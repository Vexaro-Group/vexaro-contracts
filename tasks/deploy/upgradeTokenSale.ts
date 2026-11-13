import { type Contract, ZeroAddress, getAddress, id } from "ethers";

import { ARTIFACT, type Deployment } from "./context";
import { exportAbi } from "./record";
import type { UpgradeRecord, UpgradedImplementation } from "./types";
import {
  type Call,
  type Route,
  TOKEN_SALE_UPGRADE_ID,
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
/** The EIP-1967 implementation slot. */
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface TokenSaleUpgradeOptions {
  /** Stop after this step id (`impl:TokenSale`, `upgrade:TokenSale`, `schedule`); the next run resumes. */
  stopAfter?: string;
  /** Timelock path: keep polling until the operation is ready and execute it. */
  wait?: boolean;
}

/** TokenSale values the upgrade must leave as they are: read before and after. */
async function stateOf(sale: Contract): Promise<Record<string, string>> {
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return {
    roundCount: String(await sale.roundCount()),
    currentRound: String(await sale.currentRound()),
    rounds: json(await sale.rounds()),
    sellSink: await sale.sellSink(),
    currentSellFeeBps: String(await sale.currentSellFeeBps()),
    currentSellCaps: json(await sale.currentSellCaps()),
    sellLimits: json(await sale.sellLimits(ZeroAddress)),
    reserveFloor: json(await sale.reserveFloor()),
    inventory: String(await sale.inventory()),
  };
}

/** Direct when the sender holds UPGRADER_ROLE on the TokenSale, the Safe / the timelock otherwise. */
async function routeOf(d: Deployment): Promise<Route> {
  const who = d.signer ? await d.signer.getAddress() : d.deployer;
  const sale = await attachable(d, "TokenSale");
  if (await sale.hasRole(UPGRADER_ROLE, who)) return { via: "direct", problems: [] };
  const viaSafe = await safeRoute(d, [["TokenSale", [UPGRADER_ROLE]]]);
  if (viaSafe) return viaSafe;

  const problems: string[] = [];
  const timelockAddress = d.record.contracts.TimelockController?.address;
  if (!timelockAddress) {
    problems.push(
      `${who} lacks TokenSale.UPGRADER_ROLE and there is no TimelockController in the record (nor does the Safe hold it)`,
    );
    return { via: "timelock", problems };
  }
  const timelock = await attachable(d, "TimelockController");
  if (!(await sale.hasRole(UPGRADER_ROLE, timelockAddress)))
    problems.push("the timelock lacks TokenSale.UPGRADER_ROLE");
  if (!(await timelock.hasRole(PROPOSER_ROLE, who))) problems.push(`${who} is not a proposer of the timelock`);
  if (!(await timelock.hasRole(EXECUTOR_ROLE, who))) problems.push(`${who} is not an executor of the timelock`);
  return { via: "timelock", problems };
}

/** The one call: `upgradeToAndCall(implementation, 0x)` on the TokenSale proxy (no initializer: an empty mapping is right). */
async function buildCall(d: Deployment, implementation: string): Promise<Call> {
  const sale = await attachable(d, "TokenSale");
  return {
    id: "upgrade:TokenSale",
    title: `TokenSale.upgradeToAndCall(${
      implementation === ZeroAddress ? "<new implementation>" : implementation
    }, no call)`,
    contract: "TokenSale",
    data: sale.interface.encodeFunctionData("upgradeToAndCall", [implementation, "0x"]),
    done: async () => (await implementationOf(d, "TokenSale")) === getAddress(implementation),
  };
}

/** The implementation address in the EIP-1967 slot of the proxy. */
async function slotImplementation(d: Deployment, proxy: string): Promise<string> {
  const word = await d.hre.ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT);
  return getAddress("0x" + word.slice(-40));
}

