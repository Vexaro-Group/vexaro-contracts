import { Interface, ZeroAddress, formatEther } from "ethers";

import { STAKING_POOLS } from "../../deploy/params/stakingPools";
import {
  KIND_NAMES,
  activateLicense,
  bonusVexOf,
  buyLicense,
  buyVex,
  claimLite,
  claimReward,
  mintUsdt,
  sellBack,
  sellCurrent,
  stakeVex,
  vexForUsdt,
} from "./actions";
import { WAD, earlyClose, mulDiv, poolParams } from "./oracle";
import type { OperatorCall, Runner, StepContext } from "./runner";
import type { World } from "./world";

export interface RunConfig {
  mode: "fork" | "live";
  /** Pool ids to stake in (default: every pool the chain has). */
  pools?: number[];
  /** The sponsor of alice: an address, or the zero address for the root. */
  rootSponsor: string;
}

/** Wallet names of the three-level chain every run builds: alice (root) -> bob -> carol. */
export const CHAIN = ["alice", "bob", "carol"] as const;
const CODES = new Map(STAKING_POOLS.map((p) => [p.id, p.code]));

/** The call `from` would send, encoded, for the NEEDS-OPERATOR rows. */
export function operatorCall(
  w: World,
  from: string,
  contractKey: Parameters<World["env"]["addr"]>[0],
  fn: string,
  args: unknown[],
  note?: string,
): OperatorCall {
  const c = w.env.c[contractKey];
  const iface: Interface = c.interface;
  return {
    from,
    contract: String(contractKey),
    address: String(c.target),
    function: fn,
    args: args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))),
    calldata: iface.encodeFunctionData(fn, args),
    ...(note ? { note } : {}),
  };
}

/** Whole balance of a claim kind, bounded by the kind's maximum and the daily cap room; skips below the minimum. */
async function claimAmount(s: StepContext, w: World, who: string, kind: number): Promise<bigint> {
  const info = (await w.env.c.rewards.claimsOf(w.actor(who).address))[kind];
  const balance = BigInt(info.balance);
  let gross = balance;
  for (const bound of [BigInt(info.maximum), BigInt(info.capRoom)]) if (gross > bound) gross = bound;
  s.fact(`${KIND_NAMES[kind]} balance`, balance);
  if (!info.windowOpen) s.skip(`${KIND_NAMES[kind]} window opens at ${info.nextAllowedAt}`);
  if (gross < BigInt(info.minimum))
    s.skip(`${KIND_NAMES[kind]} claimable ${gross} is below the minimum ${info.minimum}`);
  return gross;
}

export const staleFeedReason = async (w: World): Promise<string> => {
  const f = await w.env.feedStatus();
  return `SKIPPED-STALE-FEED: Chainlink BNB/USD ${f.address} updated ${f.age} s ago, bnbMaxAge ${f.maxAge} s (updatedAt ${f.updatedAt})`;
};

/**
 * The part of the scenario both modes run on day 0: preflight, join, purchases with USDT and BNB, licenses, stakes in
 * every pool, partner credits, reward claims, sell-back and the early-close quote. `setupWallets` creates alice, bob,
 * carol (and, on a fork, the extra actors) and funds them.
 */
