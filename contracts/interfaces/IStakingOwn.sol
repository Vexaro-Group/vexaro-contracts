// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice What Rewards and LicenseSale read of an account's own-funded open stakes (USER and AIRDROP; a JUMP stake
///         never counts). It is separate from `IStaking`, which earlier Staking builds kept as test fixtures implement.
interface IStakingOwn {
    /// @dev `releaseAirdropHoldBatch` with no account or with more than its maximum.
    error InvalidBatchSize(uint256 size);

    /// @notice The account's largest open own-funded stake, by principal in VEX, among its USER and AIRDROP stakes
    ///         (also while an AIRDROP stake is on hold). The lowest id on a tie. This stake's principal is the
    ///         partner-bonus cap base and half of it (in VEX) is the withdrawal maximum of the reward claims.
    /// @return stakeId The stake (0 = none).
    /// @return principal Its principal, VEX wei.
    /// @return entryUsdt Its USDT value at the opening, USDT wei.
    function largestOpenOf(
        address account
    ) external view returns (uint256 stakeId, uint256 principal, uint256 entryUsdt);

    /// @return True when the account has an open own stake of a jump-eligible pool (P1-P5): a USER stake or an AIRDROP
    ///         stake (what License Lite needs; VEX Jump keeps `IStaking.openP15At`, which counts USER stakes only).
    function hasOpenOwnP15(address account) external view returns (bool);

    /// @return halves The part of the account's `incomeOf` that stakes of two-halves pools released (open ones) or
    ///         settled (closed ones), less what was claimed, a claim being taken to spend that part first. The
    ///         withdrawal maximum of the reward claims does not bind it.
    function halvesIncomeOf(address account) external view returns (uint256 halves);

    /// @notice `IStaking.consumeIncome` that also returns `halvesIncomeOf` as it was before the consumption
    ///         (REWARDS_ROLE).
    /// @return income The income before this consumption.
    /// @return halves The two-halves part of it.
    function consumeIncomeSplit(address account, uint256 amount) external returns (uint256 income, uint256 halves);
}
