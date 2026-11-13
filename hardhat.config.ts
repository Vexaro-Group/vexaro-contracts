import "@nomicfoundation/hardhat-ledger";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-deploy";
import type { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import type { NetworkUserConfig } from "hardhat/types";

import "./tasks/accounts";
import "./tasks/coverage";
import "./tasks/deployAll";
import "./tasks/e2e";
import "./tasks/governance";
import "./tasks/license";
import "./tasks/vexaro";

// Run 'npx hardhat vars setup' to see the list of variables that need to be set

// Optional so that compile / test / coverage run without any config var
const privateKey: string | undefined = vars.has("PRIVATE_KEY") ? vars.get("PRIVATE_KEY") : undefined;
// BSC mainnet signs with a Ledger only (`ledgerAccounts`), never with a key on disk: LEDGER_ACCOUNT is the address of
// the Ledger account that deploys. PRIVATE_KEY stays for the template's other networks.
const ledgerAccount: string | undefined = vars.has("LEDGER_ACCOUNT") ? vars.get("LEDGER_ACCOUNT") : undefined;
// BSC testnet only: a throwaway deployer key, read from the hardhat var / HARDHAT_VAR_TESTNET_DEPLOYER_KEY at run time
// (never in a file of the repo, never for another network). Without it bscTestnet uses the Ledger like mainnet.
const testnetDeployerKey: string | undefined = vars.has("TESTNET_DEPLOYER_KEY")
  ? vars.get("TESTNET_DEPLOYER_KEY")
  : undefined;
const infuraApiKey: string | undefined = vars.has("INFURA_API_KEY") ? vars.get("INFURA_API_KEY") : undefined;

// Optimizer runs of the three contracts that sit close to the EIP-170 limit (24 576 bytes); each is the highest count
// measured that leaves at least 300 bytes of headroom (docs/gas.md "Optimizer runs"). The test mocks that inherit them
// keep MOCK_RUNS so that they stay deployable with the functions they add.
const NETWORK_RUNS = 800;
const STAKING_RUNS = 169;
const TOKEN_SALE_RUNS = 210;
const MOCK_RUNS = 100;

const chainIds = {
  "arbitrum-mainnet": 42161,
  avalanche: 43114,
  bsc: 56,
  bscTestnet: 97,
  ganache: 1337,
  hardhat: 31337,
  mainnet: 1,
  "optimism-mainnet": 10,
  "polygon-mainnet": 137,
  "polygon-mumbai": 80001,
  sepolia: 11155111,
};

function getChainConfig(chain: keyof typeof chainIds): NetworkUserConfig {
  const testnetKey = chain === "bscTestnet" ? testnetDeployerKey : undefined;
  const useLedger = (chain === "bsc" || chain === "bscTestnet") && testnetKey === undefined;
  let jsonRpcUrl: string;
  switch (chain) {
    case "avalanche":
      jsonRpcUrl = "https://api.avax.network/ext/bc/C/rpc";
      break;
    case "bsc":
      jsonRpcUrl = vars.get("BSC_RPC_URL", "https://bsc-dataseed1.binance.org");
      break;
    case "bscTestnet":
      // the default node refuses eth_getLogs ("limit exceeded"): set BSC_TESTNET_RPC_URL (for example
      // https://bsc-testnet-rpc.publicnode.com) for `task:deploy:check --holders`
      jsonRpcUrl = vars.get("BSC_TESTNET_RPC_URL", "https://data-seed-prebsc-1-s1.bnbchain.org:8545");
      break;
    default:
      jsonRpcUrl = "https://" + chain + ".infura.io/v3/" + infuraApiKey;
  }
  return {
    accounts: testnetKey !== undefined ? [testnetKey] : !useLedger && privateKey !== undefined ? [privateKey] : [],
    chainId: chainIds[chain],
    // the public testnet RPCs suggest a 0.05 gwei tip and then refuse it (minimum 0.1 gwei): pay 0.2 gwei flat
    ...(chain === "bscTestnet" ? { gasPrice: 200_000_000 } : {}),
    ledgerAccounts: useLedger && ledgerAccount !== undefined ? [ledgerAccount] : [],
    url: jsonRpcUrl,
  };
}

const compilerSettings = {
  // BSC runs Cancun since 2024; ReentrancyGuardTransient (tstore / tload) needs it
  evmVersion: "cancun" as const,
  metadata: {
    // Not including the metadata hash
    // https://github.com/paulrberg/hardhat-template/issues/31
    bytecodeHash: "none" as const,
  },
  // Disable the optimizer when debugging
  // https://hardhat.org/hardhat-network/#solidity-optimizer-support
  optimizer: { enabled: true, runs: 800 },
};
const withRuns = (runs: number) => ({
  version: "0.8.27",
  settings: { ...compilerSettings, optimizer: { enabled: true, runs } },
});
const networkSettings = withRuns(NETWORK_RUNS);
const stakingSettings = withRuns(STAKING_RUNS);
const tokenSaleSettings = withRuns(TOKEN_SALE_RUNS);
// the mocks and legacy fixtures that inherit or copy these contracts: fewer runs keep them under the size limit
const mockSettings = withRuns(MOCK_RUNS);

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: 0,
  },
  // Etherscan API V2: one Etherscan.io key for every chain (BSC 56 / BSC testnet 97 included). A single string key makes
  // hardhat-verify call https://api.etherscan.io/v2/api?chainid=<id>; the per-network key map of the V1 API (api.bscscan.com)
  // is not accepted by BscScan any more. Empty = verification skipped (tasks/deploy/verify.ts).
  etherscan: {
    apiKey: vars.get("ETHERSCAN_API_KEY", ""),
  },
  // REPORT_GAS=1 bun run test [REPORT_GAS_FILE=gas.txt]; the summary of the main actions is kept in docs/gas.md
  gasReporter: {
    currency: "USD",
    enabled: process.env.REPORT_GAS === "1",
    excludeContracts: [
      "MockBlocklistERC20",
      "MockERC20",
      "TestUSDT",
      "MockHookERC20",
      "RejectEther",
      "SaleBuyer",
      "ManagedHarness",
      "ManagedHarnessV2",
      "NetworkHarness",
      "NetworkHarnessV2",
      "TreasuryUpgradeMock",
      "PriceFeedUpgradeMock",
      "NetworkUpgradeMock",
      "TokenSaleUpgradeMock",
      "LicenseSaleUpgradeMock",
      "StakingUpgradeMock",
      "RewardsUpgradeMock",
      "RewardsVariant",
      "LicenseSaleVariant",
      "TokenSaleVariant",
      "JumpVariant",
      "TreasuryVariant",
      "StakingV3Compat",
      "JumpUpgradeMock",
      "NetworkHook",
      "MockAggregatorV3",
      "MockRoundPriceSource",
      "MockVexPriceAdapter",
      "MockSellCreditor",
    ],
    noColors: true,
    outputFile: process.env.REPORT_GAS_FILE,
    src: "./contracts",
  },
  networks: {
    hardhat: {
      chainId: chainIds.hardhat,
      // forking BSC (test/upgrade/Network.fork.ts, opt-in) needs to know which hardfork the forked blocks run
      chains: {
        [chainIds.bsc]: { hardforkHistory: { cancun: 0 } },
        [chainIds.bscTestnet]: { hardforkHistory: { cancun: 0 } },
      },
    },
    ganache: {
      chainId: chainIds.ganache,
      url: "http://localhost:8545",
    },
    arbitrum: getChainConfig("arbitrum-mainnet"),
    avalanche: getChainConfig("avalanche"),
    bsc: getChainConfig("bsc"),
    bscTestnet: getChainConfig("bscTestnet"),
    mainnet: getChainConfig("mainnet"),
    optimism: getChainConfig("optimism-mainnet"),
    "polygon-mainnet": getChainConfig("polygon-mainnet"),
    "polygon-mumbai": getChainConfig("polygon-mumbai"),
    sepolia: getChainConfig("sepolia"),
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    // hardhat-deploy is only used for namedAccounts; deploy/ holds the pool catalogue, not hardhat-deploy scripts
    deploy: "./deploy/none",
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    compilers: [{ version: "0.8.27", settings: compilerSettings }],
    overrides: {
      "contracts/Network.sol": networkSettings,
      "contracts/Staking.sol": stakingSettings,
      "contracts/TokenSale.sol": tokenSaleSettings,
      // the legacy copy of the TokenSale is built with the runs it was deployed with
      "contracts/mocks/legacy/v6/TokenSaleV6.sol": tokenSaleSettings,
      "contracts/mocks/TokenSaleUpgradeMock.sol": mockSettings,
      "contracts/mocks/TokenSaleVariant.sol": mockSettings,
      "contracts/mocks/StakingUpgradeMock.sol": mockSettings,
      // the legacy build plus two views is over EIP-170 at 800 runs (the pure legacy copy stays as it was deployed)
      "contracts/mocks/legacy/v3/StakingV3Compat.sol": mockSettings,
      "contracts/mocks/NetworkHarness.sol": mockSettings,
      "contracts/mocks/NetworkHarnessV2.sol": mockSettings,
      "contracts/mocks/NetworkUpgradeMock.sol": mockSettings,
      "contracts/mocks/legacy/v2/NetworkV2.sol": mockSettings,
    },
  },
  // the proxy-building unit tests and the system fixture are slow on a loaded machine
  mocha: { timeout: 300_000 },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
};

export default config;
