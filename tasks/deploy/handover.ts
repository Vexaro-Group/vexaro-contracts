import { ZeroAddress, getAddress } from "ethers";

import { checkSteps, roleRows } from "./check";
import { DEFAULT_ADMIN_ROLE, type Deployment } from "./context";
import {
  GUARDIAN_CONTRACTS,
  checkRoles,
  expectedHolders,
  governanceRoles,
  handoverModeOf,
  roleHashOf,
  roleNames,
  timelockGoverned,
  withRetry,
} from "./roles";
import { type SafeInfo, inspectSafe } from "./safe";
import { deployTimelock } from "./timelockMove";
import { type ContractName, type HandoverMode, type HandoverRecord, ROLE_CONTRACTS } from "./types";
import { type Call, writeSafeBatch } from "./upgradeCore";
import { releaseRows } from "./upgradeRelease";

export interface HandoverOptions {
  /** Only deploy the timelock (`timelock` mode) and grant; leave the deployer's roles in place. */
  grantOnly?: boolean;
  /** Skip the grants (done earlier) and renounce, after checking that the targets hold everything. */
  renounceOnly?: boolean;
  /**
   * The deployer leaves every role it still holds (DEFAULT_ADMIN included), after the hand-over is complete, the
   * release upgrade is verified and the Safe holds every role that is still needed.
   */
  renounceAdmin?: boolean;
  /** `safe` mode: accept a Safe whose threshold is 1 (otherwise a run that sends refuses). */
  allowSingleOwner?: boolean;
  /** Blocks per log query of the scan that finds the roles the deployer holds (public RPCs cap the range). */
  logChunk?: number;
  /** Do not replay the `RoleGranted` events: only the roles the ABIs list are looked at. */
  skipLogScan?: boolean;
}

interface PlanItem {
  contract: ContractName;
  role: string;
  hash: string;
  /** `timelock` / `safe` hold the governance roles (the timelock or, in `safe` mode, the Safe); `multisig` the day-to-day ones. */
  to: "timelock" | "safe" | "multisig" | "guardian";
}

/**
 * The deployer's roles and where each goes: DEFAULT_ADMIN / UPGRADER and the VEX fee / exemption managers
 * behind the timelock (`safe` mode: straight to the Safe), OPERATOR / EXIT_PAUSER / License MINTER / PAUSER to the
 * multisig, GUARDIAN to the guardian. A role the deployer holds that this table does not know is a reason to stop.
 */
async function planOf(d: Deployment, mode: HandoverMode): Promise<PlanItem[]> {
  const plan: PlanItem[] = [];
  const safe = mode === "safe";
  for (const name of ROLE_CONTRACTS) {
    const c = await d.attach(name);
    if (!c) continue;
    const gov = governanceRoles(name);
    for (const role of roleNames(c.interface)) {
      const hash = await roleHashOf(role, c);
      if (!(await c.hasRole(hash, d.deployer))) continue;
      if (gov.timelock.includes(role))
        plan.push({ contract: name, role, hash, to: safe && !timelockGoverned(d) ? "safe" : "timelock" });
      else if (gov.multisig.includes(role)) plan.push({ contract: name, role, hash, to: safe ? "safe" : "multisig" });
      else if (role === "GUARDIAN_ROLE" && GUARDIAN_CONTRACTS.includes(name))
        plan.push({ contract: name, role, hash, to: "guardian" });
      else throw new Error(`The deployer holds ${name}.${role}, which the hand-over table does not know: decide first`);
    }
  }
  return plan;
}

/** Prints the Safe and refuses a run that sends while one signature moves everything (unless the flag accepts it). */
async function assertSafeThreshold(d: Deployment, safe: string, opts: HandoverOptions): Promise<SafeInfo | undefined> {
  const info = await inspectSafe(d, safe);
  if (!info) {
    d.log(`Safe ${safe}: an EOA stand-in (multisigIsContract is false); no owners to read`);
    return undefined;
  }
  d.log(`Safe ${safe} (version ${info.version}): ${info.owners.length} owner(s), threshold ${info.threshold}`);
  for (const owner of info.owners) d.log(`  owner ${owner}`);
  if (info.threshold < 2) {
    const text =
      `the threshold is ${info.threshold} (${info.owners.length} owner(s)): one signature moves every role and every upgrade. ` +
      "Add owners and raise the threshold first, or pass --allow-single-owner to accept it knowingly";
    if (d.mode === "dry-run") d.log(`WARNING a real run would refuse: ${text}`);
    else if (!opts.allowSingleOwner) throw new Error(`Refusing to hand over: ${text}`);
    else d.log(`WARNING ${text} (--allow-single-owner)`);
  }
  return info;
}

