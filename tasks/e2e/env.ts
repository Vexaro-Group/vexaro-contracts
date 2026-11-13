import {
  Contract,
  type ContractTransactionResponse,
  type LogDescription,
  type Signer,
  type TransactionReceipt,
  Wallet,
} from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { join } from "path";

import { loadRecord } from "../deploy/record";
import type { ContractName, DeployRecord } from "../deploy/types";

/** The environment variable that names the node to fork BSC testnet from when `--fork-url` is not given. */
export const FORK_URL_ENV = "E2E_FORK_URL";

/** The contracts of the BSC testnet deployment, read-only handles (connect a signer to send). */
export interface Contracts {
  vex: Contract;
  license: Contract;
  usdt: Contract;
  treasury: Contract;
  network: Contract;
  priceFeed: Contract;
  tokenSale: Contract;
  staking: Contract;
  licenseSale: Contract;
  rewards: Contract;
  jump: Contract;
  timelock: Contract;
}

const ARTIFACTS: Array<[keyof Contracts, ContractName, string]> = [
  ["vex", "Vexaro", "Vexaro"],
  ["license", "License", "License"],
  ["usdt", "USDT", "TestUSDT"],
  ["treasury", "Treasury", "Treasury"],
  ["network", "Network", "Network"],
  ["priceFeed", "PriceFeed", "PriceFeed"],
  ["tokenSale", "TokenSale", "TokenSale"],
  ["staking", "Staking", "Staking"],
  ["licenseSale", "LicenseSale", "LicenseSale"],
  ["rewards", "Rewards", "Rewards"],
  ["jump", "Jump", "Jump"],
  ["timelock", "TimelockController", "TimelockController"],
];

export type RunMode = "fork" | "live";

