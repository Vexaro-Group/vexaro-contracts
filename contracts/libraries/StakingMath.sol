// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {
    BPS,
    BURN_BPS,
    EARLY_CAP,
    EARLY_CLOSE_DELAY,
    EARLY_FEE_BPS,
    EARLY_MATURED,
    EARLY_NO_REFUND,
    EARLY_NOT_OPEN,
    EARLY_NOT_USER,
    EARLY_TOO_SOON,
    MOMENT_OFFSET,
    NC_L1_ONLY,
    NC_LEVELS,
    PARAMS_MODE,
    PARAMS_NC,
    PARAMS_PERIOD,
    PARAMS_RANGE,
    PARAMS_RATES,
    PARAMS_RELEASE,
    PAYOUT_DAILY,
    PAYOUT_THREE_PARTS,
    RELEASE_BATCH_MAX,
    RETURN_FULL,
    RETURN_VEST,
    SOURCE_AIRDROP,
    SOURCE_JUMP,
    SOURCE_USER,
    STATE_CLOSED,
    STATE_NONE,
    STATE_OPEN,
    STATE_VESTING,
    StakingStore,
    halfDay,
    isHeld,
    maturesAt,
    vestTotal
} from "../abstracts/StakingStore.sol";
import {INetwork} from "../interfaces/INetwork.sol";
import {IPriceFeed} from "../interfaces/IPriceFeed.sol";
import {IStaking} from "../interfaces/IStaking.sol";
import {IStakingOwn} from "../interfaces/IStakingOwn.sol";

