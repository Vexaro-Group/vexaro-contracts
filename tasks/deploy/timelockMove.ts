import { type Contract, ContractFactory, ZeroAddress, formatEther, formatUnits, getAddress } from "ethers";

import type { CheckRow } from "./check";
import { DEFAULT_ADMIN_ROLE, type Deployment } from "./context";
import { MAINNET_CHAIN_ID } from "./params";
import { exportAbi } from "./record";
import { governanceRoles, handoverModeOf, roleHashOf, roleNames, timelockGoverned, withRetry } from "./roles";
import { inspectSafe } from "./safe";
import { type ContractName, GOVERNANCE_TIMELOCK_DELAY, type HandoverRecord, ROLE_CONTRACTS } from "./types";

export interface MoveOptions {
  /** Seconds of the timelock delay; defaults to the params' `timelockDelay`. */
  delay?: number;
  /** Mainnet only: accept a delay other than 24 hours. */
  allowOtherDelay?: boolean;
  /** Stop after this step id (`deploy:timelock`, `grant:<Contract>.<ROLE>`, `revoke:<Contract>.<ROLE>`); the next run resumes. */
  stopAfter?: string;
  /** Blocks per log query of the scan that looks for strangers on the timelock (public RPCs cap the range). */
  logChunk?: number;
}

/** A role of the hand-over table: a governance role moves from the Safe to the timelock, a day-to-day role stays. */
interface MoveRole {
  contract: ContractName;
  role: string;
  hash: string;
}

const TIMELOCK_ROLES = ["PROPOSER_ROLE", "CANCELLER_ROLE", "EXECUTOR_ROLE"];
/** An address that holds no role: the grants are priced against it while the timelock does not exist yet. */
const STAND_IN = getAddress("0x000000000000000000000000000000000000dEaD");

/** The roles of one column of the hand-over table, with their hashes, on the contracts that exist. */
async function tableRoles(d: Deployment, column: "timelock" | "multisig"): Promise<MoveRole[]> {
  const out: MoveRole[] = [];
  for (const name of ROLE_CONTRACTS) {
    const c = await d.attach(name);
    if (!c) continue;
    for (const role of governanceRoles(name)[column])
      out.push({ contract: name, role, hash: await roleHashOf(role, c) });
  }
  return out;
}

/** The roles the Safe moves to the timelock: DEFAULT_ADMIN, UPGRADER and the VEX managers. */
export const governanceItems = (d: Deployment) => tableRoles(d, "timelock");
/** The roles that stay with the Safe: OPERATOR, EXIT_PAUSER, AIRDROP_RELEASER, License MINTER / PAUSER. */
export const operationalItems = (d: Deployment) => tableRoles(d, "multisig");

