import { MaxUint256, ZeroAddress } from "ethers";

import { logsOf } from "./env";
import {
  type Credit,
  DAY,
  type Program,
  type Upline,
  WAD,
  accruedAt,
  distribute,
  earlyClose,
  maturesAt,
  mulDiv,
  poolParams,
  poolParamsOf,
  vestTotal,
  vestedAt,
} from "./oracle";
import type { StepContext } from "./runner";
import { type Actor, type StakeRef, World } from "./world";

const MAX_MINT = 100_000n * WAD;
const ALLOWANCE_OK = 1n << 200n;
const addr = (a: string) => a.toLowerCase();

/** Tops the actor's tUSDT up to `target` with the open faucet (100 000 per call). */
export async function mintUsdt(s: StepContext, w: World, a: Actor, target: bigint): Promise<void> {
  const usdt = w.env.c.usdt;
  let balance = await w.balanceOf(usdt, a.address);
  while (balance < target) {
    const chunk = target - balance > MAX_MINT ? MAX_MINT : target - balance;
    await s.tx(`mint ${chunk} tUSDT to ${a.name}`, () => w.as(usdt, a).mint(a.address, chunk, w.ov()));
    balance = await w.env.until(
      () => w.balanceOf(usdt, a.address),
      (b) => b >= balance + chunk,
    );
  }
  s.check(`${a.name} holds at least ${target} tUSDT`, balance >= target, `>= ${target}`, balance);
}

/** Approves `spender` for the actor's `token` once (unlimited), so later steps send one transaction each. */
export async function approveMax(
  s: StepContext,
  w: World,
  a: Actor,
  token: "usdt" | "vex",
  spender: string,
): Promise<void> {
  const t = w.env.c[token];
  if (BigInt(await t.allowance(a.address, spender)) >= ALLOWANCE_OK) return;
  await s.tx(`${a.name} approves ${token} for ${spender}`, () => w.as(t, a).approve(spender, MaxUint256, w.ov()));
  const allowance = await w.env.until(
    async () => BigInt(await t.allowance(a.address, spender)),
    (v) => v >= ALLOWANCE_OK,
  );
  s.check(`${a.name} ${token} allowance for ${spender}`, allowance >= ALLOWANCE_OK, `>= ${ALLOWANCE_OK}`, allowance);
}

/** Compares the partner credits an action made with the oracle's, address by address (upline beyond depth: 0). */
export function expectCredits(
  s: StepContext,
  label: string,
  program: Program,
  upline: Upline[],
  expected: Credit[],
  before: Map<string, { vex: bigint; usdt: bigint }>,
  after: Map<string, { vex: bigint; usdt: bigint }>,
): bigint {
  let total = 0n;
  for (const u of upline) {
    const key = addr(u.address);
    const want = expected.find((c) => addr(c.address) === key)?.credit ?? 0n;
    // every partner credit is VEX (the USDT total only holds the legacy License Rewards)
    const got = (after.get(key)?.vex ?? 0n) - (before.get(key)?.vex ?? 0n);
    s.eq(`${label}: ${program} credit of ${u.address}`, got, want);
    total += got;
  }
  return total;
}

export interface BuyOptions {
  payToken: string;
  /** Pay this much (`buy`), or ... */
  payAmount?: bigint;
  /** ... buy exactly this much VEX for at most `maxPay` (`buyExact`). */
  exact?: { vexAmount: bigint; maxPay: bigint };
  sponsor: string;
  /** Also prove the slippage guard with an eth_call. */
  negatives?: boolean;
}

export interface BuyResult {
  vexOut: bigint;
  payAmount: bigint;
  receiptBlock: number;
}

