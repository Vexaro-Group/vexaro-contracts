import { getAddress, id } from "ethers";

import type { Deployment } from "./context";
import { type ContractName, ROLE_CONTRACTS, type SafeTimelockOperation } from "./types";
import {
  type Call,
  type OperationState,
  operationIdOf,
  operationState,
  writeSafeBatch,
  writeSafeTimelockFiles,
} from "./upgradeCore";

/** One admin call as the owners write it: a contract of the record, a function of its ABI and the arguments. */
export interface AdminCallSpec {
  contract: string;
  /** A function name or a full signature (`setFee(uint256)`) when the name is overloaded. */
  function: string;
  /** Scalars as text or numbers, arrays and tuples as JSON arrays; amounts as decimal strings. */
  args?: unknown[];
}

export interface AdminCallOptions {
  /** Names the files and, with the calls, the operation: `<network>-admin-<id>-schedule.json` / `-execute.json`. */
  id: string;
  calls: AdminCallSpec[];
  /** Overrides the salt, which defaults to the hash of the id (a second operation of the same calls needs another one). */
  salt?: string;
  /** Read-only: where the operation stands; writes nothing. */
  check?: boolean;
  /** Writes the file that cancels a scheduled operation instead of the pair that schedules it. */
  cancel?: boolean;
}

export interface AdminCallResult {
  operationId: string;
  state: OperationState;
  /** Unix second the operation becomes ready (0 while it is not scheduled). */
  readyAt: number;
  operation?: SafeTimelockOperation;
  /** The cancel file, with `cancel`. */
  cancelFile?: string;
}

/** The contracts an admin call can target: the ten with roles and the timelock itself. */
const GOVERNED: ContractName[] = [...ROLE_CONTRACTS, "TimelockController"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROPOSER_ROLE = id("PROPOSER_ROLE");
const CANCELLER_ROLE = id("CANCELLER_ROLE");
const EXECUTOR_ROLE = id("EXECUTOR_ROLE");

/** The calls as encoded calldata on the recorded contracts; an unknown contract or function, or bad arguments, refuse. */
export async function buildAdminCalls(d: Deployment, specs: AdminCallSpec[]): Promise<Call[]> {
  if (specs.length === 0) throw new Error("No calls given");
  const calls: Call[] = [];
  for (const [i, spec] of specs.entries()) {
    const name = spec.contract as ContractName;
    const contract = GOVERNED.includes(name) ? await d.attach(name) : undefined;
    if (!contract) throw new Error(`call ${i + 1}: "${spec.contract}" is not one of ${GOVERNED.join(", ")}`);
    const fragment = contract.interface.getFunction(spec.function);
    if (!fragment) throw new Error(`call ${i + 1}: ${spec.contract} has no function ${spec.function}`);
    if (fragment.stateMutability === "view" || fragment.stateMutability === "pure")
      throw new Error(`call ${i + 1}: ${fragment.format("sighash")} only reads`);
    const args = spec.args ?? [];
    let data: string;
    try {
      data = contract.interface.encodeFunctionData(fragment, args);
    } catch (error) {
      throw new Error(
        `call ${i + 1}: ${fragment.format("sighash")} does not take these arguments: ${(error as Error).message}`,
      );
    }
    calls.push({
      id: `${spec.contract}.${fragment.name}#${i + 1}`,
      title: `${spec.contract}.${fragment.format("sighash")} ${JSON.stringify(args)}`,
      contract: name,
      data,
      done: async () => false,
    });
  }
  return calls;
}

/**
 * Wraps admin calls into the Safe files that run them through the timelock: scheduleBatch first, executeBatch once the
 * delay has passed, or `cancel` to withdraw a scheduled operation. Sends nothing; the Safe's owners sign the files.
 */
export async function runAdminCalls(d: Deployment, opts: AdminCallOptions): Promise<AdminCallResult> {
  if (!ID_PATTERN.test(opts.id)) throw new Error(`--id "${opts.id}": letters, digits, dot, dash and underscore only`);
  if (!d.addr("TimelockController")) throw new Error("There is no TimelockController in the record");
  const timelock = (await d.attach("TimelockController"))!;
  const safe = getAddress(d.params.multisig);
  const needed: [string, string][] = [
    ["PROPOSER_ROLE", PROPOSER_ROLE],
    ["EXECUTOR_ROLE", EXECUTOR_ROLE],
    ...(opts.cancel ? ([["CANCELLER_ROLE", CANCELLER_ROLE]] as [string, string][]) : []),
  ];
  for (const [name, role] of needed)
    if (!(await timelock.hasRole(role, safe)))
      throw new Error(`The Safe ${safe} lacks ${name} on the timelock ${d.addr("TimelockController")}`);

  const calls = await buildAdminCalls(d, opts.calls);
  const salt = opts.salt ?? id(`vexaro-admin-${opts.id}`);
  const operationId = await operationIdOf(d, calls, salt);
  const { state, readyAt } = await operationState(d, operationId);
  const delay = Number(await timelock.getMinDelay());
  d.log(`operation ${operationId} (${calls.length} call(s), salt ${salt}): ${state}`);
  for (const c of calls) d.log(`  ${c.title}`);

  if (opts.check) {
    if (state === "pending" || state === "ready")
      d.log(`  ready at ${new Date(readyAt * 1000).toISOString()}${state === "ready" ? " (now)" : ""}`);
    return { operationId, state, readyAt };
  }

  if (opts.cancel) {
    if (state !== "pending" && state !== "ready") throw new Error(`Nothing to cancel: the operation is ${state}`);
    const cancel: Call = {
      id: `cancel:${operationId}`,
      title: `cancel the timelock operation ${operationId}`,
      contract: "TimelockController",
      data: timelock.interface.encodeFunctionData("cancel", [operationId]),
      done: async () => (await operationState(d, operationId)).state === "unscheduled",
    };
    const file = await writeSafeBatch(d, {
      fileId: `admin-${opts.id}-cancel`,
      title: `Vexaro admin ${opts.id} (${d.hre.network.name}): cancel`,
      calls: [cancel],
    });
    return { operationId, state, readyAt, cancelFile: file.file };
  }

  if (state === "done")
    throw new Error(`The operation ${operationId} was executed already: use another --id (or --salt) for a new one`);
  const operation = await writeSafeTimelockFiles(d, {
    fileId: `admin-${opts.id}`,
    title: `Vexaro admin ${opts.id} (${d.hre.network.name})`,
    calls,
    salt,
  });
  d.log(
    state === "unscheduled"
      ? `The Safe imports ${operation.schedule.file} first; ${delay} s after it was executed it imports ${operation.execute.file}. To withdraw it before: run this task with --cancel.`
      : `Already scheduled (ready at ${new Date(readyAt * 1000).toISOString()}): the Safe imports ${
          operation.execute.file
        } once it is ready.`,
  );
  return { operationId, state, readyAt, operation };
}
