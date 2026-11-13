import { type Signer, getAddress } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import { type CheckResult, matches, printChecks, runChecks } from "./check";
import { Deployment, type Mode } from "./context";
import { paramsDigest, validateParams } from "./params";
import { loadRecord, recordPath } from "./record";
import { type Step, buildSteps, titleOf } from "./steps";
import type { ContractName, DeployParams, DeployRecord } from "./types";
import { verifyContracts } from "./verify";

export interface RunOptions {
  params: DeployParams;
  /** `run` sends, `dry-run` prints every step and sends nothing, `check` reports drift against the chain. */
  mode?: Mode;
  /** The deployer; defaults to the first signer. In dry-run / check an address is enough (no Ledger needed). */
  signer?: Signer;
  deployer?: string;
  /** Directory of `<network>.json` and `abis/`; defaults to deployments/. */
  deploymentsDir?: string;
  persist?: boolean;
  /** Stop after the step with this id (operational partial run; the next run resumes). */
  stopAfter?: string;
  verify?: boolean;
  /** Lets a non-run mode persist the record (the verify task only flips `verified`). */
  writeRecord?: boolean;
  /** The upgrade tasks run from the multisig after the hand-over: the signer need not be the recorded deployer. */
  anySigner?: boolean;
  log?: (message: string) => void;
}

export interface RunResult {
  record: DeployRecord;
  addresses: Record<string, string>;
  /** Steps that were (dry-run / check) or would be sent. */
  pending: string[];
  /** Steps the deployer cannot send; they stay open until someone does them. */
  manual: string[];
  sent: number;
  /** Check mode only. */
  check?: CheckResult;
}

export async function chainIdOf(hre: HardhatRuntimeEnvironment): Promise<number> {
  return Number((await hre.ethers.provider.getNetwork()).chainId);
}

/** The first configured account when it needs no device (a key in the config); a Ledger network has none. */
async function configuredSigner(hre: HardhatRuntimeEnvironment): Promise<string | undefined> {
  try {
    return (await hre.ethers.getSigners())[0]?.address;
  } catch {
    return undefined;
  }
}

/** Opens (or creates) the record for this network and refuses a record of another chain / deployer. */
export async function openDeployment(hre: HardhatRuntimeEnvironment, opts: RunOptions): Promise<Deployment> {
  const mode = opts.mode ?? "run";
  const log = opts.log ?? console.log;
  const signer = mode === "run" ? opts.signer ?? (await hre.ethers.getSigners())[0] : opts.signer;
  const path = opts.persist === false ? undefined : recordPath(hre, opts.deploymentsDir);
  const dir = opts.persist === false ? undefined : opts.deploymentsDir ?? `${hre.config.paths.root}/deployments`;
  const existing = path ? loadRecord(path) : undefined;
  const deployer = signer
    ? await signer.getAddress()
    : opts.deployer ?? existing?.deployer ?? (await configuredSigner(hre));
  if (!deployer) throw new Error("Pass --deployer <address> for a dry-run / check without a signer");
  const chainId = await chainIdOf(hre);
  if (existing) {
    if (existing.chainId !== chainId)
      throw new Error(`${path} is for chain ${existing.chainId}, connected to ${chainId}`);
    if (!opts.anySigner && getAddress(existing.deployer) !== getAddress(deployer))
      throw new Error(`${path} was deployed by ${existing.deployer}, the signer is ${deployer}`);
  } else if (mode === "check") {
    throw new Error(`No deployment record at ${path}; nothing to check`);
  }

  const now = new Date().toISOString();
  const record: DeployRecord = existing ?? {
    schemaVersion: 1,
    network: hre.network.name,
    chainId,
    deployer: getAddress(deployer),
    createdAt: now,
    updatedAt: now,
    paramsDigest: paramsDigest(opts.params),
    complete: false,
    contracts: {},
    config: configOf(opts.params),
    steps: [],
    handover: null,
  };
  if (mode === "run") {
    record.paramsDigest = paramsDigest(opts.params);
    record.config = configOf(opts.params);
  }
  return new Deployment(hre, mode, opts.params, deployer, signer, record, path, dir, log, opts.writeRecord);
}

function configOf(p: DeployParams): DeployRecord["config"] {
  return { multisig: p.multisig, guardian: p.guardian, timelockDelay: p.timelockDelay };
}