/** Buys VEX from the TokenSale and checks quote, event, balances, lot, inventory and the Treasury split. */
export async function buyVex(s: StepContext, w: World, a: Actor, o: BuyOptions): Promise<BuyResult> {
  const { tokenSale, treasury, usdt, vex, network } = w.env.c;
  const bnb = o.payToken === ZeroAddress;
  const round = BigInt(await tokenSale.currentRound());
  const price = BigInt((await tokenSale.currentRoundPrice())[0]);
  const member = Boolean(await network.isMember(a.address));
  const wallets = [...(await treasury.wallets())].map((x) => ({ account: String(x.account), rate: BigInt(x.rateBps) }));
  const payToken = bnb ? ZeroAddress : String(usdt.target);
  const bnbPrice = bnb ? (await w.env.bnbPrice())?.price ?? 0n : 0n;
  if (bnb && bnbPrice === 0n) throw new Error("no fresh BNB price");

  // expected result from the rules, not from the quote function
  let payAmount: bigint;
  let vexOut: bigint;
  let usdtValue: bigint;
  if (o.exact) {
    vexOut = o.exact.vexAmount;
    const usdtNeeded = (vexOut * price + WAD - 1n) / WAD;
    payAmount = bnb ? (usdtNeeded * WAD + bnbPrice - 1n) / bnbPrice : usdtNeeded;
    usdtValue = bnb ? mulDiv(payAmount, bnbPrice, WAD) : payAmount;
  } else {
    payAmount = o.payAmount as bigint;
    usdtValue = bnb ? mulDiv(payAmount, bnbPrice, WAD) : payAmount;
    vexOut = mulDiv(usdtValue, WAD, price);
  }
  const quote = o.exact
    ? await tokenSale.quoteBuyExact(o.payToken, vexOut)
    : await tokenSale.quoteBuy(o.payToken, payAmount);
  s.eq(
    o.exact ? "quoteBuyExact pay amount" : "quoteBuy VEX out",
    o.exact ? quote[0] : quote[0],
    o.exact ? payAmount : vexOut,
  );
  s.eq("quote USDT value", quote[1], usdtValue);

  const sent = o.exact ? o.exact.maxPay : payAmount;
  if (o.exact) s.check("maxPay covers the price", sent >= payAmount, `>= ${payAmount}`, sent);
  const call = (signerContract: typeof tokenSale) => (o.exact ? signerContract.buyExact : signerContract.buy);
  const args = o.exact ? [o.payToken, vexOut, sent, o.sponsor] : [o.payToken, payAmount, vexOut, o.sponsor];
  const value = bnb ? sent : 0n;
  if (o.negatives && !o.exact) {
    await s.reverts(
      "buy with minVexOut above the result",
      call(w.as(tokenSale, a)).staticCall(o.payToken, payAmount, vexOut + 1n, o.sponsor, { value }),
      tokenSale,
      "Slippage",
    );
  }

  const before = {
    vex: await w.balanceOf(vex, a.address),
    pay: bnb ? await w.bnbBalance(a.address) : await w.balanceOf(usdt, a.address),
    lot: BigInt((await tokenSale.lotsOf(a.address))[Number(round) - 1].vexAmount),
    remaining: BigInt(await tokenSale.remaining(round)),
    reserve: BigInt(await treasury.reserveOf(payToken)),
    buckets: await Promise.all(wallets.map(async (x) => BigInt(await treasury.bucketOf(payToken, x.account)))),
  };
  if (!bnb) await approveMax(s, w, a, "usdt", w.env.addr("tokenSale"));

  const receipt = await s.tx(`${a.name} ${o.exact ? "buyExact" : "buy"} ${bnb ? "BNB" : "USDT"}`, () =>
    call(w.as(tokenSale, a))(...args, w.ov({ value })),
  );

  const bought = logsOf(receipt, tokenSale, "Bought")[0];
  s.check("Bought event emitted", bought !== undefined);
  s.eq("Bought.round", bought.args.round, round);
  s.eq("Bought.payToken", bought.args.payToken, payToken);
  s.eq("Bought.payAmount", bought.args.payAmount, payAmount);
  s.eq("Bought.usdtValue", bought.args.usdtValue, usdtValue);
  s.eq("Bought.vexAmount", bought.args.vexAmount, vexOut);
  if (!member) {
    const joined = logsOf(receipt, network, "Joined")[0];
    s.check("Joined event emitted on the first purchase", joined !== undefined);
    s.eq("Joined.sponsor", joined.args.sponsor, o.sponsor);
    s.eq("sponsorOf", await network.sponsorOf(a.address), o.sponsor);
  }

  const gas = receipt.gasUsed * receipt.gasPrice;
  const afterPay = await w.env.until(
    () => (bnb ? w.bnbBalance(a.address) : w.balanceOf(usdt, a.address)),
    (v) => v !== before.pay,
  );
  s.eq("VEX received (the sale is fee-exempt)", (await w.balanceOf(vex, a.address)) - before.vex, vexOut);
  s.eq(
    bnb ? "BNB spent (payment + gas, overpayment refunded)" : "USDT spent",
    before.pay - afterPay,
    bnb ? payAmount + gas : payAmount,
  );
  const lots = await tokenSale.lotsOf(a.address);
  s.eq("lot of the round grew by the VEX bought", BigInt(lots[Number(round) - 1].vexAmount) - before.lot, vexOut);
  s.eq("round inventory shrank", before.remaining - BigInt(await tokenSale.remaining(round)), vexOut);
  // the build that pushes sends the share (and any older bucket) in the same transaction (`Released`); the build that
  // does not leaves it in the bucket: either way bucket growth plus what was sent is the share
  const released = logsOf(receipt, treasury, "Released");
  let credited = 0n;
  for (let i = 0; i < wallets.length; i++) {
    const share = mulDiv(payAmount, wallets[i].rate, 10_000n);
    const sent = released
      .filter((l) => String(l.args.account).toLowerCase() === wallets[i].account.toLowerCase())
      .reduce((sum, l) => sum + BigInt(l.args.amount), 0n);
    s.eq(
      `Treasury share of ${wallets[i].account} (bucket growth + sent)`,
      BigInt(await treasury.bucketOf(payToken, wallets[i].account)) - before.buckets[i] + sent,
      share,
    );
    credited += share;
  }
  s.eq(
    "Treasury reserve got the rest",
    BigInt(await treasury.reserveOf(payToken)) - before.reserve,
    payAmount - credited,
  );
  return { vexOut, payAmount, receiptBlock: receipt.blockNumber };
}

