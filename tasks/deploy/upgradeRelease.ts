import { type Contract, Interface, ZeroAddress, getAddress, id } from "ethers";

import { ARTIFACT, DEFAULT_ADMIN_ROLE, type Deployment } from "./context";
import { exportAbi } from "./record";
import {
  SMART_POOL,
  type SlotCycle,
  needingRecord,
  openStakesOfPool,
  partialCycles,
  readStakes,
  scanJump,
} from "./releaseScan";
import { roleHashOf, roleNames } from "./roles";
import { inspectSafe } from "./safe";
import type { ContractName, UpgradeRecord, UpgradedImplementation } from "./types";
import {
  type Call,
  RELEASE_UPGRADE_ID,
  type RoleNeeds,
  type Route,
  attachable,
  factoryOf,
  holdsAll,
  implementationOf,
  isBuildOf,
  isTimelockRoute,
  recordOf,
  runDirect,
  runVia,
  safeRoute,
  timelockDelay,
  unsafeAllowOf,
  validate,
  writeSafeBatch,
} from "./upgradeCore";
import { survey, syncBases } from "./upgradeLargestStake";
import { SCHEDULE_KEY, isStakingBuild, stakingFactory, stateOf } from "./upgradeStaking";

const UPGRADER_ROLE = id("UPGRADER_ROLE");
const PROPOSER_ROLE = id("PROPOSER_ROLE");
const EXECUTOR_ROLE = id("EXECUTOR_ROLE");
const OPERATOR_ROLE = id("OPERATOR_ROLE");
const RESERVE_SPENDER_ROLE = id("RESERVE_SPENDER_ROLE");
const HOOK_ROLE = id("HOOK_ROLE");
/** OpenZeppelin's `Initializable` namespace: the highest `initializer` / `reinitializer` version that ran is its low 64 bits. */
const INITIALIZABLE_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
/** What `TokenSale.initializeV3` sets: the daily limits of the round-price sell-back, USDT wei per account / in total. */
export const SELL_ACCOUNT_CAP_USDT = 2_000n * 10n ** 18n;
export const SELL_GLOBAL_CAP_USDT = 20_000n * 10n ** 18n;
/** EIP-170: the largest runtime a contract may have. */
const MAX_RUNTIME = 24_576;
/** Stand-in for a library that a dry-run would deploy: the layout checks only need some address. */
const DRY_RUN_LIBRARY = "0x000000000000000000000000000000000000dEaD";

/** The proxies of the release in the order their calls run; Treasury and PriceFeed only when their build differs. */
const PROXIES = ["Network", "TokenSale", "Staking", "Rewards", "Jump", "LicenseSale", "Treasury", "PriceFeed"] as const;
type ReleaseProxy = (typeof PROXIES)[number];
const LIBRARIES = ["NetworkFreeze", "StakingMath"] as const;
type Library = (typeof LIBRARIES)[number];

export interface ReleaseOptions {
  /** Stop after this step id (`impl:NetworkFreeze`, `impl:StakingMath`, `impl:<Name>`, `upgrade:<Name>`, `schedule`); the next run resumes. */
  stopAfter?: string;
  /** Timelock path: keep polling until the operation is ready and execute it. */
  wait?: boolean;
  /** Test seam: runs once the calls are confirmed, before the state is compared (to prove the comparison has teeth). */
  afterCalls?: () => Promise<void>;
  /**
   * Go on although stakes of Smart are open: they follow the two-halves schedule from the call on and what they were
   * credited daily keeps counting as claimed. For a test network; on mainnet there is none and the run refuses.
   */
  allowOpenSmart?: boolean;
}

export interface ReleaseRow {
  status: "OK" | "DRIFT" | "INFO";
  item: string;
  want: string;
  have: string;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// --------------------------------------------------------------------------------------------- builds

/** True when `address` holds the runtime of the library the compiler produces (it embeds its own address, 20 bytes). */
async function isLibraryBuild(d: Deployment, name: Library, address: string): Promise<boolean> {
  const { deployedBytecode } = await d.hre.artifacts.readArtifact(ARTIFACT[name]);
  const code = (await d.hre.ethers.provider.getCode(address)).toLowerCase();
  return code.split(address.slice(2).toLowerCase()).join("0".repeat(40)) === deployedBytecode.toLowerCase();
}

/** The address of a library that is already deployed as the current build: this upgrade's own, else the record's. */
async function existingLibrary(d: Deployment, up: UpgradeRecord, name: Library): Promise<string | undefined> {
  for (const candidate of [up.implementations[name]?.current, d.addr(name)]) {
    if (candidate && (await isLibraryBuild(d, name, candidate))) return getAddress(candidate);
  }
  return undefined;
}

/** Is the implementation at `address` the build the compiler produces now (libraries linked as `libs`)? */
async function isBuild(
  d: Deployment,
  name: ReleaseProxy,
  address: string,
  libs: Partial<Record<Library, string>>,
): Promise<boolean> {
  if (name === "Staking") return libs.StakingMath ? isStakingBuild(d, address, libs.StakingMath) : false;
  if (name === "Network") {
    if (!libs.NetworkFreeze) return false;
    d.pendingLibraries.NetworkFreeze = libs.NetworkFreeze;
  }
  return isBuildOf(d, name, address);
}

/** `unsafeAllow` of the layout checks: the one library each of Network and Staking links, nothing else. */
const layoutAllowance = (name: ReleaseProxy) => [
  ...unsafeAllowOf(name),
  ...(name === "Staking" ? (["external-library-linking"] as const) : []),
];

/** The libraries of the record, as far as they are the current build. */
async function recordedLibraries(d: Deployment, up: UpgradeRecord): Promise<Partial<Record<Library, string>>> {
  const libs: Partial<Record<Library, string>> = {};
  for (const name of LIBRARIES) libs[name] = await existingLibrary(d, up, name);
  return libs;
}

// --------------------------------------------------------------------------------------------- state

/** The highest initializer version that ran on a proxy. */
async function initializedVersion(d: Deployment, proxy: string): Promise<bigint> {
  const word = await d.hre.ethers.provider.getStorage(proxy, INITIALIZABLE_SLOT);
  return BigInt(word) & ((1n << 64n) - 1n);
}

/** `read` of a zero-argument view as text; "n/a" when the deployed code has no such function. */
async function readView(c: Contract, name: string): Promise<string> {
  try {
    return json(await c.getFunction(name)());
  } catch {
    return "n/a";
  }
}

/** The views of the upgraded contracts (except Staking, see `stateOf`) that the upgrade must leave as they are. */
const WIRING: Partial<Record<ReleaseProxy, string[]>> = {
  Network: ["priceFeed", "ncRates", "lrRates", "backFlow", "tierLevels", "guardianFreezeBudget", "pausedFlags"],
  TokenSale: [
    "vex",
    "usdt",
    "treasury",
    "network",
    "priceFeed",
    "sellSink",
    "roundCount",
    "rounds",
    "currentSellCaps",
    "currentSellFeeBps",
    "pausedFlags",
  ],
  Rewards: ["vex", "network", "staking", "priceFeed", "tokenSale", "wholeBalanceWhenHalfBelowMin", "pausedFlags"],
  Jump: ["vex", "network", "staking", "priceFeed", "tokenSale", "reviewPeriod", "allocation", "pausedFlags"],
  LicenseSale: ["license", "usdt", "treasury", "network", "priceFeed", "staking", "pausedFlags"],
};

async function wiringOf(d: Deployment): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, views] of Object.entries(WIRING) as [ReleaseProxy, string[]][]) {
    const c = await attachable(d, name);
    for (const view of views) out[`${name}.${view}`] = await readView(c, view);
  }
  // the VEX limit only: the second limit is gone from Rewards
  out["Rewards.caps"] = json((await (await attachable(d, "Rewards")).capsOf()).capUsdt);
  return out;
}

