import { type Contract, ZeroAddress, getAddress, id } from "ethers";

import { ARTIFACT, type Deployment } from "./context";
import { exportAbi } from "./record";
import type { UpgradeRecord, UpgradedImplementation } from "./types";
import {
  type Call,
  NETWORK_UPGRADE_ID,
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
  unsafeAllowOf,
  validate,
} from "./upgradeCore";

const UPGRADER_ROLE = id("UPGRADER_ROLE");
const PROPOSER_ROLE = id("PROPOSER_ROLE");
const EXECUTOR_ROLE = id("EXECUTOR_ROLE");

export interface NetworkUpgradeOptions {
  /** Stop after this step id (`impl:Network`, `upgrade:Network`, `schedule`); the next run resumes. */
  stopAfter?: string;
  /** Timelock path: keep polling until the operation is ready and execute it. */
  wait?: boolean;
}

/** Network values the upgrade must leave as they are (no storage changes): read before and after. */
async function stateOf(network: Contract): Promise<Record<string, string>> {
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return {
    priceFeed: await network.priceFeed(),
    lrRates: json(await network.lrRates()),
    ncRates: json(await network.ncRates()),
    backFlow: json(await network.backFlow()),
    tierLevels: json(await network.tierLevels()),
    licenseOwed: String(await network.licenseOwed()),
    guardianFreezeBudget: json(await network.guardianFreezeBudget()),
  };
}

/** Direct when the sender holds UPGRADER_ROLE on the Network (before the hand-over), the timelock otherwise. */
async function routeOf(d: Deployment): Promise<Route> {
  const who = d.signer ? await d.signer.getAddress() : d.deployer;
  const network = await attachable(d, "Network");
  if (await network.hasRole(UPGRADER_ROLE, who)) return { via: "direct", problems: [] };
  const viaSafe = await safeRoute(d, [["Network", [UPGRADER_ROLE]]]);
  if (viaSafe) return viaSafe;

  const problems: string[] = [];
  const timelockAddress = d.record.contracts.TimelockController?.address;
  if (!timelockAddress) {
    problems.push(
      `${who} lacks Network.UPGRADER_ROLE and there is no TimelockController in the record (nor does the Safe hold it)`,
    );
    return { via: "timelock", problems };
  }
  const timelock = await attachable(d, "TimelockController");
  if (!(await network.hasRole(UPGRADER_ROLE, timelockAddress)))
    problems.push("the timelock lacks Network.UPGRADER_ROLE");
  if (!(await timelock.hasRole(PROPOSER_ROLE, who))) problems.push(`${who} is not a proposer of the timelock`);
  if (!(await timelock.hasRole(EXECUTOR_ROLE, who))) problems.push(`${who} is not an executor of the timelock`);
  return { via: "timelock", problems };
}

/** The one call: `upgradeToAndCall(implementation, 0x)` on the Network proxy (no initializer: the storage is unchanged). */
async function buildCall(d: Deployment, implementation: string): Promise<Call> {
  const network = await attachable(d, "Network");
  return {
    id: "upgrade:Network",
    title: `Network.upgradeToAndCall(${
      implementation === ZeroAddress ? "<new implementation>" : implementation
    }, no call)`,
    contract: "Network",
    data: network.interface.encodeFunctionData("upgradeToAndCall", [implementation, "0x"]),
    done: async () => (await implementationOf(d, "Network")) === getAddress(implementation),
  };
}

/**
 * License Rewards are credited as VEX on the cashback balance. Only the Network proxy is
 * upgraded to the new implementation; no storage change, no initializer. Idempotent and resumable like the deploy
 * engine: every step reads the chain and what is recorded in `record.upgrades` (the new implementation, the timelock
 * operation) is reused. `dry-run` sends nothing (it checks the storage layout against the implementation the proxy
 * runs, prints what each path would sign); `run` signs with the connected account (a Ledger on `bsc`).
 *
 *  1. the implementation is deployed (`prepareUpgrade` checks the layout against the OpenZeppelin manifest);
 *  2. the sender holds Network.UPGRADER_ROLE (before the hand-over) -> one direct `upgradeToAndCall`;
 *     otherwise the same call as a timelock batch of one (schedule, wait the delay, execute);
 *  3. the record gets the implementation (only after the call is confirmed) and the Network ABI is written again.
 */