/** Opens a USER stake of `vexAmount` in `poolId` and checks the stake, the sums, the cap base and the NC credits. */
export async function stakeVex(
  s: StepContext,
  w: World,
  a: Actor,
  poolId: number,
  vexAmount: bigint,
  sponsor: string,
  negatives = false,
): Promise<StakeRef> {
  const { staking, vex, network } = w.env.c;
  const pool = await staking.pool(poolId);
  s.check(`pool ${poolId} is launched and enabled`, Boolean(pool.launched) && Boolean(pool.enabled));
  const version = BigInt(pool.versionCount);
  const params = poolParams(await staking.poolVersion(poolId, version));
  const price = await w.vexPrice();
  const entryUsdt = mulDiv(vexAmount, price, WAD);
  s.check(`stake value ${entryUsdt} within the pool range`, entryUsdt >= params.usdtMin && entryUsdt <= params.usdtMax);
  const tables = await w.partnerTables();
  const upline = await w.upline(a.address, 15);
  const credBefore = await w.credits(upline.map((u) => u.address));
  const pre = {
    vex: await w.balanceOf(vex, a.address),
    total: BigInt(await staking.totalPrincipal()),
    p15: BigInt(await staking.openP15Now(a.address)),
    open: [...(await staking.openStakesOf(a.address))].map(BigInt),
  };
  await approveMax(s, w, a, "vex", w.env.addr("staking"));
  if (negatives) {
    await s.reverts(
      "stake with minUsdtValue above the value",
      w.as(staking, a).stake.staticCall(poolId, vexAmount, entryUsdt + 1n, sponsor),
      staking,
      "Slippage",
    );
    await s.reverts(
      "stake below the pool minimum",
      w.as(staking, a).stake.staticCall(poolId, 1n, 0, sponsor),
      staking,
      "OutOfRange",
    );
  }
  const receipt = await s.tx(`${a.name} stakes ${vexAmount} VEX in pool ${poolId}`, () =>
    w.as(staking, a).stake(poolId, vexAmount, entryUsdt, sponsor, w.ov()),
  );
  const opened = logsOf(receipt, staking, "StakeOpened")[0];
  s.check("StakeOpened emitted", opened !== undefined);
  const id = BigInt(opened.args.stakeId);
  s.eq("StakeOpened.poolId", opened.args.poolId, poolId);
  s.eq("StakeOpened.version", opened.args.version, version);
  s.eq("StakeOpened.source (USER)", opened.args.source, 0);
  s.eq("StakeOpened.principal", opened.args.principal, vexAmount);
  s.eq("StakeOpened.entryUsdt", opened.args.entryUsdt, entryUsdt);

  const block = await w.env.provider.getBlock(receipt.blockNumber);
  const openedAt = BigInt(block?.timestamp ?? 0);
  const view = await staking.stakeView(id);
  s.eq("stake owner", view.owner, a.address);
  s.eq("stake state (OPEN)", view.state, 1);
  s.eq("stake pool", view.poolId, poolId);
  s.eq("stake principal", view.principal, vexAmount);
  s.eq("stake entryUsdt", view.entryUsdt, entryUsdt);
  s.eq("stake openedAt", view.openedAt, openedAt);
  s.eq("stake maturesAt", view.maturesAt, maturesAt(params, openedAt));
  s.eq("stake earlyCloseFrom (48 h)", view.earlyCloseFrom, openedAt + 172_800n);
  s.eq("stake accrued at opening", view.accrued, 0);

  s.eq("VEX left the wallet", pre.vex - (await w.balanceOf(vex, a.address)), vexAmount);
  const open = [...(await staking.openStakesOf(a.address))].map(BigInt);
  s.check("open list holds the stake", open.includes(id) && open.length === pre.open.length + 1);
  s.eq("totalPrincipal grew", BigInt(await staking.totalPrincipal()) - pre.total, vexAmount);
  s.eq(
    "Network cap base = the largest open stake",
    (await network.capOf(a.address))[0],
    (await staking.largestOpenOf(a.address))[1],
  );
  if (params.jumpEligible) s.eq("openP15Now grew", BigInt(await staking.openP15Now(a.address)) - pre.p15, 1);

  const expected = distribute("NC", upline, vexAmount, tables, { l1Only: params.ncRule === 1, l1Bps: params.l1Bps });
  const credAfter = await w.credits(upline.map((u) => u.address));
  expectCredits(s, `stake in pool ${poolId}`, "NC", upline, expected, credBefore, credAfter);

  const ref: StakeRef = {
    id,
    owner: a.address,
    pool: poolId,
    principal: vexAmount,
    entryUsdt,
    openedAt: Number(openedAt),
    version,
    vexMark: BigInt(opened.args.vexMark),
    usdtMark: BigInt(opened.args.usdtMark),
  };
  w.stakes.set(a.name, [...w.stakesOf(a.name), ref]);
  return ref;
}

