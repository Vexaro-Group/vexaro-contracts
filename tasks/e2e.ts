import { task, types } from "hardhat/config";

import { runE2e } from "./e2e/index";

task(
  "task:e2e",
  'End-to-end scenario on BSC testnet: --mode fork (full, on a fork with impersonation and time travel) or --mode live (the subset that needs no OPERATOR key and no time travel); docs/testnet.md "E2E runner"',
)
  .addParam("mode", "fork | live", undefined, types.string)
  .addOptionalParam(
    "report",
    "JSON report file (default: a file in the system temp directory)",
    undefined,
    types.string,
  )
  .addOptionalParam(
    "walletsOut",
    "live: file for the generated wallets' keys (mode 600, outside the repo, written before any transaction)",
    undefined,
    types.string,
  )
  .addOptionalParam("forkUrl", "fork: node to fork BSC testnet from (default: E2E_FORK_URL)", undefined, types.string)
  .addOptionalParam("forkBlock", "fork: block to fork at (default: head - 5)", undefined, types.int)
  .addOptionalParam("fundAmount", "live: tBNB sent to each fresh wallet", "0.006", types.string)
  .addOptionalParam(
    "maxSpend",
    "live: abort before any transaction when the deployer would spend more tBNB",
    "0.08",
    types.string,
  )
  .addOptionalParam(
    "rootSponsor",
    "smoke (the registered testnet user, default) | none | an address",
    "smoke",
    types.string,
  )
  .addOptionalParam("pools", "comma separated pool ids to stake in (default: all)", undefined, types.string)
  .addFlag(
    "impersonateDeployer",
    "live on a fork rehearsal: impersonate the deployer instead of using its key (refused off a fork)",
  )
  .addFlag("noSweep", "live: leave the wallets' leftover tBNB where it is instead of sending it back to the deployer")
  .setAction(async (args, hre) => {
    const { counts } = await runE2e(hre, args);
    if (counts.FAIL > 0 || counts.BLOCKED > 0) process.exitCode = 1;
  });
