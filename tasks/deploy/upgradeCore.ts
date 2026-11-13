import {
  type Contract,
  type ContractFactory,
  type ContractTransactionResponse,
  FunctionFragment,
  type ParamType,
  Wallet,
  ZeroHash,
  getAddress,
  id,
} from "ethers";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { ARTIFACT, type Deployment } from "./context";
import type { ContractName, SafeBatch, SafeTimelockOperation, UpgradeRecord } from "./types";

/** The proxies the first upgrade of the live system replaced, in the order they were upgraded. */
export const CORE_CONTRACTS = ["Treasury", "Network", "TokenSale", "Rewards", "Jump"] as const;
export type CoreContract = (typeof CORE_CONTRACTS)[number];
/** Ids of the upgrades in `record.upgrades`, as stored in deployments/<network>.json. */
export const CORE_UPGRADE_ID = "oc13";
export const NETWORK_UPGRADE_ID = "oc16";
export const STAKING_UPGRADE_ID = "oc15";
export const LARGEST_STAKE_UPGRADE_ID = "oc19";
export const RELEASE_UPGRADE_ID = "release-2026-10-31";
export const TOKEN_SALE_UPGRADE_ID = "tokensale-daily-sale";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface UpgradeOptions {
  /** Stop after this step id (the next run resumes). */
  stopAfter?: string;
  /** Timelock path: keep polling until the operation is ready and execute it (otherwise the run ends after scheduling). */
  wait?: boolean;
}

/** One transaction of the upgrade, as a direct call or as an operation of the timelock batch. */
export interface Call {
  id: string;
  title: string;
  contract: ContractName;
  data: string;
  /** Satisfied on chain? */
  done(): Promise<boolean>;
}

// --------------------------------------------------------------------------------------------- helpers

export const attachable = (d: Deployment, name: ContractName) => d.attach(name) as Promise<Contract>;

export async function implementationOf(d: Deployment, name: ContractName): Promise<string> {
  return getAddress(await d.hre.upgrades.erc1967.getImplementationAddress(d.addr(name)!));
}

/**
 * True when `address` holds the runtime code the compiler produced for `name`. UUPSUpgradeable keeps the
 * implementation's own address in an immutable (`__self`): it is blanked before the comparison.
 */
export async function isBuildOf(d: Deployment, name: ContractName, address: string): Promise<boolean> {
  const { deployedBytecode, deployedLinkReferences } = await d.hre.artifacts.readArtifact(ARTIFACT[name]);
  const code = (await d.hre.ethers.provider.getCode(address)).toLowerCase();
  const self = "0".repeat(24) + address.toLowerCase().slice(2);
  let want: string;
  try {
    want = linkedRuntime(d, name, deployedBytecode, deployedLinkReferences);
  } catch {
    return false; // no library address to link yet: the deployed code cannot be this build
  }
  return code.split(self).join("0".repeat(64)) === want;
}

/**
 * The libraries `name` is linked to: only the Network links one, NetworkFreeze. The address is the one a running task
 * has just deployed (`pendingLibraries`) or else the one in the record.
 */
export function librariesOf(d: Deployment, name: ContractName): Record<string, string> | undefined {
  if (name !== "Network") return undefined;
  const library = d.pendingLibraries.NetworkFreeze ?? d.addr("NetworkFreeze");
  if (!library) throw new Error("NetworkFreeze is missing from the record: the Network links it");
  return { NetworkFreeze: library };
}

/** `unsafeAllow` of the upgrade checks: the library of the Network is linked on purpose. */
export const unsafeAllowOf = (name: ContractName) => (name === "Network" ? ["external-library-linking" as const] : []);

/** The runtime code the compiler produced for `name` with the library addresses of the record written in. */
function linkedRuntime(
  d: Deployment,
  name: ContractName,
  runtime: string,
  references: Record<string, Record<string, { start: number; length: number }[]>>,
): string {
  let code = runtime.toLowerCase();
  const libraries = librariesOf(d, name) ?? {};
  for (const byFile of Object.values(references)) {
    for (const [library, spots] of Object.entries(byFile)) {
      const address = libraries[library];
      if (!address) throw new Error(`${name}: no address for the library ${library}`);
      for (const { start, length } of spots) {
        code = code.slice(0, 2 + start * 2) + address.slice(2).toLowerCase() + code.slice(2 + (start + length) * 2);
      }
    }
  }
  return code;
}

