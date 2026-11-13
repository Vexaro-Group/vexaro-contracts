/** Everything that differs between networks. Amounts are bigint wei (VEX and USDT are 18 dp), never floats. */
export interface DeployParams {
  /** Chain the params are for; the run refuses another chain. */
  chainId: number;
  /** Existing USDT; omitted = a TestUSDT is deployed (test networks only, never on chain 56). */
  usdt?: string;
  /** Chainlink BNB/USD feed; `address` omitted = a MockAggregatorV3 at 600 USD is deployed (local only). */
  bnbFeed: { address?: string; maxAge: number };
  /** VEX burn fee in bps, switched on as the last step once every exemption is in place. */
  vexFeeBps: number;
  /** Where `PriceFeed.vexPrice()` comes from; `manual` / `adapter` are staged when given. */
  vexPrice: { mode: "ROUND" | "MANUAL" | "ADAPTER"; manual?: bigint; adapter?: string };
  /** OPERATOR and EXIT_PAUSER holder, proposer / executor / canceller of the timelock (the Safe on mainnet). */
  multisig: string;
  /** True when the multisig must be a contract (the Safe); false for the EOA stand-in of a test network. */
  multisigIsContract: boolean;
  /** GUARDIAN holder on every contract that has the role (the signer-server key; the deployer on the testnet). */
  guardian: string;
  /**
   * How the governance roles are handed over: `timelock` (default) deploys a TimelockController and gives it
   * DEFAULT_ADMIN / UPGRADER and the VEX managers; `safe` gives them directly to the
   * multisig (the Safe) and the deployer keeps DEFAULT_ADMIN as a backup until `--renounce-admin`.
   */
  handoverMode?: HandoverMode;
  /**
   * Seconds. The delay of the TimelockController of the `timelock` hand-over mode (48 h on a mainnet timelock hand-over)
   * and of the governance move after a `safe` hand-over (24 h on mainnet, `task:governance:timelock`).
   */
  timelockDelay: number;
  /**
   * `safe` mode: the governance roles still have to move from the Safe to a TimelockController (`task:governance:timelock`)
   * before the deployer leaves; `--renounce-admin` refuses until they have.
   */
  timelockGovernance?: boolean;
  /** `License` base URI (the admin changes it later through the timelock). */
  licenseBaseUri: string;
  treasury: {
    /** Split of every payment; the rest goes to the reserve. Empty = everything to the reserve. */
    wallets: { account: string; rateBps: number }[];
    /** USDT in the Treasury reserve (sell-back payouts, License Rewards). */
    reserveUsdt: bigint;
  };
  /** Extra VEX fee-exempt accounts (DEX pair / router, CEX hot wallets, the treasury wallet). */
  exemptions: string[];
  /** Receives the rest of the 1B VEX supply once the contracts are funded; must be in `exemptions`. */
  vexRemainderTo: string;
  /** Daily limits in USDT wei, OPERATOR-tunable afterwards. */
  caps: { rewardVex: bigint; refundUsdt: bigint };
  /** TokenSale `sellAtCurrentPrice`: fee (bps, at most 1 000) and the per-account / global daily caps on the net payout. */
  currentSell: { feeBps: number; accountCapUsdt: bigint; globalCapUsdt: bigint };
  wholeBalanceWhenHalfBelowMin: boolean;
  /**
   * The fixed part of the USDT reserve floor of `TokenSale.sellAtCurrentPrice`, on top of the License
   * Rewards still owed. DEFAULT_ADMIN (the timelock) changes it later; 0 when omitted.
   */
  reserveFloorFixedUsdt?: bigint;
  /** GUARDIAN freezes allowed per UTC day, OPERATOR tunes it later; 50 when omitted. */
  guardianFreezeBudget?: number;
  /** Network rate tables and levels per tier Lite..Ultra. */
  network: {
    ncRates: number[];
    lrRates: number[];
    backFlow: { bps: number; levels: number };
    tierLevels: { nc: number[]; lr: number[] };
  };
  /** LicenseSale list prices: tier 1..4 (Basic..Ultra) x term 30 / 180 / 360, USDT wei. */
  licensePrices: { tier: number; term: number; usdt: bigint }[];
  /** TokenSale rounds in order: price = USDT wei per VEX. */
  rounds: { price: bigint; allocation: bigint }[];
  activeRound: number;
  /** Round inventory the OPERATOR pulls from the deployer. */
  roundFunding: { round: number; amount: bigint }[];
  /** VEX the OPERATOR puts into the reward vault and Jump. */
  funding: { rewardsVault: bigint; jump: bigint };
  /** The only wallet that sends airdrops: set on the token, fee-exempt, its sends create airdrop locks. */
  airdropWallet: string;
  /** VEX moved to the airdrop wallet from the supply holder at deploy (1.5 % of the supply on mainnet). */
  airdropAmount: bigint;
  /** Test-token faucet mints to these accounts (only when the engine deploys the TestUSDT). */
  usdtMints: { to: string; amount: bigint }[];
  /** `all` launches every pool (testnet), `goLive` only those marked in stakingPools.ts. */
  launch: "all" | "goLive";
}

