import { type Contract, ZeroAddress, getAddress, id } from "ethers";

import { ARTIFACT, DEFAULT_ADMIN_ROLE, type Deployment } from "./context";
import { exportAbi } from "./record";
import { expectedHolders, phaseOf } from "./roles";
import type { UpgradeRecord, UpgradedImplementation } from "./types";
import {
  type Call,
  type Route,
  STAKING_UPGRADE_ID,
  attachable,
  implementationOf,
  isTimelockRoute,
  recordOf,
  runVia,
  safeRoute,
  timelockDelay,
} from "./upgradeCore";

const UPGRADER_ROLE = id("UPGRADER_ROLE");
const PROPOSER_ROLE = id("PROPOSER_ROLE");
const EXECUTOR_ROLE = id("EXECUTOR_ROLE");
export const AIRDROP_RELEASER_ROLE = id("AIRDROP_RELEASER_ROLE");
const SOURCE_AIRDROP = 2n;
const STATE_OPEN = 1n;
/** Stakes read per run (the ids are 1..n without a gap; mainnet has a few). */
const MAX_STAKES = 5000;

export interface StakingUpgradeOptions {
  /** Stop after this step id (`impl:StakingMath`, `impl:Staking`, `upgrade:Staking`, `schedule`); the next run resumes. */
  stopAfter?: string;
  /** Timelock path: keep polling until the operation is ready and execute it. */
  wait?: boolean;
  /** Test seam: runs once the calls are confirmed, before the state is compared (to prove the comparison has teeth). */
  afterCalls?: () => Promise<void>;
}

// --------------------------------------------------------------------------------------------- builds

/** The Staking runtime the compiler produces with `library` linked in (the UUPS `__self` immutable stays blank). */
async function linkedStakingCode(d: Deployment, library: string): Promise<string> {
  const art = await d.hre.artifacts.readArtifact(ARTIFACT.Staking);
  let hex = art.deployedBytecode.slice(2).toLowerCase();
  const lib = library.slice(2).toLowerCase();
  for (const libs of Object.values(art.deployedLinkReferences))
    for (const refs of Object.values(libs))
      for (const r of refs) hex = hex.slice(0, r.start * 2) + lib + hex.slice((r.start + r.length) * 2);
  return "0x" + hex;
}

/** True when `address` holds the Staking runtime the compiler produces now, linked to `library`. */
export async function isStakingBuild(d: Deployment, address: string, library: string): Promise<boolean> {
  const code = (await d.hre.ethers.provider.getCode(address)).toLowerCase();
  const self = "0".repeat(24) + address.toLowerCase().slice(2);
  return code.split(self).join("0".repeat(64)) === (await linkedStakingCode(d, library));
}

/** True when `address` holds the StakingMath runtime the compiler produces now (it embeds its own address, 20 bytes). */
export async function isLibraryBuild(d: Deployment, address: string): Promise<boolean> {
  const { deployedBytecode } = await d.hre.artifacts.readArtifact(ARTIFACT.StakingMath);
  const code = (await d.hre.ethers.provider.getCode(address)).toLowerCase();
  return code.split(address.slice(2).toLowerCase()).join("0".repeat(40)) === deployedBytecode.toLowerCase();
}

/** The StakingMath address a Staking implementation is linked to (read from its code), undefined when it has none. */
export async function libraryOf(d: Deployment, implementation: string): Promise<string | undefined> {
  const art = await d.hre.artifacts.readArtifact(ARTIFACT.Staking);
  const code = (await d.hre.ethers.provider.getCode(implementation)).toLowerCase();
  for (const libs of Object.values(art.deployedLinkReferences))
    for (const refs of Object.values(libs)) {
      const r = refs[0];
      if (r) return getAddress("0x" + code.slice(2 + r.start * 2, 2 + (r.start + r.length) * 2));
    }
  return undefined;
}

export async function stakingFactory(d: Deployment, library: string) {
  const signer = d.signer ?? (await d.hre.ethers.getSigners())[0];
  return d.hre.ethers.getContractFactory(ARTIFACT.Staking, { signer, libraries: { StakingMath: library } });
}

// --------------------------------------------------------------------------------------------- state

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export interface HeldStakes {
  /** Open AIRDROP stakes and whether each is on hold. */
  open: { id: bigint; owner: string; principal: bigint; held: boolean | undefined }[];
  /** Stakes read (every id 1..n). */
  total: number;
}