/** The upgrade record of this run (created on the first run). */
export function recordOf(d: Deployment, id = CORE_UPGRADE_ID): UpgradeRecord {
  d.record.upgrades ??= [];
  let u = d.record.upgrades.find((x) => x.id === id);
  if (!u) {
    u = { id, startedAt: new Date().toISOString(), implementations: {}, txHashes: [] };
    d.record.upgrades.push(u);
  }
  return u;
}

/** A signer-less factory for read-only validation (a dry-run without a Ledger). */
export async function factoryOf(d: Deployment, name: ContractName): Promise<ContractFactory> {
  const signer = d.signer ?? Wallet.createRandom().connect(d.hre.ethers.provider);
  return d.hre.ethers.getContractFactory(ARTIFACT[name], { signer, libraries: librariesOf(d, name) });
}

/** OpenZeppelin's storage-layout check of `name` against the implementation the proxy runs now. */
export async function validate(d: Deployment, name: ContractName): Promise<void> {
  await d.hre.upgrades.validateUpgrade(d.addr(name)!, await factoryOf(d, name), {
    kind: "uups",
    unsafeAllow: [...unsafeAllowOf(name)],
  });
}

// --------------------------------------------------------------------------------------------- who sends what

export interface Route {
  /**
   * `direct`: the sender holds the roles. `timelock`: a timelock holds them and the sender proposes. `safe`: the Safe
   * holds them. `safe-timelock`: a timelock holds them and the Safe proposes (a schedule file and an execute file).
   */
  via: "direct" | "timelock" | "safe" | "safe-timelock";
  problems: string[];
}

/** The routes whose calls wait for the timelock delay. */
export const isTimelockRoute = (route: Route): boolean => route.via === "timelock" || route.via === "safe-timelock";

const PROPOSER_ROLE = id("PROPOSER_ROLE");
const EXECUTOR_ROLE = id("EXECUTOR_ROLE");

/** Roles (hashes) an account must hold on a contract for a route to work. */
export type RoleNeeds = [ContractName, string[]][];

export async function holdsAll(d: Deployment, who: string, needs: RoleNeeds): Promise<boolean> {
  for (const [name, roles] of needs) {
    const c = await attachable(d, name);
    for (const role of roles) if (!(await c.hasRole(role, who))) return false;
  }
  return true;
}

/**
 * The Safe paths: neither the sender nor a timelock the sender can use holds the roles. Either the Safe
 * (params.multisig) holds them: the calls are written to a Safe Transaction Builder file for the owners to sign
 * (`safe`). Or a timelock holds them, the sender is not its proposer and the Safe is: the calls are written as two
 * files, scheduleBatch and, after the delay, executeBatch (`safe-timelock`). Undefined when another route works.
 */
export async function safeRoute(d: Deployment, needs: RoleNeeds): Promise<Route | undefined> {
  const timelock = d.record.contracts.TimelockController?.address;
  const safe = getAddress(d.params.multisig);
  if (timelock && (await holdsAll(d, timelock, needs))) {
    const governor = (await d.attach("TimelockController"))!;
    const runs = async (who: string) =>
      (await governor.hasRole(PROPOSER_ROLE, who)) && (await governor.hasRole(EXECUTOR_ROLE, who));
    const sender = d.signer ? await d.signer.getAddress() : d.deployer;
    if (await runs(sender)) return undefined;
    return (await runs(safe)) ? { via: "safe-timelock", problems: [] } : undefined;
  }
  return (await holdsAll(d, safe, needs)) ? { via: "safe", problems: [] } : undefined;
}

export async function timelockDelay(d: Deployment): Promise<number> {
  const timelock = await d.attach("TimelockController");
  return timelock ? Number(await timelock.getMinDelay()) : 0;
}

/** Sends the pending calls the way the route says; false when the run has to stop here (see the log). */
export async function runVia(
  d: Deployment,
  up: UpgradeRecord,
  route: Route,
  pending: Call[],
  opts: UpgradeOptions,
): Promise<boolean> {
  if (route.via === "direct") return runDirect(d, up, pending, opts);
  if (route.via === "safe") return runSafe(d, up, pending);
  if (route.via === "safe-timelock") return runSafeTimelock(d, up, pending);
  return runTimelock(d, up, pending, opts);
}

// --------------------------------------------------------------------------------------------- the Safe path

interface SafeInput {
  internalType: string;
  name: string;
  type: string;
  components?: SafeInput[];
}

