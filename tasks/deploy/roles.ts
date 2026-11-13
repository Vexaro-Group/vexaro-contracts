import { type Contract, Interface, getAddress, id } from "ethers";

import { DEFAULT_ADMIN_ROLE, type Deployment } from "./context";
import { type ContractName, type HandoverMode, ROLE_CONTRACTS } from "./types";

/**
 * `setup`: the deployer governs; `granting`: targets hold the roles, the deployer may still; `renouncing`: `safe` mode,
 * the deployer may still hold DEFAULT_ADMIN only; `exiting`: the `--renounce-admin` step, the deployer may still hold
 * any role (the holders that are required are the same as in `handed`); `handed`: only targets (in `safe` mode plus
 * the DEFAULT_ADMIN the deployer keeps while `adminKeptBy` is set).
 */
export type Phase = "setup" | "granting" | "renouncing" | "exiting" | "handed";

export function phaseOf(d: Deployment): Phase {
  const h = d.record.handover;
  return h?.completed ? "handed" : h?.granted ? "granting" : "setup";
}

/** The mode of the hand-over: what the record started with, else what the params ask for (default `timelock`). */
export function handoverModeOf(d: Deployment): HandoverMode {
  return d.record.handover ? d.record.handover.mode ?? "timelock" : d.params.handoverMode ?? "timelock";
}

/**
 * True when the TimelockController holds the governance roles: the `timelock` hand-over mode, or a `safe` hand-over
 * whose governance moved to a timelock (`task:governance:timelock`).
 */
export function timelockGoverned(d: Deployment): boolean {
  return handoverModeOf(d) === "timelock" || d.record.handover?.governance === "timelock";
}

const MANAGED: ContractName[] = ["Network", "PriceFeed", "TokenSale", "Staking", "LicenseSale", "Rewards", "Jump"];

/** Governance roles the deployer starts with and where each goes at the hand-over. */
export function governanceRoles(contract: ContractName): { timelock: string[]; multisig: string[] } {
  if (contract === "Vexaro")
    return { timelock: ["DEFAULT_ADMIN_ROLE", "FEE_MANAGER_ROLE", "EXEMPT_MANAGER_ROLE"], multisig: [] };
  if (contract === "License") return { timelock: ["DEFAULT_ADMIN_ROLE"], multisig: ["MINTER_ROLE", "PAUSER_ROLE"] };
  if (contract === "Treasury") return { timelock: ["DEFAULT_ADMIN_ROLE", "UPGRADER_ROLE"], multisig: [] };
  // the admin console releases the airdrop hold at once, without the 48 h timelock
  if (contract === "Staking")
    return {
      timelock: ["DEFAULT_ADMIN_ROLE", "UPGRADER_ROLE"],
      multisig: ["OPERATOR_ROLE", "EXIT_PAUSER_ROLE", "AIRDROP_RELEASER_ROLE"],
    };
  if (MANAGED.includes(contract))
    return { timelock: ["DEFAULT_ADMIN_ROLE", "UPGRADER_ROLE"], multisig: ["OPERATOR_ROLE", "EXIT_PAUSER_ROLE"] };
  return { timelock: [], multisig: [] };
}

/** Roles other contracts hold (README checklist 3, 4, 5, 7). */
const WIRED: [ContractName, string, ContractName[]][] = [
  ["Network", "REGISTRAR_ROLE", ["TokenSale", "Staking", "LicenseSale"]],
  ["Network", "STAKING_HOOK_ROLE", ["Staking"]],
  ["Network", "LICENSE_HOOK_ROLE", ["LicenseSale"]],
  ["Network", "WITHDRAWAL_HOOK_ROLE", ["Rewards"]],
  ["Network", "REWARDS_ROLE", ["Rewards"]],
  ["Staking", "GRANTER_ROLE", ["Jump"]],
  ["Vexaro", "AIRDROP_SPENDER_ROLE", ["Staking"]],
  ["Staking", "REWARDS_ROLE", ["Rewards"]],
  ["Jump", "HOOK_ROLE", ["Staking"]],
  ["Treasury", "PAYER_ROLE", ["TokenSale", "LicenseSale"]],
  ["Treasury", "RESERVE_SPENDER_ROLE", ["TokenSale"]],
  // Rewards (claims) and Jump (grants) credit what the platform pays out for the current-price sale
  ["TokenSale", "SELL_CREDITOR_ROLE", ["Rewards", "Jump"]],
  ["License", "MINTER_ROLE", ["LicenseSale"]],
  ["License", "BURNER_ROLE", ["LicenseSale"]],
];
export const GUARDIAN_CONTRACTS: ContractName[] = ["Network", "Staking", "TokenSale", "LicenseSale", "Rewards", "Jump"];

