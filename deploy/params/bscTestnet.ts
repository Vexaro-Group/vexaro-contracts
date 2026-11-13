import { parseEther } from "ethers";

import type { DeployParams } from "../../tasks/deploy/types";
import {
  DEFAULT_AIRDROP_AMOUNT,
  DEFAULT_CAPS,
  DEFAULT_CURRENT_SELL_FEE_BPS,
  DEFAULT_LICENSE_PRICES,
  DEFAULT_NETWORK,
  DEFAULT_ROUNDS,
} from "./defaults";

// BSC testnet (chain 97). No keys here: the deployer signs with the throwaway key TESTNET_DEPLOYER_KEY (hardhat var
// or HARDHAT_VAR_TESTNET_DEPLOYER_KEY, see hardhat.config.ts) and is not an admin after the hand-over.
const DEPLOYER = "0x1E83eE3359E37Ef9230831fe2Dbe9b3529eF292d";
/** The test multisig stand-in: an EOA that is OPERATOR, EXIT_PAUSER and proposer / executor / canceller. */
const ADMIN_WALLET = "0x2dE355670DF16bc7475987F2Fa2a791547421f41";

const params: DeployParams = {
  chainId: 97,
  // usdt omitted: the run deploys TestUSDT (tUSDT, 18 dp, open faucet) - never used by the bsc params
  bnbFeed: {
    // Chainlink BNB/USD on BSC testnet (8 decimals); it updates far less often than mainnet, hence 3 h
    address: "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526",
    maxAge: 3 * 3600,
  },
  vexFeeBps: 100,
  vexPrice: { mode: "ROUND" },
  multisig: ADMIN_WALLET,
  multisigIsContract: false,
  // stand-in for the main backend's GUARDIAN key
  guardian: DEPLOYER,
  timelockDelay: 10 * 60,
  licenseBaseUri: "https://www.vexaro.finance/metadata/license/",
  treasury: {
    // 20 % of every sale payment goes to the admin wallet, 80 % stays in the Treasury reserve
    wallets: [{ account: ADMIN_WALLET, rateBps: 2000 }],
    reserveUsdt: parseEther("1000000"),
  },
  exemptions: [ADMIN_WALLET],
  // the rest of the supply goes to the admin wallet: after the hand-over it funds the later rounds
  vexRemainderTo: ADMIN_WALLET,
  caps: DEFAULT_CAPS,
  currentSell: {
    feeBps: DEFAULT_CURRENT_SELL_FEE_BPS,
    accountCapUsdt: parseEther("2000"),
    globalCapUsdt: parseEther("20000"),
  },
  wholeBalanceWhenHalfBelowMin: true,
  network: DEFAULT_NETWORK,
  licensePrices: DEFAULT_LICENSE_PRICES,
  rounds: DEFAULT_ROUNDS,
  activeRound: 1,
  roundFunding: [{ round: 1, amount: DEFAULT_ROUNDS[0].allocation }],
  funding: { rewardsVault: parseEther("50000000"), jump: parseEther("5000000") },
  // the testnet user1 wallet, so the airdrop flow can be tested end to end
  airdropWallet: "0x33160471C84c6A54bD9B6F5E27DE390731B9D181",
  airdropAmount: DEFAULT_AIRDROP_AMOUNT,
  usdtMints: [{ to: ADMIN_WALLET, amount: parseEther("1000000") }],
  // testers can try every pool (go-live launches only the first ones)
  launch: "all",
};

export default params;
