import { parseEther } from "ethers";

import type { DeployParams } from "../../tasks/deploy/types";

/**
 * The default values every network starts from. They are the same numbers the contracts initialise themselves with
 * (Network rate tables, LicenseSale price table), so a run on a fresh deployment sends no transaction for them and the
 * post-deploy check proves nothing drifted.
 */
const usdt = (n: number | string) => parseEther(String(n));

/** 1.5 % of the 1B supply goes to the airdrop wallet at deploy. */
export const DEFAULT_AIRDROP_AMOUNT = 15_000_000n * 10n ** 18n;

export const DEFAULT_NETWORK: DeployParams["network"] = {
  // Network Cashback levels 1..15: L1 10 %, L2 5 %, L3-5 1 %, L6-15 0.5 %
  ncRates: [1000, 500, 100, 100, 100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50],
  // License Rewards levels 1..10: L1 20 %, L2 8 %, L3 3 %, L4-10 1 %
  lrRates: [2000, 800, 300, 100, 100, 100, 100, 100, 100, 100],
  // BackFlow 0.5 % x 10 levels = the 5 % Rewards keeps from a VEX claim
  backFlow: { bps: 50, levels: 10 },
  // Lite, Basic, Prime, Elite, Ultra
  tierLevels: { nc: [2, 4, 6, 9, 15], lr: [2, 3, 4, 5, 10] },
};

/** License list prices in USDT: tier 1..4 (Basic, Prime, Elite, Ultra) x 30 / 180 / 360 days. */
export const DEFAULT_LICENSE_PRICES: DeployParams["licensePrices"] = [
  [1, [20, 60, 100]],
  [2, [30, 100, 180]],
  [3, [100, 400, 700]],
  [4, [200, 900, 1500]],
].flatMap(([tier, prices]) =>
  ([30, 180, 360] as const).map((term, i) => ({
    tier: tier as number,
    term,
    usdt: usdt((prices as number[])[i]),
  })),
);

/** Sale rounds R1..R5: price in USDT per VEX and allocation in VEX (10 / 20 / 30 / 40 / 50 M). */
export const DEFAULT_ROUNDS: DeployParams["rounds"] = [
  { price: usdt("0.036"), allocation: usdt(10_000_000) },
  { price: usdt("0.072"), allocation: usdt(20_000_000) },
  { price: usdt("0.144"), allocation: usdt(30_000_000) },
  { price: usdt("0.288"), allocation: usdt(40_000_000) },
  { price: usdt("0.576"), allocation: usdt(50_000_000) },
];

/** VEX reward claims 2 000 USDT/day, early-close refunds 1 000/day (there is no USDT License limit). */
export const DEFAULT_CAPS: DeployParams["caps"] = {
  rewardVex: usdt(2_000),
  refundUsdt: usdt(1_000),
};

/** TokenSale `sellAtCurrentPrice`: no fee; the daily caps are set per network. */
export const DEFAULT_CURRENT_SELL_FEE_BPS = 0;

/** The 48 h timelock delay of mainnet. */
export const MAINNET_TIMELOCK_DELAY = 48 * 3600;
