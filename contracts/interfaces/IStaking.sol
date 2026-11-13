// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice The Staking contract as the other contracts and the UI use it. Amounts are wei (VEX and USDT, 18
///         decimals), times are unix seconds (UTC), pool and stake ids start at 1.
interface IStaking {
    /// @dev One immutable version of a pool. A stake keeps the version it opened with.
    /// @param dailyBps Daily rate in basis points of the principal (65 = 0.65 %).
    /// @param periodDays Reward days (P).
    /// @param maxProfitBps Hard cap of the staking income in basis points of the principal.
    /// @param payoutMode 0 = daily, 1 = three parts (released on `releaseDays`).
    /// @param returnMode 0 = VEST (95 % vested over P days after the close), 1 = FULL (95 % at the close).
    /// @param ncRule 0 = Network Cashback by license levels, 1 = level 1 only at `l1Bps`.
    /// @param l1Bps Level-1 rate of ncRule 1 (0 for ncRule 0).
    /// @param jumpEligible True for the pools whose own open stake counts for VEX Jump (P1-P5).
    /// @param usdtMin Smallest stake in USDT (inclusive).
    /// @param usdtMax Largest stake in USDT (inclusive).
    /// @param releaseDays The days after the opening day on which the three parts are released (three-part pools).
    struct PoolParams {
        uint16 dailyBps;
        uint16 periodDays;
        uint16 maxProfitBps;
        uint8 payoutMode;
        uint8 returnMode;
        uint8 ncRule;
        uint16 l1Bps;
        bool jumpEligible;
        uint128 usdtMin;
        uint128 usdtMax;
        uint16[3] releaseDays;
    }

    /// @dev Everything the UI shows about one stake. `accrued` is the staking income so far (final once closed);
    ///      `claimable` is the vested VEX not yet claimed (VESTING stakes).
    struct StakeView {
        address owner;
        uint8 poolId;
        uint16 version;
        uint8 source;
        uint8 state;
        uint256 openedAt;
        uint256 principal;
        uint256 entryUsdt;
        uint256 accrued;
        uint256 nextMomentAt;
        uint256 maturesAt;
        uint256 earlyCloseFrom;
        uint256 closedAt;
        uint256 vested;
        uint256 vestClaimed;
        uint256 claimable;
    }

    /// @dev What `closeEarly` would do now. `status` 0 means it can; the other codes are the EARLY_* constants of
    ///      Staking. The amounts are filled whenever the stake is an open USER stake. `refund` is 0 when the fee and
    ///      the deduction leave nothing.
    struct EarlyClosePreview {
        uint8 status;
        uint256 principal;
        uint256 burn;
        uint256 feeToVault;
        uint256 accrued;
        uint256 bonusVex;
        uint256 deduction;
        uint256 refund;
        uint256 availableAt;
        uint256 maturesAt;
        uint256 capRoom;
    }

    /// @dev A pool version is not well formed; `reason` is one of the PARAMS_* codes (1 range, 2 rates, 3 period,
    ///      4 modes, 5 release days, 6 NC rule).
    error InvalidPoolParams(uint8 reason);

    // ------------------------------------------------------------------ calls of the other contracts

    /// @notice Opens a JUMP stake (`source` must be SOURCE_JUMP) of `vexAmount` for `account`; the VEX is pulled
    ///         from the caller (GRANTER_ROLE, the Jump contract). Such a stake accrues and matures like any other,
    ///         can not be closed early and is never part of the checkpoints or the cap base.
    function createGrantStake(
        address account,
        uint256 poolId,
        uint256 vexAmount,
        uint8 source
    ) external returns (uint256 stakeId);

    /// @notice Marks `amount` of the account's staking income as claimed (REWARDS_ROLE); reverts above `incomeOf`.
    /// @return income The income before this consumption (what `incomeOf` returned): no second read needed.
    function consumeIncome(address account, uint256 amount) external returns (uint256 income);

    /// @return Staking income not yet claimed: settled (closed stakes) + accrued (open stakes) - claimed.
    function incomeOf(address account) external view returns (uint256);

    /// @return How many open USER stakes of jump-eligible pools (P1-P5) the account had after every change made at
    ///         or before `timestamp`.
    function openP15At(address account, uint256 timestamp) external view returns (uint256);

    /// @return How many open USER stakes of jump-eligible pools (P1-P5) the account has now (what License Lite needs).
    function openP15Now(address account) external view returns (uint256);
}
