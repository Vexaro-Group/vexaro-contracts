import { parseEther } from "ethers";

/** One version of a pool as `Staking.addPoolVersion` takes it. USDT amounts are wei. */
export interface StakingPoolParams {
  /** Daily rate in basis points of the principal. */
  dailyBps: number;
  periodDays: number;
  /** Hard cap of the staking income in basis points of the principal. */
  maxProfitBps: number;
  /** 0 = daily, 1 = three parts. */
  payoutMode: 0 | 1;
  /** 0 = VEST (95 % vested over the period after the close), 1 = FULL (95 % at the close). */
  returnMode: 0 | 1;
  /** 0 = Network Cashback by license levels, 1 = level 1 only at `l1Bps`. */
  ncRule: 0 | 1;
  l1Bps: number;
  /** The pools whose own open stake counts for VEX Jump (P1-P5). */
  jumpEligible: boolean;
  usdtMin: bigint;
  usdtMax: bigint;
  /** Release days of the three parts (three-part pools), [0, 0, 0] for daily pools. */
  releaseDays: [number, number, number];
}

export interface StakingPool {
  /** On-chain pool id: the catalogue order (Smart = 1, P1-P5 = 2-6, P6-P13 = 7-14). */
  id: number;
  code: string;
  /** Launched at go-live (the other pools are launched by hand, one on the 6th of each month). */
  launchAtGoLive: boolean;
  /** Airdrop VEX may be staked here (`stakeAirdrop`): P1-P5 only; Smart and P6-P13 refuse it. */
  airdropAllowed: boolean;
  /**
   * Two-halves schedule (`Staking.enablePoolHalves`): the reward is released in two equal halves at 00:00 UTC of the
   * opening date + P / 2 and + P days; the maturity does not change (Smart only).
   */
  halves?: boolean;
  params: StakingPoolParams;
}

const usdt = (n: number) => parseEther(String(n));

const daily = (
  dailyBps: number,
  periodDays: number,
  maxProfitBps: number,
  min: number,
  max: number,
  extra: Partial<StakingPoolParams>,
): StakingPoolParams => ({
  dailyBps,
  periodDays,
  maxProfitBps,
  payoutMode: 0,
  returnMode: 0,
  ncRule: 0,
  l1Bps: 0,
  jumpEligible: false,
  usdtMin: usdt(min),
  usdtMax: usdt(max),
  releaseDays: [0, 0, 0],
  ...extra,
});

const threeParts = (
  dailyBps: number,
  periodDays: number,
  maxProfitBps: number,
  min: number,
  max: number,
  releaseDays: [number, number, number],
): StakingPoolParams =>
  daily(dailyBps, periodDays, maxProfitBps, min, max, {
    payoutMode: 1,
    returnMode: 1,
    ncRule: 1,
    l1Bps: 500,
    releaseDays,
  });

const p15 = { jumpEligible: true };

/**
 * The 14 pools with the three-part totals (daily rate x period, P13 capped at 30 %). The daily pools P1-P5 vest 95 % over their period from the close; Smart and P6-P13 pay 95 % at the close.
 * Smart is on the two-halves schedule (`halves`): its version keeps the daily-mode numbers, which only give the total
 * (min(144 x 16, 2 300) = 23 % of the principal), released in two halves.
 */
export const STAKING_POOLS: StakingPool[] = [
  {
    id: 1,
    code: "Smart",
    launchAtGoLive: true,
    airdropAllowed: false,
    halves: true,
    params: daily(144, 16, 2_300, 500, 1_500, { returnMode: 1, ncRule: 1, l1Bps: 300 }),
  },
  { id: 2, code: "P1", airdropAllowed: true, launchAtGoLive: true, params: daily(65, 308, 20_000, 10, 500, p15) },
  { id: 3, code: "P2", airdropAllowed: true, launchAtGoLive: true, params: daily(75, 267, 20_000, 500, 1_000, p15) },
  { id: 4, code: "P3", airdropAllowed: true, launchAtGoLive: false, params: daily(90, 223, 20_000, 1_000, 5_000, p15) },
  {
    id: 5,
    code: "P4",
    airdropAllowed: true,
    launchAtGoLive: false,
    params: daily(110, 182, 20_000, 5_000, 15_000, p15),
  },
  {
    id: 6,
    code: "P5",
    airdropAllowed: true,
    launchAtGoLive: false,
    params: daily(135, 149, 20_000, 15_000, 250_000, p15),
  },
  {
    id: 7,
    code: "P6",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(111, 90, 9_990, 800, 8_000, [30, 60, 90]),
  },
  {
    id: 8,
    code: "P7",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(112, 80, 8_960, 700, 7_000, [27, 53, 80]),
  },
  {
    id: 9,
    code: "P8",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(114, 70, 7_980, 600, 6_000, [23, 47, 70]),
  },
  {
    id: 10,
    code: "P9",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(117, 60, 7_020, 500, 5_000, [20, 40, 60]),
  },
  {
    id: 11,
    code: "P10",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(120, 50, 6_000, 400, 4_000, [17, 33, 50]),
  },
  {
    id: 12,
    code: "P11",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(138, 40, 5_520, 300, 3_000, [13, 27, 40]),
  },
  {
    id: 13,
    code: "P12",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(150, 30, 4_500, 200, 2_000, [10, 20, 30]),
  },
  {
    id: 14,
    code: "P13",
    airdropAllowed: false,
    launchAtGoLive: false,
    params: threeParts(175, 20, 3_000, 100, 1_000, [7, 13, 20]),
  },
];
