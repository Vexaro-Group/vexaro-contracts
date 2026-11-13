// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Managed} from "./abstracts/Managed.sol";
import {INetwork} from "./interfaces/INetwork.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {
    BASIS_POINTS,
    FREEZE_BATCH,
    FREEZE_LIMIT,
    LIMIT_BPS,
    LIMIT_BPS_LITE,
    NetworkFreeze,
    TIER_LITE
} from "./libraries/NetworkFreeze.sol";

/// @title Network
/// @notice Accounting of the partner structure; it holds no tokens. It keeps the membership and the sponsor
///         tree, the freeze registry, the VEX sell block, the license mirror and the bonus-cap state, and runs the
///         NC / LR / BF distribution with its rate tables, the claimable bonus balances and `CapReached`.
///
///         The freeze registry (`freeze`, `unfreeze`, `unfreezeMany`, `voidFreeze`) runs in the external library
///         `NetworkFreeze` by DELEGATECALL on this contract's storage: the functions here only check the role and
///         forward, events and errors are the ones declared here. The implementation must be deployed linked to a
///         deployed `NetworkFreeze`.
///
///         Sponsor tree. The sponsor travels in the account's first buy / stake / license transaction: the calling
///         contract (a REGISTRAR_ROLE holder) calls `register(account, sponsor)`. The first call registers the account
///         (sponsor 0 = none), every later call returns false and changes nothing, so callers may always pass it. The
///         sponsor is final, may be any address other than the account's own, also one that is not registered yet (a
///         referral link works right after web registration; that address keeps its invitees and gets its own sponsor
///         in its own first transaction). A new account must not become its own ancestor (`SponsorCycle`) and the
///         chain from its sponsor up to the top may have at most 255 accounts (`TreeTooDeep`), for every join. The
///         number of accounts above a member is kept in `depths` once it cannot change any more, that is when the
///         whole chain above it is registered: a join then costs the same at any depth. A chain that ends in an
///         account that has not registered yet is walked (at most 255 steps) because that account may still get a
///         sponsor, and so does a member registered before `depths` existed, whose entry is stored by the first walk.
///         Only an account somebody already named as a sponsor (`directCount != 0`) can close a cycle, so only its
///         join walks to the top whatever is stored.
///
///         Freeze. GUARDIAN or OPERATOR freezes, OPERATOR alone unfreezes. Every freeze is kept as an
///         interval [from, until) with its reason (until 0 = still frozen), at most 32 per account, so Staking can
///         skip reward moments that fall inside one. A frozen account is not `isActive`.
///
///         Voiding. A freeze by a leaked or mistaken GUARDIAN must not cost the account its
///         income. OPERATOR can `voidFreeze(account, index)` an interval: it becomes empty (`until = from`), which
///         StakingMath reads as "nothing frozen", so Staking pays every moment of it again (a void of the open
///         interval also unfreezes). `unfreezeMany` lifts (or voids the open interval of) up to MAX_BATCH accounts in
///         one call.
///         Voiding restores the STAKING accrual and the partner credits (NC / LR / BF) that were skipped while the
///         beneficiary was frozen in the open interval: each skip that would have been credited without the freeze
///         adds its share to a per-program sum (`missedBonus`), a void of the open interval credits the sums within the
///         cap room it has at that moment (NC, then LR, then BF; the license must be running; what does not fit is
///         dropped; event `MissedBonusRestored`), and an ordinary lift or the end of any other interval clears them.
///         Income an account already claimed during the freeze is final, and an interval that began before this
///         record existed has no sums. A voided interval is empty, so it does not count against MAX_FREEZES: when an
///         account has 32 intervals, `freeze` first drops the empty ones (keeping the order of the others, which
///         StakingMath relies on; the indexes of later intervals move down, read `freezeIntervals` again). A GUARDIAN
///         key also has a budget of
///         freezes per UTC day (default 50, OPERATOR sets it, OPERATOR's own freezes do not count).
///
///         Sell block. GUARDIAN or OPERATOR blocks VEX sell-back of one account, OPERATOR alone lifts it.
///
///         License mirror and cap. LicenseSale pushes each activation (`onActivated`), Staking the principal of the
///         account's LARGEST open own stake, USER or AIRDROP, never JUMP (`setCapBase`). The cap limit is 200 % of the
///         base (Lite 100 %), zero without an active license; the used counter resets at every activation except a
///         Lite that replaces a Lite which is still running (the 30-day Lite renewal, after the previous Lite ended,
///         resets it). A license is active while `expiresAt > now`, to the second.
///
///         Bonus counters. Per account the total of every partner credit ever made (`vexCum` in VEX wei, raised in
///         the credit transaction) and a mark, `vexDeducted`, that Staking moves up to the total when an early close
///         deducts the credits. A stake remembers the total at its opening, so the credits it must give back are those
///         above both its own mark and the account's deducted mark: each credit is deducted at most once. Every
///         credit is in VEX. The USDT halves of the views (`usdtCum`, `usdtDeducted`, the license balance) read 0:
///         an earlier Network version credited License Rewards in USDT (testnet only, none on mainnet), the fields
///         stay in storage for the layout and nothing reads them.
///
///         Distribution. Three triggers, each called by the contract that owns the hook in the
///         transaction of the event: `onStakeOpened` (Network Cashback, NC: Staking, USER stakes only),
///         `onLicenseBought` (License Rewards, LR: LicenseSale, A = the purchase's USDT value, credited as VEX) and
///         `onWithdrawal` (BackFlow, BF: Rewards, A = the gross VEX). For each ancestor of the actor, nearest first, up
///         to the program's depth, the ancestor is skipped (event `BonusSkipped` with the reason) when it is frozen,
///         has no active license at this second, the level is not paid by its tier's table, has no cap
///         base (no open own stake) or the share rounds to 0. Otherwise wanted = floor(A * rate / 10 000), room = cap
///         limit - used, credit = min(wanted, room); a cap without room is skipped `SKIP_CAP_FULL`. The credit raises
///         the account's claimable cashback balance (VEX, all three programs), its `used` counter and the bonus
///         counters, and emits `BonusCredited`. The credit that fills the cap emits `CapReached(account,
///         activationSeq)` once per activation (flag in the License record, reset by `onActivated`); a cap that is
///         already used up when the next event finds no room (the base shrank) sends it too, once. What is not credited
///         stays in the reward wallets.
///
///         License Rewards in VEX. LR are computed in USDT as before (rate per level of
///         the purchase's USDT value, floored), then converted to VEX at the PriceFeed price of the purchase,
///         floor(usdt * 1e18 / price), the price that also counts them against the cap. That VEX is `wanted`; a
///         trimmed credit is the room itself. They land on the cashback balance and are claimed through
///         `Rewards.claim(KIND_CASHBACK)` under its rules; there is no LICENSE balance any more (`consumeBonus`
///         refuses BONUS_LICENSE, `licenseOwed` keeps the value an earlier upgrade stored). With no price
///         the whole LR event credits nothing (one `SKIP_NO_PRICE`) and the purchase is never reverted.
///         `BonusCredited` for LR carries VEX in `wanted` / `credit` (testnet events from before the switch to VEX are
///         USDT; read the upgrade block from `deployments/<network>.json`).
///
///         Rate tables are state, set by DEFAULT_ADMIN: NC rates per level (15), LR rates per level
///         (10), the BF rate and its level count, and per tier the NC / LR level counts (non-decreasing with the tier).
///         The defaults are: NC L1 10 %, L2 5 %, L3-L5 1 %, L6-L15 0.5 %; LR L1 20 %, L2 8 %, L3 3 %, L4-L10
///         1 %; BF 0.5 % on 10 levels; levels NC 2 / 4 / 6 / 9 / 15 and LR 2 / 3 / 4 / 5 / 10 for Lite / Basic /
///         Prime / Elite / Ultra. A pool that pays level 1 only (ncRule 1) passes its own `l1Bps`.
///
///         Balances. `bonusBalances(account)` = credits made - credits consumed; REWARDS_ROLE (the Rewards contract)
///         takes them with `consumeBonus` when the account claims. The second value of `bonusBalances` (the legacy
///         USDT license balance) is always 0.
///
///         Roles. One per caller, granted by DEFAULT_ADMIN: REGISTRAR_ROLE (`register`: TokenSale, Staking,
///         LicenseSale), LICENSE_HOOK_ROLE (`onActivated`, `onLicenseBought`: LicenseSale), STAKING_HOOK_ROLE
///         (`setCapBase`, `markDeducted`, `onStakeOpened`: Staking) and WITHDRAWAL_HOOK_ROLE (`onWithdrawal`:
///         Rewards); REWARDS_ROLE for `consumeBonus`; GUARDIAN / OPERATOR as above; the rest comes from `Managed`.
///         The earlier single HOOK_ROLE is not checked any more; `initializeV3` swaps it for these on the wired
///         contracts.
///
///         Storage (ERC-7201 `vexaro.storage.Network`, one mapping per struct, each value packed):
///         - Member  (1 slot): sponsor 20 B | joinedAt 5 B | registered, frozen, sellBlocked 3 B | directCount 4 B
///         - License (1 slot): tier 1 B | expiresAt 5 B | activationSeq 4 B | capReached 1 B
///         - Cap     (1 slot): base 16 B | used 16 B (VEX wei; the total supply is 1e27, far below 2^128)
///         - FreezeInterval[] per account: from 5 B | until 5 B | reason 1 B per element
///         - Bonus   (3 slots): vexCum 16 B | usdtCum 16 B, vexDeducted 16 B | usdtDeducted 16 B,
///                              vexConsumed 16 B | usdtConsumed 16 B
///         - Tables: priceFeed, ncBps[15], lrBps[10], bfBps | bfLevels, ncLevels[5], lrLevels[5] (appended later)
///         - Appended later: `licenseOwed` (legacy USDT License Rewards credited minus consumed, all accounts: nothing
///           changes it or reads it any more), then
///           guardianFreezeBudget | guardianFreezeDay | guardianFreezeUsed in one slot
///         - Appended after that: `depths` (accounts above a member plus one, 0 = unknown, 2 B) and `missedBonus`
///           (per account the partner credits skipped while frozen in the open interval: NC | LR | BF, 16 B each)
contract Network is INetwork, Managed {
    /// @notice The single hook role of earlier versions; nothing checks it any more (kept for the ABI).
    ///         `initializeV3` swaps it for the four roles below.
    bytes32 public constant HOOK_ROLE = keccak256("HOOK_ROLE");
    /// @notice `register`: TokenSale, Staking and LicenseSale (the contracts that take a sponsor with the first
    ///         transaction of an account).
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    /// @notice `onActivated` and `onLicenseBought`: LicenseSale.
    bytes32 public constant LICENSE_HOOK_ROLE = keccak256("LICENSE_HOOK_ROLE");
    /// @notice `setCapBase`, `markDeducted` and `onStakeOpened`: Staking (and its StakingMath library).
    bytes32 public constant STAKING_HOOK_ROLE = keccak256("STAKING_HOOK_ROLE");
    /// @notice `onWithdrawal`: Rewards.
    bytes32 public constant WITHDRAWAL_HOOK_ROLE = keccak256("WITHDRAWAL_HOOK_ROLE");
    /// @notice Held by the Rewards contract: takes bonus balances when an account claims.
    bytes32 public constant REWARDS_ROLE = keccak256("REWARDS_ROLE");

    /// @notice Longest sponsor chain (accounts above a new one) accepted by `register`.
    uint256 public constant MAX_TREE_DEPTH = 255;
    /// @notice Largest `maxDepth` of `ancestors`.
    uint256 public constant MAX_VIEW_DEPTH = 15;
    /// @notice Freeze intervals kept per account.
    uint256 public constant MAX_FREEZES = FREEZE_LIMIT;
    /// @notice Most accounts one `unfreezeMany` call takes.
    uint256 public constant MAX_BATCH = FREEZE_BATCH;
    /// @notice The GUARDIAN freeze budget per UTC day a reinitialised Network starts with.
    uint32 public constant DEFAULT_GUARDIAN_FREEZE_BUDGET = 50;
    /// @notice Highest license tier: 0 Lite, 1 Basic, 2 Prime, 3 Elite, 4 Ultra.
    uint8 public constant MAX_TIER = 4;
    uint8 public constant LITE_TIER = TIER_LITE;
    /// @notice Cap limit as a percentage of the base, in basis points.
    uint256 public constant CAP_BPS = LIMIT_BPS;
    uint256 public constant CAP_BPS_LITE = LIMIT_BPS_LITE;
    uint256 private constant BPS = BASIS_POINTS;
    uint256 private constant WAD = 1e18;

    /// @notice Most levels each program can pay (the walk length, and so the gas bound).
    uint8 public constant MAX_NC_LEVELS = 15;
    uint8 public constant MAX_LR_LEVELS = 10;
    uint8 public constant MAX_BF_LEVELS = 10;
    /// @notice Largest BackFlow total (rate x levels) in basis points: Rewards keeps 5 % of each VEX claim for it.
    uint256 public constant MAX_BF_TOTAL_BPS = 500;

    /// @dev `program` of the bonus events.
    uint8 public constant PROGRAM_NC = 0;
    uint8 public constant PROGRAM_LR = 1;
    uint8 public constant PROGRAM_BF = 2;

    /// @dev `kind` of a bonus balance: cashback is VEX (NC, LR, BF); license was the legacy USDT LR balance, which
    ///      `consumeBonus` refuses now.
    uint8 public constant BONUS_CASHBACK = 0;
    uint8 public constant BONUS_LICENSE = 1;

    /// @dev `reason` of `BonusSkipped`.
    uint8 public constant SKIP_FROZEN = 1;
    uint8 public constant SKIP_NO_LICENSE = 2;
    uint8 public constant SKIP_LEVEL = 3;
    uint8 public constant SKIP_NO_BASE = 4;
    uint8 public constant SKIP_CAP_FULL = 5;
    uint8 public constant SKIP_DUST = 6;
    uint8 public constant SKIP_NO_PRICE = 7;

    struct Member {
        address sponsor;
        uint40 joinedAt;
        bool registered;
        bool frozen;
        bool sellBlocked;
        uint32 directCount;
    }

    /// @dev `capReached`: `CapReached` was emitted for this activation (reset by the next activation).
    struct License {
        uint8 tier;
        uint40 expiresAt;
        uint32 activationSeq;
        bool capReached;
    }

    struct Cap {
        uint128 base;
        uint128 used;
    }

    /// @dev Partner credits ever made (VEX wei), how much of them early closes already deducted and how much the
    ///      Rewards contract already took (the balance is credits - consumed). The USDT fields belong to the legacy
    ///      License Rewards of an earlier Network version: nothing reads or writes them now.
    struct Bonus {
        uint128 vexCum;
        uint128 usdtCum;
        uint128 vexDeducted;
        uint128 usdtDeducted;
        uint128 vexConsumed;
        uint128 usdtConsumed;
    }

    /// @dev One bonus event in flight: who caused it, which program, the amount A (VEX for NC / BF, USDT for LR) and,
    ///      for LR, the VEX price that converts the share.
    struct Trigger {
        address source;
        uint8 program;
        bool l1Only;
        uint16 l1Bps;
        uint256 amount;
        uint256 price;
    }

    /// @custom:storage-location erc7201:vexaro.storage.Network
    struct NetworkStorage {
        mapping(address account => Member) members;
        mapping(address account => License) licenses;
        mapping(address account => Cap) caps;
        mapping(address account => FreezeInterval[]) freezes;
        mapping(address account => Bonus) bonuses;
        // appended after the initial layout; do not reorder
        address priceFeed;
        uint16[15] ncBps;
        uint16[10] lrBps;
        uint16 bfBps;
        uint8 bfLevels;
        uint8[5] ncLevels;
        uint8[5] lrLevels;
        // appended later; do not reorder
        uint256 licenseOwed;
        uint32 guardianFreezeBudget;
        uint32 guardianFreezeDay;
        uint32 guardianFreezeUsed;
        // appended after the freeze budget; do not reorder
        mapping(address account => uint16) depths;
        mapping(address account => uint128[3]) missedBonus;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.Network")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant NETWORK_STORAGE_LOCATION =
        0x636a54d177cfbf670f16375a0ea052681a5c5a5f0f07053a267dbc3c5588b200;

    event Joined(address indexed account, address indexed sponsor, uint40 at);
    event Frozen(address indexed account, uint8 reason, address indexed by);
    event Unfrozen(address indexed account, address indexed by);
    /// @notice Interval `index` of the account's freezes became empty. `wasOpen`: it was the open one, so the
    ///         account is unfrozen too (`Unfrozen` follows).
    event FreezeVoided(address indexed account, uint256 index, bool wasOpen, address indexed by);
    event GuardianFreezeBudgetSet(uint32 oldBudget, uint32 newBudget, address indexed by);
    event SellBlocked(address indexed account, uint8 reason, address indexed by);
    event SellUnblocked(address indexed account, address indexed by);
    event LicenseActivated(address indexed account, uint8 tier, uint40 expiresAt, uint32 activationSeq);
    event CapBaseSet(address indexed account, uint256 base);
    event BonusDeducted(address indexed account, uint256 vexCum, uint256 usdtCum);
    /// @param program PROGRAM_NC / PROGRAM_LR / PROGRAM_BF.
    /// @param depth Level of the beneficiary above `source` (1 = its sponsor).
    /// @param wanted The share before the cap, in VEX wei (LR: the USDT share converted at the purchase price; LR
    ///        events of earlier Network versions carry USDT wei).
    /// @param credit What was credited (VEX wei, same unit).
    event BonusCredited(
        address indexed beneficiary,
        address indexed source,
        uint8 program,
        uint8 depth,
        uint16 rateBps,
        uint256 wanted,
        uint256 credit
    );
    /// @param reason One of the SKIP_* codes. SKIP_NO_PRICE is emitted once per LR event with beneficiary 0, depth 0.
    event BonusSkipped(address indexed beneficiary, address indexed source, uint8 program, uint8 depth, uint8 reason);
    /// @notice The credit that used up the account's cap in this activation: the «limit used up, increase your pool»
    ///         notification. Emitted once per activation.
    event CapReached(address indexed account, uint32 activationSeq);
    /// @param kind BONUS_CASHBACK / BONUS_LICENSE.
    event BonusConsumed(address indexed account, uint8 kind, uint256 amount, uint256 totalConsumed);
    event NcRatesSet(uint16[15] bps);
    event LrRatesSet(uint16[10] bps);
    event BackFlowSet(uint16 bps, uint8 levels);
    event TierLevelsSet(uint8[5] nc, uint8[5] lr);
    event PriceFeedChanged(address indexed oldPriceFeed, address indexed newPriceFeed);
    /// @notice A void of the open freeze gave back partner credits that were skipped while the account was frozen.
    /// @param program PROGRAM_NC / PROGRAM_LR / PROGRAM_BF.
    /// @param wanted The sum of the skipped shares of the program (VEX wei).
    /// @param credit What was credited after the cap room at the time of the void (VEX wei, 0 when there was none).
    event MissedBonusRestored(address indexed beneficiary, uint8 program, uint256 wanted, uint256 credit);

    /// @dev A deducted mark above the credits ever made.
    error MarkAboveTotal(address account, uint256 mark, uint256 total);
    /// @dev An account cannot sponsor itself.
    error SelfSponsor(address account);
    /// @dev The sponsor's chain leads back to the joining account.
    error SponsorCycle(address account, address sponsor);
    /// @dev The sponsor's chain is longer than MAX_TREE_DEPTH.
    error TreeTooDeep();
    /// @dev The account already has MAX_FREEZES intervals.
    error FreezeLimit(address account);
    /// @dev The GUARDIAN already made `budget` freezes today.
    error FreezeBudgetExceeded(uint32 used, uint32 budget);
    /// @dev The account has no interval `index`.
    error UnknownFreeze(address account, uint256 index);
    /// @dev The interval is already empty.
    error FreezeAlreadyVoid(address account, uint256 index);
    /// @dev An `unfreezeMany` list that is empty or longer than MAX_BATCH.
    error InvalidBatch(uint256 length);
    error InvalidTier(uint8 tier);
    /// @dev An activation must end in the future.
    error InvalidExpiry(uint40 expiresAt);
    error DepthTooLarge(uint256 maxDepth);
    error ZeroAmount();
    error NotAContract(address account);
    /// @dev A rate table with a rate above 100 %, a total above 100 % (BackFlow: above 5 %), or a level count above the
    ///      program's bound.
    error InvalidRates();
    /// @dev Tier level counts must not decrease with the tier and stay within the program's bound.
    error InvalidLevels();
    /// @dev A pool NC rule other than 0 (license levels) / 1 (level 1 only), or a level-1 rate above 100 %.
    error InvalidNcRule(uint8 ncRule, uint16 l1Bps);
    error InvalidBonusKind(uint8 kind);
    /// @dev `amount` is more than the account's claimable balance of `kind`.
    error BonusExceeded(address account, uint8 kind, uint256 amount, uint256 balance);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __Managed_init(admin);
        NetworkStorage storage $ = _networkStorage();
        $.ncBps = [1000, 500, 100, 100, 100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50];
        $.lrBps = [2000, 800, 300, 100, 100, 100, 100, 100, 100, 100];
        $.bfBps = 50;
        $.bfLevels = 10;
        $.ncLevels = [2, 4, 6, 9, 15];
        $.lrLevels = [2, 3, 4, 5, 10];
        $.guardianFreezeBudget = DEFAULT_GUARDIAN_FREEZE_BUDGET;
    }

    /// @notice Upgrade step (DEFAULT_ADMIN, called by `upgradeToAndCall`): replaces HOOK_ROLE of the four wired callers
    ///         by the roles of the hooks each one calls: REGISTRAR_ROLE for TokenSale, Staking and LicenseSale,
    ///         STAKING_HOOK_ROLE for Staking, LICENSE_HOOK_ROLE for LicenseSale and WITHDRAWAL_HOOK_ROLE for Rewards.
    ///         Every address must hold HOOK_ROLE now (it is revoked from each).
    function initializeV3(
        address tokenSale,
        address staking,
        address licenseSale,
        address rewards
    ) external reinitializer(3) onlyRole(DEFAULT_ADMIN_ROLE) {
        _swapHook(tokenSale, REGISTRAR_ROLE, bytes32(0));
        _swapHook(staking, REGISTRAR_ROLE, STAKING_HOOK_ROLE);
        _swapHook(licenseSale, REGISTRAR_ROLE, LICENSE_HOOK_ROLE);
        _swapHook(rewards, WITHDRAWAL_HOOK_ROLE, bytes32(0));
    }

    /// @dev GUARDIAN (deny-only) or OPERATOR.
    modifier onlyGuardianOrOperator() {
        if (!hasRole(GUARDIAN_ROLE, msg.sender)) _checkRole(OPERATOR_ROLE);
        _;
    }

    // ------------------------------------------------------------------ hooks

    /// @inheritdoc INetwork
    function register(address account, address sponsor) external onlyRole(REGISTRAR_ROLE) returns (bool joined) {
        if (account == address(0)) revert ZeroAddress();
        NetworkStorage storage $ = _networkStorage();
        Member storage m = $.members[account];
        if (m.registered) return false;

        // accounts above the new one, and whether they are all registered (so that number can never change)
        uint256 above;
        bool settled = true;
        if (sponsor != address(0)) {
            if (sponsor == account) revert SelfSponsor(account);
            // An account that already has invitees may be on its sponsor's chain: that walk also looks for a cycle.
            (above, settled) = _chain($, account, sponsor, m.directCount != 0);
            $.members[sponsor].directCount++;
            m.sponsor = sponsor;
        }
        if (settled) $.depths[account] = uint16(above + 1);
        uint40 at = uint40(block.timestamp);
        m.joinedAt = at;
        m.registered = true;
        emit Joined(account, sponsor, at);
        return true;
    }

    /// @inheritdoc INetwork
    function onActivated(address account, uint8 tier, uint40 expiresAt) external onlyRole(LICENSE_HOOK_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (tier > MAX_TIER) revert InvalidTier(tier);
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt);
        NetworkStorage storage $ = _networkStorage();
        License storage lic = $.licenses[account];
        // A Lite that replaces a running Lite is not a renewal: the used counter and the cap notice stay.
        bool renewal = tier != LITE_TIER || lic.tier != LITE_TIER || lic.expiresAt <= block.timestamp;
        uint32 seq = lic.activationSeq + 1;
        bool reached = !renewal && lic.capReached;
        $.licenses[account] = License({tier: tier, expiresAt: expiresAt, activationSeq: seq, capReached: reached});
        if (renewal) $.caps[account].used = 0;
        emit LicenseActivated(account, tier, expiresAt, seq);
    }

    /// @inheritdoc INetwork
    function setCapBase(address account, uint256 base) external onlyRole(STAKING_HOOK_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        Cap storage c = _networkStorage().caps[account];
        uint128 newBase = SafeCast.toUint128(base);
        if (c.base == newBase) return;
        c.base = newBase;
        emit CapBaseSet(account, base);
    }

    /// @inheritdoc INetwork
    function markDeducted(address account, uint256 vexCum, uint256 /* usdtCum */) external onlyRole(STAKING_HOOK_ROLE) {
        Bonus storage b = _networkStorage().bonuses[account];
        if (vexCum > b.vexCum) revert MarkAboveTotal(account, vexCum, b.vexCum);
        // marks only move up
        if (vexCum > b.vexDeducted) b.vexDeducted = uint128(vexCum);
        emit BonusDeducted(account, b.vexDeducted, 0);
    }

    /// @inheritdoc INetwork
    function onStakeOpened(
        address account,
        uint256 principal,
        uint8 ncRule,
        uint16 l1Bps
    ) external onlyRole(STAKING_HOOK_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (ncRule > 1 || l1Bps > BPS) revert InvalidNcRule(ncRule, l1Bps);
        _distribute(
            Trigger({
                source: account,
                program: PROGRAM_NC,
                l1Only: ncRule == 1,
                l1Bps: l1Bps,
                amount: principal,
                price: 0
            })
        );
    }

    /// @inheritdoc INetwork
    function onLicenseBought(address account, uint256 usdtValue) external onlyRole(LICENSE_HOOK_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _distribute(
            Trigger({source: account, program: PROGRAM_LR, l1Only: false, l1Bps: 0, amount: usdtValue, price: 0})
        );
    }

    /// @inheritdoc INetwork
    function onWithdrawal(address account, uint256 gross) external onlyRole(WITHDRAWAL_HOOK_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _distribute(Trigger({source: account, program: PROGRAM_BF, l1Only: false, l1Bps: 0, amount: gross, price: 0}));
    }

    /// @inheritdoc INetwork
    function consumeBonus(
        address account,
        uint8 kind,
        uint256 amount
    ) external onlyRole(REWARDS_ROLE) whenNotPaused(REWARDS) {
        if (amount == 0) revert ZeroAmount();
        if (kind != BONUS_CASHBACK) revert InvalidBonusKind(kind);
        Bonus storage b = _networkStorage().bonuses[account];
        uint256 balance = b.vexCum - b.vexConsumed;
        if (amount > balance) revert BonusExceeded(account, kind, amount, balance);
        uint256 consumed = uint256(b.vexConsumed) + amount;
        b.vexConsumed = uint128(consumed);
        emit BonusConsumed(account, kind, amount, consumed);
    }

    // ------------------------------------------------------------------ rate tables (DEFAULT_ADMIN)

    /// @notice Sets the Network Cashback rate of levels 1..15 in basis points (0 = the level pays nothing). Each rate
    ///         and their sum must be at most 100 %.
    function setNcRates(uint16[15] calldata bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 total = 0;
        for (uint256 i; i < bps.length; ++i) total += bps[i];
        if (total > BPS) revert InvalidRates();
        _networkStorage().ncBps = bps;
        emit NcRatesSet(bps);
    }

    /// @notice Sets the License Rewards rate of levels 1..10 in basis points; the sum must be at most 100 %.
    function setLrRates(uint16[10] calldata bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 total = 0;
        for (uint256 i; i < bps.length; ++i) total += bps[i];
        if (total > BPS) revert InvalidRates();
        _networkStorage().lrBps = bps;
        emit LrRatesSet(bps);
    }

    /// @notice Sets the BackFlow rate per level and the number of levels (at most 10); `bps * levels` at most
    ///         `MAX_BF_TOTAL_BPS` (5 %: the share of each VEX claim that Rewards keeps for BackFlow).
    function setBackFlow(uint16 bps, uint8 levels) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (levels > MAX_BF_LEVELS || uint256(bps) * levels > MAX_BF_TOTAL_BPS) revert InvalidRates();
        NetworkStorage storage $ = _networkStorage();
        $.bfBps = bps;
        $.bfLevels = levels;
        emit BackFlowSet(bps, levels);
    }

    /// @notice Sets how many levels each tier (Lite..Ultra) earns on, for Network Cashback (at most 15) and License
    ///         Rewards (at most 10). A higher tier never has fewer levels than a lower one.
    function setTierLevels(uint8[5] calldata nc, uint8[5] calldata lr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 1; i < 5; ++i) {
            if (nc[i] < nc[i - 1] || lr[i] < lr[i - 1]) revert InvalidLevels();
        }
        if (nc[4] > MAX_NC_LEVELS || lr[4] > MAX_LR_LEVELS) revert InvalidLevels();
        NetworkStorage storage $ = _networkStorage();
        $.ncLevels = nc;
        $.lrLevels = lr;
        emit TierLevelsSet(nc, lr);
    }

    /// @notice The PriceFeed that converts License Rewards to VEX and values them against the cap (DEFAULT_ADMIN).
    ///         Without one, or while it has no price, a license purchase pays no License Rewards.
    function setPriceFeed(address newPriceFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPriceFeed == address(0)) revert ZeroAddress();
        if (newPriceFeed.code.length == 0) revert NotAContract(newPriceFeed);
        NetworkStorage storage $ = _networkStorage();
        emit PriceFeedChanged($.priceFeed, newPriceFeed);
        $.priceFeed = newPriceFeed;
    }

    // ------------------------------------------------------------------ freeze and sell block

    /// @notice Freezes `account` (GUARDIAN or OPERATOR); opens a new interval. Reverts `NoChange(reason)` when it is
    ///         already frozen, `FreezeBudgetExceeded` when a GUARDIAN is over its daily budget and `FreezeLimit` when
    ///         the account still has 32 non-empty intervals.
    function freeze(address account, uint8 reason) external onlyGuardianOrOperator {
        if (account == address(0)) revert ZeroAddress();
        NetworkFreeze.freeze(_networkStorage(), account, reason, hasRole(OPERATOR_ROLE, msg.sender));
    }

    /// @notice Lifts the freeze of `account` (OPERATOR only) and closes its interval now. Reverts `NoChange(0)` when
    ///         it is not frozen.
    function unfreeze(address account) external onlyRole(OPERATOR_ROLE) {
        NetworkFreeze.unfreeze(_networkStorage(), account);
    }

    /// @notice Lifts the freeze of every listed account that is frozen (OPERATOR only; the others are skipped), at
    ///         most MAX_BATCH. With `voidOpenInterval` the open interval becomes empty (no income is lost for it, see
    ///         `voidFreeze`); without it the interval is closed now like `unfreeze`.
    function unfreezeMany(address[] calldata accounts, bool voidOpenInterval) external onlyRole(OPERATOR_ROLE) {
        NetworkFreeze.unfreezeMany(_networkStorage(), accounts, voidOpenInterval);
    }

    /// @notice Makes freeze interval `index` of `account` empty (OPERATOR only): Staking pays the moments inside it
    ///         again, it no longer counts against MAX_FREEZES, and when it was the open interval the account is
    ///         unfrozen. Voiding the open interval also credits the partner credits skipped during it, within the cap
    ///         room of that moment (`MissedBonusRestored`); income already claimed is final. Reverts `UnknownFreeze` /
    ///         `FreezeAlreadyVoid`.
    function voidFreeze(address account, uint256 index) external onlyRole(OPERATOR_ROLE) {
        NetworkFreeze.voidFreeze(_networkStorage(), account, index);
    }

    /// @notice Sets how many freezes a GUARDIAN may make per UTC day (OPERATOR; 0 stops GUARDIAN freezes).
    function setGuardianFreezeBudget(uint32 newBudget) external onlyRole(OPERATOR_ROLE) {
        NetworkStorage storage $ = _networkStorage();
        emit GuardianFreezeBudgetSet($.guardianFreezeBudget, newBudget, msg.sender);
        $.guardianFreezeBudget = newBudget;
    }

    /// @notice Blocks VEX sell-back for `account` (GUARDIAN or OPERATOR). Reverts `NoChange(reason)` when blocked.
    function blockSell(address account, uint8 reason) external onlyGuardianOrOperator {
        if (account == address(0)) revert ZeroAddress();
        Member storage m = _networkStorage().members[account];
        if (m.sellBlocked) revert NoChange(reason);
        m.sellBlocked = true;
        emit SellBlocked(account, reason, msg.sender);
    }

    /// @notice Lifts the sell block of `account` (OPERATOR only). Reverts `NoChange(0)` when it is not blocked.
    function unblockSell(address account) external onlyRole(OPERATOR_ROLE) {
        Member storage m = _networkStorage().members[account];
        if (!m.sellBlocked) revert NoChange(0);
        m.sellBlocked = false;
        emit SellUnblocked(account, msg.sender);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc INetwork
    function isMember(address account) external view returns (bool) {
        return _networkStorage().members[account].registered;
    }

    /// @inheritdoc INetwork
    function isActive(address account) external view returns (bool) {
        Member storage m = _networkStorage().members[account];
        return m.registered && !m.frozen;
    }

    /// @inheritdoc INetwork
    function isFrozen(address account) external view returns (bool) {
        return _networkStorage().members[account].frozen;
    }

    /// @inheritdoc INetwork
    function isFrozenAt(address account, uint256 timestamp) external view returns (bool) {
        FreezeInterval[] storage list = _networkStorage().freezes[account];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            FreezeInterval memory f = list[i];
            if (timestamp >= f.from && (f.until == 0 || timestamp < f.until)) return true;
        }
        return false;
    }

    /// @inheritdoc INetwork
    function isSellBlocked(address account) external view returns (bool) {
        return _networkStorage().members[account].sellBlocked;
    }

    /// @inheritdoc INetwork
    function sponsorOf(address account) external view returns (address) {
        return _networkStorage().members[account].sponsor;
    }

    /// @inheritdoc INetwork
    function joinedAt(address account) external view returns (uint40) {
        return _networkStorage().members[account].joinedAt;
    }

    /// @notice How many accounts named `account` as their sponsor (also before `account` registered itself).
    function directCount(address account) external view returns (uint32) {
        return _networkStorage().members[account].directCount;
    }

    /// @notice The GUARDIAN freeze budget per UTC day, what it used today and what is left.
    function guardianFreezeBudget() external view returns (uint32 budget, uint32 usedToday, uint32 left) {
        NetworkStorage storage $ = _networkStorage();
        budget = $.guardianFreezeBudget;
        usedToday = $.guardianFreezeDay == block.timestamp / 1 days ? $.guardianFreezeUsed : 0;
        left = budget > usedToday ? budget - usedToday : 0;
    }

    /// @inheritdoc INetwork
    function licenseOwed() external view returns (uint256) {
        return _networkStorage().licenseOwed;
    }

    /// @notice How many freezes the account has had (open one and empty ones included).
    function freezeCount(address account) external view returns (uint256) {
        return _networkStorage().freezes[account].length;
    }

    /// @inheritdoc INetwork
    function freezeIntervals(address account) external view returns (FreezeInterval[] memory) {
        return _networkStorage().freezes[account];
    }

    /// @inheritdoc INetwork
    function ancestors(address account, uint256 maxDepth) external view returns (address[] memory result) {
        if (maxDepth > MAX_VIEW_DEPTH) revert DepthTooLarge(maxDepth);
        NetworkStorage storage $ = _networkStorage();
        address[] memory buffer = new address[](maxDepth);
        uint256 n = 0;
        address node = $.members[account].sponsor;
        while (node != address(0) && n < maxDepth) {
            buffer[n++] = node;
            node = $.members[node].sponsor;
        }
        result = new address[](n);
        for (uint256 i; i < n; ++i) result[i] = buffer[i];
    }

    /// @inheritdoc INetwork
    function licenseOf(
        address account
    ) external view returns (uint8 tier, uint40 expiresAt, uint32 activationSeq, bool active) {
        License memory lic = _networkStorage().licenses[account];
        return (lic.tier, lic.expiresAt, lic.activationSeq, lic.expiresAt > block.timestamp);
    }

    /// @inheritdoc INetwork
    function capOf(address account) external view returns (uint256 base, uint256 limit, uint256 used, uint256 room) {
        return _cap(_networkStorage(), account);
    }

    /// @inheritdoc INetwork
    function bonusTotals(
        address account
    ) external view returns (uint256 vexCum, uint256 usdtCum, uint256 vexDeducted, uint256 usdtDeducted) {
        Bonus storage b = _networkStorage().bonuses[account];
        return (b.vexCum, 0, b.vexDeducted, 0);
    }

    /// @inheritdoc INetwork
    function bonusBalances(address account) external view returns (uint256 cashbackVex, uint256 licenseUsdt) {
        Bonus storage b = _networkStorage().bonuses[account];
        return (b.vexCum - b.vexConsumed, 0);
    }

    /// @notice The Network Cashback rates of levels 1..15 (basis points).
    function ncRates() external view returns (uint16[15] memory) {
        return _networkStorage().ncBps;
    }

    /// @notice The License Rewards rates of levels 1..10 (basis points).
    function lrRates() external view returns (uint16[10] memory) {
        return _networkStorage().lrBps;
    }

    /// @notice The BackFlow rate per level (basis points) and its number of levels.
    function backFlow() external view returns (uint16 bps, uint8 levels) {
        NetworkStorage storage $ = _networkStorage();
        return ($.bfBps, $.bfLevels);
    }

    /// @notice Levels per tier (Lite..Ultra) for Network Cashback and License Rewards.
    function tierLevels() external view returns (uint8[5] memory nc, uint8[5] memory lr) {
        NetworkStorage storage $ = _networkStorage();
        return ($.ncLevels, $.lrLevels);
    }

    function priceFeed() external view returns (address) {
        return _networkStorage().priceFeed;
    }

    /// @inheritdoc INetwork
    function memberOf(address account) external view returns (MemberView memory v) {
        NetworkStorage storage $ = _networkStorage();
        Member memory m = $.members[account];
        License memory lic = $.licenses[account];
        v.isMember = m.registered;
        v.isActive = m.registered && !m.frozen;
        v.sponsor = m.sponsor;
        v.joinedAt = m.joinedAt;
        v.directCount = m.directCount;
        v.frozen = m.frozen;
        v.sellBlocked = m.sellBlocked;
        v.tier = lic.tier;
        v.licenseExpiresAt = lic.expiresAt;
        v.activationSeq = lic.activationSeq;
        v.licenseActive = lic.expiresAt > block.timestamp;
        (v.capBase, v.capLimit, v.capUsed, v.capRoom) = _cap($, account);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Remembers the share a frozen beneficiary would have been credited, by program, until its freeze ends.
    function _recordMissed(NetworkStorage storage $, Trigger memory t, address node, uint256 d) private {
        (uint8 reason, uint256 rate, , ) = _eligibility($, t, node, d, false);
        if (reason != 0) return;
        uint256 wanted = _share(t, rate);
        if (wanted == 0) return;
        uint128[3] storage missed = $.missedBonus[node];
        uint256 sum = uint256(missed[t.program]) + wanted;
        missed[t.program] = sum > type(uint128).max ? type(uint128).max : uint128(sum);
    }

    /// @dev Replaces HOOK_ROLE of `holder` by `first` and, when given, `second`.
    function _swapHook(address holder, bytes32 first, bytes32 second) private {
        _checkRole(HOOK_ROLE, holder);
        _revokeRole(HOOK_ROLE, holder);
        _grantRole(first, holder);
        if (second != bytes32(0)) _grantRole(second, holder);
    }

    /// @dev Adds a partner credit (VEX wei, every program) to the account's counters: the total the Staking
    ///      early-close deduction reads and, through it, the claimable cashback balance.
    function _recordBonus(address account, uint256 vexAmount) internal {
        _networkStorage().bonuses[account].vexCum += SafeCast.toUint128(vexAmount);
    }

    /// @dev Walks the actor's sponsors, nearest first, up to the program's depth and credits each one it can.
    function _distribute(Trigger memory t) private {
        if (t.amount == 0) return;
        NetworkStorage storage $ = _networkStorage();
        address node = $.members[t.source].sponsor;
        if (node == address(0)) return;

        uint256 depth;
        if (t.program == PROGRAM_NC) {
            depth = t.l1Only ? 1 : $.ncLevels[MAX_TIER];
        } else if (t.program == PROGRAM_BF) {
            depth = $.bfLevels;
        } else {
            t.price = _vexPrice($);
            if (t.price == 0) {
                emit BonusSkipped(address(0), t.source, t.program, 0, SKIP_NO_PRICE);
                return;
            }
            depth = $.lrLevels[MAX_TIER];
        }
        for (uint256 d = 1; d <= depth && node != address(0); ++d) node = _creditLevel($, t, node, d);
    }

    /// @dev The VEX price, or 0 when there is no PriceFeed or it has no price (it must not revert a purchase).
    function _vexPrice(NetworkStorage storage $) private view returns (uint256) {
        address feed = $.priceFeed;
        if (feed == address(0)) return 0;
        try IPriceFeed(feed).vexPrice() returns (uint256 price) {
            return price;
        } catch {
            return 0;
        }
    }

    /// @dev Credits or skips the ancestor `node` at level `d`; returns its sponsor (the next one to visit).
    function _creditLevel(
        NetworkStorage storage $,
        Trigger memory t,
        address node,
        uint256 d
    ) private returns (address next) {
        Member storage m = $.members[node];
        next = m.sponsor;
        (uint8 reason, uint256 rate, uint256 limit, uint256 used) = _eligibility($, t, node, d, m.frozen);
        if (reason != 0) {
            if (reason == SKIP_FROZEN) _recordMissed($, t, node, d);
            emit BonusSkipped(node, t.source, t.program, uint8(d), reason);
            return next;
        }
        _settle($, t, node, d, rate, limit, used);
    }

    /// @dev Why `node` earns nothing at level `d` (0 = it does) and, if it does, its rate, cap limit and cap used.
    function _eligibility(
        NetworkStorage storage $,
        Trigger memory t,
        address node,
        uint256 d,
        bool frozen
    ) private view returns (uint8 reason, uint256 rate, uint256 limit, uint256 used) {
        if (frozen) return (SKIP_FROZEN, 0, 0, 0);
        License memory lic = $.licenses[node];
        if (lic.expiresAt <= block.timestamp) return (SKIP_NO_LICENSE, 0, 0, 0);
        rate = _rateOf($, t, lic.tier, d);
        if (rate == 0) return (SKIP_LEVEL, 0, 0, 0);
        Cap memory c = $.caps[node];
        if (c.base == 0) return (SKIP_NO_BASE, 0, 0, 0);
        return (0, rate, _limitOf(c.base, lic.tier), c.used);
    }

    /// @dev The rate (bps) the tier earns on level `d` of the trigger's program, 0 = the level is not paid.
    function _rateOf(NetworkStorage storage $, Trigger memory t, uint8 tier, uint256 d) private view returns (uint256) {
        if (t.program == PROGRAM_BF) return $.bfBps;
        if (t.program == PROGRAM_LR) return d <= $.lrLevels[tier] ? $.lrBps[d - 1] : 0;
        // NC: a level-1-only pool pays its own rate to any active license (the walk stops after level 1), the others
        // follow the tier's table
        if (t.l1Only) return t.l1Bps;
        return d <= $.ncLevels[tier] ? $.ncBps[d - 1] : 0;
    }

    /// @dev The share of the trigger's amount at `rate` (bps) in VEX wei. License Rewards are credited as VEX at the
    ///      purchase-time price (the one that also values them against the cap): the share rounds down in USDT first
    ///      and then in VEX.
    function _share(Trigger memory t, uint256 rate) private pure returns (uint256 wanted) {
        wanted = (t.amount * rate) / BPS;
        if (t.program == PROGRAM_LR) wanted = Math.mulDiv(wanted, WAD, t.price);
    }

    /// @dev Trims the share to the cap room, records the credit and emits the events.
    function _settle(
        NetworkStorage storage $,
        Trigger memory t,
        address node,
        uint256 d,
        uint256 rate,
        uint256 limit,
        uint256 used
    ) private {
        uint256 wanted = _share(t, rate);
        if (wanted == 0) {
            emit BonusSkipped(node, t.source, t.program, uint8(d), SKIP_DUST);
            return;
        }
        uint256 room = limit > used ? limit - used : 0;
        if (room == 0) {
            // used up (also when the base shrank below `used`): nothing is credited, the notice goes out once
            emit BonusSkipped(node, t.source, t.program, uint8(d), SKIP_CAP_FULL);
            _markCapReached($, node);
            return;
        }
        uint256 credit = wanted < room ? wanted : room;

        _recordBonus(node, credit);
        used += credit;
        $.caps[node].used = SafeCast.toUint128(used);
        emit BonusCredited(node, t.source, t.program, uint8(d), uint16(rate), wanted, credit);
        if (used >= limit) _markCapReached($, node);
    }

    /// @dev Emits `CapReached` the first time in this activation.
    function _markCapReached(NetworkStorage storage $, address node) private {
        License storage lic = $.licenses[node];
        if (lic.capReached) return;
        lic.capReached = true;
        emit CapReached(node, lic.activationSeq);
    }

    function _limitOf(uint256 base, uint8 tier) private pure returns (uint256) {
        return (base * (tier == LITE_TIER ? CAP_BPS_LITE : CAP_BPS)) / BPS;
    }

    function _cap(
        NetworkStorage storage $,
        address account
    ) private view returns (uint256 base, uint256 limit, uint256 used, uint256 room) {
        Cap memory c = $.caps[account];
        License memory lic = $.licenses[account];
        base = c.base;
        used = c.used;
        if (lic.expiresAt > block.timestamp) limit = _limitOf(base, lic.tier);
        room = limit > used ? limit - used : 0;
    }

    /// @dev The number of accounts from `sponsor` up to the top of its chain (itself included); reverts `TreeTooDeep`
    ///      above MAX_TREE_DEPTH, and `SponsorCycle` if `findCycle` and `account` is on the chain.
    ///
    ///      A registered account whose whole chain is registered keeps the number of accounts above it in `depths`
    ///      (plus one, so 0 means unknown) because its sponsor is final: the walk stops at the first such account.
    ///      Every other chain ends in an account that has not registered yet, which may still get a sponsor of its own,
    ///      so its length can grow: `settled` is false for it and nothing is stored. Accounts registered before
    ///      `depths` existed have no entry and are walked (at most MAX_TREE_DEPTH steps); the sponsor's entry is
    ///      stored when the walk found a settled chain. A cycle can only close through an account that has invitees
    ///      (`findCycle`): the walk of its join goes up to the top and does not read `depths` (one read per level).
    function _chain(
        NetworkStorage storage $,
        address account,
        address sponsor,
        bool findCycle
    ) private returns (uint256 length, bool settled) {
        address node = sponsor;
        for (;;) {
            if (findCycle && node == account) revert SponsorCycle(account, sponsor);
            ++length;
            uint16 stored = findCycle ? 0 : $.depths[node];
            if (stored != 0) {
                length += stored - 1;
                settled = true;
                break;
            }
            Member storage m = $.members[node];
            node = m.sponsor;
            if (node == address(0)) {
                settled = m.registered;
                break;
            }
            if (length == MAX_TREE_DEPTH) revert TreeTooDeep();
        }
        if (length > MAX_TREE_DEPTH) revert TreeTooDeep();
        if (settled && $.depths[sponsor] == 0) $.depths[sponsor] = uint16(length);
    }

    function _networkStorage() internal pure returns (NetworkStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := NETWORK_STORAGE_LOCATION
        }
    }
}
