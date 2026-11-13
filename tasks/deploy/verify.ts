import { vars } from "hardhat/config";

import type { Deployment } from "./context";
import type { ContractName } from "./types";

const ARGS: Partial<Record<ContractName, (d: Deployment) => unknown[]>> = {
  Vexaro: (d) => [d.deployer, d.deployer, 0],
  License: (d) => [d.deployer, d.params.licenseBaseUri],
  TimelockController: (d) => {
    const h = d.record.handover;
    return [h?.timelockDelay, [h?.multisig], [h?.multisig], "0x" + "00".repeat(20)];
  },
};

/**
 * Verifies the plain contracts and the implementations of the UUPS proxies on Etherscan V2 (BscScan), through
 * hardhat-verify. One Etherscan.io key serves every chain (`etherscan.apiKey` in hardhat.config.ts, the hardhat var
 * ETHERSCAN_API_KEY); BscScan's own keys are not accepted any more. Failures are reported, never fatal: the deployment
 * is already on chain, `task:deploy:verify` retries. Skipped with a note when there is no key. The proxies themselves
 * are not touched here: link them with `hardhat verify <proxy>` or "Is this a proxy?" on BscScan (docs/deploy.md).
 */
export async function verifyContracts(d: Deployment): Promise<void> {
  if (d.local) {
    d.log("Verification skipped on a local network.");
    return;
  }
  if (!d.hre.config.etherscan.apiKey) {
    d.log(
      "Verification skipped: no ETHERSCAN_API_KEY (an Etherscan API V2 key, valid for BSC too: " +
        "`hardhat vars set ETHERSCAN_API_KEY`, then run task:deploy:verify)." +
        (vars.has("BSCSCAN_API_KEY") ? " BSCSCAN_API_KEY is no longer used: BscScan keys do not work with V2." : ""),
    );
    return;
  }
  for (const [name, c] of Object.entries(d.record.contracts) as [
    ContractName,
    NonNullable<Deployment["record"]["contracts"][ContractName]>,
  ][]) {
    if (c.external || c.verified || name === "BnbFeed") continue;
    const target = c.implementation ?? c.address;
    try {
      await d.hre.run("verify:verify", {
        address: target,
        constructorArguments: ARGS[name]?.(d) ?? [],
        ...(name === "Staking" ? { libraries: { StakingMath: d.addr("StakingMath") } } : {}),
        ...(name === "Network" ? { libraries: { NetworkFreeze: d.addr("NetworkFreeze") } } : {}),
      });
      c.verified = true;
      d.log(`verified ${name} at ${target}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already verified/i.test(message)) c.verified = true;
      else d.log(`WARNING could not verify ${name} at ${target}: ${message.split("\n")[0]}`);
    }
    d.save();
  }
}
