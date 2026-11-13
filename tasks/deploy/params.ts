import { createHash } from "crypto";
import { ZeroAddress, getAddress, isAddress } from "ethers";
import { existsSync } from "fs";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { join, resolve } from "path";

import type { DeployParams, ParamsFactory } from "./types";

export const LOCAL_CHAIN_IDS = [31337, 1337];
export const MAINNET_CHAIN_ID = 56;
export const MIN_MAINNET_TIMELOCK_DELAY = 48 * 3600;
/** TokenSale.MAX_ROUNDS */
const MAX_ROUNDS = 8;
const MAX_WALLETS = 16;
const MAX_FEE_BPS = 100;
const MAX_BF_TOTAL_BPS = 500;
const SUPPLY = 1_000_000_000n * 10n ** 18n;

export function isLocalChain(chainId: number): boolean {
  return LOCAL_CHAIN_IDS.includes(chainId);
}

export const sameAddress = (a?: string, b?: string): boolean =>
  a !== undefined && b !== undefined && isAddress(a) && isAddress(b) && getAddress(a) === getAddress(b);

/**
 * Errors make every run refuse; placeholders (the zero address or a negative amount, marked TODO(operator) in the
 * params file) only block a real run, so a dry-run can still print the steps of a half-filled file.
 */