/**
 * The hand-over, in one of two modes (params `handoverMode`, default `timelock`; fixed by the record once it starts):
 *
 * - `timelock`: deploys an OZ TimelockController (delay from the params, the multisig is proposer / canceller /
 *   executor, no admin), grants the deployer's roles to their holders, checks that the targets hold every one, then the
 *   deployer renounces. GUARDIAN stays with the deployer when the params make the deployer the guardian (testnet).
 * - `safe`: no timelock; DEFAULT_ADMIN, UPGRADER and the VEX managers go straight to the
 *   multisig (the Safe) together with OPERATOR / EXIT_PAUSER / ..., the deployer renounces everything except
 *   DEFAULT_ADMIN, which it keeps as a backup until `--renounce-admin` (refused unless the Safe holds DEFAULT_ADMIN on
 *   every contract). The Safe's owners and threshold are read and printed; a threshold of 1 refuses unless
 *   `--allow-single-owner`. GUARDIAN is not touched.
 *
 * Every phase is idempotent and resumable.
 */
export async function runHandover(d: Deployment, opts: HandoverOptions = {}): Promise<void> {
  const { log, params } = d;
  if (d.mode === "check") throw new Error("The hand-over has no check mode; see task:deploy:check");
  if (opts.grantOnly && opts.renounceOnly) throw new Error("--grant-only and --renounce-only exclude each other");
  if (opts.renounceAdmin && (opts.grantOnly || opts.renounceOnly))
    throw new Error("--renounce-admin is a step of its own: it excludes --grant-only and --renounce-only");
  if (!d.record.complete) throw new Error("The deployment is not complete: finish `task:deploy:all` first");

  const multisig = getAddress(params.multisig);
  if (multisig === ZeroAddress) throw new Error("multisig is a placeholder");
  if (multisig === getAddress(d.deployer)) throw new Error("The multisig cannot be the deployer");
  if (params.multisigIsContract && (await d.hre.ethers.provider.getCode(multisig)) === "0x")
    throw new Error(`multisig ${multisig} has no code: expected the Safe proxy contract`);

  const mode = handoverModeOf(d);
  const asked = params.handoverMode ?? "timelock";
  if (d.record.handover && asked !== mode)
    throw new Error(`The hand-over already started in ${mode} mode (see the record), the params ask for ${asked}`);
  const safeInfo = mode === "safe" ? await assertSafeThreshold(d, multisig, opts) : undefined;

  if (d.mode === "dry-run") return dryRun(d, multisig, mode, opts);
  if (opts.renounceAdmin) return renounceAdmin(d, multisig, opts);

  // the wiring must be right before the roles move: after the hand-over the deployer cannot repair anything
  if (!d.record.handover?.completed) {
    const rows = (await checkSteps(d)).filter((r) => r.status === "DRIFT");
    if (rows.length > 0)
      throw new Error(
        `Refusing to hand over, the deployment drifted from the params:\n  ${rows.map((r) => r.item).join("\n  ")}`,
      );
  }

  // 1. the holder of the governance roles: the timelock (deployed here) or the Safe itself
  const prior = d.record.handover;
  if (prior && getAddress(prior.multisig) !== multisig)
    throw new Error("The hand-over already started with another multisig (see the record)");
  if (mode === "timelock" && prior && prior.timelockDelay !== params.timelockDelay)
    throw new Error("The hand-over already started with another multisig / delay (see the record)");
  let governor = multisig;
  if (mode === "timelock") {
    if (!d.record.contracts.TimelockController) await deployTimelock(d, multisig, params.timelockDelay);
    governor = d.record.contracts.TimelockController!.address;
    await assertTimelock(d, multisig, params.timelockDelay);
  } else if (timelockGoverned(d)) governor = getAddress(d.record.handover!.timelock!);
  const handover = (d.record.handover ??=
    mode === "safe"
      ? { mode, multisig, safe: multisig, granted: false, completed: false, adminKeptBy: getAddress(d.deployer) }
      : { multisig, timelock: governor, timelockDelay: params.timelockDelay, granted: false, completed: false });
  if (safeInfo) handover.safeOwners = { owners: safeInfo.owners, threshold: safeInfo.threshold };
  d.save();

  const holderOf = (item: PlanItem) =>
    item.to === "guardian"
      ? getAddress(params.guardian)
      : item.to === "multisig" || item.to === "safe"
        ? multisig
        : governor;
  const plan = (await planOf(d, mode)).filter((i) => !(i.to === "guardian" && holderOf(i) === getAddress(d.deployer)));
  // safe mode keeps the deployer's DEFAULT_ADMIN as a backup; every other role is renounced
  const keeping = (i: PlanItem) => mode === "safe" && !!handover.adminKeptBy && i.hash === DEFAULT_ADMIN_ROLE;
  const renouncing = plan.filter((i) => !keeping(i));

  const note = () => {
    const { txHashes, block } = d.takeTxs();
    if (mode === "safe" && txHashes.length > 0) {
      handover.at = { block: block!, txHashes: [...(handover.at?.txHashes ?? []), ...txHashes] };
      d.save();
    }
    return { txHash: txHashes[0], block };
  };

  // 2. grants
  if (!opts.renounceOnly) {
    for (const item of plan) {
      const c = (await d.attach(item.contract))!;
      const who = holderOf(item);
      if (await c.hasRole(item.hash, who)) {
        log(`skip   ${item.contract}.${item.role} is already held by the ${item.to} ${who}`);
        continue;
      }
      await d.send(c.grantRole(item.hash, who));
      const { txHash, block } = note();
      log(`granted ${item.contract}.${item.role} to ${item.to} ${who} (block ${block}, tx ${txHash})`);
    }
    handover.granted = true;
    d.save();
  }
  if (opts.grantOnly) {
    log("Grants done; the deployer still holds its roles (--grant-only).");
    return;
  }

  // 3. refuse unless the targets hold every role the deployer is about to give up
  const missing: string[] = [];
  for (const item of plan)
    if (!(await (await d.attach(item.contract))!.hasRole(item.hash, holderOf(item))))
      missing.push(`${item.contract}.${item.role} is not held by the ${item.to} ${holderOf(item)}`);
  if (missing.length > 0)
    throw new Error(`Refusing to renounce, the hand-over is incomplete:\n  ${missing.join("\n  ")}`);
  handover.granted = true;
  const grantedCheck = roleRows(await checkRoles(d, "granting")).filter((r) => r.status === "DRIFT");
  if (grantedCheck.length > 0)
    throw new Error(`Refusing to renounce, the role check found:\n  ${grantedCheck.map((r) => r.item).join("\n  ")}`);

  // 4. the deployer renounces, DEFAULT_ADMIN of each contract last (safe mode: it stays)
  for (const name of ROLE_CONTRACTS) {
    const c = await d.attach(name);
    if (!c) continue;
    const items = renouncing
      .filter((i) => i.contract === name)
      .sort((a, b) => Number(a.hash === DEFAULT_ADMIN_ROLE) - Number(b.hash === DEFAULT_ADMIN_ROLE));
    for (const item of items) {
      if (!(await c.hasRole(item.hash, d.deployer))) {
        log(`skip   the deployer holds no ${name}.${item.role} any more`);
        continue;
      }
      await d.send(c.renounceRole(item.hash, d.deployer));
      const { txHash, block } = note();
      log(`deployer renounced ${name}.${item.role} (block ${block}, tx ${txHash})`);
    }
  }

  // 5. only the new holders remain
  handover.completed = true;
  const left = roleRows(await checkRoles(d, "handed")).filter((r) => r.status === "DRIFT");
  if (left.length > 0) {
    handover.completed = false;
    d.save();
    throw new Error(`The role check after the hand-over found:\n  ${left.map((r) => r.item).join("\n  ")}`);
  }
  handover.block = await d.hre.ethers.provider.getBlockNumber();
  d.save();
  if (mode === "safe")
    log(
      `Hand-over complete (safe mode): every governance and day-to-day role -> the Safe ${multisig}, GUARDIAN untouched. ` +
        (handover.adminKeptBy
          ? `The deployer ${d.deployer} still holds DEFAULT_ADMIN on ${ROLE_CONTRACTS.length} contracts as a backup: run --renounce-admin when the Safe has proven itself.`
          : "The deployer holds no role."),
    );
  else
    log(
      `Hand-over complete: DEFAULT_ADMIN / UPGRADER / VEX managers -> timelock ${governor}, OPERATOR / EXIT_PAUSER -> ${multisig}.`,
    );
}

