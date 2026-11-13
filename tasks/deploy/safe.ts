import { Contract, getAddress } from "ethers";

import type { Deployment } from "./context";

export interface SafeInfo {
  owners: string[];
  threshold: number;
  version: string;
}

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
];

/** Owners and threshold of the Safe, read-only; undefined when the multisig is an EOA stand-in (test networks). */
export async function inspectSafe(d: Deployment, safe: string): Promise<SafeInfo | undefined> {
  if (!d.params.multisigIsContract) return undefined;
  const c = new Contract(safe, SAFE_ABI, d.hre.ethers.provider);
  try {
    const owners = (await c.getOwners()) as string[];
    const threshold = Number(await c.getThreshold());
    const version = (await c.VERSION().catch(() => "unknown")) as string;
    return { owners: owners.map((o) => getAddress(o)), threshold, version };
  } catch {
    throw new Error(`${safe} does not answer getOwners() / getThreshold(): is it the Safe?`);
  }
}