export type ParamsFactory = (ctx: { signers: string[] }) => DeployParams;

export type ContractName =
  | "Vexaro"
  | "License"
  | "USDT"
  | "BnbFeed"
  | "StakingMath"
  | "NetworkFreeze"
  | "Treasury"
  | "Network"
  | "PriceFeed"
  | "TokenSale"
  | "Staking"
  | "LicenseSale"
  | "Rewards"
  | "Jump"
  | "TimelockController";

/** UUPS contracts behind an ERC1967 proxy. */
export const PROXY_CONTRACTS: ContractName[] = [
  "Treasury",
  "Network",
  "PriceFeed",
  "TokenSale",
  "Staking",
  "LicenseSale",
  "Rewards",
  "Jump",
];

/** Contracts with roles, in deploy order. */
export const ROLE_CONTRACTS: ContractName[] = [
  "Vexaro",
  "License",
  "Treasury",
  "Network",
  "PriceFeed",
  "TokenSale",
  "Staking",
  "LicenseSale",
  "Rewards",
  "Jump",
];

export interface ContractRecord {
  address: string;
  /** UUPS contracts: the implementation behind the proxy at deploy time. */
  implementation?: string;
  /** Path of the ABI file relative to the deployments directory; absent for an external USDT / feed. */
  abi?: string;
  /** An address that was not deployed by this run (the real USDT, the Chainlink feed). */
  external?: boolean;
  deployBlock?: number;
  txHash?: string;
  /** Etherscan V2 (BscScan) verification of the implementation / contract. */
  verified?: boolean;
}

export interface StepRecord {
  id: string;
  status: "done" | "already-on-chain";
  block?: number;
  txHashes: string[];
  at: string;
}

export type HandoverMode = "timelock" | "safe";

/** The delay of the mainnet governance timelock: 24 hours. */
export const GOVERNANCE_TIMELOCK_DELAY = 24 * 3600;

/** Block and transactions of a group of hand-over calls (accumulated over resumed runs). */
export interface HandoverTxs {
  /** Block of the last transaction. */
  block: number;
  txHashes: string[];
}

/**
 * The hand-over. `mode` is absent in a record written by the timelock hand-over (read it as `timelock`). In `safe` mode
 * there is no `timelock` / `timelockDelay`; `multisig` still names the Safe, so a reader of `multisig` keeps working.
 */
