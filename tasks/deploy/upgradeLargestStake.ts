import { type Contract, ZeroAddress, getAddress, id } from "ethers";

import { ARTIFACT, type Deployment } from "./context";
import { exportAbi } from "./record";
import type { ContractName, UpgradeRecord, UpgradedImplementation } from "./types";
import {
  type Call,
  LARGEST_STAKE_UPGRADE_ID,
  type Route,
  attachable,
  factoryOf,
  implementationOf,
  isBuildOf,
  isTimelockRoute,
  recordOf,
  runVia,
  safeRoute,
  timelockDelay,
  validate,
} from "./upgradeCore";
import { isLibraryBuild, isStakingBuild, stakeIds, stakingFactory, stateOf } from "./upgradeStaking";

const UPGRADER_ROLE = id("UPGRADER_ROLE");
const PROPOSER_ROLE = id("PROPOSER_ROLE");
const EXECUTOR_ROLE = id("EXECUTOR_ROLE");
const SOURCE_JUMP = 1n;
const STATE_OPEN = 1n;
/** Index of the CASHBACK kind in `Rewards.claimsOf`. */
const KIND_CASHBACK = 1;
/** Accounts per `syncCapBase` (Staking.MAX_RELEASE_BATCH). */
const SYNC_BATCH = 50;
/** The proxies that change, in the order they are upgraded: Rewards and LicenseSale read what the new Staking adds. */
const PROXIES = ["Staking", "Rewards", "LicenseSale"] as const;
type LargestStakeProxy = (typeof PROXIES)[number];