export interface EnvOptions {
  mode: RunMode;
  impersonateDeployer: boolean;
  forkUrl?: string;
  forkBlock?: number;
  /**
   * Test hook: a deployment record made on the in-process network (test/tasks/E2e.ts deploys the system there). The
   * task never sets it; it skips the BSC testnet record, the chain-97 checks and the fork.
   */
  local?: DeployRecord;
  log: (message: string) => void;
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method} on ${url}: ${body.error.message}`);
  return body.result;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The chain the runner works on, the contracts, and the helpers that only exist on a fork (time, impersonation). */
export class Env {
  readonly fees: Record<string, bigint>;

  private constructor(
    readonly hre: HardhatRuntimeEnvironment,
    readonly opts: EnvOptions,
    readonly record: DeployRecord,
    readonly c: Contracts,
    /** True on the in-process hardhat network (a fork of BSC testnet): time travel and impersonation work. */
    readonly fork: boolean,
  ) {
    const gasPrice = hre.network.config.gasPrice;
    // the public testnet nodes refuse the tip ethers suggests: pay the 0.2 gwei flat the network config sets
    this.fees = !fork && typeof gasPrice === "number" ? { gasPrice: BigInt(gasPrice) } : {};
  }

  get provider() {
    return this.hre.ethers.provider;
  }

  get deployerAddress(): string {
    return this.record.deployer;
  }

  get multisig(): string {
    return this.record.config.multisig;
  }

  addr(name: keyof Contracts): string {
    return String(this.c[name].target);
  }

  /**
   * Opens the run: checks the chain, forks BSC testnet when asked, attaches every contract. Refuses every chain that
   * is not BSC testnet (97) - mainnet absolutely - and `--impersonate-deployer` anywhere but on a fork.
   */
  static async open(hre: HardhatRuntimeEnvironment, opts: EnvOptions): Promise<Env> {
    const name = hre.network.name;
    if (name !== "hardhat" && name !== "bscTestnet") {
      throw new Error(
        `task:e2e refuses network ${name}: it runs on a BSC testnet fork (hardhat) or on bscTestnet only`,
      );
    }
    if (opts.mode === "fork" && name !== "hardhat") throw new Error("--mode fork runs on --network hardhat");
    if (opts.mode === "live" && name === "hardhat" && !opts.impersonateDeployer) {
      throw new Error("--mode live on --network hardhat needs --impersonate-deployer (a fork rehearsal)");
    }
    if (opts.impersonateDeployer && name !== "hardhat") {
      throw new Error("--impersonate-deployer is refused off a fork: the live run signs with the configured key");
    }
    const record = opts.local ?? loadRecord(join(hre.config.paths.root, "deployments", "bscTestnet.json"));
    if (!record || (record.chainId !== 97 && !opts.local))
      throw new Error("deployments/bscTestnet.json (chain 97) not found");
    if (opts.local && name !== "hardhat") throw new Error("a local deployment record needs the in-process network");

    const fork = name === "hardhat";
    if (opts.local) {
      // the deployment is already on the in-process chain
    } else if (fork) {
      const url = opts.forkUrl ?? process.env[FORK_URL_ENV];
      if (!url) throw new Error(`a BSC testnet node to fork from is required: pass --fork-url or set ${FORK_URL_ENV}`);
      const sourceChain = Number(BigInt((await rpc(url, "eth_chainId")) as string));
      if (sourceChain !== 97) throw new Error(`fork source ${url} is chain ${sourceChain}, not BSC testnet (97)`);
      const head = Number(BigInt((await rpc(url, "eth_blockNumber")) as string));
      const blockNumber = opts.forkBlock ?? head - 5;
      opts.log(`forking BSC testnet at block ${blockNumber} (head ${head}) from ${url}`);
      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: url, blockNumber } }],
      });
    } else {
      const chain = (await hre.ethers.provider.getNetwork()).chainId;
      if (chain !== 97n) throw new Error(`connected chain is ${chain}, not BSC testnet (97)`);
    }

    const handles: Partial<Contracts> = {};
    for (const [key, contract, artifact] of ARTIFACTS) {
      const address = record.contracts[contract]?.address;
      if (!address) throw new Error(`${contract} missing from deployments/bscTestnet.json`);
      const { abi } = await hre.artifacts.readArtifact(artifact);
      handles[key] = new Contract(address, abi, hre.ethers.provider);
    }
    const env = new Env(hre, opts, record, handles as Contracts, fork);
    if ((await hre.ethers.provider.getCode(env.addr("tokenSale"))) === "0x") {
      throw new Error("TokenSale has no code on this chain: not the BSC testnet deployment");
    }
    return env;
  }

  async now(): Promise<number> {
    const block = await this.provider.getBlock("latest");
    if (!block) throw new Error("no latest block");
    return block.timestamp;
  }

  /** Mines a block at `timestamp` (fork only); later transactions continue from there. */
  async warpTo(timestamp: number): Promise<void> {
    this.requireFork("time travel");
    await this.hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
    await this.hre.network.provider.send("evm_mine", []);
  }

  async warpBy(seconds: number): Promise<number> {
    const to = (await this.now()) + seconds;
    await this.warpTo(to);
    return to;
  }

  async setBalance(address: string, wei: bigint): Promise<void> {
    this.requireFork("hardhat_setBalance");
    await this.hre.network.provider.send("hardhat_setBalance", [address, "0x" + wei.toString(16)]);
  }

  /** A funded signer for `address` that needs no key (fork only). */
  async impersonate(address: string, minBalance = 10n ** 21n): Promise<Signer> {
    this.requireFork("impersonation");
    // top up only when the account holds less: a live rehearsal keeps the deployer's real tBNB so the spend guard is real
    if ((await this.provider.getBalance(address)) < minBalance) await this.setBalance(address, minBalance);
    return this.hre.ethers.getImpersonatedSigner(address);
  }

  requireFork(what: string): void {
    if (!this.fork) throw new Error(`${what} is only possible on a fork`);
  }

  newWallet(): Wallet {
    return new Wallet(Wallet.createRandom().privateKey, this.provider);
  }

  wallet(privateKey: string): Wallet {
    return new Wallet(privateKey, this.provider);
  }

  /** The configured deployer: the network's key on bscTestnet, the impersonated deployer on a fork rehearsal. */
  async deployerSigner(): Promise<Signer> {
    if (this.fork)
      return this.impersonate(this.deployerAddress, this.opts.mode === "live" ? 2n * 10n ** 17n : 10n ** 21n);
    const [signer] = await this.hre.ethers.getSigners();
    if (!signer)
      throw new Error("no deployer key: set HARDHAT_VAR_TESTNET_DEPLOYER_KEY (hardhat var TESTNET_DEPLOYER_KEY)");
    const address = await signer.getAddress();
    if (address.toLowerCase() !== this.deployerAddress.toLowerCase()) {
      throw new Error(
        `the configured key is ${address}, the deployment's deployer / GUARDIAN is ${this.deployerAddress}`,
      );
    }
    return signer;
  }

  as(contract: Contract, signer: Signer): Contract {
    return contract.connect(signer) as Contract;
  }

  /** Waits until the node that serves the reads has block `number` (public RPCs sit behind load balancers). */
  async awaitBlock(number: number, tries = 10): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if ((await this.provider.getBlockNumber()) >= number) return;
      await sleep(1000);
    }
  }

  /** Waits (a few blocks at most) until a read sees `condition`; public RPCs lag a block behind the last receipt. */
  async until<T>(read: () => Promise<T>, condition: (value: T) => boolean, tries = 6): Promise<T> {
    let value = await read();
    for (let i = 0; i < tries && !condition(value); i++) {
      await sleep(1500);
      value = await read();
    }
    return value;
  }

  /** The Chainlink BNB/USD feed: the answer, decimals and age as the PriceFeed sees them. */
  async feedStatus(): Promise<{ address: string; updatedAt: number; maxAge: number; age: number; fresh: boolean }> {
    const address = String(await this.c.priceFeed.bnbFeed());
    const maxAge = Number(await this.c.priceFeed.bnbMaxAge());
    const feed = new Contract(
      address,
      ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"],
      this.provider,
    );
    const round = await feed.latestRoundData();
    const updatedAt = Number(round[3]);
    const now = await this.now();
    return { address, updatedAt, maxAge, age: now - updatedAt, fresh: now - updatedAt <= maxAge };
  }

  /**
   * BNB price for a BNB payment. A fork replaces a stale feed's code at its address with `MockAggregatorV3` (answer =
   * the last real answer, updated now) and refreshes it after later time travel; a live chain cannot, so it returns
   * undefined and the step reports SKIPPED-STALE-FEED.
   */
  async bnbPrice(): Promise<{ price: bigint; mocked: boolean } | undefined> {
    try {
      return { price: BigInt(await this.c.priceFeed.bnbPrice()), mocked: this.feedMocked };
    } catch {
      if (!this.fork) return undefined;
    }
    const status = await this.feedStatus().catch(() => undefined);
    const address = status?.address ?? String(await this.c.priceFeed.bnbFeed());
    const provider = this.hre.network.provider;
    const deployer = await this.deployerSigner();
    if (!this.feedMocked) {
      let answer = 600n * 10n ** 8n;
      try {
        const feed = new Contract(
          address,
          ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"],
          this.provider,
        );
        const round = await feed.latestRoundData();
        if (BigInt(round[1]) > 0n) answer = BigInt(round[1]);
      } catch {
        // keep the default answer
      }
      const { deployedBytecode } = await this.hre.artifacts.readArtifact("MockAggregatorV3");
      await provider.send("hardhat_setCode", [address, deployedBytecode]);
      for (let slot = 0; slot < 6; slot++) {
        await provider.send("hardhat_setStorageAt", [address, "0x" + slot.toString(16), "0x" + "00".repeat(32)]);
      }
      const mock = new Contract(
        address,
        ["function setDecimals(uint8)", "function set(int256)", "function answer() view returns (int256)"],
        deployer,
      );
      await (await mock.setDecimals(8)).wait();
      await (await mock.set(answer)).wait();
      this.feedMocked = true;
      this.opts.log(
        `  (fork) BNB/USD feed ${address} was stale: its code is replaced by MockAggregatorV3, answer ${answer}`,
      );
    } else {
      const mock = new Contract(address, ["function set(int256)", "function answer() view returns (int256)"], deployer);
      await (await mock.set(await mock.answer())).wait();
    }
    return { price: BigInt(await this.c.priceFeed.bnbPrice()), mocked: true };
  }

  feedMocked = false;

  /** Executes `data` on `target` through the real timelock (fork only): schedule by the multisig, wait, execute. */
  async viaTimelock(target: string, data: string, label: string): Promise<TransactionReceipt> {
    this.requireFork("the timelock path");
    const multisig = await this.impersonate(this.multisig);
    const timelock = this.as(this.c.timelock, multisig);
    const delay = BigInt(await this.c.timelock.getMinDelay());
    const salt =
      "0x" +
      BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000))
        .toString(16)
        .padStart(64, "0");
    const zero = "0x" + "00".repeat(32);
    await (await timelock.schedule(target, 0, data, zero, salt, delay)).wait();
    await this.warpBy(Number(delay) + 1);
    const response = (await timelock.execute(target, 0, data, zero, salt)) as ContractTransactionResponse;
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`timelock execution of ${label} failed`);
    return receipt;
  }
}

/** The decoded logs of `receipt` emitted by `contract` (all of them, or only those named `name`). */
export function logsOf(receipt: TransactionReceipt, contract: Contract, name?: string): LogDescription[] {
  const out: LogDescription[] = [];
  const address = String(contract.target).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address) continue;
    let parsed: LogDescription | null = null;
    try {
      parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (parsed && (name === undefined || parsed.name === name)) out.push(parsed);
  }
  return out;
}
