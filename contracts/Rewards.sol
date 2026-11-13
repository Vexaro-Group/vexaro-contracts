// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Managed} from "./abstracts/Managed.sol";
import {INetwork} from "./interfaces/INetwork.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IStakingOwn} from "./interfaces/IStakingOwn.sol";
import {ITokenSale} from "./interfaces/ITokenSale.sol";
import {IVexaro} from "./interfaces/IVexaro.sol";

/// @title Rewards
/// @notice The claim contract and the vault of the reward VEX: every withdrawal rule runs
///         here and no backend key moves money. It never holds or touches staked principal.
///
///         Vault. The reward VEX sits in this contract. OPERATOR funds it (`fund`); Staking's early-close fee and
///         deductions arrive by plain transfer (this contract is Staking's `rewardVault`); DEFAULT_ADMIN is the only
///         account that can take tokens out (`withdraw`). VEX must be fee-exempt for this contract, which `fund` and
///         `claim` check on every transfer.
///
///         Claims. `claim(kind, gross)` for the account that calls it (REWARDS pause; Network must say it is active,
///         i.e. registered and not frozen). Kinds: STAKING (VEX, `Staking.incomeOf` / `consumeIncome`), CASHBACK (VEX,
///         Network bonus 0: it holds Network Cashback, License Rewards and BackFlow).
///         There is no USDT kind: `claim` with any other kind reverts `InvalidKind`.
///         Rules, checked in this order (a STAKING claim calls
///         `Staking.consumeIncome` first, which reverts above the income and returns it, so the open stakes are read
///         once; every rule below still reverts the whole claim, the consumption included):
///         - `now >= lastClaim[account][kind] + 24 h` (to the second; the clock is per kind);
///         - `gross <= ` the kind's balance;
///         - `gross >= 5 USDT` (a VEX amount at `PriceFeed.vexPrice()`, no price = revert);
///         - `gross <= ` the maximum: 50 % of the PRINCIPAL in VEX of the account's LARGEST open own stake
///           (`Staking.largestOpenOf`: a USER or AIRDROP stake by principal, never JUMP). It needs no price. With
///           no open own stake it is 50 % of the kind's balance, and the WHOLE balance when that half is below the
///           minimum while the balance reaches it (DEFAULT_ADMIN can switch this off with
///           `setWholeBalanceWhenHalfBelowMin`, default on). A STAKING claim may also reach the staking income that
///           stakes of two-halves pools (Smart) released and that is not claimed yet (`Staking.halvesIncomeOf`, read
///           before the consumption): the maximum is the larger of the rule and that amount. A claim is taken to
///           spend that part of the income first, so income of other pools never gets past the rule;
///         - the daily VEX cap across all accounts per UTC day (`DailyCapExceeded`), both kinds together, stored in
///           USDT and converted at the price of the claim. OPERATOR sets it up or down, GUARDIAN may only lower it; 0
///           switches claims off. The counter counts `gross` in VEX, like Staking's refund cap;
///         - the account's own share of that cap on the same UTC day (`AccountDailyCapExceeded`): `accountShareBps`
///           of the cap in force, 25 % unless OPERATOR sets another value (1 % .. 100 %; GUARDIAN may only lower
///           it), so a few accounts cannot use the whole day's cap. The account's usage is counted like the global
///           one and starts at 0 each UTC day; usage written before this rule existed is not carried over (on the
///           first day after the upgrade an account that claimed earlier that day may use its full share once more).
///
///         Payout. 90 % to the account, 5 % burned from the vault, the rest (5 % plus rounding dust) stays
///         in the vault; `Network.onWithdrawal(account, gross)` credits BackFlow to the uplines out of what stays
///         (what is not credited just stays). Amounts are floored.
///
///         Sell credit. Every VEX claim credits the NET VEX the account received to
///         `TokenSale.currentSellCredit` (`creditCurrentSell`, SELL_CREDITOR_ROLE on the TokenSale): only VEX the
///         platform paid out (staking income, Network Cashback, BackFlow, airdrop- and Jump-stake income) can later be
///         sold at the current price besides purchase lots. With no TokenSale set nothing is credited.
///
///         Wiring: REWARDS_ROLE on Staking and on Network, WITHDRAWAL_HOOK_ROLE on Network (for `onWithdrawal`;
///         Rewards pays no USDT, so it holds no role on the Treasury), SELL_CREDITOR on the TokenSale, VEX fee
///         exemption, `Staking.setRewardVault(this)`.
///
///         Storage (ERC-7201 `vexaro.storage.Rewards`): six wiring addresses (`usdt` and `treasury` are deprecated
///         and never read; the whole-balance flag sits next to the last), the two daily limits (one slot each: cap |
///         used | day; the second, `licenseLimit`, is deprecated and never read), the last claim times (one slot per
///         account, three entries per account, the third unused), then the TokenSale address with the account share
///         in basis points next to it, and the per-account daily usage (used | day).
contract Rewards is Managed {
    using SafeERC20 for IERC20;

    // Claim kinds
    uint8 public constant KIND_STAKING = 0;
    uint8 public constant KIND_CASHBACK = 1;

    /// @notice The window between two claims of one kind.
    uint256 public constant CLAIM_INTERVAL = 1 days;
    /// @notice Smallest gross claim, in USDT (VEX kinds: the VEX value at the price).
    uint256 public constant MIN_CLAIM_USDT = 5e18;
    /// @notice The share of the open-stake total (or of the balance) one request may take.
    uint256 public constant MAX_SHARE_BPS = 5000;
    /// @dev VEX claims: 90 % to the account, 5 % burned, the rest stays in the vault.
    uint256 public constant NET_BPS = 9000;
    uint256 public constant BURN_BPS = 500;
    /// @notice The daily caps the contract starts with, in USDT.
    uint256 public constant DEFAULT_DAILY_CAP_USDT = 2_000e18;
    /// @notice One account's share of the daily cap while none was set (25 %), in basis points.
    uint256 public constant DEFAULT_ACCOUNT_SHARE_BPS = 2_500;
    /// @notice The smallest share `setAccountShareBps` takes (1 %).
    uint256 public constant MIN_ACCOUNT_SHARE_BPS = 100;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /// @dev One daily limit in one slot. `capUsdt` is the cap in USDT wei; `used` the amount counted on UTC day
    ///      `day` (VEX wei). 96 bits hold 7.9e28 wei, far above the whole VEX supply (1e27).
    struct DailyLimit {
        uint96 capUsdt;
        uint96 used;
        uint64 day;
    }

    /// @dev What one account used of the daily cap, in VEX wei, on UTC day `day`.
    struct AccountUse {
        uint96 used;
        uint64 day;
    }

    /// @custom:storage-location erc7201:vexaro.storage.Rewards
    struct RewardsStorage {
        address vex;
        // Deprecated: Rewards pays no USDT; never read.
        address usdt;
        // Deprecated: Rewards uses no Treasury; never read.
        address treasury;
        address network;
        address staking;
        address priceFeed;
        bool wholeBalanceWhenHalfBelowMin;
        DailyLimit vexLimit;
        // Deprecated: the USDT License limit is gone; the slot stays for the layout and is never read.
        DailyLimit licenseLimit;
        mapping(address account => uint40[3] times) lastClaim;
        // appended after the initial layout; do not reorder
        address tokenSale;
        // 0 = DEFAULT_ACCOUNT_SHARE_BPS, so the rule applies to the live proxies without an initializer
        uint16 accountShareBps;
        mapping(address account => AccountUse) accountUse;
    }

    /// @dev What the UI shows about one kind, in VEX wei. `priced` is false while there is no VEX price (minimum,
    ///      maximum and capRoom are then 0 and a claim reverts). `capRoom` is what the daily limits still allow
    ///      today: the smaller of the global room and the account's own room.
    struct ClaimInfo {
        uint256 balance;
        uint256 minimum;
        uint256 maximum;
        uint256 nextAllowedAt;
        uint256 capRoom;
        bool windowOpen;
        bool priced;
    }

    /// @dev The daily limit as the UI shows it: `capUsdt` as stored, `cap` / `used` / `room` in VEX wei (`cap` and
    ///      `room` are 0 while there is no price).
    struct CapInfo {
        uint256 capUsdt;
        uint256 cap;
        uint256 used;
        uint256 room;
    }

    /// @dev One account's share of the daily limit as the UI shows it: `shareBps` in force, `cap` / `used` / `room`
    ///      in VEX wei (`cap` and `room` are 0 while there is no price).
    struct AccountCapInfo {
        uint256 shareBps;
        uint256 cap;
        uint256 used;
        uint256 room;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.Rewards")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REWARDS_STORAGE_LOCATION =
        0xbc324d4b1ab72d3cd220577d382322316a3c850826ef225173a2a5923611cb00;

    /// @param net What the account received (90 % of `gross`).
    /// @param burned VEX burned from the vault (5 %).
    /// @param backflowBase The amount `Network.onWithdrawal` was told (`gross`).
    event Claimed(
        address indexed account,
        uint8 indexed kind,
        uint256 gross,
        uint256 net,
        uint256 burned,
        uint256 backflowBase
    );
    event Funded(address indexed funder, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event DailyCapSet(address indexed token, uint256 oldCapUsdt, uint256 newCapUsdt, address indexed by);
    event WholeBalanceRuleSet(bool enabled);
    event AccountShareSet(uint256 oldShareBps, uint256 newShareBps, address indexed by);
    event NetworkChanged(address indexed oldNetwork, address indexed newNetwork);
    event StakingChanged(address indexed oldStaking, address indexed newStaking);
    event PriceFeedChanged(address indexed oldPriceFeed, address indexed newPriceFeed);
    event TokenSaleChanged(address indexed oldTokenSale, address indexed newTokenSale);

    error ZeroAmount();
    error InvalidValue();
    error NotAContract(address account);
    error InvalidKind(uint8 kind);
    /// @dev The account is not registered or is frozen.
    error NotActive(address account);
    /// @dev The kind was claimed less than 24 h ago; the next claim opens at `nextAllowedAt`.
    error TooSoon(uint256 nextAllowedAt);
    error InsufficientBalance(uint8 kind, uint256 requested, uint256 balance);
    error BelowMinimum(uint256 gross, uint256 minimum);
    error AboveMaximum(uint256 gross, uint256 maximum);
    /// @dev The claim is above what is left of the global daily cap.
    error DailyCapExceeded(uint256 requested, uint256 room);
    /// @dev The claim is above what is left of the account's own share of the daily cap.
    error AccountDailyCapExceeded(uint256 requested, uint256 room);
    /// @dev The vault holds less VEX than the payout and the burn need.
    error VaultShort(uint256 held, uint256 needed);
    error FeeNotExempt(uint256 expected, uint256 received);
    /// @dev A cap is set for something that is not VEX.
    error UnknownToken(address token);
    /// @dev GUARDIAN may only lower a cap or a share.
    error CapNotLowered(uint256 current, uint256 requested);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address vex_,
        address network_,
        address staking_,
        address priceFeed_
    ) external initializer {
        __Managed_init(admin);
        _requireContract(vex_);
        RewardsStorage storage $ = _rewardsStorage();
        $.vex = vex_;
        _setNetwork($, network_);
        _setStaking($, staking_);
        _setPriceFeed($, priceFeed_);
        $.wholeBalanceWhenHalfBelowMin = true;
        $.vexLimit.capUsdt = uint96(DEFAULT_DAILY_CAP_USDT);
        emit DailyCapSet(vex_, 0, DEFAULT_DAILY_CAP_USDT, admin);
        emit WholeBalanceRuleSet(true);
    }

    // ------------------------------------------------------------------ claims

    /// @notice Claims `gross` of the caller's reward balance of `kind` (see the contract notes for the rules).
    /// @param kind KIND_STAKING or KIND_CASHBACK; any other kind (the removed LICENSE kind 2 included) reverts
    ///        `InvalidKind`.
    function claim(uint8 kind, uint256 gross) external nonReentrant whenNotPaused(REWARDS) {
        if (kind > KIND_CASHBACK) revert InvalidKind(kind);
        RewardsStorage storage $ = _rewardsStorage();
        if (!INetwork($.network).isActive(msg.sender)) revert NotActive(msg.sender);
        uint40[3] storage last = $.lastClaim[msg.sender];
        uint256 nextAt = _nextAllowedAt(last[kind]);
        if (block.timestamp < nextAt) revert TooSoon(nextAt);

        // `vexPrice` reverts `PriceUnavailable` while there is no price: a claim is then refused.
        uint256 price = IPriceFeed($.priceFeed).vexPrice();
        // STAKING consumes first and learns the income it consumed from (one pass over the open stakes, not two); a
        // limit broken below reverts the whole transaction, consumption included.
        uint256 balance;
        uint256 halves;
        if (kind == KIND_STAKING) (balance, halves) = IStakingOwn($.staking).consumeIncomeSplit(msg.sender, gross);
        else balance = _balanceOf($, msg.sender, kind);
        _validate($, msg.sender, kind, gross, price, balance, halves);

        last[kind] = uint40(block.timestamp);
        if (kind != KIND_STAKING) INetwork($.network).consumeBonus(msg.sender, kind - 1, gross);
        _payVex($, msg.sender, kind, gross);
    }

    // ------------------------------------------------------------------ vault

    /// @notice Adds `amount` VEX to the vault, pulled from the caller (OPERATOR); reverts when VEX charged a fee.
    function fund(uint256 amount) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 token = IERC20(_rewardsStorage().vex);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert FeeNotExempt(amount, received);
        emit Funded(msg.sender, amount);
    }

    /// @notice Sends `amount` of `token` out of the vault (DEFAULT_ADMIN). For VEX this is the only way reward VEX
    ///         leaves besides claims; no staked principal is ever held here.
    function withdraw(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ------------------------------------------------------------------ rules

    /// @notice Sets the daily cap of VEX (STAKING + CASHBACK together) in USDT wei; 0 turns claims off. OPERATOR sets
    ///         any value; GUARDIAN may only lower it. Any other `token` reverts (there is no USDT cap).
    function setDailyCap(address token, uint256 capUsdt) external {
        RewardsStorage storage $ = _rewardsStorage();
        if (token != $.vex) revert UnknownToken(token);
        DailyLimit storage limit = $.vexLimit;
        if (capUsdt > type(uint96).max) revert InvalidValue();
        uint256 current = limit.capUsdt;
        if (!hasRole(OPERATOR_ROLE, msg.sender)) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender)) _checkRole(OPERATOR_ROLE);
            if (capUsdt >= current) revert CapNotLowered(current, capUsdt);
        }
        // `capUsdt` is at most uint96 max, checked above.
        limit.capUsdt = uint96(capUsdt);
        emit DailyCapSet(token, current, capUsdt, msg.sender);
    }

    /// @notice Sets one account's share of the daily cap, in basis points of the cap in force
    ///         (`MIN_ACCOUNT_SHARE_BPS` .. 10 000). OPERATOR sets any value in that range; GUARDIAN may only lower the
    ///         share. A value outside the range reverts `InvalidValue`.
    function setAccountShareBps(uint256 shareBps) external {
        RewardsStorage storage $ = _rewardsStorage();
        if (shareBps < MIN_ACCOUNT_SHARE_BPS || shareBps > BPS) revert InvalidValue();
        uint256 current = _shareBps($);
        if (!hasRole(OPERATOR_ROLE, msg.sender)) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender)) _checkRole(OPERATOR_ROLE);
            if (shareBps >= current) revert CapNotLowered(current, shareBps);
        }
        // at most 10 000, checked above
        $.accountShareBps = uint16(shareBps);
        emit AccountShareSet(current, shareBps, msg.sender);
    }

    /// @notice Switches the whole-balance rule: with no open own stake, the whole balance may be claimed when half of
    ///         it is below the minimum while the balance reaches it (DEFAULT_ADMIN).
    function setWholeBalanceWhenHalfBelowMin(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _rewardsStorage().wholeBalanceWhenHalfBelowMin = enabled;
        emit WholeBalanceRuleSet(enabled);
    }

    function setNetwork(address newNetwork) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setNetwork(_rewardsStorage(), newNetwork);
    }

    function setStaking(address newStaking) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setStaking(_rewardsStorage(), newStaking);
    }

    function setPriceFeed(address newPriceFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPriceFeed(_rewardsStorage(), newPriceFeed);
    }

    /// @notice The TokenSale that gets the sell credit of VEX claims (DEFAULT_ADMIN); zero switches the credit off.
    function setTokenSale(address newTokenSale) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTokenSale(_rewardsStorage(), newTokenSale);
    }

    // ------------------------------------------------------------------ views

    /// @notice Everything the UI shows about the two kinds of `account` (index = kind), in VEX wei. The maximum is the
    ///         rule's bound (50 %); the balance and `capRoom` bind too. Never reverts for a missing VEX price (`priced`
    ///         is false then).
    function claimsOf(address account) external view returns (ClaimInfo[2] memory infos) {
        RewardsStorage storage $ = _rewardsStorage();
        uint256 price = _tryPrice($);
        infos[KIND_STAKING] = _infoOf($, account, KIND_STAKING, price);
        infos[KIND_CASHBACK] = _infoOf($, account, KIND_CASHBACK, price);
    }

    /// @notice The daily VEX limit with today's usage (STAKING + CASHBACK together, in VEX wei).
    function capsOf() external view returns (CapInfo memory vexCap) {
        RewardsStorage storage $ = _rewardsStorage();
        vexCap.capUsdt = $.vexLimit.capUsdt;
        (vexCap.cap, vexCap.used, vexCap.room) = _limitOf($, _tryPrice($));
    }

    /// @notice `account`'s share of today's daily limit with its usage (VEX wei). The global limit is `capsOf`; a
    ///         claim needs room in both.
    function accountCapOf(address account) external view returns (AccountCapInfo memory info) {
        RewardsStorage storage $ = _rewardsStorage();
        (uint256 cap, , ) = _limitOf($, _tryPrice($));
        info.shareBps = _shareBps($);
        (info.cap, info.used, info.room) = _accountLimitOf($, account, cap);
    }

    /// @notice One account's share of the daily cap in force, in basis points.
    function accountShareBps() external view returns (uint256) {
        return _shareBps(_rewardsStorage());
    }

    /// @notice When `account` last claimed `kind` (0 = never).
    function lastClaimOf(address account, uint8 kind) external view returns (uint256) {
        if (kind > KIND_CASHBACK) revert InvalidKind(kind);
        return _rewardsStorage().lastClaim[account][kind];
    }

    /// @notice The VEX held by the vault. Reward liabilities (unclaimed staking income, cashback with License Rewards)
    ///         are per account in Staking and Network and are not summed on chain.
    function vaultBalance() external view returns (uint256) {
        RewardsStorage storage $ = _rewardsStorage();
        return IERC20($.vex).balanceOf(address(this));
    }

    function wholeBalanceWhenHalfBelowMin() external view returns (bool) {
        return _rewardsStorage().wholeBalanceWhenHalfBelowMin;
    }

    function vex() external view returns (address) {
        return _rewardsStorage().vex;
    }

    function network() external view returns (address) {
        return _rewardsStorage().network;
    }

    function staking() external view returns (address) {
        return _rewardsStorage().staking;
    }

    function priceFeed() external view returns (address) {
        return _rewardsStorage().priceFeed;
    }

    function tokenSale() external view returns (address) {
        return _rewardsStorage().tokenSale;
    }

    // ------------------------------------------------------------------ internals: claim rules

    /// @dev Minimum and maximum in VEX wei for an account whose balance is `balance`, `halves` of which is the staking
    ///      income of two-halves pools: that part is not bound by the 50 % rule, so the maximum is the larger of the
    ///      rule and `halves`. They need `price` (USDT wei per VEX); with `price == 0` (views only) both are 0.
    function _terms(
        RewardsStorage storage $,
        address account,
        uint256 price,
        uint256 balance,
        uint256 halves
    ) private view returns (uint256 minimum, uint256 maximum) {
        if (price == 0) return (0, 0);
        minimum = Math.mulDiv(MIN_CLAIM_USDT, WAD, price, Math.Rounding.Ceil);
        // The largest open own stake (USER or AIRDROP): half of its principal in VEX (no price).
        // slither-disable-next-line unused-return
        (uint256 largestId, uint256 principal, ) = IStakingOwn($.staking).largestOpenOf(account);
        if (largestId != 0) {
            maximum = (principal * MAX_SHARE_BPS) / BPS;
        } else {
            maximum = (balance * MAX_SHARE_BPS) / BPS;
            if ($.wholeBalanceWhenHalfBelowMin && maximum < minimum && balance >= minimum) maximum = balance;
        }
        if (halves > maximum) maximum = halves;
    }

    /// @dev The VEX balance of the claim kind: the staking income or the Network cashback balance (bonus 0).
    function _balanceOf(RewardsStorage storage $, address account, uint8 kind) private view returns (uint256) {
        if (kind == KIND_STAKING) return IStaking($.staking).incomeOf(account);
        (uint256 cashbackVex, ) = INetwork($.network).bonusBalances(account);
        return cashbackVex;
    }

    /// @dev Checks balance, minimum, maximum, the daily cap and the account's share of it, and counts `gross` against
    ///      both.
    function _validate(
        RewardsStorage storage $,
        address account,
        uint8 kind,
        uint256 gross,
        uint256 price,
        uint256 balance,
        uint256 halves
    ) private {
        (uint256 minimum, uint256 maximum) = _terms($, account, price, balance, halves);
        if (gross > balance) revert InsufficientBalance(kind, gross, balance);
        if (gross < minimum) revert BelowMinimum(gross, minimum);
        if (gross > maximum) revert AboveMaximum(gross, maximum);
        _useDailyLimits($, account, gross, price);
    }

    /// @dev Counts `gross` against the global daily cap and the account's share of it (reverts when either is short).
    function _useDailyLimits(RewardsStorage storage $, address account, uint256 gross, uint256 price) private {
        (uint256 cap, uint256 used, uint256 room) = _limitOf($, price);
        if (gross > room) revert DailyCapExceeded(gross, room);
        (, uint256 accountUsed, uint256 accountRoom) = _accountLimitOf($, account, cap);
        if (gross > accountRoom) revert AccountDailyCapExceeded(gross, accountRoom);
        uint64 today = uint64(block.timestamp / 1 days);
        DailyLimit storage limit = $.vexLimit;
        limit.used = SafeCast.toUint96(used + gross);
        limit.day = today;
        AccountUse storage use = $.accountUse[account];
        use.used = SafeCast.toUint96(accountUsed + gross);
        use.day = today;
    }

    /// @dev The account's share of the daily limit today: `globalCap` (VEX wei) times the share in force, what the
    ///      account used today and what is left of its share.
    function _accountLimitOf(
        RewardsStorage storage $,
        address account,
        uint256 globalCap
    ) private view returns (uint256 cap, uint256 used, uint256 room) {
        cap = (globalCap * _shareBps($)) / BPS;
        AccountUse storage use = $.accountUse[account];
        // Day counter comparison, not a balance check.
        // slither-disable-next-line incorrect-equality
        used = use.day == block.timestamp / 1 days ? use.used : 0;
        room = cap > used ? cap - used : 0;
    }

    /// @dev The share in force: the stored one, or the default while none was set.
    function _shareBps(RewardsStorage storage $) private view returns (uint256 shareBps) {
        shareBps = $.accountShareBps;
        if (shareBps == 0) shareBps = DEFAULT_ACCOUNT_SHARE_BPS;
    }

    /// @dev The VEX limit today: its cap converted at `price` (0 without one), what is used today and what is left.
    function _limitOf(
        RewardsStorage storage $,
        uint256 price
    ) private view returns (uint256 cap, uint256 used, uint256 room) {
        DailyLimit storage limit = $.vexLimit;
        cap = price == 0 ? 0 : Math.mulDiv(limit.capUsdt, WAD, price);
        // Day counter comparison, not a balance check.
        // slither-disable-next-line incorrect-equality
        used = limit.day == block.timestamp / 1 days ? limit.used : 0;
        room = cap > used ? cap - used : 0;
    }

    /// @dev 90 % to `account` (checked to arrive whole), 5 % burned, the rest stays; BackFlow for the withdrawal.
    function _payVex(RewardsStorage storage $, address account, uint8 kind, uint256 gross) private {
        uint256 net = (gross * NET_BPS) / BPS;
        uint256 burned = (gross * BURN_BPS) / BPS;
        emit Claimed(account, kind, gross, net, burned, gross);
        INetwork($.network).onWithdrawal(account, gross);

        IERC20 token = IERC20($.vex);
        uint256 held = token.balanceOf(address(this));
        if (held < net + burned) revert VaultShort(held, net + burned);
        uint256 before = token.balanceOf(account);
        token.safeTransfer(account, net);
        uint256 received = token.balanceOf(account) - before;
        if (received != net) revert FeeNotExempt(net, received);
        IVexaro(address(token)).burn(burned);
        // the account holds `net` new platform VEX now: it may sell it at the current price
        address sale = $.tokenSale;
        if (sale != address(0)) ITokenSale(sale).creditCurrentSell(account, net);
    }

    /// @dev When the next claim of a kind opens: 24 h after the last one, 0 when it was never claimed.
    function _nextAllowedAt(uint40 lastClaimAt) private pure returns (uint256) {
        return lastClaimAt == 0 ? 0 : uint256(lastClaimAt) + CLAIM_INTERVAL;
    }

    function _infoOf(
        RewardsStorage storage $,
        address account,
        uint8 kind,
        uint256 price
    ) private view returns (ClaimInfo memory info) {
        info.priced = price != 0;
        info.balance = _balanceOf($, account, kind);
        uint256 halves = kind == KIND_STAKING ? IStakingOwn($.staking).halvesIncomeOf(account) : 0;
        (info.minimum, info.maximum) = _terms($, account, price, info.balance, halves);
        (uint256 cap, , uint256 room) = _limitOf($, price);
        (, , uint256 accountRoom) = _accountLimitOf($, account, cap);
        info.capRoom = Math.min(room, accountRoom);
        info.nextAllowedAt = _nextAllowedAt($.lastClaim[account][kind]);
        info.windowOpen = block.timestamp >= info.nextAllowedAt;
    }

    /// @dev The VEX price, or 0 when the feed has none (views).
    function _tryPrice(RewardsStorage storage $) private view returns (uint256) {
        try IPriceFeed($.priceFeed).vexPrice() returns (uint256 price) {
            return price;
        } catch {
            return 0;
        }
    }

    // ------------------------------------------------------------------ internals: wiring

    function _setNetwork(RewardsStorage storage $, address newNetwork) private {
        _requireContract(newNetwork);
        emit NetworkChanged($.network, newNetwork);
        $.network = newNetwork;
    }

    function _setStaking(RewardsStorage storage $, address newStaking) private {
        _requireContract(newStaking);
        emit StakingChanged($.staking, newStaking);
        $.staking = newStaking;
    }

    function _setPriceFeed(RewardsStorage storage $, address newPriceFeed) private {
        _requireContract(newPriceFeed);
        emit PriceFeedChanged($.priceFeed, newPriceFeed);
        $.priceFeed = newPriceFeed;
    }

    function _setTokenSale(RewardsStorage storage $, address newTokenSale) private {
        if (newTokenSale != address(0)) _requireContract(newTokenSale);
        emit TokenSaleChanged($.tokenSale, newTokenSale);
        $.tokenSale = newTokenSale;
    }

    function _requireContract(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotAContract(account);
    }

    function _rewardsStorage() private pure returns (RewardsStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := REWARDS_STORAGE_LOCATION
        }
    }
}
