import { ZeroAddress, getAddress, isAddress } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import type { DeployRecord } from "../deploy/types";
import { type RunConfig } from "./core";
import { Env, FORK_URL_ENV, type RunMode } from "./env";
import { runFork } from "./fork";
import { runLive } from "./live";
import { Runner, type StepResult, type StepStatus, str } from "./runner";
import { World } from "./world";

export interface E2eArgs {
  mode: string;
  report?: string;
  walletsOut?: string;
  forkUrl?: string;
  forkBlock?: number;
  fundAmount: string;
  maxSpend: string;
  rootSponsor: string;
  pools?: string;
  impersonateDeployer: boolean;
  noSweep: boolean;
}

export interface E2eHooks {
  /** Test hook: a deployment made on the in-process network instead of the BSC testnet record. */
  local?: DeployRecord;
  log?: (message: string) => void;
}

export interface E2eResult {
  counts: Record<StepStatus, number>;
  reportPath: string;
  report: Record<string, unknown> & { steps: StepResult[] };
}

export async function runE2e(hre: HardhatRuntimeEnvironment, args: E2eArgs, hooks: E2eHooks = {}): Promise<E2eResult> {
  if (args.mode !== "fork" && args.mode !== "live") throw new Error(`--mode must be fork or live, got ${args.mode}`);
  const mode: RunMode = args.mode;
  const log = hooks.log ?? ((message: string) => console.log(message));
  const startedAt = new Date().toISOString();
  const env = await Env.open(hre, {
    mode,
    impersonateDeployer: args.impersonateDeployer,
    forkUrl: args.forkUrl,
    forkBlock: args.forkBlock,
    local: hooks.local,
    log,
  });

  // alice's sponsor: the registered testnet user (the airdrop wallet), or the root
  let rootSponsor = ZeroAddress;
  if (args.rootSponsor === "smoke") {
    const smoke = String(await env.c.vex.airdropWallet());
    if (smoke !== ZeroAddress && (await env.c.network.isMember(smoke))) rootSponsor = getAddress(smoke);
  } else if (args.rootSponsor !== "none") {
    if (!isAddress(args.rootSponsor)) throw new Error(`--root-sponsor must be smoke, none or an address`);
    rootSponsor = getAddress(args.rootSponsor);
  }
  const cfg: RunConfig = {
    mode,
    rootSponsor,
    pools: args.pools ? args.pools.split(",").map((p) => Number(p.trim())) : undefined,
  };
  if (cfg.pools?.some((p) => !Number.isInteger(p) || p < 1)) throw new Error("--pools must be a list of pool ids");

  const reportPath = resolve(args.report ?? join(tmpdir(), `vexaro-e2e-${mode}-${Date.now()}.json`));
  const world = new World(env);
  let extra: Record<string, unknown> = {};
  const buildReport = (finished: boolean) => {
    const txs = runner.results.flatMap((r) => r.txs);
    return {
      task: "task:e2e",
      mode,
      complete: finished,
      chain: {
        id: 97,
        fork: env.fork,
        rpc: env.fork ? args.forkUrl ?? process.env[FORK_URL_ENV] ?? "unset" : hre.network.name,
      },
      startedAt,
      finishedAt: finished ? new Date().toISOString() : undefined,
      deployer: env.deployerAddress,
      rootSponsor,
      actors: Object.fromEntries([...world.actors.values()].map((a) => [a.name, a.address])),
      bnbFeedMocked: env.feedMocked,
      counts: runner.counts(),
      totalGas: txs.reduce((sum, t) => sum + BigInt(t.gasUsed), 0n).toString(),
      totalFeeWei: txs.reduce((sum, t) => sum + BigInt(t.feeWei), 0n).toString(),
      ...extra,
      steps: runner.results,
    };
  };
  const save = (finished: boolean) => {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      JSON.stringify(buildReport(finished), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
    );
  };
  // a live run is long: the report is rewritten after every step, a crash keeps what was done
  const runner = new Runner({
    settleMs: env.fork ? 0 : 1000,
    retries: env.fork ? 0 : 2,
    log,
    afterTx: env.fork ? undefined : (receipt) => env.awaitBlock(receipt.blockNumber),
    onStep: () => save(false),
  });
  log(`task:e2e ${mode} on ${env.fork ? "a fork of BSC testnet" : "BSC testnet"}, root sponsor ${rootSponsor}`);
  if (mode === "fork") {
    await runFork(runner, world, cfg, args);
  } else {
    extra = await runLive(runner, world, cfg, args);
  }
  const counts = runner.counts();
  const feeWei = runner.results.flatMap((r) => r.txs).reduce((sum, t) => sum + BigInt(t.feeWei), 0n);
  save(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));

  log("\n" + runner.table());
  log(
    `\n${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join("  ")}`,
  );
  log(`transactions: ${runner.results.reduce((n, r) => n + r.txs.length, 0)}, fees ${str(feeWei)} wei`);
  log(`report: ${reportPath}`);
  return { counts, reportPath, report };
}
