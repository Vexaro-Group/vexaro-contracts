// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IStaking} from "../interfaces/IStaking.sol";

// Values shared by `Staking` and the `StakingMath` library it delegates to (file level: a library cannot read the
// constants of a contract). `Staking` re-exports the ones the UI needs as public constants.
uint256 constant BPS = 10_000;
/// @dev 5 % of the principal is burned when a stake matures or closes early.
uint256 constant BURN_BPS = 500;
/// @dev Early-close fee in basis points of the principal (of which BURN_BPS is burned).
uint256 constant EARLY_FEE_BPS = 3000;
uint256 constant EARLY_CLOSE_DELAY = 48 hours;
/// @dev Offset of the reward moment inside a UTC day (06:00).
uint256 constant MOMENT_OFFSET = 6 hours;

uint8 constant PAYOUT_DAILY = 0;
uint8 constant PAYOUT_THREE_PARTS = 1;
uint8 constant RETURN_VEST = 0;
uint8 constant RETURN_FULL = 1;
uint8 constant NC_LEVELS = 0;
uint8 constant NC_L1_ONLY = 1;

/// @dev Accounts per `Staking.releaseAirdropHoldBatch`.
uint256 constant RELEASE_BATCH_MAX = 50;

uint8 constant SOURCE_USER = 0;
uint8 constant SOURCE_JUMP = 1;
uint8 constant SOURCE_AIRDROP = 2;

uint8 constant STATE_NONE = 0;
uint8 constant STATE_OPEN = 1;
uint8 constant STATE_VESTING = 2;
uint8 constant STATE_CLOSED = 3;
uint8 constant STATE_CLOSED_EARLY = 4;

uint8 constant EARLY_NOT_OPEN = 1;
uint8 constant EARLY_NOT_USER = 2;
uint8 constant EARLY_TOO_SOON = 3;
uint8 constant EARLY_MATURED = 4;
uint8 constant EARLY_NO_REFUND = 5;
uint8 constant EARLY_CAP = 6;

uint8 constant PARAMS_RANGE = 1;
uint8 constant PARAMS_RATES = 2;
uint8 constant PARAMS_PERIOD = 3;
uint8 constant PARAMS_MODE = 4;
uint8 constant PARAMS_RELEASE = 5;
uint8 constant PARAMS_NC = 6;

/// @dev The storage of `Staking`, kept apart so the library can use the same types.
abstract contract StakingStore {
    struct Pool {
        uint16 versionCount;
        bool launched;
        bool enabled;
        bool airdropAllowed;
        // appended, one-way: every stake of the pool follows the two-halves schedule (see `halfDay`)
        bool halves;
    }

    /// @dev Four slots. `principal`, `finalAccrued` and `vestClaimed` are VEX wei (the supply is 1e27 < 2^90).
    struct Stake {
        address owner;
        uint40 openedAt;
        uint8 poolId;
        uint16 version;
        uint8 source;
        uint8 state;
        uint8 openIndex;
        uint96 principal;
        uint128 entryUsdt;
        uint128 vexMark;
        // Deprecated: no longer written (0 for new stakes), read by nothing; kept for the layout.
        uint128 usdtMark;
        uint40 closedAt;
        uint96 finalAccrued;
        uint96 vestClaimed;
    }

    /// @dev `openPrincipal` and `openEntryUsdt` are deprecated: they are no longer written (they hold what was summed
    ///      before they were dropped) and nothing reads them. `settledHalves` (appended) is the part of `settled` that
    ///      came from stakes of two-halves pools and `claimedHalves` (appended) is how much of the claimed income was
    ///      spent on that kind of income.
    struct Account {
        uint128 openPrincipal;
        uint128 openEntryUsdt;
        uint128 settled;
        uint128 claimed;
        uint128 settledHalves;
        uint128 claimedHalves;
    }

    /// @dev The account's largest open own-funded stake (USER or AIRDROP, never JUMP) by principal, one slot.
    ///      `stakeId` 0 = not recorded: either the account has no such stake or it was last touched before the record
    ///      existed, and the views / hooks then look at the open list (at most 50 stakes).
    struct Largest {
        uint64 stakeId;
        uint96 principal;
    }

    /// @custom:storage-location erc7201:vexaro.storage.Staking
    struct StakingStorage {
        address vex;
        address network;
        address priceFeed;
        address rewardVault;
        uint8 poolCount;
        uint40 refundDay;
        uint256 nextStakeId;
        uint256 totalPrincipal;
        uint256 refundCapUsdt;
        uint256 refundUsed;
        mapping(uint256 poolId => Pool) pools;
        mapping(uint256 poolId => mapping(uint256 version => IStaking.PoolParams)) versions;
        mapping(uint256 stakeId => Stake) stakes;
        mapping(address account => Account) accounts;
        mapping(address account => uint256[]) openIds;
        mapping(address account => Checkpoints.Trace208) p15;
        // appended after the initial layout; do not reorder
        address jump;
        // the AIRDROP stakes of the account with an id up to this one are released from the hold; 0 (the default) =
        // all held
        mapping(address account => uint256 stakeId) airdropReleasedUpTo;
        // the largest open USER / AIRDROP stake, the bonus cap base and the base of the withdrawal maximum; a
        // never-recorded account (the default) is read from its open list
        mapping(address account => Largest) largest;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.Staking")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STAKING_STORAGE_LOCATION =
        0xdc4b5e207eb9eb5b857f4e15d3824dfd743df9ab18a212df8b5f772aa81f0100;

    function _stakingStorage() internal pure returns (StakingStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := STAKING_STORAGE_LOCATION
        }
    }
}

/// @dev Maturity: 00:00 UTC of day(openedAt) + P (VEST pools) or + P + 1 (FULL pools).
function maturesAt(StakingStore.Stake storage s, IStaking.PoolParams storage v) view returns (uint256) {
    return (uint256(s.openedAt) / 1 days + v.periodDays + (v.returnMode == RETURN_FULL ? 1 : 0)) * 1 days;
}

/// @dev Two-halves pools: the first half of the reward is released at 00:00 UTC of day(openedAt) + `halfDay`, the
///      second at 00:00 UTC of day(openedAt) + P. `halfDay` is half of the period, rounded up. The maturity is not
///      moved (a FULL pool matures a day later, see `maturesAt`).
function halfDay(IStaking.PoolParams storage v) view returns (uint256) {
    return (uint256(v.periodDays) + 1) / 2;
}

/// @dev An OPEN AIRDROP stake is on hold (its income and its principal can not be claimed: it can
///      not be closed, so it never reaches VESTING) until an admin released its owner's stakes up to its id
///      (`releaseAirdropHold`). Stakes opened after a release have a higher id, so they are held again; a stake that
///      exists when the hold is introduced is held because the account's mark is 0. A stake that was closed before
///      the hold existed is not held: its income is settled and its vesting runs as before.
function isHeld(
    StakingStore.StakingStorage storage $,
    uint256 stakeId,
    StakingStore.Stake storage s
) view returns (bool) {
    return s.source == SOURCE_AIRDROP && s.state == STATE_OPEN && stakeId > $.airdropReleasedUpTo[s.owner];
}

/// @dev What a matured close leaves for the owner after the 5 % burn.
function vestTotal(uint256 principal) pure returns (uint256) {
    return principal - (principal * BURN_BPS) / BPS;
}