/** The smallest VEX amount whose value in USDT reaches `usdtMin` (the stake range is inclusive at the bottom). */
export function vexForUsdt(usdt: bigint, price: bigint): bigint {
  let vex = (usdt * WAD + price - 1n) / price;
  while (mulDiv(vex, price, WAD) < usdt) vex += 1n;
  return vex;
}

/** Buys a license with USDT and checks the list price, the NFT, the Treasury split and the License Rewards (VEX). */
export async function buyLicense(
  s: StepContext,
  w: World,
  a: Actor,
  tier: number,
  term: number,
  sponsor: string,
): Promise<{ id: bigint; price: bigint }> {
  const { licenseSale, license, usdt, treasury, network } = w.env.c;
  const id = BigInt(tier * 1000 + term);
  const [price, onSale] = await licenseSale.priceOf(tier, term);
  s.check(`license ${id} is on sale`, Boolean(onSale) && BigInt(price) > 0n);
  const quote = await licenseSale.quoteLicense(tier, term, usdt.target);
  s.eq("quoteLicense pay amount", quote[0], price);
  const vexPrice = await w.vexPrice();
  const tables = await w.partnerTables();
  const member = Boolean(await network.isMember(a.address));
  const upline = member
    ? await w.upline(a.address, 10)
    : sponsor === ZeroAddress
      ? []
      : await uplineOfFuture(w, sponsor);
  const credBefore = await w.credits(upline.map((u) => u.address));
  const owedBefore = BigInt(await network.licenseOwed());
  const wallets = [...(await treasury.wallets())].map((x) => ({ account: String(x.account), rate: BigInt(x.rateBps) }));
  const reserveBefore = BigInt(await treasury.reserveOf(usdt.target));
  const usdtBefore = await w.balanceOf(usdt, a.address);
  const unitsBefore = BigInt(await license.balanceOf(a.address, id));
  await approveMax(s, w, a, "usdt", w.env.addr("licenseSale"));
  const receipt = await s.tx(`${a.name} buys license ${id}`, () =>
    w.as(licenseSale, a).buyLicense(tier, term, usdt.target, price, sponsor, w.ov()),
  );
  const ev = logsOf(receipt, licenseSale, "LicenseBought")[0];
  s.check("LicenseBought emitted", ev !== undefined);
  s.eq("LicenseBought.licenseId", ev.args.licenseId, id);
  s.eq("LicenseBought.payAmount", ev.args.payAmount, price);
  s.eq("LicenseBought.usdtValue", ev.args.usdtValue, price);
  s.eq("license unit minted", BigInt(await license.balanceOf(a.address, id)) - unitsBefore, 1);
  s.eq("USDT paid", usdtBefore - (await w.balanceOf(usdt, a.address)), price);
  const credited = wallets.reduce((sum, x) => sum + mulDiv(price, x.rate, 10_000n), 0n);
  s.eq(
    "Treasury reserve got the rest",
    BigInt(await treasury.reserveOf(usdt.target)) - reserveBefore,
    price - credited,
  );

  const fullUpline = upline.length === 0 ? [] : upline;
  const expected = distribute("LR", fullUpline, price, tables, { price: vexPrice });
  const credAfter = await w.credits(fullUpline.map((u) => u.address));
  expectCredits(s, `license ${id}`, "LR", fullUpline, expected, credBefore, credAfter);
  // License Rewards are VEX on the cashback balance, nothing is owed in USDT any more
  s.eq("licenseOwed did not grow", BigInt(await network.licenseOwed()) - owedBefore, 0n);
  for (const u of fullUpline)
    s.eq(
      `license ${id}: USDT total of ${u.address} unchanged`,
      credAfter.get(u.address.toLowerCase())?.usdt ?? 0n,
      credBefore.get(u.address.toLowerCase())?.usdt ?? 0n,
    );
  return { id, price };
}

/** The upline a not yet registered buyer will have: its sponsor first, then the sponsor's own upline. */
async function uplineOfFuture(w: World, sponsor: string): Promise<Upline[]> {
  const m = await w.env.c.network.memberOf(sponsor);
  const first: Upline = {
    address: sponsor,
    frozen: Boolean(m.frozen),
    licenseActive: Boolean(m.licenseActive),
    tier: Number(m.tier),
    capBase: BigInt(m.capBase),
    capUsed: BigInt(m.capUsed),
  };
  return [first, ...(await w.upline(sponsor, 9))];
}

export async function activateLicense(s: StepContext, w: World, a: Actor, id: bigint): Promise<void> {
  const { licenseSale, license, network } = w.env.c;
  const tier = Number(id / 1000n);
  const term = Number(id % 1000n);
  const seqBefore = BigInt((await network.licenseOf(a.address))[2]);
  const units = BigInt(await license.balanceOf(a.address, id));
  const receipt = await s.tx(`${a.name} activates license ${id}`, () => w.as(licenseSale, a).activate(id, w.ov()));
  const at = BigInt((await w.env.provider.getBlock(receipt.blockNumber))?.timestamp ?? 0);
  const ev = logsOf(receipt, licenseSale, "LicenseActivated")[0];
  s.check("LicenseActivated emitted", ev !== undefined);
  s.eq("expiresAt = activation + term days, to the second", ev.args.expiresAt, at + BigInt(term) * BigInt(DAY));
  const lic = await w.env.until(
    () => network.licenseOf(a.address),
    (l) => BigInt(l[2]) > seqBefore,
  );
  s.eq("Network tier", lic[0], tier);
  s.eq("Network expiresAt", lic[1], at + BigInt(term) * BigInt(DAY));
  s.eq("activation sequence", lic[2], seqBefore + 1n);
  s.check("license running", Boolean(lic[3]));
  s.eq("unit burned", units - BigInt(await license.balanceOf(a.address, id)), 1);
}