export interface LargestStakeUpgradeOptions {
  /** Stop after this step id (`impl:StakingMath`, `impl:<Name>`, `upgrade:<Name>`, `schedule`); the next run resumes. */
  stopAfter?: string;
  /** Timelock path: keep polling until the operation is ready and execute it. */
  wait?: boolean;
  /** Test seam: runs once the calls are confirmed, before the state is compared (to prove the comparison has teeth). */
  afterCalls?: () => Promise<void>;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// --------------------------------------------------------------------------------------------- state

/** What the stakes of the chain say about the cap bases (read the same way before and after the upgrade). */
export interface Survey {
  /** Stakes ever opened. */
  stakes: number;
  /** Accounts that ever opened one. */
  owners: number;
  /** Accounts with at least one open stake. */
  openOwners: number;
  /** Accounts with more than one open USER or AIRDROP stake (their base changes: the sum becomes the largest). */
  multi: number;
  /** Accounts with an open AIRDROP stake and no USER stake or more (their base appears, it was 0). */
  airdropOnly: number;
  /** Accounts whose cap base in Network is not the principal of their largest open USER / AIRDROP stake. */
  stale: string[];
  /** Per account with an open own stake: the old base (Network), the sum of the USER stakes and the new base. */
  rows: { owner: string; open: number; base: bigint; sum: bigint; largest: bigint }[];
}

/** Reads every stake and compares the Network cap base of its owner with the largest open own stake. */
export async function survey(staking: Contract, network: Contract): Promise<Survey> {
  const n = await stakeIds(staking);
  const byOwner = new Map<string, { principal: bigint; source: bigint }[]>();
  for (let i = 1; i <= n; i++) {
    const v = await staking.stakeView(i);
    const list = byOwner.get(v.owner) ?? [];
    if (BigInt(v.state) === STATE_OPEN) list.push({ principal: BigInt(v.principal), source: BigInt(v.source) });
    byOwner.set(v.owner, list);
  }
  const out: Survey = { stakes: n, owners: byOwner.size, openOwners: 0, multi: 0, airdropOnly: 0, stale: [], rows: [] };
  for (const [owner, open] of byOwner) {
    if (open.length > 0) out.openOwners++;
    const own = open.filter((s) => s.source !== SOURCE_JUMP);
    const largest = own.reduce((m, s) => (s.principal > m ? s.principal : m), 0n);
    const sum = own.filter((s) => s.source === 0n).reduce((a, s) => a + s.principal, 0n);
    if (own.length > 1) out.multi++;
    if (own.length > 0 && own.every((s) => s.source !== 0n)) out.airdropOnly++;
    const base = BigInt((await network.capOf(owner))[0]);
    if (base !== largest) out.stale.push(owner);
    if (own.length > 0) out.rows.push({ owner, open: own.length, base, sum, largest });
  }
  return out;
}

/** Rewards and LicenseSale values the upgrade must leave as they are (no storage change). */
async function wiringOf(d: Deployment): Promise<Record<string, string>> {
  const rewards = await attachable(d, "Rewards");
  const sale = await attachable(d, "LicenseSale");
  const out: Record<string, string> = {};
  for (const k of ["vex", "network", "staking", "priceFeed", "tokenSale"]) out[`rewards.${k}`] = await rewards[k]();
  out["rewards.wholeBalanceWhenHalfBelowMin"] = String(await rewards.wholeBalanceWhenHalfBelowMin());
  // the VEX limit only: the second (USDT License) limit is gone after the upgrade
  out["rewards.caps"] = json((await rewards.capsOf()).capUsdt);
  out["rewards.pausedFlags"] = String(await rewards.pausedFlags());
  for (const k of ["license", "usdt", "treasury", "network", "priceFeed", "staking"])
    out[`licenseSale.${k}`] = await sale[k]();
  out["licenseSale.pausedFlags"] = String(await sale.pausedFlags());
  return out;
}

// --------------------------------------------------------------------------------------------- who sends what

/** Direct when the sender holds UPGRADER_ROLE on the three proxies (before the hand-over), the Safe / timelock after. */
async function routeOf(d: Deployment): Promise<Route> {
  const who = d.signer ? await d.signer.getAddress() : d.deployer;
  let direct = true;
  for (const name of PROXIES) if (!(await (await attachable(d, name)).hasRole(UPGRADER_ROLE, who))) direct = false;
  if (direct) return { via: "direct", problems: [] };
  const viaSafe = await safeRoute(
    d,
    PROXIES.map((name): [ContractName, string[]] => [name, [UPGRADER_ROLE]]),
  );
  if (viaSafe) return viaSafe;

  const problems: string[] = [];
  const timelockAddress = d.record.contracts.TimelockController?.address;
  if (!timelockAddress) {
    problems.push(
      `${who} lacks UPGRADER_ROLE on ${PROXIES.join(
        ", ",
      )} and there is no TimelockController in the record (nor does the Safe hold it)`,
    );
    return { via: "timelock", problems };
  }
  const timelock = await attachable(d, "TimelockController");
  for (const name of PROXIES)
    if (!(await (await attachable(d, name)).hasRole(UPGRADER_ROLE, timelockAddress)))
      problems.push(`the timelock lacks ${name}.UPGRADER_ROLE`);
  if (!(await timelock.hasRole(PROPOSER_ROLE, who))) problems.push(`${who} is not a proposer of the timelock`);
  if (!(await timelock.hasRole(EXECUTOR_ROLE, who))) problems.push(`${who} is not an executor of the timelock`);
  return { via: "timelock", problems };
}

/** The three `upgradeToAndCall`s (no initializer: no storage is set), Staking first. */
async function buildCalls(d: Deployment, impls: Record<LargestStakeProxy, string>): Promise<Call[]> {
  const calls: Call[] = [];
  for (const name of PROXIES) {
    const c = await attachable(d, name);
    calls.push({
      id: `upgrade:${name}`,
      title: `${name}.upgradeToAndCall(${impls[name] === ZeroAddress ? "<new implementation>" : impls[name]}, no call)`,
      contract: name,
      data: c.interface.encodeFunctionData("upgradeToAndCall", [impls[name], "0x"]),
      done: async () => (await implementationOf(d, name)) === getAddress(impls[name]),
    });
  }
  return calls;
}

// --------------------------------------------------------------------------------------------- the run

/**
 * The partner-bonus cap and the withdrawal maximum (50 % of its principal in
 * VEX; the legacy USDT kind 50 % of its entry USDT) follow the LARGEST open own stake
 * (USER or AIRDROP, never JUMP), an AIRDROP stake also gives the other eligibilities (bonuses, withdrawal, Lite), and
 * the admin can release many airdrop holds in one transaction. The Staking proxy is upgraded to a new implementation
 * (it links a new StakingMath), Rewards and LicenseSale to new implementations that read the new Staking views. No
 * initializer; one new mapping at the end of the Staking namespace (`largest`), so the old accounts have no record yet:
 * the views read their open list until they are touched or `syncCapBase` writes it, which this task does for every
 * account whose Network cap base differs from the new rule. Idempotent and resumable like the deploy engine; `dry-run`
 * sends nothing (it checks the storage layouts against the implementations the proxies run and prints what each path
 * would sign, and which accounts the sync would touch); `run` signs with the connected account.
 *
 *  1. the StakingMath library is deployed (a contract creation, no state);
 *  2. the Staking implementation is deployed linked to it, the Rewards and LicenseSale implementations (each through
 *     `prepareUpgrade`, which checks the layout against the manifest);
 *  3. the sender holds UPGRADER_ROLE on the three (before the hand-over) -> three direct `upgradeToAndCall`; the Safe
 *     holds it (safe-mode hand-over) -> a Safe batch file; otherwise one timelock batch;
 *  4. `syncCapBase` for the accounts whose base moves (anyone may send it, no role);
 *  5. the record gets the library and the implementations (only after the calls are confirmed) and the ABIs are
 *     written again.
 */
export async function runUpgradeLargestStake(
  d: Deployment,
  opts: LargestStakeUpgradeOptions = {},
): Promise<UpgradeRecord> {
  const { log, hre } = d;
  if (!d.record.complete) throw new Error("The deployment is not complete: finish `task:deploy:all` first");
  for (const name of [...PROXIES, "StakingMath", "Network"] as const)
    if (!d.addr(name)) throw new Error(`${name} is missing from the record`);
  const sends = d.sends;
  const up = recordOf(d, LARGEST_STAKE_UPGRADE_ID);
  const sender = d.signer ? await d.signer.getAddress() : d.deployer;
  const proxy = d.addr("Staking")!;
  const staking = await attachable(d, "Staking");
  const network = await attachable(d, "Network");
  log(`${sends ? "Upgrading" : "Dry-run of the upgrade of"} ${hre.network.name} (largest open stake)`);
  log(`  sender          ${sender}`);
  for (const name of PROXIES) log(`  ${name.padEnd(15)} ${d.addr(name)} runs ${await implementationOf(d, name)}`);
  log(`  StakingMath     ${d.addr("StakingMath")} (the record)`);

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
    log(`[1/5] skip   deploy StakingMath (recorded ${library})`);
  } else if (await isLibraryBuild(d, recordedLib)) {
    library = recordedLib;
    up.implementations.StakingMath = { previous: knownLib?.previous ?? recordedLib, current: recordedLib };
    log(`[1/5] skip   StakingMath at ${recordedLib} is already this build`);
  } else if (!sends) {
    library = recordedLib; // only to check the layout below
    log(`[1/5] would  deploy the StakingMath library (a contract creation, no state)`);
  } else {
    log(`[1/5] sign   deploy the StakingMath library (a contract creation, no proxy call)`);
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
    log(`[1/5] done   StakingMath ${library}`);
    if (opts.stopAfter === "impl:StakingMath") return stop(d, up);
  }