export function validateParams(p: DeployParams, chainId: number): { errors: string[]; placeholders: string[] } {
  const errors: string[] = [];
  const placeholders: string[] = [];
  const address = (name: string, value: string | undefined, optional = false) => {
    if (value === undefined && optional) return;
    if (value === undefined || !isAddress(value)) errors.push(`${name}: not an address (${String(value)})`);
    else if (value === ZeroAddress) placeholders.push(name);
  };
  const amount = (name: string, value: unknown) => {
    if (typeof value !== "bigint") errors.push(`${name}: must be a bigint`);
    else if (value < 0n) placeholders.push(name);
  };
  const ints = (name: string, list: number[], length: number, max?: number) => {
    if (list.length !== length) errors.push(`${name}: needs ${length} entries, has ${list.length}`);
    for (const v of list)
      if (!Number.isInteger(v) || v < 0 || (max !== undefined && v > max)) errors.push(`${name}: ${v} is invalid`);
  };

  if (p.chainId !== chainId) errors.push(`chainId: the params are for chain ${p.chainId}, connected to ${chainId}`);
  const mainnet = chainId === MAINNET_CHAIN_ID;
  const local = isLocalChain(chainId);

  address("usdt", p.usdt, true);
  address("bnbFeed.address", p.bnbFeed.address, true);
  address("multisig", p.multisig);
  address("guardian", p.guardian);
  address("vexRemainderTo", p.vexRemainderTo);
  address("airdropWallet", p.airdropWallet);
  p.exemptions.forEach((a, i) => address(`exemptions[${i}]`, a));
  p.treasury.wallets.forEach((w, i) => address(`treasury.wallets[${i}].account`, w.account));
  p.usdtMints.forEach((m, i) => address(`usdtMints[${i}].to`, m.to));
  address("vexPrice.adapter", p.vexPrice.adapter, true);

  if (p.usdt === undefined) {
    if (mainnet) errors.push("usdt: the TestUSDT is never deployed on mainnet");
  } else if (p.usdtMints.length > 0) errors.push("usdtMints: only with the TestUSDT (usdt omitted)");
  if (p.bnbFeed.address === undefined && !local) errors.push("bnbFeed.address: a mock feed is only allowed locally");
  if (!Number.isInteger(p.bnbFeed.maxAge) || p.bnbFeed.maxAge <= 0) errors.push("bnbFeed.maxAge: seconds, > 0");

  if (!Number.isInteger(p.vexFeeBps) || p.vexFeeBps < 0 || p.vexFeeBps > MAX_FEE_BPS)
    errors.push(`vexFeeBps: ${p.vexFeeBps} is not an integer in 0..${MAX_FEE_BPS}`);
  if (p.vexPrice.mode === "MANUAL" && !(p.vexPrice.manual && p.vexPrice.manual > 0n))
    errors.push("vexPrice: MANUAL needs a manual price > 0");
  if (p.vexPrice.mode === "ADAPTER" && !p.vexPrice.adapter) errors.push("vexPrice: ADAPTER needs an adapter");
  if (p.vexPrice.manual !== undefined && p.vexPrice.manual <= 0n) errors.push("vexPrice.manual: must be > 0");

  if (p.handoverMode !== undefined && p.handoverMode !== "timelock" && p.handoverMode !== "safe")
    errors.push(`handoverMode: "${String(p.handoverMode)}" is neither timelock nor safe`);
  if (!Number.isInteger(p.timelockDelay) || p.timelockDelay <= 0) errors.push("timelockDelay: seconds, > 0");
  else if (mainnet && p.handoverMode !== "safe" && p.timelockDelay < MIN_MAINNET_TIMELOCK_DELAY)
    errors.push(`timelockDelay: ${p.timelockDelay} s is below the 48 h minimum`);
  if (p.timelockGovernance && p.handoverMode !== "safe")
    errors.push('timelockGovernance: only after a hand-over in handoverMode "safe"');
  if (mainnet && !p.multisigIsContract)
    errors.push("multisigIsContract: the mainnet multisig must be the Safe contract");

  // Treasury
  amount("treasury.reserveUsdt", p.treasury.reserveUsdt);
  if (p.treasury.wallets.length > MAX_WALLETS) errors.push(`treasury.wallets: at most ${MAX_WALLETS}`);
  let total = 0;
  const seen = new Set<string>();
  for (const w of p.treasury.wallets) {
    if (!Number.isInteger(w.rateBps) || w.rateBps <= 0)
      errors.push(`treasury.wallets: rate of ${w.account} must be > 0`);
    total += w.rateBps;
    const key = isAddress(w.account) ? getAddress(w.account) : w.account;
    if (seen.has(key)) errors.push(`treasury.wallets: ${w.account} listed twice`);
    seen.add(key);
  }
  if (total > 10_000) errors.push(`treasury.wallets: rates sum to ${total} bps (> 10000)`);

  if (!p.exemptions.some((a) => sameAddress(a, p.vexRemainderTo)))
    errors.push("vexRemainderTo: must be listed in exemptions (the transfer would burn the VEX fee otherwise)");

  // limits
  for (const [key, value] of Object.entries(p.caps)) {
    if (typeof value !== "bigint" || value < 0n) errors.push(`caps.${key}: must be a bigint >= 0`);
  }

  if (!Number.isInteger(p.currentSell.feeBps) || p.currentSell.feeBps < 0 || p.currentSell.feeBps > 1_000)
    errors.push("currentSell.feeBps: an integer in 0..1000");
  amount("currentSell.accountCapUsdt", p.currentSell.accountCapUsdt);
  amount("currentSell.globalCapUsdt", p.currentSell.globalCapUsdt);

  // Network tables
  ints("network.ncRates", p.network.ncRates, 15, 10_000);
  ints("network.lrRates", p.network.lrRates, 10, 10_000);
  if (p.network.ncRates.reduce((a, b) => a + b, 0) > 10_000) errors.push("network.ncRates: sum above 100 %");
  if (p.network.lrRates.reduce((a, b) => a + b, 0) > 10_000) errors.push("network.lrRates: sum above 100 %");
  const bf = p.network.backFlow;
  if (
    !Number.isInteger(bf.bps) ||
    !Number.isInteger(bf.levels) ||
    bf.levels > 10 ||
    bf.bps * bf.levels > MAX_BF_TOTAL_BPS
  )
    errors.push(`network.backFlow: bps * levels must be an integer <= ${MAX_BF_TOTAL_BPS} with at most 10 levels`);
  ints("network.tierLevels.nc", p.network.tierLevels.nc, 5, 15);
  ints("network.tierLevels.lr", p.network.tierLevels.lr, 5, 10);
  for (const list of [p.network.tierLevels.nc, p.network.tierLevels.lr])
    for (let i = 1; i < list.length; i++) if (list[i] < list[i - 1]) errors.push("network.tierLevels: not ascending");

  // licence prices
  const keys = new Set<string>();
  for (const l of p.licensePrices) {
    if (!(l.tier >= 1 && l.tier <= 4) || ![30, 180, 360].includes(l.term))
      errors.push(`licensePrices: tier ${l.tier} / term ${l.term} does not exist`);
    if (typeof l.usdt !== "bigint" || l.usdt <= 0n) errors.push(`licensePrices: ${l.tier}/${l.term} needs a price > 0`);
    if (keys.has(`${l.tier}/${l.term}`)) errors.push(`licensePrices: ${l.tier}/${l.term} listed twice`);
    keys.add(`${l.tier}/${l.term}`);
  }

  // rounds and funding
  if (p.rounds.length === 0 || p.rounds.length > MAX_ROUNDS) errors.push(`rounds: 1..${MAX_ROUNDS} rounds`);
  p.rounds.forEach((r, i) => {
    if (r.price <= 0n || r.allocation <= 0n) errors.push(`rounds[${i}]: price and allocation must be > 0`);
  });
  if (!Number.isInteger(p.activeRound) || p.activeRound < 0 || p.activeRound > p.rounds.length)
    errors.push(`activeRound: 0..${p.rounds.length}`);
  let vexNeeded = 0n;
  for (const f of p.roundFunding) {
    const round = p.rounds[f.round - 1];
    if (!round) errors.push(`roundFunding: round ${f.round} does not exist`);
    else if (f.amount <= 0n || f.amount > round.allocation)
      errors.push(`roundFunding: round ${f.round} amount must be in 1..allocation`);
    else vexNeeded += f.amount;
  }
  for (const [key, value] of Object.entries(p.funding)) {
    amount(`funding.${key}`, value);
    if (value > 0n) vexNeeded += value;
  }
  amount("airdropAmount", p.airdropAmount);
  if (p.airdropAmount > 0n) vexNeeded += p.airdropAmount;
  if (vexNeeded > SUPPLY) errors.push("funding: the VEX to fund exceeds the 1B supply");
  p.usdtMints.forEach((m, i) => {
    if (m.amount <= 0n) errors.push(`usdtMints[${i}].amount must be > 0`);
  });
  if (p.launch !== "all" && p.launch !== "goLive") errors.push(`launch: "${String(p.launch)}"`);
  return { errors, placeholders };
}

/** Canonical JSON (sorted keys, bigint as decimal strings) hashed with sha256: a marker of which params ran. */
export function paramsDigest(params: DeployParams): string {
  const canon = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canon(x)]),
      );
    return v;
  };
  return (
    "0x" +
    createHash("sha256")
      .update(JSON.stringify(canon(params)))
      .digest("hex")
  );
}

/** `deploy/params/<network>.ts` (default export: the params or a factory), or an explicit file. */
export async function loadParams(hre: HardhatRuntimeEnvironment, file?: string): Promise<DeployParams> {
  // an explicit file is relative to the project root, like the default one (a bare relative path would not import)
  const path = file
    ? resolve(hre.config.paths.root, file)
    : join(hre.config.paths.root, "deploy", "params", `${hre.network.name}.ts`);
  if (!existsSync(path)) throw new Error(`No params file at ${path}; create it from deploy/params/bscTestnet.ts`);
  const mod = (await import(path)).default as DeployParams | ParamsFactory;
  if (typeof mod !== "function") return mod;
  const signers = (await hre.ethers.getSigners()).map((s) => s.address);
  return mod({ signers });
}