/** Errors always refuse; placeholders refuse a real run and only warn in a dry-run / check. */
export function assertParams(d: Deployment): void {
  const { errors, placeholders } = validateParams(d.params, d.record.chainId);
  if (errors.length > 0) throw new Error(`Invalid params:\n  ${errors.join("\n  ")}`);
  if (placeholders.length > 0) {
    const text = `Params still hold placeholders (TODO(operator)): ${placeholders.join(", ")}`;
    if (d.mode === "run") throw new Error(text);
    d.log(`WARNING ${text}`);
  }
}

/** Is the step satisfied on chain (or recorded, for initial-state steps)? */
export async function isDone(d: Deployment, step: Step): Promise<boolean> {
  if (step.soft && d.recorded(step.id)) return true;
  return matches(step, await step.read());
}

/** After a transaction a load-balanced public RPC may still answer from the previous block: poll a little. */
async function confirmed(d: Deployment, step: Step): Promise<boolean> {
  for (let i = 0; i < (d.local ? 1 : 10); i++) {
    if (matches(step, await step.read())) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

export async function runDeploy(hre: HardhatRuntimeEnvironment, opts: RunOptions): Promise<RunResult> {
  const d = await openDeployment(hre, opts);
  const { log } = d;
  assertParams(d);
  if (d.mode === "run" && d.record.handover?.completed)
    throw new Error("The hand-over is complete: the deployer no longer governs the system; use the check task");
  if (d.mode === "check") return runCheck(d);

  const steps = buildSteps(d);
  if (opts.stopAfter !== undefined && !steps.some((s) => s.id === opts.stopAfter))
    throw new Error(`Unknown step "${opts.stopAfter}"; steps:\n  ${steps.map((s) => s.id).join("\n  ")}`);

  log(`${d.mode === "run" ? "Deploying" : "Dry-run of"} Vexaro on ${hre.network.name} (chain ${d.record.chainId})`);
  log(`  deployer ${d.deployer}`);

  const pending: string[] = [];
  const manual: string[] = [];
  let stopped = false;
  for (const [i, step] of steps.entries()) {
    const tag = `[${String(i + 1).padStart(3)}/${steps.length}]`;
    await runStep(d, step, tag, pending, manual);
    if (opts.stopAfter === step.id) {
      log(`Stopped after ${step.id} (--stop-after); run again to resume.`);
      stopped = true;
      break;
    }
  }

  if (d.mode === "run") {
    d.record.complete = !stopped && pending.length === 0 && manual.length === 0;
    d.save();
  }
  if (d.mode === "run" && opts.verify) await verifyContracts(d);

  if (!stopped) for (const line of manual) log(`MANUAL: ${line}`);
  if (d.mode === "dry-run") log(`Dry-run done: ${pending.length} step(s) would send transactions; nothing was sent.`);
  return result(d, pending, manual);
}

/** Read-only comparison of every wired value and role with the params; prints the table. */
export async function runCheck(d: Deployment, opts: Parameters<typeof runChecks>[1] = {}): Promise<RunResult> {
  assertParams(d);
  const check = await runChecks(d, opts);
  printChecks(d, check);
  const pending = check.rows.filter((r) => r.status === "DRIFT").map((r) => r.item);
  return { ...result(d, pending, []), check };
}

function result(d: Deployment, pending: string[], manual: string[]): RunResult {
  const addresses: Record<string, string> = {};
  for (const [name, c] of Object.entries(d.record.contracts)) addresses[name as ContractName] = c.address;
  return { record: d.record, addresses, pending, manual, sent: d.sent };
}

async function runStep(d: Deployment, step: Step, tag: string, pending: string[], manual: string[]): Promise<void> {
  if (await isDone(d, step)) {
    d.log(`${tag} skip   ${titleOf(d, step)} (already on chain)`);
    if (d.mode === "run") {
      d.markStep({ id: step.id, status: "already-on-chain", txHashes: [], at: new Date().toISOString() });
      d.save();
    }
    return;
  }
  const reason = await step.manual?.();
  if (reason) {
    manual.push(reason);
    d.log(`${tag} manual ${titleOf(d, step)}`);
    return;
  }
  if (d.mode !== "run") {
    pending.push(step.id);
    d.log(`${tag} would  ${titleOf(d, step)}`);
    return;
  }

  await step.apply();
  if (!(await confirmed(d, step)))
    throw new Error(`${step.id}: the transaction went through but the state does not match`);
  const { txHashes, block } = d.takeTxs();
  d.markStep({ id: step.id, status: "done", txHashes, block, at: new Date().toISOString() });
  d.save();
  d.log(`${tag} done   ${titleOf(d, step)} (block ${block ?? "-"}, ${txHashes.length} tx)`);
}