/** Every stake id 1..n (the first id without a state ends the list). */
export async function stakeIds(staking: Contract): Promise<number> {
  let n = 0;
  while (n < MAX_STAKES) {
    const v = await staking.stakeView(n + 1);
    if (BigInt(v.state) === 0n) break;
    n++;
  }
  return n;
}

/** The open AIRDROP stakes and (on a Staking with the hold) whether they are on hold. */
export async function airdropStakes(staking: Contract): Promise<HeldStakes> {
  const n = await stakeIds(staking);
  const open: HeldStakes["open"] = [];
  const hasHold = (() => {
    try {
      staking.interface.getFunction("isStakeHeld");
      return true;
    } catch {
      return false;
    }
  })();
  for (let i = 1; i <= n; i++) {
    const v = await staking.stakeView(i);
    if (BigInt(v.source) !== SOURCE_AIRDROP || BigInt(v.state) !== STATE_OPEN) continue;
    let held: boolean | undefined;
    if (hasHold) {
      try {
        held = (await staking.isStakeHeld(i)) as boolean;
      } catch {
        held = undefined;
      }
    }
    open.push({ id: BigInt(i), owner: v.owner, principal: BigInt(v.principal), held });
  }
  return { open, total: n };
}

/** Suffix of the key that holds the schedule-dependent accrual of a stake in `stateOf`. */
export const SCHEDULE_KEY = ":accrual";

/**
 * What the upgrade must leave as it is, read at the block timestamp `at` so that nothing depends on the clock: the
 * configuration, the pools, every stake (static fields and the accrual projected to `at`) and the sums of its owner.
 * `incomeOf` is not compared: the income of a held AIRDROP stake leaves it by design (it is `heldIncomeOf`).
 * For the ids in `scheduleBound` the accrual is not part of the stake's entry but of its own key
 * (`stake<id>` + `SCHEDULE_KEY`), so that a caller can leave exactly that value out of a comparison.
 */
export async function stateOf(
  staking: Contract,
  at: bigint,
  scheduleBound: ReadonlySet<number> = new Set(),
): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    vex: await staking.vex(),
    network: await staking.network(),
    priceFeed: await staking.priceFeed(),
    rewardVault: await staking.rewardVault(),
    jump: await staking.jump(),
    totalPrincipal: String(await staking.totalPrincipal()),
    refundCapUsdt: String(await staking.refundCapUsdt()),
    pausedFlags: String(await staking.pausedFlags()),
  };
  const pools = Number(await staking.poolCount());
  out.poolCount = String(pools);
  for (let p = 1; p <= pools; p++) {
    const info = await staking.pool(p);
    out[`pool${p}`] = json(info);
    for (let v = 1; v <= Number(info.versionCount); v++) out[`pool${p}v${v}`] = json(await staking.poolVersion(p, v));
  }
  const owners = new Set<string>();
  const n = await stakeIds(staking);
  for (let i = 1; i <= n; i++) {
    const v = await staking.stakeView(i);
    owners.add(v.owner);
    const accrual = BigInt(v.state) === STATE_OPEN ? await staking.accruedAt(i, at) : v.accrued;
    if (scheduleBound.has(i)) out[`stake${i}${SCHEDULE_KEY}`] = String(accrual);
    out[`stake${i}`] = json([
      v.owner,
      v.poolId,
      v.version,
      v.source,
      v.state,
      v.openedAt,
      v.principal,
      v.entryUsdt,
      v.maturesAt,
      v.earlyCloseFrom,
      v.closedAt,
      v.vestClaimed,
      ...(scheduleBound.has(i) ? [] : [accrual]),
    ]);
  }
  out.stakes = String(n);
  for (const o of owners) out[`owner${o}`] = json([await staking.openStakesOf(o)]);
  return out;
}

// --------------------------------------------------------------------------------------------- who sends what

/** Who must hold AIRDROP_RELEASER_ROLE after the upgrade: the deployer before the hand-over, the multisig after. */
function releasers(d: Deployment): string[] {
  return [...expectedHolders(d, "Staking", "AIRDROP_RELEASER_ROLE", phaseOf(d)).required];
}