/** Free Lite license for an account with an open own P1-P5 stake. */
export async function claimLite(s: StepContext, w: World, a: Actor): Promise<void> {
  const { licenseSale, license } = w.env.c;
  s.eq("liteStatusOf (0 = can claim)", await licenseSale.liteStatusOf(a.address), 0);
  const receipt = await s.tx(`${a.name} claims Lite`, () => w.as(licenseSale, a).claimLite(w.ov()));
  s.check("LiteClaimed emitted", logsOf(receipt, licenseSale, "LiteClaimed").length === 1);
  s.eq("Lite unit minted", await license.balanceOf(a.address, 30), 1);
  await s.reverts("a second Lite claim", w.as(licenseSale, a).claimLite.staticCall(), licenseSale, "LiteHeld");
}

export const KIND_NAMES = ["STAKING", "CASHBACK"];

/** One reward claim (`kind` 0 STAKING, 1 CASHBACK; the LICENSE kind 2 was removed) with the 90 / 5 / 5 split, BackFlow and the window. */
export async function claimReward(s: StepContext, w: World, a: Actor, kind: number, gross: bigint): Promise<void> {
  const { rewards, vex, usdt, tokenSale, treasury, network, staking } = w.env.c;
  const info = (await rewards.claimsOf(a.address))[kind];
  s.check(`${KIND_NAMES[kind]} window open`, Boolean(info.windowOpen));
  s.check(
    `${KIND_NAMES[kind]} claim ${gross} within [${info.minimum}, ${info.maximum}]`,
    gross >= BigInt(info.minimum) && gross <= BigInt(info.maximum),
  );
  const vexKind = kind !== 2;
  const tables = await w.partnerTables();
  const upline = await w.upline(a.address, 10);
  const credBefore = await w.credits(upline.map((u) => u.address));
  const pre = {
    vex: await w.balanceOf(vex, a.address),
    usdt: await w.balanceOf(usdt, a.address),
    vault: BigInt(await rewards.vaultBalance()),
    supply: BigInt(await vex.totalSupply()),
    credit: BigInt((await tokenSale.currentSellEntitlement(a.address))[2]),
    bonus: await network.bonusBalances(a.address),
    reserve: BigInt(await treasury.reserveOf(usdt.target)),
    owed: BigInt(await network.licenseOwed()),
  };
  const receipt = await s.tx(`${a.name} claims ${KIND_NAMES[kind]} ${gross}`, () =>
    w.as(rewards, a).claim(kind, gross, w.ov()),
  );
  const at = BigInt((await w.env.provider.getBlock(receipt.blockNumber))?.timestamp ?? 0);
  const ev = logsOf(receipt, rewards, "Claimed")[0];
  s.check("Claimed emitted", ev !== undefined);
  s.eq("Claimed.kind", ev.args.kind, kind);
  s.eq("Claimed.gross", ev.args.gross, gross);
  s.eq("lastClaimOf", await rewards.lastClaimOf(a.address, kind), at);
  if (kind === 0) {
    const used = logsOf(receipt, staking, "IncomeConsumed")[0];
    s.check("IncomeConsumed emitted", used !== undefined);
    s.eq("IncomeConsumed.amount", used.args.amount, gross);
  }
  if (vexKind) {
    const net = mulDiv(gross, 9000n, 10_000n);
    const burned = mulDiv(gross, 500n, 10_000n);
    s.eq("Claimed.net (90 %)", ev.args.net, net);
    s.eq("Claimed.burned (5 %)", ev.args.burned, burned);
    s.eq("Claimed.backflowBase", ev.args.backflowBase, gross);
    s.eq("VEX received", (await w.balanceOf(vex, a.address)) - pre.vex, net);
    s.eq("vault paid net + burn", pre.vault - BigInt(await rewards.vaultBalance()), net + burned);
    s.eq("VEX supply fell by the burn", pre.supply - BigInt(await vex.totalSupply()), burned);
    s.eq("sell credit of the payout", BigInt((await tokenSale.currentSellEntitlement(a.address))[2]) - pre.credit, net);
    const expected = distribute("BF", upline, gross, tables);
    const credAfter = await w.credits(upline.map((u) => u.address));
    expectCredits(s, `${KIND_NAMES[kind]} claim`, "BF", upline, expected, credBefore, credAfter);
    if (kind === 1) {
      const after = await network.bonusBalances(a.address);
      s.eq("cashback balance fell by the claim", BigInt(pre.bonus[0]) - BigInt(after[0]), gross);
    }
  } else {
    s.eq("Claimed.net (all of gross)", ev.args.net, gross);
    s.eq("Claimed.burned", ev.args.burned, 0);
    s.eq("Claimed.backflowBase", ev.args.backflowBase, 0);
    s.eq("USDT received", (await w.balanceOf(usdt, a.address)) - pre.usdt, gross);
    s.eq("Treasury reserve paid", pre.reserve - BigInt(await treasury.reserveOf(usdt.target)), gross);
    s.eq(
      "License Rewards balance fell",
      BigInt(pre.bonus[1]) - BigInt((await network.bonusBalances(a.address))[1]),
      gross,
    );
    s.eq("licenseOwed fell", pre.owed - BigInt(await network.licenseOwed()), gross);
  }
  await s.reverts(
    `second ${KIND_NAMES[kind]} claim within 24 h`,
    w.as(rewards, a).claim.staticCall(kind, gross),
    rewards,
    "TooSoon",
  );
}