  // ---- 2. the implementations
  const impls = {} as Record<LargestStakeProxy, string>;
  for (const [i, name] of PROXIES.entries()) {
    const tag = `[${i + 2}/5]`;
    const known = up.implementations[name];
    const now = await implementationOf(d, name);
    const isBuild = (address: string) =>
      name === "Staking" ? isStakingBuild(d, address, library) : isBuildOf(d, name, address);
    if (known && (await hre.ethers.provider.getCode(known.current)) !== "0x" && (await isBuild(known.current))) {
      impls[name] = known.current;
      log(`${tag} skip   deploy the ${name} implementation (recorded ${known.current})`);
      continue;
    }
    if (await isBuild(now)) {
      impls[name] = now;
      up.implementations[name] = { previous: known?.previous ?? now, current: now };
      log(`${tag} skip   ${name} already runs this build (${now})`);
      continue;
    }
    const options = {
      kind: "uups" as const,
      unsafeAllow: name === "Staking" ? ["external-library-linking" as const] : [],
    };
    if (name === "Staking") await hre.upgrades.validateUpgrade(proxy, await stakingFactory(d, library), options);
    else await validate(d, name);
    if (!sends) {
      log(`${tag} would  deploy the ${name} implementation (storage layout checked against ${now}: compatible)`);
      impls[name] = ZeroAddress;
      continue;
    }
    log(`${tag} sign   deploy the ${name} implementation (a contract creation, no proxy call yet)`);
    const factory = name === "Staking" ? await stakingFactory(d, library) : await factoryOf(d, name);
    impls[name] = getAddress(
      (await hre.upgrades.prepareUpgrade(d.addr(name)!, factory, { ...options, timeout: 0 })) as string,
    );
    await d.settle();
    up.implementations[name] = {
      previous: known?.previous ?? now,
      current: impls[name],
    } satisfies UpgradedImplementation;
    d.save();
    log(`${tag} done   ${name} implementation ${impls[name]}`);
    if (opts.stopAfter === `impl:${name}`) return stop(d, up);
  }

