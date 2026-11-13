import { ZeroAddress, formatEther, id, parseEther } from "ethers";

import { type RunConfig, operatorCall, runCore } from "./core";
import { logsOf } from "./env";
import type { E2eArgs } from "./index";
import type { Runner, StepContext } from "./runner";
import { type WalletKey, assertWalletsPath, writeWallets } from "./wallets";
import type { World } from "./world";

const NAMES = ["alice", "bob", "carol"];
const GAS_UNITS_DEPLOYER_TXS = 4n * 250_000n;
const TRANSFER_GAS = 21_000n;

/**
 * The part of the scenario that needs no OPERATOR / Safe key and no time travel, signed by the deployer's key (or an
 * impersonated deployer on a fork rehearsal): fresh wallets are funded, the day-0 core runs, then what only an
 * OPERATOR, the timelock, the airdrop wallet or the passing of time can do is listed with the exact call.
 */
export async function runLive(r: Runner, w: World, cfg: RunConfig, args: E2eArgs): Promise<Record<string, unknown>> {
  const env = w.env;
  const { network, staking, jump, tokenSale, usdt, rewards, treasury } = env.c;
  if (!args.walletsOut) {
    throw new Error(
      "--wallets-out <file> is required in live mode: the throwaway wallets' keys, outside the repo, mode 600",
    );
  }
  assertWalletsPath(env.hre, args.walletsOut);
  const fund = parseEther(args.fundAmount);
  const maxSpend = parseEther(args.maxSpend);
  const deployer = await env.deployerSigner();
  const deployerAddress = await deployer.getAddress();

  // spend guard: nothing is sent when the deployer could spend more than --max-spend
  const feeData = env.fees.gasPrice === undefined ? await env.provider.getFeeData() : undefined;
  const gasPrice = env.fees.gasPrice ?? feeData?.maxFeePerGas ?? feeData?.gasPrice ?? 1_000_000_000n;
  const planned = BigInt(NAMES.length) * fund + GAS_UNITS_DEPLOYER_TXS * gasPrice;
  if (planned > maxSpend) {
    throw new Error(
      `spend guard: the deployer would spend up to ${formatEther(planned)} tBNB, --max-spend is ${formatEther(
        maxSpend,
      )}`,
    );
  }
  const balanceStart = await env.provider.getBalance(deployerAddress);
  if (balanceStart < planned) {
    throw new Error(`the deployer holds ${formatEther(balanceStart)} tBNB, the run may spend ${formatEther(planned)}`);
  }
  env.opts.log(
    `deployer ${deployerAddress}: ${formatEther(balanceStart)} tBNB, planned spend up to ${formatEther(
      planned,
    )} (max ${formatEther(maxSpend)})`,
  );

  let funded = 0n;
  /** tBNB the deployer has spent so far: gas of its transactions plus what it sent to the wallets. */
  const spent = (s?: StepContext): bigint => {
    const txs = [...r.results.flatMap((x) => x.txs), ...(s?.txs ?? [])];
    return (
      funded +
      txs
        .filter((t) => t.from.toLowerCase() === deployerAddress.toLowerCase())
        .reduce((sum, t) => sum + BigInt(t.feeWei), 0n)
    );
  };
  const guard = (s: StepContext, next: bigint) => {
    if (spent(s) + next > maxSpend) {
      throw new Error(
        `spend guard: ${formatEther(spent(s))} spent + ${formatEther(next)} would pass --max-spend ${formatEther(
          maxSpend,
        )}`,
      );
    }
  };

  await runCore(r, w, cfg, async (s) => {
    const keys: WalletKey[] = NAMES.map((name) => {
      const wallet = env.newWallet();
      w.addActor(name, wallet, wallet.address);
      return { name, address: wallet.address, privateKey: wallet.privateKey };
    });
    // the keys are on disk before a single wei is sent to the wallets
    writeWallets(env.hre, args.walletsOut as string, keys);
    s.fact("wallets file (keys are not printed)", args.walletsOut);
    for (const name of NAMES) {
      const a = w.actor(name);
      guard(s, fund + TRANSFER_GAS * gasPrice);
      await s.tx(`deployer funds ${name} with ${formatEther(fund)} tBNB`, () =>
        deployer.sendTransaction({ to: a.address, value: fund, ...env.fees }),
      );
      funded += fund;
      const balance = await env.until(
        () => w.bnbBalance(a.address),
        (b) => b >= fund,
      );
      s.eq(`${name} tBNB balance`, balance, fund);
    }
  });

  // ------------------------------------------------------------------ what the live chain can still show today
  await r.step(
    "jump-slot-bob",
    "bob's P1 stake fills a Jump slot of alice's cycle 1",
    { needs: ["stake-bob-P1"] },
    async (s) => {
      const alice = w.actor("alice").address;
      const cycle = await jump.cycle(alice, 1);
      s.eq("alice cycle 1 slots", cycle.slots, 1);
      s.check("bob is counted", Boolean(await jump.isCounted(w.actor("bob").address)));
      s.eq("the slot's entry value is bob's stake", cycle.usdt, w.stakesOf("bob").find((x) => x.pool === 2)?.entryUsdt);
      s.fact("cycle end / grant claimable at", `${cycle.end} / ${cycle.claimableAt}`);
    },
  );

  const staleness = "needs the passing of chain time: a live network cannot be time-travelled (the fork run covers it)";
  const laterStep = async (id_: string, title: string, needs: string[], reason: () => Promise<string>) =>
    r.step(id_, title, { needs }, async (s) => s.skip(await reason()));
  const firstStake = () => w.stakesOf("alice")[0];
  await laterStep(
    "early-close",
    "early close of bob's Smart stake",
    ["early-close-quote"],
    async () => `the early close opens 48 h after the stake, at ${w.memo.get("earlyCloseAvailableAt")}; ${staleness}`,
  );
  await laterStep("accrual-claim-staking", "staking income accrual and its claim", ["stake-alice-Smart"], async () => {
    const view = await staking.stakeView(firstStake().id);
    return `no reward moment has passed: income ${await staking.incomeOf(
      w.actor("alice").address,
    )}, the first moment is at ${view.nextMomentAt}; ${staleness}`;
  });
  await laterStep(
    "matured-close-vesting",
    "matured close, vesting claim, three-part releases",
    ["stake-alice-Smart"],
    async () =>
      `the Smart pool matures at ${
        (await staking.stakeView(firstStake().id)).maturesAt
      }, VEST pools 308 days after opening; ${staleness}`,
  );
  await laterStep("jump-claim", "Jump grant of cycle 1", ["jump-slot-bob"], async () => {
    const cycle = await jump.cycle(w.actor("alice").address, 1);
    return `cycle 1 has ${cycle.slots} of 4 slots and ends at ${cycle.end} (grant claimable at ${cycle.claimableAt}); ${staleness}`;
  });
  await r.step(
    "airdrop-lock",
    "airdrop wallet sends VEX to carol, carol stakeAirdrop in P1",
    { needs: ["wallets"] },
    async (s) => {
      const wallet = String(await env.c.vex.airdropWallet());
      s.needsOperator(
        operatorCall(
          w,
          wallet,
          "vex",
          "transfer",
          [w.actor("carol").address, 10_000n * 10n ** 18n],
          "the airdrop wallet's key is not held by the runner; carol then calls Staking.stakeAirdrop(2, amount, 0x0)",
        ),
      );
    },
  );

  // ------------------------------------------------------------------ GUARDIAN freeze (the deployer is GUARDIAN)
  await r.step(
    "guardian-freeze-carol",
    "GUARDIAN freezes carol: daily budget counted, her actions are refused",
    { needs: ["claim-cashback-bob", "sell-back-carol"] },
    async (s) => {
      const carol = w.actor("carol");
      const guardianRole = await network.GUARDIAN_ROLE();
      const operatorRole = await network.OPERATOR_ROLE();
      if (!(await network.hasRole(guardianRole, deployerAddress))) {
        return s.skip(`${deployerAddress} does not hold GUARDIAN on Network`);
      }
      const isOperator = Boolean(await network.hasRole(operatorRole, deployerAddress));
      const budget = await network.guardianFreezeBudget();
      s.fact("budget / used today / left", `${budget[0]} / ${budget[1]} / ${budget[2]}`);
      s.fact("deployer also holds OPERATOR on Network (its freezes are then not counted)", isOperator);
      if (!isOperator && BigInt(budget[2]) === 0n)
        return s.skip(`the GUARDIAN daily freeze budget is used up (${budget[1]} of ${budget[0]})`);
      guard(s, 250_000n * gasPrice);
      const receipt = await s.tx("GUARDIAN freezes carol", () =>
        env.as(network, deployer).freeze(carol.address, 1, env.fees),
      );
      const ev = logsOf(receipt, network, "Frozen")[0];
      s.check("Frozen emitted", ev !== undefined);
      s.eq("Frozen.by", ev.args.by, deployerAddress);
      const frozen = await env.until(
        async () => Boolean(await network.isFrozen(carol.address)),
        (v) => v,
      );
      s.check("carol is frozen", frozen);
      const list = await network.freezeIntervals(carol.address);
      s.eq("open interval (until = 0)", list[list.length - 1].until, 0);
      const after = await network.guardianFreezeBudget();
      s.eq("daily budget used", BigInt(after[1]) - BigInt(budget[1]), isOperator ? 0 : 1);
      await s.reverts(
        "a frozen account buys",
        w.as(tokenSale, carol).buy.staticCall(usdt.target, 10n ** 18n, 0, ZeroAddress),
        tokenSale,
        "NotActive",
      );
      await s.reverts(
        "a frozen account claims",
        w.as(rewards, carol).claim.staticCall(1, 10n ** 18n),
        rewards,
        "NotActive",
      );
      // the account checks answer before the one-sale-per-day rule, also for an account that sold earlier today
      await s.reverts(
        "a frozen account sells back",
        w.as(tokenSale, carol).sell.staticCall(10n ** 18n, 0),
        tokenSale,
        "NotActive",
      );
      await s.reverts(
        "freezing again",
        env.as(network, deployer).freeze.staticCall(carol.address, 1),
        network,
        "NoChange",
      );
      if (!isOperator) {
        await s.reverts(
          "GUARDIAN unfreeze",
          env.as(network, deployer).unfreeze.staticCall(carol.address),
          network,
          "AccessControlUnauthorizedAccount",
        );
      }
    },
  );

  // ------------------------------------------------------------------ what only the Safe / the timelock can do
  const safe = env.multisig;
  await r.step("unfreeze-carol", "Safe: OPERATOR unfreezes carol", { needs: ["guardian-freeze-carol"] }, async (s) => {
    s.needsOperator(
      operatorCall(
        w,
        safe,
        "network",
        "unfreeze",
        [w.actor("carol").address],
        "OPERATOR_ROLE; lifts the freeze and closes the interval now",
      ),
    );
  });
  await r.step(
    "void-freeze-carol",
    "Safe: OPERATOR voids carol's freeze",
    { needs: ["guardian-freeze-carol"] },
    async (s) => {
      const index = BigInt(await network.freezeCount(w.actor("carol").address)) - 1n;
      s.needsOperator(
        operatorCall(
          w,
          safe,
          "network",
          "voidFreeze",
          [w.actor("carol").address, index],
          "OPERATOR_ROLE; the open interval becomes empty, the account is unfrozen and no income is lost",
        ),
      );
    },
  );
  await r.step(
    "treasury-bnb-withdraw",
    "Safe via the timelock: withdraw the BNB reserve",
    { needs: ["buy-bnb"] },
    async (s) => {
      const reserve = BigInt(await treasury.reserveOf(ZeroAddress));
      if (reserve === 0n) return s.skip("the BNB reserve is empty");
      const data = treasury.interface.encodeFunctionData("withdrawBnbReserve", [safe, reserve]);
      const delay = BigInt(await env.c.timelock.getMinDelay());
      s.needsOperator(
        operatorCall(
          w,
          safe,
          "timelock",
          "schedule",
          [env.addr("treasury"), 0n, data, "0x" + "00".repeat(32), id("task:e2e withdrawBnbReserve"), delay],
          `proposer; execute with the same arguments after ${delay} s; withdraws ${reserve} wei of BNB reserve to the Safe`,
        ),
      );
    },
  );

  // ------------------------------------------------------------------ give the unspent tBNB back
  await r.step(
    "sweep-back",
    "the wallets send their leftover tBNB back to the deployer",
    { needs: ["wallets"] },
    async (s) => {
      if (args.noSweep) return s.skip("--no-sweep");
      const price = env.fees.gasPrice ?? gasPrice;
      for (const name of NAMES) {
        const a = w.actor(name);
        const balance = await w.bnbBalance(a.address);
        const cost = TRANSFER_GAS * price;
        if (balance <= cost) continue;
        const before = await w.bnbBalance(deployerAddress);
        await s.tx(`${name} sends ${formatEther(balance - cost)} tBNB back`, () =>
          a.signer.sendTransaction(
            env.fork
              ? {
                  to: deployerAddress,
                  value: balance - cost,
                  gasLimit: TRANSFER_GAS,
                  maxFeePerGas: price,
                  maxPriorityFeePerGas: 0n,
                }
              : { to: deployerAddress, value: balance - cost, gasLimit: TRANSFER_GAS, gasPrice: price },
          ),
        );
        const afterBalance = await env.until(
          () => w.bnbBalance(deployerAddress),
          (b) => b > before,
        );
        s.eq(`${name} sweep arrived`, afterBalance - before, balance - cost);
        s.check(`${name} keeps no more than dust`, (await w.bnbBalance(a.address)) < cost * 2n);
      }
    },
  );

  const balanceEnd = await env.provider.getBalance(deployerAddress);
  return {
    deployerSpend: {
      startBalanceWei: balanceStart.toString(),
      endBalanceWei: balanceEnd.toString(),
      netSpentWei: (balanceStart - balanceEnd).toString(),
      grossSentToWalletsWei: funded.toString(),
      maxSpendWei: maxSpend.toString(),
      plannedWorstCaseWei: planned.toString(),
    },
    walletsFile: args.walletsOut,
  };
}
