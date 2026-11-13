import type { Deployment } from "./context";
import { type RoleRow, checkRoles, handoverModeOf, phaseOf, strangeHolders } from "./roles";
import { ABSENT, type Step, buildSteps, titleOf } from "./steps";
import { governanceRows } from "./timelockMove";
import { coreCheckRows } from "./upgradeCore";

export type Status = "OK" | "INFO" | "DRIFT";

export interface CheckRow {
  status: Status;
  group: string;
  item: string;
  want: string;
  have: string;
}

export const matches = (step: Step, have: string): boolean =>
  step.ok ? step.ok(have, step.want()) : have === step.want();

/** Reads every step's value from the chain and compares it with the params. */
export async function checkSteps(d: Deployment, steps = buildSteps(d)): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  for (const step of steps) {
    const have = await step.read();
    const ok = have !== ABSENT && matches(step, have);
    // initial-state items (funding, tunable limits) only report the live value once they were set
    const status: Status = ok ? "OK" : have !== ABSENT && step.soft && d.recorded(step.id) ? "INFO" : "DRIFT";
    rows.push({ status, group: step.group, item: titleOf(d, step), want: step.want(), have });
  }
  return rows;
}

export function roleRows(rows: RoleRow[]): CheckRow[] {
  return rows.map((r) => ({
    status: r.want === r.have ? "OK" : "DRIFT",
    group: r.contract,
    item: r.want ? `${r.role} held by ${r.holderName}` : `${r.role} must not be held by ${r.holderName}`,
    want: String(r.want),
    have: String(r.have),
  }));
}

export interface CheckResult {
  rows: CheckRow[];
  drift: number;
}

/** The post-deploy check: wiring and values, then the role holders for the phase of the hand-over. */
export async function runChecks(
  d: Deployment,
  opts: {
    holders?: boolean;
    /** First block of the holders scan (default: the deploy block of each contract). */
    holdersFrom?: number;
    chunk?: number;
  } = {},
): Promise<CheckResult> {
  const rows = await checkSteps(d);
  rows.push(...(await coreCheckRows(d)));
  rows.push(...(await governanceRows(d)));
  const roles = await checkRoles(d);
  if (opts.holders) roles.push(...(await strangeHolders(d, opts.chunk, opts.holdersFrom)));
  rows.push(...roleRows(roles));
  return { rows, drift: rows.filter((r) => r.status === "DRIFT").length };
}

const short = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export function printChecks(d: Deployment, result: CheckResult): void {
  const { log } = d;
  const kept = d.record.handover?.adminKeptBy;
  const governed = d.record.handover?.governance === "timelock" ? ", governance at the timelock" : "";
  const mode =
    handoverModeOf(d) === "safe" ? `, safe mode${governed}${kept ? `, DEFAULT_ADMIN kept by ${kept}` : ""}` : "";
  log(`Check of ${d.hre.network.name} (hand-over phase: ${phaseOf(d)}${mode})`);
  const groups = new Map<string, CheckRow[]>();
  for (const r of result.rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  for (const [group, rows] of groups) {
    log(`  ${group}`);
    for (const r of rows) {
      const detail = r.status === "OK" ? short(r.have, 48) : `want ${short(r.want)} have ${short(r.have)}`;
      log(`    ${r.status.padEnd(5)} ${short(r.item, 70).padEnd(70)} ${detail}`);
    }
  }
  const count = (s: Status) => result.rows.filter((r) => r.status === s).length;
  log(`${count("OK")} OK, ${count("INFO")} INFO (initial values changed since), ${result.drift} DRIFT`);
}