  // ---- 3. the route and the calls
  const route = await routeOf(d);
  const calls = await buildCalls(d, impls);
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
  const seen = await survey(staking, network);
  logSurvey(d, seen);
  if (!sends) {
    printSigning(d, calls, route, seen);
    log("Dry-run done: nothing was sent.");
    return up;
  }

  const at = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
  const before = pending.length > 0 ? { staking: await stateOf(staking, at), wiring: await wiringOf(d) } : undefined;
  up.via = route.via;
  if (pending.length > 0) {
    if (!(await runVia(d, up, route, pending, { stopAfter: opts.stopAfter, wait: opts.wait }))) return up;
  }
  await opts.afterCalls?.();

  // ---- 4. verify the calls, then sync the bases
  for (const c of calls)
    if (!(await c.done())) throw new Error(`${c.id}: the transaction went through but the state does not match`);
  if (before) {
    const after = { staking: await stateOf(staking, at), wiring: await wiringOf(d) };
    for (const part of ["staking", "wiring"] as const)
      for (const key of Object.keys(before[part]))
        if (before[part][key] !== after[part][key])
          throw new Error(`${part} ${key} changed by the upgrade: ${before[part][key]} -> ${after[part][key]}`);
    log(
      `the Staking configuration, pools and ${seen.stakes} stake(s), and the Rewards and LicenseSale wiring are unchanged`,
    );
  }
  await syncBases(d, staking, network);

  // ---- 5. record
  for (const name of PROXIES) {
    const c = d.record.contracts[name]!;
    if (c.implementation !== getAddress(impls[name])) delete c.verified;
    c.implementation = getAddress(impls[name]);
  }
  const m = d.record.contracts.StakingMath!;
  const lib = up.implementations.StakingMath;
  if (getAddress(m.address) !== library) {
    delete m.verified;
    m.address = library;
    if (lib?.deployBlock !== undefined) m.deployBlock = lib.deployBlock;
    if (lib?.txHash !== undefined) m.txHash = lib.txHash;
  }
  if (d.dir) for (const name of [...PROXIES, "StakingMath"] as const) await exportAbi(hre, d.dir, name, ARTIFACT[name]);
  up.completedAt = new Date().toISOString();
  up.block = await hre.ethers.provider.getBlockNumber();
  d.save();
  log(
    `Largest-stake upgrade complete (${route.via}): ${PROXIES.map((n) => `${n} ${impls[n]}`).join(
      ", ",
    )}, StakingMath ${library}; run task:deploy:verify for them`,
  );
  return up;
}

/** Sends `syncCapBase` for the accounts whose base differs from the largest open own stake, 50 per transaction. */
export async function syncBases(d: Deployment, staking: Contract, network: Contract, tag = "[5/5]"): Promise<void> {
  const seen = await survey(staking, network);
  if (seen.stale.length === 0) {
    d.log(`${tag} skip   no account has a stale cap base`);
    return;
  }
  for (let i = 0; i < seen.stale.length; i += SYNC_BATCH) {
    const batch = seen.stale.slice(i, i + SYNC_BATCH);
    d.log(`${tag} sign   Staking.syncCapBase(${batch.length} account(s))`);
    await d.send(staking.syncCapBase(batch));
  }
  const after = await survey(staking, network);
  if (after.stale.length > 0)
    throw new Error(`${after.stale.length} account(s) still have a stale cap base after syncCapBase`);
  d.log(`  ${seen.stale.length} cap base(s) synced`);
}