const label = (m: MoveRole) => `${m.contract}.${m.role}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The delay the timelock is made with; mainnet accepts only 24 hours unless the flag says otherwise. */
export function moveDelay(d: Deployment, opts: MoveOptions): number {
  const delay = opts.delay ?? d.params.timelockDelay;
  if (!Number.isInteger(delay) || delay <= 0)
    throw new Error(`The timelock delay must be a whole number of seconds > 0, got ${delay}`);
  if (d.record.chainId === MAINNET_CHAIN_ID && delay !== GOVERNANCE_TIMELOCK_DELAY && !opts.allowOtherDelay)
    throw new Error(
      `Refusing a timelock delay of ${delay} s on mainnet: it is ${GOVERNANCE_TIMELOCK_DELAY} s (24 hours). Pass --allow-other-delay to use another one knowingly`,
    );
  return delay;
}

/** The hand-over this move continues: complete, in safe mode. */
function handoverOf(d: Deployment): HandoverRecord {
  const h = d.record.handover;
  if (!d.record.complete) throw new Error("The deployment is not complete: finish `task:deploy:all` first");
  if (!h || !h.completed)
    throw new Error("The safe-mode hand-over is not complete: run `task:deploy:handover` to the end first");
  if (handoverModeOf(d) !== "safe")
    throw new Error("The governance move continues a safe-mode hand-over; the timelock mode has its timelock already");
  if (getAddress(h.multisig) !== getAddress(d.params.multisig))
    throw new Error("The hand-over was made with another multisig (see the record)");
  return h;
}

interface MoveState {
  /** Governance roles the timelock does not hold yet. */
  grants: MoveRole[];
  /** Governance roles the Safe still holds. */
  revokes: MoveRole[];
  /** Day-to-day roles the Safe does not hold. */
  missingOps: MoveRole[];
}

/** What is left to do, read from the chain (the timelock may not exist yet: then every grant is left). */
async function stateOf(d: Deployment, timelock: string | undefined): Promise<MoveState> {
  const safe = getAddress(d.params.multisig);
  const state: MoveState = { grants: [], revokes: [], missingOps: [] };
  for (const item of await governanceItems(d)) {
    const c = (await d.attach(item.contract))!;
    if (!timelock || !(await c.hasRole(item.hash, timelock))) state.grants.push(item);
    if (await c.hasRole(item.hash, safe)) state.revokes.push(item);
  }
  for (const item of await operationalItems(d)) {
    const c = (await d.attach(item.contract))!;
    if (!(await c.hasRole(item.hash, safe))) state.missingOps.push(item);
  }
  return state;
}

/** DEFAULT_ADMIN of each contract last, so that the Ledger keeps the right to revoke until its own revoke is done. */
const adminLast = (a: MoveRole, b: MoveRole) =>
  Number(a.hash === DEFAULT_ADMIN_ROLE) - Number(b.hash === DEFAULT_ADMIN_ROLE);

function inOrder(items: MoveRole[]): MoveRole[] {
  return ROLE_CONTRACTS.flatMap((name) => items.filter((i) => i.contract === name).sort(adminLast));
}

/** Everything wrong with the timelock itself; empty when it is exactly what the move needs. */
async function timelockProblems(d: Deployment, delay: number, chunk: number): Promise<string[]> {
  const safe = getAddress(d.params.multisig);
  const record = d.record.contracts.TimelockController!;
  const timelock = (await d.attach("TimelockController"))!;
  const address = getAddress(record.address);
  const problems: string[] = [];
  if ((await d.hre.ethers.provider.getCode(address)) === "0x") return [`TimelockController ${address} has no code`];
  const have = Number(await timelock.getMinDelay());
  if (have !== delay) problems.push(`the min delay is ${have} s, not ${delay} s`);
  for (const role of TIMELOCK_ROLES)
    if (!(await timelock.hasRole(await timelock[role](), safe))) problems.push(`the Safe lacks ${role}`);
  if (!(await timelock.hasRole(DEFAULT_ADMIN_ROLE, address))) problems.push("the timelock is not its own admin");
  if (await timelock.hasRole(DEFAULT_ADMIN_ROLE, d.deployer)) problems.push("the deployer is an admin of the timelock");

  // nobody else: every grant the timelock ever made is replayed and its holder is looked at
  const allowed = new Map<string, string>([[DEFAULT_ADMIN_ROLE, address]]);
  for (const role of TIMELOCK_ROLES) allowed.set(await timelock[role](), safe);
  const latest = await d.hre.ethers.provider.getBlockNumber();
  const seen = new Set<string>();
  for (let from = record.deployBlock ?? 0; from <= latest; from += chunk) {
    const to = Math.min(from + chunk - 1, latest);
    for (const log of await withRetry(() => timelock.queryFilter(timelock.filters.RoleGranted(), from, to))) {
      const [role, account] = (log as unknown as { args: [string, string] }).args;
      seen.add(`${role}:${getAddress(account)}`);
    }
  }
  for (const key of seen) {
    const [role, who] = key.split(":");
    if (getAddress(allowed.get(role) ?? ZeroAddress) === who || !(await timelock.hasRole(role, who))) continue;
    const names = await Promise.all(
      ["DEFAULT_ADMIN_ROLE", ...TIMELOCK_ROLES].map(async (r) => [r, await roleHashOf(r, timelock)] as const),
    );
    problems.push(`${who} holds ${names.find(([, h]) => h === role)?.[0] ?? role} of the timelock`);
  }
  return problems;
}

/** Deploys the timelock (proposer, canceller and executor: the multisig; no admin, it administers itself) and records it. */
export async function deployTimelock(d: Deployment, multisig: string, delay: number): Promise<void> {
  const factory = await d.hre.ethers.getContractFactory("TimelockController", d.signer);
  const timelock = await factory.deploy(delay, [multisig], [multisig], ZeroAddress);
  const receipt = await timelock.deploymentTransaction()!.wait();
  d.sent += 1;
  d.record.contracts.TimelockController = {
    address: await timelock.getAddress(),
    abi: d.dir ? await exportAbi(d.hre, d.dir, "TimelockController", "TimelockController") : undefined,
    deployBlock: receipt!.blockNumber,
    txHash: receipt!.hash,
  };
  d.save();
  await d.settle();
  d.log(`deployed TimelockController at ${d.record.contracts.TimelockController.address} (delay ${delay} s)`);
}

/** After a transaction a load-balanced public RPC may answer from the previous block: poll a little. */
async function confirmed(d: Deployment, holds: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < (d.local ? 1 : 10); i++) {
    if (await holds()) return true;
    await sleep(2000);
  }
  return false;
}

/** Prints the Safe and warns about a threshold of 1 (this move takes powers from the Safe, it adds none). */
async function printSafe(d: Deployment, safe: string): Promise<void> {
  const info = await inspectSafe(d, safe);
  if (!info) {
    d.log(`Safe ${safe}: an EOA stand-in (multisigIsContract is false); no owners to read`);
    return;
  }
  d.log(`Safe ${safe} (version ${info.version}): ${info.owners.length} owner(s), threshold ${info.threshold}`);
  for (const owner of info.owners) d.log(`  owner ${owner}`);
  if (info.threshold < 2)
    d.log(
      `WARNING the threshold is ${info.threshold}: one owner would propose, cancel and execute every governance call`,
    );
}

/** The deployer signs everything: it must still be DEFAULT_ADMIN of the contracts it grants and revokes on. */
async function assertDeployerAdmin(d: Deployment): Promise<void> {
  const missing: string[] = [];
  for (const name of ROLE_CONTRACTS) {
    const c = await d.attach(name);
    if (c && !(await c.hasRole(DEFAULT_ADMIN_ROLE, d.deployer))) missing.push(name);
  }
  if (missing.length > 0) {
    const names = missing.join(", ");
    throw new Error(
      `The deployer ${d.deployer} is not DEFAULT_ADMIN of ${names}: this move is signed by the deployer, so it has to be done before the deployer leaves (--renounce-admin)`,
    );
  }
}

// --------------------------------------------------------------------------------------------- the move

/**
 * Moves the governance roles of a safe-mode deployment from the Safe to a TimelockController the Safe alone proposes
 * to, cancels on and executes from, with the deployer signing every transaction:
 *
 * 1. deploys `TimelockController(delay, [Safe], [Safe], 0)` (no admin: it administers itself);
 * 2. grants DEFAULT_ADMIN (all contracts), UPGRADER and the VEX fee / exemption managers to it;
 * 3. checks the timelock (code, delay, the Safe is the only proposer / canceller / executor, no other admin), that it
 *    holds every governance role and that the Safe still holds every day-to-day role;
 * 4. revokes the governance roles from the Safe;
 * 5. writes the record, once the calls are seen on chain.
 *
 * The deployer leaves afterwards, with `task:deploy:handover --renounce-admin`. Every step reads the chain first, so
 * a run after a stop sends only what is missing.
 */
export async function runGovernanceMove(d: Deployment, opts: MoveOptions = {}): Promise<void> {
  const { log } = d;
  if (d.mode === "check") throw new Error("The governance move has its own --check; see task:governance:timelock");
  const delay = moveDelay(d, opts);
  const handover = handoverOf(d);
  const safe = getAddress(d.params.multisig);
  if (d.mode === "dry-run") return dryRun(d, delay, opts);
  const chunk = opts.logChunk ?? 5000;

  if (handover.governance === "timelock") {
    const rows = (await moveRows(d, delay, chunk)).filter((r) => r.status === "DRIFT");
    if (rows.length > 0)
      throw new Error(
        `The governance moved to the timelock before, but the chain differs:\n  ${rows
          .map((r) => r.item)
          .join("\n  ")}`,
      );
    log(
      `The governance roles are at the timelock ${handover.timelock} (delay ${handover.timelockDelay} s); nothing to do.`,
    );
    return;
  }

  await printSafe(d, safe);
  const note = (extra: string[] = []) => {
    const { txHashes, block } = d.takeTxs();
    handover.governanceMoveAt = {
      block: block ?? handover.governanceMoveAt?.block ?? d.record.contracts.TimelockController?.deployBlock ?? 0,
      txHashes: [...(handover.governanceMoveAt?.txHashes ?? []), ...extra, ...txHashes],
    };
    d.save();
    return { txHash: txHashes[0], block };
  };
  const stop = (id: string) => {
    if (opts.stopAfter !== id) return false;
    log(`Stopped after ${id} (--stop-after); run again to resume.`);
    return true;
  };

  // 1. the timelock
  if (!d.record.contracts.TimelockController) {
    await assertDeployerAdmin(d);
    await deployTimelock(d, safe, delay);
    note([d.record.contracts.TimelockController!.txHash!]);
    if (stop("deploy:timelock")) return;
  } else log(`skip   the TimelockController ${d.addr("TimelockController")} is deployed already`);
  const timelock = getAddress(d.addr("TimelockController")!);
  const problems = await timelockProblems(d, delay, chunk);
  if (problems.length > 0) throw new Error(`TimelockController ${timelock}:\n  ${problems.join("\n  ")}`);

  // 2. the grants
  let state = await stateOf(d, timelock);
  if (state.grants.length + state.revokes.length > 0) await assertDeployerAdmin(d);
  for (const item of inOrder(state.grants)) {
    const c = (await d.attach(item.contract))!;
    await d.send(c.grantRole(item.hash, timelock));
    const { txHash, block } = note();
    if (!(await confirmed(d, async () => c.hasRole(item.hash, timelock))))
      throw new Error(`${label(item)}: the grant went through but the timelock does not hold the role`);
    log(`granted ${label(item)} to the timelock ${timelock} (block ${block}, tx ${txHash})`);
    if (stop(`grant:${label(item)}`)) return;
  }

  // 3. the gate: nothing leaves the Safe until the timelock holds all of it and the Safe keeps the rest
  state = await stateOf(d, timelock);
  const gaps = [
    ...state.grants.map((m) => `${label(m)} is not held by the timelock ${timelock}`),
    ...state.missingOps.map((m) => `${label(m)} is not held by the Safe ${safe}`),
  ];
  if (gaps.length > 0)
    throw new Error(
      `Refusing to revoke the Safe's roles, the roles are not where they belong:\n  ${gaps.join("\n  ")}`,
    );

  // 4. the revokes
  for (const item of inOrder(state.revokes)) {
    const c = (await d.attach(item.contract))!;
    await d.send(c.revokeRole(item.hash, safe));
    const { txHash, block } = note();
    if (!(await confirmed(d, async () => !(await c.hasRole(item.hash, safe)))))
      throw new Error(`${label(item)}: the revoke went through but the Safe still holds the role`);
    log(`revoked ${label(item)} from the Safe ${safe} (block ${block}, tx ${txHash})`);
    if (stop(`revoke:${label(item)}`)) return;
  }

  // 5. the record, written once the calls are seen on chain
  handover.governance = "timelock";
  handover.timelock = timelock;
  handover.timelockDelay = delay;
  handover.block = await d.hre.ethers.provider.getBlockNumber();
  d.save();
  // only the roles of the move are judged: the wiring roles of a deployment before its release upgrade differ on purpose
  const left = (await moveRows(d, delay, chunk)).filter((r) => r.status === "DRIFT");
  if (left.length > 0)
    throw new Error(`The check after the move found:\n  ${left.map((r) => `${r.group}: ${r.item}`).join("\n  ")}`);
  const governance = (await governanceItems(d)).length;
  log(
    `Governance moved: ${governance} role(s) are held by the timelock ${timelock} (delay ${delay} s) and no longer by the Safe; ` +
      `the Safe keeps the ${(await operationalItems(d)).length} day-to-day roles. The deployer ${
        d.deployer
      } still holds DEFAULT_ADMIN: ` +
      "`task:deploy:handover --renounce-admin` is the last step.",
  );
}