interface HeldRole {
  contract: ContractName;
  /** The name of the role, or its hash when no ABI knows it. */
  role: string;
  hash: string;
}

/** Roles nothing checks any more: the deployer may give them up without anybody taking them over. */
const RETIRED_ROLES = new Set(["Network.HOOK_ROLE"]);

/** The hashes of the roles `who` was ever granted on `contract` (its `RoleGranted` events, in chunks). */
async function grantedRoles(d: Deployment, name: ContractName, who: string, chunk: number): Promise<string[]> {
  const c = (await d.attach(name))!;
  const provider = d.hre.ethers.provider;
  const latest = await provider.getBlockNumber();
  const seen = new Set<string>();
  for (let from = d.record.contracts[name]?.deployBlock ?? 0; from <= latest; from += chunk) {
    const to = Math.min(from + chunk - 1, latest);
    for (const log of await withRetry(() => c.queryFilter(c.filters.RoleGranted(null, who), from, to)))
      seen.add((log as unknown as { args: [string] }).args[0]);
  }
  return [...seen];
}

/** The ten contracts and the timelock, when the deployment has one: where the deployer may still hold a role. */
const exitContracts = (d: Deployment): ContractName[] =>
  d.addr("TimelockController") ? [...ROLE_CONTRACTS, "TimelockController"] : ROLE_CONTRACTS;