export interface SafeTransaction {
  to: string;
  value: "0";
  data: null;
  contractMethod: { inputs: SafeInput[]; name: string; payable: false };
  contractInputsValues: Record<string, string>;
}

/** The file the Safe's Transaction Builder imports ("Upload a batch"); the same format as the backend's proposals. */
export interface SafeBatchFile {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: "1.17.0";
    createdFromSafeAddress: string;
    createdFromOwnerAddress: "";
  };
  transactions: SafeTransaction[];
}

/** A value as the Transaction Builder reads it: scalars as text, arrays and tuples as a JSON array of such texts. */
function safeValue(value: unknown, type: ParamType): unknown {
  if (type.baseType === "array") return (value as unknown[]).map((v) => safeValue(v, type.arrayChildren!));
  if (type.baseType === "tuple") return type.components!.map((c, i) => safeValue((value as unknown[])[i], c));
  return type.baseType === "address" ? getAddress(String(value)) : String(value);
}

/** One Transaction Builder transaction for a call: the method from the contract's ABI, the arguments decoded from the calldata. */
export async function safeTransaction(d: Deployment, call: Call): Promise<SafeTransaction> {
  const c = (await d.attach(call.contract))!;
  const parsed = c.interface.parseTransaction({ data: call.data });
  if (!parsed) throw new Error(`${call.id}: the calldata is not a call of ${call.contract}`);
  const { abi } = await d.hre.artifacts.readArtifact(ARTIFACT[call.contract]);
  const entry = (abi as { type: string; name: string; inputs: SafeInput[] }[]).find(
    (e) => e.type === "function" && e.name === parsed.name && FunctionFragment.from(e).selector === parsed.selector,
  );
  if (!entry) throw new Error(`${call.id}: ${call.contract} has no ABI entry for ${parsed.signature}`);
  const values: Record<string, string> = {};
  parsed.fragment.inputs.forEach((input, i) => {
    const rendered = safeValue(parsed.args[i], input);
    values[input.name] = Array.isArray(rendered) ? JSON.stringify(rendered) : (rendered as string);
  });
  return {
    to: getAddress(d.addr(call.contract)!),
    value: "0",
    data: null,
    contractMethod: { inputs: entry.inputs, name: parsed.name, payable: false },
    contractInputsValues: values,
  };
}

export async function safeBatchFile(
  d: Deployment,
  calls: Call[],
  meta: { name: string; description: string; createdAt: number },
): Promise<SafeBatchFile> {
  return {
    version: "1.0",
    chainId: String(d.record.chainId),
    createdAt: meta.createdAt,
    meta: {
      name: meta.name,
      description: meta.description,
      txBuilderVersion: "1.17.0",
      createdFromSafeAddress: getAddress(d.params.multisig),
      createdFromOwnerAddress: "",
    },
    transactions: await Promise.all(calls.map((c) => safeTransaction(d, c))),
  };
}

/**
 * The Safe path: writes the pending calls as one Transaction Builder batch to `<deployments>/safe/<network>-<id>.json`
 * and stops (false). The owners import and sign it; running the task again (or its `--check`) after the Safe executed
 * it verifies the calls and completes the record. The same calls give the same file (createdAt is kept).
 */
export async function runSafe(d: Deployment, up: UpgradeRecord, pending: Call[]): Promise<boolean> {
  up.safe = await writeSafeBatch(d, {
    fileId: up.id,
    title: `Vexaro ${up.id} upgrade (${d.hre.network.name})`,
    calls: pending,
    previous: up.safe,
  });
  d.save();
  return false;
}

/**
 * Writes `calls` as one Transaction Builder batch to `<deployments>/safe/<network>-<fileId>.json` and returns the
 * record entry. The same calls give the same file (`createdAt` of the `previous` entry is kept).
 */
