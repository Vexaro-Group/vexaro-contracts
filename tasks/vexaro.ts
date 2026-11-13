import { task } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("task:deployVexaro", "Deploys Vexaro.sol Contract")
  .addParam("recipient", "recipient address (receives the supply, fee-exempt)")
  .addOptionalParam("admin", "admin address (defaults to recipient)")
  .addOptionalParam("fee", "initial fee in bps, max 100", "0")
  .setAction(async function (taskArguments: TaskArguments, { ethers }) {
    const signers = await ethers.getSigners();
    const contractFactory = await ethers.getContractFactory("Vexaro");
    console.log(`Deploying Vexaro...`);
    const vexaro = await contractFactory
      .connect(signers[0])
      .deploy(taskArguments.recipient, taskArguments.admin ?? taskArguments.recipient, taskArguments.fee);
    await vexaro.waitForDeployment();
    console.log("Vexaro.sol deployed to: ", await vexaro.getAddress());
  });