/** Direct when the sender holds UPGRADER_ROLE and DEFAULT_ADMIN_ROLE on the Staking, the timelock otherwise. */
async function routeOf(d: Deployment): Promise<Route> {
  const who = d.signer ? await d.signer.getAddress() : d.deployer;
  const staking = await attachable(d, "Staking");
  if ((await staking.hasRole(UPGRADER_ROLE, who)) && (await staking.hasRole(DEFAULT_ADMIN_ROLE, who)))
    return { via: "direct", problems: [] };
  const viaSafe = await safeRoute(d, [["Staking", [UPGRADER_ROLE, DEFAULT_ADMIN_ROLE]]]);
  if (viaSafe) return viaSafe;

  const problems: string[] = [];
  const timelockAddress = d.record.contracts.TimelockController?.address;
  if (!timelockAddress) {
    problems.push(
      `${who} lacks Staking.UPGRADER_ROLE / DEFAULT_ADMIN_ROLE and there is no TimelockController in the record (nor does the Safe hold them)`,
    );
    return { via: "timelock", problems };
  }
  const timelock = await attachable(d, "TimelockController");
  for (const [name, role] of [
    ["UPGRADER_ROLE", UPGRADER_ROLE],
    ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
  ] as const)
    if (!(await staking.hasRole(role, timelockAddress))) problems.push(`the timelock lacks Staking.${name}`);
  if (!(await timelock.hasRole(PROPOSER_ROLE, who))) problems.push(`${who} is not a proposer of the timelock`);
  if (!(await timelock.hasRole(EXECUTOR_ROLE, who))) problems.push(`${who} is not an executor of the timelock`);
  return { via: "timelock", problems };
}

/** The upgrade call and the grant(s) of the new role, in the order they must land. */
async function buildCalls(d: Deployment, implementation: string): Promise<Call[]> {
  const staking = await attachable(d, "Staking");
  const calls: Call[] = [
    {
      id: "upgrade:Staking",
      title: `Staking.upgradeToAndCall(${
        implementation === ZeroAddress ? "<new implementation>" : implementation
      }, no call)`,
      contract: "Staking",
      data: staking.interface.encodeFunctionData("upgradeToAndCall", [implementation, "0x"]),
      done: async () => (await implementationOf(d, "Staking")) === getAddress(implementation),
    },
  ];
  for (const who of releasers(d))
    calls.push({
      id: `grant:Staking.AIRDROP_RELEASER->${who}`,
      title: `Staking.grantRole(AIRDROP_RELEASER_ROLE, ${who})`,
      contract: "Staking",
      data: staking.interface.encodeFunctionData("grantRole", [AIRDROP_RELEASER_ROLE, who]),
      done: async () => staking.hasRole(AIRDROP_RELEASER_ROLE, who),
    });
  return calls;
}

// --------------------------------------------------------------------------------------------- the run

/**
 * The airdrop hold. The Staking proxy is upgraded to the new implementation (it links a
 * new StakingMath library: the income of a held AIRDROP stake is left out of `incomeOf` there) and the admin console
 * gets AIRDROP_RELEASER_ROLE. No initializer, one new storage member at the end of the Staking namespace; every
 * existing AIRDROP stake is held from the upgrade on (the default of the release mark is 0). Idempotent and resumable
 * like the deploy engine: every step reads the chain and what is recorded in `record.upgrades` (the new library and
 * implementation, the timelock operation) is reused. `dry-run` sends nothing (it checks the storage layout against
 * the implementation the proxy runs and prints what each path would sign); `run` signs with the connected account.
 *
 *  1. the StakingMath library is deployed (a contract creation, no state);
 *  2. the Staking implementation is deployed linked to it (`prepareUpgrade` checks the layout against the manifest);
 *  3. the sender holds Staking.UPGRADER_ROLE and DEFAULT_ADMIN_ROLE (before the hand-over) -> direct `upgradeToAndCall`
 *     and `grantRole`; otherwise the same calls as one timelock batch (schedule, wait the delay, execute);
 *  4. the record gets the library and the implementation (only after the calls are confirmed) and the ABIs of Staking
 *     and StakingMath are written again.
 */