export async function writeSafeBatch(
  d: Deployment,
  opts: { fileId: string; title: string; calls: Call[]; previous?: SafeBatch },
): Promise<SafeBatch> {
  const { calls, previous } = opts;
  const safe = getAddress(d.params.multisig);
  const ids = calls.map((c) => c.id);
  const file = join("safe", `${d.hre.network.name}-${opts.fileId}.json`);
  const same = previous && previous.safe === safe && previous.file === file && previous.calls.join() === ids.join();
  const createdAt = same ? previous.createdAt : new Date().toISOString();
  const batch = await safeBatchFile(d, calls, {
    name: opts.title,
    description: calls.map((c) => c.title).join("; "),
    createdAt: Date.parse(createdAt),
  });
  if (d.dir) {
    mkdirSync(join(d.dir, "safe"), { recursive: true });
    writeFileSync(join(d.dir, file), JSON.stringify(batch, null, 2) + "\n");
  }
  d.log(
    `wrote the Safe batch (${calls.length} transaction(s)) to ${
      d.dir ? join(d.dir, file) : file
    }: import it in the Safe ${safe} ` +
      "(Apps > Transaction Builder > Upload a batch), collect the signatures and execute; then run this task again, or its --check, to verify.",
  );
  return { file, safe, createdAt, calls: ids };
}

/** Direct transactions of the sender, one after the other; each is read back before the next. */
export async function runDirect(
  d: Deployment,
  up: UpgradeRecord,
  pending: Call[],
  opts: UpgradeOptions,
): Promise<boolean> {
  for (const [i, call] of pending.entries()) {
    const c = (await d.attach(call.contract))!;
    await d.send(
      d.signer!.sendTransaction({
        to: c.target as string,
        data: call.data,
      }) as unknown as Promise<ContractTransactionResponse>,
    );
    const { txHashes, block } = d.takeTxs();
    up.txHashes.push(...txHashes);
    up.block = block;
    for (let tries = 0; !(await call.done()) && tries < (d.local ? 1 : 10); tries++) await sleep(2000);
    if (!(await call.done())) throw new Error(`${call.id}: the transaction went through but the state does not match`);
    d.save();
    d.log(`[${i + 1}/${pending.length}] done   ${call.title} (block ${block ?? "-"})`);
    if (opts.stopAfter === call.id) {
      d.log("Stopped (--stop-after); run again to resume.");
      return false;
    }
  }
  return true;
}

/**
 * The same calls as one timelock batch. First run: schedule it (the data is fixed in the record). Later runs: wait,
 * then execute once the delay has passed. Returns true when the batch has been executed.
 */
export async function runTimelock(
  d: Deployment,
  up: UpgradeRecord,
  pending: Call[],
  opts: UpgradeOptions,
): Promise<boolean> {
  const timelock = (await d.attach("TimelockController"))!;
  const targets = pending.map((c) => d.addr(c.contract)!);
  const values = pending.map(() => 0n);
  const payloads = pending.map((c) => c.data);
  let op = up.timelock;

  if (!op) {
    const salt = id(`vexaro-${up.id}-${up.startedAt}`);
    const operationId: string = await timelock.hashOperationBatch(targets, values, payloads, ZeroHash, salt);
    const delay = Number(await timelock.getMinDelay());
    if (!(await timelock.isOperation(operationId))) {
      await d.send(timelock.scheduleBatch(targets, values, payloads, ZeroHash, salt, delay));
      const { txHashes } = d.takeTxs();
      up.txHashes.push(...txHashes);
      op = {
        operationId,
        salt,
        scheduledAt: new Date().toISOString(),
        scheduleTxHash: txHashes[0],
        readyAt: Number(await timelock.getTimestamp(operationId)),
      };
      up.timelock = op;
      d.save();
      d.log(
        `scheduled the batch ${operationId} (${pending.length} calls), ready at ${new Date(
          op.readyAt * 1000,
        ).toISOString()}`,
      );
    } else {
      op = {
        operationId,
        salt,
        scheduledAt: new Date().toISOString(),
        scheduleTxHash: "",
        readyAt: Number(await timelock.getTimestamp(operationId)),
      };
      up.timelock = op;
      d.save();
      d.log(`the batch ${operationId} was scheduled before (ready at ${new Date(op.readyAt * 1000).toISOString()})`);
    }
  }
  if (opts.stopAfter === "schedule") {
    d.log("Stopped after scheduling; run again after the delay.");
    return false;
  }

  // the batch is executed exactly as it was scheduled: the data built now must hash to the recorded operation
  const rebuilt: string = await timelock.hashOperationBatch(targets, values, payloads, ZeroHash, op.salt);
  if (rebuilt !== op.operationId)
    throw new Error(
      `The calls built now (${rebuilt}) differ from the scheduled batch (${op.operationId}): the params or the implementations changed since; cancel the operation on the timelock and start again`,
    );
  const operationId = op.operationId;
  const provider = d.hre.ethers.provider;
  for (;;) {
    if (await timelock.isOperationDone(operationId)) return true;
    if (await timelock.isOperationReady(operationId)) break;
    const eta = Number(await timelock.getTimestamp(operationId));
    const now = (await provider.getBlock("latest"))!.timestamp;
    if (!opts.wait || d.local) {
      d.log(
        `the batch is not ready yet: ${Math.max(0, eta - now)} s to go (ready at ${new Date(
          eta * 1000,
        ).toISOString()}); run again, or pass --wait`,
      );
      return false;
    }
    d.log(`waiting ${Math.max(0, eta - now)} s for the timelock delay ...`);
    await sleep(Math.min(30_000, Math.max(5_000, (eta - now) * 1000)));
  }
  await d.send(timelock.executeBatch(targets, values, payloads, ZeroHash, op.salt));
  const { txHashes, block } = d.takeTxs();
  up.txHashes.push(...txHashes);
  up.block = block;
  op.executedAt = new Date().toISOString();
  op.executeTxHash = txHashes[0];
  d.save();
  d.log(`executed the batch (${pending.length} calls) in block ${block ?? "-"}`);
  return true;
}