/**
 * Every role `who` holds on the ten contracts (and the timelock), read from the chain: the roles the ABIs list and,
 * unless `scan` is off, every role its `RoleGranted` events name (a role no ABI knows is shown by its hash).
 */
async function rolesHeldBy(d: Deployment, who: string, opts: { scan: boolean; chunk: number }): Promise<HeldRole[]> {
  const held: HeldRole[] = [];
  for (const name of exitContracts(d)) {
    const c = await d.attach(name);
    if (!c) continue;
    const names = new Map<string, string>();
    for (const role of roleNames(c.interface)) names.set(await roleHashOf(role, c), role);
    const hashes = new Set(names.keys());
    if (opts.scan) for (const hash of await grantedRoles(d, name, who, opts.chunk)) hashes.add(hash);
    for (const hash of hashes)
      if (await c.hasRole(hash, who)) held.push({ contract: name, role: names.get(hash) ?? hash, hash });
  }
  return held;
}

interface ExitPlan {
  /** What the deployer holds now. */
  held: HeldRole[];
  /** Roles it keeps because the params make it their holder (the guardian of a test network). */
  keeping: HeldRole[];
  leaving: HeldRole[];
  /** Roles a required holder lacks: a grant by the Safe comes first (`holder` is the Safe when the Safe can make it). */
  missing: { contract: ContractName; role: string; hash: string; holder: string; viaSafe: boolean }[];
  /** Everything else the role check or the Safe's admin rights object to. */
  problems: string[];
}