// --------------------------------------------------------------------------------------------- the dry-run

async function gasOf(d: Deployment, tx: { to?: string; data: string }): Promise<bigint | undefined> {
  try {
    return await d.hre.ethers.provider.estimateGas({ from: d.deployer, ...tx });
  } catch {
    return undefined;
  }
}

/** Prints every transaction the deployer signs, in order, with its gas; sends nothing. */
async function dryRun(d: Deployment, delay: number, opts: MoveOptions): Promise<void> {
  const { log } = d;
  const safe = getAddress(d.params.multisig);
  const handover = handoverOf(d);
  await printSafe(d, safe);
  if (handover.governance === "timelock") {
    log(`The governance roles are at the timelock ${handover.timelock} already.`);
    log("Dry-run done: 0 transaction(s); nothing was sent.");
    return;
  }
  const existing = d.record.contracts.TimelockController?.address;
  let total = 0n;
  let counted = 0;
  let unknown = 0;
  const gas = (g: bigint | undefined) => {
    if (g === undefined) {
      unknown += 1;
      return "gas n/a";
    }
    total += g;
    return `gas ~${g}`;
  };
  const signer = `signer ${d.deployer}`;

  if (existing) {
    log(`skip   the TimelockController ${existing} is deployed already`);
    const problems = await timelockProblems(d, delay, opts.logChunk ?? 5000);
    for (const p of problems) log(`WARNING a real run would refuse: ${p}`);
  } else {
    const { abi, bytecode } = await d.hre.artifacts.readArtifact("TimelockController");
    const data = (await new ContractFactory(abi, bytecode).getDeployTransaction(delay, [safe], [safe], ZeroAddress))
      .data;
    counted += 1;
    log(
      `would deploy TimelockController(${delay} s, proposers [${safe}], executors [${safe}], admin 0), ${signer}, ${gas(
        await gasOf(d, { data }),
      )}`,
    );
  }

  const state = await stateOf(d, existing);
  const grantTo = existing ?? STAND_IN;
  for (const item of inOrder(state.grants)) {
    const c = (await d.attach(item.contract))!;
    counted += 1;
    log(
      `would grant ${label(item)} to the timelock ${existing ?? "<TimelockController>"}, ${signer}, ${gas(
        await gasOf(d, {
          to: c.target as string,
          data: c.interface.encodeFunctionData("grantRole", [item.hash, grantTo]),
        }),
      )}`,
    );
  }
  for (const item of inOrder(state.revokes)) {
    const c = (await d.attach(item.contract))!;
    counted += 1;
    log(
      `would revoke ${label(item)} from the Safe ${safe}, ${signer}, ${gas(
        await gasOf(d, {
          to: c.target as string,
          data: c.interface.encodeFunctionData("revokeRole", [item.hash, safe]),
        }),
      )}`,
    );
  }
  for (const m of state.missingOps) log(`WARNING a real run would refuse: ${label(m)} is not held by the Safe ${safe}`);
  for (const s of await unknownSafeRoles(d))
    log(`keep   ${s} stays with the Safe (a role the hand-over table does not list)`);
  const price = (await d.hre.ethers.provider.getFeeData()).gasPrice;
  log(
    `Dry-run done: ${counted} transaction(s), gas ~${total}${unknown > 0 ? ` (${unknown} without an estimate)` : ""}${
      price ? `, gas price ${formatUnits(price, "gwei")} gwei, ~${formatEther(total * price)} BNB` : ""
    }; nothing was sent.`,
  );
  log(
    "Afterwards the deployer leaves with `task:deploy:handover --renounce-admin` (one renounce per contract, DEFAULT_ADMIN last).",
  );
}