export interface HandoverRecord {
  mode?: HandoverMode;
  multisig: string;
  /** `safe` mode: the Safe, the same address as `multisig`. */
  safe?: string;
  /** `safe` mode: owners and threshold of the Safe as read when the hand-over ran (absent for an EOA stand-in). */
  safeOwners?: { owners: string[]; threshold: number };
  /** The timelock that holds the governance roles: the one of the `timelock` mode, or the one a `safe` hand-over moved them to. */
  timelock?: string;
  timelockDelay?: number;
  /**
   * Who holds the governance roles (DEFAULT_ADMIN, UPGRADER, the VEX managers). Absent: what `mode` says (the Safe in
   * `safe` mode, the timelock in `timelock` mode). `timelock` after `task:governance:timelock` moved them from the Safe.
   */
  governance?: "safe" | "timelock";
  /** The governance move: every transaction of the timelock deployment, the grants and the revokes (accumulated over resumed runs). */
  governanceMoveAt?: HandoverTxs;
  granted: boolean;
  completed: boolean;
  block?: number;
  /** `safe` mode: the grants and renounces of the hand-over. */
  at?: HandoverTxs;
  /** `safe` mode: the account that still holds DEFAULT_ADMIN on every contract as a backup; null once renounced. */
  adminKeptBy?: string | null;
  /** The `--renounce-admin` step: every transaction in which the deployer gave a role up. */
  renouncedAdminAt?: HandoverTxs;
  /** The roles of that step, as `<Contract>.<ROLE>`. */
  renouncedRoles?: string[];
  /** Grants the Safe has to make before the deployer can leave a role (a Safe batch file). */
  exitSafe?: SafeBatch;
}

/** One implementation swap of a proxy. */
export interface UpgradedImplementation {
  previous: string;
  current: string;
  /** Deployment of `current`. */
  txHash?: string;
  /** Block of that deployment (a library that replaces the recorded one). */
  deployBlock?: number;
}

/** A timelock operation (schedule + execute) that carries an upgrade after the hand-over. */
export interface TimelockOperation {
  /** `hashOperationBatch` of the batch. */
  operationId: string;
  salt: string;
  scheduledAt: string;
  scheduleTxHash: string;
  /** Unix seconds from which `executeBatch` works. */
  readyAt: number;
  executedAt?: string;
  executeTxHash?: string;
}

/** A Safe Transaction Builder batch that carries an upgrade after a `safe` mode hand-over. */
export interface SafeBatch {
  /** Path relative to the deployments directory. */
  file: string;
  safe: string;
  createdAt: string;
  /** Ids of the calls in the file, in order. */
  calls: string[];
}

/** A timelock operation the Safe schedules and later executes, as two Transaction Builder files. */
export interface SafeTimelockOperation {
  /** `hashOperationBatch` of the batch. */
  operationId: string;
  salt: string;
  /** Seconds between the scheduling and the earliest execution. */
  delay: number;
  schedule: SafeBatch;
  execute: SafeBatch;
}

/** An upgrade of the deployed proxies (task:upgrade:*): which implementations replaced which, and how. */
export interface UpgradeRecord {
  /** Upgrade id, as stored in deployments/<network>.json (see the `*_UPGRADE_ID` constants in upgradeCore.ts). */
  id: string;
  startedAt: string;
  completedAt?: string;
  via?: "direct" | "timelock" | "safe" | "safe-timelock";
  implementations: Partial<Record<ContractName, UpgradedImplementation>>;
  /** First upgrade (kept in the record): the License Rewards still owed that the Network was seeded with (USDT wei, decimal). */
  licenseOwed?: string;
  timelock?: TimelockOperation;
  /** The batch file the Safe signs: where it is, which calls it carries. */
  safe?: SafeBatch;
  /** The Safe proposes the batch to the timelock: the two files and the operation they carry. */
  safeTimelock?: SafeTimelockOperation;
  /** A second batch for the Safe that can only run after the first (calls that need the new implementations). */
  followUp?: SafeBatch;
  txHashes: string[];
  block?: number;
}

export interface DeployRecord {
  schemaVersion: 1;
  network: string;
  chainId: number;
  deployer: string;
  createdAt: string;
  updatedAt: string;
  /** Digest of the params of the last run (sha256 of their canonical JSON): no secrets, only a drift marker. */
  paramsDigest: string;
  /** Every deploy / wiring / funding step is done on chain. */
  complete: boolean;
  contracts: Partial<Record<ContractName, ContractRecord>>;
  config: { multisig: string; guardian: string; timelockDelay: number };
  steps: StepRecord[];
  handover: HandoverRecord | null;
  /** Upgrades applied after the deployment, oldest first (`contracts.*.implementation` is the current one). */
  upgrades?: UpgradeRecord[];
}