/** Role names a contract defines: DEFAULT_ADMIN_ROLE plus every `*_ROLE` constant getter of its ABI. */
export function roleNames(iface: Interface): string[] {
  const names: string[] = [];
  iface.forEachFunction((f) => {
    if (f.inputs.length === 0 && f.name.endsWith("_ROLE") && f.name !== "DEFAULT_ADMIN_ROLE") names.push(f.name);
  });
  return ["DEFAULT_ADMIN_ROLE", ...names];
}

/**
 * The hash of a role: the contract's constant getter, or keccak256(name) (what every getter returns) when the deployed
 * code predates the role, e.g. before the core upgrade.
 */
export async function roleHashOf(name: string, c: Contract): Promise<string> {
  if (name === "DEFAULT_ADMIN_ROLE") return DEFAULT_ADMIN_ROLE;
  try {
    return await c.getFunction(name)();
  } catch {
    return id(name);
  }
}

/** Who must hold `role` on `contract`: `required` always, `allowed` may. Everybody else must not. */
export function expectedHolders(
  d: Deployment,
  contract: ContractName | "TimelockController",
  role: string,
  phase: Phase,
): { required: Set<string>; allowed: Set<string> } {
  const required = new Set<string>();
  const allowed = new Set<string>();
  const { multisig, guardian } = d.params;
  const norm = (a: string) => getAddress(a);
  const timelock = d.record.handover?.timelock ?? d.addr("TimelockController");

  if (contract === "TimelockController") {
    if (role === "DEFAULT_ADMIN_ROLE" && timelock) required.add(norm(timelock));
    else if (["PROPOSER_ROLE", "CANCELLER_ROLE", "EXECUTOR_ROLE"].includes(role)) required.add(norm(multisig));
    if (phase === "exiting") allowed.add(norm(d.deployer));
    return { required, allowed };
  }

  for (const [c, r, holders] of WIRED)
    if (c === contract && r === role) for (const h of holders) if (d.addr(h)) required.add(norm(d.addr(h)!));
  if (role === "GUARDIAN_ROLE" && GUARDIAN_CONTRACTS.includes(contract)) required.add(norm(guardian));

  if (phase === "exiting") allowed.add(norm(d.deployer));
  const gov = governanceRoles(contract);
  // `safe` mode: there is no timelock until the governance moves, the roles of its column go to the multisig (the Safe)
  const safeMode = handoverModeOf(d) === "safe";
  const target = gov.timelock.includes(role)
    ? timelockGoverned(d)
      ? timelock
      : multisig
    : gov.multisig.includes(role)
      ? multisig
      : undefined;
  if (gov.timelock.includes(role) || gov.multisig.includes(role)) {
    if (phase === "setup") required.add(norm(d.deployer));
    else {
      if (target) required.add(norm(target));
      if (phase === "granting") allowed.add(norm(d.deployer));
      if (safeMode && role === "DEFAULT_ADMIN_ROLE") {
        // the deployer keeps DEFAULT_ADMIN as a backup until --renounce-admin
        if (phase === "renouncing") allowed.add(norm(d.deployer));
        else if (phase === "handed" && d.record.handover?.adminKeptBy)
          required.add(norm(d.record.handover.adminKeptBy));
      }
    }
  }
  return { required, allowed };
}