/** The roles the deployer leaves, and what has to be true before it does. Read-only. */
async function planExit(d: Deployment, multisig: string, opts: HandoverOptions): Promise<ExitPlan> {
  const handover = d.record.handover!;
  // the Safe can make a missing grant only while it administers the contracts (not once the timelock does)
  const safeAdmin = handoverModeOf(d) === "safe" && !timelockGoverned(d);
  const governor = safeAdmin ? multisig : getAddress(handover.timelock ?? d.addr("TimelockController")!);
  const held = await rolesHeldBy(d, d.deployer, { scan: !opts.skipLogScan, chunk: opts.logChunk ?? 5000 });
  const me = getAddress(d.deployer);
  const keeping = held.filter((h) => expectedHolders(d, h.contract, h.role, "exiting").required.has(me));
  const leaving = held.filter((h) => !keeping.includes(h));
  const plan: ExitPlan = { held, keeping, leaving, missing: [], problems: [] };

  // the governor must be able to administer everything the deployer's backup administers
  for (const name of ROLE_CONTRACTS) {
    const c = await d.attach(name);
    if (c && !(await c.hasRole(DEFAULT_ADMIN_ROLE, governor)))
      plan.problems.push(
        `${name}.DEFAULT_ADMIN_ROLE is not held by the ${safeAdmin ? "Safe" : "timelock"} ${governor}`,
      );
  }
  if (plan.problems.length > 0) return plan;

  // every role the table expects someone else to hold, and every role of the deployer that nobody is meant to hold
  for (const r of await checkRoles(d, "exiting")) {
    if (r.want === r.have) continue;
    if (r.want && safeAdmin && getAddress(r.holder) === governor) {
      const c = (await d.attach(r.contract as ContractName))!;
      plan.missing.push({
        contract: r.contract as ContractName,
        role: r.role,
        hash: await roleHashOf(r.role, c),
        holder: governor,
        viaSafe: true,
      });
    } else
      plan.problems.push(
        `${r.role} ${r.want ? "is not held by" : "must not be held by"} ${r.holderName} (${r.contract})`,
      );
  }
  for (const item of leaving) {
    const needed = expectedHolders(d, item.contract, item.role, "exiting").required;
    if (needed.size > 0 || RETIRED_ROLES.has(`${item.contract}.${item.role}`)) continue;
    // a role that only the deployer holds and the tables do not know: the governor takes it over first
    const c = (await d.attach(item.contract))!;
    if (!(await c.hasRole(item.hash, governor))) plan.missing.push({ ...item, holder: governor, viaSafe: safeAdmin });
  }
  return plan;
}

/** The Safe batch of the grants that have to come first, as `grantRole(role, Safe)` calls. */
async function exitCalls(d: Deployment, plan: ExitPlan): Promise<Call[]> {
  const calls: Call[] = [];
  for (const m of plan.missing.filter((x) => x.viaSafe)) {
    const c = (await d.attach(m.contract))!;
    calls.push({
      id: `grant:${m.contract}.${m.role}`,
      title: `${m.contract}.grantRole(${m.role}, ${m.holder})`,
      contract: m.contract,
      data: c.interface.encodeFunctionData("grantRole", [m.hash, m.holder]),
      done: async () => (await c.hasRole(m.hash, m.holder)) as boolean,
    });
  }
  return calls;
}

/** Prints what is wrong with the plan; true when the deployer may leave. */
function reportExit(d: Deployment, plan: ExitPlan): boolean {
  for (const h of plan.keeping)
    d.log(`keep   ${h.contract}.${h.role}: the params make the deployer ${d.deployer} its holder`);
  for (const m of plan.missing) d.log(`MISSING ${m.contract}.${m.role} is not held by ${m.holder}`);
  for (const p of plan.problems) d.log(`PROBLEM ${p}`);
  return plan.missing.length === 0 && plan.problems.length === 0;
}

/**
 * The later step: the deployer leaves every role it still holds on the ten contracts, DEFAULT_ADMIN of each last.
 * Refuses unless the hand-over is complete, the release upgrade is verified (a deployment that is already on the
 * current build passes), the governor (the Safe, or the timelock) is DEFAULT_ADMIN on every contract and every role
 * that is still needed is held by its holder. A missing holder is named and, when it is the Safe, the grants are
 * written to a Safe batch file: they come first. Resumable: the roles are read from the chain on every run.
 */
