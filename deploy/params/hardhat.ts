import { parseEther } from "ethers";

import type { ParamsFactory } from "../../tasks/deploy/types";
import {
  DEFAULT_AIRDROP_AMOUNT,
  DEFAULT_CAPS,
  DEFAULT_CURRENT_SELL_FEE_BPS,
  DEFAULT_LICENSE_PRICES,
  DEFAULT_NETWORK,
  DEFAULT_ROUNDS,
} from "./defaults";

/**
 * Local network (used by the deploy tests): the Hardhat accounts play every role, account #0 deploys, #1 is the
 * multisig stand-in and the VEX treasury, #2 the guardian. TestUSDT and a mock BNB/USD feed are deployed. No secrets.
 */
const params: ParamsFactory = ({ signers }) => ({
  chainId: 31337,
  bnbFeed: { maxAge: 3650 * 24 * 3600 },
  vexFeeBps: 100,
  vexPrice: { mode: "ROUND" },
  multisig: signers[1],
  multisigIsContract: false,
  guardian: signers[2],
  timelockDelay: 3600,
  licenseBaseUri: "",
  treasury: {
    wallets: [
      { account: signers[3], rateBps: 2000 },
      { account: signers[4], rateBps: 1000 },
    ],
    reserveUsdt: parseEther("1000000"),
  },
  exemptions: [signers[1]],
  vexRemainderTo: signers[1],
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
  airdropWallet: signers[5],
  airdropAmount: DEFAULT_AIRDROP_AMOUNT,
  usdtMints: [{ to: signers[1], amount: parseEther("1000000") }],
  launch: "all",
});

export default params;
