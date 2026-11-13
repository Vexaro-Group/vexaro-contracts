// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Managed} from "./abstracts/Managed.sol";
import {
    BPS,
    BURN_BPS,
    RETURN_VEST,
    SOURCE_AIRDROP,
    SOURCE_JUMP,
    SOURCE_USER,
    STATE_CLOSED,
    STATE_CLOSED_EARLY,
    STATE_OPEN,
    STATE_VESTING,
    StakingStore,
    isHeld,
    maturesAt,
    vestTotal
} from "./abstracts/StakingStore.sol";
import {StakingMath} from "./libraries/StakingMath.sol";
import {INetwork} from "./interfaces/INetwork.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {IJump} from "./interfaces/IJump.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IStakingOwn} from "./interfaces/IStakingOwn.sol";
import {IVexaro} from "./interfaces/IVexaro.sol";

/// @title Staking
/// @notice The VEX staking: the pools, the stakes, the income and every exit rule live here, no backend key signs
///         anything. It holds the staked principal and nothing else (rewards are paid from the reward vault by the
///         Rewards contract, which only asks this contract how much income an account has).
///
///         Pools. DEFAULT_ADMIN adds a pool or a new immutable VERSION of one (`addPoolVersion`);
///         a stake keeps the version it opened with, new stakes use the newest. OPERATOR launches a pool by hand
///         and enables or disables it; a pool takes stakes while it is launched and enabled.
///
///         Stakes. `stake` registers the sponsor (first transaction), needs an active account, takes the VEX and
///         checks its USDT value at the PriceFeed price against the pool's inclusive range; at most 50 open stakes
///         per wallet. `stakeAirdrop` opens an AIRDROP stake of the caller's airdrop-locked VEX under the same entry
///         rules (the token's `spendAirdrop`, STAKING holds AIRDROP_SPENDER_ROLE there): it earns the daily income, can
///         not be closed early, pays no Network Cashback to the uplines and is never in the P1-P5 checkpoints (it
///         does count for the cap base and the other eligibilities, see "Largest stake"). A GRANTER
///         (Jump) opens JUMP stakes with `createGrantStake`: the pool must exist (launched or not, enabled or not: a
///         promised grant does not lapse), the range and the sponsor are not checked, such a stake can not be closed
///         early and is never in the checkpoints, the cap base or any eligibility.
///
///         VEX Jump. A USER stake of a jump-eligible pool (P1-P5) also tells the Jump contract (`setJump`,
///         DEFAULT_ADMIN) its pool and entry USDT after the Network Cashback; Jump decides whether it fills a slot of
///         the sponsor's cycle. A Jump that reverts never blocks the stake (`JumpHookFailed`). JUMP / AIRDROP stakes
///         never reach the hook.
///
///         Time (UTC). The reward moment of day k of a stake opened at t0 is `day(t0) * 1 days + k * 1 days + 6 h`
///         (k = 1..P). A stake is mature at 00:00 UTC of day(t0) + P for VEST pools (P1-P5) and of day(t0) + P + 1 for
///         FULL pools (Smart, P6-P13).
///
///         Accrual (view, exact). Daily pools: floor(principal * dailyBps / 10 000) per paid moment, the running total
///         trimmed to floor(principal * maxProfitBps / 10 000). Three-part pools: total = floor(principal *
///         min(dailyBps * P, maxProfitBps) / 10 000), parts floor(total / 3), floor(total / 3) and the rest on the
///         three release days. Two-halves pools (`enablePoolHalves`, the Smart pool): the same total in two parts,
///         floor(total / 2) at 00:00 UTC of day(t0) + ceil(P / 2) and the rest at 00:00 UTC of day(t0) + P, nothing
///         before; the maturity stays where it is (a day after the second half). A moment inside a freeze interval of
///         the owner (Network) pays 0; the schedule and the cap do not move (frozen days are forfeited). A matured
///         close settles the whole schedule, an early close the moments up to the close.
///
///         Income. `incomeOf(account)` = settled (accrual of closed stakes) + accrued (open stakes) - claimed. The
///         Rewards contract (REWARDS_ROLE) takes income with `consumeIncome` / `consumeIncomeSplit`. The part of the
///         income that stakes of two-halves pools released (`halvesIncomeOf`) is not bound by the withdrawal maximum
///         (Rewards): claims are taken to spend that part first, so the rest of the income still is.
///
///         Airdrop hold. An open AIRDROP stake is on hold: it accrues and matures as any
///         stake, but its income is left out of `incomeOf` / `consumeIncome` (it is `heldIncomeOf`) and it can not be
///         closed (`StakeOnHold`); the partner bonuses, USER and JUMP stakes are not touched. AIRDROP_RELEASER_ROLE
///         (the admin console) calls `releaseAirdropHold(account)`: every open AIRDROP stake the account has now is
///         released, its accrual is income from then on and its principal follows the normal close and vesting rules;
///         a stake opened later is held again. The condition for a release (team volume of the grant) is judged off
///         chain. Storage: one mark per account (`airdropReleasedUpTo`, a stake id), so a stake is held while its id is
///         above its owner's mark, which includes every AIRDROP stake that existed before the first release (mark 0).
///
///         Checkpoints. Open USER stakes of jump-eligible pools (P1-P5) are counted in a checkpoint series
///         for VEX Jump (`openP15At`), which AIRDROP stakes do not feed. The per-account sums of the open principal
///         and entry value are no longer kept.
///
///         Largest stake. The partner-bonus cap base (pushed to Network as `setCapBase` after every open or close,
///         200 % of it, Lite 100 %) and the withdrawal maximum (half of its principal in VEX,
///         read by Rewards) are the account's LARGEST open own-funded stake by principal in VEX: any pool, USER and
///         AIRDROP stakes (also while an AIRDROP stake is on hold), never JUMP; the lowest id on a tie. `largestOpenOf`
///         answers it. One record per account (`largest`: stake id and principal, one slot) is updated in O(1) when a
///         stake opens, and found again in the open list (at most 50 stakes) only when the recorded largest stake
///         closes; an account last touched before the record existed has none and is read from its list until it is
///         touched or `syncCapBase` writes it. `hasOpenOwnP15` is what License Lite needs: a USER or AIRDROP stake of
///         P1-P5. `releaseAirdropHoldBatch` releases many accounts in one transaction.
///
///         Exits. Matured close (`closeMatured`, EXITS pause): burns 5 %; VEST pools vest the rest over P days from the
///         close (floor(95 % / P) per whole UTC day after the close day, the remainder on the last, `claimVested`),
///         FULL pools pay it at once. Early close (`closeEarly`, ENTRIES pause, USER stakes, from openedAt + 48 h and
///         before maturity): fee 30 % of the principal (5 % burned, 25 % to the reward vault); deduction = the stake's
///         accrual + the partner bonuses credited since it opened and not deducted yet (Network counters; every credit,
///         License Rewards included, is VEX); refund = principal - fee - deduction must be positive and within the
///         UTC-day refund cap (set in USDT, converted at the current price at each close, `EARLY_CAP`). The cap is
///         shared by all accounts: there is no per-account share, because a stake closes as a whole. The deduction
///         goes to the reward vault, the accrual stays claimable.
///
///         Storage (ERC-7201 `vexaro.storage.Staking`): wiring addresses, pool registry (PoolParams: 3 slots), stakes
///         (4 slots: owner | time and pool fields, principal | entry USDT, bonus marks, close fields), per account 2
///         slots of income (and 2 deprecated slots of sums), the open list, the P1-P5 checkpoints, the hold marks, the
///         largest-stake record per account.
contract Staking is IStaking, IStakingOwn, StakingStore, Managed {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    bytes32 public constant GRANTER_ROLE = keccak256("GRANTER_ROLE");
    bytes32 public constant REWARDS_ROLE = keccak256("REWARDS_ROLE");
    /// @notice Releases the hold of an account's AIRDROP stakes (`releaseAirdropHold`).
    bytes32 public constant AIRDROP_RELEASER_ROLE = keccak256("AIRDROP_RELEASER_ROLE");

    /// @notice Open stakes per wallet, all sources.
    uint256 public constant MAX_OPEN_STAKES = 50;

    event PoolVersionAdded(uint256 indexed poolId, uint256 indexed version, PoolParams params);
    event PoolLaunched(uint256 indexed poolId);
    event PoolEnabled(uint256 indexed poolId, bool enabled);
    event PoolAirdropAllowed(uint256 indexed poolId, bool allowed);
    event PoolHalvesEnabled(uint256 indexed poolId);
    /// @param usdtMark Always 0: the field is kept so that the event signature does not change.
    event StakeOpened(
        address indexed account,
        uint256 indexed stakeId,
        uint256 indexed poolId,
        uint256 version,
        uint8 source,
        uint256 principal,
        uint256 entryUsdt,
        uint256 vexMark,
        uint256 usdtMark
    );
    /// @param kind 0 = matured, 1 = early.
    /// @param accrued The staking income settled by the close (final).
    /// @param burned VEX burned (5 % of the principal).
    /// @param feeToVault The early-close fee part sent to the reward vault (25 %); 0 for a matured close.
    /// @param deduction VEX of the principal sent to the vault for the stake's accrual and partner bonuses.
    /// @param paid VEX handed to the owner right away: the refund, or the 95 % of a FULL matured close; 0 for VEST.
    event StakeClosed(
        address indexed account,
        uint256 indexed stakeId,
        uint8 kind,
        uint256 accrued,
        uint256 burned,
        uint256 feeToVault,
        uint256 deduction,
        uint256 paid
    );
    event VestingClaimed(address indexed account, uint256 indexed stakeId, uint256 amount, uint256 totalClaimed);
    event IncomeConsumed(address indexed account, uint256 amount, uint256 totalClaimed);
    /// @notice The hold of `stakes` open AIRDROP stakes of `account` (every one with an id up to `releasedUpTo`) was
    ///         released by `by`. `income` is their accrual so far, claimable from now on. An AIRDROP stake is held from
    ///         its `StakeOpened` (source 2) until an `AirdropReleased` of its owner with `releasedUpTo` >= its id.
    event AirdropReleased(
        address indexed account,
        uint256 releasedUpTo,
        uint256 stakes,
        uint256 income,
        address indexed by
    );
    event RefundCapSet(uint256 oldCapUsdt, uint256 newCapUsdt);
    event RewardVaultChanged(address indexed oldVault, address indexed newVault);
    event JumpChanged(address indexed oldJump, address indexed newJump);
    /// @notice The Jump hook reverted; the stake itself went through.
    event JumpHookFailed(address indexed account, uint256 indexed poolId);
    event NetworkChanged(address indexed oldNetwork, address indexed newNetwork);
    event PriceFeedChanged(address indexed oldPriceFeed, address indexed newPriceFeed);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAmount();
    error NotAContract(address account);
    error TooManyPools();
    /// @dev The id is 0 or above the number of pools (a new pool must take the next id).
    error UnknownPool(uint256 poolId);
    /// @dev `stakeAirdrop` into a pool that does not take airdrop VEX.
    error AirdropPoolNotAllowed(uint256 poolId);
    /// @dev The pool is not launched or is disabled.
    error PoolClosed(uint256 poolId);
    /// @dev The stake's USDT value is outside the pool's range.
    error OutOfRange(uint256 usdtValue, uint256 usdtMin, uint256 usdtMax);
    /// @dev `actual` is below the `minUsdtValue` the caller gave.
    error Slippage(uint256 actual, uint256 limit);
    error TooManyStakes(address account);
    /// @dev The account is not registered or is frozen.
    error NotActive(address account);
    error InvalidSource(uint8 source);
    error StakeNotOwned(uint256 stakeId);
    error WrongState(uint256 stakeId, uint8 state);
    error NotMatured(uint256 maturesAt);
    /// @dev `status` is one of the EARLY_* codes.
    error EarlyCloseRefused(uint8 status);
    error NothingToClaim(uint256 stakeId);
    error IncomeExceeded(uint256 amount, uint256 income);
    error FeeNotExempt(uint256 expected, uint256 received);
    error ExceedsExcess(uint256 amount, uint256 excess);
    /// @dev The open AIRDROP stake is on hold: it can not be closed (its principal stays, its income is not claimable)
    ///      until an admin releases it. A held stake is OPEN, so `claimVested` answers `WrongState` for it.
    error StakeOnHold(uint256 stakeId);
    /// @dev `releaseAirdropHold` for an account without an open AIRDROP stake on hold.
    error NothingToRelease(address account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin Gets the governance roles (see `Managed`).
    /// @param vex_ The VEX token (this contract must be fee-exempt on it).
    /// @param network_ Network (this contract needs REGISTRAR_ROLE and STAKING_HOOK_ROLE there).
    /// @param priceFeed_ PriceFeed.
    /// @param rewardVault_ Receives the early-close fee and the deductions (the Rewards vault).
    function initialize(
        address admin,
        address vex_,
        address network_,
        address priceFeed_,
        address rewardVault_
    ) external initializer {
        __Managed_init(admin);
        _grantRole(AIRDROP_RELEASER_ROLE, admin);
        _requireContract(vex_);
        StakingStorage storage $ = _stakingStorage();
        $.vex = vex_;
        _setNetwork($, network_);
        _setPriceFeed($, priceFeed_);
        _setRewardVault($, rewardVault_);
    }

    // ------------------------------------------------------------------ pools

    /// @notice Adds pool `poolId` (the next free id) or a new version of an existing pool (DEFAULT_ADMIN). New stakes
    ///         use the newest version; open ones keep theirs. A new pool starts unlaunched and disabled.
    /// @return version The new version number (1 for a new pool).
    function addPoolVersion(
        uint256 poolId,
        PoolParams calldata params
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 version) {
        StakingMath.validate(params);
        StakingStorage storage $ = _stakingStorage();
        if (poolId == 0 || poolId > uint256($.poolCount) + 1) revert UnknownPool(poolId);
        if (poolId > $.poolCount) {
            if ($.poolCount == type(uint8).max) revert TooManyPools();
            $.poolCount = uint8(poolId);
        }
        Pool storage p = $.pools[poolId];
        version = uint256(p.versionCount) + 1;
        p.versionCount = SafeCast.toUint16(version);
        $.versions[poolId][version] = params;
        emit PoolVersionAdded(poolId, version, params);
    }

    /// @notice Opens the pool to stakes for the first time (OPERATOR, by hand). Also enables it.
    function launchPool(uint256 poolId) external onlyRole(OPERATOR_ROLE) {
        Pool storage p = _pool(_stakingStorage(), poolId);
        // poolId <= 255 here
        if (p.launched) revert NoChange(uint8(poolId));
        p.launched = true;
        p.enabled = true;
        emit PoolLaunched(poolId);
        emit PoolEnabled(poolId, true);
    }

    /// @notice Enables or disables a pool (OPERATOR); open stakes are not affected.
    function setPoolEnabled(uint256 poolId, bool enabled) external onlyRole(OPERATOR_ROLE) {
        Pool storage p = _pool(_stakingStorage(), poolId);
        if (p.enabled == enabled) revert NoChange(uint8(poolId));
        p.enabled = enabled;
        emit PoolEnabled(poolId, enabled);
    }

    /// @notice Allows or refuses `stakeAirdrop` into a pool (DEFAULT_ADMIN; idempotent). The flag belongs to the pool,
    ///         not to a version: a new version keeps it. Off for a new pool.
    function setPoolAirdropAllowed(uint256 poolId, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Pool storage p = _pool(_stakingStorage(), poolId);
        p.airdropAllowed = allowed;
        emit PoolAirdropAllowed(poolId, allowed);
    }

    /// @notice Puts pool `poolId` on the two-halves schedule (DEFAULT_ADMIN, one-way): every version of the pool and
    ///         every stake of it, open ones included, accrues in two halves (00:00 UTC of day(openedAt) + ceil(P / 2)
    ///         and + P); the maturity does not change. See the contract notes. Open stakes that were already credited
    ///         daily income keep what was claimed, so call it while the pool has no open stake or accept that their
    ///         accrual restarts from the new schedule. Reverts `NoChange` when it is on already.
    function enablePoolHalves(uint256 poolId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Pool storage p = _pool(_stakingStorage(), poolId);
        if (p.halves) revert NoChange(uint8(poolId));
        p.halves = true;
        emit PoolHalvesEnabled(poolId);
    }

    // ------------------------------------------------------------------ stakes

    /// @notice Opens a USER stake of `vexAmount` VEX in pool `poolId` for the caller (VEX approved to this contract).
    ///         The first transaction of an account also registers `sponsor` in Network (later ones ignore it).
    /// @param minUsdtValue Reverts `Slippage` when the stake's USDT value is lower (0 = no limit).
    function stake(
        uint256 poolId,
        uint256 vexAmount,
        uint256 minUsdtValue,
        address sponsor
    ) external whenNotPaused(ENTRIES) nonReentrant returns (uint256 stakeId) {
        return _stake(poolId, vexAmount, minUsdtValue, sponsor, SOURCE_USER);
    }

    /// @notice Opens an AIRDROP stake of `vexAmount` of the caller's airdrop-locked VEX (no approval: the token's
    ///         `spendAirdrop`) in pool `poolId`. Same entry rules as `stake` (registers `sponsor` on the first
    ///         transaction, active account, pool launched and enabled, USDT range, 50 open stakes). Such a stake
    ///         earns the daily income, can not be closed early, pays no Network Cashback to the uplines and is never in
    ///         the checkpoints or the Jump hook; it counts for the cap base (it can be the largest
    ///         open stake); at maturity the principal is paid out as free VEX.
    function stakeAirdrop(
        uint256 poolId,
        uint256 vexAmount,
        address sponsor
    ) external whenNotPaused(ENTRIES) nonReentrant returns (uint256 stakeId) {
        return _stake(poolId, vexAmount, 0, sponsor, SOURCE_AIRDROP);
    }

    /// @inheritdoc IStaking
    function createGrantStake(
        address account,
        uint256 poolId,
        uint256 vexAmount,
        uint8 source
    ) external onlyRole(GRANTER_ROLE) whenNotPaused(ENTRIES) nonReentrant returns (uint256 stakeId) {
        if (account == address(0)) revert ZeroAddress();
        if (source != SOURCE_JUMP) revert InvalidSource(source);
        if (vexAmount == 0) revert ZeroAmount();
        StakingStorage storage $ = _stakingStorage();
        // Every field is set below or deliberately left 0 (marks and entry value of a grant).
        // slither-disable-next-line uninitialized-local
        Stake memory n;
        n.owner = account;
        n.source = source;
        n.principal = SafeCast.toUint96(vexAmount);
        n.version = _pool($, poolId).versionCount;
        // poolId <= 255 (checked by `_pool`)
        n.poolId = uint8(poolId);
        stakeId = _open($, n, false);
        _pullExact($.vex, msg.sender, vexAmount, false);
    }

    /// @notice Closes a mature OPEN stake of the caller (EXITS pause): settles the whole schedule, burns 5 % and
    ///         either starts the vesting of the rest (VEST pools) or pays it out (FULL pools).
    function closeMatured(uint256 stakeId) external whenNotPaused(EXITS) nonReentrant {
        StakingStorage storage $ = _stakingStorage();
        Stake storage s = _owned($, stakeId, STATE_OPEN);
        _requireNotHeld($, stakeId, s);
        INetwork net = INetwork($.network);
        _requireNotFrozen(net, msg.sender);
        PoolParams storage v = $.versions[s.poolId][s.version];
        uint256 matures = maturesAt(s, v);
        if (block.timestamp < matures) revert NotMatured(matures);

        uint256 accrued = StakingMath.accruedAt($, stakeId, type(uint256).max);
        uint256 amount = s.principal;
        uint256 burned = (amount * BURN_BPS) / BPS;
        _closeOpen($, net, s, stakeId, accrued);
        $.totalPrincipal -= burned;
        uint256 paid = 0;
        if (v.returnMode == RETURN_VEST) {
            s.state = STATE_VESTING;
        } else {
            s.state = STATE_CLOSED;
            paid = amount - burned;
            $.totalPrincipal -= paid;
        }
        emit StakeClosed(msg.sender, stakeId, 0, accrued, burned, 0, 0, paid);
        IVexaro($.vex).burn(burned);
        if (paid != 0) _payExact($.vex, msg.sender, paid);
    }

    /// @notice Pays the vested, unclaimed part of a VESTING stake of the caller (EXITS pause).
    function claimVested(uint256 stakeId) external whenNotPaused(EXITS) nonReentrant {
        StakingStorage storage $ = _stakingStorage();
        Stake storage s = _owned($, stakeId, STATE_VESTING);
        _requireNotFrozen(INetwork($.network), msg.sender);
        uint256 due = StakingMath.vested($, stakeId) - s.vestClaimed;
        // `due` comes from the vesting schedule, not from a balance an attacker can move.
        // slither-disable-next-line incorrect-equality
        if (due == 0) revert NothingToClaim(stakeId);

        uint256 claimed = s.vestClaimed + due;
        s.vestClaimed = uint96(claimed);
        // Exact completion of the schedule (`claimed` only ever grows by `due`).
        // slither-disable-next-line incorrect-equality
        if (claimed == vestTotal(s.principal)) s.state = STATE_CLOSED;
        $.totalPrincipal -= due;
        emit VestingClaimed(msg.sender, stakeId, due, claimed);
        _payExact($.vex, msg.sender, due);
    }

    /// @notice Closes an OPEN USER stake of the caller before it matures (ENTRIES pause); see `previewEarlyClose`.
    ///         Reverts `EarlyCloseRefused(status)` when the preview's status is not 0.
    function closeEarly(uint256 stakeId) external whenNotPaused(ENTRIES) nonReentrant {
        StakingStorage storage $ = _stakingStorage();
        Stake storage s = _owned($, stakeId, STATE_OPEN);
        _requireNotHeld($, stakeId, s);
        INetwork net = INetwork($.network);
        if (!net.isActive(msg.sender)) revert NotActive(msg.sender);
        (EarlyClosePreview memory p, uint256 vexCum, bool mark) = StakingMath.earlyQuote($, stakeId);
        if (p.status != 0) revert EarlyCloseRefused(p.status);

        _useRefund($, p.refund);
        _closeOpen($, net, s, stakeId, p.accrued);
        s.state = STATE_CLOSED_EARLY;
        $.totalPrincipal -= p.principal;
        if (mark) net.markDeducted(msg.sender, vexCum, 0);
        emit StakeClosed(msg.sender, stakeId, 1, p.accrued, p.burn, p.feeToVault, p.deduction, p.refund);

        IVexaro($.vex).burn(p.burn);
        _payExact($.vex, $.rewardVault, p.feeToVault + p.deduction);
        _payExact($.vex, msg.sender, p.refund);
    }

    // ------------------------------------------------------------------ income (Rewards)

    /// @inheritdoc IStaking
    function consumeIncome(
        address account,
        uint256 amount
    ) external onlyRole(REWARDS_ROLE) whenNotPaused(REWARDS) returns (uint256 income) {
        (income, ) = StakingMath.consume(_stakingStorage(), account, amount);
    }

    /// @inheritdoc IStakingOwn
    function consumeIncomeSplit(
        address account,
        uint256 amount
    ) external onlyRole(REWARDS_ROLE) whenNotPaused(REWARDS) returns (uint256 income, uint256 halves) {
        return StakingMath.consume(_stakingStorage(), account, amount);
    }

    // ------------------------------------------------------------------ airdrop hold

    /// @notice Releases the hold of every open AIRDROP stake of `account` (AIRDROP_RELEASER_ROLE, the admin console):
    ///         their accrued income becomes claimable and their principal follows the normal close and vesting rules.
    ///         AIRDROP stakes the account opens later are held again. Whether the account earned the release (the
    ///         team volume of the grant) is judged off chain; the contract does not check it. Reverts
    ///         `NothingToRelease` when none of the account's open AIRDROP stakes is on hold.
    /// @return stakes How many stakes were released.
    /// @return income Their accrual so far (now part of `incomeOf`).
    function releaseAirdropHold(
        address account
    ) external onlyRole(AIRDROP_RELEASER_ROLE) returns (uint256 stakes, uint256 income) {
        StakingStorage storage $ = _stakingStorage();
        (stakes, income) = StakingMath.release($, account);
        if (stakes == 0) revert NothingToRelease(account);
        emit AirdropReleased(account, $.nextStakeId, stakes, income, msg.sender);
    }

    /// @notice `releaseAirdropHold` for many accounts in one transaction (AIRDROP_RELEASER_ROLE): an account without
    ///         an open AIRDROP stake on hold is skipped without a revert, every other one
    ///         is released with its own `AirdropReleased` event. At most 50 accounts; an empty list or a longer one
    ///         reverts `InvalidBatchSize`. A batch at its bounds (50 accounts, each with 50 held stakes and many freeze
    ///         intervals) costs more gas than a block holds, so a caller must size the batch by estimating its gas on
    ///         the current state and split a long list into several transactions.
    /// @return released How many accounts had something on hold.
    function releaseAirdropHoldBatch(
        address[] calldata accounts
    ) external onlyRole(AIRDROP_RELEASER_ROLE) returns (uint256 released) {
        return StakingMath.releaseBatch(_stakingStorage(), accounts, msg.sender);
    }

    // ------------------------------------------------------------------ cap base

    /// @notice Migration and repair: records the largest open own-funded stake of each of `accounts` (1 to
    ///         50) and pushes it to Network as the cap base. An account last touched before the
    ///         record existed has its old base (the sum of its USER stakes) in Network until it opens or closes a
    ///         stake or someone calls this. Anyone may call it: it only writes what the next open or close would write.
    function syncCapBase(address[] calldata accounts) external {
        StakingMath.syncCapBase(_stakingStorage(), accounts);
    }

    // ------------------------------------------------------------------ admin

    /// @notice The refund cap per UTC day across all accounts, in USDT (OPERATOR); 0 turns early closes off.
    function setRefundCapUsdt(uint256 newCapUsdt) external onlyRole(OPERATOR_ROLE) {
        StakingStorage storage $ = _stakingStorage();
        emit RefundCapSet($.refundCapUsdt, newCapUsdt);
        $.refundCapUsdt = newCapUsdt;
    }

    function setRewardVault(address newVault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRewardVault(_stakingStorage(), newVault);
    }

    /// @notice The VEX Jump contract told about every USER stake of a jump-eligible pool (DEFAULT_ADMIN); zero turns
    ///         the hook off. Jump needs HOOK_ROLE for this contract on its side.
    function setJump(address newJump) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StakingStorage storage $ = _stakingStorage();
        if (newJump != address(0)) _requireContract(newJump);
        emit JumpChanged($.jump, newJump);
        $.jump = newJump;
    }

    function setNetwork(address newNetwork) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setNetwork(_stakingStorage(), newNetwork);
    }

    function setPriceFeed(address newPriceFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPriceFeed(_stakingStorage(), newPriceFeed);
    }

    /// @notice Sends out tokens that are not staked principal: any token but VEX, or VEX above `totalPrincipal`
    ///         (DEFAULT_ADMIN).
    function rescue(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        StakingStorage storage $ = _stakingStorage();
        if (token == $.vex) {
            uint256 excess = _vexExcess($);
            if (amount > excess) revert ExceedsExcess(amount, excess);
        }
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ------------------------------------------------------------------ views

    function vex() external view returns (address) {
        return _stakingStorage().vex;
    }

    function network() external view returns (address) {
        return _stakingStorage().network;
    }

    function priceFeed() external view returns (address) {
        return _stakingStorage().priceFeed;
    }

    function rewardVault() external view returns (address) {
        return _stakingStorage().rewardVault;
    }

    /// @notice The VEX Jump contract the stake hook calls (zero = none).
    function jump() external view returns (address) {
        return _stakingStorage().jump;
    }

    /// @notice The number of pools (ids 1..n).
    function poolCount() external view returns (uint256) {
        return _stakingStorage().poolCount;
    }

    /// @notice Whether pool `poolId` is launched and enabled, how many versions it has (the newest is in force) and
    ///         whether `stakeAirdrop` may use it.
    function pool(
        uint256 poolId
    ) external view returns (bool launched, bool enabled, uint256 versionCount, bool airdropAllowed) {
        Pool storage p = _pool(_stakingStorage(), poolId);
        return (p.launched, p.enabled, p.versionCount, p.airdropAllowed);
    }

    /// @notice Whether pool `poolId` is on the two-halves schedule (`enablePoolHalves`).
    function poolHalves(uint256 poolId) external view returns (bool) {
        return _pool(_stakingStorage(), poolId).halves;
    }

    /// @notice One version of a pool (1..versionCount).
    function poolVersion(uint256 poolId, uint256 version) external view returns (PoolParams memory) {
        StakingStorage storage $ = _stakingStorage();
        Pool storage p = _pool($, poolId);
        if (version == 0 || version > p.versionCount) revert UnknownPool(poolId);
        return $.versions[poolId][version];
    }

    /// @notice The staking income of the stake so far: final once it is closed.
    function accruedOf(uint256 stakeId) external view returns (uint256) {
        return _accruedAt(_stakingStorage(), stakeId, block.timestamp);
    }

    /// @notice The staking income of the stake from the reward moments due by `timestamp`: a projection for a time in
    ///         the future (it assumes no freeze after now), the schedule's total for `type(uint256).max`. A closed
    ///         stake returns its final accrual.
    function accruedAt(uint256 stakeId, uint256 timestamp) external view returns (uint256) {
        return _accruedAt(_stakingStorage(), stakeId, timestamp);
    }

    function stakeView(uint256 stakeId) external view returns (StakeView memory) {
        return StakingMath.stakeView(_stakingStorage(), stakeId);
    }

    /// @notice What `closeEarly` would do now (see `EarlyClosePreview`); reverts when the VEX price is unavailable.
    function previewEarlyClose(uint256 stakeId) external view returns (EarlyClosePreview memory p) {
        StakingStorage storage $ = _stakingStorage();
        // The bonus totals are for `closeEarly`; the preview has everything in `p`.
        // slither-disable-next-line unused-return
        (p, , ) = StakingMath.earlyQuote($, stakeId);
    }

    /// @notice Ids of the account's open stakes (at most 50), in the order of the open list.
    function openStakesOf(address account) external view returns (uint256[] memory) {
        return _stakingStorage().openIds[account];
    }

    /// @inheritdoc IStaking
    function incomeOf(address account) external view returns (uint256) {
        return StakingMath.income(_stakingStorage(), account);
    }

    /// @inheritdoc IStakingOwn
    function halvesIncomeOf(address account) external view returns (uint256 halves) {
        (, halves) = StakingMath.incomeSplit(_stakingStorage(), account);
    }

    /// @notice The accrual so far of the account's open AIRDROP stakes that are on hold: not part of `incomeOf`, and
    ///         it becomes income when the hold is released.
    function heldIncomeOf(address account) external view returns (uint256) {
        return StakingMath.heldIncome(_stakingStorage(), account);
    }

    /// @notice Whether the stake is an open AIRDROP stake on hold (not released yet).
    function isStakeHeld(uint256 stakeId) external view returns (bool) {
        StakingStorage storage $ = _stakingStorage();
        return isHeld($, stakeId, $.stakes[stakeId]);
    }

    /// @notice The AIRDROP stakes of `account` with an id up to this are released from the hold (0 = none yet).
    function airdropReleasedUpTo(address account) external view returns (uint256) {
        return _stakingStorage().airdropReleasedUpTo[account];
    }

    /// @inheritdoc IStakingOwn
    function largestOpenOf(
        address account
    ) external view returns (uint256 stakeId, uint256 principal, uint256 entryUsdt) {
        return StakingMath.largestOpen(_stakingStorage(), account);
    }

    /// @inheritdoc IStakingOwn
    function hasOpenOwnP15(address account) external view returns (bool) {
        return StakingMath.hasOpenOwnP15(_stakingStorage(), account);
    }

    /// @inheritdoc IStaking
    function openP15At(address account, uint256 timestamp) external view returns (uint256) {
        if (timestamp > type(uint48).max) timestamp = type(uint48).max;
        return _stakingStorage().p15[account].upperLookup(uint48(timestamp));
    }

    /// @inheritdoc IStaking
    function openP15Now(address account) external view returns (uint256) {
        return _stakingStorage().p15[account].latest();
    }

    /// @notice VEX vested so far on a stake (0 before it vests, the 95 % once complete).
    function vestedOf(uint256 stakeId) external view returns (uint256) {
        return StakingMath.vested(_stakingStorage(), stakeId);
    }

    /// @notice VEX a `claimVested` would pay now.
    function claimableOf(uint256 stakeId) external view returns (uint256) {
        StakingStorage storage $ = _stakingStorage();
        Stake storage s = $.stakes[stakeId];
        return StakingMath.vested($, stakeId) - s.vestClaimed;
    }

    /// @notice Principal still held: open stakes plus the unclaimed vesting.
    function totalPrincipal() external view returns (uint256) {
        return _stakingStorage().totalPrincipal;
    }

    function refundCapUsdt() external view returns (uint256) {
        return _stakingStorage().refundCapUsdt;
    }

    /// @notice VEX refunded by early closes in the current UTC day.
    function refundUsedToday() external view returns (uint256) {
        return _refundUsedToday(_stakingStorage());
    }

    /// @notice VEX held above `totalPrincipal` (what `rescue` may take).
    function vexExcess() external view returns (uint256) {
        return _vexExcess(_stakingStorage());
    }

    // ------------------------------------------------------------------ internals: stakes

    /// @dev The entry path of `stake` (SOURCE_USER) and `stakeAirdrop` (SOURCE_AIRDROP); both feed the cap base (the
    ///      largest open stake), only a USER stake feeds the Network Cashback and the Jump hook.
    function _stake(
        uint256 poolId,
        uint256 vexAmount,
        uint256 minUsdtValue,
        address sponsor,
        uint8 source
    ) private returns (uint256 stakeId) {
        StakingStorage storage $ = _stakingStorage();
        INetwork net = INetwork($.network);
        // `register` says whether the account joined just now, which `isActive` makes irrelevant here.
        // slither-disable-next-line unused-return
        net.register(msg.sender, sponsor);
        if (!net.isActive(msg.sender)) revert NotActive(msg.sender);
        if (vexAmount == 0) revert ZeroAmount();

        // Every field is set below or deliberately left 0 (marks of an AIRDROP stake, entry value).
        // slither-disable-next-line uninitialized-local
        Stake memory n;
        n.owner = msg.sender;
        n.source = source;
        n.principal = SafeCast.toUint96(vexAmount);
        PoolParams storage v = _openPool($, poolId, n);
        uint256 usdtValue = IPriceFeed($.priceFeed).vexToUsdt(vexAmount);
        if (usdtValue < v.usdtMin || usdtValue > v.usdtMax) revert OutOfRange(usdtValue, v.usdtMin, v.usdtMax);
        if (usdtValue < minUsdtValue) revert Slippage(usdtValue, minUsdtValue);
        n.entryUsdt = SafeCast.toUint128(usdtValue);
        bool user = source == SOURCE_USER;
        if (user) {
            // Only the VEX credit total is needed here (`usdtMark` is no longer written, it stays 0).
            // slither-disable-next-line unused-return
            (uint256 vexCum, , , ) = net.bonusTotals(msg.sender);
            n.vexMark = SafeCast.toUint128(vexCum);
        }
        stakeId = _open($, n, v.jumpEligible);
        // the cap base is the largest open USER or AIRDROP stake
        net.setCapBase(msg.sender, $.largest[msg.sender].principal);
        if (user) {
            // Network Cashback for the sponsors, after the stake is recorded and the cap base is pushed
            net.onStakeOpened(msg.sender, vexAmount, v.ncRule, v.l1Bps);
            if (v.jumpEligible) _jumpSlot($.jump, msg.sender, poolId, usdtValue);
        }
        _pullExact($.vex, msg.sender, vexAmount, !user);
    }

    /// @dev Checks pool `poolId` takes stakes and writes its id and newest version into `n`; returns its parameters.
    function _openPool(
        StakingStorage storage $,
        uint256 poolId,
        Stake memory n
    ) private view returns (PoolParams storage) {
        Pool storage p = _pool($, poolId);
        if (!p.launched || !p.enabled) revert PoolClosed(poolId);
        if (n.source == SOURCE_AIRDROP && !p.airdropAllowed) revert AirdropPoolNotAllowed(poolId);
        // poolId <= 255 (checked by `_pool`)
        n.poolId = uint8(poolId);
        n.version = p.versionCount;
        return $.versions[poolId][p.versionCount];
    }

    /// @dev VEX Jump slot for a USER stake of a jump-eligible pool. A reverting Jump never blocks the stake.
    function _jumpSlot(address jump_, address account, uint256 poolId, uint256 entryUsdt) private {
        if (jump_ == address(0)) return;
        // solhint-disable-next-line no-empty-blocks
        try IJump(jump_).onStakeOpened(account, poolId, entryUsdt) {} catch {
            emit JumpHookFailed(account, poolId);
        }
    }

    /// @dev Writes the new stake, adds it to the owner's open list and (USER) to the checkpoints.
    function _open(StakingStorage storage $, Stake memory n, bool jumpEligible) private returns (uint256 stakeId) {
        uint256[] storage list = $.openIds[n.owner];
        if (list.length >= MAX_OPEN_STAKES) revert TooManyStakes(n.owner);
        stakeId = ++$.nextStakeId;
        Stake storage s = $.stakes[stakeId];
        s.owner = n.owner;
        s.openedAt = uint40(block.timestamp);
        s.poolId = n.poolId;
        s.version = n.version;
        s.source = n.source;
        s.state = STATE_OPEN;
        // at most 50 entries
        s.openIndex = uint8(list.length);
        s.principal = n.principal;
        s.entryUsdt = n.entryUsdt;
        s.vexMark = n.vexMark;
        list.push(stakeId);
        $.totalPrincipal += n.principal;
        StakingMath.recordOpen($, stakeId, jumpEligible);
        emit StakeOpened(
            n.owner,
            stakeId,
            n.poolId,
            n.version,
            n.source,
            n.principal,
            n.entryUsdt,
            n.vexMark,
            n.usdtMark
        );
    }

    /// @dev Takes an OPEN stake out of the open list and the checkpoints, settles `accrued` into the owner's income and
    ///      records the close; the caller sets the final state. Pushes the new cap base for USER and AIRDROP stakes.
    function _closeOpen(
        StakingStorage storage $,
        INetwork net,
        Stake storage s,
        uint256 stakeId,
        uint256 accrued
    ) private {
        address owner = s.owner;
        // the cap base falls to the next largest open USER or AIRDROP stake (a JUMP stake is not counted)
        (bool counted, uint256 base) = StakingMath.closeOpen($, stakeId, accrued);
        if (counted) net.setCapBase(owner, base);
    }

    function _owned(
        StakingStorage storage $,
        uint256 stakeId,
        uint8 expectedState
    ) private view returns (Stake storage s) {
        s = $.stakes[stakeId];
        if (s.owner != msg.sender) revert StakeNotOwned(stakeId);
        if (s.state != expectedState) revert WrongState(stakeId, s.state);
    }

    function _requireNotHeld(StakingStorage storage $, uint256 stakeId, Stake storage s) private view {
        if (isHeld($, stakeId, s)) revert StakeOnHold(stakeId);
    }

    function _requireNotFrozen(INetwork net, address account) private view {
        if (net.isFrozen(account)) revert NotActive(account);
    }

    function _accruedAt(StakingStorage storage $, uint256 stakeId, uint256 at) private view returns (uint256) {
        return
            $.stakes[stakeId].state == STATE_OPEN
                ? StakingMath.accruedAt($, stakeId, at)
                : $.stakes[stakeId].finalAccrued;
    }

    // ------------------------------------------------------------------ internals: refund cap

    function _refundUsedToday(StakingStorage storage $) private view returns (uint256) {
        // Day counter comparison, not a balance check.
        // slither-disable-next-line incorrect-equality
        return $.refundDay == block.timestamp / 1 days ? $.refundUsed : 0;
    }

    function _useRefund(StakingStorage storage $, uint256 refund) private {
        uint256 used = _refundUsedToday($);
        $.refundDay = uint40(block.timestamp / 1 days);
        $.refundUsed = used + refund;
    }

    // ------------------------------------------------------------------ internals: pools and tokens

    function _pool(StakingStorage storage $, uint256 poolId) private view returns (Pool storage) {
        if (poolId == 0 || poolId > $.poolCount) revert UnknownPool(poolId);
        return $.pools[poolId];
    }

    /// @dev Pulls `amount` (an airdrop-locked amount through the token's `spendAirdrop`) and checks this contract
    ///      received all of it (fails when it is not fee-exempt).
    function _pullExact(address vex_, address from, uint256 amount, bool airdrop) private {
        IERC20 token = IERC20(vex_);
        uint256 before = token.balanceOf(address(this));
        if (airdrop) {
            // The VEX token is a plain ERC20 without hooks and this function runs under `nonReentrant`; the balance
            // difference below is exactly the check that the whole amount arrived.
            // slither-disable-next-line reentrancy-balance
            IVexaro(vex_).spendAirdrop(from, amount);
        } else {
            // `from` is the caller: the staker, or the Jump contract that approved this contract.
            // slither-disable-next-line arbitrary-send-erc20
            token.safeTransferFrom(from, address(this), amount);
        }
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert FeeNotExempt(amount, received);
    }

    /// @dev Sends `amount` and checks `to` received all of it.
    function _payExact(address vex_, address to, uint256 amount) private {
        IERC20 token = IERC20(vex_);
        uint256 before = token.balanceOf(to);
        token.safeTransfer(to, amount);
        uint256 received = token.balanceOf(to) - before;
        if (received != amount) revert FeeNotExempt(amount, received);
    }

    function _vexExcess(StakingStorage storage $) private view returns (uint256) {
        return IERC20($.vex).balanceOf(address(this)) - $.totalPrincipal;
    }

    function _setRewardVault(StakingStorage storage $, address newVault) private {
        if (newVault == address(0)) revert ZeroAddress();
        emit RewardVaultChanged($.rewardVault, newVault);
        $.rewardVault = newVault;
    }

    function _setNetwork(StakingStorage storage $, address newNetwork) private {
        _requireContract(newNetwork);
        emit NetworkChanged($.network, newNetwork);
        $.network = newNetwork;
    }

    function _setPriceFeed(StakingStorage storage $, address newPriceFeed) private {
        _requireContract(newPriceFeed);
        emit PriceFeedChanged($.priceFeed, newPriceFeed);
        $.priceFeed = newPriceFeed;
    }

    function _requireContract(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotAContract(account);
    }
}
