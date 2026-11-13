import { task } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("task:deployLicense", "Deploys License Contract")
  .addParam("admin", "admin address")
  .addOptionalParam("baseuri", "metadata base URI (the license id is appended)", "")
  .setAction(async function (taskArguments: TaskArguments, { ethers }) {
    const signers = await ethers.getSigners();
    const licenseFactory = await ethers.getContractFactory("License");
    console.log(`Deploying License with admin address ${taskArguments.admin}`);
    const license = await licenseFactory.connect(signers[0]).deploy(taskArguments.admin, taskArguments.baseuri);
    await license.waitForDeployment();
    console.log("License deployed to: ", await license.getAddress());
  });
