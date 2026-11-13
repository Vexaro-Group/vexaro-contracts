import { parseEther } from "ethers";

import { type DeployParams, GOVERNANCE_TIMELOCK_DELAY } from "../../tasks/deploy/types";
import {
  DEFAULT_AIRDROP_AMOUNT,
  DEFAULT_CAPS,
  DEFAULT_CURRENT_SELL_FEE_BPS,
  DEFAULT_LICENSE_PRICES,
  DEFAULT_NETWORK,
  DEFAULT_ROUNDS,
} from "./defaults";

const params: DeployParams = {
  chainId: 56,
  // Binance-Peg BSC-USD (USDT), 18 decimals; the TestUSDT is never deployed on mainnet
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  bnbFeed: {
    // Chainlink BNB/USD on BSC mainnet; TODO(operator): confirm the address and the heartbeat on data.chain.link
    address: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
    maxAge: 300,
  },
  vexFeeBps: 100,
  vexPrice: { mode: "ROUND" },
  // TODO(operator): the Gnosis Safe (OPERATOR, EXIT_PAUSER, proposer / executor / canceller of the timelock)
  multisig: "0x0c9840c7714DF9A0D97080701c834e90b8D29170",
  multisigIsContract: true,
  // TODO(operator): the address of the GUARDIAN key, now held by the main backend (no separate signer server; never the key itself)
  guardian: "0xa70A19F9563DBEf414D7143D5269Cc08269394a8",
  // the roles went straight to the Safe and the Ledger keeps DEFAULT_ADMIN as a backup until
  // `task:deploy:handover --renounce-admin` (docs/deploy.md section 8) ...
  handoverMode: "safe",
  // ... which refuses until `task:governance:timelock` has moved the governance roles to a timelock (section 17)
  timelockGovernance: true,
  // the delay of that timelock: 24 hours
  timelockDelay: GOVERNANCE_TIMELOCK_DELAY,
  licenseBaseUri: "https://www.vexaro.finance/metadata/license/",
  treasury: {
    // TODO(operator): Treasury wallets and their shares, e.g. [{ account: "0x...", rateBps: 2000 }]; the rest stays
    // in the reserve. An empty list sends every payment to the reserve.
    wallets: [
      { account: "0xa70e5501A115b712C60417136cE36BC46ADB24ad", rateBps: 5000 },
      { account: "0x78a0124Fe02Bd123F57c86b215f9BE8Ca96154FD", rateBps: 500 },
      { account: "0x3e4E533Da9f66d5a2223c02205a9EdcEdB526B7b", rateBps: 500 },
    ],
    // TODO(operator): USDT the deployer puts into the reserve (sell-backs, legacy USDT License Rewards)
    reserveUsdt: 0n,
  },
  // TODO(operator): DEX pair / router, CEX hot wallets and the treasury wallet; vexRemainderTo must be listed
  exemptions: ["0x717ea50524f30b035c3A1373119c6869d3D026D1", "0x77c1810B0bca820461fC0F78580829E5b4a1d7D0"],
  // TODO(operator): the treasury wallet that holds the supply that is not funded into the contracts
  vexRemainderTo: "0x717ea50524f30b035c3A1373119c6869d3D026D1",
  caps: DEFAULT_CAPS,
  // fee 0 and daily caps of 2 000 USDT per account / 20 000 USDT global, 18-decimal units
  currentSell: {
    feeBps: DEFAULT_CURRENT_SELL_FEE_BPS,
    accountCapUsdt: 2_000n * 10n ** 18n,
    globalCapUsdt: 20_000n * 10n ** 18n,
  },
  wholeBalanceWhenHalfBelowMin: true,
  network: DEFAULT_NETWORK,
  licensePrices: DEFAULT_LICENSE_PRICES,
  rounds: DEFAULT_ROUNDS,
  activeRound: 1,
  // round 1 holds its full allocation (10 M VEX); later rounds are funded by the OPERATOR when they open
  roundFunding: [{ round: 1, amount: DEFAULT_ROUNDS[0].allocation }],
  // TODO(operator): the reward vault and Jump allocations (VEX)
  funding: { rewardsVault: parseEther("100000000"), jump: parseEther("1000000") },
  // the Ledger that sends the airdrops: 1.5 % of the supply, fee-exempt, its sends create airdrop locks
  airdropWallet: "0xE2d569D41d26A4b6480c8Caa0B1DC6b9E573Ac0F",
  airdropAmount: DEFAULT_AIRDROP_AMOUNT,
  usdtMints: [],
  // go-live pools only; the others are launched one by one by the OPERATOR
  launch: "goLive",
};

export default params;