/** FIFO sell-back of `vexAmount` at the lot prices. */
export async function sellBack(s: StepContext, w: World, a: Actor, vexAmount: bigint): Promise<void> {
  const { tokenSale, usdt, vex, treasury } = w.env.c;
  const quote = BigInt(await tokenSale.quoteSell(a.address, vexAmount));
  const lots = await tokenSale.lotsOf(a.address);
  let left = vexAmount;
  let expected = 0n;
  for (const lot of lots) {
    const take = BigInt(lot.vexAmount) < left ? BigInt(lot.vexAmount) : left;
    expected += mulDiv(take, BigInt(lot.price), WAD);
    left -= take;
  }
  s.eq("quoteSell = FIFO lot value", quote, expected);
  const pre = {
    usdt: await w.balanceOf(usdt, a.address),
    vex: await w.balanceOf(vex, a.address),
    reserve: BigInt(await treasury.reserveOf(usdt.target)),
    sellable: BigInt(await tokenSale.sellable(a.address)),
  };
  await approveMax(s, w, a, "vex", w.env.addr("tokenSale"));
  const receipt = await s.tx(`${a.name} sells back ${vexAmount} VEX`, () =>
    w.as(tokenSale, a).sell(vexAmount, quote, w.ov()),
  );
  const ev = logsOf(receipt, tokenSale, "Sold")[0];
  s.check("Sold emitted", ev !== undefined);
  s.eq("Sold.usdtAmount", ev.args.usdtAmount, quote);
  s.eq("USDT received", (await w.balanceOf(usdt, a.address)) - pre.usdt, quote);
  s.eq("VEX left the wallet", pre.vex - (await w.balanceOf(vex, a.address)), vexAmount);
  s.eq("Treasury reserve paid", pre.reserve - BigInt(await treasury.reserveOf(usdt.target)), quote);
  s.eq("sellable lots fell", pre.sellable - BigInt(await tokenSale.sellable(a.address)), vexAmount);
}

/** Sale at the current VEX price against the Treasury reserve, within the reserve floor and the daily caps. */
export async function sellCurrent(s: StepContext, w: World, a: Actor, vexAmount: bigint): Promise<void> {
  const { tokenSale, usdt, vex, treasury } = w.env.c;
  const price = await w.vexPrice();
  const feeBps = BigInt(await tokenSale.currentSellFeeBps());
  const gross = mulDiv(vexAmount, price, WAD);
  const fee = (gross * feeBps + 9_999n) / 10_000n;
  const q = await tokenSale.quoteSellAtCurrentPrice(vexAmount);
  s.eq("quote gross", q[0], gross);
  s.eq("quote fee", q[1], fee);
  const ent = await tokenSale.currentSellEntitlement(a.address);
  const lotVex = BigInt(ent[1]);
  s.check("amount within the entitlement", vexAmount <= BigInt(ent[0]), `<= ${ent[0]}`, vexAmount);
  const floor = await tokenSale.reserveFloor();
  const reserve = BigInt(await treasury.reserveOf(usdt.target));
  s.check(
    "reserve stays above the floor",
    reserve >= gross - fee + BigInt(floor[0]),
    `>= ${gross - fee + BigInt(floor[0])}`,
    reserve,
  );
  const room = await tokenSale.currentSellRoom(a.address);
  const pre = {
    usdt: await w.balanceOf(usdt, a.address),
    vex: await w.balanceOf(vex, a.address),
    reserve,
    sellable: BigInt(await tokenSale.sellable(a.address)),
    credit: BigInt(ent[2]),
  };
  await approveMax(s, w, a, "vex", w.env.addr("tokenSale"));
  const receipt = await s.tx(`${a.name} sells ${vexAmount} VEX at the current price`, () =>
    w.as(tokenSale, a).sellAtCurrentPrice(vexAmount, gross - fee, w.ov()),
  );
  const ev = logsOf(receipt, tokenSale, "SoldAtCurrentPrice")[0];
  s.check("SoldAtCurrentPrice emitted", ev !== undefined);
  const fromLots = vexAmount < lotVex ? vexAmount : lotVex;
  s.eq("event price", ev.args.price, price);
  s.eq("event net", ev.args.usdtNet, gross - fee);
  s.eq("lots consumed first", ev.args.lotsConsumed, fromLots);
  s.eq("USDT received", (await w.balanceOf(usdt, a.address)) - pre.usdt, gross - fee);
  s.eq("VEX left the wallet", pre.vex - (await w.balanceOf(vex, a.address)), vexAmount);
  s.eq("Treasury reserve paid", pre.reserve - BigInt(await treasury.reserveOf(usdt.target)), gross - fee);
  s.eq("lots fell by the lot part", pre.sellable - BigInt(await tokenSale.sellable(a.address)), fromLots);
  s.eq(
    "credit fell by the rest",
    pre.credit - BigInt((await tokenSale.currentSellEntitlement(a.address))[2]),
    vexAmount - fromLots,
  );
  const roomAfter = await tokenSale.currentSellRoom(a.address);
  s.eq("account cap room fell by the net", BigInt(room[0]) - BigInt(roomAfter[0]), gross - fee);
}

