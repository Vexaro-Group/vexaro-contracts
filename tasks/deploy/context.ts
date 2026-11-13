import { Contract, type ContractTransactionResponse, type Signer, id } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import { isLocalChain } from "./params";
import { saveRecord } from "./record";
import type { ContractName, DeployParams, DeployRecord, StepRecord } from "./types";

export const ARTIFACT: Record<ContractName, string> = {
  Vexaro: "Vexaro",
  License: "License",
  USDT: "TestUSDT",
  BnbFeed: "MockAggregatorV3",
  StakingMath: "StakingMath",
  NetworkFreeze: "NetworkFreeze",
  Treasury: "Treasury",
  Network: "Network",
  PriceFeed: "PriceFeed",
  TokenSale: "TokenSale",
  Staking: "Staking",
  LicenseSale: "LicenseSale",
  Rewards: "Rewards",
  Jump: "Jump",
  TimelockController: "TimelockController",
};

export const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);
export const roleHash = (name: string) => (name === "DEFAULT_ADMIN_ROLE" ? DEFAULT_ADMIN_ROLE : id(name));

/** `run` sends, `dry-run` prints every step and sends nothing, `check` reports drift against the chain. */
export type Mode = "run" | "dry-run" | "check";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared state of one task run: the record, the signer, and how transactions are sent (or not). */
export class Deployment {
  sent = 0;
  txHashes: string[] = [];
  lastBlock: number | undefined;
  /** Libraries a task deployed (or, in a dry-run, stands in for) that the record does not name yet. */
  readonly pendingLibraries: Partial<Record<ContractName, string>> = {};

  constructor(
    readonly hre: HardhatRuntimeEnvironment,
    readonly mode: Mode,
    readonly params: DeployParams,
    readonly deployer: string,
    readonly signer: Signer | undefined,
    readonly record: DeployRecord,
    /** Where the record is persisted; undefined keeps it in memory only. */
    readonly path: string | undefined,
    readonly dir: string | undefined,
    readonly log: (message: string) => void,
    private readonly writeRecord = false,
  ) {}

  get sends(): boolean {
    return this.mode === "run";
  }

  get local(): boolean {
    return isLocalChain(this.record.chainId);
  }

  /** The deployed (or recorded) address of a contract, undefined while it does not exist yet. */
  addr(name: ContractName): string | undefined {
    return this.record.contracts[name]?.address;
  }

  /** Placeholder-aware address for log lines. */
  label(name: ContractName): string {
    return this.addr(name) ?? `<${name}>`;
  }

  /** A read-only or signing handle (signing only in `run` mode), undefined when the contract does not exist yet. */
  async attach(name: ContractName, artifact = ARTIFACT[name]): Promise<Contract | undefined> {
    const address = this.addr(name);
    if (!address) return undefined;
    const { abi } = await this.hre.artifacts.readArtifact(artifact);
    return new Contract(address, abi, this.signer ?? this.hre.ethers.provider);
  }

  /** Sends one transaction, waits for it and keeps hash / block for the step log. */
  async send(pending: Promise<ContractTransactionResponse>): Promise<void> {
    if (!this.sends) throw new Error("internal: a transaction was attempted outside of run mode");
    const tx = await pending;
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`Transaction ${tx.hash} failed`);
    this.sent += 1;
    this.txHashes.push(receipt.hash);
    this.lastBlock = receipt.blockNumber;
    await this.settle();
  }

  /** Public RPCs sit behind load balancers: give the next read / estimate a chance to see the new block. */
  async settle(): Promise<void> {
    if (!this.local) await sleep(1500);
  }

  takeTxs(): { txHashes: string[]; block?: number } {
    const out = { txHashes: this.txHashes, block: this.lastBlock };
    this.txHashes = [];
    this.lastBlock = undefined;
    return out;
  }

  save(): void {
    if ((this.sends || this.writeRecord) && this.path) saveRecord(this.path, this.record);
  }

  markStep(step: StepRecord): void {
    const existing = this.record.steps.find((s) => s.id === step.id);
    if (!existing) this.record.steps.push(step);
    else if (existing.status !== "done" || step.status === "done") Object.assign(existing, step);
  }

  /** True when the step was recorded as done by an earlier run (initial-state steps are not re-applied). */
  recorded(stepId: string): boolean {
    return this.record.steps.some((s) => s.id === stepId);
  }
}
