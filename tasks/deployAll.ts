import { task, types } from "hardhat/config";

import { openDeployment, runCheck, runDeploy } from "./deploy/engine";
import { runHandover } from "./deploy/handover";
import { loadParams } from "./deploy/params";
import {
  LARGEST_STAKE_UPGRADE_ID,
  NETWORK_UPGRADE_ID,
  RELEASE_UPGRADE_ID,
  STAKING_UPGRADE_ID,
  TOKEN_SALE_UPGRADE_ID,
  logOperation,
} from "./deploy/upgradeCore";
import { largestStakeRows, runUpgradeLargestStake } from "./deploy/upgradeLargestStake";
import { networkRows, runUpgradeNetwork } from "./deploy/upgradeNetwork";
import { releaseRows, runUpgradeRelease } from "./deploy/upgradeRelease";
import { runUpgradeStaking, stakingRows } from "./deploy/upgradeStaking";
import { runUpgradeTokenSale, tokenSaleRows } from "./deploy/upgradeTokenSale";
import { verifyContracts } from "./deploy/verify";

export const withCommon = <T extends ReturnType<typeof task>>(t: T): T => {
  t.addOptionalParam("paramsFile", "params file (default deploy/params/<network>.ts)", undefined, types.string);
  t.addOptionalParam(
    "deploymentsDir",
    "directory of <network>.json and abis/ (default deployments/)",
    undefined,
    types.string,
  );
  t.addOptionalParam("deployer", "deployer address for a dry-run without a Ledger connected", undefined, types.string);
  return t;
};

withCommon(task("task:deploy:all", "Deploys, wires and funds the whole system; idempotent, resumable (docs/deploy.md)"))
  .addFlag("dryRun", "print every step and parameter, send nothing")
  .addFlag("noVerify", "skip the Etherscan V2 (BscScan) verification")
  .addOptionalParam("stopAfter", "stop after this step id (the next run resumes)", undefined, types.string)
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const result = await runDeploy(hre, {
      params,
      mode: args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
      stopAfter: args.stopAfter,
      verify: !args.noVerify,
    });
    return result.addresses;
  });

withCommon(
  task("task:deploy:check", "Read-only: every wired value, limit and role holder vs the params; exit 1 on drift"),
)
  .addFlag("holders", "also replay the RoleGranted events to find holders outside the expected set")
  .addOptionalParam("logChunk", "block range per log query (public RPCs cap it)", "5000", types.string)
  .addOptionalParam(
    "holdersFrom",
    "first block of the --holders scan (default: the deploy block of each contract); only the grants since then are replayed",
    undefined,
    types.int,
  )
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: "check",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
    });
    const result = await runCheck(d, {
      holders: args.holders,
      holdersFrom: args.holdersFrom,
      chunk: Number(args.logChunk),
    });
    if (result.check!.drift > 0) throw new Error(`${result.check!.drift} item(s) drifted from the params`);
  });

withCommon(
  task(
    "task:deploy:verify",
    "Verifies the recorded contracts on Etherscan V2 (BscScan; retry after a failed verification)",
  ),
).setAction(async (args, hre) => {
  const params = await loadParams(hre, args.paramsFile);
  const d = await openDeployment(hre, {
    params,
    mode: "check",
    deployer: args.deployer,
    deploymentsDir: args.deploymentsDir,
    writeRecord: true,
  });
  await verifyContracts(d);
});

withCommon(
  task(
    "task:deploy:handover",
    "Roles to the timelock / multisig / guardian (params handoverMode `safe`: straight to the Safe, the deployer keeps DEFAULT_ADMIN), then the deployer renounces",
  ),
)
  .addFlag("dryRun", "print the grants and renounces and the Safe's owners / threshold, send nothing")
  .addFlag("grantOnly", "deploy the timelock (timelock mode) and grant, keep the deployer's roles")
  .addFlag("renounceOnly", "renounce only (after --grant-only); refuses if a target lacks a role")
  .addFlag(
    "renounceAdmin",
    "the later step: the deployer leaves every role it holds (DEFAULT_ADMIN last); refuses until the release upgrade is verified and the Safe holds every role that is still needed",
  )
  .addFlag("allowSingleOwner", "safe mode: accept a Safe whose threshold is 1 (otherwise a run that sends refuses)")
  .addOptionalParam(
    "logChunk",
    "block range per log query of the scan that finds the deployer's roles (public RPCs cap it)",
    "5000",
    types.string,
  )
  .addFlag("skipLogScan", "--renounce-admin: look at the roles of the ABIs only, do not replay RoleGranted events")
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
    });
    await runHandover(d, {
      grantOnly: args.grantOnly,
      renounceOnly: args.renounceOnly,
      renounceAdmin: args.renounceAdmin,
      allowSingleOwner: args.allowSingleOwner,
      logChunk: Number(args.logChunk),
      skipLogScan: args.skipLogScan,
    });
  });