// --------------------------------------------------------------------------------------------- the Safe proposes to the timelock

export type OperationState = "unscheduled" | "pending" | "ready" | "done";

/** What the timelock says about an operation: its state and the Unix second it becomes ready (0 while unscheduled). */
export async function operationState(
  d: Deployment,
  operationId: string,
): Promise<{ state: OperationState; readyAt: number }> {
  const timelock = (await d.attach("TimelockController"))!;
  const readyAt = Number(await timelock.getTimestamp(operationId));
  if (await timelock.isOperationDone(operationId)) return { state: "done", readyAt };
  if (await timelock.isOperationReady(operationId)) return { state: "ready", readyAt };
  if (await timelock.isOperation(operationId)) return { state: "pending", readyAt };
  return { state: "unscheduled", readyAt: 0 };
}

/** The arguments of `scheduleBatch` / `executeBatch` / `hashOperationBatch` for a list of calls (no predecessor). */
export function timelockBatch(d: Deployment, calls: Call[], salt: string) {
  return {
    targets: calls.map((c) => d.addr(c.contract)!),
    values: calls.map(() => 0n),
    payloads: calls.map((c) => c.data),
    predecessor: ZeroHash,
    salt,
  };
}

export async function operationIdOf(d: Deployment, calls: Call[], salt: string): Promise<string> {
  const timelock = (await d.attach("TimelockController"))!;
  const b = timelockBatch(d, calls, salt);
  return (await timelock.hashOperationBatch(b.targets, b.values, b.payloads, b.predecessor, b.salt)) as string;
}

/** A call of the timelock itself, for a Safe batch file. */
async function timelockCall(
  d: Deployment,
  callId: string,
  title: string,
  method: string,
  args: unknown[],
  done: () => Promise<boolean>,
): Promise<Call> {
  const timelock = (await d.attach("TimelockController"))!;
  return {
    id: callId,
    title,
    contract: "TimelockController",
    data: timelock.interface.encodeFunctionData(method, args),
    done,
  };
}

/**
 * Writes the two Transaction Builder files that carry `calls` through the timelock: `<network>-<fileId>-schedule.json`
 * (scheduleBatch, first) and `<network>-<fileId>-execute.json` (executeBatch, once the delay has passed; the same salt
 * and no predecessor). The same calls give the same files.
 */
export async function writeSafeTimelockFiles(
  d: Deployment,
  opts: { fileId: string; title: string; calls: Call[]; salt: string; previous?: SafeTimelockOperation },
): Promise<SafeTimelockOperation> {
  const { calls, salt, previous } = opts;
  const timelock = (await d.attach("TimelockController"))!;
  const delay = Number(await timelock.getMinDelay());
  const b = timelockBatch(d, calls, salt);
  const operationId = await operationIdOf(d, calls, salt);
  const inner = calls.map((c) => c.title).join("; ");
  const schedule = await timelockCall(
    d,
    `schedule:${operationId}`,
    `schedule in the timelock (delay ${delay} s): ${inner}`,
    "scheduleBatch",
    [b.targets, b.values, b.payloads, b.predecessor, b.salt, delay],
    async () => (await operationState(d, operationId)).state !== "unscheduled",
  );
  const execute = await timelockCall(
    d,
    `execute:${operationId}`,
    `execute from the timelock: ${inner}`,
    "executeBatch",
    [b.targets, b.values, b.payloads, b.predecessor, b.salt],
    async () => (await operationState(d, operationId)).state === "done",
  );
  return {
    operationId,
    salt,
    delay,
    schedule: await writeSafeBatch(d, {
      fileId: `${opts.fileId}-schedule`,
      title: `${opts.title}: schedule`,
      calls: [schedule],
      previous: previous?.schedule,
    }),
    execute: await writeSafeBatch(d, {
      fileId: `${opts.fileId}-execute`,
      title: `${opts.title}: execute`,
      calls: [execute],
      previous: previous?.execute,
    }),
  };
}

