/**
 * Independent TypeScript models of the contract rules the E2E runner checks on chain: the staking accrual schedule,
 * the vesting schedule, the partner programs (Network Cashback, License Rewards, BackFlow) and the freeze ranges. They
 * are written from the rules of README / docs, not copied call by call, so a drift between contract and rule shows up
 * as a failed assertion. All amounts are bigint (constitution 7).
 */
import type { Contract } from "ethers";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const DAY = 86_400;
export const MOMENT_OFFSET = 6 * 3600;
const MAX = (1n << 256n) - 1n;

export const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface PoolParams {
  dailyBps: bigint;
  periodDays: bigint;
  maxProfitBps: bigint;
  payoutMode: number;
  returnMode: number;
  ncRule: number;
  l1Bps: bigint;
  jumpEligible: boolean;
  usdtMin: bigint;
  usdtMax: bigint;
  releaseDays: bigint[];
  /** The pool is on the two-halves schedule (Staking.poolHalves): the reward is released in two halves. */
  halves?: boolean;
}

/** Reads the struct an ethers call returns (named members) into plain bigints. */
export function poolParams(raw: Record<string, unknown>): PoolParams {
  const r = raw as unknown as Record<string, bigint | boolean | number | bigint[]>;
  return {
    dailyBps: BigInt(r.dailyBps as bigint),
    periodDays: BigInt(r.periodDays as bigint),
    maxProfitBps: BigInt(r.maxProfitBps as bigint),
    payoutMode: Number(r.payoutMode),
    returnMode: Number(r.returnMode),
    ncRule: Number(r.ncRule),
    l1Bps: BigInt(r.l1Bps as bigint),
    jumpEligible: Boolean(r.jumpEligible),
    usdtMin: BigInt(r.usdtMin as bigint),
    usdtMax: BigInt(r.usdtMax as bigint),
    releaseDays: [...(r.releaseDays as bigint[])].map((d) => BigInt(d)),
  };
}

/**
 * The version of pool `poolId` a stake runs on, with the two-halves flag of the pool. A Staking build without the flag
 * has no two-halves pool: the call fails there and the flag is off.
 */
export async function poolParamsOf(
  staking: Contract,
  poolId: bigint | number,
  version: bigint | number,
): Promise<PoolParams> {
  const params = poolParams(await staking.poolVersion(poolId, version));
  const halves = await staking.poolHalves(poolId).catch(() => false);
  return { ...params, halves: Boolean(halves) };
}

export interface FreezeInterval {
  from: bigint;
  until: bigint;
}

/** UTC dates whose 06:00 moment lies inside a freeze: pairs [first, end) (end = max while the freeze is in force). */
export function frozenRanges(intervals: FreezeInterval[]): Array<[bigint, bigint]> {
  return intervals.map((f) => [
    ceilDiv(f.from - BigInt(MOMENT_OFFSET), BigInt(DAY)),
    f.until === 0n ? MAX : ceilDiv(f.until - BigInt(MOMENT_OFFSET), BigInt(DAY)),
  ]);
}

const frozenDate = (ranges: Array<[bigint, bigint]>, date: bigint) =>
  ranges.some(([lo, hi]) => date >= lo && date < hi);

function frozenDays(ranges: Array<[bigint, bigint]>, first: bigint, last: bigint): bigint {
  let count = 0n;
  for (const [lo0, hi0] of ranges) {
    const lo = lo0 > first ? lo0 : first;
    const hi = hi0 > last ? last + 1n : hi0;
    if (hi > lo) count += hi - lo;
  }
  return count;
}

/** Reward moments due at `at`: moment k falls at 06:00 UTC of the opening day + k days, k = 1..period. */
export function momentsDue(openedAt: bigint, at: bigint, period: bigint): bigint {
  const base = (openedAt / BigInt(DAY)) * BigInt(DAY) + BigInt(MOMENT_OFFSET);
  if (at < base + BigInt(DAY)) return 0n;
  const k = (at - base) / BigInt(DAY);
  return k < period ? k : period;
}

/** The staking income of an OPEN stake at time `at` (frozen moments pay nothing and are forfeited). */
export function accruedAt(
  p: PoolParams,
  principal: bigint,
  openedAt: bigint,
  at: bigint,
  frozen: FreezeInterval[] = [],
): bigint {
  if (p.halves) return halvesAccruedAt(p, principal, openedAt, at, frozen);
  const due = momentsDue(openedAt, at, p.periodDays);
  if (due === 0n) return 0n;
  const ranges = frozenRanges(frozen);
  const first = openedAt / BigInt(DAY) + 1n;
  if (p.payoutMode === 0) {
    const paid = (due - frozenDays(ranges, first, first + due - 1n)) * mulDiv(principal, p.dailyBps, BPS);
    const cap = mulDiv(principal, p.maxProfitBps, BPS);
    return paid > cap ? cap : paid;
  }
  const dailyTotal = p.dailyBps * p.periodDays;
  const rate = dailyTotal < p.maxProfitBps ? dailyTotal : p.maxProfitBps;
  const whole = mulDiv(principal, rate, BPS);
  const part = whole / 3n;
  let total = 0n;
  for (let i = 0; i < 3; i++) {
    const day = p.releaseDays[i];
    if (day > due || frozenDate(ranges, first - 1n + day)) continue;
    total += i === 2 ? whole - 2n * part : part;
  }
  return total;
}

/**
 * Two-halves pools: the reward total (as for a three-part pool) in floor(total / 2) at 00:00 UTC of the opening date
 * + ceil(P / 2) days and the rest at 00:00 UTC of the opening date + P days. A release inside a freeze pays nothing.
 */