function logSurvey(d: Deployment, s: Survey): void {
  const { log } = d;
  log(
    `stakes ${s.stakes}, accounts ${s.owners}, with an open stake ${s.openOwners}, with more than one open USER / AIRDROP stake ${s.multi}, AIRDROP-only ${s.airdropOnly}`,
  );
  for (const r of s.rows)
    log(
      `  ${r.owner}: ${r.open} open own stake(s), Network base ${r.base}, sum of USER stakes ${r.sum}, new base (largest) ${r.largest}`,
    );
  log(`${s.stale.length} account(s) whose Network cap base is not the largest open own stake (syncCapBase moves them)`);
}

function stop(d: Deployment, up: UpgradeRecord): UpgradeRecord {
  d.save();
  d.log("Stopped (--stop-after); run again to resume.");
  return up;
}

/** Everything the dry-run shows the person who will sign: both paths, with the role each needs. */
function printSigning(d: Deployment, calls: Call[], route: Route, seen: Survey): void {
  const { log } = d;
  log("What is signed (the connected account approves each transaction on the device):");
  log("  before the hand-over (the deployer holds UPGRADER_ROLE on Staking, Rewards and LicenseSale):");
  log("    tx 1  contract creation of the StakingMath library (no value, no state)");
  log("    tx 2  contract creation of the Staking implementation linked to it (no proxy touched)");
  log("    tx 3  contract creation of the Rewards implementation");
  log("    tx 4  contract creation of the LicenseSale implementation");
  for (const [i, c] of calls.entries())
    log(`    tx ${5 + i}  to ${d.addr(c.contract)}  ${c.title}   calldata ${c.data}`);
  log(`    tx 8+ Staking.syncCapBase(accounts) x ${Math.ceil(seen.stale.length / SYNC_BATCH)} (any account, no role)`);
  log("    roles: UPGRADER_ROLE of the sender on Staking, Rewards and LicenseSale");
  log("  after a safe-mode hand-over (the Safe holds UPGRADER_ROLE, no timelock):");
  log("    tx 1-4  the library and the three implementations (any account)");
  log("    then a Safe batch file (Transaction Builder) with the three upgrades for the owners to sign");
  log("  after a timelock hand-over: scheduleBatch / executeBatch of the same three calls");
  log(`  this run would take the ${route.via} path`);
  log(
    "  after it succeeds the record gets the three implementations and StakingMath.address; the four ABIs are written again",
  );
}

// --------------------------------------------------------------------------------------------- the check

export interface LargestStakeRow {
  status: "OK" | "DRIFT" | "INFO";
  item: string;
  want: string;
  have: string;
}

/**
 * Read-only status of the upgrade (`task:upgrade:largest-stake --check`): do Staking, Rewards and LicenseSale run the build
 * the compiler produces now (Staking linked to the recorded, compiled StakingMath); does the record name them; does
 * every cap base in Network equal the largest open own stake.
 */
export async function largestStakeRows(d: Deployment): Promise<LargestStakeRow[]> {
  const rows: LargestStakeRow[] = [];
  const library = getAddress(d.addr("StakingMath")!);
  const libBuild = await isLibraryBuild(d, library);
  rows.push({
    status: libBuild ? "OK" : "DRIFT",
    item: "StakingMath at the record is the current build (largest open stake, release batch)",
    want: "current build",
    have: libBuild ? `current build ${library}` : `older build ${library}`,
  });
  for (const name of PROXIES) {
    const now = await implementationOf(d, name);
    const build = name === "Staking" ? await isStakingBuild(d, now, library) : await isBuildOf(d, name, now);
    rows.push({
      status: build ? "OK" : "DRIFT",
      item: `${name} implementation is the current build`,
      want: "current build",
      have: build ? `current build ${now}` : `older build ${now}`,
    });
    const recorded = d.record.contracts[name]?.implementation;
    const same = recorded !== undefined && getAddress(recorded) === now;
    rows.push({
      status: same ? "OK" : "DRIFT",
      item: `${name} implementation equals the record`,
      want: recorded ?? "recorded",
      have: now,
    });
  }
  const staking = await attachable(d, "Staking");
  const network = await attachable(d, "Network");
  let have = "unreadable (the Staking does not run the current build yet)";
  let status: LargestStakeRow["status"] = "DRIFT";
  let seen: Survey | undefined;
  try {
    seen = await survey(staking, network);
    have = `${seen.stale.length} stale of ${seen.owners} account(s)`;
    status = seen.stale.length === 0 ? "OK" : "DRIFT";
  } catch {
    // an older Staking: the rows above already say so
  }
  rows.push({
    status,
    item: "every Network cap base is the principal of the account's largest open USER / AIRDROP stake",
    want: "0 stale",
    have,
  });
  rows.push(await maximumRow(d, seen));
  rows.push(await kindsRow(d));
  return rows;
}