/// @title StakingMath
/// @notice The numbers of `Staking`: pool validation, the accrual schedule, the income of an account, vesting and the
///         early-close quote. It lives in a library of its own because `Staking` would not fit into one contract
///         (24 KB); the public functions run by DELEGATECALL on `Staking`'s storage (the namespace pointer is passed
///         in) and hold no state. Deploy it once and link it into the `Staking` implementation.
library StakingMath {
    using Checkpoints for Checkpoints.Trace208;

    /// @dev A pool version is well formed (see `Staking.addPoolVersion`); reverts `InvalidPoolParams(reason)`.
    function validate(IStaking.PoolParams calldata p) external pure {
        if (p.usdtMin == 0 || p.usdtMax < p.usdtMin) revert IStaking.InvalidPoolParams(PARAMS_RANGE);
        if (p.dailyBps == 0 || p.dailyBps > BPS || p.maxProfitBps == 0) {
            revert IStaking.InvalidPoolParams(PARAMS_RATES);
        }
        if (p.periodDays == 0) revert IStaking.InvalidPoolParams(PARAMS_PERIOD);
        if (p.payoutMode > PAYOUT_THREE_PARTS || p.returnMode > RETURN_FULL) {
            revert IStaking.InvalidPoolParams(PARAMS_MODE);
        }
        _validateRelease(p);
        if (p.ncRule > NC_L1_ONLY) revert IStaking.InvalidPoolParams(PARAMS_NC);
        if ((p.ncRule == NC_LEVELS) != (p.l1Bps == 0) || p.l1Bps > BPS) {
            revert IStaking.InvalidPoolParams(PARAMS_NC);
        }
    }

    /// @dev Daily pools have no release days; three-part pools have three, rising, the last within the period.
    function _validateRelease(IStaking.PoolParams calldata p) private pure {
        if (p.payoutMode == PAYOUT_DAILY) {
            if (p.releaseDays[0] != 0 || p.releaseDays[1] != 0 || p.releaseDays[2] != 0) {
                revert IStaking.InvalidPoolParams(PARAMS_RELEASE);
            }
        } else if (
            p.releaseDays[0] == 0 ||
            p.releaseDays[0] >= p.releaseDays[1] ||
            p.releaseDays[1] >= p.releaseDays[2] ||
            p.releaseDays[2] > p.periodDays
        ) {
            revert IStaking.InvalidPoolParams(PARAMS_RELEASE);
        }
    }

    /// @dev The staking income of an OPEN stake from the reward moments due at `at` (`type(uint256).max` = the whole
    ///      schedule). Closed stakes have their final accrual in the stake itself.
    function accruedAt(
        StakingStore.StakingStorage storage $,
        uint256 stakeId,
        uint256 at
    ) external view returns (uint256) {
        StakingStore.Stake storage s = $.stakes[stakeId];
        return _accruedAt($, s, $.versions[s.poolId][s.version], _frozenDates($, s.owner), at);
    }

    /// @dev settled + the accrual of every open stake now that is not on hold - claimed (0 if a freeze starting on a
    ///      reward moment lowered the accrual below what was claimed before). The income of a held AIRDROP stake is
    ///      left out (`heldIncome`).
    function income(StakingStore.StakingStorage storage $, address account) external view returns (uint256 total) {
        StakingStore.Account storage a = $.accounts[account];
        total = _openIncome($, account).free + a.settled;
        uint256 claimed = a.claimed;
        return total > claimed ? total - claimed : 0;
    }

    /// @dev Same signatures as the events and errors of `Staking` (an event of the library is emitted from Staking's
    ///      address).
    event IncomeConsumed(address indexed account, uint256 amount, uint256 totalClaimed);
    error ZeroAmount();
    error IncomeExceeded(uint256 amount, uint256 income);

    /// @dev `income` and its part that comes from two-halves pools: what those stakes released (open ones) or settled
    ///      (closed ones) less `claimedHalves`, the part of the claims spent on that income (a claim spends it first).
    ///      The part never exceeds the income.
    function incomeSplit(
        StakingStore.StakingStorage storage $,
        address account
    ) public view returns (uint256 total, uint256 halves) {
        StakingStore.Account storage a = $.accounts[account];
        OpenIncome memory o = _openIncome($, account);
        uint256 claimed = a.claimed;
        total = o.free + a.settled;
        total = total > claimed ? total - claimed : 0;
        halves = o.halves + a.settledHalves;
        uint256 spent = a.claimedHalves;
        halves = halves > spent ? halves - spent : 0;
        if (halves > total) halves = total;
    }

    /// @dev Marks `amount` of the income of `account` as claimed; reverts above the income. Returns the income and its
    ///      two-halves part as they were before.
    function consume(
        StakingStore.StakingStorage storage $,
        address account,
        uint256 amount
    ) external returns (uint256 total, uint256 halves) {
        if (amount == 0) revert ZeroAmount();
        (total, halves) = incomeSplit($, account);
        if (amount > total) revert IncomeExceeded(amount, total);
        StakingStore.Account storage a = $.accounts[account];
        uint256 claimed = uint256(a.claimed) + amount;
        a.claimed = SafeCast.toUint128(claimed);
        a.claimedHalves += SafeCast.toUint128(amount < halves ? amount : halves);
        emit IncomeConsumed(account, amount, claimed);
    }

    /// @dev The accrual so far of the open AIRDROP stakes of `account` that are on hold: not part of `income`.
    function heldIncome(StakingStore.StakingStorage storage $, address account) external view returns (uint256 held) {
        return _openIncome($, account).held;
    }

    /// @dev Releases the hold of every open AIRDROP stake of `account` (the ones with an id up to the newest stake id;
    ///      stakes opened later are held again). Returns how many were held and their accrual so far, which is
    ///      claimable income from now on; nothing changes when none was held.
    function release(
        StakingStore.StakingStorage storage $,
        address account
    ) public returns (uint256 count, uint256 released) {
        OpenIncome memory o = _openIncome($, account);
        (released, count) = (o.held, o.heldCount);
        if (count != 0) $.airdropReleasedUpTo[account] = $.nextStakeId;
    }

    /// @dev Same signature as `Staking.AirdropReleased` (an event of the library is emitted from Staking's address).
    event AirdropReleased(
        address indexed account,
        uint256 releasedUpTo,
        uint256 stakes,
        uint256 income,
        address indexed by
    );

    /// @dev `release` for each of `accounts` (1..RELEASE_BATCH_MAX of them), one `AirdropReleased` per
    ///      account that had something on hold and no revert for the others. Returns how many had.
    function releaseBatch(
        StakingStore.StakingStorage storage $,
        address[] calldata accounts,
        address by
    ) external returns (uint256 released) {
        if (accounts.length == 0 || accounts.length > RELEASE_BATCH_MAX) {
            revert IStakingOwn.InvalidBatchSize(accounts.length);
        }
        for (uint256 i = 0; i < accounts.length; ++i) {
            (uint256 count, uint256 accrued) = release($, accounts[i]);
            if (count == 0) continue;
            ++released;
            emit AirdropReleased(accounts[i], $.nextStakeId, count, accrued, by);
        }
    }

    /// @dev The account's largest open own-funded stake, by principal in VEX, among its USER and AIRDROP stakes (a
    ///      JUMP stake never counts); the lowest id on a tie. Read from the record, or from the open list (at most 50
    ///      stakes) for an account that has no record. Zeros without one.
    function largestOpen(
        StakingStore.StakingStorage storage $,
        address account
    ) external view returns (uint256 stakeId, uint256 principal, uint256 entryUsdt) {
        StakingStore.Largest memory rec = $.largest[account];
        stakeId = rec.stakeId;
        principal = rec.principal;
        if (stakeId == 0) (stakeId, principal) = _scanLargest($, account);
        if (stakeId != 0) entryUsdt = $.stakes[stakeId].entryUsdt;
    }

    /// @dev Staking calls it after it wrote the new stake `stakeId` and added it to its owner's open list: a USER stake
    ///      of a jump-eligible pool enters the P1-P5 series; a USER or AIRDROP stake moves the largest-stake record to
    ///      it when it is larger (or sets the record from the list when there was none).
    function recordOpen(StakingStore.StakingStorage storage $, uint256 stakeId, bool jumpEligible) external {
        StakingStore.Stake storage s = $.stakes[stakeId];
        address owner = s.owner;
        uint8 source = s.source;
        if (source == SOURCE_JUMP) return;
        uint256 principal = s.principal;
        if (source == SOURCE_USER && jumpEligible) {
            Checkpoints.Trace208 storage t = $.p15[owner];
            // at most 50 open stakes, so no overflow; `push` returns the previous and the new value
            // slither-disable-next-line unused-return
            t.push(uint48(block.timestamp), t.latest() + 1);
        }
        StakingStore.Largest storage rec = $.largest[owner];
        if (rec.stakeId == 0) {
            (uint256 id, uint256 largest) = _scanLargest($, owner);
            // the id and the principal come from stakes, bounded by uint64 and uint96 there
            rec.stakeId = uint64(id);
            rec.principal = uint96(largest);
        } else if (principal > rec.principal) {
            rec.stakeId = uint64(stakeId);
            rec.principal = uint96(principal);
        }
    }

    /// @dev For each of `accounts` (1..RELEASE_BATCH_MAX) records the largest open own-funded stake read from the
    ///      open list and pushes its principal to Network as the cap base (Network emits `CapBaseSet` only when it
    ///      changes). Idempotent and permissionless: it writes what the next open or close would write anyway.
    function syncCapBase(StakingStore.StakingStorage storage $, address[] calldata accounts) external {
        if (accounts.length == 0 || accounts.length > RELEASE_BATCH_MAX) {
            revert IStakingOwn.InvalidBatchSize(accounts.length);
        }
        INetwork net = INetwork($.network);
        for (uint256 i = 0; i < accounts.length; ++i) {
            (uint256 id, uint256 largest) = _scanLargest($, accounts[i]);
            StakingStore.Largest storage rec = $.largest[accounts[i]];
            rec.stakeId = uint64(id);
            rec.principal = uint96(largest);
            net.setCapBase(accounts[i], largest);
        }
    }

    /// @dev Takes the OPEN stake `stakeId` out of its owner's open list and checkpoints, settles `accrued` into the
    ///      owner's income and records the close (the caller sets the final state). `counted` is true for a USER or
    ///      AIRDROP stake, and then `base` is the owner's new cap base: the largest of the stakes still open.
    function closeOpen(
        StakingStore.StakingStorage storage $,
        uint256 stakeId,
        uint256 accrued
    ) external returns (bool counted, uint256 base) {
        StakingStore.Stake storage s = $.stakes[stakeId];
        address owner = s.owner;
        uint256[] storage list = $.openIds[owner];
        uint256 last = list.length - 1;
        uint256 index = s.openIndex;
        if (index != last) {
            uint256 moved = list[last];
            list[index] = moved;
            // the open list holds at most 50 entries
            $.stakes[moved].openIndex = uint8(index);
        }
        list.pop();

        StakingStore.Account storage a = $.accounts[owner];
        a.settled += SafeCast.toUint128(accrued);
        if ($.pools[s.poolId].halves) a.settledHalves += SafeCast.toUint128(accrued);
        s.finalAccrued = SafeCast.toUint96(accrued);
        s.closedAt = uint40(block.timestamp);
        uint8 source = s.source;
        if (source == SOURCE_USER && $.versions[s.poolId][s.version].jumpEligible) {
            Checkpoints.Trace208 storage t = $.p15[owner];
            // at most 50 open stakes, so no underflow; `push` returns the previous and the new value
            // slither-disable-next-line unused-return
            t.push(uint48(block.timestamp), t.latest() - 1);
        }
        counted = source != SOURCE_JUMP;
        if (counted) base = noteClosed($, owner, stakeId);
    }

    /// @dev Called after stake `stakeId` (USER or AIRDROP) left the open list: when it was the recorded largest (or
    ///      nothing was recorded) the next largest is found in the list. Returns the cap base.
    function noteClosed(
        StakingStore.StakingStorage storage $,
        address account,
        uint256 stakeId
    ) public returns (uint256 base) {
        StakingStore.Largest storage rec = $.largest[account];
        if (rec.stakeId != stakeId && rec.stakeId != 0) return rec.principal;
        (uint256 id, uint256 largest) = _scanLargest($, account);
        rec.stakeId = uint64(id);
        rec.principal = uint96(largest);
        return largest;
    }

    /// @dev The largest USER / AIRDROP stake in the account's open list (zeros when there is none); the lowest id on a
    ///      tie, so the answer does not depend on the order of the list. The principal is read first: the source slot
    ///      only for a stake that would beat the best so far (a stake is never empty, so the first one always does).
    function _scanLargest(
        StakingStore.StakingStorage storage $,
        address account
    ) private view returns (uint256 bestId, uint256 best) {
        uint256[] storage ids = $.openIds[account];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = ids[i];
            StakingStore.Stake storage s = $.stakes[id];
            uint256 principal = s.principal;
            if (principal < best || (principal == best && id > bestId)) continue;
            if (s.source == SOURCE_JUMP) continue;
            best = principal;
            bestId = id;
        }
    }

    /// @dev True when the account has an open own stake of a jump-eligible pool (P1-P5) that is a USER stake (the
    ///      checkpoint series) or an AIRDROP stake: what License Lite needs. VEX Jump does
    ///      not use it (`openP15At` counts USER stakes only).
    function hasOpenOwnP15(StakingStore.StakingStorage storage $, address account) external view returns (bool) {
        if ($.p15[account].latest() != 0) return true;
        uint256[] storage ids = $.openIds[account];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; ++i) {
            StakingStore.Stake storage s = $.stakes[ids[i]];
            if (s.source == SOURCE_AIRDROP && $.versions[s.poolId][s.version].jumpEligible) return true;
        }
        return false;
    }

    /// @dev The accrual now of the open stakes of `account`: `free` (not on hold), `held` (on hold, with the number of
    ///      those stakes) and `halves`, the part of `free` that comes from two-halves pools.
    struct OpenIncome {
        uint256 free;
        uint256 held;
        uint256 heldCount;
        uint256 halves;
    }

    function _openIncome(
        StakingStore.StakingStorage storage $,
        address account
    ) private view returns (OpenIncome memory o) {
        uint256[] storage ids = $.openIds[account];
        uint256 n = ids.length;
        if (n == 0) return o;
        uint256[] memory fz = _frozenDates($, account);
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = ids[i];
            StakingStore.Stake storage s = $.stakes[id];
            uint256 accrued = _accruedAt($, s, $.versions[s.poolId][s.version], fz, block.timestamp);
            if (isHeld($, id, s)) {
                o.held += accrued;
                ++o.heldCount;
            } else {
                o.free += accrued;
                if ($.pools[s.poolId].halves) o.halves += accrued;
            }
        }
    }

    /// @dev The next reward moment after now (0 when the schedule is complete).
    function _nextMoment(
        StakingStore.StakingStorage storage $,
        StakingStore.Stake storage s,
        IStaking.PoolParams storage v
    ) private view returns (uint256) {
        if ($.pools[s.poolId].halves) {
            uint256 date = uint256(s.openedAt) / 1 days;
            uint256 first = (date + halfDay(v)) * 1 days;
            if (block.timestamp < first) return first;
            uint256 second = (date + v.periodDays) * 1 days;
            return block.timestamp < second ? second : 0;
        }
        uint256 base = _base(s.openedAt);
        uint256 due = _due(base, block.timestamp, v.periodDays);
        if (v.payoutMode == PAYOUT_DAILY) return due < v.periodDays ? base + (due + 1) * 1 days : 0;
        for (uint256 i = 0; i < 3; ++i) {
            if (v.releaseDays[i] > due) return base + uint256(v.releaseDays[i]) * 1 days;
        }
        return 0;
    }

    /// @dev Vested so far: floor(total / P) per whole UTC day since the close day, everything from day P on (the
    ///      remainder lands on the last day). Only VEST stakes closed by maturity vest.
    function vested(StakingStore.StakingStorage storage $, uint256 stakeId) external view returns (uint256) {
        StakingStore.Stake storage s = $.stakes[stakeId];
        return _vested(s, $.versions[s.poolId][s.version]);
    }

    function _vested(StakingStore.Stake storage s, IStaking.PoolParams storage v) private view returns (uint256) {
        uint8 state = s.state;
        if (v.returnMode != RETURN_VEST || (state != STATE_VESTING && state != STATE_CLOSED)) return 0;
        uint256 total = vestTotal(s.principal);
        uint256 elapsed = block.timestamp / 1 days - uint256(s.closedAt) / 1 days;
        uint256 days_ = v.periodDays;
        if (elapsed >= days_) return total;
        // Intended: a fixed `floor(total / P)` per day; the remainder is released on the last day.
        // slither-disable-next-line divide-before-multiply
        return elapsed * (total / days_);
    }

    /// @dev Everything the UI shows about stake `stakeId` (empty for an unknown id).
    function stakeView(
        StakingStore.StakingStorage storage $,
        uint256 stakeId
    ) external view returns (IStaking.StakeView memory r) {
        StakingStore.Stake storage s = $.stakes[stakeId];
        if (s.state == STATE_NONE) return r;
        IStaking.PoolParams storage v = $.versions[s.poolId][s.version];
        r.owner = s.owner;
        r.poolId = s.poolId;
        r.version = s.version;
        r.source = s.source;
        r.state = s.state;
        r.openedAt = s.openedAt;
        r.principal = s.principal;
        r.entryUsdt = s.entryUsdt;
        r.maturesAt = maturesAt(s, v);
        r.closedAt = s.closedAt;
        r.vestClaimed = s.vestClaimed;
        if (s.source == SOURCE_USER) r.earlyCloseFrom = uint256(s.openedAt) + EARLY_CLOSE_DELAY;
        if (s.state == STATE_OPEN) {
            r.accrued = _accruedAt($, s, v, _frozenDates($, s.owner), block.timestamp);
            r.nextMomentAt = _nextMoment($, s, v);
        } else {
            r.accrued = s.finalAccrued;
            r.vested = _vested(s, v);
            r.claimable = r.vested - s.vestClaimed;
        }
    }

    /// @dev The early-close numbers for stake `stakeId` (see `IStaking.EarlyClosePreview`) plus the account's VEX
    ///      credit total to mark as deducted; `mark` is true when it is above its deducted mark.
    function earlyQuote(
        StakingStore.StakingStorage storage $,
        uint256 stakeId
    ) external view returns (IStaking.EarlyClosePreview memory p, uint256 vexCum, bool mark) {
        StakingStore.Stake storage s = $.stakes[stakeId];
        if (s.state != STATE_OPEN) {
            p.status = EARLY_NOT_OPEN;
            return (p, 0, false);
        }
        if (s.source != SOURCE_USER) {
            p.status = EARLY_NOT_USER;
            return (p, 0, false);
        }
        IStaking.PoolParams storage v = $.versions[s.poolId][s.version];
        p.principal = s.principal;
        p.burn = (p.principal * BURN_BPS) / BPS;
        uint256 fee = (p.principal * EARLY_FEE_BPS) / BPS;
        p.feeToVault = fee - p.burn;
        p.availableAt = uint256(s.openedAt) + EARLY_CLOSE_DELAY;
        p.maturesAt = maturesAt(s, v);
        p.accrued = _accruedAt($, s, v, _frozenDates($, s.owner), block.timestamp);
        (p.bonusVex, vexCum, mark) = _bonus($, s);
        p.deduction = p.accrued + p.bonusVex;

        if (fee + p.deduction < p.principal) p.refund = p.principal - fee - p.deduction;
        p.capRoom = _refundRoom($);
        // `refund == 0` compares a computed amount, not a balance an attacker can move.
        // slither-disable-start incorrect-equality
        if (block.timestamp < p.availableAt) {
            p.status = EARLY_TOO_SOON;
        } else if (block.timestamp >= p.maturesAt) {
            p.status = EARLY_MATURED;
        } else if (p.refund == 0) {
            p.status = EARLY_NO_REFUND;
        } else if (p.refund > p.capRoom) {
            p.status = EARLY_CAP;
        }
        // slither-disable-end incorrect-equality
    }

    // ------------------------------------------------------------------ internals

    /// @dev The owner's freezes as day ranges, four words per freeze interval: a pair [first, end) of UTC dates whose
    ///      06:00 moment lies in the interval (end = max for a freeze still in force), then the same for the 00:00
    ///      moments of the two-halves pools. One conversion per call; every stake then counts its frozen moments
    ///      against the pairs by comparison alone.
    function _frozenDates(
        StakingStore.StakingStorage storage $,
        address account
    ) private view returns (uint256[] memory r) {
        INetwork.FreezeInterval[] memory fz = INetwork($.network).freezeIntervals(account);
        r = new uint256[](fz.length * 4);
        for (uint256 i = 0; i < fz.length; ++i) {
            uint256 from = fz[i].from;
            uint256 until = fz[i].until;
            // date d is frozen when from <= d * 1 days + 6 h < until (block times are far above 6 h)
            r[4 * i] = Math.ceilDiv(from - MOMENT_OFFSET, 1 days);
            r[4 * i + 1] = until == 0 ? type(uint256).max : Math.ceilDiv(until - MOMENT_OFFSET, 1 days);
            // ... and a 00:00 moment when from <= d * 1 days < until
            r[4 * i + 2] = Math.ceilDiv(from, 1 days);
            r[4 * i + 3] = until == 0 ? type(uint256).max : Math.ceilDiv(until, 1 days);
        }
    }

    /// @dev 06:00 UTC of the stake's opening day: reward moment k is `base + k * 1 days`.
    function _base(uint256 openedAt) private pure returns (uint256) {
        // Intended: the UTC midnight of the opening day (floor to a whole day), then 06:00.
        // slither-disable-next-line divide-before-multiply
        return (openedAt / 1 days) * 1 days + MOMENT_OFFSET;
    }

    /// @dev How many reward moments (k = 1..period) are due at `at`.
    function _due(uint256 base, uint256 at, uint256 period) private pure returns (uint256) {
        if (at < base + 1 days) return 0;
        uint256 k = (at - base) / 1 days;
        return k < period ? k : period;
    }

    /// @dev Daily pools: floor(principal * dailyBps / 10 000) per paid moment, the running total trimmed to the cap.
    ///      Three-part pools: floor(principal * min(dailyBps * P, maxProfitBps) / 10 000) in three parts on the release
    ///      days. A moment inside a freeze interval pays 0 and does not move anything else (frozen days are forfeited).
    function _accruedAt(
        StakingStore.StakingStorage storage $,
        StakingStore.Stake storage s,
        IStaking.PoolParams storage v,
        uint256[] memory fz,
        uint256 at
    ) private view returns (uint256 total) {
        if ($.pools[s.poolId].halves) return _halvesAccruedAt(s, v, fz, at);
        uint256 base = _base(s.openedAt);
        uint256 due = _due(base, at, v.periodDays);
        // A count of reward moments, not a balance.
        // slither-disable-next-line incorrect-equality
        if (due == 0) return 0;
        uint256 principal = s.principal;
        // the UTC date of reward moment 1 (moment k falls on date first - 1 + k)
        uint256 first = uint256(s.openedAt) / 1 days + 1;
        if (v.payoutMode == PAYOUT_DAILY) {
            // Intended: every paid moment pays the same floored daily amount.
            // slither-disable-next-line divide-before-multiply
            uint256 paid = (due - _frozenDays(fz, first, first + due - 1)) * ((principal * v.dailyBps) / BPS);
            uint256 cap = (principal * v.maxProfitBps) / BPS;
            return paid > cap ? cap : paid;
        }
        uint256 rate = Math.min(uint256(v.dailyBps) * v.periodDays, v.maxProfitBps);
        uint256 whole = (principal * rate) / BPS;
        // Intended: two equal floors of a third, the last part takes the rest.
        // slither-disable-next-line divide-before-multiply
        uint256 part = whole / 3;
        for (uint256 i = 0; i < 3; ++i) {
            uint256 day = v.releaseDays[i];
            if (day > due || _frozenDate(fz, 0, first - 1 + day)) continue;
            total += i == 2 ? whole - 2 * part : part;
        }
    }

    /// @dev Two-halves pools: the reward `floor(principal * min(dailyBps * P, maxProfitBps) / 10 000)` in two parts,
    ///      `floor(total / 2)` at 00:00 UTC of day(openedAt) + `halfDay` and the rest at 00:00 UTC of day(openedAt) +
    ///      P. Nothing accrues before the first moment. A moment inside a freeze interval pays 0.
    function _halvesAccruedAt(
        StakingStore.Stake storage s,
        IStaking.PoolParams storage v,
        uint256[] memory fz,
        uint256 at
    ) private view returns (uint256 total) {
        uint256 date = uint256(s.openedAt) / 1 days;
        uint256 firstDate = date + halfDay(v);
        uint256 lastDate = date + v.periodDays;
        uint256 rate = Math.min(uint256(v.dailyBps) * v.periodDays, v.maxProfitBps);
        uint256 whole = (s.principal * rate) / BPS;
        uint256 half = whole / 2;
        if (at >= firstDate * 1 days && !_frozenDate(fz, 2, firstDate)) total = half;
        if (at >= lastDate * 1 days && !_frozenDate(fz, 2, lastDate)) total += whole - half;
    }

    /// @dev How many UTC dates in [first, last] have a frozen 06:00 moment (see `_frozenDates`; the ranges never
    ///      overlap).
    function _frozenDays(uint256[] memory r, uint256 first, uint256 last) private pure returns (uint256 count) {
        for (uint256 i = 0; i < r.length; i += 4) {
            uint256 lo = r[i] > first ? r[i] : first;
            uint256 hi = r[i + 1] > last ? last + 1 : r[i + 1];
            if (hi > lo) count += hi - lo;
        }
    }

    /// @dev Whether the moment of UTC date `date` is frozen: `kind` 0 = the 06:00 moment, 2 = the 00:00 moment.
    function _frozenDate(uint256[] memory r, uint256 kind, uint256 date) private pure returns (bool) {
        for (uint256 i = kind; i < r.length; i += 4) {
            if (date >= r[i] && date < r[i + 1]) return true;
        }
        return false;
    }

    /// @dev The partner credits the stake would give back, in VEX: those above both its own opening mark and the
    ///      account's deducted mark. The legacy USDT credits (`usdtCum`, `usdtMark`) are neither converted nor
    ///      deducted. Also returns the account's VEX total and whether it is above the deducted
    ///      mark.
    function _bonus(
        StakingStore.StakingStorage storage $,
        StakingStore.Stake storage s
    ) private view returns (uint256 bonusVex, uint256 vexCum, bool mark) {
        uint256 vexDed;
        (vexCum, , vexDed, ) = INetwork($.network).bonusTotals(s.owner);
        uint256 vexFrom = Math.max(s.vexMark, vexDed);
        bonusVex = vexCum > vexFrom ? vexCum - vexFrom : 0;
        mark = vexCum > vexDed;
    }

    /// @dev VEX still refundable in the current UTC day: the cap converted at the current price minus the used part.
    function _refundRoom(StakingStore.StakingStorage storage $) private view returns (uint256) {
        uint256 capUsdt = $.refundCapUsdt;
        if (capUsdt == 0) return 0;
        uint256 capVex = IPriceFeed($.priceFeed).usdtToVex(capUsdt);
        // Day counter comparison, not a balance check.
        // slither-disable-next-line incorrect-equality
        uint256 used = $.refundDay == block.timestamp / 1 days ? $.refundUsed : 0;
        return capVex > used ? capVex - used : 0;
    }
}