async function renounceAdmin(d: Deployment, multisig: string, opts: HandoverOptions): Promise<void> {
  const { log } = d;
  const handover = d.record.handover as HandoverRecord | null;
  if (!handover || !handover.completed)
    throw new Error(
      `Refusing to renounce the deployer's roles: run the ${
        handoverModeOf(d) === "safe" ? "safe-mode " : ""
      }hand-over to the end first`,
    );
  if (needsGovernanceMove(d) && handover.adminKeptBy != null)
    throw new Error(
      "Refusing to renounce the deployer's roles: the governance roles are still with the Safe. " +
        "Move them to the timelock first (task:governance:timelock); the deployer leaves after that",
    );

  const drift = (await releaseRows(d)).filter((r) => r.status === "DRIFT");
  if (drift.length > 0)
    throw new Error(
      `Refusing to renounce the deployer's roles, the release upgrade is not verified (task:upgrade:release --check):\n  ${drift
        .map((r) => r.item)
        .join("\n  ")}`,
    );

  const plan = await planExit(d, multisig, opts);
  if (plan.held.length === 0 && handover.adminKeptBy == null) {
    log("The deployer renounced DEFAULT_ADMIN before (see the record) and holds no role; nothing to do.");
    return;
  }
  const safeMode = handoverModeOf(d) === "safe";
  const safeAdmin = safeMode && !timelockGoverned(d);
  const adminless = plan.problems.filter((p) => p.includes("DEFAULT_ADMIN_ROLE is not held by the"));
  if (adminless.length > 0)
    throw new Error(
      `Refusing to renounce DEFAULT_ADMIN, the ${
        safeAdmin ? "Safe" : "timelock"
      } is not admin everywhere:\n  ${adminless.join("\n  ")}`,
    );
  if (!reportExit(d, plan)) {
    const calls = await exitCalls(d, plan);
    if (calls.length > 0)
      handover.exitSafe = await writeSafeBatch(d, {
        fileId: "deployer-exit",
        title: `Vexaro roles for the Safe before the deployer leaves (${d.hre.network.name})`,
        calls,
        previous: handover.exitSafe,
      });
    d.save();
    throw new Error(
      `Refusing to renounce, the role check found:\n  ${[
        ...plan.missing.map((m) => `${m.role} held by ${m.holder === multisig ? "safe" : m.holder} (${m.contract})`),
        ...plan.problems,
      ].join("\n  ")}${
        calls.length > 0 ? "\nThe Safe has to make these grants first: see the batch file written above." : ""
      }`,
    );
  }

  const order = (a: HeldRole, b: HeldRole) =>
    Number(a.hash === DEFAULT_ADMIN_ROLE) - Number(b.hash === DEFAULT_ADMIN_ROLE);
  for (const name of exitContracts(d)) {
    const c = await d.attach(name);
    if (!c) continue;
    for (const item of plan.leaving.filter((h) => h.contract === name).sort(order)) {
      if (!(await c.hasRole(item.hash, d.deployer))) {
        log(`skip   the deployer holds no ${name}.${item.role} any more`);
        continue;
      }
      await d.send(c.renounceRole(item.hash, d.deployer));
      const { txHashes, block } = d.takeTxs();
      handover.renouncedAdminAt = {
        block: block!,
        txHashes: [...(handover.renouncedAdminAt?.txHashes ?? []), ...txHashes],
      };
      handover.renouncedRoles = [...new Set([...(handover.renouncedRoles ?? []), `${name}.${item.role}`])];
      d.save();
      log(`deployer renounced ${name}.${item.role} (block ${block}, tx ${txHashes[0]})`);
    }
  }

  // the chain is the truth: the record says so even if the final check below finds something else
  if (safeMode) handover.adminKeptBy = null;
  handover.block = await d.hre.ethers.provider.getBlockNumber();
  d.save();
  const left = roleRows(await checkRoles(d, "handed")).filter((r) => r.status === "DRIFT");
  if (left.length > 0)
    throw new Error(`The role check after the deployer left found:\n  ${left.map((r) => r.item).join("\n  ")}`);
  log(
    `The deployer holds no role any more${
      plan.keeping.length > 0 ? " but the ones above" : ""
    }. DEFAULT_ADMIN renounced: ` +
      `the ${safeAdmin ? "Safe" : "timelock"} ${safeAdmin ? multisig : handover.timelock} is the only admin of ${
        ROLE_CONTRACTS.length
      } contracts.`,
  );
}

/** `safe` mode whose params ask for a timelock over the governance roles, which has not taken them over yet. */
export function needsGovernanceMove(d: Deployment): boolean {
  return handoverModeOf(d) === "safe" && !!d.params.timelockGovernance && !timelockGoverned(d);
}

async function assertTimelock(d: Deployment, multisig: string, delay: number): Promise<void> {
  const timelock = (await d.attach("TimelockController"))!;
  const problems: string[] = [];
  if (Number(await timelock.getMinDelay()) !== delay) problems.push(`min delay is not ${delay} s`);
  for (const role of ["PROPOSER_ROLE", "CANCELLER_ROLE", "EXECUTOR_ROLE"])
    if (!(await timelock.hasRole(await timelock[role](), multisig))) problems.push(`the multisig lacks ${role}`);
  if (await timelock.hasRole(DEFAULT_ADMIN_ROLE, d.deployer)) problems.push("the deployer is a timelock admin");
  if (!(await timelock.hasRole(DEFAULT_ADMIN_ROLE, await timelock.getAddress())))
    problems.push("the timelock is not its own admin");
  if (problems.length > 0) throw new Error(`TimelockController ${await timelock.getAddress()}: ${problems.join("; ")}`);
}