export async function runUpgradeStaking(d: Deployment, opts: StakingUpgradeOptions = {}): Promise<UpgradeRecord> {
  const { log, hre } = d;
  if (!d.record.complete) throw new Error("The deployment is not complete: finish `task:deploy:all` first");
  for (const name of ["Staking", "StakingMath"] as const)
    if (!d.addr(name)) throw new Error(`${name} is missing from the record`);
  const sends = d.sends;
  const up = recordOf(d, STAKING_UPGRADE_ID);
  const sender = d.signer ? await d.signer.getAddress() : d.deployer;
  const proxy = d.addr("Staking")!;
  const current = await implementationOf(d, "Staking");
  const staking = await attachable(d, "Staking");
  const linked = await libraryOf(d, current);
  if (up.completedAt && !(linked && (await isStakingBuild(d, current, linked)))) {
    // this upgrade ran before; the compiled Staking is a later build, which this task must not swap in
    log(`Staking upgrade was completed at ${up.completedAt}: nothing to do`);
    return up;
  }
  log(`${sends ? "Upgrading" : "Dry-run of the upgrade of"} ${hre.network.name} (staking: airdrop hold)`);
  log(`  sender          ${sender}`);
  log(`  Staking proxy   ${proxy}`);
  log(`  runs now        ${current}`);
  log(`  StakingMath     ${d.addr("StakingMath")} (linked now: ${(await libraryOf(d, current)) ?? "none"})`);

  // ---- 1. the library
  const recordedLib = getAddress(d.addr("StakingMath")!);
  const knownLib = up.implementations.StakingMath;
  let library: string;
  if (
    knownLib &&
    (await hre.ethers.provider.getCode(knownLib.current)) !== "0x" &&
    (await isLibraryBuild(d, knownLib.current))
  ) {
    library = getAddress(knownLib.current);
    log(`[1/3] skip   deploy StakingMath (recorded ${library})`);
  } else if (await isLibraryBuild(d, recordedLib)) {
    library = recordedLib;
    up.implementations.StakingMath = { previous: knownLib?.previous ?? recordedLib, current: recordedLib };
    log(`[1/3] skip   StakingMath at ${recordedLib} is already this build`);
  } else if (!sends) {
    library = recordedLib; // only to check the layout below
    log(`[1/3] would  deploy the StakingMath library (a contract creation, no state)`);
  } else {
    log(`[1/3] sign   deploy the StakingMath library (a contract creation, no proxy call)`);
    const factory = await hre.ethers.getContractFactory(ARTIFACT.StakingMath, d.signer);
    const instance = await factory.deploy();
    await instance.waitForDeployment();
    const tx = instance.deploymentTransaction();
    const receipt = await tx?.wait();
    if (!tx || !receipt) throw new Error("StakingMath: no deployment receipt");
    d.sent += 1;
    d.txHashes.push(tx.hash);
    d.lastBlock = receipt.blockNumber;
    library = getAddress(await instance.getAddress());
    await d.settle();
    up.implementations.StakingMath = {
      previous: knownLib?.previous ?? recordedLib,
      current: library,
      txHash: tx.hash,
      deployBlock: receipt.blockNumber,
    } satisfies UpgradedImplementation;
    d.save();
    log(`[1/3] done   StakingMath ${library}`);
    if (opts.stopAfter === "impl:StakingMath") return stop(d, up);
  }

  // ---- 2. the implementation, linked to it
  const known = up.implementations.Staking;
  let implementation: string;
  if (
    known &&
    (await hre.ethers.provider.getCode(known.current)) !== "0x" &&
    (await isStakingBuild(d, known.current, library))
  ) {
    implementation = known.current;
    log(`[2/3] skip   deploy the Staking implementation (recorded ${implementation})`);
  } else if (await isStakingBuild(d, current, library)) {
    implementation = current;
    up.implementations.Staking = { previous: known?.previous ?? current, current };
    log(`[2/3] skip   Staking already runs this build (${current})`);
  } else {
    const factory = await stakingFactory(d, library);
    const options = { kind: "uups" as const, unsafeAllow: ["external-library-linking" as const] };
    await hre.upgrades.validateUpgrade(proxy, factory, options);
    if (!sends) {
      log(`[2/3] would  deploy the Staking implementation (storage layout checked against ${current}: compatible)`);
      implementation = ZeroAddress;
    } else {
      log(`[2/3] sign   deploy the Staking implementation (a contract creation, no proxy call yet)`);
      implementation = getAddress(
        (await hre.upgrades.prepareUpgrade(proxy, factory, { ...options, timeout: 0 })) as string,
      );
      await d.settle();
      up.implementations.Staking = {
        previous: known?.previous ?? current,
        current: implementation,
      } satisfies UpgradedImplementation;
      d.save();
      log(`[2/3] done   Staking implementation ${implementation}`);
      if (opts.stopAfter === "impl:Staking") return stop(d, up);
    }
  }

  // ---- 3. the route and the calls
  const route = await routeOf(d);
  const calls = await buildCalls(d, implementation);
  const pending: Call[] = [];
  for (const c of calls) if (!(await c.done())) pending.push(c);
  log(
    `route: ${route.via}${isTimelockRoute(route) ? ` (delay ${await timelockDelay(d)} s)` : ""}; ${pending.length} of ${
      calls.length
    } call(s) to do`,
  );
  for (const c of calls) log(`  ${pending.includes(c) ? "todo" : "done"}  ${c.title}`);
  if (route.problems.length > 0 && pending.length > 0) {
    for (const p of route.problems) log(`  PROBLEM ${p}`);
    if (sends) throw new Error(`The sender cannot send the upgrade:\n  ${route.problems.join("\n  ")}`);
  }
  const airdrop = await airdropStakes(staking);
  log(
    `${airdrop.open.length} open AIRDROP stake(s) of ${airdrop.total} (${airdrop.open
      .reduce((sum, s) => sum + s.principal, 0n)
      .toString()} VEX wei): on hold from the upgrade on`,
  );
  if (!sends) {
    printSigning(d, proxy, implementation, calls, route);
    log("Dry-run done: nothing was sent.");
    return up;
  }

  const at = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
  const before = pending.length > 0 ? await stateOf(staking, at) : undefined;
  up.via = route.via;
  if (pending.length > 0) {
    if (!(await runVia(d, up, route, pending, { stopAfter: opts.stopAfter, wait: opts.wait }))) return up;
  }
  await opts.afterCalls?.();

  // ---- 4. verify and record (only now: the calls are confirmed)
  for (const c of calls)
    if (!(await c.done())) throw new Error(`${c.id}: the transaction went through but the state does not match`);
  if (before) {
    const after = await stateOf(staking, at);
    for (const key of Object.keys(before))
      if (before[key] !== after[key])
        throw new Error(`Staking ${key} changed by the upgrade: ${before[key]} -> ${after[key]}`);
  }
  if (before) {
    // right after the upgrade nothing is released yet: every AIRDROP stake that was open is on hold
    const held = await airdropStakes(staking);
    for (const s of held.open)
      if (s.held !== true) throw new Error(`AIRDROP stake ${s.id} of ${s.owner} is not on hold after the upgrade`);
    log(`${held.open.length} open AIRDROP stake(s) are on hold; the pools and ${held.total} stake(s) are unchanged`);
  }

  const s = d.record.contracts.Staking!;
  if (s.implementation !== getAddress(implementation)) delete s.verified;
  s.implementation = getAddress(implementation);
  const m = d.record.contracts.StakingMath!;
  const lib = up.implementations.StakingMath;
  if (getAddress(m.address) !== library) {
    delete m.verified;
    m.address = library;
    if (lib?.deployBlock !== undefined) m.deployBlock = lib.deployBlock;
    if (lib?.txHash !== undefined) m.txHash = lib.txHash;
  }
  if (d.dir) {
    await exportAbi(hre, d.dir, "Staking", ARTIFACT.Staking);
    await exportAbi(hre, d.dir, "StakingMath", ARTIFACT.StakingMath);
  }
  up.completedAt = new Date().toISOString();
  up.block = await hre.ethers.provider.getBlockNumber();
  d.save();
  log(
    `Staking upgrade complete (${route.via}): Staking ${implementation}, StakingMath ${library}; run task:deploy:verify for both`,
  );
  return up;
}

