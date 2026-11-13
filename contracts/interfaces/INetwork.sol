// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice What the other contracts use of `Network`: the hooks (each callable only by the holders of the role of its
///         caller) and the views behind every entry-point check.
interface INetwork {
    /// @dev One freeze: the account is frozen at `t` when `from <= t` and (`until == 0` or `t < until`); `until == 0`
    ///      means the freeze is still in force; `until == from` is an empty (voided) interval that freezes nothing.
    ///      `reason` is the code the GUARDIAN / OPERATOR gave.
    struct FreezeInterval {
        uint40 from;
        uint40 until;
        uint8 reason;
    }

    /// @dev Everything the UI shows about one account in one call.
    struct MemberView {
        bool isMember;
        bool isActive;
        address sponsor;
        uint40 joinedAt;
        uint32 directCount;
        bool frozen;
        bool sellBlocked;
        uint8 tier;
        uint40 licenseExpiresAt;
        uint32 activationSeq;
        bool licenseActive;
        uint256 capBase;
        uint256 capLimit;
        uint256 capUsed;
        uint256 capRoom;
    }

    // ------------------------------------------------------------------ hooks

    /// @notice Registers `account` with `sponsor` (zero = none) on its first call; every later call is a no-op.
    ///         REGISTRAR_ROLE (TokenSale, Staking, LicenseSale).
    /// @return joined True when this call registered the account.
    function register(address account, address sponsor) external returns (bool joined);

    /// @notice Mirrors a license activation: tier, expiry, activation counter + 1, and resets the cap counter (not for
    ///         a Lite that replaces a Lite still running). LICENSE_HOOK_ROLE (LicenseSale).
    function onActivated(address account, uint8 tier, uint40 expiresAt) external;

    /// @notice Sets the account's cap base: the principal of its largest open own-funded stake, USER or AIRDROP, never
    ///         JUMP (VEX wei). STAKING_HOOK_ROLE (Staking).
    function setCapBase(address account, uint256 base) external;

    /// @notice Moves the account's deducted mark up to `vexCum` (never down); it must be at most the credits made so
    ///         far. `usdtCum` is ignored. Called by Staking after an early close deducted the credits
    ///         (STAKING_HOOK_ROLE).
    function markDeducted(address account, uint256 vexCum, uint256 usdtCum) external;

    /// @notice Network Cashback for a USER stake of `principal` VEX opened by `account`: credits the sponsors. `ncRule`
    ///         and `l1Bps` are the stake's pool-version values (0 = by license levels; 1 = level 1 only at `l1Bps`).
    ///         STAKING_HOOK_ROLE (Staking).
    function onStakeOpened(address account, uint256 principal, uint8 ncRule, uint16 l1Bps) external;

    /// @notice License Rewards for a license purchase worth `usdtValue` USDT made by `account`: each upline share is
    ///         computed in USDT, converted to VEX at the PriceFeed price of this moment and credited to the cashback
    ///         balance. Never reverts for a missing VEX price: the event just credits
    ///         nothing. LICENSE_HOOK_ROLE (LicenseSale).
    function onLicenseBought(address account, uint256 usdtValue) external;

    /// @notice BackFlow for a VEX withdrawal of `gross` made by `account`. WITHDRAWAL_HOOK_ROLE (Rewards).
    function onWithdrawal(address account, uint256 gross) external;

    /// @notice Takes `amount` of the account's claimable cashback balance (VEX, `kind` 0); REWARDS_ROLE only, reverts
    ///         above the balance and `InvalidBonusKind` for any other kind (the license kind is gone).
    function consumeBonus(address account, uint8 kind, uint256 amount) external;

    // ------------------------------------------------------------------ views

    /// @return True once the account is registered.
    function isMember(address account) external view returns (bool);

    /// @return True when the account is registered and not frozen: the gate of every user entry point.
    function isActive(address account) external view returns (bool);

    /// @return True while the account is frozen.
    function isFrozen(address account) external view returns (bool);

    /// @return True when the account was frozen at `timestamp` (see `FreezeInterval`).
    function isFrozenAt(address account, uint256 timestamp) external view returns (bool);

    /// @return True while VEX sell-back is blocked for the account.
    function isSellBlocked(address account) external view returns (bool);

    /// @return The account's sponsor (zero when it has none or is not registered).
    function sponsorOf(address account) external view returns (address);

    /// @return When the account joined: the time of its first transaction (0 = not registered).
    function joinedAt(address account) external view returns (uint40);

    /// @return Every freeze of the account, oldest first (at most 32).
    function freezeIntervals(address account) external view returns (FreezeInterval[] memory);

    /// @return The sponsors above the account, nearest first, at most `maxDepth` (<= 15) of them.
    function ancestors(address account, uint256 maxDepth) external view returns (address[] memory);

    /// @return tier The tier of the last activated license (0 Lite .. 4 Ultra).
    /// @return expiresAt When it ends (0 = never activated).
    /// @return activationSeq How many licenses the account activated.
    /// @return active True while `expiresAt > now`, to the second.
    function licenseOf(
        address account
    ) external view returns (uint8 tier, uint40 expiresAt, uint32 activationSeq, bool active);

    /// @return base The cap base (the largest open own-funded stake, VEX wei).
    /// @return limit 200 % of the base (Lite 100 %); 0 without an active license.
    /// @return used Partner bonuses credited since the last activation (VEX wei).
    /// @return room `limit - used`, or 0.
    function capOf(address account) external view returns (uint256 base, uint256 limit, uint256 used, uint256 room);

    /// @return vexCum Every partner credit ever made to the account, in VEX wei.
    /// @return usdtCum Always 0 (an earlier Network version credited License Rewards in USDT; they are not shown).
    /// @return vexDeducted How much of `vexCum` early closes already deducted.
    /// @return usdtDeducted Always 0.
    function bonusTotals(
        address account
    ) external view returns (uint256 vexCum, uint256 usdtCum, uint256 vexDeducted, uint256 usdtDeducted);

    /// @return cashbackVex Claimable cashback (Network Cashback + License Rewards + BackFlow credits not consumed
    ///         yet), VEX wei.
    /// @return licenseUsdt Always 0 (the legacy USDT License Rewards cannot be claimed).
    function bonusBalances(address account) external view returns (uint256 cashbackVex, uint256 licenseUsdt);

    /// @return Legacy License Rewards (credited in USDT by an earlier version) of all accounts and not claimed yet,
    ///         USDT wei. 0 on mainnet; nothing changes it and nothing reads it any more.
    function licenseOwed() external view returns (uint256);

    function memberOf(address account) external view returns (MemberView memory);
}