/** Roles of the ABIs the Safe holds that neither column of the hand-over table lists. */
async function unknownSafeRoles(d: Deployment): Promise<string[]> {
  const safe = getAddress(d.params.multisig);
  const out: string[] = [];
  for (const name of ROLE_CONTRACTS) {
    const c = (await d.attach(name)) as Contract | undefined;
    if (!c) continue;
    const known = [...governanceRoles(name).timelock, ...governanceRoles(name).multisig];
    for (const role of roleNames(c.interface))
      if (!known.includes(role) && (await c.hasRole(await roleHashOf(role, c), safe))) out.push(`${name}.${role}`);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- the check

/**
 * The read-only status of the move, one row per fact: DRIFT until the timelock is what it should be, holds every
 * governance role, the Safe holds none of them and every day-to-day one, and the record says so.
 */
export async function moveRows(d: Deployment, delay: number, chunk = 5000): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const row = (ok: boolean, group: string, item: string, want: string, have: string, info = false) =>
    rows.push({ status: ok ? "OK" : info ? "INFO" : "DRIFT", group, item, want, have });
  const recorded = d.record.contracts.TimelockController?.address;
  const timelock = recorded ? getAddress(recorded) : undefined;

  row(!!timelock, "TimelockController", "is deployed and recorded", "recorded", timelock ?? "none");
  if (timelock) {
    const problems = await timelockProblems(d, delay, chunk);
    row(
      problems.length === 0,
      "TimelockController",
      `delay ${delay} s, only the Safe proposes / cancels / executes, no other admin`,
      "none",
      problems.join("; ") || "none",
    );
  }
  const state = await stateOf(d, timelock);
  for (const item of await governanceItems(d)) {
    const atTimelock = !state.grants.some((g) => g.contract === item.contract && g.role === item.role);
    const atSafe = state.revokes.some((g) => g.contract === item.contract && g.role === item.role);
    row(atTimelock, item.contract, `${item.role} held by the timelock`, "true", String(atTimelock));
    row(!atSafe, item.contract, `${item.role} not held by the Safe`, "false", String(atSafe));
  }
  for (const item of await operationalItems(d)) {
    const held = !state.missingOps.some((g) => g.contract === item.contract && g.role === item.role);
    row(held, item.contract, `${item.role} held by the Safe`, "true", String(held));
  }
  for (const s of await unknownSafeRoles(d))
    row(false, "Safe", `${s} stays with the Safe (not in the hand-over table)`, "-", "held", true);

  const h = d.record.handover;
  const noted =
    h?.governance === "timelock" &&
    !!timelock &&
    !!h.timelock &&
    getAddress(h.timelock) === timelock &&
    h.timelockDelay === delay;
  row(
    noted,
    "record",
    "the record names the timelock as holder of the governance roles",
    "governance: timelock",
    noted ? "governance: timelock" : "not recorded",
  );
  let admins = 0;
  for (const name of ROLE_CONTRACTS) {
    const c = await d.attach(name);
    if (c && (await c.hasRole(DEFAULT_ADMIN_ROLE, d.deployer))) admins += 1;
  }
  row(
    admins === 0,
    "deployer",
    `holds DEFAULT_ADMIN on ${admins} of ${ROLE_CONTRACTS.length} contracts (the renounce is the last step)`,
    "0",
    String(admins),
    true,
  );
  return rows;
}

/** After the move: the timelock's delay equals the record (`deploy:check` row; absent before the move). */
export async function governanceRows(d: Deployment): Promise<CheckRow[]> {
  if (!timelockGoverned(d) || d.record.handover?.governance !== "timelock") return [];
  const timelock = await d.attach("TimelockController");
  if (!timelock) return [];
  const have = Number(await timelock.getMinDelay());
  const want = d.record.handover.timelockDelay;
  return [
    {
      status: have === want ? "OK" : "DRIFT",
      group: "TimelockController",
      item: "min delay equals the record",
      want: String(want),
      have: String(have),
    },
  ];
}
