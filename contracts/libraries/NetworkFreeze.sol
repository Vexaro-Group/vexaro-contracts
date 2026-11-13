// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Managed} from "../abstracts/Managed.sol";
import {INetwork} from "../interfaces/INetwork.sol";
import {Network} from "../Network.sol";

// Values shared by `Network` and the `NetworkFreeze` library it delegates to (file level: a library cannot read the
// constants of a contract). `Network` re-exports them as public constants.
/// @dev Freeze intervals kept per account.
uint256 constant FREEZE_LIMIT = 32;
/// @dev Most accounts one `unfreezeMany` call takes.
uint256 constant FREEZE_BATCH = 100;
uint8 constant TIER_LITE = 0;
/// @dev Cap limit as a percentage of the base, in basis points.
uint256 constant LIMIT_BPS = 20_000;
uint256 constant LIMIT_BPS_LITE = 10_000;
uint256 constant BASIS_POINTS = 10_000;

/// @title NetworkFreeze
/// @notice The freeze registry of `Network`: opening, lifting and voiding freeze intervals, the GUARDIAN daily budget
///         and the credits that a void gives back. It lives in a library of its own because `Network` would not fit
///         into one contract (24 KB); the external functions run by DELEGATECALL on `Network`'s storage (the namespace
///         pointer is passed in), emit the events and revert with the errors declared in `Network`, and hold no state.
///         Access control stays in `Network`. Deploy it once and link it into the `Network` implementation.
library NetworkFreeze {
    /// @dev Opens a new interval for `account`; `byOperator`: the OPERATOR's own freezes are not limited by the
    ///      GUARDIAN budget.
    function freeze(Network.NetworkStorage storage $, address account, uint8 reason, bool byOperator) external {
        Network.Member storage m = $.members[account];
        if (m.frozen) revert Managed.NoChange(reason);
        if (!byOperator) _useGuardianBudget($);
        INetwork.FreezeInterval[] storage list = $.freezes[account];
        if (list.length >= FREEZE_LIMIT) {
            _compact(list);
            if (list.length >= FREEZE_LIMIT) revert Network.FreezeLimit(account);
        }
        list.push(INetwork.FreezeInterval({from: uint40(block.timestamp), until: 0, reason: reason}));
        m.frozen = true;
        emit Network.Frozen(account, reason, msg.sender);
    }

    /// @dev Closes the open interval of `account` now; reverts `NoChange(0)` when it is not frozen.
    function unfreeze(Network.NetworkStorage storage $, address account) external {
        if (!$.members[account].frozen) revert Managed.NoChange(0);
        _lift($, account, false);
    }

    /// @dev Lifts every listed account that is frozen (the others are skipped); `voidOpenInterval` voids the open
    ///      interval instead of closing it.
    function unfreezeMany(
        Network.NetworkStorage storage $,
        address[] calldata accounts,
        bool voidOpenInterval
    ) external {
        if (accounts.length == 0 || accounts.length > FREEZE_BATCH) revert Network.InvalidBatch(accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            if ($.members[accounts[i]].frozen) _lift($, accounts[i], voidOpenInterval);
        }
    }

    /// @dev Makes interval `index` of `account` empty; voiding the open one also unfreezes the account.
    function voidFreeze(Network.NetworkStorage storage $, address account, uint256 index) external {
        INetwork.FreezeInterval[] storage list = $.freezes[account];
        if (index >= list.length) revert Network.UnknownFreeze(account, index);
        INetwork.FreezeInterval storage f = list[index];
        if (_isEmpty(f)) revert Network.FreezeAlreadyVoid(account, index);
        if (f.until == 0) {
            _lift($, account, true);
        } else {
            f.until = f.from;
            emit Network.FreezeVoided(account, index, false, msg.sender);
        }
    }

    /// @dev Counts one GUARDIAN freeze against today's budget.
    function _useGuardianBudget(Network.NetworkStorage storage $) private {
        uint32 today = uint32(block.timestamp / 1 days);
        uint32 used = $.guardianFreezeDay == today ? $.guardianFreezeUsed : 0;
        uint32 budget = $.guardianFreezeBudget;
        if (used >= budget) revert Network.FreezeBudgetExceeded(used, budget);
        $.guardianFreezeDay = today;
        $.guardianFreezeUsed = used + 1;
    }

    /// @dev Ends the open interval of a frozen account: closed now (the partner credits skipped during it stay lost),
    ///      or made empty (they are given back, see `_restoreMissed`).
    function _lift(Network.NetworkStorage storage $, address account, bool voidIt) private {
        INetwork.FreezeInterval[] storage list = $.freezes[account];
        uint256 last = list.length - 1;
        if (voidIt) {
            list[last].until = list[last].from;
            emit Network.FreezeVoided(account, last, true, msg.sender);
        } else {
            list[last].until = uint40(block.timestamp);
        }
        $.members[account].frozen = false;
        emit Network.Unfrozen(account, msg.sender);
        if (voidIt) _restoreMissed($, account);
        else delete $.missedBonus[account];
    }

    /// @dev Credits what the account's frozen interval skipped, program by program (NC, LR, BF), within the cap room it
    ///      has now: the license must be running and the base set, the credit of a program is the smaller of its sum
    ///      and the room left, and what does not fit is dropped. The record is cleared.
    function _restoreMissed(Network.NetworkStorage storage $, address account) private {
        uint128[3] memory missed = $.missedBonus[account];
        if (missed[0] == 0 && missed[1] == 0 && missed[2] == 0) return;
        delete $.missedBonus[account];
        Network.License memory lic = $.licenses[account];
        Network.Cap memory c = $.caps[account];
        uint256 limit = lic.expiresAt > block.timestamp
            ? (uint256(c.base) * (lic.tier == TIER_LITE ? LIMIT_BPS_LITE : LIMIT_BPS)) / BASIS_POINTS
            : 0;
        uint256 used = c.used;
        uint256 total;
        for (uint8 p; p < 3; ++p) {
            uint256 wanted = missed[p];
            if (wanted == 0) continue;
            uint256 room = limit > used ? limit - used : 0;
            uint256 credit = wanted < room ? wanted : room;
            used += credit;
            total += credit;
            emit Network.MissedBonusRestored(account, p, wanted, credit);
        }
        if (total == 0) return;
        $.bonuses[account].vexCum += SafeCast.toUint128(total);
        $.caps[account].used = SafeCast.toUint128(used);
        if (used >= limit && !lic.capReached) {
            $.licenses[account].capReached = true;
            emit Network.CapReached(account, lic.activationSeq);
        }
    }

    /// @dev An interval that freezes nothing: closed with `until == from` (voided, or lifted in the block it began).
    function _isEmpty(INetwork.FreezeInterval storage f) private view returns (bool) {
        return f.until != 0 && f.until == f.from;
    }

    /// @dev Drops the empty intervals, keeping the order of the others (StakingMath walks them as ranges).
    function _compact(INetwork.FreezeInterval[] storage list) private {
        uint256 n = list.length;
        uint256 kept;
        for (uint256 i; i < n; ++i) {
            if (_isEmpty(list[i])) continue;
            if (kept != i) list[kept] = list[i];
            ++kept;
        }
        for (uint256 i = n; i > kept; --i) list.pop();
    }
}