/**
 * One sale per account and UTC day (`sell` and `sellAtCurrentPrice` together). Only the TokenSale proxy is upgraded;
 * the storage gets one appended mapping, no initializer. Idempotent and resumable like the deploy engine: every step
 * reads the chain and what is recorded in `record.upgrades` (the new implementation, the timelock operation) is
 * reused. `dry-run` sends nothing (it checks the storage layout against the implementation the proxy runs, prints
 * what each path would sign); `run` signs with the connected account (a Ledger on `bsc`).
 *
 *  1. the implementation is deployed (`prepareUpgrade` checks the layout against the OpenZeppelin manifest);
 *  2. the sender holds TokenSale.UPGRADER_ROLE -> one direct `upgradeToAndCall`; otherwise the same call goes through
 *     the timelock (the Safe imports a schedule file, then an execute file after the delay);
 *  3. the post-upgrade check reads the implementation slot and `nextSaleAt`, then the record gets the implementation
 *     and the TokenSale ABI is written again.
 */
export async function runUpgradeTokenSale(d: Deployment, opts: TokenSaleUpgradeOptions = {}): Promise<UpgradeRecord> {
  const { log, hre } = d;
  if (!d.record.complete) throw new Error("The deployment is not complete: finish `task:deploy:all` first");
  if (!d.addr("TokenSale")) throw new Error("TokenSale is missing from the record");
  const sends = d.sends;
  const up = recordOf(d, TOKEN_SALE_UPGRADE_ID);
  const sender = d.signer ? await d.signer.getAddress() : d.deployer;
  const proxy = d.addr("TokenSale")!;
  const current = await implementationOf(d, "TokenSale");
  log(`${sends ? "Upgrading" : "Dry-run of the upgrade of"} ${hre.network.name} (TokenSale: one sale per day)`);
  log(`  sender          ${sender}`);
  log(`  TokenSale proxy ${proxy}`);
  log(`  runs now        ${current}`);

  // ---- 1. the implementation
  const known = up.implementations.TokenSale;
  let implementation: string;
  if (
    known &&
    (await hre.ethers.provider.getCode(known.current)) !== "0x" &&
    (await isBuildOf(d, "TokenSale", known.current))
  ) {
    implementation = known.current;
    log(`[1/2] skip   deploy the TokenSale implementation (recorded ${implementation})`);
  } else if (await isBuildOf(d, "TokenSale", current)) {
    implementation = current;
    up.implementations.TokenSale = { previous: known?.previous ?? current, current };
    log(`[1/2] skip   TokenSale already runs this build (${current})`);
  } else {
    await validate(d, "TokenSale");
    if (!sends) {
      log(`[1/2] would  deploy the TokenSale implementation (storage layout checked against ${current}: compatible)`);
      implementation = ZeroAddress;
    } else {
      log(`[1/2] sign   deploy the TokenSale implementation (a contract creation, no proxy call yet)`);
      const factory = await factoryOf(d, "TokenSale");
      implementation = getAddress(
        (await hre.upgrades.prepareUpgrade(proxy, factory, {
          kind: "uups",
          unsafeAllow: [...unsafeAllowOf("TokenSale")],
          timeout: 0,
        })) as string,
      );
      await d.settle();
      up.implementations.TokenSale = {
        previous: known?.previous ?? current,
        current: implementation,
      } satisfies UpgradedImplementation;
      d.save();
      log(`[1/2] done   TokenSale implementation ${implementation}`);
      if (opts.stopAfter === "impl:TokenSale") return stop(d, up);
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

  const before = await stateOf(await attachable(d, "TokenSale"));
  up.via = route.via;
  if (pending) {
    if (!(await runVia(d, up, route, [call], { stopAfter: opts.stopAfter, wait: opts.wait }))) return up;
  }

  // ---- 3. verify and record (only now: the call is confirmed)
  if (!(await call.done())) throw new Error(`${call.id}: the transaction went through but the state does not match`);
  const slot = await slotImplementation(d, proxy);
  if (slot !== getAddress(implementation))
    throw new Error(`The implementation slot holds ${slot}, expected ${implementation}`);
  const sale = await attachable(d, "TokenSale");
  const after = await stateOf(sale);
  for (const key of Object.keys(before))
    if (before[key] !== after[key])
      throw new Error(`TokenSale.${key} changed by the upgrade: ${before[key]} -> ${after[key]}`);
  const next = await sale.nextSaleAt(ZeroAddress);
  if (next !== 0n) throw new Error(`nextSaleAt of an account that never sold is ${next}, expected 0`);
  const c = d.record.contracts.TokenSale!;
  if (c.implementation !== getAddress(implementation)) delete c.verified;
  c.implementation = getAddress(implementation);
  if (d.dir) await exportAbi(hre, d.dir, "TokenSale", ARTIFACT.TokenSale);
  up.completedAt = new Date().toISOString();
  up.block = await hre.ethers.provider.getBlockNumber();
  d.save();
  log(
    `TokenSale upgrade complete (${route.via}): TokenSale ${implementation}; run task:deploy:verify for the new implementation`,
  );
  return up;
}

function stop(d: Deployment, up: UpgradeRecord): UpgradeRecord {
  d.save();
  d.log("Stopped (--stop-after); run again to resume.");
  return up;
}

/** Everything the dry-run shows the person who will sign: each path, with the role it needs. */
function printSigning(d: Deployment, proxy: string, implementation: string, call: Call, route: Route): void {
  const { log } = d;
  const impl = implementation === ZeroAddress ? "<new implementation, known after the deployment>" : implementation;
  log("What is signed (the connected account approves each transaction on the device):");
  log("  all paths:");
  log(`    tx 1  contract creation of the TokenSale implementation (any account, no proxy touched)`);
  log("  the sender holds UPGRADER_ROLE on the TokenSale:");
  log(`    tx 2  to ${proxy}  upgradeToAndCall(${impl}, 0x)   calldata ${call.data}`);
  log("  a timelock holds UPGRADER_ROLE and the sender proposes:");
  log(`    tx 2  timelock.scheduleBatch([${proxy}], [0], [${call.data}], 0x0, <salt>, <delay>)  by a PROPOSER`);
  log(`    tx 3  timelock.executeBatch(the same batch) by an EXECUTOR after the delay`);
  log("  a timelock holds UPGRADER_ROLE and the Safe proposes:");
  log(`    two Transaction Builder files in deployments/safe/: schedule now, execute after the delay`);
  log(`  this run would take the ${route.via} path`);
  log(`  after it succeeds the record gets TokenSale.implementation and the TokenSale ABI is written again`);
}

export interface TokenSaleRow {
  status: "OK" | "DRIFT" | "INFO";
  item: string;
  want: string;
  have: string;
}

/**
 * Read-only status of the upgrade (`task:upgrade:tokensale --check`): does the proxy run the build the compiler
 * produces now, does the record name that implementation, and does `nextSaleAt` answer.
 */
export async function tokenSaleRows(d: Deployment): Promise<TokenSaleRow[]> {
  const rows: TokenSaleRow[] = [];
  const current = await implementationOf(d, "TokenSale");
  const build = await isBuildOf(d, "TokenSale", current);
  rows.push({
    status: build ? "OK" : "DRIFT",
    item: "TokenSale implementation is the current build (one sale per account and UTC day)",
    want: "current build",
    have: build ? `current build ${current}` : `older build ${current}`,
  });
  const recorded = d.record.contracts.TokenSale?.implementation;
  const same = recorded !== undefined && getAddress(recorded) === current;
  rows.push({
    status: same ? "OK" : "DRIFT",
    item: "TokenSale implementation equals the record",
    want: recorded ?? "recorded",
    have: current,
  });
  if (build) {
    const sale = await attachable(d, "TokenSale");
    const next = await sale.nextSaleAt(ZeroAddress);
    rows.push({
      status: next === 0n ? "OK" : "DRIFT",
      item: "nextSaleAt of an account that never sold is 0",
      want: "0",
      have: String(next),
    });
  }
  return rows;
}