export async function runUpgradeNetwork(d: Deployment, opts: NetworkUpgradeOptions = {}): Promise<UpgradeRecord> {
  const { log, hre } = d;
  if (!d.record.complete) throw new Error("The deployment is not complete: finish `task:deploy:all` first");
  if (!d.addr("Network")) throw new Error("Network is missing from the record");
  const sends = d.sends;
  const up = recordOf(d, NETWORK_UPGRADE_ID);
  const sender = d.signer ? await d.signer.getAddress() : d.deployer;
  const proxy = d.addr("Network")!;
  const current = await implementationOf(d, "Network");
  log(`${sends ? "Upgrading" : "Dry-run of the upgrade of"} ${hre.network.name} (network: License Rewards as VEX)`);
  log(`  sender          ${sender}`);
  log(`  Network proxy   ${proxy}`);
  log(`  runs now        ${current}`);

  // ---- 1. the implementation
  const known = up.implementations.Network;
  let implementation: string;
  if (
    known &&
    (await hre.ethers.provider.getCode(known.current)) !== "0x" &&
    (await isBuildOf(d, "Network", known.current))
  ) {
    implementation = known.current;
    log(`[1/2] skip   deploy the Network implementation (recorded ${implementation})`);
  } else if (await isBuildOf(d, "Network", current)) {
    implementation = current;
    up.implementations.Network = { previous: known?.previous ?? current, current };
    log(`[1/2] skip   Network already runs this build (${current})`);
  } else {
    await validate(d, "Network");
    if (!sends) {
      log(`[1/2] would  deploy the Network implementation (storage layout checked against ${current}: compatible)`);
      implementation = ZeroAddress;
    } else {
      log(`[1/2] sign   deploy the Network implementation (a contract creation, no proxy call yet)`);
      const factory = await factoryOf(d, "Network");
      implementation = getAddress(
        (await hre.upgrades.prepareUpgrade(proxy, factory, {
          kind: "uups",
          unsafeAllow: [...unsafeAllowOf("Network")],
          timeout: 0,
        })) as string,
      );
      await d.settle();
      up.implementations.Network = {
        previous: known?.previous ?? current,
        current: implementation,
      } satisfies UpgradedImplementation;
      d.save();
      log(`[1/2] done   Network implementation ${implementation}`);
      if (opts.stopAfter === "impl:Network") return stop(d, up);
    }
  }

  // ---- 2. the route and the call
  const route = await routeOf(d);
  const call = await buildCall(d, implementation);
  const pending = !(await call.done());
  log(`route: ${route.via}${isTimelockRoute(route) ? ` (delay ${await timelockDelay(d)} s)` : ""}`);
  log(`  ${pending ? "todo" : "done"}  ${call.title}`);
  if (route.problems.length > 0 && pending) {
    for (const p of route.problems) log(`  PROBLEM ${p}`);
    if (sends) throw new Error(`The sender cannot send the upgrade:\n  ${route.problems.join("\n  ")}`);
  }
  if (!sends) {
    printSigning(d, proxy, implementation, call, route);
    log("Dry-run done: nothing was sent.");
    return up;
  }

  const before = await stateOf(await attachable(d, "Network"));
  up.via = route.via;
  if (pending) {
    if (!(await runVia(d, up, route, [call], { stopAfter: opts.stopAfter, wait: opts.wait }))) return up;
  }

  // ---- 3. verify and record (only now: the call is confirmed)
  if (!(await call.done())) throw new Error(`${call.id}: the transaction went through but the state does not match`);
  const after = await stateOf(await attachable(d, "Network"));
  for (const key of Object.keys(before))
    if (before[key] !== after[key])
      throw new Error(`Network.${key} changed by the upgrade: ${before[key]} -> ${after[key]}`);
  const c = d.record.contracts.Network!;
  if (c.implementation !== getAddress(implementation)) delete c.verified;
  c.implementation = getAddress(implementation);
  if (d.dir) await exportAbi(hre, d.dir, "Network", ARTIFACT.Network);
  up.completedAt = new Date().toISOString();
  up.block = await hre.ethers.provider.getBlockNumber();
  d.save();
  log(
    `Network upgrade complete (${route.via}): Network ${implementation}; run task:deploy:verify for the new implementation`,
  );
  return up;
}