/** Expected accrual of `ref` at `at` with the freezes the account has now. */
export async function expectedAccrual(w: World, ref: StakeRef, at: bigint): Promise<bigint> {
  const params = await poolParamsOf(w.env.c.staking, ref.pool, ref.version);
  const fz = (await w.env.c.network.freezeIntervals(ref.owner)).map((f: { from: bigint; until: bigint }) => ({
    from: BigInt(f.from),
    until: BigInt(f.until),
  }));
  return accruedAt(params, ref.principal, BigInt(ref.openedAt), at, fz);
}

/** The partner credits a stake gives back when it is closed early, in VEX (legacy USDT credits are not deducted). */
export async function bonusVexOf(w: World, ref: StakeRef): Promise<bigint> {
  const t = await w.env.c.network.bonusTotals(ref.owner);
  const [vexCum, vexDed] = [BigInt(t[0]), BigInt(t[2])];
  const vexFrom = ref.vexMark > vexDed ? ref.vexMark : vexDed;
  return vexCum > vexFrom ? vexCum - vexFrom : 0n;
}

/** Early close of an open USER stake after the 48 h window: refund, fee, burn, partner credits, caps, state. */
export async function closeEarlyStake(s: StepContext, w: World, a: Actor, ref: StakeRef): Promise<void> {
  const { staking, vex, rewards, network } = w.env.c;
  const now = BigInt(await w.env.now());
  const accrued = await expectedAccrual(w, ref, now);
  const bonus = await bonusVexOf(w, ref);
  const expected = earlyClose(ref.principal, accrued, bonus);
  const p = await staking.previewEarlyClose(ref.id);
  s.eq("preview status (0 = can close)", p.status, 0);
  s.eq("preview accrued", p.accrued, accrued);
  s.eq("preview partner credits", p.bonusVex, bonus);
  s.eq("preview burn", p.burn, expected.burn);
  s.eq("preview fee to the vault", p.feeToVault, expected.feeToVault);
  s.eq("preview refund", p.refund, expected.refund);
  s.eq(
    "principal = refund + burn + fee to vault + deduction",
    expected.refund + expected.burn + expected.feeToVault + expected.deduction,
    ref.principal,
  );
  const totalsBefore = await network.bonusTotals(ref.owner);
  const pre = {
    vex: await w.balanceOf(vex, a.address),
    vault: BigInt(await rewards.vaultBalance()),
    supply: BigInt(await vex.totalSupply()),
    total: BigInt(await staking.totalPrincipal()),
    used: BigInt(await staking.refundUsedToday()),
  };
  const receipt = await s.tx(`${a.name} closes stake ${ref.id} early`, () =>
    w.as(staking, a).closeEarly(ref.id, w.ov()),
  );
  const ev = logsOf(receipt, staking, "StakeClosed")[0];
  s.check("StakeClosed emitted", ev !== undefined);
  s.eq("StakeClosed.kind (early)", ev.args.kind, 1);
  s.eq("StakeClosed.accrued", ev.args.accrued, accrued);
  s.eq("StakeClosed.burned", ev.args.burned, expected.burn);
  s.eq("StakeClosed.feeToVault", ev.args.feeToVault, expected.feeToVault);
  s.eq("StakeClosed.deduction (accrual + partner credits)", ev.args.deduction, expected.deduction);
  s.eq("StakeClosed.paid (refund)", ev.args.paid, expected.refund);
  s.eq("refund received", (await w.balanceOf(vex, a.address)) - pre.vex, expected.refund);
  s.eq(
    "vault received fee + deduction",
    BigInt(await rewards.vaultBalance()) - pre.vault,
    expected.feeToVault + expected.deduction,
  );
  s.eq("VEX supply fell by the burn", pre.supply - BigInt(await vex.totalSupply()), expected.burn);
  s.eq("totalPrincipal fell", pre.total - BigInt(await staking.totalPrincipal()), ref.principal);
  s.eq(
    "Network cap base follows the largest open stake",
    (await network.capOf(a.address))[0],
    (await staking.largestOpenOf(a.address))[1],
  );
  s.eq("refund counted against the daily cap", BigInt(await staking.refundUsedToday()) - pre.used, expected.refund);
  s.eq("stake state (CLOSED_EARLY)", (await staking.stakeView(ref.id)).state, 4);
  const totalsAfter = await network.bonusTotals(ref.owner);
  s.eq(
    "VEX credits marked as deducted",
    totalsAfter[2],
    BigInt(totalsBefore[0]) > BigInt(totalsBefore[2]) ? totalsBefore[0] : totalsBefore[2],
  );
  s.eq(
    "USDT credits marked as deducted",
    totalsAfter[3],
    BigInt(totalsBefore[1]) > BigInt(totalsBefore[3]) ? totalsBefore[1] : totalsBefore[3],
  );
  await s.reverts("closing the stake twice", w.as(staking, a).closeEarly.staticCall(ref.id), staking, "WrongState");
}