withCommon(
  task(
    "task:upgrade:network",
    "Upgrade of the Network (License Rewards as VEX on the cashback balance; docs/deploy.md): direct when the signer holds UPGRADER_ROLE, through the timelock otherwise; idempotent, resumable",
  ),
)
  .addFlag("dryRun", "check the layout, print what each path signs, send nothing")
  .addFlag("check", "read-only status: build, record, wiring; exit 1 when the upgrade is pending")
  .addFlag("wait", "timelock path: wait for the delay and execute (otherwise the run ends after scheduling)")
  .addOptionalParam(
    "stopAfter",
    "stop after this step id (impl:Network, upgrade:Network, schedule)",
    undefined,
    types.string,
  )
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: args.check ? "check" : args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
      anySigner: true,
    });
    if (args.check) {
      const rows = await networkRows(d);
      for (const r of rows)
        d.log(
          `  ${r.status.padEnd(5)} ${r.item.padEnd(78)} ${
            r.status === "OK" ? r.have : `want ${r.want} have ${r.have}`
          }`,
        );
      const drift = rows.filter((r) => r.status === "DRIFT").length;
      d.log(`${rows.length - drift} OK/INFO, ${drift} DRIFT`);
      await logOperation(d, NETWORK_UPGRADE_ID);
      if (drift > 0)
        throw new Error(`${drift} item(s) drifted: the network upgrade is pending or the wiring is incomplete`);
      return;
    }
    await runUpgradeNetwork(d, { stopAfter: args.stopAfter, wait: args.wait });
  });

withCommon(
  task(
    "task:upgrade:staking",
    "Upgrade of the Staking (airdrop stakes on hold until an admin releases them; new StakingMath library, AIRDROP_RELEASER_ROLE; docs/deploy.md): direct when the signer holds UPGRADER_ROLE and DEFAULT_ADMIN_ROLE, through the timelock otherwise; idempotent, resumable",
  ),
)
  .addFlag("dryRun", "check the layout, print what each path signs, send nothing")
  .addFlag("check", "read-only status: builds, record, role, held stakes; exit 1 when the upgrade is pending")
  .addFlag("wait", "timelock path: wait for the delay and execute (otherwise the run ends after scheduling)")
  .addOptionalParam(
    "stopAfter",
    "stop after this step id (impl:StakingMath, impl:Staking, upgrade:Staking, schedule)",
    undefined,
    types.string,
  )
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: args.check ? "check" : args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
      anySigner: true,
    });
    if (args.check) {
      const rows = await stakingRows(d);
      for (const r of rows)
        d.log(
          `  ${r.status.padEnd(5)} ${r.item.padEnd(90)} ${
            r.status === "OK" ? r.have : `want ${r.want} have ${r.have}`
          }`,
        );
      const drift = rows.filter((r) => r.status === "DRIFT").length;
      d.log(`${rows.length - drift} OK/INFO, ${drift} DRIFT`);
      await logOperation(d, STAKING_UPGRADE_ID);
      if (drift > 0)
        throw new Error(`${drift} item(s) drifted: the staking upgrade is pending or the wiring is incomplete`);
      return;
    }
    await runUpgradeStaking(d, { stopAfter: args.stopAfter, wait: args.wait });
  });

withCommon(
  task(
    "task:upgrade:largest-stake",
    "Upgrade of the Staking, Rewards and LicenseSale (cap base and withdrawal maximum from the LARGEST open stake, airdrop stakes eligible, batch release of the airdrop hold; new StakingMath library; docs/deploy.md): direct when the signer holds UPGRADER_ROLE on the three, a Safe batch file or the timelock otherwise; idempotent, resumable",
  ),
)
  .addFlag("dryRun", "check the layouts, print what each path signs and which cap bases move, send nothing")
  .addFlag("check", "read-only status: builds, record, cap bases; exit 1 when the upgrade is pending")
  .addFlag("wait", "timelock path: wait for the delay and execute (otherwise the run ends after scheduling)")
  .addOptionalParam(
    "stopAfter",
    "stop after this step id (impl:StakingMath, impl:<Name>, upgrade:<Name>, schedule)",
    undefined,
    types.string,
  )
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: args.check ? "check" : args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
      anySigner: true,
    });
    if (args.check) {
      const rows = await largestStakeRows(d);
      for (const r of rows)
        d.log(
          `  ${r.status.padEnd(5)} ${r.item.padEnd(90)} ${
            r.status === "OK" ? r.have : `want ${r.want} have ${r.have}`
          }`,
        );
      const drift = rows.filter((r) => r.status === "DRIFT").length;
      d.log(`${rows.length - drift} OK/INFO, ${drift} DRIFT`);
      await logOperation(d, LARGEST_STAKE_UPGRADE_ID);
      if (drift > 0)
        throw new Error(`${drift} item(s) drifted: the largest-stake upgrade is pending or the cap bases are stale`);
      return;
    }
    await runUpgradeLargestStake(d, { stopAfter: args.stopAfter, wait: args.wait });
  });