function stop(d: Deployment, up: UpgradeRecord): UpgradeRecord {
  d.save();
  d.log("Stopped (--stop-after); run again to resume.");
  return up;
}

/** Everything the dry-run shows the person who will sign: both paths, with the role each needs. */
function printSigning(d: Deployment, proxy: string, implementation: string, call: Call, route: Route): void {
  const { log } = d;
  const impl = implementation === ZeroAddress ? "<new implementation, known after the deployment>" : implementation;
  log("What is signed (the connected account approves each transaction on the device):");
  log("  before the hand-over (the deployer holds UPGRADER_ROLE):");
  log(`    tx 1  contract creation of the Network implementation (no value, no proxy touched)`);
  log(`    tx 2  to ${proxy}  upgradeToAndCall(${impl}, 0x)   calldata ${call.data}`);
  log("    role: Network.UPGRADER_ROLE of the sender (the deployer today; DEFAULT_ADMIN is not enough on its own)");
  log("  after the hand-over (the timelock holds UPGRADER_ROLE, the multisig proposes):");
  log(`    tx 1  contract creation of the Network implementation (any account)`);
  log(`    tx 2  timelock.scheduleBatch([${proxy}], [0], [${call.data}], 0x0, <salt>, <delay>)  by a PROPOSER`);
  log(`    tx 3  timelock.executeBatch(the same batch) by an EXECUTOR after the delay`);
  log("  after a safe-mode hand-over (the Safe holds UPGRADER_ROLE, no timelock):");
  log(`    tx 1  contract creation of the Network implementation (any account)`);
  log(`    then a Safe batch file (Transaction Builder) with upgradeToAndCall(${impl}, 0x) for the owners to sign`);
  log(`  this run would take the ${route.via} path`);
  log(`  after it succeeds the record gets Network.implementation and the Network ABI is written again`);
}

export interface NetworkRow {
  status: "OK" | "DRIFT" | "INFO";
  item: string;
  want: string;
  have: string;
}

/**
 * Read-only status of the upgrade (`task:upgrade:network --check`): does the Network proxy run the build the compiler
 * produces now, does the record name that implementation, is the PriceFeed set (License Rewards are not credited
 * without a price) and are the wiring roles in place.
 */
export async function networkRows(d: Deployment): Promise<NetworkRow[]> {
  const rows: NetworkRow[] = [];
  const network = await attachable(d, "Network");
  const current = await implementationOf(d, "Network");
  const build = await isBuildOf(d, "Network", current);
  rows.push({
    status: build ? "OK" : "DRIFT",
    item: "Network implementation is the current build (License Rewards as VEX)",
    want: "current build",
    have: build ? `current build ${current}` : `older build ${current}`,
  });
  const recorded = d.record.contracts.Network?.implementation;
  const same = recorded !== undefined && getAddress(recorded) === current;
  rows.push({
    status: same ? "OK" : "DRIFT",
    item: "Network implementation equals the record",
    want: recorded ?? "recorded",
    have: current,
  });
  const feed: string = await network.priceFeed();
  rows.push({
    status: feed === ZeroAddress ? "DRIFT" : "OK",
    item: "Network.priceFeed is set (without it a license pays no License Rewards)",
    want: d.addr("PriceFeed") ?? "PriceFeed",
    have: feed,
  });
  if (d.addr("Rewards")) {
    const wired = await network.hasRole(id("REWARDS_ROLE"), d.addr("Rewards")!);
    rows.push({
      status: wired ? "OK" : "DRIFT",
      item: "Rewards holds Network.REWARDS_ROLE (cashback claims consume the balance)",
      want: "true",
      have: String(wired),
    });
  }
  if (d.addr("LicenseSale")) {
    const wired = await network.hasRole(id("HOOK_ROLE"), d.addr("LicenseSale")!);
    rows.push({
      status: wired ? "OK" : "DRIFT",
      item: "LicenseSale holds Network.HOOK_ROLE (onLicenseBought)",
      want: "true",
      have: String(wired),
    });
  }
  const owed = await network.licenseOwed();
  rows.push({
    status: "INFO",
    item: "legacy USDT License Rewards still owed (credited before the upgrade; 0 on mainnet)",
    want: "0 on mainnet",
    have: String(owed),
  });
  return rows;
}
