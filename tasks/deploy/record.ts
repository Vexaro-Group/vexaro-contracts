import { isAddress } from "ethers";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { dirname, join } from "path";

import { type ContractName, type DeployRecord, PROXY_CONTRACTS } from "./types";

export function recordPath(hre: HardhatRuntimeEnvironment, dir?: string): string {
  return join(dir ?? join(hre.config.paths.root, "deployments"), `${hre.network.name}.json`);
}

export function loadRecord(path: string): DeployRecord | undefined {
  if (!existsSync(path)) return undefined;
  const record = JSON.parse(readFileSync(path, "utf8")) as DeployRecord;
  const errors = validateRecord(record);
  if (errors.length > 0) throw new Error(`${path} is not a valid deployment record:\n  ${errors.join("\n  ")}`);
  return record;
}

/** Atomic (temp file + rename): an interrupted run never leaves half a record. */
export function saveRecord(path: string, record: DeployRecord): void {
  record.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Writes the ABI of `artifact` to `<dir>/abis/<contract>.json` and returns the path relative to `dir`. */
export async function exportAbi(
  hre: HardhatRuntimeEnvironment,
  dir: string,
  contract: ContractName,
  artifact: string,
): Promise<string> {
  const rel = join("abis", `${contract}.json`);
  const { abi } = await hre.artifacts.readArtifact(artifact);
  mkdirSync(join(dir, "abis"), { recursive: true });
  writeFileSync(join(dir, rel), JSON.stringify(abi, null, 2) + "\n");
  return rel;
}

/** The contracts a finished deployment lists (the timelock appears with the hand-over). */
const CORE: ContractName[] = [
  "Vexaro",
  "License",
  "USDT",
  "StakingMath",
  "Treasury",
  "Network",
  "PriceFeed",
  "TokenSale",
  "Staking",
  "LicenseSale",
  "Rewards",
  "Jump",
];

/** Shape the backend / frontend / admin rely on; returns the problems found (empty = valid). */
export function validateRecord(r: Partial<DeployRecord>): string[] {
  const errors: string[] = [];
  if (r.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof r.network !== "string" || r.network === "") errors.push("network missing");
  if (!Number.isInteger(r.chainId)) errors.push("chainId missing");
  if (typeof r.deployer !== "string" || !isAddress(r.deployer)) errors.push("deployer is not an address");
  if (typeof r.paramsDigest !== "string") errors.push("paramsDigest missing");
  if (typeof r.config !== "object" || r.config === null) errors.push("config missing");
  if (!Array.isArray(r.steps)) errors.push("steps must be an array");

  const contracts = r.contracts ?? {};
  for (const [name, c] of Object.entries(contracts)) {
    if (!isAddress(c.address)) errors.push(`${name}.address is not an address`);
    if (!c.external) {
      if (!Number.isInteger(c.deployBlock)) errors.push(`${name}.deployBlock missing`);
      if (typeof c.abi !== "string") errors.push(`${name}.abi missing`);
    }
  }
  // a finished deployment lists every contract; a partial one only what exists so far
  if (r.complete) {
    for (const name of CORE) if (!contracts[name]) errors.push(`${name} missing from contracts`);
  }
  for (const name of PROXY_CONTRACTS) {
    const impl = contracts[name]?.implementation;
    if (contracts[name] && (impl === undefined || !isAddress(impl))) errors.push(`${name}.implementation missing`);
  }
  return errors;
}