withCommon(
  task(
    "task:upgrade:release",
    "Upgrade of every contract whose build changed (Network + NetworkFreeze, TokenSale, Staking + StakingMath, Rewards, Jump, LicenseSale) in one atomic batch with the initializers, the Treasury revoke and the Smart two-halves flag; docs/deploy.md section 16: direct when the signer holds the roles, a Safe batch file or the timelock otherwise; idempotent, resumable",
  ),
)
  .addFlag("dryRun", "read the chain, run the pre-checks, check the layouts, print what is signed, send nothing")
  .addFlag(
    "check",
    "read-only status: builds, record, initializers and calls, Jump cycles; exit 1 while anything is pending",
  )
  .addFlag("wait", "timelock path: wait for the delay and execute (otherwise the run ends after scheduling)")
  .addFlag("allowOpenSmart", "test networks: go on although stakes of Smart are open (mainnet: refuses)")
  .addOptionalParam(
    "stopAfter",
    "stop after this step id (impl:NetworkFreeze, impl:StakingMath, impl:<Name>, upgrade:<Name>, schedule)",
    undefined,
    types.string,
  )
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: args.check ? "check" : args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
      anySigner: true,
    });
    if (args.check) {
      const rows = await releaseRows(d);
      for (const r of rows)
        d.log(
          `  ${r.status.padEnd(5)} ${r.item.padEnd(90)} ${
            r.status === "OK" ? r.have : `want ${r.want} have ${r.have}`
          }`,
        );
      const drift = rows.filter((r) => r.status === "DRIFT").length;
      d.log(`${rows.length - drift} OK/INFO, ${drift} DRIFT`);
      await logOperation(d, RELEASE_UPGRADE_ID);
      if (drift > 0) throw new Error(`${drift} item(s) drifted: the release upgrade is pending or incomplete`);
      return;
    }
    await runUpgradeRelease(d, { stopAfter: args.stopAfter, wait: args.wait, allowOpenSmart: args.allowOpenSmart });
  });

withCommon(
  task(
    "task:upgrade:tokensale",
    "Upgrade of the TokenSale (one sale per account and UTC day, `sell` and `sellAtCurrentPrice` together; docs/deploy.md): direct when the signer holds UPGRADER_ROLE, a Safe file pair through the timelock otherwise; idempotent, resumable",
  ),
)
  .addFlag("dryRun", "check the layout, print what each path signs, send nothing")
  .addFlag("check", "read-only status: build, record, nextSaleAt; exit 1 when the upgrade is pending")
  .addFlag("wait", "timelock path: wait for the delay and execute (otherwise the run ends after scheduling)")
  .addOptionalParam(
    "stopAfter",
    "stop after this step id (impl:TokenSale, upgrade:TokenSale, schedule)",
    undefined,
    types.string,
  )
  .setAction(async (args, hre) => {
    const params = await loadParams(hre, args.paramsFile);
    const d = await openDeployment(hre, {
      params,
      mode: args.check ? "check" : args.dryRun ? "dry-run" : "run",
      deployer: args.deployer,
      deploymentsDir: args.deploymentsDir,
      anySigner: true,
    });
    if (args.check) {
      const rows = await tokenSaleRows(d);
      for (const r of rows)
        d.log(
          `  ${r.status.padEnd(5)} ${r.item.padEnd(78)} ${
            r.status === "OK" ? r.have : `want ${r.want} have ${r.have}`
          }`,
        );
      const drift = rows.filter((r) => r.status === "DRIFT").length;
      d.log(`${rows.length - drift} OK/INFO, ${drift} DRIFT`);
      await logOperation(d, TOKEN_SALE_UPGRADE_ID);
      if (drift > 0) throw new Error(`${drift} item(s) drifted: the TokenSale upgrade is pending or incomplete`);
      return;
    }
    await runUpgradeTokenSale(d, { stopAfter: args.stopAfter, wait: args.wait });
  });