/** Words of one `ClaimInfo` (balance, minimum, maximum, nextAllowedAt, capRoom, windowOpen, priced). */
const CLAIM_INFO_WORDS = 7;

/**
 * The USDT License kind (2) is gone. `Rewards.lastClaimOf(account, 2)` reverts `InvalidKind` (a pure view, so
 * a pause does not hide it) and `claimsOf` returns the two VEX kinds only (the raw answer is two `ClaimInfo` long).
 */
async function kindsRow(d: Deployment): Promise<LargestStakeRow> {
  const item = "Rewards refuses kind 2 (the USDT License kind is removed) and claimsOf lists the two VEX kinds";
  const row = (status: LargestStakeRow["status"], have: string): LargestStakeRow => ({
    status,
    item,
    want: "InvalidKind(2), 2 kinds",
    have,
  });
  const { hre } = d;
  const rewards = await attachable(d, "Rewards");
  let refused = false;
  try {
    await rewards.lastClaimOf(ZeroAddress, 2);
  } catch (e) {
    refused = rewards.interface.parseError((e as { data?: string }).data ?? "0x")?.name === "InvalidKind";
  }
  let kinds = -1;
  try {
    const data = rewards.interface.encodeFunctionData("claimsOf", [ZeroAddress]);
    const answer = await hre.ethers.provider.call({ to: await rewards.getAddress(), data });
    kinds = (answer.length - 2) / 2 / 32 / CLAIM_INFO_WORDS;
  } catch {
    return row("DRIFT", "claimsOf is unreadable");
  }
  const ok = refused && kinds === 2;
  return row(ok ? "OK" : "DRIFT", `kind 2 ${refused ? "refused" : "still accepted"}, claimsOf lists ${kinds} kind(s)`);
}

/**
 * The withdrawal maximum of the VEX kinds (CASHBACK; STAKING has the same rule) is half of the principal in VEX
 * of the account's largest open own stake, whatever the price. Read from `Rewards.claimsOf` for every account with an
 * own stake; with no VEX price the view answers 0 and nothing can be compared (not a drift).
 */
async function maximumRow(d: Deployment, seen: Survey | undefined): Promise<LargestStakeRow> {
  const item = "Rewards withdrawal maximum of a VEX kind is half of the principal (VEX) of the largest open own stake";
  const row = (status: LargestStakeRow["status"], have: string): LargestStakeRow => ({
    status,
    item,
    want: "principal / 2",
    have,
  });
  if (!seen) return row("DRIFT", "unreadable (the Staking does not run the current build yet)");
  try {
    const rewards = await attachable(d, "Rewards");
    const wrong: string[] = [];
    for (const r of seen.rows) {
      const info = (await rewards.claimsOf(r.owner))[KIND_CASHBACK];
      if (!info.priced) return row("OK", "no VEX price now: not compared");
      if (BigInt(info.maximum) !== r.largest / 2n) wrong.push(`${r.owner} (${info.maximum} vs ${r.largest / 2n})`);
    }
    if (wrong.length > 0) return row("DRIFT", `${wrong.length} differ: ${wrong.slice(0, 3).join(", ")}`);
    return row("OK", `${seen.rows.length} account(s) agree`);
  } catch {
    return row("DRIFT", "unreadable (an older Rewards)");
  }
}