async function dryRun(d: Deployment, multisig: string, mode: HandoverMode, opts: HandoverOptions): Promise<void> {
  if (opts.renounceAdmin) return dryRunRenounceAdmin(d, multisig, opts);
  const existing = d.record.contracts.TimelockController?.address;
  if (mode === "timelock")
    d.log(
      `would ${
        existing
          ? `reuse TimelockController ${existing}`
          : `deploy a TimelockController (delay ${d.params.timelockDelay} s, proposer / canceller / executor ${multisig}, no admin)`
      }`,
    );
  else if (timelockGoverned(d))
    d.log(`the governance roles are at the timelock ${existing}; the Safe keeps the day-to-day ones`);
  else d.log("no TimelockController in safe mode: the roles go straight to the Safe");
  const plan = await planOf(d, mode);
  const keepAdmin = mode === "safe" && d.record.handover?.adminKeptBy !== null;
  const where = (item: PlanItem) =>
    item.to === "timelock" ? existing ?? "<TimelockController>" : item.to === "guardian" ? d.params.guardian : multisig;
  const moving = plan.filter((i) => !(i.to === "guardian" && getAddress(d.params.guardian) === getAddress(d.deployer)));
  const renouncing = moving.filter((i) => !(keepAdmin && i.hash === DEFAULT_ADMIN_ROLE));
  let grants = 0;
  if (!opts.renounceOnly)
    for (const item of moving) {
      const c = (await d.attach(item.contract))!;
      if (item.to === "timelock" && !existing) {
        grants += 1;
        d.log(`would grant ${item.contract}.${item.role} to ${item.to} ${where(item)}`);
      } else if (await c.hasRole(item.hash, where(item)))
        d.log(`skip   ${item.contract}.${item.role} is already held by the ${item.to} ${where(item)}`);
      else {
        grants += 1;
        d.log(`would grant ${item.contract}.${item.role} to ${item.to} ${where(item)}`);
      }
    }
  if (!opts.grantOnly)
    for (const item of renouncing)
      d.log(`would renounce ${item.contract}.${item.role} from the deployer ${d.deployer}`);
  const txs = grants + (opts.grantOnly ? 0 : renouncing.length);
  if (mode === "safe") {
    const keeps = moving.length - renouncing.length;
    if (keeps > 0)
      d.log(`would keep DEFAULT_ADMIN_ROLE of the deployer ${d.deployer} on ${keeps} contract(s) (backup)`);
    d.log(`Dry-run done: ${txs} transaction(s); nothing was sent.`);
  } else d.log(`Dry-run done: ${txs} transaction(s) plus the timelock deployment; nothing was sent.`);
}

async function dryRunRenounceAdmin(d: Deployment, multisig: string, opts: HandoverOptions): Promise<void> {
  const handover = d.record.handover;
  if (!handover || !handover.completed) {
    d.log("WARNING a real run would refuse: the hand-over is not complete yet");
    d.log("Dry-run done: 0 transaction(s); nothing was sent.");
    return;
  }
  if (needsGovernanceMove(d))
    d.log("WARNING a real run would refuse: the governance roles are still with the Safe (task:governance:timelock)");
  const drift = (await releaseRows(d)).filter((r) => r.status === "DRIFT");
  for (const r of drift) d.log(`WARNING a real run would refuse: the release upgrade is not verified: ${r.item}`);
  const plan = await planExit(d, multisig, opts);
  d.log(`the deployer ${d.deployer} holds ${plan.held.length} role(s) on the ${exitContracts(d).length} contracts:`);
  for (const h of plan.held) d.log(`  ${h.contract}.${h.role}`);
  const ok = reportExit(d, plan);
  if (!ok) d.log("WARNING a real run would refuse: the roles above are missing; the Safe makes these grants first");
  for (const h of plan.leaving) d.log(`would renounce ${h.contract}.${h.role} from the deployer ${d.deployer}`);
  d.log(`Dry-run done: ${plan.leaving.length} transaction(s); nothing was sent.`);
}
