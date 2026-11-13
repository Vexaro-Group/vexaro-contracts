import { type Contract, ZeroAddress } from "ethers";

import type { Deployment } from "./context";
import { withRetry } from "./roles";
import { attachable } from "./upgradeCore";

/** Pool id of Smart. */
export const SMART_POOL = 1;
const SOURCE_USER = 0;
const STATE_OPEN = 1;
/** Stakes read per call round and the most the scan accepts (the ids are 1..n without a gap). */
const BATCH = 20;
export const MAX_STAKES = 20_000;
const DAY = 86_400n;

/** What the scans need of one stake. */
export interface StakeRow {
  id: number;
  owner: string;
  poolId: number;
  version: number;
  source: number;
  state: number;
  openedAt: bigint;
  entryUsdt: bigint;
}

/**
 * Reads every stake (`stakeView`, ids 1..n; the first id without a state ends the list), a few at a time. Every call
 * is retried, there is nothing to resume: a run that stops simply starts again.
 */
export async function readStakes(staking: Contract): Promise<StakeRow[]> {
  const rows: StakeRow[] = [];
  for (let from = 1; from <= MAX_STAKES; from += BATCH) {
    const ids = Array.from({ length: BATCH }, (_, i) => from + i);
    const views = await Promise.all(ids.map((id) => withRetry(() => staking.stakeView(id))));
    for (const [i, v] of views.entries()) {
      if (Number(v.state) === 0) return rows;
      rows.push({
        id: ids[i],
        owner: v.owner,
        poolId: Number(v.poolId),
        version: Number(v.version),
        source: Number(v.source),
        state: Number(v.state),
        openedAt: BigInt(v.openedAt),
        entryUsdt: BigInt(v.entryUsdt),
      });
    }
  }
  throw new Error(`More than ${MAX_STAKES} stakes: the scan does not go further, raise MAX_STAKES in releaseScan.ts`);
}

/** The open stakes of one pool. */
export const openStakesOfPool = (rows: StakeRow[], poolId: number): StakeRow[] =>
  rows.filter((r) => r.poolId === poolId && r.state === STATE_OPEN);

/** One Jump cycle of a sponsor that has at least one slot filled. */
export interface SlotCycle {
  sponsor: string;
  cycleNo: number;
  /** Slots filled (4 = full). */
  slots: number;
  claimed: boolean;
  /** The stakes that filled the slots, derived from the stakes of the chain (one per counted invitee). */
  stakeIds: number[];
  /** The four stake ids are recorded on the Jump (a Jump without `slotStakesOf` records nothing). */
  recorded: boolean;
  problem?: string;
}

/**
 * The Jump cycles with a slot filled, read from the views only: the stakes that qualify for a slot (a USER stake of a
 * Jump-eligible pool worth at least the minimum, the first of an invitee that Jump has counted) are grouped by the
 * sponsor's cycle they opened in, and each group is compared with `Jump.cycle`. A full cycle that is not claimed and
 * whose four stakes are not recorded is the one `recordSlotStakes` has to be called for; the four ids come from here.
 */
export async function scanJump(d: Deployment, rows: StakeRow[]): Promise<SlotCycle[]> {
  const jump = await attachable(d, "Jump");
  const network = await attachable(d, "Network");
  const staking = await attachable(d, "Staking");
  if (!jump || !network || !staking) throw new Error("Jump, Network and Staking must be in the record");
  const minEntry = BigInt(await jump.MIN_ENTRY_USDT());
  const cycleDays = BigInt(await jump.CYCLE_DAYS());

  const eligible = new Map<string, boolean>();
  const jumpEligible = async (poolId: number, version: number) => {
    const key = `${poolId}:${version}`;
    if (!eligible.has(key)) eligible.set(key, Boolean((await staking.poolVersion(poolId, version)).jumpEligible));
    return eligible.get(key)!;
  };

  const groups = new Map<string, { sponsor: string; cycleNo: bigint; stakeIds: number[] }>();
  const counted = new Set<string>();
  for (const r of rows) {
    if (r.source !== SOURCE_USER || r.entryUsdt < minEntry || counted.has(r.owner)) continue;
    if (!(await jumpEligible(r.poolId, r.version)) || !(await jump.isCounted(r.owner))) continue;
    const sponsor: string = await network.sponsorOf(r.owner);
    const joined = BigInt(sponsor === ZeroAddress ? 0 : await network.joinedAt(sponsor));
    if (joined === 0n || r.openedAt / DAY < joined / DAY) continue;
    counted.add(r.owner);
    const cycleNo = (r.openedAt / DAY - joined / DAY) / cycleDays + 1n;
    const key = `${sponsor}:${cycleNo}`;
    const group = groups.get(key) ?? { sponsor, cycleNo, stakeIds: [] };
    group.stakeIds.push(r.id);
    groups.set(key, group);
  }

  const out: SlotCycle[] = [];
  for (const g of groups.values()) {
    const cycle = await jump.cycle(g.sponsor, g.cycleNo);
    const slots = Number(cycle.slots);
    if (slots === 0) continue;
    let recorded = false;
    try {
      recorded = BigInt((await jump.slotStakesOf(g.sponsor, g.cycleNo))[0]) !== 0n;
    } catch {
      // a Jump that predates the recording
    }
    out.push({
      sponsor: g.sponsor,
      cycleNo: Number(g.cycleNo),
      slots,
      claimed: Boolean(cycle.claimed),
      stakeIds: g.stakeIds,
      recorded,
      ...(slots === 4 && g.stakeIds.length !== 4
        ? { problem: `${g.stakeIds.length} stake(s) found for 4 slots: record them by hand` }
        : {}),
    });
  }
  return out;
}

/** Full cycles that are not claimed and whose slot stakes are not recorded: they need `recordSlotStakes`. */
export const needingRecord = (cycles: SlotCycle[]): SlotCycle[] =>
  cycles.filter((c) => c.slots === 4 && !c.claimed && !c.recorded);

/** Cycles that are not full yet: whoever fills them later still needs `recordSlotStakes` for the earlier slots. */
export const partialCycles = (cycles: SlotCycle[]): SlotCycle[] => cycles.filter((c) => c.slots < 4 && !c.claimed);
