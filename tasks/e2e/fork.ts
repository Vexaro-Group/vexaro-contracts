import { Wallet, ZeroAddress, parseEther } from "ethers";

import {
  buyVex,
  claimReward,
  claimVestedStake,
  closeEarlyStake,
  closeMaturedStake,
  expectedAccrual,
  mintUsdt,
  sellCurrent,
  stakeVex,
  vexForUsdt,
} from "./actions";
import { type RunConfig, runCore } from "./core";
import { logsOf } from "./env";
import type { E2eArgs } from "./index";
import { DAY, WAD, accruedAt, mulDiv, poolParams, poolParamsOf } from "./oracle";
import type { Runner } from "./runner";
import { type WalletKey, assertWalletsPath, writeWallets } from "./wallets";
import type { StakeRef, World } from "./world";

const ACTORS = ["alice", "bob", "carol", "j1", "j2", "j3", "j4", "erin"];
const AIRDROP_VEX = 10_000n * WAD;
const STAKING_KIND = 0;

/** The full scenario on a fork of BSC testnet: impersonated OPERATOR / timelock / airdrop wallet, time travel. */
export async function runFork(r: Runner, w: World, cfg: RunConfig, args: E2eArgs): Promise<void> {
  const env = w.env;
  if (args.walletsOut) assertWalletsPath(env.hre, args.walletsOut);
  const { vex, usdt, staking, network, jump, tokenSale, treasury, rewards, priceFeed } = env.c;

  await runCore(r, w, cfg, async (s) => {
    const keys: WalletKey[] = [];
    for (const name of ACTORS) {
      const wallet = env.newWallet();
      await env.setBalance(wallet.address, parseEther("1000"));
      w.addActor(name, wallet, wallet.address);
      keys.push({ name, address: wallet.address, privateKey: wallet.privateKey });
    }
    if (args.walletsOut) writeWallets(env.hre, args.walletsOut, keys);
    s.eq("wallets created", w.actors.size, ACTORS.length);
  });

  const operator = async () => env.impersonate(env.multisig);
  const guardian = async () => env.deployerSigner();
  const day0 = () => Math.floor((w.stakesOf("alice")[0]?.openedAt ?? 0) / DAY);
  const at = (days: number) => (day0() + days) * DAY + 7 * 3600;
  const warp = (id: string, days: number, needs: string[]) =>
    r.step(id, `time travel to day ${days} after the opening day, 07:00 UTC`, { needs }, async (s) => {
      const target = at(days);
      if (target <= (await env.now())) s.skip(`already past day ${days}`);
      await env.warpTo(target);
      s.eq("block time", await env.now(), target);
    });
  const stakeOf = (who: string, pool: number): StakeRef => {
    const ref = w.stakesOf(who).find((x) => x.pool === pool);
    if (!ref) throw new Error(`${who} has no stake in pool ${pool}`);
    return ref;
  };

  // ------------------------------------------------------------------ day 0: airdrop lock
  await r.step(
    "airdrop-lock",
    "the airdrop wallet sends VEX: the receiver's copy travels locked",
    { needs: ["wallets"] },
    async (s) => {
      const wallet = String(await vex.airdropWallet());
      const erin = w.actor("erin");
      const signer = await env.impersonate(wallet);
      const pre = await w.balanceOf(vex, wallet);
      s.check("the airdrop wallet holds the airdrop", pre >= AIRDROP_VEX, `>= ${AIRDROP_VEX}`, pre);
      const receipt = await s.tx("airdrop wallet sends VEX to erin", () =>
        env.as(vex, signer).transfer(erin.address, AIRDROP_VEX),
      );
      const ev = logsOf(receipt, vex, "AirdropLockAdded")[0];
      s.check("AirdropLockAdded emitted", ev !== undefined);
      s.eq("lock amount", ev.args.amount, AIRDROP_VEX);
      s.eq("erin balance (the wallet is fee-exempt)", await vex.balanceOf(erin.address), AIRDROP_VEX);
      s.eq("airdropLockedOf", await vex.airdropLockedOf(erin.address), AIRDROP_VEX);
      s.eq("freeBalanceOf", await vex.freeBalanceOf(erin.address), 0);
      await s.reverts(
        "locked VEX sent to the TokenSale",
        w.as(vex, erin).transfer.staticCall(env.addr("tokenSale"), 1n),
        vex,
        "AirdropLocked",
      );
    },
  );
  await r.step(
    "airdrop-stake",
    "stakeAirdrop in P1: the lock is spent, no partner bonus, no early close",
    { needs: ["airdrop-lock"] },
    async (s) => {
      const erin = w.actor("erin");
      const pool = 2;
      const pre = {
        total: BigInt(await staking.totalPrincipal()),
        staked: BigInt(await vex.balanceOf(env.addr("staking"))),
      };
      await s.reverts(
        "stakeAirdrop in Smart",
        w.as(staking, erin).stakeAirdrop.staticCall(1, AIRDROP_VEX, ZeroAddress),
        staking,
        "AirdropPoolNotAllowed",
      );
      const receipt = await s.tx("erin stakeAirdrop P1", () =>
        w.as(staking, erin).stakeAirdrop(pool, AIRDROP_VEX, ZeroAddress),
      );
      const ev = logsOf(receipt, staking, "StakeOpened")[0];
      s.check("StakeOpened emitted", ev !== undefined);
      s.eq("source (AIRDROP)", ev.args.source, 2);
      s.eq("principal", ev.args.principal, AIRDROP_VEX);
      s.check("AirdropLockSpent emitted", logsOf(receipt, vex, "AirdropLockSpent").length === 1);
      s.eq("lock left", await vex.airdropLockedOf(erin.address), 0);
      s.eq("erin balance", await vex.balanceOf(erin.address), 0);
      s.eq("Staking holds the VEX", BigInt(await vex.balanceOf(env.addr("staking"))) - pre.staked, AIRDROP_VEX);
      s.eq("totalPrincipal grew", BigInt(await staking.totalPrincipal()) - pre.total, AIRDROP_VEX);
      const id = BigInt(ev.args.stakeId);
      const p = await staking.previewEarlyClose(id);
      s.eq("early close status (2 = not a USER stake)", p.status, 2);
      const view = await staking.stakeView(id);
      const ref: StakeRef = {
        id,
        owner: erin.address,
        pool,
        principal: AIRDROP_VEX,
        entryUsdt: BigInt(view.entryUsdt),
        openedAt: Number(view.openedAt),
        version: BigInt(view.version),
        vexMark: 0n,
        usdtMark: 0n,
      };
      w.stakes.set("erin", [ref]);
    },
  );

  // ------------------------------------------------------------------ day 0: VEX Jump slots
  // bob (alice's invitee, P1 stake of 10 USDT) already holds slot 1 of alice's cycle 1: j1..j3 fill slots 2..4, j4
  // finds the cycle full and is not counted
  const jumpRefs: StakeRef[] = [];
  for (const [i, name] of ["j1", "j2", "j3", "j4"].entries()) {
    await r.step(
      `jump-slot-${name}`,
      `${name} joins under alice and stakes in P1: ${i < 3 ? `Jump slot ${i + 2}` : "the cycle is full"}`,
      { needs: ["stake-alice-P1", "stake-bob-P1", "license-alice"] },
      async (s) => {
        const a = w.actor(name);
        await mintUsdt(s, w, a, 100n * WAD);
        await buyVex(s, w, a, {
          payToken: String(usdt.target),
          payAmount: 30n * WAD,
          sponsor: w.actor("alice").address,
        });
        const vexAmount = vexForUsdt((12n + BigInt(i)) * WAD, await w.vexPrice());
        const ref = await stakeVex(s, w, a, 2, vexAmount, ZeroAddress);
        jumpRefs.push(ref);
        const alice = w.actor("alice").address;
        const cycle = await jump.cycle(alice, 1);
        const counted = i < 3;
        s.eq("alice cycle 1 slots", cycle.slots, Math.min(2 + i, 4));
        s.eq("invitee counted", Boolean(await jump.isCounted(a.address)), counted);
        s.eq("smallest slot (entry USDT, bob's stake)", cycle.usdt, stakeOf("bob", 2).entryUsdt);
        s.eq("smallest slot pool", cycle.poolId, 2);
        s.eq("cycle status (1 = running with four slots, 0 = fewer)", cycle.status, i >= 2 ? 1 : 0);
      },
    );
  }

  await r.step(
    "pool-disable-guard",
    "OPERATOR disables a pool: new stakes are refused, open ones are untouched",
    { needs: ["stake-alice-P13"] },
    async (s) => {
      const op = await operator();
      const pool = 14;
      const alice = w.actor("alice");
      const open = (await staking.openStakesOf(alice.address)).length;
      await s.reverts(
        "launching a launched pool",
        env.as(staking, op).launchPool.staticCall(pool),
        staking,
        "NoChange",
      );
      await s.tx("OPERATOR disables P13", () => env.as(staking, op).setPoolEnabled(pool, false, w.ov()));
      s.eq("pool enabled flag", (await staking.pool(pool)).enabled, false);
      await s.reverts(
        "stake into the disabled pool",
        w.as(staking, alice).stake.staticCall(pool, 10n ** 21n, 0, ZeroAddress),
        staking,
        "PoolClosed",
      );
      s.eq("open stakes untouched", (await staking.openStakesOf(alice.address)).length, open);
      await s.tx("OPERATOR enables P13", () => env.as(staking, op).setPoolEnabled(pool, true, w.ov()));
      s.eq("pool enabled flag", (await staking.pool(pool)).enabled, true);
    },
  );

  // ------------------------------------------------------------------ day 0: Treasury and TokenSale admin through the timelock
  await r.step(
    "reserve-fund",
    "unaccounted tUSDT in the Treasury is moved into the reserve by the timelock",
    { needs: ["preflight"] },
    async (s) => {
      const amount = 1000n * WAD;
      const a = w.actor("alice");
      await s.tx("mint tUSDT to the Treasury", () => w.as(usdt, a).mint(env.addr("treasury"), amount));
      const pre = {
        reserve: BigInt(await treasury.reserveOf(usdt.target)),
        excess: BigInt(await treasury.excessOf(usdt.target)),
      };
      s.check("the excess shows the donation", pre.excess >= amount);
      const operatorSigner = await operator();
      await s.reverts(
        "fundReserve by the OPERATOR",
        env.as(treasury, operatorSigner).fundReserve.staticCall(usdt.target, amount),
        treasury,
        "AccessControlUnauthorizedAccount",
      );
      const data = treasury.interface.encodeFunctionData("fundReserve", [usdt.target, amount]);
      const receipt = await env.viaTimelock(env.addr("treasury"), data, "fundReserve");
      s.check("ReserveFunded emitted", logsOf(receipt, treasury, "ReserveFunded").length === 1);
      s.eq("reserve grew", BigInt(await treasury.reserveOf(usdt.target)) - pre.reserve, amount);
      s.eq("excess fell", pre.excess - BigInt(await treasury.excessOf(usdt.target)), amount);
    },
  );
  await r.step(
    "treasury-bnb-withdraw",
    "the timelock withdraws the BNB reserve; nobody else can",
    { needs: ["buy-bnb", "reserve-fund"] },
    async (s) => {
      const reserve = BigInt(await treasury.reserveOf(ZeroAddress));
      s.check("the BNB purchases left a BNB reserve", reserve > 0n, "> 0", reserve);
      const to = Wallet.createRandom().address;
      const amount = reserve / 2n;
      const operatorSigner = await operator();
      await s.reverts(
        "withdrawBnbReserve by the OPERATOR",
        env.as(treasury, operatorSigner).withdrawBnbReserve.staticCall(to, amount),
        treasury,
        "AccessControlUnauthorizedAccount",
      );
      const timelock = await env.impersonate(String(env.c.timelock.target));
      await s.reverts(
        "withdraw above the reserve",
        env.as(treasury, timelock).withdrawBnbReserve.staticCall(to, reserve + 1n),
        treasury,
        "InsufficientReserve",
      );
      await s.reverts(
        "withdraw zero",
        env.as(treasury, timelock).withdrawBnbReserve.staticCall(to, 0),
        treasury,
        "ZeroAmount",
      );
      const balance = await w.bnbBalance(env.addr("treasury"));
      const usdtReserve = BigInt(await treasury.reserveOf(usdt.target));
      const receipt = await env.viaTimelock(
        env.addr("treasury"),
        treasury.interface.encodeFunctionData("withdrawBnbReserve", [to, amount]),
        "withdrawBnbReserve",
      );
      const ev = logsOf(receipt, treasury, "ReserveWithdrawn")[0];
      s.check("ReserveWithdrawn emitted", ev !== undefined);
      s.eq("event amount", ev.args.amount, amount);
      s.eq("recipient got the BNB", await w.bnbBalance(to), amount);
      s.eq("Treasury balance fell", balance - (await w.bnbBalance(env.addr("treasury"))), amount);
      s.eq("BNB reserve fell", reserve - BigInt(await treasury.reserveOf(ZeroAddress)), amount);
      s.eq("the USDT reserve is untouched by the BNB exit", await treasury.reserveOf(usdt.target), usdtReserve);
    },
  );

  // ------------------------------------------------------------------ day 3: accruals, claims, early close, BNB feed after time travel, freezes
  await warp("warp-day3", 3, ["wallets"]);
  // carol sold back on day 0, so the day rule closed her sales for that day; the sale at the current price follows here
  await r.step(
    "reserve-floor-guard",
    "a reserve floor refuses the current-price sale, lifting it allows it",
    { needs: ["warp-day3", "sell-current-carol", "reserve-fund"] },
    async (s) => {
      const carol = w.actor("carol");
      const reserve = BigInt(await treasury.reserveOf(usdt.target));
      const old = BigInt((await tokenSale.reserveFloor())[2]);
      const sale = tokenSale.interface;
      await env.viaTimelock(
        env.addr("tokenSale"),
        sale.encodeFunctionData("setReserveFloorFixed", [reserve]),
        "setReserveFloorFixed",
      );
      const floor = await tokenSale.reserveFloor();
      s.eq("floor = the fixed part (nothing is owed in USDT any more)", floor[0], reserve);
      s.eq("licenseOwed part", floor[1], 0);
      await s.reverts(
        "sale with the floor at the reserve",
        w.as(tokenSale, carol).sellAtCurrentPrice.staticCall(200n * WAD, 0),
        tokenSale,
        "ReserveFloor",
      );
      await env.viaTimelock(
        env.addr("tokenSale"),
        sale.encodeFunctionData("setReserveFloorFixed", [old]),
        "setReserveFloorFixed",
      );
      s.eq("floor restored", (await tokenSale.reserveFloor())[2], old);
      // the same call passes now (static call only: the amount stays for the other steps)
      await w.as(tokenSale, carol).sellAtCurrentPrice.staticCall(200n * WAD, 0);
    },
  );
  // a purchase counts for the current-price sale 24 hours after it, and a sale of day 0 does not block day 3
  await r.step(
    "sell-current-carol-matured",
    "carol's purchase is older than 24 hours and a new day has begun: the current-price sale works",
    { needs: ["warp-day3", "sell-current-carol", "reserve-floor-guard"] },
    async (s) => {
      const carol = w.actor("carol");
      const vexAmount = 500n * WAD;
      const gross = mulDiv(vexAmount, await w.vexPrice(), WAD);
      const [floor] = await tokenSale.reserveFloor();
      const reserve = BigInt(await treasury.reserveOf(usdt.target));
      if (BigInt(floor) !== 0n && reserve < gross + BigInt(floor)) {
        s.skip(`USDT reserve ${reserve} is below payout ${gross} + floor ${floor}`);
      }
      s.eq("carol may sell again (nextSaleAt)", await tokenSale.nextSaleAt(carol.address), 0);
      const [matured, maturing] = await tokenSale.currentSellMaturity(carol.address);
      s.check("carol's purchase matured", BigInt(matured) >= vexAmount && BigInt(maturing) === 0n);
      await s.reverts(
        "more than the entitlement",
        w.as(tokenSale, carol).sellAtCurrentPrice.staticCall(10n ** 30n, 0),
        tokenSale,
        "NotEntitled",
      );
      await s.reverts(
        "a sale below 5 USDT",
        w.as(tokenSale, carol).sellAtCurrentPrice.staticCall(WAD, 0),
        tokenSale,
        "BelowMinimum",
      );
      await sellCurrent(s, w, carol, vexAmount);
      await s.reverts(
        "a second sale on the same day",
        w.as(tokenSale, carol).sell.staticCall(WAD, 0),
        tokenSale,
        "SaleAlreadyMadeToday",
      );
    },
  );
  await r.step(
    "bnb-feed-mock",
    "BNB purchase after time travel: the stale Chainlink feed is replaced by a mock aggregator",
    { needs: ["warp-day3", "join-bob"] },
    async (s) => {
      const real = await priceFeed
        .bnbPrice()
        .then(() => true)
        .catch(() => false);
      s.fact("real feed still fresh after the time travel", real);
      const bnb = await env.bnbPrice();
      s.check("a BNB price is available", bnb !== undefined);
      s.fact("feed mocked", bnb?.mocked ?? false);
      // a stale feed (the testnet one) is replaced; a feed that is still fresh (a local deployment) is used as it is
      s.check("a stale feed was replaced by the mock", real || bnb?.mocked === true);
      await buyVex(s, w, w.actor("bob"), {
        payToken: ZeroAddress,
        payAmount: 300_000_000_000_000n,
        sponsor: ZeroAddress,
      });
    },
  );
  await r.step(
    "accrual-day3",
    "every open stake has accrued exactly what its schedule says by day 3 (Smart: nothing before day 8)",
    { needs: ["warp-day3"] },
    async (s) => {
      const now = BigInt(await env.now());
      let count = 0;
      let sum = 0n;
      for (const [who, refs] of w.stakes) {
        if (who === "erin") continue;
        for (const ref of refs) {
          const want = await expectedAccrual(w, ref, now);
          s.eq(`${who} pool ${ref.pool} stake ${ref.id} accrued`, await staking.accruedOf(ref.id), want);
          if (who === "alice") sum += want;
          count += 1;
        }
      }
      s.check("some stakes were checked", count > 10, "> 10", count);
      s.eq("alice income = sum of her accruals", await staking.incomeOf(w.actor("alice").address), sum);
      const view = await staking.stakeView(stakeOf("alice", 2).id);
      s.check("next reward moment is in the future", BigInt(view.nextMomentAt) > now);
    },
  );
  await r.step(
    "claim-staking-alice",
    "alice claims staking income (VEX, 90 / 5 / 5)",
    { needs: ["accrual-day3"] },
    async (s) => {
      const info = (await rewards.claimsOf(w.actor("alice").address))[STAKING_KIND];
      let gross = BigInt(info.balance);
      for (const bound of [BigInt(info.maximum), BigInt(info.capRoom)]) if (gross > bound) gross = bound;
      s.check("claimable", gross >= BigInt(info.minimum), `>= ${info.minimum}`, gross);
      await claimReward(s, w, w.actor("alice"), STAKING_KIND, gross);
    },
  );
  await r.step(
    "airdrop-hold",
    "the airdrop stake is on hold: its income is held, Rewards has nothing to pay, the stake can not be closed",
    { needs: ["accrual-day3", "airdrop-stake"] },
    async (s) => {
      const erin = w.actor("erin");
      const ref = w.stakesOf("erin")[0];
      s.eq("isStakeHeld", await staking.isStakeHeld(ref.id), true);
      s.eq("incomeOf", await staking.incomeOf(erin.address), 0);
      s.eq(
        "heldIncomeOf = accrual of the airdrop stake",
        await staking.heldIncomeOf(erin.address),
        await expectedAccrual(w, ref, BigInt(await env.now())),
      );
      s.eq("the STAKING balance Rewards sees", (await rewards.claimsOf(erin.address))[STAKING_KIND].balance, 0);
      await s.reverts(
        "closeEarly of a held stake",
        w.as(staking, erin).closeEarly.staticCall(ref.id),
        staking,
        "StakeOnHold",
      );
    },
  );
  await r.step(
    "airdrop-release",
    "the admin console (AIRDROP_RELEASER_ROLE, the multisig) releases erin: the held income becomes claimable",
    { needs: ["airdrop-hold"] },
    async (s) => {
      const erin = w.actor("erin");
      const releaser = await operator();
      s.eq(
        "the multisig holds AIRDROP_RELEASER_ROLE",
        await staking.hasRole(await staking.AIRDROP_RELEASER_ROLE(), env.multisig),
        true,
      );
      await s.reverts(
        "a wallet without the role",
        w.as(staking, erin).releaseAirdropHold.staticCall(erin.address),
        staking,
        "AccessControlUnauthorizedAccount",
      );
      const receipt = await s.tx("the multisig releases erin", () =>
        env.as(staking, releaser).releaseAirdropHold(erin.address),
      );
      const ev = logsOf(receipt, staking, "AirdropReleased")[0];
      s.check("AirdropReleased emitted", ev !== undefined);
      s.eq("one stake released", ev.args.stakes, 1);
      s.eq("held income now", await staking.heldIncomeOf(erin.address), 0);
      s.eq("the released income is income", await staking.incomeOf(erin.address), ev.args.income);
    },
  );
  await r.step(
    "airdrop-income-claim",
    "the airdrop stake's income is claimable once released; the payout is free VEX",
    { needs: ["accrual-day3", "airdrop-stake", "airdrop-release"] },
    async (s) => {
      const erin = w.actor("erin");
      const info = (await rewards.claimsOf(erin.address))[STAKING_KIND];
      s.check(
        "income at least the minimum",
        BigInt(info.balance) >= BigInt(info.minimum),
        `>= ${info.minimum}`,
        info.balance,
      );
      const ref = w.stakesOf("erin")[0];
      s.eq(
        "income = accrual of the airdrop stake",
        info.balance,
        await expectedAccrual(w, ref, BigInt(await env.now())),
      );
      const half = BigInt(info.balance) / 2n;
      const gross = half >= BigInt(info.minimum) ? half : BigInt(info.balance);
      s.check("within the maximum", gross <= BigInt(info.maximum), `<= ${info.maximum}`, gross);
      await claimReward(s, w, erin, STAKING_KIND, gross);
      s.eq("the lock stays spent", await vex.airdropLockedOf(erin.address), 0);
      s.eq("all of it is free VEX", await vex.freeBalanceOf(erin.address), await vex.balanceOf(erin.address));
    },
  );
  await r.step(
    "early-close-bob",
    "bob closes his Smart stake early: refund after fee, accrual and partner credits",
    { needs: ["warp-day3", "early-close-quote"] },
    async (s) => {
      await closeEarlyStake(s, w, w.actor("bob"), stakeOf("bob", 1));
    },
  );

  await r.step(
    "guardian-only",
    "model the documented hand-over: the deployer is GUARDIAN only",
    { needs: ["preflight"] },
    async (s) => {
      const g = await guardian();
      const renounced: string[] = [];
      for (const key of ["network", "priceFeed", "tokenSale", "staking", "licenseSale", "rewards", "jump"] as const) {
        const c = env.c[key];
        const role = await c.OPERATOR_ROLE();
        if (!(await c.hasRole(role, env.deployerAddress))) continue;
        await s.tx(`deployer renounces OPERATOR on ${key} (fork only)`, () =>
          env.as(c, g).renounceRole(role, env.deployerAddress),
        );
        renounced.push(key);
        s.eq(`deployer holds OPERATOR on ${key}`, await c.hasRole(role, env.deployerAddress), false);
      }
      s.fact("OPERATOR the deployer still held on the forked chain", renounced.join(", ") || "none");
      s.eq(
        "deployer holds GUARDIAN on Network",
        await network.hasRole(await network.GUARDIAN_ROLE(), env.deployerAddress),
        true,
      );
    },
  );
  await r.step(
    "freeze-start",
    "GUARDIAN freezes j1..j4: budget counted, actions refused, GUARDIAN cannot lift it",
    { needs: ["warp-day3", "jump-slot-j4", "guardian-only"] },
    async (s) => {
      const g = await guardian();
      const budget = await network.guardianFreezeBudget();
      for (const name of ["j1", "j2", "j3", "j4"]) {
        const a = w.actor(name);
        const receipt = await s.tx(`GUARDIAN freezes ${name}`, () => env.as(network, g).freeze(a.address, 1, w.ov()));
        s.check("Frozen emitted", logsOf(receipt, network, "Frozen").length === 1);
        s.check(`${name} is frozen`, Boolean(await network.isFrozen(a.address)));
        const list = await network.freezeIntervals(a.address);
        s.eq(`${name} open interval`, [list.length, list[0].until], [1, 0]);
      }
      const after = await network.guardianFreezeBudget();
      s.eq("budget used today grew by 4", BigInt(after[1]) - BigInt(budget[1]), 4);
      s.eq("budget left fell by 4", BigInt(budget[2]) - BigInt(after[2]), 4);
      const j1 = w.actor("j1");
      await s.reverts(
        "a frozen account buys",
        w.as(tokenSale, j1).buy.staticCall(usdt.target, WAD, 0, ZeroAddress),
        tokenSale,
        "NotActive",
      );
      await s.reverts(
        "freezing a frozen account",
        env.as(network, g).freeze.staticCall(j1.address, 1),
        network,
        "NoChange",
      );
      await s.reverts(
        "GUARDIAN unfreeze",
        env.as(network, g).unfreeze.staticCall(j1.address),
        network,
        "AccessControlUnauthorizedAccount",
      );
      await s.reverts(
        "GUARDIAN voidFreeze",
        env.as(network, g).voidFreeze.staticCall(j1.address, 0),
        network,
        "AccessControlUnauthorizedAccount",
      );
      await s.reverts(
        "GUARDIAN unfreezeMany",
        env.as(network, g).unfreezeMany.staticCall([j1.address], true),
        network,
        "AccessControlUnauthorizedAccount",
      );
    },
  );

  // ------------------------------------------------------------------ day 6: forfeited moments, void freeze, batch unfreeze
  await warp("warp-day6", 6, ["warp-day3"]);
  const jRef = (name: string) => w.stakesOf(name)[0];
  const accrualOf = async (name: string) => BigInt((await staking.stakeView(jRef(name).id)).accrued);
  const noFreeze = async (name: string) => {
    const ref = jRef(name);
    const params = await poolParamsOf(staking, ref.pool, ref.version);
    return accruedAt(params, ref.principal, BigInt(ref.openedAt), BigInt(await env.now()));
  };
  await r.step(
    "freeze-forfeit",
    "frozen reward moments pay nothing: accrual follows the freeze ranges",
    { needs: ["warp-day6"] },
    async (s) => {
      for (const name of ["j1", "j2", "j3", "j4"]) {
        const ref = jRef(name);
        const got = await accrualOf(name);
        s.eq(`${name} accrual with the open freeze`, got, await expectedAccrual(w, ref, BigInt(await env.now())));
        s.check(`${name} lost the frozen moments`, got < (await noFreeze(name)), `< ${await noFreeze(name)}`, got);
      }
    },
  );
  await r.step(
    "jump-review-pending",
    "the Jump grant of cycle 1 is not claimable before the cycle ends and the review passes",
    { needs: ["warp-day6"] },
    async (s) => {
      await s.reverts(
        "claimJump(1)",
        w.as(jump, w.actor("alice"))["claimJump(uint256)"].staticCall(1),
        jump,
        "ReviewPending",
      );
    },
  );
  await r.step(
    "void-freeze-j1",
    "Safe void freeze of j1's open freeze: unfrozen, accrual restored",
    { needs: ["freeze-forfeit"] },
    async (s) => {
      const op = await operator();
      const j1 = w.actor("j1");
      const before = await accrualOf("j1");
      const receipt = await s.tx("OPERATOR voidFreeze(j1, 0)", () =>
        env.as(network, op).voidFreeze(j1.address, 0, w.ov()),
      );
      const ev = logsOf(receipt, network, "FreezeVoided")[0];
      s.check("FreezeVoided emitted", ev !== undefined);
      s.eq("FreezeVoided.wasOpen", ev.args.wasOpen, true);
      s.check("Unfrozen emitted", logsOf(receipt, network, "Unfrozen").length === 1);
      s.check("j1 is active again", Boolean(await network.isActive(j1.address)));
      const after = await accrualOf("j1");
      s.eq("accrual restored to the unfrozen schedule", after, await noFreeze("j1"));
      s.check("the accrual grew", after > before, `> ${before}`, after);
      await s.reverts(
        "voiding twice",
        env.as(network, op).voidFreeze.staticCall(j1.address, 0),
        network,
        "FreezeAlreadyVoid",
      );
      await s.reverts(
        "unknown interval",
        env.as(network, op).voidFreeze.staticCall(j1.address, 7),
        network,
        "UnknownFreeze",
      );
    },
  );
  await r.step(
    "batch-unfreeze-j2-j3",
    "Safe batch unfreeze with void: j2 and j3 restored, a non-frozen account is skipped",
    { needs: ["freeze-forfeit", "void-freeze-j1"] },
    async (s) => {
      const op = await operator();
      const list = ["j1", "j2", "j3"].map((n) => w.actor(n).address);
      const receipt = await s.tx("OPERATOR unfreezeMany(j1, j2, j3, void)", () =>
        env.as(network, op).unfreezeMany(list, true, w.ov()),
      );
      s.eq("two accounts were lifted", logsOf(receipt, network, "Unfrozen").length, 2);
      for (const name of ["j2", "j3"]) {
        s.check(`${name} is active`, Boolean(await network.isActive(w.actor(name).address)));
        s.eq(`${name} accrual restored`, await accrualOf(name), await noFreeze(name));
      }
      await s.reverts("empty batch", env.as(network, op).unfreezeMany.staticCall([], true), network, "InvalidBatch");
    },
  );
  await r.step(
    "unfreeze-void-j4",
    "OPERATOR unfreeze keeps the forfeit; the later void of the closed interval restores it",
    { needs: ["freeze-forfeit", "batch-unfreeze-j2-j3"] },
    async (s) => {
      const op = await operator();
      const j4 = w.actor("j4");
      await s.tx("OPERATOR unfreeze(j4)", () => env.as(network, op).unfreeze(j4.address, w.ov()));
      s.check("j4 is active", Boolean(await network.isActive(j4.address)));
      const lost = await accrualOf("j4");
      s.eq("the frozen moments stay forfeited", lost, await expectedAccrual(w, jRef("j4"), BigInt(await env.now())));
      s.check("less than the unfrozen schedule", lost < (await noFreeze("j4")));
      const receipt = await s.tx("OPERATOR voidFreeze(j4, 0)", () =>
        env.as(network, op).voidFreeze(j4.address, 0, w.ov()),
      );
      const ev = logsOf(receipt, network, "FreezeVoided")[0];
      s.eq("FreezeVoided.wasOpen (closed interval)", ev.args.wasOpen, false);
      s.eq("accrual restored", await accrualOf("j4"), await noFreeze("j4"));
      await s.reverts(
        "unfreeze of an active account",
        env.as(network, op).unfreeze.staticCall(j4.address),
        network,
        "NoChange",
      );
    },
  );

  // ------------------------------------------------------------------ day 11: Jump grant
  await warp("warp-day11", 11, ["warp-day6"]);
  await r.step(
    "jump-claim-alice",
    "alice claims the Jump grant of cycle 1: a JUMP stake from the Jump allocation",
    { needs: ["warp-day11"] },
    async (s) => {
      const alice = w.actor("alice");
      const cycle = await jump.cycle(alice.address, 1);
      s.eq("cycle status (4 = claimable)", cycle.status, 4);
      const usdtClamped = BigInt(cycle.usdt) > 5000n * WAD ? 5000n * WAD : BigInt(cycle.usdt);
      const vexAmount = mulDiv(usdtClamped, WAD, await w.vexPrice());
      const pre = {
        allocation: BigInt(await jump.allocation()),
        total: BigInt(await staking.totalPrincipal()),
        credit: BigInt((await tokenSale.currentSellEntitlement(alice.address))[2]),
      };
      const receipt = await s.tx("alice claimJump(1)", () => w.as(jump, alice)["claimJump(uint256)"](1, w.ov()));
      const ev = logsOf(receipt, jump, "GrantClaimed")[0];
      s.check("GrantClaimed emitted", ev !== undefined);
      s.eq("GrantClaimed.poolId (smallest slot)", ev.args.poolId, cycle.poolId);
      s.eq("GrantClaimed.vexAmount", ev.args.vexAmount, vexAmount);
      const id = BigInt(ev.args.stakeId);
      const view = await staking.stakeView(id);
      s.eq("grant stake source (JUMP)", view.source, 1);
      s.eq("grant stake principal", view.principal, vexAmount);
      s.eq("grant stake owner", view.owner, alice.address);
      s.eq("Jump allocation paid", pre.allocation - BigInt(await jump.allocation()), vexAmount);
      s.eq("totalPrincipal grew", BigInt(await staking.totalPrincipal()) - pre.total, vexAmount);
      s.eq(
        "no sell credit yet: it comes as the stake pays the principal back",
        BigInt((await tokenSale.currentSellEntitlement(alice.address))[2]) - pre.credit,
        0n,
      );
      const credit = await jump.grantCreditOf(alice.address, 1);
      s.eq("credit due (95 % of the grant)", credit[0], vexAmount - mulDiv(vexAmount, 500n, 10_000n));
      s.eq("credit releasable now", credit[2], 0);
      s.eq("grantsClaimedOf", await jump.grantsClaimedOf(alice.address), 1);
      s.eq("early close status (2 = not a USER stake)", (await staking.previewEarlyClose(id)).status, 2);
      await s.reverts(
        "claiming the grant twice",
        w.as(jump, alice)["claimJump(uint256)"].staticCall(1),
        jump,
        "AlreadyClaimed",
      );
    },
  );

  // ------------------------------------------------------------------ day 18: pauses, then the matured FULL close (Smart)
  await warp("warp-day18", 18, ["warp-day11"]);
  await r.step(
    "pause-guard",
    "GUARDIAN pauses ENTRIES (it cannot lift it), EXIT_PAUSER pauses EXITS",
    { needs: ["warp-day18", "stake-carol-Smart", "guardian-only"] },
    async (s) => {
      const g = await guardian();
      const op = await operator();
      const carol = w.actor("carol");
      const ref = stakeOf("carol", 1);
      await s.tx("GUARDIAN pauses ENTRIES on Staking", () => env.as(staking, g).pause(1, w.ov()));
      await s.reverts(
        "stake while ENTRIES is paused",
        w.as(staking, carol).stake.staticCall(2, 10n ** 21n, 0, ZeroAddress),
        staking,
        "EnforcedPause",
      );
      await s.reverts(
        "GUARDIAN unpause",
        env.as(staking, g).unpause.staticCall(1),
        staking,
        "AccessControlUnauthorizedAccount",
      );
      await s.tx("OPERATOR unpauses ENTRIES", () => env.as(staking, op).unpause(1, w.ov()));
      await s.tx("EXIT_PAUSER pauses EXITS", () => env.as(staking, op).pause(4, w.ov()));
      await s.reverts(
        "closeMatured while EXITS is paused",
        w.as(staking, carol).closeMatured.staticCall(ref.id),
        staking,
        "EnforcedPause",
      );
      await s.reverts(
        "OPERATOR-less GUARDIAN pauses EXITS",
        env.as(staking, g).pause.staticCall(4),
        staking,
        "AccessControlUnauthorizedAccount",
      );
      await s.tx("EXIT_PAUSER unpauses EXITS", () => env.as(staking, op).unpause(4, w.ov()));
      s.eq("no flag left paused", await staking.pausedFlags(), 0);
    },
  );
  await r.step(
    "matured-close-carol-smart",
    "carol's Smart stake matures: 95 % paid now, 5 % burned, whole schedule settled",
    { needs: ["pause-guard", "stake-carol-Smart"] },
    async (s) => {
      const ref = stakeOf("carol", 1);
      const carol = w.actor("carol");
      await closeMaturedStake(s, w, carol, ref);
      const income = BigInt(await staking.incomeOf(carol.address));
      s.check("the settled income is in the balance", income > 0n, "> 0", income);
    },
  );

  // ------------------------------------------------------------------ day 31: three-part pools release their first parts
  await warp("warp-day31", 31, ["warp-day18"]);
  await r.step(
    "accrual-three-parts",
    "three-part pools P6..P13 release parts on their release days",
    { needs: ["warp-day31", "stake-alice-P6"] },
    async (s) => {
      const now = BigInt(await env.now());
      let checked = 0;
      for (const ref of w.stakesOf("alice")) {
        if (ref.pool < 7) continue;
        s.eq(`alice pool ${ref.pool} accrued`, await staking.accruedOf(ref.id), await expectedAccrual(w, ref, now));
        checked += 1;
      }
      s.check("three-part pools were checked", checked > 0, "> 0", checked);
    },
  );
  await r.step(
    "claim-staking-alice-2",
    "alice claims staking income again after the 24 h window",
    { needs: ["warp-day31", "claim-staking-alice"] },
    async (s) => {
      const info = (await rewards.claimsOf(w.actor("alice").address))[STAKING_KIND];
      let gross = BigInt(info.balance);
      for (const bound of [BigInt(info.maximum), BigInt(info.capRoom)]) if (gross > bound) gross = bound;
      await claimReward(s, w, w.actor("alice"), STAKING_KIND, gross);
    },
  );

  // ------------------------------------------------------------------ day 92: matured FULL close of three-part pools
  await warp("warp-day92", 92, ["warp-day31"]);
  await r.step(
    "matured-close-alice-p6",
    "alice's P6 and P13 mature: the three parts are settled, 95 % paid",
    { needs: ["warp-day92", "stake-alice-P6", "stake-alice-P13"] },
    async (s) => {
      const alice = w.actor("alice");
      const p6 = stakeOf("alice", 7);
      const params = poolParams(await staking.poolVersion(p6.pool, p6.version));
      const whole = mulDiv(
        p6.principal,
        params.dailyBps * params.periodDays < params.maxProfitBps
          ? params.dailyBps * params.periodDays
          : params.maxProfitBps,
        10_000n,
      );
      s.eq("P6 schedule total", await staking.accruedOf(p6.id), whole);
      await closeMaturedStake(s, w, alice, p6);
      await closeMaturedStake(s, w, alice, stakeOf("alice", 14));
    },
  );

  // ------------------------------------------------------------------ day 310: VEST pools: close, partial and final vesting claims
  await warp("warp-day310", 310, ["warp-day92"]);
  const closed = new Map<string, bigint>();
  await r.step(
    "matured-close-vest",
    "erin's airdrop stake and alice's P1 mature: VEST starts, nothing is paid yet",
    { needs: ["warp-day310", "airdrop-release", "stake-alice-P1"] },
    async (s) => {
      const erin = w.actor("erin");
      const ref = w.stakesOf("erin")[0];
      await closeMaturedStake(s, w, erin, ref);
      closed.set("erin", BigInt((await staking.stakeView(ref.id)).closedAt));
      s.eq("nothing claimable on the closing day", await staking.claimableOf(ref.id), 0);
      await s.reverts(
        "claimVested on the closing day",
        w.as(staking, erin).claimVested.staticCall(ref.id),
        staking,
        "NothingToClaim",
      );
      await closeMaturedStake(s, w, w.actor("alice"), stakeOf("alice", 2));
    },
  );
  await warp("warp-vest-half", 310 + 154, ["warp-day310"]);
  let half = 0n;
  await r.step(
    "vesting-claim-half",
    "erin claims the half-vested principal: free VEX, the lock is gone",
    { needs: ["warp-vest-half", "matured-close-vest"] },
    async (s) => {
      const erin = w.actor("erin");
      const ref = w.stakesOf("erin")[0];
      half = await claimVestedStake(s, w, erin, ref, closed.get("erin") as bigint);
      s.eq("airdropLockedOf", await vex.airdropLockedOf(erin.address), 0);
      s.eq("free balance = balance", await vex.freeBalanceOf(erin.address), await vex.balanceOf(erin.address));
    },
  );
  await warp("warp-vest-end", 310 + 308, ["warp-vest-half"]);
  await r.step(
    "vesting-claim-final",
    "erin claims the rest: the stake closes, 95 % of the principal was paid in all",
    { needs: ["warp-vest-end", "vesting-claim-half"] },
    async (s) => {
      const erin = w.actor("erin");
      const ref = w.stakesOf("erin")[0];
      const total = await claimVestedStake(s, w, erin, ref, closed.get("erin") as bigint);
      s.eq("total claimed = 95 % of the principal", total, ref.principal - mulDiv(ref.principal, 500n, 10_000n));
      s.check("more than the first claim", total > half, `> ${half}`, total);
      await s.reverts(
        "claiming a closed stake",
        w.as(staking, erin).claimVested.staticCall(ref.id),
        staking,
        "WrongState",
      );
    },
  );
}