/** Close of a matured OPEN stake: the whole schedule settles, 5 % burns, FULL pays 95 % now, VEST starts to vest. */
export async function closeMaturedStake(s: StepContext, w: World, a: Actor, ref: StakeRef): Promise<void> {
  const { staking, vex, network } = w.env.c;
  const params = await poolParamsOf(staking, ref.pool, ref.version);
  const fz = (await network.freezeIntervals(ref.owner)).map((f: { from: bigint; until: bigint }) => ({
    from: BigInt(f.from),
    until: BigInt(f.until),
  }));
  const full = accruedAt(params, ref.principal, BigInt(ref.openedAt), BigInt(ref.openedAt) + 400n * BigInt(DAY), fz);
  const burned = mulDiv(ref.principal, 500n, 10_000n);
  const paid = params.returnMode === 1 ? ref.principal - burned : 0n;
  const pre = {
    vex: await w.balanceOf(vex, a.address),
    supply: BigInt(await vex.totalSupply()),
    total: BigInt(await staking.totalPrincipal()),
  };
  const receipt = await s.tx(`${a.name} closes matured stake ${ref.id}`, () =>
    w.as(staking, a).closeMatured(ref.id, w.ov()),
  );
  const at = BigInt((await w.env.provider.getBlock(receipt.blockNumber))?.timestamp ?? 0);
  const ev = logsOf(receipt, staking, "StakeClosed")[0];
  s.check("StakeClosed emitted", ev !== undefined);
  s.eq("StakeClosed.kind (matured)", ev.args.kind, 0);
  s.eq("StakeClosed.accrued = the whole schedule", ev.args.accrued, full);
  s.eq("StakeClosed.burned (5 %)", ev.args.burned, burned);
  s.eq("StakeClosed.paid", ev.args.paid, paid);
  s.eq("VEX received", (await w.balanceOf(vex, a.address)) - pre.vex, paid);
  s.eq("VEX supply fell by the burn", pre.supply - BigInt(await vex.totalSupply()), burned);
  s.eq("totalPrincipal fell", pre.total - BigInt(await staking.totalPrincipal()), burned + paid);
  const view = await staking.stakeView(ref.id);
  s.eq("stake state", view.state, params.returnMode === 1 ? 3 : 2);
  s.eq("closedAt", view.closedAt, at);
  await s.reverts("closing the stake twice", w.as(staking, a).closeMatured.staticCall(ref.id), staking, "WrongState");
}

/** One vesting claim of a VESTING stake; the total claimed must follow floor(total / P) per day from the close. */
export async function claimVestedStake(
  s: StepContext,
  w: World,
  a: Actor,
  ref: StakeRef,
  closedAt: bigint,
): Promise<bigint> {
  const { staking, vex } = w.env.c;
  const params = poolParams(await staking.poolVersion(ref.pool, ref.version));
  const before = await staking.stakeView(ref.id);
  const claimedBefore = BigInt(before.vestClaimed);
  const now = BigInt(await w.env.now());
  const vested = vestedAt(params, ref.principal, closedAt, now + 1n);
  const preVex = await w.balanceOf(vex, a.address);
  const receipt = await s.tx(`${a.name} claims vested VEX of stake ${ref.id}`, () =>
    w.as(staking, a).claimVested(ref.id, w.ov()),
  );
  const ev = logsOf(receipt, staking, "VestingClaimed")[0];
  s.check("VestingClaimed emitted", ev !== undefined);
  const at = BigInt((await w.env.provider.getBlock(receipt.blockNumber))?.timestamp ?? 0);
  const due = vestedAt(params, ref.principal, closedAt, at) - claimedBefore;
  s.check("something vested", due > 0n, "> 0", due);
  s.near("vesting claim follows the schedule", BigInt(ev.args.amount), due, 0n);
  s.eq("totalClaimed", ev.args.totalClaimed, claimedBefore + due);
  s.eq("VEX received (the vault is fee-exempt)", (await w.balanceOf(vex, a.address)) - preVex, due);
  const complete = claimedBefore + due === vestTotal(ref.principal);
  s.eq("stake state", (await staking.stakeView(ref.id)).state, complete ? 3 : 2);
  void vested;
  return claimedBefore + due;
}