/** True when pool `SMART_POOL` is on the two-halves schedule; false on a Staking that does not know the flag. */
async function halvesOn(staking: Contract): Promise<boolean> {
  try {
    return Boolean(await staking.poolHalves(SMART_POOL));
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------------------------- Treasury buckets

/** Gas a BNB share gets in `Treasury.notifyPayment` (`WALLET_SEND_GAS`); the dry-run of a send uses the same. */
const WALLET_SEND_GAS = 50_000n;
const TOKENS = [
  { id: "USDT", label: "USDT" },
  { id: "BNB", label: "BNB" },
] as const;
type BucketToken = (typeof TOKENS)[number]["id"];

const tokenAddress = (d: Deployment, token: BucketToken) => (token === "BNB" ? ZeroAddress : d.addr("USDT")!);

interface OpenBucket {
  wallet: string;
  amount: bigint;
  /** A send of the bucket from the Treasury would succeed (simulated with `eth_call`). */
  receivable: boolean;
}

/** Would `to` accept `amount` of `token` sent by the Treasury? A simulation, nothing is sent. */
async function canReceive(d: Deployment, token: BucketToken, to: string, amount: bigint): Promise<boolean> {
  const provider = d.hre.ethers.provider;
  const from = d.addr("Treasury")!;
  try {
    if (token === "BNB") {
      await provider.call({ from, to, value: amount, gasLimit: WALLET_SEND_GAS });
      return true;
    }
    const data = new Interface(["function transfer(address,uint256) returns (bool)"]).encodeFunctionData("transfer", [
      to,
      amount,
    ]);
    const out = await provider.call({ from, to: tokenAddress(d, token), data });
    return out === "0x" || BigInt(out) === 1n;
  } catch {
    return false;
  }
}

/** The registered wallets of the Treasury that have something in their bucket of `token`. */
async function openBuckets(d: Deployment, token: BucketToken): Promise<OpenBucket[]> {
  const treasury = (await attachable(d, "Treasury"))!;
  const out: OpenBucket[] = [];
  for (const w of await treasury.wallets()) {
    const wallet = getAddress(w.account);
    const amount = BigInt(await treasury.bucketOf(tokenAddress(d, token), wallet));
    if (amount > 0n) out.push({ wallet, amount, receivable: await canReceive(d, token, wallet, amount) });
  }
  return out;
}

// --------------------------------------------------------------------------------------------- pre-checks

interface PreChecks {
  problems: string[];
  /** Full cycles whose slot stakes the Safe has to record after the upgrade, and the partial ones. */
  recording: SlotCycle[];
  partial: SlotCycle[];
}

/** Roles of `who` on every contract, one line each (read-only; the ABIs of the build list the roles). */
async function rolesLine(d: Deployment, who: string): Promise<string[]> {
  const lines: string[] = [];
  for (const name of ["Vexaro", "License", ...PROXIES] as ContractName[]) {
    const c = await d.attach(name);
    if (!c) continue;
    const held: string[] = [];
    for (const role of roleNames(c.interface))
      if (await c.hasRole(await roleHashOf(role, c), who)) held.push(role.replace(/_ROLE$/, ""));
    lines.push(`    ${name.padEnd(12)} ${held.join(", ") || "-"}`);
  }
  return lines;
}

/**
 * Everything the upgrade needs to be true before it starts, read-only. Problems make a run that sends refuse (a dry-run
 * only says so). `pending` are the proxies whose implementation is replaced.
 */
async function preChecks(d: Deployment, pending: Set<ReleaseProxy>, allowOpenSmart = false): Promise<PreChecks> {
  const { log } = d;
  const problems: string[] = [];
  const staking = (await attachable(d, "Staking"))!;
  const network = (await attachable(d, "Network"))!;
  log("pre-checks (read-only):");

  // who holds what
  const safe = getAddress(d.params.multisig);
  const info = await inspectSafe(d, safe);
  log(
    info
      ? `  Safe ${safe} (version ${info.version}): ${info.owners.length} owner(s), threshold ${info.threshold}`
      : `  Safe ${safe}: an EOA stand-in (multisigIsContract is false)`,
  );
  if (info) for (const o of info.owners) log(`    owner ${o}`);
  const me = d.signer ? await d.signer.getAddress() : d.deployer;
  log(`  roles of the sender ${me}:`);
  for (const l of await rolesLine(d, me)) log(l);
  log(`  roles of the Safe:`);
  for (const l of await rolesLine(d, safe)) log(l);

  // the Network hands its single hook role over to one role per caller: every caller must hold the old one now
  if (pending.has("Network")) {
    const version = await initializedVersion(d, d.addr("Network")!);
    log(`  Network initializer version ${version} (initializeV3 needs a lower one)`);
    if (version >= 3n) problems.push(`Network is at initializer version ${version}: initializeV3 would revert`);
    for (const name of ["TokenSale", "Staking", "LicenseSale", "Rewards"] as const) {
      const holds = await network.hasRole(HOOK_ROLE, d.addr(name)!);
      log(`  ${name} holds Network.HOOK_ROLE: ${holds}`);
      if (!holds && version < 3n)
        problems.push(`${name} does not hold Network.HOOK_ROLE: Network.initializeV3 would revert`);
    }
  }
  if (pending.has("TokenSale")) {
    const version = await initializedVersion(d, d.addr("TokenSale")!);
    log(`  TokenSale initializer version ${version} (initializeV3 needs a lower one)`);
    if (version >= 3n) problems.push(`TokenSale is at initializer version ${version}: initializeV3 would revert`);
  }

  // the two-halves schedule: the open stakes of Smart would restart their accrual
  const rows = await readStakes(staking);
  const open = openStakesOfPool(rows, SMART_POOL);
  const on = await halvesOn(staking);
  log(
    `  stakes on the chain: ${rows.length}; open in pool ${SMART_POOL} (Smart): ${open.length}; two-halves flag: ${on}`,
  );
  for (const s of open) log(`    open Smart stake ${s.id} of ${s.owner}`);
  if (!on && open.length > 0) {
    const text = `${open.length} open stake(s) in pool ${SMART_POOL} (Smart): enablePoolHalves would change their payout schedule`;
    if (allowOpenSmart) log(`  WARNING ${text} (--allow-open-smart)`);
    else problems.push(text);
  }

  // Jump: cycles filled before the stakes were recorded
  const cycles = await scanJump(d, rows);
  const recording = needingRecord(cycles);
  const partial = partialCycles(cycles);
  log(
    `  Jump cycles with a slot filled: ${cycles.length}; full and unclaimed without recorded stakes: ${recording.length}`,
  );
  for (const c of recording)
    log(
      `    sponsor ${c.sponsor} cycle ${c.cycleNo}: stakes ${c.stakeIds.join(", ")}${
        c.problem ? ` (${c.problem})` : ""
      }`,
    );
  for (const c of partial)
    log(`    sponsor ${c.sponsor} cycle ${c.cycleNo}: ${c.slots} of 4 slots (needs recordSlotStakes once it is full)`);
  for (const c of recording) if (c.problem) problems.push(`Jump cycle ${c.cycleNo} of ${c.sponsor}: ${c.problem}`);

  const treasury = (await attachable(d, "Treasury"))!;
  log(
    `  Rewards holds Treasury.RESERVE_SPENDER_ROLE: ${await treasury.hasRole(
      RESERVE_SPENDER_ROLE,
      d.addr("Rewards")!,
    )}`,
  );
  return { problems, recording, partial };
}

// --------------------------------------------------------------------------------------------- who sends what

/** The roles each pending call needs: the upgrade role of the proxy, DEFAULT_ADMIN for the calls inside the batch. */
function needsOf(calls: Call[]): RoleNeeds {
  const needs = new Map<ContractName, Set<string>>();
  const add = (name: ContractName, role: string) => needs.set(name, (needs.get(name) ?? new Set()).add(role));
  for (const c of calls) {
    if (c.id.startsWith("upgrade:")) add(c.contract, UPGRADER_ROLE);
    if (c.id === "upgrade:Network" || c.id === "upgrade:TokenSale") add(c.contract, DEFAULT_ADMIN_ROLE);
    if (c.id === "revoke:Treasury" || c.id === "halves:Staking") add(c.contract, DEFAULT_ADMIN_ROLE);
  }
  return [...needs].map(([name, roles]) => [name, [...roles]]);
}

async function missingRoles(d: Deployment, who: string, needs: RoleNeeds): Promise<string[]> {
  const out: string[] = [];
  for (const [name, roles] of needs) {
    const c = (await attachable(d, name))!;
    for (const role of roles)
      if (!(await c.hasRole(role, who)))
        out.push(`${name}.${role === DEFAULT_ADMIN_ROLE ? "DEFAULT_ADMIN_ROLE" : role}`);
  }
  return out;
}

/** Direct when the sender holds the roles (before the hand-over), the Safe when it does, else the timelock. */
async function routeOf(d: Deployment, calls: Call[]): Promise<Route> {
  const who = d.signer ? await d.signer.getAddress() : d.deployer;
  const needs = needsOf(calls);
  if (needs.length === 0 || (await holdsAll(d, who, needs))) return { via: "direct", problems: [] };
  const viaSafe = await safeRoute(d, needs);
  if (viaSafe) return viaSafe;

  const problems: string[] = [];
  const timelockAddress = d.record.contracts.TimelockController?.address;
  if (!timelockAddress) {
    problems.push(
      `${who} lacks ${(await missingRoles(d, who, needs)).join(
        ", ",
      )} and there is no TimelockController in the record (nor does the Safe hold them)`,
    );
    return { via: "timelock", problems };
  }
  const lacking = await missingRoles(d, timelockAddress, needs);
  if (lacking.length > 0) problems.push(`the timelock lacks ${lacking.join(", ")}`);
  const timelock = (await attachable(d, "TimelockController"))!;
  if (!(await timelock.hasRole(PROPOSER_ROLE, who))) problems.push(`${who} is not a proposer of the timelock`);
  if (!(await timelock.hasRole(EXECUTOR_ROLE, who))) problems.push(`${who} is not an executor of the timelock`);
  return { via: "timelock", problems };
}

// --------------------------------------------------------------------------------------------- the calls

const shown = (address: string) => (address === ZeroAddress ? "<new implementation>" : address);

/**
 * The batch, in the order it must run: Network (+ `initializeV3`), TokenSale (+ `initializeV3`), Staking, Rewards, Jump,
 * LicenseSale (and Treasury / PriceFeed when their build differs), then the Treasury revoke and the two-halves flag.
 * `impls` has an entry for every proxy that is part of the release.
 */
async function buildCalls(
  d: Deployment,
  impls: Partial<Record<ReleaseProxy, string>>,
  extra: { revoke: boolean; halves: boolean; release: boolean },
): Promise<Call[]> {
  const calls: Call[] = [];
  for (const name of PROXIES) {
    const impl = impls[name];
    if (impl === undefined) continue;
    const c = (await attachable(d, name))!;
    let init = "0x";
    if (name === "Network")
      init = c.interface.encodeFunctionData("initializeV3", [
        d.addr("TokenSale"),
        d.addr("Staking"),
        d.addr("LicenseSale"),
        d.addr("Rewards"),
      ]);
    if (name === "TokenSale")
      init = c.interface.encodeFunctionData("initializeV3", [SELL_ACCOUNT_CAP_USDT, SELL_GLOBAL_CAP_USDT]);
    const initName = name === "Network" || name === "TokenSale" ? "initializeV3" : "no call";
    calls.push({
      id: `upgrade:${name}`,
      title: `${name}.upgradeToAndCall(${shown(impl)}, ${initName})`,
      contract: name,
      data: c.interface.encodeFunctionData("upgradeToAndCall", [impl, init]),
      done: async () => (await implementationOf(d, name)) === getAddress(impl),
    });
  }
  if (extra.release) {
    // anyone may call releaseAll; right after the Treasury upgrade it pays what the old build left in the buckets
    const treasury = (await attachable(d, "Treasury"))!;
    for (const { id: token, label } of TOKENS) {
      calls.push({
        id: `release:Treasury:${token}`,
        title: `Treasury.releaseAll(${label})`,
        contract: "Treasury",
        data: treasury.interface.encodeFunctionData("releaseAll", [tokenAddress(d, token)]),
        // both calls stay in the batch until the Treasury runs the current build, even when a bucket is empty today
        done: async () =>
          (await isBuildOf(d, "Treasury", await implementationOf(d, "Treasury"))) &&
          !(await openBuckets(d, token)).some((b) => b.receivable),
      });
    }
  }
  if (extra.revoke) {
    const treasury = (await attachable(d, "Treasury"))!;
    const rewards = d.addr("Rewards")!;
    calls.push({
      id: "revoke:Treasury",
      title: `Treasury.revokeRole(RESERVE_SPENDER_ROLE, ${rewards})`,
      contract: "Treasury",
      data: treasury.interface.encodeFunctionData("revokeRole", [RESERVE_SPENDER_ROLE, rewards]),
      done: async () => !(await treasury.hasRole(RESERVE_SPENDER_ROLE, rewards)),
    });
  }
  if (extra.halves) {
    const staking = (await attachable(d, "Staking"))!;
    calls.push({
      id: "halves:Staking",
      title: `Staking.enablePoolHalves(${SMART_POOL})`,
      contract: "Staking",
      data: staking.interface.encodeFunctionData("enablePoolHalves", [SMART_POOL]),
      done: () => halvesOn(staking),
    });
  }
  return calls;
}

/** `recordSlotStakes` for the full cycles that were filled before the stakes were recorded (OPERATOR). */
async function slotCalls(d: Deployment, cycles: SlotCycle[]): Promise<Call[]> {
  const jump = (await attachable(d, "Jump"))!;
  return cycles
    .filter((c) => c.stakeIds.length === 4)
    .map((c) => ({
      id: `slots:${c.sponsor}:${c.cycleNo}`,
      title: `Jump.recordSlotStakes(${c.sponsor}, ${c.cycleNo}, [${c.stakeIds.join(", ")}])`,
      contract: "Jump" as ContractName,
      data: jump.interface.encodeFunctionData("recordSlotStakes", [c.sponsor, c.cycleNo, c.stakeIds]),
      done: async () => {
        try {
          return BigInt((await jump.slotStakesOf(c.sponsor, c.cycleNo))[0]) !== 0n;
        } catch {
          return false;
        }
      },
    }));
}

// --------------------------------------------------------------------------------------------- the run

/**
 * The upgrade of the live contracts to the current build, in one batch. Each proxy whose implementation is not the
 * build the compiler produces now is upgraded (PriceFeed is normally not), checked against the storage
 * layout the proxy runs now; Network links the new `NetworkFreeze` library and Staking a new `StakingMath`. In the same
 * batch, atomically and in this order:
 *
 *   Network.upgradeToAndCall(impl, initializeV3(TokenSale, Staking, LicenseSale, Rewards))   one hook role per caller
 *   TokenSale.upgradeToAndCall(impl, initializeV3(2 000e18, 20 000e18))                      the sell-back limits
 *   Staking, Rewards, Jump, LicenseSale, Treasury (PriceFeed)  .upgradeToAndCall(impl, 0x)
 *   Treasury.releaseAll(USDT), Treasury.releaseAll(BNB)                                      the old buckets leave at once
 *   Treasury.revokeRole(RESERVE_SPENDER_ROLE, Rewards)
 *   Staking.enablePoolHalves(1)                                                              Smart: two halves
 *
 * Before anything is sent the task reads the chain and refuses when a stake of Smart is open, when an initializer
 * would revert, or when a Jump cycle has slots the Jump could not claim (those are listed, and their
 * `recordSlotStakes` calls go to a second Safe file). Idempotent and resumable like the deploy engine: every step reads
 * the chain and what `record.upgrades` keeps. `dry-run` sends nothing; `run` signs with the connected account:
 *
 *  1. the libraries are deployed (contract creations, no state; anyone may);
 *  2. the implementations are deployed (`prepareUpgrade` checks each layout against the manifest);
 *  3. the sender holds the roles (before the hand-over) -> direct transactions; the Safe holds them -> a Safe batch
 *     file; a timelock holds them -> one timelock batch;
 *  4. the calls are read back, the state the upgrade must not touch is compared, `syncCapBase` brings the cap bases
 *     of the accounts in line, the record gets the libraries and the implementations (only now) and the ABIs.
 */
export async function runUpgradeRelease(d: Deployment, opts: ReleaseOptions = {}): Promise<UpgradeRecord> {
  const { log, hre } = d;
  if (!d.record.complete) throw new Error("The deployment is not complete: finish `task:deploy:all` first");
  for (const name of [...PROXIES, "StakingMath"] as const)
    if (!d.addr(name)) throw new Error(`${name} is missing from the record`);
  const sends = d.sends;
  const up = recordOf(d, RELEASE_UPGRADE_ID);
  const sender = d.signer ? await d.signer.getAddress() : d.deployer;
  log(`${sends ? "Upgrading" : "Dry-run of the upgrade of"} ${hre.network.name} (release ${RELEASE_UPGRADE_ID})`);
  log(`  sender          ${sender}`);
  for (const name of PROXIES) log(`  ${name.padEnd(15)} ${d.addr(name)} runs ${await implementationOf(d, name)}`);

  // ---- what is already the current build
  const libs = await recordedLibraries(d, up);
  // `unbuilt`: still runs an older build; `pending` also keeps the ones this upgrade deployed an implementation for
  const unbuilt = new Set<ReleaseProxy>();
  const pending = new Set<ReleaseProxy>();
  for (const name of PROXIES) {
    const built = await isBuild(d, name, await implementationOf(d, name), libs);
    if (!built) unbuilt.add(name);
    if (!built || up.implementations[name]) pending.add(name);
  }
  const pre = await preChecks(d, unbuilt, opts.allowOpenSmart);
  if (pre.problems.length > 0) {
    for (const p of pre.problems) log(`  PROBLEM ${p}`);
    if (sends) throw new Error(`The release cannot start:\n  ${pre.problems.join("\n  ")}`);
    log("WARNING a real run would refuse: see the problems above");
  }

  // ---- 0. the layouts, before anything is deployed: a proxy that cannot take the new build stops the run here
  d.pendingLibraries.NetworkFreeze = libs.NetworkFreeze ?? DRY_RUN_LIBRARY;
  for (const name of PROXIES) {
    if (!unbuilt.has(name)) continue;
    const options = { kind: "uups" as const, unsafeAllow: layoutAllowance(name) };
    if (name === "Staking")
      await hre.upgrades.validateUpgrade(
        d.addr(name)!,
        await stakingFactory(d, libs.StakingMath ?? DRY_RUN_LIBRARY),
        options,
      );
    else await validate(d, name);
    log(`[0/4] checked ${name}: the storage layout is compatible with ${await implementationOf(d, name)}`);
  }
  delete d.pendingLibraries.NetworkFreeze;

  // ---- 1. the libraries
  for (const name of LIBRARIES) {
    const tag = "[1/4]";
    const recorded = d.addr(name);
    const found = libs[name];
    if (found) {
      log(`${tag} skip   ${name} at ${found} is already the current build`);
      continue;
    }
    if (!sends) {
      log(`${tag} would  deploy the ${name} library (a contract creation, no state)`);
      libs[name] = DRY_RUN_LIBRARY;
      continue;
    }
    log(`${tag} sign   deploy the ${name} library (a contract creation, no proxy call)`);
    const factory = await hre.ethers.getContractFactory(ARTIFACT[name], d.signer);
    const instance = await factory.deploy();
    await instance.waitForDeployment();
    const tx = instance.deploymentTransaction();
    const receipt = await tx?.wait();
    if (!tx || !receipt) throw new Error(`${name}: no deployment receipt`);
    d.sent += 1;
    d.txHashes.push(tx.hash);
    d.lastBlock = receipt.blockNumber;
    const address = getAddress(await instance.getAddress());
    await d.settle();
    up.implementations[name] = {
      previous: up.implementations[name]?.previous ?? recorded ?? ZeroAddress,
      current: address,
      txHash: tx.hash,
      deployBlock: receipt.blockNumber,
    } satisfies UpgradedImplementation;
    libs[name] = address;
    d.save();
    log(`${tag} done   ${name} ${address}`);
    if (opts.stopAfter === `impl:${name}`) return stop(d, up);
  }
  if (libs.NetworkFreeze) d.pendingLibraries.NetworkFreeze = libs.NetworkFreeze;

  // ---- 2. the implementations
  const impls: Partial<Record<ReleaseProxy, string>> = {};
  for (const name of PROXIES) {
    if (!pending.has(name)) continue;
    const tag = "[2/4]";
    const known = up.implementations[name];
    const now = await implementationOf(d, name);
    if (
      known &&
      (await hre.ethers.provider.getCode(known.current)) !== "0x" &&
      (await isBuild(d, name, known.current, libs))
    ) {
      impls[name] = known.current;
      log(`${tag} skip   deploy the ${name} implementation (recorded ${known.current})`);
      continue;
    }
    if (await isBuild(d, name, now, libs)) {
      impls[name] = now;
      up.implementations[name] = { previous: known?.previous ?? now, current: now };
      log(`${tag} skip   ${name} already runs this build (${now})`);
      continue;
    }
    const options = { kind: "uups" as const, unsafeAllow: layoutAllowance(name) };
    if (!sends) {
      log(`${tag} would  deploy the ${name} implementation (a contract creation, no proxy call yet)`);
      impls[name] = ZeroAddress;
      continue;
    }
    log(`${tag} sign   deploy the ${name} implementation (a contract creation, no proxy call yet)`);
    const factory = name === "Staking" ? await stakingFactory(d, libs.StakingMath!) : await factoryOf(d, name);
    impls[name] = getAddress(
      (await hre.upgrades.prepareUpgrade(d.addr(name)!, factory, { ...options, timeout: 0 })) as string,
    );
    await d.settle();
    up.implementations[name] = {
      previous: known?.previous ?? now,
      current: impls[name]!,
    } satisfies UpgradedImplementation;
    d.save();
    log(`${tag} done   ${name} implementation ${impls[name]}`);
    if (opts.stopAfter === `impl:${name}`) return stop(d, up);
  }

  // ---- 3. the route and the calls
  const staking = (await attachable(d, "Staking"))!;
  const treasury = (await attachable(d, "Treasury"))!;
  const rewards = d.addr("Rewards")!;
  const knownCalls = new Set([...(up.safe?.calls ?? [])]);
  const calls = await buildCalls(d, impls, {
    revoke: knownCalls.has("revoke:Treasury") || (await treasury.hasRole(RESERVE_SPENDER_ROLE, rewards)),
    halves: knownCalls.has("halves:Staking") || !(await halvesOn(staking)),
    release:
      impls.Treasury !== undefined ||
      knownCalls.has("release:Treasury:USDT") ||
      (await Promise.all(TOKENS.map((t) => openBuckets(d, t.id)))).some((rows) => rows.some((b) => b.receivable)),
  });
  const todo: Call[] = [];
  for (const c of calls) if (!(await c.done())) todo.push(c);
  const route = await routeOf(d, todo);
  log(
    `route: ${route.via}${isTimelockRoute(route) ? ` (delay ${await timelockDelay(d)} s)` : ""}; ${todo.length} of ${
      calls.length
    } call(s) to do`,
  );
  for (const c of calls) log(`  ${todo.includes(c) ? "todo" : "done"}  ${c.title}`);
  if (route.problems.length > 0 && todo.length > 0) {
    for (const p of route.problems) log(`  PROBLEM ${p}`);
    if (sends) throw new Error(`The sender cannot send the upgrade:\n  ${route.problems.join("\n  ")}`);
  }
  const slots = await slotCalls(d, pre.recording);
  const slotsTodo: Call[] = [];
  for (const c of slots) if (!(await c.done())) slotsTodo.push(c);
  if (!sends) {
    printSigning(d, calls, slots, route);
    log("Dry-run done: nothing was sent.");
    return up;
  }

  const at = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
  // With --allow-open-smart the open stakes of Smart change their accrual when the pool goes to the two-halves
  // schedule: that one value is left out of the comparison for them (and printed), everything else is still compared.
  const scheduleBound = new Set<number>(
    opts.allowOpenSmart && todo.length > 0
      ? openStakesOfPool(await readStakes(staking), SMART_POOL).map((s) => s.id)
      : [],
  );
  const before =
    todo.length > 0 ? { staking: await stateOf(staking, at, scheduleBound), wiring: await wiringOf(d) } : undefined;
  if (todo.length > 0) up.via = route.via;
  // the slot stakes are recorded by an OPERATOR of the Jump: the sender when it is one, else the Safe, through a second
  // file written together with the first so that the owners get both at once
  const jump = (await attachable(d, "Jump"))!;
  const senderRecords = await jump.hasRole(OPERATOR_ROLE, sender);
  if (slotsTodo.length > 0 && !senderRecords && (await jump.hasRole(OPERATOR_ROLE, getAddress(d.params.multisig))))
    up.followUp = await writeSafeBatch(d, {
      fileId: `${RELEASE_UPGRADE_ID}-slot-stakes`,
      title: `Vexaro ${RELEASE_UPGRADE_ID} slot stakes of Jump (${hre.network.name}): run after the upgrade`,
      calls: slotsTodo,
      previous: up.followUp,
    });
  if (todo.length > 0) {
    if (!(await runVia(d, up, route, todo, { stopAfter: opts.stopAfter, wait: opts.wait }))) return up;
  }
  await opts.afterCalls?.();

  // ---- 4. verify the calls and the state, bring the cap bases in line, record
  for (const c of calls)
    if (!(await c.done())) throw new Error(`${c.id}: the transaction went through but the state does not match`);
  if (before) {
    const after = { staking: await stateOf(staking, at, scheduleBound), wiring: await wiringOf(d) };
    for (const part of ["staking", "wiring"] as const)
      for (const key of Object.keys(before[part])) {
        if (part === "staking" && key.endsWith(SCHEDULE_KEY)) {
          log(
            `  INFO ${key.slice(0, -SCHEDULE_KEY.length)} (open, pool ${SMART_POOL}): accrual at the block time ${
              before.staking[key]
            } -> ${after.staking[key]} (the two-halves schedule, --allow-open-smart)`,
          );
          continue;
        }
        if (before[part][key] !== after[part][key])
          throw new Error(`${part} ${key} changed by the upgrade: ${before[part][key]} -> ${after[part][key]}`);
      }
    log(
      "the Staking configuration, pools and stakes, and the wiring and settings of the other contracts are unchanged",
    );
  }
  const effects = (await effectRows(d)).filter((r) => r.status === "DRIFT");
  if (effects.length > 0)
    throw new Error(
      `The upgrade went through but its effects are not in place:\n  ${effects.map((r) => r.item).join("\n  ")}`,
    );
  await syncBases(d, staking, (await attachable(d, "Network"))!, "[sync]");

  if (slotsTodo.length > 0) {
    if (senderRecords) {
      log(`recording the slot stakes of ${slotsTodo.length} Jump cycle(s) as ${sender}`);
      await runDirect(d, up, slotsTodo, {});
    } else if (up.followUp)
      log(
        `WARNING ${slotsTodo.length} Jump cycle(s) wait for the second Safe file (${up.followUp.file}): execute it now`,
      );
    else
      log(
        `WARNING ${slotsTodo.length} Jump cycle(s) need Jump.recordSlotStakes by an OPERATOR; ${sender} is not one: ` +
          slotsTodo.map((c) => c.title).join("; "),
      );
  }

  // record: the libraries, the implementations, the ABIs
  for (const name of PROXIES) {
    const impl = impls[name];
    if (impl === undefined) continue;
    const c = d.record.contracts[name]!;
    if (c.implementation !== getAddress(impl)) delete c.verified;
    c.implementation = getAddress(impl);
  }
  for (const name of LIBRARIES) {
    const lib = up.implementations[name];
    const address = libs[name];
    if (!address) continue;
    const entry = d.record.contracts[name];
    if (!entry) {
      d.record.contracts[name] = {
        address,
        deployBlock: lib?.deployBlock ?? 0,
        ...(lib?.txHash ? { txHash: lib.txHash } : {}),
      };
    } else if (getAddress(entry.address) !== address) {
      delete entry.verified;
      entry.address = address;
      if (lib?.deployBlock !== undefined) entry.deployBlock = lib.deployBlock;
      if (lib?.txHash !== undefined) entry.txHash = lib.txHash;
    }
    if (d.dir) d.record.contracts[name]!.abi = await exportAbi(hre, d.dir, name, ARTIFACT[name]);
  }
  if (d.dir)
    for (const name of PROXIES)
      if (impls[name] !== undefined) d.record.contracts[name]!.abi = await exportAbi(hre, d.dir, name, ARTIFACT[name]);
  up.completedAt = new Date().toISOString();
  up.block = await hre.ethers.provider.getBlockNumber();
  d.save();
  log(
    `Release upgrade complete (${route.via}): ${PROXIES.filter((n) => impls[n] !== undefined)
      .map((n) => `${n} ${impls[n]}`)
      .join(", ")}; run task:deploy:verify for them, then --check`,
  );
  return up;
}

function stop(d: Deployment, up: UpgradeRecord): UpgradeRecord {
  d.save();
  d.log("Stopped (--stop-after); run again to resume.");
  return up;
}

/** Everything the dry-run shows the person who will sign. */
function printSigning(d: Deployment, calls: Call[], slots: Call[], route: Route): void {
  const { log } = d;
  log("What is signed:");
  log("  by the account that deploys (the Ledger; no role is needed, it only creates contracts):");
  log("    the libraries NetworkFreeze and StakingMath and the implementations of the changed proxies");
  log(
    `  the batch, ${
      route.via === "safe"
        ? "one Safe batch file, signed by the owners"
        : route.via === "safe-timelock"
          ? "two Safe batch files (schedule, then execute after the timelock delay), signed by the owners"
          : `through the ${route.via} route`
    }:`,
  );
  for (const [i, c] of calls.entries())
    log(`    call ${i + 1}  to ${d.addr(c.contract)}  ${c.title}   calldata ${c.data}`);
  if (slots.length > 0) {
    log("  then, in a second Safe file (the Safe is OPERATOR of the Jump):");
    for (const c of slots) log(`    ${c.title}`);
  }
  log("  after it: Staking.syncCapBase for accounts whose cap base is stale (any account, no role; none expected)");
  log("  the record gets the libraries and the implementations only once the calls are seen on chain");
}

// --------------------------------------------------------------------------------------------- the check

/** The effects of the two initializers and of the calls in the batch, read from the contracts. */
export async function effectRows(d: Deployment): Promise<ReleaseRow[]> {
  const rows: ReleaseRow[] = [];
  const row = (status: ReleaseRow["status"], item: string, want: string, have: string) =>
    rows.push({ status, item, want, have });
  const network = (await attachable(d, "Network"))!;
  const callers: [string, ContractName][] = [
    ["REGISTRAR_ROLE", "TokenSale"],
    ["REGISTRAR_ROLE", "Staking"],
    ["REGISTRAR_ROLE", "LicenseSale"],
    ["STAKING_HOOK_ROLE", "Staking"],
    ["LICENSE_HOOK_ROLE", "LicenseSale"],
    ["WITHDRAWAL_HOOK_ROLE", "Rewards"],
  ];
  for (const [role, name] of callers) {
    let have = "unreadable";
    try {
      have = String(await network.hasRole(id(role), d.addr(name)!));
    } catch {
      // the check goes on
    }
    row(have === "true" ? "OK" : "DRIFT", `${name} holds Network.${role}`, "true", have);
  }
  for (const name of ["TokenSale", "Staking", "LicenseSale", "Rewards"] as const) {
    const old = String(await network.hasRole(HOOK_ROLE, d.addr(name)!));
    row(old === "false" ? "OK" : "DRIFT", `${name} no longer holds the old Network.HOOK_ROLE`, "false", old);
  }
  row(
    "INFO",
    "Network initializer version",
    ">= 3 after the upgrade",
    String(await initializedVersion(d, d.addr("Network")!)),
  );

  const sale = (await attachable(d, "TokenSale"))!;
  try {
    const limits = await sale.sellLimits(ZeroAddress);
    const ok = BigInt(limits.accountCap) > 0n && BigInt(limits.globalCap) > 0n;
    row(
      ok ? "OK" : "DRIFT",
      "TokenSale sell-back limits are set (initializeV3; 0 turns the sell-back off)",
      `${SELL_ACCOUNT_CAP_USDT} / ${SELL_GLOBAL_CAP_USDT} at the upgrade`,
      `${limits.accountCap} / ${limits.globalCap}`,
    );
  } catch {
    row("DRIFT", "TokenSale sell-back limits are set (initializeV3)", "readable", "unreadable (an older TokenSale)");
  }
  row(
    "INFO",
    "TokenSale initializer version",
    ">= 3 after the upgrade",
    String(await initializedVersion(d, d.addr("TokenSale")!)),
  );

  const staking = (await attachable(d, "Staking"))!;
  const halves = await halvesOn(staking);
  row(
    halves ? "OK" : "DRIFT",
    `Staking.poolHalves(${SMART_POOL}) (Smart on the two-halves schedule)`,
    "true",
    String(halves),
  );

  const treasury = (await attachable(d, "Treasury"))!;
  const spender = String(await treasury.hasRole(RESERVE_SPENDER_ROLE, d.addr("Rewards")!));
  row(spender === "false" ? "OK" : "DRIFT", "Rewards holds no Treasury.RESERVE_SPENDER_ROLE", "false", spender);

  // the wallets' shares leave with each payment: after the batch no registered wallet has anything left in a bucket,
  // except one that cannot receive (named; its bucket stays until it can)
  for (const { id: token, label } of TOKENS) {
    const open = await openBuckets(d, token);
    const have =
      open.length === 0
        ? "0 in every bucket"
        : open.map((b) => `${b.wallet} ${b.amount}${b.receivable ? "" : " (cannot receive)"}`).join(", ");
    row(
      open.length === 0 ? "OK" : open.some((b) => b.receivable) ? "DRIFT" : "INFO",
      `Treasury: the buckets of the registered wallets in ${label} are empty (releaseAll)`,
      "0 in every bucket",
      have,
    );
  }
  return rows;
}

/**
 * Read-only status of the upgrade (`task:upgrade:release --check`): every proxy runs the current build and the record
 * names it, the libraries are linked as recorded, the initializers and the batch had their effects, the Jump cycles
 * from before the upgrade are recorded, every cap base is in line, every runtime fits EIP-170.
 */
export async function releaseRows(d: Deployment): Promise<ReleaseRow[]> {
  const rows: ReleaseRow[] = [];
  const row = (status: ReleaseRow["status"], item: string, want: string, have: string) =>
    rows.push({ status, item, want, have });
  // the libraries of the record
  const libs: Partial<Record<Library, string>> = {};
  for (const name of LIBRARIES) {
    const address = d.addr(name);
    const build = address ? await isLibraryBuild(d, name, address) : false;
    if (build) libs[name] = getAddress(address!);
    row(
      build ? "OK" : "DRIFT",
      `${name} at the record is the current build`,
      "current build",
      address ? (build ? `current build ${address}` : `older build ${address}`) : "not in the record",
    );
  }
  for (const name of PROXIES) {
    const now = await implementationOf(d, name);
    const build = await isBuild(d, name, now, libs);
    row(
      build ? "OK" : "DRIFT",
      `${name} implementation is the current build`,
      "current build",
      build ? `current build ${now}` : `older build ${now}`,
    );
    const recorded = d.record.contracts[name]?.implementation;
    const same = recorded !== undefined && getAddress(recorded) === now;
    row(same ? "OK" : "DRIFT", `${name} implementation equals the record`, recorded ?? "recorded", now);
  }
  try {
    rows.push(...(await effectRows(d)));
  } catch (e) {
    row("DRIFT", "the effects of the upgrade are readable", "readable", e instanceof Error ? e.message : String(e));
  }

  // Jump cycles filled before the stakes were recorded
  try {
    const cycles = await scanJump(d, await readStakes((await attachable(d, "Staking"))!));
    const need = needingRecord(cycles);
    row(
      need.length === 0 ? "OK" : "DRIFT",
      "Jump: every full, unclaimed cycle has its four slot stakes recorded (recordSlotStakes)",
      "0 cycles",
      need.length === 0 ? "0 cycles" : need.map((c) => `${c.sponsor} cycle ${c.cycleNo}`).join(", "),
    );
    const partial = partialCycles(cycles);
    row("INFO", "Jump: cycles with some slots filled before the upgrade", "-", String(partial.length));
  } catch (e) {
    row("DRIFT", "Jump cycles are readable", "readable", e instanceof Error ? e.message : String(e));
  }
  try {
    const seen = await survey((await attachable(d, "Staking"))!, (await attachable(d, "Network"))!);
    row(
      seen.stale.length === 0 ? "OK" : "DRIFT",
      "every Network cap base is the principal of the account's largest open USER / AIRDROP stake",
      "0 stale",
      `${seen.stale.length} stale of ${seen.owners} account(s)`,
    );
  } catch (e) {
    row("DRIFT", "the cap bases are readable", "readable", e instanceof Error ? e.message : String(e));
  }

  for (const name of [...LIBRARIES, ...PROXIES] as (Library | ReleaseProxy)[]) {
    const { deployedBytecode } = await d.hre.artifacts.readArtifact(ARTIFACT[name]);
    const size = (deployedBytecode.length - 2) / 2;
    row(
      size <= MAX_RUNTIME ? "OK" : "DRIFT",
      `${name} runtime fits EIP-170 (24 576 bytes)`,
      `<= ${MAX_RUNTIME}`,
      `${size}`,
    );
  }
  return rows;
}