export interface RoleRow {
  contract: string;
  role: string;
  holder: string;
  holderName: string;
  /** What the params ask for: true = must hold, false = must not. */
  want: boolean;
  have: boolean;
}

/** Names for the addresses of the deployment, for the tables. */
export function nameMap(d: Deployment): Map<string, string> {
  const names = new Map<string, string>();
  for (const [n, c] of Object.entries(d.record.contracts)) names.set(getAddress(c.address), n);
  names.set(getAddress(d.params.multisig), handoverModeOf(d) === "safe" ? "safe" : "multisig");
  names.set(getAddress(d.params.guardian), "guardian");
  names.set(getAddress(d.deployer), "deployer");
  const h = d.record.handover;
  if (h?.timelock) names.set(getAddress(h.timelock), "timelock");
  return names;
}

/**
 * Reads `hasRole` of every role of every contract for every account that plays a part (deployer, multisig, guardian,
 * timelock, the system contracts) and compares with the expectation of the phase. Returns one row per positive
 * expectation and per unexpected holder.
 */
export async function checkRoles(d: Deployment, phase = phaseOf(d)): Promise<RoleRow[]> {
  const names = nameMap(d);
  const candidates = [...names.keys()];
  const rows: RoleRow[] = [];
  const contracts: (ContractName | "TimelockController")[] = [...ROLE_CONTRACTS];
  if (d.addr("TimelockController")) contracts.push("TimelockController");
  for (const name of contracts) {
    const c = await d.attach(name);
    if (!c) continue;
    for (const role of roleNames(c.interface)) {
      const hash = await roleHashOf(role, c);
      const { required, allowed } = expectedHolders(d, name, role, phase);
      const have = await Promise.all(
        candidates.map(async (who) => [who, (await c.hasRole(hash, who)) as boolean] as const),
      );
      for (const [who, held] of have) {
        const must = required.has(who);
        if (must || (held && !allowed.has(who)))
          rows.push({ contract: name, role, holder: who, holderName: names.get(who) ?? who, want: must, have: held });
      }
    }
  }
  return rows;
}

/** Public RPCs rate-limit log queries ("limit exceeded"): wait and ask again a few times. */
export async function withRetry<T>(call: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (error) {
      if (i >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * i));
    }
  }
}

/**
 * Optional wide scan: replays RoleGranted / RoleRevoked of each contract in chunks (public RPCs cap the range) and
 * reports accounts outside the known set that still hold a role. `fromBlock` limits the scan to the grants since then
 * (an incremental check after a hand-over; the grants before it need one full scan).
 */
export async function strangeHolders(d: Deployment, chunk = 5000, fromBlock = 0): Promise<RoleRow[]> {
  const names = nameMap(d);
  const rows: RoleRow[] = [];
  const contracts: (ContractName | "TimelockController")[] = [...ROLE_CONTRACTS, "TimelockController"];
  for (const name of contracts) {
    const c = await d.attach(name);
    if (!c) continue;
    const provider = c.runner!.provider!;
    const latest = await provider.getBlockNumber();
    const from0 = Math.max(fromBlock, d.record.contracts[name]?.deployBlock ?? 0);
    const seen = new Set<string>();
    for (let from = from0; from <= latest; from += chunk) {
      const to = Math.min(from + chunk - 1, latest);
      for (const log of await withRetry(() => c.queryFilter(c.filters.RoleGranted(), from, to))) {
        const [role, account] = (log as unknown as { args: [string, string] }).args;
        seen.add(`${role}:${getAddress(account)}`);
      }
    }
    for (const key of seen) {
      const [role, who] = key.split(":");
      if (names.has(who) || !(await c.hasRole(role, who))) continue;
      const roleName = (
        await Promise.all(roleNames(c.interface).map(async (r) => [r, await roleHashOf(r, c)] as const))
      ).find(([, h]) => h === role);
      rows.push({ contract: name, role: roleName?.[0] ?? role, holder: who, holderName: who, want: false, have: true });
    }
  }
  return rows;
}