function stop(d: Deployment, up: UpgradeRecord): UpgradeRecord {
  d.save();
  d.log("Stopped (--stop-after); run again to resume.");
  return up;
}

/** Everything the dry-run shows the person who will sign: both paths, with the roles each needs. */
function printSigning(d: Deployment, proxy: string, implementation: string, calls: Call[], route: Route): void {
  const { log } = d;
  const impl = implementation === ZeroAddress ? "<new implementation, known after the deployment>" : implementation;
  const grants = releasers(d);
  log("What is signed (the connected account approves each transaction on the device):");
  log("  before the hand-over (the deployer holds UPGRADER_ROLE and DEFAULT_ADMIN_ROLE on the Staking):");
  log("    tx 1  contract creation of the StakingMath library (no value, no state)");
  log("    tx 2  contract creation of the Staking implementation linked to it (no proxy touched)");
  log(`    tx 3  to ${proxy}  upgradeToAndCall(${impl}, 0x)   calldata ${calls[0].data}`);
  for (const [i, c] of calls.slice(1).entries())
    log(`    tx ${4 + i}  to ${proxy}  grantRole(AIRDROP_RELEASER_ROLE, ${grants[i]})   calldata ${c.data}`);
  log("    roles: Staking.UPGRADER_ROLE (upgrade) and Staking.DEFAULT_ADMIN_ROLE (grant) of the sender");
  log("  after the hand-over (the timelock holds both roles, the multisig proposes):");
  log("    tx 1  contract creation of the StakingMath library (any account)");
  log("    tx 2  contract creation of the Staking implementation (any account)");
  log(
    `    tx 3  timelock.scheduleBatch([${calls
      .map(() => proxy)
      .join(", ")}], [0...], [upgrade, grant...], 0x0, <salt>, <delay>) by a PROPOSER`,
  );
  log("    tx 4  timelock.executeBatch(the same batch) by an EXECUTOR after the delay");
  log("  after a safe-mode hand-over (the Safe holds both roles, no timelock):");
  log("    tx 1, 2  the StakingMath library and the Staking implementation (any account)");
  log("    then a Safe batch file (Transaction Builder) with the upgrade and the grant(s) for the owners to sign");
  log(`  this run would take the ${route.via} path`);
  log(
    "  after it succeeds the record gets Staking.implementation and StakingMath.address; both ABIs are written again",
  );
}

