import { readFileSync } from "fs";
import { task, types } from "hardhat/config";

import { type AdminCallSpec, runAdminCalls } from "./deploy/adminCalls";
import { openDeployment } from "./deploy/engine";
import { loadParams } from "./deploy/params";
import { moveDelay, moveRows, runGovernanceMove } from "./deploy/timelockMove";
import { withCommon } from "./deployAll";

withCommon(
  task(
    "task:governance:timelock",
    "After a safe-mode hand-over: the governance roles (DEFAULT_ADMIN, UPGRADER, the VEX managers) move from the Safe to a TimelockController the Safe alone proposes to; the deployer signs everything and leaves last (docs/deploy.md section 17)",
  ),
)
  .addFlag("dryRun", "print every transaction the deployer signs, with its gas, and send nothing")
  .addFlag("check", "read-only status of the move; exit 1 while anything is pending")
  .addOptionalParam("delay", "timelock delay in seconds (default: params timelockDelay)", undefined, types.int)
  .addFlag("allowOtherDelay", "mainnet: accept a delay other than 24 hours")
  .addOptionalParam(
    "stopAfter",
    "stop after this step id (deploy:timelock, grant:<Contract>.<ROLE>, revoke:<Contract>.<ROLE>); the next run resumes",
    undefined,
    types.string,
  )
  .addOptionalParam(
    "logChunk",
    "block range per log query of the check for other holders of the timelock (public RPCs cap it)",
    "5000",
    types.string,
  )
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: args.check ? "check" : args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
    });
    const options = {
      delay: args.delay,
      allowOtherDelay: args.allowOtherDelay,
      stopAfter: args.stopAfter,
      logChunk: Number(args.logChunk),
    };
    if (args.check) {
      const rows = await moveRows(d, moveDelay(d, options), options.logChunk);
      for (const r of rows)
        d.log(
          `  ${r.status.padEnd(5)} ${(r.group + ": " + r.item).padEnd(100)} ${
            r.status === "OK" ? r.have : `want ${r.want} have ${r.have}`
          }`,
        );
      const drift = rows.filter((r) => r.status === "DRIFT").length;
      d.log(`${rows.length - drift} OK/INFO, ${drift} DRIFT`);
      if (drift > 0) throw new Error(`${drift} item(s) drifted: the governance move is pending or incomplete`);
      return;
    }
    await runGovernanceMove(d, options);
  });

withCommon(
  task(
    "task:governance:call",
    "Wraps admin calls into the two Safe Transaction Builder files that run them through the timelock (scheduleBatch, then executeBatch after the delay), or the file that cancels them; sends nothing (docs/deploy.md section 17)",
  ),
)
  .addParam("id", "name of the operation: names the files and, with the calls, the operation", undefined, types.string)
  .addOptionalParam(
    "calls",
    'JSON file: [{ "contract": "Rewards", "function": "setWholeBalanceWhenHalfBelowMin", "args": [false] }, ...]',
    undefined,
    types.string,
  )
  .addOptionalParam("salt", "salt of the operation (default: the hash of the id)", undefined, types.string)
  .addFlag("check", "read-only: is the operation pending, ready or done; writes nothing")
  .addFlag("cancel", "write the file that cancels the scheduled operation")
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    // reads the chain only: the files are the output, the Safe's owners are the signers
    const d = await openDeployment(hre, {
      params,
      mode: "check",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
      anySigner: true,
    });
    if (!args.calls) throw new Error("--calls <file> is required");
    const specs = JSON.parse(readFileSync(args.calls, "utf8")) as AdminCallSpec[];
    if (!Array.isArray(specs)) throw new Error(`${args.calls} must hold a JSON array of calls`);
    const result = await runAdminCalls(d, {
      id: args.id,
      calls: specs,
      salt: args.salt,
      check: args.check,
      cancel: args.cancel,
    });
    if (args.check && result.state !== "done")
      throw new Error(`The operation is ${result.state}${result.state === "unscheduled" ? "" : " (not executed yet)"}`);
  });