/** One line on where the operation stands and which file the owners import next. */
export async function operationLine(d: Deployment, op: SafeTimelockOperation): Promise<string> {
  const { state, readyAt } = await operationState(d, op.operationId);
  const now = (await d.hre.ethers.provider.getBlock("latest"))!.timestamp;
  const at = new Date(readyAt * 1000).toISOString();
  if (state === "unscheduled")
    return `operation ${op.operationId}: not scheduled; the Safe imports ${op.schedule.file} first, then ${op.execute.file} after ${op.delay} s`;
  if (state === "pending")
    return `operation ${op.operationId}: pending, ready at ${at} (${Math.max(
      0,
      readyAt - now,
    )} s to go); then the Safe imports ${op.execute.file}`;
  if (state === "ready")
    return `operation ${op.operationId}: ready (since ${at}); the Safe imports ${op.execute.file} now`;
  return `operation ${op.operationId}: done`;
}

/**
 * The Safe-proposes route: a timelock holds the roles and the Safe is its proposer / executor. Writes the schedule and
 * the execute file of the pending calls and stops (false); the owners schedule, wait for the delay and execute, then
 * running the task again (or its --check) verifies the calls and completes the record.
 */
export async function runSafeTimelock(d: Deployment, up: UpgradeRecord, pending: Call[]): Promise<boolean> {
  const known = up.safeTimelock;
  const salt = known?.salt ?? id(`vexaro-${up.id}-${up.startedAt}`);
  const operationId = await operationIdOf(d, pending, salt);
  if (known && known.operationId !== operationId) {
    const old = await operationState(d, known.operationId);
    if (old.state === "pending" || old.state === "ready")
      throw new Error(
        `The calls built now (${operationId}) differ from the batch the Safe scheduled (${known.operationId}): cancel that operation on the timelock and start again`,
      );
  }
  up.safeTimelock = await writeSafeTimelockFiles(d, {
    fileId: up.id,
    title: `Vexaro ${up.id} upgrade (${d.hre.network.name})`,
    calls: pending,
    salt,
    previous: known?.operationId === operationId ? known : undefined,
  });
  d.save();
  d.log(await operationLine(d, up.safeTimelock));
  return false;
}

/** `--check` of a task that can run this route: where the recorded operation of the upgrade `upgradeId` stands. */
export async function logOperation(d: Deployment, upgradeId: string): Promise<void> {
  const op = d.record.upgrades?.find((u) => u.id === upgradeId)?.safeTimelock;
  if (op) d.log(await operationLine(d, op));
}

// --------------------------------------------------------------------------------------------- the check

export interface CoreRow {
  status: "OK" | "DRIFT";
  group: string;
  item: string;
  want: string;
  have: string;
}

/**
 * The upgrade part of `task:deploy:check`: every upgraded proxy runs the code the compiler produces now and the
 * record names that implementation.
 */
export async function coreCheckRows(d: Deployment): Promise<CoreRow[]> {
  const rows: CoreRow[] = [];
  for (const name of CORE_CONTRACTS) {
    if (!d.addr(name)) continue;
    const current = await implementationOf(d, name);
    const build = await isBuildOf(d, name, current);
    rows.push({
      status: build ? "OK" : "DRIFT",
      group: name,
      item: `${name} implementation is the compiled build`,
      want: "compiled build",
      have: build ? `compiled build ${current}` : `other build ${current}`,
    });
    const recorded = d.record.contracts[name]?.implementation;
    const same = recorded !== undefined && getAddress(recorded) === current;
    rows.push({
      status: same ? "OK" : "DRIFT",
      group: name,
      item: `${name} implementation equals the record`,
      want: recorded ?? "recorded",
      have: current,
    });
  }
  return rows;
}
