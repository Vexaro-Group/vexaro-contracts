// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Managed} from "./abstracts/Managed.sol";
import {BPS, BURN_BPS, SOURCE_JUMP, SOURCE_USER, STATE_CLOSED, STATE_OPEN} from "./abstracts/StakingStore.sol";
import {IJump} from "./interfaces/IJump.sol";
import {INetwork} from "./interfaces/INetwork.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {IStakeReader} from "./interfaces/IStakeReader.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {ITokenSale} from "./interfaces/ITokenSale.sol";

/// @title Jump
/// @notice VEX Jump: the first four direct invitees of an account that open an own
///         stake in a cycle earn the account a free stake, the grant, after a review period in which the admin can
///         reject it. The contract holds the Jump VEX allocation and nothing else; no backend key moves money.
///
///         Cycles (UTC). Cycle c (from 1) of an account U is the 7 UTC days [d + 7 (c - 1), d + 7 c) where d is the
///         UTC day of `Network.joinedAt(U)`, the account's first on-chain transaction. Its first day is
///         the join day itself, so an account that joined at 23:59:59 has only one second of day one in cycle 1. The
///         cycle ends at 00:00 UTC of day d + 7 c.
///
///         Slots. Staking calls `onStakeOpened` for every USER stake of a jump-eligible pool (P1-P5), in the stake's
///         own transaction. The sponsor U of the staker I gets a slot of its current cycle c when all of these hold:
///         the stake is worth at least 10 USDT (entry value, inclusive), U has joined, I joined inside cycle c (so I
///         staked in the cycle it joined in, as the stake is in c too), I was not counted before and U's cycle c has
///         fewer than four slots. Slots are filled in the order of the stake openings. Per (U, c) the contract keeps
///         the number of slots and the smallest slot (pool, entry USDT; the earlier one on a tie). JUMP and AIRDROP
///         stakes never reach the hook, so they never fill a slot. A stake made before its sponsor's own first
///         transaction counts for nothing (the sponsor has no cycle yet). Pausing does not stop the hook: slots are
///         bookkeeping and Staking is the one that stops stakes.
///
///         Grant. For (U, c) with four slots, `claimJump(c)` by U opens a JUMP stake in the smallest slot's pool for
///         its USDT amount clamped to 10 - 5 000 USDT, converted at the PriceFeed price (floor; no price = revert),
///         paid from this contract's own VEX through `Staking.createGrantStake` (this contract holds GRANTER_ROLE
///         there). Conditions, checked in this order: ENTRIES not paused; U is active (registered, not frozen); the
///         cycle has four slots; not claimed; not rejected; `now >= cycleEnd + reviewPeriod` (72 h by default, to the
///         second); U had an open own P1-P5 stake at the cycle's end (`Staking.openP15At(U, cycleEnd) > 0`: a stake
///         closed at the cycle end second or before does not count, one closed a second later does); each of the four
///         stakes that filled the slots is still open (`InviteeStakeClosed`, final) and at least
///         `MIN_INVITEE_STAKE_AGE` (3 days) old (`InviteeStakeTooYoung` with the moment the youngest reaches it).
///         Grants do not expire. A grant that is not eligible at the cycle's end (no open stake) can never become
///         eligible: the checkpoint at that second is history. `claimJump(c, minVexOut)` reverts `Slippage` when the
///         grant converts to fewer VEX.
///
///         Slot stakes. The hook records the id of the stake that filled each slot (the newest of the invitee's open
///         stakes in `Staking.openStakesOf`, 0 when it has none). A cycle that was filled before the stakes were
///         recorded has no ids: its claim reverts `InviteeStakesUnrecorded` until OPERATOR gives the four stakes to
///         `recordSlotStakes`, which checks each one and can not overwrite a recorded cycle. After that the cycle
///         follows the same rules. `claimability` tells whether a grant can be claimed now and from when.
///
///         Sell credit. The principal of a grant stake is new platform VEX that Staking pays back at maturity (95 %).
///         The claim only records that amount; `releaseGrantCredit` (anyone, for the account) hands it to the
///         TokenSale as the stake pays it back: everything once a FULL pool closes the stake, the claimed part while a
///         VEST pool vests. A grant claimed before this rule was credited at the claim and has nothing recorded.
///
///         Review. The review period is the admin's manual check (e-mail, fraud signals, shared devices).
///         GUARDIAN or OPERATOR rejects a grant (`rejectGrant`, deny-only) until it is claimed; only OPERATOR lifts a
///         rejection (`restoreGrant`).
///
///         Four grants at most. An account earns grants only for its FIRST FOUR ELIGIBLE full
///         cycles, in cycle order. A full cycle is eligible when the account had an open own P1-P5 stake at the
///         cycle's end (the same `openP15At(U, end) > 0` test `claimJump` runs); a full cycle without one earns nothing
///         and does not use a place. The hook settles the account's full cycles lazily: before it counts a slot for U
///         it walks `fullCycles[U]` from `settled[U]`, evaluates every full cycle that ended before this second once
///         (eligible: `earned[U]++`) and moves `settled[U]` on, so each full cycle is evaluated once over the account's
///         life and a stake pays for at most the cycles that ended since the previous one. No slot is counted while
///         `earned + pending >= 4`, where `pending` are full cycles not settled yet (the one that ends in this very
///         second, whose last checkpoint is not final until the second is over, counts as eligible: the invitee is only
///         asked to stake again a second later). Cycles are sequential, so when a later cycle gets slots every earlier
///         full cycle has ended: eligible cycles can never exceed four. A rejected grant keeps its place (a later cycle
///         does not replace it; `restoreGrant` makes it claimable again) and the four can be claimed in any order.
///
///         Funding. OPERATOR `fund`s the VEX allocation (VEX must be fee-exempt for this contract, which `fund` checks;
///         Staking is exempt itself, so the stake pull is never charged); DEFAULT_ADMIN is the only
///         account that takes tokens out. What the unclaimed grants will need is not known on chain, so `withdraw` is
///         not limited by them.
///
///         Roles. HOOK_ROLE: Staking. GRANTER_ROLE on Staking: this contract. GUARDIAN / OPERATOR / DEFAULT_ADMIN as in
///         `Managed`.
///
///         Storage (ERC-7201 `vexaro.storage.Jump`): wiring addresses and the review period; per (account, cycle) one
///         slot (slots 1 B | smallest pool 1 B | smallest USDT 16 B | rejected 1 B | reason 1 B | claimed 1 B | stake
///         id 8 B); per invitee a counted flag; per account the grants claimed and the list of its full cycles;
///         appended later: the TokenSale, the four slot stake ids per (account, cycle) and the sell credit of a grant
///         (total | credited) per (account, cycle).
contract Jump is IJump, Managed {
    using SafeERC20 for IERC20;

    bytes32 public constant HOOK_ROLE = keccak256("HOOK_ROLE");

    /// @notice Days of a cycle.
    uint256 public constant CYCLE_DAYS = 7;
    /// @notice Slots of a cycle.
    uint256 public constant SLOTS = 4;
    /// @notice Full cycles (and so grants) an account can earn over its life: the first four.
    uint256 public constant MAX_GRANTS = 4;
    /// @notice The smallest stake (entry USDT, wei) that fills a slot.
    uint256 public constant MIN_ENTRY_USDT = 10 ether;
    /// @notice The grant's USDT amount is clamped to 10 - 5 000 USDT: the lower bound is `MIN_ENTRY_USDT` (no slot is
    ///         smaller), the upper one this (wei).
    uint256 public constant GRANT_MAX_USDT = 5_000 ether;
    uint256 public constant DEFAULT_REVIEW_PERIOD = 72 hours;
    /// @notice Upper bound of the review period, so a setting error can not lock grants for good.
    uint256 public constant MAX_REVIEW_PERIOD = 30 days;
    /// @notice Lower bound of the review period: a grant is claimed strictly after the cycle's end second, so the
    ///         checkpoint it reads is final.
    uint256 public constant MIN_REVIEW_PERIOD = 1;
    /// @notice How old each of the four invitee stakes of a cycle must be when its grant is claimed.
    uint256 public constant MIN_INVITEE_STAKE_AGE = 3 days;

    /// @dev `status` of a cycle in `cycle()`.
    uint8 public constant STATUS_NONE = 0; // fewer than four slots
    uint8 public constant STATUS_RUNNING = 1; // four slots, cycle not over
    uint8 public constant STATUS_NOT_ELIGIBLE = 2; // over, but no open own P1-P5 stake at its end
    uint8 public constant STATUS_REVIEW = 3; // over, eligible, review period running
    uint8 public constant STATUS_CLAIMABLE = 4;
    uint8 public constant STATUS_REJECTED = 5;
    uint8 public constant STATUS_CLAIMED = 6;
    uint8 public constant STATUS_STAKES_UNRECORDED = 7; // review over, but the four invitee stakes are not recorded
    uint8 public constant STATUS_INVITEE_CLOSED = 8; // review over, an invitee stake was closed: never claimable
    uint8 public constant STATUS_INVITEE_YOUNG = 9; // review over, an invitee stake is younger than 3 days

    struct Cycle {
        uint8 slots;
        uint8 poolId;
        uint128 usdt;
        bool rejected;
        uint8 rejectReason;
        bool claimed;
        uint64 stakeId;
    }

    /// @dev Everything the UI shows about one cycle. `start` / `end` are 0 for an account that has not joined;
    ///      `poolId` / `usdt` are the smallest slot (the grant's pool and unclamped USDT), `claimableAt` is
    ///      `end + reviewPeriod`.
    struct CycleView {
        uint256 cycleNo;
        uint256 start;
        uint256 end;
        uint256 slots;
        uint256 poolId;
        uint256 usdt;
        uint256 claimableAt;
        bool rejected;
        uint8 rejectReason;
        bool claimed;
        uint256 stakeId;
        uint8 status;
    }

    /// @dev The cabinet's summary: the current cycle, the grants and whether the account has an open stake now.
    struct JumpStatus {
        bool member;
        uint256 cycleNo;
        uint256 start;
        uint256 end;
        uint256 slots;
        uint256 poolId;
        uint256 usdt;
        uint256 grantsClaimed;
        uint256 grantsEarned;
        uint256 grantsLeft;
        uint256 fullCycles;
        bool hasOpenStake;
        uint256 allocation;
    }

    /// @dev `settled` is how many entries of the account's `fullCycles` were evaluated, `earned` how many of those had
    ///      an open own P1-P5 stake at their end.
    struct AccountState {
        uint32 grantsClaimed;
        uint32 settled;
        uint32 earned;
    }

    /// @dev The sell credit of a grant stake: `total` is what the stake pays back (95 % of the principal), `credited`
    ///      the part already given to the TokenSale.
    struct GrantCredit {
        uint128 total;
        uint128 credited;
    }

    /// @custom:storage-location erc7201:vexaro.storage.Jump
    struct JumpStorage {
        address vex;
        address network;
        address staking;
        address priceFeed;
        uint40 reviewPeriod;
        mapping(address account => mapping(uint256 cycleNo => Cycle)) cycles;
        mapping(address invitee => bool) counted;
        mapping(address account => AccountState) accounts;
        mapping(address account => uint32[]) fullCycles;
        // appended after the initial layout; do not reorder
        address tokenSale;
        mapping(address account => mapping(uint256 cycleNo => uint64[4])) slotStakes;
        mapping(address account => mapping(uint256 cycleNo => GrantCredit)) grantCredits;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.Jump")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant JUMP_STORAGE_LOCATION = 0x018f181761ddf93650fde40a0085e55dc3171e2575172d42004212b1bdf03d00;

    /// @param slot 1..4, the order of the stake openings.
    event SlotFilled(
        address indexed sponsor,
        uint256 indexed cycleNo,
        address indexed invitee,
        uint8 slot,
        uint256 poolId,
        uint256 entryUsdt
    );
    /// @notice The fourth slot was filled: the grant exists (if its conditions hold at the cycle's end). `poolId` and
    ///         `usdt` are the smallest slot.
    event CycleFull(
        address indexed sponsor,
        uint256 indexed cycleNo,
        uint256 poolId,
        uint256 usdt,
        uint256 cycleEnd,
        uint256 claimableAt
    );
    event GrantRejected(address indexed account, uint256 indexed cycleNo, uint8 reason, address indexed by);
    event GrantRestored(address indexed account, uint256 indexed cycleNo, address indexed by);
    /// @param usdt The USDT amount after the 10 - 5 000 clamp.
    event GrantClaimed(
        address indexed account,
        uint256 indexed cycleNo,
        uint256 indexed stakeId,
        uint256 poolId,
        uint256 usdt,
        uint256 vexAmount
    );
    /// @notice The stakes that filled the four slots of a cycle were recorded by hand (cycles filled before the
    ///         stakes were recorded on the slot).
    event SlotStakesRecorded(address indexed account, uint256 indexed cycleNo, uint256[4] stakeIds, address indexed by);
    /// @notice `amount` VEX of the grant stake's principal was paid back and became sellable at the current price.
    event GrantCreditReleased(address indexed account, uint256 indexed cycleNo, uint256 amount);
    event Funded(address indexed funder, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event ReviewPeriodSet(uint256 oldPeriod, uint256 newPeriod);
    event NetworkChanged(address indexed oldNetwork, address indexed newNetwork);
    event StakingChanged(address indexed oldStaking, address indexed newStaking);
    event PriceFeedChanged(address indexed oldPriceFeed, address indexed newPriceFeed);
    event TokenSaleChanged(address indexed oldTokenSale, address indexed newTokenSale);

    error ZeroAmount();
    error NotAContract(address account);
    /// @dev The account is not registered or is frozen.
    error NotActive(address account);
    /// @dev The cycle (numbers start at 1) has fewer than four slots.
    error NoGrant(address account, uint256 cycleNo);
    error AlreadyClaimed(uint256 cycleNo);
    /// @dev The admin rejected the grant (`reason` is the code it gave).
    error Rejected(uint256 cycleNo, uint8 reason);
    /// @dev The review period runs until `claimableAt`.
    error ReviewPending(uint256 claimableAt);
    /// @dev The account had no open own P1-P5 stake at `cycleEnd`.
    error NoOpenStake(uint256 cycleEnd);
    /// @dev The four stakes that filled the slots of the cycle are not recorded (the cycle was filled before they
    ///      were); OPERATOR records them with `recordSlotStakes`.
    error InviteeStakesUnrecorded(uint256 cycleNo);
    /// @dev One of the four invitee stakes was closed, so the grant can not be claimed any more.
    error InviteeStakeClosed(uint256 cycleNo, uint256 stakeId);
    /// @dev One of the four invitee stakes is younger than `MIN_INVITEE_STAKE_AGE`; the youngest reaches it at
    ///      `availableAt`.
    error InviteeStakeTooYoung(uint256 cycleNo, uint40 availableAt);
    /// @dev The grant converted to fewer VEX than the caller's `minVexOut` (`actual < limit`).
    error Slippage(uint256 actual, uint256 limit);
    /// @dev A stake given to `recordSlotStakes` is not a stake that could have filled a slot of the cycle.
    error InvalidSlotStake(uint256 stakeId);
    /// @dev The slot stakes of the cycle are recorded already.
    error InviteeStakesAlreadyRecorded(uint256 cycleNo);
    /// @dev The grant stake has paid back nothing new (or there is no TokenSale to credit).
    error NothingToRelease(uint256 cycleNo);
    error AllocationShort(uint256 held, uint256 needed);
    error FeeNotExempt(uint256 expected, uint256 received);
    error InvalidPeriod(uint256 period);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin Gets the governance roles (see `Managed`).
    /// @param vex_ The VEX token (this contract must be fee-exempt on it).
    /// @param network_ Network (sponsors, join times, freezes).
    /// @param staking_ Staking (this contract needs GRANTER_ROLE there and holds HOOK_ROLE for it here).
    /// @param priceFeed_ PriceFeed.
    function initialize(
        address admin,
        address vex_,
        address network_,
        address staking_,
        address priceFeed_
    ) external initializer {
        __Managed_init(admin);
        _requireContract(vex_);
        JumpStorage storage $ = _jumpStorage();
        $.vex = vex_;
        _setNetwork($, network_);
        _setStaking($, staking_);
        _setPriceFeed($, priceFeed_);
        $.reviewPeriod = uint40(DEFAULT_REVIEW_PERIOD);
        emit ReviewPeriodSet(0, DEFAULT_REVIEW_PERIOD);
    }

    /// @notice The TokenSale that gets the sell credit of grants (DEFAULT_ADMIN); zero switches the credit off.
    function setTokenSale(address newTokenSale) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTokenSale(_jumpStorage(), newTokenSale);
    }

    function tokenSale() external view returns (address) {
        return _jumpStorage().tokenSale;
    }

    // ------------------------------------------------------------------ slots (Staking)

    /// @inheritdoc IJump
    function onStakeOpened(address account, uint256 poolId, uint256 entryUsdt) external onlyRole(HOOK_ROLE) {
        JumpStorage storage $ = _jumpStorage();
        (address sponsor, uint256 cycleNo, uint256 sponsorJoined) = _admit($, account, entryUsdt);
        if (sponsor == address(0)) return;

        Cycle storage c = $.cycles[sponsor][cycleNo];
        uint256 filled = c.slots;
        if (filled >= SLOTS) return;
        $.counted[account] = true;
        c.slots = uint8(filled + 1);
        $.slotStakes[sponsor][cycleNo][filled] = _newestStake($, account);
        // The earlier slot keeps the place on a tie.
        if (filled == 0 || entryUsdt < c.usdt) {
            c.poolId = SafeCast.toUint8(poolId);
            c.usdt = SafeCast.toUint128(entryUsdt);
        }
        emit SlotFilled(sponsor, cycleNo, account, uint8(filled + 1), poolId, entryUsdt);
        if (filled + 1 == SLOTS) {
            $.fullCycles[sponsor].push(SafeCast.toUint32(cycleNo));
            uint256 end = _cycleEnd(sponsorJoined, cycleNo);
            emit CycleFull(sponsor, cycleNo, c.poolId, c.usdt, end, end + $.reviewPeriod);
        }
    }

    // ------------------------------------------------------------------ grants

    /// @notice Opens the caller's JUMP stake for the grant of cycle `cycleNo` (see the contract notes for the
    ///         conditions and their order). The stake id is returned.
    function claimJump(uint256 cycleNo) external whenNotPaused(ENTRIES) nonReentrant returns (uint256 stakeId) {
        return _claim(cycleNo, 0);
    }

    /// @notice `claimJump` that reverts `Slippage(vexAmount, minVexOut)` when the grant converts to fewer VEX than
    ///         `minVexOut` at the price of the block it is included in.
    function claimJump(
        uint256 cycleNo,
        uint256 minVexOut
    ) external whenNotPaused(ENTRIES) nonReentrant returns (uint256 stakeId) {
        return _claim(cycleNo, minVexOut);
    }

    function _claim(uint256 cycleNo, uint256 minVexOut) private returns (uint256 stakeId) {
        JumpStorage storage $ = _jumpStorage();
        if (!INetwork($.network).isActive(msg.sender)) revert NotActive(msg.sender);
        Cycle storage c = $.cycles[msg.sender][cycleNo];
        _requireClaimable($, c, cycleNo);

        uint256 usdt = c.usdt > GRANT_MAX_USDT ? GRANT_MAX_USDT : c.usdt;
        // Reverts `PriceUnavailable` while there is no VEX price.
        uint256 vexAmount = IPriceFeed($.priceFeed).usdtToVex(usdt);
        if (vexAmount < minVexOut) revert Slippage(vexAmount, minVexOut);
        uint256 held = IERC20($.vex).balanceOf(address(this));
        if (held < vexAmount) revert AllocationShort(held, vexAmount);

        c.claimed = true;
        $.accounts[msg.sender].grantsClaimed++;
        IERC20($.vex).forceApprove($.staking, vexAmount);
        uint256 poolId = c.poolId;
        stakeId = IStaking($.staking).createGrantStake(msg.sender, poolId, vexAmount, SOURCE_JUMP);
        // The id exists only after the stake is opened; `claimed` is already set and the guard is on.
        // slither-disable-next-line reentrancy-benign
        c.stakeId = SafeCast.toUint64(stakeId);
        // The grant principal is new platform VEX that Staking pays back to the account (95 %, 5 % is burned at the
        // close). It becomes sellable at the current price as it is paid back (`releaseGrantCredit`), not now.
        if ($.tokenSale != address(0)) {
            $.grantCredits[msg.sender][cycleNo].total = SafeCast.toUint128(vexAmount - (vexAmount * BURN_BPS) / BPS);
        }
        emit GrantClaimed(msg.sender, cycleNo, stakeId, poolId, usdt, vexAmount);
    }

    /// @notice Gives `account` the sell credit for the part of the cycle's grant stake that Staking has paid back so
    ///         far: all of it once the stake is closed (a FULL pool pays at the close), the claimed part while a VEST
    ///         pool vests. Anyone may call it; the credit goes to `account`. Returns the VEX credited. Reverts
    ///         `NothingToRelease` when nothing new was paid back, the grant was claimed before the credit was
    ///         deferred (it was credited at the claim) or no TokenSale is set.
    function releaseGrantCredit(address account, uint256 cycleNo) external nonReentrant returns (uint256 amount) {
        JumpStorage storage $ = _jumpStorage();
        amount = _releasable($, account, cycleNo);
        address sale = $.tokenSale;
        if (amount == 0 || sale == address(0)) revert NothingToRelease(cycleNo);
        $.grantCredits[account][cycleNo].credited += SafeCast.toUint128(amount);
        ITokenSale(sale).creditCurrentSell(account, amount);
        emit GrantCreditReleased(account, cycleNo, amount);
    }

    /// @notice Records the four stakes that filled the slots of a full cycle that was filled before the contract
    ///         recorded them (OPERATOR). Each must be a USER stake worth at least `MIN_ENTRY_USDT` opened inside the
    ///         cycle by a different invitee of `account` that was counted. Cannot overwrite a recorded cycle.
    function recordSlotStakes(
        address account,
        uint256 cycleNo,
        uint256[4] calldata stakeIds
    ) external onlyRole(OPERATOR_ROLE) {
        JumpStorage storage $ = _jumpStorage();
        Cycle storage c = _fullCycle(account, cycleNo);
        if (c.claimed) revert AlreadyClaimed(cycleNo);
        uint64[4] storage slots = $.slotStakes[account][cycleNo];
        if (slots[0] != 0) revert InviteeStakesAlreadyRecorded(cycleNo);
        uint256 joined = INetwork($.network).joinedAt(account);
        uint256 start = _cycleStart(joined, cycleNo);
        uint256 end = _cycleEnd(joined, cycleNo);
        address[4] memory owners;
        for (uint256 i = 0; i < SLOTS; ++i) {
            IStaking.StakeView memory v = IStakeReader($.staking).stakeView(stakeIds[i]);
            if (
                v.source != SOURCE_USER ||
                v.entryUsdt < MIN_ENTRY_USDT ||
                v.openedAt < start ||
                v.openedAt >= end ||
                !$.counted[v.owner] ||
                INetwork($.network).sponsorOf(v.owner) != account
            ) revert InvalidSlotStake(stakeIds[i]);
            // Four different invitees: an account can not repeat.
            for (uint256 j = 0; j < i; ++j) {
                if (owners[j] == v.owner) revert InvalidSlotStake(stakeIds[i]);
            }
            owners[i] = v.owner;
            slots[i] = SafeCast.toUint64(stakeIds[i]);
        }
        emit SlotStakesRecorded(account, cycleNo, stakeIds, msg.sender);
    }

    /// @notice Rejects the grant of `account`'s cycle `cycleNo` (GUARDIAN or OPERATOR; deny-only) until it is
    ///         claimed. `reason` is a code for the review log. Reverts `NoChange(reason)` when already rejected.
    function rejectGrant(address account, uint256 cycleNo, uint8 reason) external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender)) _checkRole(OPERATOR_ROLE);
        Cycle storage c = _fullCycle(account, cycleNo);
        if (c.claimed) revert AlreadyClaimed(cycleNo);
        if (c.rejected) revert NoChange(reason);
        c.rejected = true;
        c.rejectReason = reason;
        emit GrantRejected(account, cycleNo, reason, msg.sender);
    }

    /// @notice Lifts a rejection (OPERATOR only). Reverts `NoChange(0)` when the grant is not rejected.
    function restoreGrant(address account, uint256 cycleNo) external onlyRole(OPERATOR_ROLE) {
        Cycle storage c = _fullCycle(account, cycleNo);
        if (!c.rejected) revert NoChange(0);
        c.rejected = false;
        c.rejectReason = 0;
        emit GrantRestored(account, cycleNo, msg.sender);
    }

    // ------------------------------------------------------------------ allocation

    /// @notice Adds `amount` VEX to the Jump allocation, pulled from the caller (OPERATOR); reverts when VEX charged
    ///         a fee.
    function fund(uint256 amount) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 token = IERC20(_jumpStorage().vex);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert FeeNotExempt(amount, received);
        emit Funded(msg.sender, amount);
    }

    /// @notice Sends `amount` of `token` out (DEFAULT_ADMIN). Not limited by grants that are
    ///         still to be claimed.
    function withdraw(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the review period in seconds (DEFAULT_ADMIN), 1 second .. 30 days. It applies to every grant that
    ///         is not claimed yet.
    function setReviewPeriod(uint256 newPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPeriod < MIN_REVIEW_PERIOD || newPeriod > MAX_REVIEW_PERIOD) revert InvalidPeriod(newPeriod);
        JumpStorage storage $ = _jumpStorage();
        emit ReviewPeriodSet($.reviewPeriod, newPeriod);
        $.reviewPeriod = uint40(newPeriod);
    }

    function setNetwork(address newNetwork) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setNetwork(_jumpStorage(), newNetwork);
    }

    function setStaking(address newStaking) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setStaking(_jumpStorage(), newStaking);
    }

    function setPriceFeed(address newPriceFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPriceFeed(_jumpStorage(), newPriceFeed);
    }

    // ------------------------------------------------------------------ views

    function vex() external view returns (address) {
        return _jumpStorage().vex;
    }

    function network() external view returns (address) {
        return _jumpStorage().network;
    }

    function staking() external view returns (address) {
        return _jumpStorage().staking;
    }

    function priceFeed() external view returns (address) {
        return _jumpStorage().priceFeed;
    }

    function reviewPeriod() external view returns (uint256) {
        return _jumpStorage().reviewPeriod;
    }

    /// @notice VEX held for grants.
    function allocation() external view returns (uint256) {
        return IERC20(_jumpStorage().vex).balanceOf(address(this));
    }

    /// @notice Whether `invitee` already filled a slot.
    function isCounted(address invitee) external view returns (bool) {
        return _jumpStorage().counted[invitee];
    }

    /// @notice Grants `account` has claimed so far (all cycles).
    function grantsClaimedOf(address account) external view returns (uint256) {
        return _jumpStorage().accounts[account].grantsClaimed;
    }

    /// @notice The account's cycle at the current time: its number (0 when it has not joined) and bounds.
    function currentCycle(address account) public view returns (uint256 cycleNo, uint256 start, uint256 end) {
        uint256 joined = INetwork(_jumpStorage().network).joinedAt(account);
        if (joined == 0) return (0, 0, 0);
        cycleNo = (block.timestamp / 1 days - joined / 1 days) / CYCLE_DAYS + 1;
        return (cycleNo, _cycleStart(joined, cycleNo), _cycleEnd(joined, cycleNo));
    }

    /// @notice One cycle of `account` (see `CycleView`); `cycleNo` starts at 1. All zero for an account that has not
    ///         joined.
    function cycle(address account, uint256 cycleNo) public view returns (CycleView memory r) {
        if (cycleNo == 0) return r;
        JumpStorage storage $ = _jumpStorage();
        uint256 joined = INetwork($.network).joinedAt(account);
        if (joined == 0) return r;
        Cycle storage c = $.cycles[account][cycleNo];
        r.cycleNo = cycleNo;
        r.start = _cycleStart(joined, cycleNo);
        r.end = _cycleEnd(joined, cycleNo);
        r.slots = c.slots;
        r.poolId = c.poolId;
        r.usdt = c.usdt;
        r.claimableAt = r.end + $.reviewPeriod;
        r.rejected = c.rejected;
        r.rejectReason = c.rejectReason;
        r.claimed = c.claimed;
        r.stakeId = c.stakeId;
        r.status = _status($, account, c, cycleNo, r.end, r.claimableAt);
    }

    /// @notice Whether the grant of `account`'s cycle can be claimed now and, when it can not yet, from when: `status`
    ///         is the one of `cycle()`; `availableAt` is the first second the claim can work (0 when it is open now
    ///         or can not work any more: claimed, rejected, closed invitee stake, no grant).
    function claimability(
        address account,
        uint256 cycleNo
    ) external view returns (bool claimableNow, uint256 availableAt, uint8 status) {
        CycleView memory r = cycle(account, cycleNo);
        status = r.status;
        claimableNow = status == STATUS_CLAIMABLE;
        if (status == STATUS_REVIEW || status == STATUS_INVITEE_YOUNG) {
            availableAt = r.claimableAt;
            (uint8 problem, uint256 detail) = _inviteeStakes(_jumpStorage(), account, cycleNo);
            if (problem == 3 && detail > availableAt) availableAt = detail;
        }
    }

    /// @notice The stake ids that filled the four slots of `account`'s cycle (0 where not recorded).
    function slotStakesOf(address account, uint256 cycleNo) external view returns (uint64[4] memory) {
        return _jumpStorage().slotStakes[account][cycleNo];
    }

    /// @notice The sell credit of a grant: `total` the stake pays back, `credited` already given, `releasable` what
    ///         `releaseGrantCredit` would give now. All 0 for a grant claimed before the credit was deferred.
    function grantCreditOf(
        address account,
        uint256 cycleNo
    ) external view returns (uint256 total, uint256 credited, uint256 releasable) {
        JumpStorage storage $ = _jumpStorage();
        GrantCredit storage g = $.grantCredits[account][cycleNo];
        return (g.total, g.credited, _releasable($, account, cycleNo));
    }

    /// @notice The cycle numbers of `account` that filled all four slots, oldest first.
    function grantsOf(address account) external view returns (uint256[] memory result) {
        uint32[] storage list = _jumpStorage().fullCycles[account];
        result = new uint256[](list.length);
        for (uint256 i; i < result.length; ++i) result[i] = list[i];
    }

    /// @notice The cabinet's summary of `account`: the current cycle, the grants and whether it has an open own P1-P5
    ///         stake now.
    function jumpStatus(address account) external view returns (JumpStatus memory r) {
        JumpStorage storage $ = _jumpStorage();
        (uint256 cycleNo, uint256 start, uint256 end) = currentCycle(account);
        r.member = cycleNo != 0;
        r.cycleNo = cycleNo;
        r.start = start;
        r.end = end;
        Cycle storage c = $.cycles[account][cycleNo];
        r.slots = c.slots;
        r.poolId = c.poolId;
        r.usdt = c.usdt;
        r.grantsClaimed = $.accounts[account].grantsClaimed;
        // eligible full cycles settled up to now; the places not used yet are what a coming cycle can still earn
        (, uint32 earned, ) = _settled($, account, INetwork($.network).joinedAt(account));
        r.grantsEarned = earned;
        r.grantsLeft = MAX_GRANTS - earned;
        r.fullCycles = $.fullCycles[account].length;
        r.hasOpenStake = IStaking($.staking).openP15Now(account) != 0;
        r.allocation = IERC20($.vex).balanceOf(address(this));
    }

    // ------------------------------------------------------------------ internals

    /// @dev 00:00 UTC of the first day of cycle `cycleNo` for an account that joined at `joined`.
    function _cycleStart(uint256 joined, uint256 cycleNo) private pure returns (uint256) {
        return (joined / 1 days + (cycleNo - 1) * CYCLE_DAYS) * 1 days;
    }

    /// @dev 00:00 UTC of the day after the cycle: the cycle is [start, end).
    function _cycleEnd(uint256 joined, uint256 cycleNo) private pure returns (uint256) {
        return (joined / 1 days + cycleNo * CYCLE_DAYS) * 1 days;
    }

    /// @dev `_qualify` plus the settlement: the sponsor, its cycle number and its join time when the stake fills a slot
    ///      of the sponsor's cycle in principle and the sponsor still has a place among its four grants; a zero sponsor
    ///      otherwise.
    function _admit(
        JumpStorage storage $,
        address account,
        uint256 entryUsdt
    ) private returns (address sponsor, uint256 cycleNo, uint256 sponsorJoined) {
        (sponsor, cycleNo, sponsorJoined) = _qualify($, account, entryUsdt);
        if (sponsor != address(0) && !_hasPlace($, sponsor, sponsorJoined)) return (address(0), 0, 0);
    }

    /// @dev Settles the sponsor's full cycles that ended and says whether a place among the four is left.
    function _hasPlace(JumpStorage storage $, address sponsor, uint256 joined) private returns (bool) {
        (uint32 idx, uint32 earned, uint256 pending) = _settled($, sponsor, joined);
        AccountState storage a = $.accounts[sponsor];
        if (idx != a.settled) {
            a.settled = idx;
            a.earned = earned;
        }
        return earned + pending < MAX_GRANTS;
    }

    /// @dev Walks the full cycles from `settled` that ended before this second: `earned` counts those with an open own
    ///      P1-P5 stake at their end, `pending` are the ones left (ending now or later).
    function _settled(
        JumpStorage storage $,
        address account,
        uint256 joined
    ) private view returns (uint32 idx, uint32 earned, uint256 pending) {
        AccountState storage a = $.accounts[account];
        idx = a.settled;
        earned = a.earned;
        uint32[] storage list = $.fullCycles[account];
        uint256 n = list.length;
        while (idx < n) {
            uint256 end = _cycleEnd(joined, list[idx]);
            if (end >= block.timestamp) break;
            // The same test `claimJump` runs: a count of open stakes at a past second, not a balance.
            // slither-disable-start calls-loop,incorrect-equality
            if (IStaking($.staking).openP15At(account, end) != 0) earned++;
            // slither-disable-end calls-loop,incorrect-equality
            idx++;
        }
        pending = n - idx;
    }

    /// @dev The sponsor, the sponsor's cycle number and its join time when a stake of `account` worth `entryUsdt`
    ///      qualifies for a slot; a zero sponsor when it does not (small stake, counted before, no sponsor, sponsor not
    ///      joined, invitee joined before the cycle).
    function _qualify(
        JumpStorage storage $,
        address account,
        uint256 entryUsdt
    ) private view returns (address sponsor, uint256 cycleNo, uint256 sponsorJoined) {
        if (entryUsdt < MIN_ENTRY_USDT || $.counted[account]) return (address(0), 0, 0);
        INetwork net = INetwork($.network);
        sponsor = net.sponsorOf(account);
        sponsorJoined = sponsor == address(0) ? 0 : net.joinedAt(sponsor);
        // A sponsor that has not made its first transaction has no cycle yet.
        if (sponsorJoined == 0) return (address(0), 0, 0);

        uint256 firstDay = sponsorJoined / 1 days;
        cycleNo = (block.timestamp / 1 days - firstDay) / CYCLE_DAYS + 1;
        // The invitee must have joined inside the cycle (its stake is in the cycle: it is happening now).
        if (net.joinedAt(account) / 1 days < firstDay + (cycleNo - 1) * CYCLE_DAYS) return (address(0), 0, 0);
    }

    /// @dev Reverts unless the caller's grant of cycle `cycleNo` can be claimed;
    function _requireClaimable(JumpStorage storage $, Cycle storage c, uint256 cycleNo) private view {
        if (c.slots < SLOTS) revert NoGrant(msg.sender, cycleNo);
        if (c.claimed) revert AlreadyClaimed(cycleNo);
        if (c.rejected) revert Rejected(cycleNo, c.rejectReason);
        uint256 end = _cycleEnd(INetwork($.network).joinedAt(msg.sender), cycleNo);
        uint256 claimableAt = end + $.reviewPeriod;
        if (block.timestamp < claimableAt) revert ReviewPending(claimableAt);
        // A count of open stakes at a past second, not a balance anybody can move.
        // slither-disable-next-line incorrect-equality
        if (IStaking($.staking).openP15At(msg.sender, end) == 0) revert NoOpenStake(end);
        _requireInviteeStakes($, cycleNo);
    }

    /// @dev Reverts unless the four stakes that filled the caller's slots of the cycle are recorded, open and old
    ///      enough.
    function _requireInviteeStakes(JumpStorage storage $, uint256 cycleNo) private view {
        (uint8 problem, uint256 detail) = _inviteeStakes($, msg.sender, cycleNo);
        if (problem == 1) revert InviteeStakesUnrecorded(cycleNo);
        if (problem == 2) revert InviteeStakeClosed(cycleNo, detail);
        if (problem == 3) revert InviteeStakeTooYoung(cycleNo, uint40(detail));
    }

    /// @dev The stake of `account` that was opened last, 0 when it has none (a hook that is not Staking).
    function _newestStake(JumpStorage storage $, address account) private view returns (uint64) {
        uint256[] memory open = IStakeReader($.staking).openStakesOf(account);
        return open.length == 0 ? 0 : SafeCast.toUint64(open[open.length - 1]);
    }

    /// @dev Checks the four stakes that filled the slots of the cycle: 0 when all are open and old enough; 1 when
    ///      they are not recorded; 2 and the stake id when one was closed (nothing can fix that); 3 and the moment the
    ///      youngest reaches the minimum age.
    function _inviteeStakes(
        JumpStorage storage $,
        address account,
        uint256 cycleNo
    ) private view returns (uint8 problem, uint256 detail) {
        uint64[4] storage ids = $.slotStakes[account][cycleNo];
        for (uint256 i = 0; i < SLOTS; ++i) {
            uint256 id = ids[i];
            if (id == 0) return (1, 0);
            // slither-disable-next-line calls-loop
            IStaking.StakeView memory v = IStakeReader($.staking).stakeView(id);
            if (v.state != STATE_OPEN) return (2, id);
            uint256 at = v.openedAt + MIN_INVITEE_STAKE_AGE;
            if (at > detail) detail = at;
        }
        if (detail > block.timestamp) return (3, detail);
        return (0, 0);
    }

    /// @dev What `releaseGrantCredit` would give for the grant stake of the cycle: what the stake has paid back minus
    ///      what was credited. Nothing without a recorded credit total.
    function _releasable(JumpStorage storage $, address account, uint256 cycleNo) private view returns (uint256) {
        GrantCredit storage g = $.grantCredits[account][cycleNo];
        uint256 total = g.total;
        if (total == 0) return 0;
        IStaking.StakeView memory v = IStakeReader($.staking).stakeView($.cycles[account][cycleNo].stakeId);
        // A FULL pool pays everything when the stake is closed, a VEST pool pays as it vests.
        uint256 paid = v.state == STATE_CLOSED ? total : Math.min(v.vestClaimed, total);
        return paid > g.credited ? paid - g.credited : 0;
    }

    function _fullCycle(address account, uint256 cycleNo) private view returns (Cycle storage c) {
        c = _jumpStorage().cycles[account][cycleNo];
        if (c.slots < SLOTS) revert NoGrant(account, cycleNo);
    }

    function _status(
        JumpStorage storage $,
        address account,
        Cycle storage c,
        uint256 cycleNo,
        uint256 end,
        uint256 claimableAt
    ) private view returns (uint8) {
        if (c.claimed) return STATUS_CLAIMED;
        if (c.rejected) return STATUS_REJECTED;
        if (c.slots < SLOTS) return STATUS_NONE;
        if (block.timestamp < end) return STATUS_RUNNING;
        // slither-disable-next-line incorrect-equality
        if (IStaking($.staking).openP15At(account, end) == 0) return STATUS_NOT_ELIGIBLE;
        if (block.timestamp < claimableAt) return STATUS_REVIEW;
        return _inviteeStatus($, account, cycleNo);
    }

    /// @dev The status of a grant whose review is over: claimable, or what the invitee stakes behind it say.
    function _inviteeStatus(JumpStorage storage $, address account, uint256 cycleNo) private view returns (uint8) {
        (uint8 problem, ) = _inviteeStakes($, account, cycleNo);
        if (problem == 1) return STATUS_STAKES_UNRECORDED;
        if (problem == 2) return STATUS_INVITEE_CLOSED;
        return problem == 3 ? STATUS_INVITEE_YOUNG : STATUS_CLAIMABLE;
    }

    function _setNetwork(JumpStorage storage $, address newNetwork) private {
        _requireContract(newNetwork);
        emit NetworkChanged($.network, newNetwork);
        $.network = newNetwork;
    }

    function _setStaking(JumpStorage storage $, address newStaking) private {
        _requireContract(newStaking);
        emit StakingChanged($.staking, newStaking);
        $.staking = newStaking;
    }

    function _setPriceFeed(JumpStorage storage $, address newPriceFeed) private {
        _requireContract(newPriceFeed);
        emit PriceFeedChanged($.priceFeed, newPriceFeed);
        $.priceFeed = newPriceFeed;
    }

    function _setTokenSale(JumpStorage storage $, address newTokenSale) private {
        if (newTokenSale != address(0)) _requireContract(newTokenSale);
        emit TokenSaleChanged($.tokenSale, newTokenSale);
        $.tokenSale = newTokenSale;
    }

    function _requireContract(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotAContract(account);
    }

    function _jumpStorage() private pure returns (JumpStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := JUMP_STORAGE_LOCATION
        }
    }
}