export async function runCore(
  r: Runner,
  w: World,
  cfg: RunConfig,
  setupWallets: (s: StepContext) => Promise<void>,
): Promise<void> {
  const env = w.env;
  const { tokenSale, staking, network, treasury, usdt, rewards, jump } = env.c;

  await r.step("preflight", "chain, deployment and contract surface", {}, async (s) => {
    const block = await env.provider.getBlock("latest");
    s.fact("block", block?.number);
    s.fact("timestamp", block?.timestamp);
    s.fact("fork", env.fork);
    for (const key of [
      "vex",
      "usdt",
      "treasury",
      "network",
      "priceFeed",
      "tokenSale",
      "staking",
      "licenseSale",
      "rewards",
      "jump",
    ] as const) {
      s.check(`${key} has code`, (await env.provider.getCode(env.addr(key))) !== "0x");
    }
    // these views revert on the first build
    const budget = await network.guardianFreezeBudget();
    s.fact("guardian freeze budget / used / left", `${budget[0]} / ${budget[1]} / ${budget[2]}`);
    const floor = await tokenSale.reserveFloor();
    s.fact("reserve floor (floor, owed, fixed)", `${floor[0]}, ${floor[1]}, ${floor[2]}`);
    await tokenSale.currentSellEntitlement(env.deployerAddress);
    s.check("Treasury.withdrawBnbReserve exists", env.c.treasury.interface.getFunction("withdrawBnbReserve") !== null);
    const round = BigInt(await tokenSale.currentRound());
    s.check("a sale round is open", round > 0n);
    const price = await w.vexPrice();
    s.fact("VEX price (USDT wei)", price);
    s.fact("round", round);
    s.fact("round inventory (VEX)", await tokenSale.remaining(round));
    s.fact("USDT reserve", await treasury.reserveOf(usdt.target));
    s.fact("BNB reserve", await treasury.reserveOf(ZeroAddress));
    s.fact("reward vault (VEX)", await rewards.vaultBalance());
    s.fact("Jump allocation (VEX)", await jump.allocation());
    s.fact("licenseOwed", await network.licenseOwed());
    s.fact("deployer / GUARDIAN holds role", await network.hasRole(await network.GUARDIAN_ROLE(), env.deployerAddress));
    const operatorOn: string[] = [];
    const guardianOn: string[] = [];
    for (const key of ["network", "priceFeed", "tokenSale", "staking", "licenseSale", "rewards", "jump"] as const) {
      const c = env.c[key];
      if (await c.hasRole(await c.OPERATOR_ROLE(), env.deployerAddress)) operatorOn.push(key);
      if (await c.hasRole(await c.GUARDIAN_ROLE(), env.deployerAddress)) guardianOn.push(key);
    }
    s.fact("deployer holds GUARDIAN on", guardianOn.join(", "));
    s.fact("deployer ALSO holds OPERATOR on", operatorOn.join(", ") || "none");
    const feed = await env.feedStatus().catch(() => undefined);
    if (feed) s.fact("BNB feed age s / max age s", `${feed.age} / ${feed.maxAge}`);

    // the pools to stake in: launched, enabled and covered by the sale inventory
    const count = Number(await staking.poolCount());
    const ids = cfg.pools ?? Array.from({ length: count }, (_, i) => i + 1);
    let budget_ = BigInt(await tokenSale.remaining(round)) - 100_000n * WAD;
    w.plan = [];
    for (const id of ids) {
      const code = CODES.get(id) ?? `pool ${id}`;
      const p = await staking.pool(id).catch(() => undefined);
      if (!p) {
        w.plan.push({ id, code, vex: 0n, skip: "pool does not exist" });
        continue;
      }
      const params = poolParams(await staking.poolVersion(id, p.versionCount));
      const vexAmount = vexForUsdt(params.usdtMin, price);
      let skip: string | undefined;
      if (!p.launched) skip = "pool is not launched";
      else if (!p.enabled) skip = "pool is disabled";
      else if (vexAmount > budget_) skip = `sale inventory left (${budget_}) does not cover ${vexAmount} VEX`;
      else budget_ -= vexAmount;
      w.plan.push({ id, code, vex: vexAmount, skip });
    }
    s.fact("pool plan", w.plan.map((p) => `${p.code}:${p.skip ?? p.vex}`).join(" "));
  });

  await r.step("wallets", "create and fund alice, bob, carol", { needs: ["preflight"] }, setupWallets);

  await r.step("usdt-mint", "tUSDT from the open faucet", { needs: ["wallets"] }, async (s) => {
    const price = await w.vexPrice();
    const alicePool = w.plan.filter((p) => !p.skip).reduce((sum, p) => sum + p.vex, 0n);
    const aliceUsdt = mulDiv(alicePool, price, WAD) + 200n * WAD;
    await mintUsdt(s, w, w.actor("alice"), aliceUsdt);
    await mintUsdt(s, w, w.actor("bob"), 700n * WAD);
    await mintUsdt(s, w, w.actor("carol"), 900n * WAD);
  });

  // ---- join: the first purchase registers the sponsor
  await r.step("join-alice", "alice buys VEX with USDT under the root sponsor", { needs: ["usdt-mint"] }, async (s) => {
    const price = await w.vexPrice();
    const need = w.plan.filter((p) => !p.skip).reduce((sum, p) => sum + p.vex, 0n);
    const pay = mulDiv(need, price, WAD) + WAD;
    await buyVex(s, w, w.actor("alice"), {
      payToken: String(usdt.target),
      payAmount: pay,
      sponsor: cfg.rootSponsor,
      negatives: true,
    });
    s.eq("alice sponsor", await network.sponsorOf(w.actor("alice").address), cfg.rootSponsor);
  });
  await r.step("join-bob", "bob buys VEX with USDT under alice", { needs: ["join-alice"] }, async (s) => {
    await buyVex(s, w, w.actor("bob"), {
      payToken: String(usdt.target),
      payAmount: 520n * WAD,
      sponsor: w.actor("alice").address,
    });
    s.eq("alice directCount", await network.directCount(w.actor("alice").address), 1);
  });
  await r.step("join-carol", "carol buys VEX with USDT under bob", { needs: ["join-bob"] }, async (s) => {
    await buyVex(s, w, w.actor("carol"), {
      payToken: String(usdt.target),
      payAmount: 700n * WAD,
      sponsor: w.actor("bob").address,
    });
    const chain = [...(await network.ancestors(w.actor("carol").address, 3))].map(String);
    s.eq("carol's ancestors", chain.slice(0, 2), [w.actor("bob").address, w.actor("alice").address]);
    s.eq("bob directCount", await network.directCount(w.actor("bob").address), 1);
  });

  // ---- BNB purchases (a stale Chainlink feed is a chain condition on a live network)
  await r.step("buy-bnb", "bob buys VEX with BNB", { needs: ["join-bob"] }, async (s) => {
    const bnb = await env.bnbPrice();
    if (!bnb) return s.skip(await staleFeedReason(w));
    s.fact("BNB price source", bnb.mocked ? "mock aggregator (fork)" : "Chainlink");
    await buyVex(s, w, w.actor("bob"), {
      payToken: ZeroAddress,
      payAmount: 400_000_000_000_000n,
      sponsor: ZeroAddress,
    });
  });
  await r.step(
    "buy-bnb-exact",
    "alice buys an exact VEX amount with BNB, the overpayment is refunded",
    { needs: ["join-alice"] },
    async (s) => {
      const bnb = await env.bnbPrice();
      if (!bnb) return s.skip(await staleFeedReason(w));
      const vexAmount = 20n * WAD;
      const quote = await tokenSale.quoteBuyExact(ZeroAddress, vexAmount);
      await buyVex(s, w, w.actor("alice"), {
        payToken: ZeroAddress,
        exact: { vexAmount, maxPay: (BigInt(quote[0]) * 12n) / 10n },
        sponsor: ZeroAddress,
      });
    },
  );

  // ---- licenses and stakes
  await r.step(
    "license-alice",
    "alice buys and activates a Basic 180 d license",
    { needs: ["join-alice"] },
    async (s) => {
      const bought = await buyLicense(s, w, w.actor("alice"), 1, 180, ZeroAddress);
      await activateLicense(s, w, w.actor("alice"), bought.id);
    },
  );
  for (const p of w.plan) {
    const id = `stake-alice-${p.code}`;
    if (p.skip) {
      await r.step(id, `alice stakes in ${p.code}`, {}, async (s) => s.skip(p.skip as string));
      continue;
    }
    await r.step(id, `alice stakes the minimum in ${p.code}`, { needs: ["join-alice"] }, async (s) => {
      await stakeVex(s, w, w.actor("alice"), p.id, p.vex, ZeroAddress, p.id === w.plan[0].id);
    });
  }
  const aliceBase = ["license-alice", "stake-alice-" + (w.plan[0]?.code ?? "Smart")];

  await r.step(
    "license-bob",
    "bob buys a Basic 180 d license: License Rewards to alice",
    { needs: ["join-bob", ...aliceBase] },
    async (s) => {
      const bought = await buyLicense(s, w, w.actor("bob"), 1, 180, ZeroAddress);
      await activateLicense(s, w, w.actor("bob"), bought.id);
    },
  );
  const stakeStep = async (who: string, poolId: number, usdtValue: bigint, id: string, needs: string[]) =>
    r.step(id, `${who} stakes ${formatEther(usdtValue)} USDT in pool ${poolId}`, { needs }, async (s) => {
      const p = await staking.pool(poolId);
      if (!p.launched || !p.enabled) s.skip(`pool ${poolId} is ${p.launched ? "disabled" : "not launched"}`);
      const vexAmount = vexForUsdt(usdtValue, await w.vexPrice());
      await stakeVex(s, w, w.actor(who), poolId, vexAmount, ZeroAddress);
    });
  await stakeStep("bob", 1, 500n * WAD, "stake-bob-Smart", ["license-bob"]);
  await stakeStep("bob", 2, 10n * WAD, "stake-bob-P1", ["license-bob"]);
  await stakeStep("carol", 1, 500n * WAD, "stake-carol-Smart", ["join-carol", "stake-bob-Smart"]);
  await stakeStep("carol", 2, 20n * WAD, "stake-carol-P1", ["join-carol", "stake-bob-Smart"]);
  await r.step(
    "lite-carol",
    "carol claims and activates the free Lite license",
    { needs: ["stake-carol-P1"] },
    async (s) => {
      await claimLite(s, w, w.actor("carol"));
      await activateLicense(s, w, w.actor("carol"), 30n);
    },
  );
  await r.step(
    "license-carol",
    "carol buys a Basic 30 d license: License Rewards to bob and alice",
    { needs: ["lite-carol", "license-bob"] },
    async (s) => {
      await buyLicense(s, w, w.actor("carol"), 1, 30, ZeroAddress);
    },
  );

  // ---- reward claims that are claimable the day they are earned
  await r.step(
    "claim-cashback-alice",
    "alice claims Network Cashback and License Rewards (VEX, 90 / 5 / 5, BackFlow)",
    { needs: ["stake-bob-Smart", "stake-carol-P1", "license-bob", "license-carol"] },
    async (s) => {
      await claimReward(s, w, w.actor("alice"), 1, await claimAmount(s, w, "alice", 1));
    },
  );
  await r.step(
    "claim-license-refused-alice",
    "alice's LICENSE claim is refused: the USDT License kind is removed, License Rewards are VEX on the cashback balance",
    { needs: ["license-bob", "license-carol"] },
    async (s) => {
      const balance = BigInt((await network.bonusBalances(w.actor("alice").address))[1]);
      s.eq("alice has no USDT License Rewards balance", balance, 0n);
      await s.reverts(
        "a LICENSE claim",
        w.as(rewards, w.actor("alice")).claim.staticCall(2, WAD),
        rewards,
        "InvalidKind",
      );
    },
  );
  await r.step(
    "claim-cashback-bob",
    "bob claims Network Cashback: BackFlow to alice",
    { needs: ["stake-carol-Smart", "claim-cashback-alice"] },
    async (s) => {
      await claimReward(s, w, w.actor("bob"), 1, await claimAmount(s, w, "bob", 1));
    },
  );

  // ---- sell back
  await r.step(
    "sell-back-carol",
    "carol sells back part of her purchase (FIFO lots)",
    { needs: ["join-carol", "stake-carol-P1"] },
    async (s) => {
      const sellable = BigInt(await tokenSale.sellable(w.actor("carol").address));
      s.check("carol has lots to sell", sellable >= 1000n * WAD);
      const out = BigInt(await tokenSale.quoteSell(w.actor("carol").address, 1000n * WAD));
      const [floor] = await tokenSale.reserveFloor();
      const reserve = BigInt(await treasury.reserveOf(usdt.target));
      if (BigInt(floor) !== 0n && reserve < out + BigInt(floor)) {
        s.skip(`USDT reserve ${reserve} is below payout ${out} + floor ${floor}`);
      }
      await sellBack(s, w, w.actor("carol"), 1000n * WAD);
    },
  );
  await r.step(
    "sell-current-carol",
    "carol's second sale of the day is refused; at the current price (entitlement, caps, reserve floor) once a new day has begun",
    { needs: ["sell-back-carol"] },
    async (s) => {
      // one sale per account and UTC day, both sale paths together: carol sold back in the step before
      const closedUntil = BigInt(await tokenSale.nextSaleAt(w.actor("carol").address));
      if (closedUntil !== 0n) {
        await s.reverts(
          "a second sale on the same day",
          w.as(tokenSale, w.actor("carol")).sellAtCurrentPrice.staticCall(500n * WAD, 0),
          tokenSale,
          "SaleAlreadyMadeToday",
        );
        s.check("nextSaleAt is a 00:00 UTC", closedUntil % 86_400n === 0n, "multiple of 86400", closedUntil);
        s.fact("carol may sell again from", closedUntil);
        return;
      }
      const vexAmount = 500n * WAD;
      const gross = mulDiv(vexAmount, await w.vexPrice(), WAD);
      const min = 5n * WAD;
      if (gross < min) s.skip(`500 VEX is worth ${gross} USDT, the sale minimum is ${min}`);
      const [floor] = await tokenSale.reserveFloor();
      const reserve = BigInt(await treasury.reserveOf(usdt.target));
      if (BigInt(floor) !== 0n && reserve < gross + BigInt(floor)) {
        s.skip(`USDT reserve ${reserve} is below payout ${gross} + floor ${floor}`);
      }
      await s.reverts(
        "more than the entitlement",
        w.as(tokenSale, w.actor("carol")).sellAtCurrentPrice.staticCall(10n ** 30n, 0),
        tokenSale,
        "NotEntitled",
      );
      // a purchase counts for the current-price sale 24 hours after it
      const [matured, maturing, nextAt] = await tokenSale.currentSellMaturity(w.actor("carol").address);
      if (BigInt(matured) < vexAmount) {
        s.check("carol's purchase is still maturing", BigInt(maturing) > 0n, "> 0", maturing);
        await s.reverts(
          "a purchase younger than 24 hours",
          w.as(tokenSale, w.actor("carol")).sellAtCurrentPrice.staticCall(vexAmount, 0),
          tokenSale,
          "LotsNotMatured",
        );
        // the sale itself waits for the purchase to count (the fork scenario sells after its time travel)
        s.fact("carol's purchase counts for the current-price sale from", nextAt);
        return;
      }
      await s.reverts(
        "a sale below 5 USDT",
        w.as(tokenSale, w.actor("carol")).sellAtCurrentPrice.staticCall(WAD, 0),
        tokenSale,
        "BelowMinimum",
      );
      await sellCurrent(s, w, w.actor("carol"), vexAmount);
    },
  );

  // ---- early close: quote now (the close opens 48 h after the stake)
  await r.step(
    "early-close-quote",
    "early-close quote of bob's Smart stake: the 48 h window, fee, partner credits",
    { needs: ["claim-cashback-bob"] },
    async (s) => {
      const ref = w.stakesOf("bob").find((x) => x.pool === 1);
      if (!ref) return s.skip("bob has no Smart stake");
      const p = await staking.previewEarlyClose(ref.id);
      const bonus = await bonusVexOf(w, ref);
      const expected = earlyClose(ref.principal, 0n, bonus);
      s.eq("status (3 = too soon)", p.status, 3);
      s.eq("availableAt = opening + 48 h", p.availableAt, BigInt(ref.openedAt) + 172_800n);
      s.eq("burn (5 %)", p.burn, expected.burn);
      s.eq("fee to the vault (25 %)", p.feeToVault, expected.feeToVault);
      s.eq("accrued", p.accrued, 0);
      s.eq("partner credits deducted", p.bonusVex, bonus);
      s.eq("refund", p.refund, expected.refund);
      s.check("the credits of carol's stake are in the deduction", p.bonusVex > 0n, "> 0", p.bonusVex);
      await s.reverts(
        "closeEarly before 48 h",
        w.as(staking, w.actor("bob")).closeEarly.staticCall(ref.id),
        staking,
        "EarlyCloseRefused",
      );
      w.memo.set("earlyCloseAvailableAt", String(p.availableAt));
    },
  );
}