// --------------------------------------------------------------------------------------------- the check

export interface StakingRow {
  status: "OK" | "DRIFT" | "INFO";
  item: string;
  want: string;
  have: string;
}

/**
 * Read-only status of the upgrade (`task:upgrade:staking --check`): does the Staking proxy run the build the compiler
 * produces now, linked to the recorded StakingMath, which is the compiled library; does the record name them; do the
 * releasers hold the new role; and how many AIRDROP stakes are on hold.
 */
export async function stakingRows(d: Deployment): Promise<StakingRow[]> {
  const rows: StakingRow[] = [];
  const staking = await attachable(d, "Staking");
  const current = await implementationOf(d, "Staking");
  const library = getAddress(d.addr("StakingMath")!);
  const linked = await libraryOf(d, current);
  // once this upgrade is recorded as done, a later one may have moved the compiled build on: the build of this
  // upgrade is the one the record names for it
  const done = d.record.upgrades?.find((u) => u.id === STAKING_UPGRADE_ID)?.completedAt !== undefined;
  const upgraded = d.record.upgrades?.find((u) => u.id === STAKING_UPGRADE_ID)?.implementations;
  const libBuild =
    (await isLibraryBuild(d, library)) ||
    (done && upgraded?.StakingMath?.current !== undefined && getAddress(upgraded.StakingMath.current) === library);
  rows.push({
    status: libBuild ? "OK" : "DRIFT",
    item: "StakingMath at the record is the staking build (income without the held stakes)",
    want: "staking build",
    have: libBuild ? `staking build ${library}` : `older build ${library}`,
  });
  const build =
    (await isStakingBuild(d, current, library)) ||
    (done && upgraded?.Staking?.current !== undefined && getAddress(upgraded.Staking.current) === current);
  rows.push({
    status: build ? "OK" : "DRIFT",
    item: "Staking implementation is the staking build (airdrop hold), linked to the recorded StakingMath",
    want: "staking build",
    have: build ? `staking build ${current}` : `older build ${current} (linked to ${linked ?? "none"})`,
  });
  const recorded = d.record.contracts.Staking?.implementation;
  const same = recorded !== undefined && getAddress(recorded) === current;
  rows.push({
    status: same ? "OK" : "DRIFT",
    item: "Staking implementation equals the record",
    want: recorded ?? "recorded",
    have: current,
  });
  for (const who of releasers(d)) {
    const held = (await staking.hasRole(AIRDROP_RELEASER_ROLE, who)) as boolean;
    rows.push({
      status: held ? "OK" : "DRIFT",
      item: `${who} holds Staking.AIRDROP_RELEASER_ROLE (releases the airdrop hold)`,
      want: "true",
      have: String(held),
    });
  }
  const airdrop = await airdropStakes(staking);
  const heldCount = airdrop.open.filter((s) => s.held === true).length;
  rows.push({
    status: "INFO",
    item: "open AIRDROP stakes (all must be on hold once the upgrade ran)",
    want: `${airdrop.open.length} on hold`,
    have: `${airdrop.open.length} open, ${heldCount} on hold`,
  });
  return rows;
}