function halvesAccruedAt(
  p: PoolParams,
  principal: bigint,
  openedAt: bigint,
  at: bigint,
  frozen: FreezeInterval[],
): bigint {
  const day = BigInt(DAY);
  const date = openedAt / day;
  const dailyTotal = p.dailyBps * p.periodDays;
  const whole = mulDiv(principal, dailyTotal < p.maxProfitBps ? dailyTotal : p.maxProfitBps, BPS);
  const half = whole / 2n;
  const paid = (moment: bigint) =>
    at >= moment && !frozen.some((f) => f.from <= moment && (f.until === 0n || moment < f.until));
  let total = 0n;
  if (paid((date + (p.periodDays + 1n) / 2n) * day)) total += half;
  if (paid((date + p.periodDays) * day)) total += whole - half;
  return total;
}

/** 00:00 UTC of the opening day + period days (VEST pools) or + period + 1 (FULL pools). */
export function maturesAt(p: PoolParams, openedAt: bigint): bigint {
  return (openedAt / BigInt(DAY) + p.periodDays + (p.returnMode === 1 ? 1n : 0n)) * BigInt(DAY);
}

/** What a matured close leaves after the 5 % burn. */
export const vestTotal = (principal: bigint): bigint => principal - mulDiv(principal, 500n, BPS);

/** VEX vested so far by a VEST stake closed at `closedAt`: floor(total / P) per whole UTC day, all from day P on. */
export function vestedAt(p: PoolParams, principal: bigint, closedAt: bigint, at: bigint): bigint {
  const total = vestTotal(principal);
  const elapsed = at / BigInt(DAY) - closedAt / BigInt(DAY);
  return elapsed >= p.periodDays ? total : elapsed * (total / p.periodDays);
}

export interface EarlyClose {
  burn: bigint;
  feeToVault: bigint;
  deduction: bigint;
  refund: bigint;
}

/** Early close: 30 % fee (5 % of it burned), minus the stake's accrual and the partner credits since opening. */
export function earlyClose(principal: bigint, accrued: bigint, bonusVex: bigint): EarlyClose {
  const burn = mulDiv(principal, 500n, BPS);
  const fee = mulDiv(principal, 3000n, BPS);
  const deduction = accrued + bonusVex;
  return {
    burn,
    feeToVault: fee - burn,
    deduction,
    refund: fee + deduction < principal ? principal - fee - deduction : 0n,
  };
}

export interface PartnerTables {
  ncRates: bigint[];
  lrRates: bigint[];
  /** Levels paid per tier index 0 (Lite) .. 4 (Ultra). */
  ncLevels: bigint[];
  lrLevels: bigint[];
  bfBps: bigint;
  bfLevels: bigint;
}

/** One sponsor above the source, nearest first, as `Network.memberOf` reports it. */
export interface Upline {
  address: string;
  frozen: boolean;
  licenseActive: boolean;
  tier: number;
  capBase: bigint;
  capUsed: bigint;
}

export type Program = "NC" | "LR" | "BF";

export interface Credit {
  address: string;
  level: number;
  credit: bigint;
  /** 0 = credited, else the SKIP_* code of Network. */
  skip: number;
}

/**
 * The credits a partner program makes for `amount` (NC / BF: VEX of the stake or claim; LR: USDT list price) along
 * `upline`, all in VEX. Mirrors the README rules: frozen -> skip 1, no running license -> 2, level not paid -> 3, no cap
 * base -> 4, cap used up -> 5, dust -> 6; a credit is trimmed to the cap room. LR: the USDT share
 * is converted to VEX at the price (floored) and credited like the others; no price -> no credits.
 */
export function distribute(
  program: Program,
  upline: Upline[],
  amount: bigint,
  t: PartnerTables,
  opts: { l1Only?: boolean; l1Bps?: bigint; price?: bigint } = {},
): Credit[] {
  let depth: number;
  if (program === "NC") depth = opts.l1Only ? 1 : Number(t.ncLevels[4]);
  else if (program === "BF") depth = Number(t.bfLevels);
  else depth = opts.price ? Number(t.lrLevels[4]) : 0;
  const out: Credit[] = [];
  for (let d = 1; d <= depth && d <= upline.length; d++) {
    const n = upline[d - 1];
    const skip = (code: number): Credit => ({ address: n.address, level: d, credit: 0n, skip: code });
    if (n.frozen) {
      out.push(skip(1));
      continue;
    }
    if (!n.licenseActive) {
      out.push(skip(2));
      continue;
    }
    let rate: bigint;
    if (program === "BF") rate = t.bfBps;
    else if (program === "LR") rate = BigInt(d) <= t.lrLevels[n.tier] ? t.lrRates[d - 1] : 0n;
    else rate = opts.l1Only ? opts.l1Bps ?? 0n : BigInt(d) <= t.ncLevels[n.tier] ? t.ncRates[d - 1] : 0n;
    if (rate === 0n) {
      out.push(skip(3));
      continue;
    }
    if (n.capBase === 0n) {
      out.push(skip(4));
      continue;
    }
    const limit = mulDiv(n.capBase, n.tier === 0 ? 10_000n : 20_000n, BPS);
    let wanted = mulDiv(amount, rate, BPS);
    if (program === "LR" && wanted !== 0n) wanted = mulDiv(wanted, WAD, opts.price as bigint);
    if (wanted === 0n) {
      out.push(skip(6));
      continue;
    }
    const room = limit > n.capUsed ? limit - n.capUsed : 0n;
    if (room === 0n) {
      out.push(skip(5));
      continue;
    }
    const credit = wanted < room ? wanted : room;
    out.push({ address: n.address, level: d, credit, skip: 0 });
  }
  return out;
}
