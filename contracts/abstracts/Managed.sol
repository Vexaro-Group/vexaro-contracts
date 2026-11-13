// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    ReentrancyGuardTransientUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title Managed
/// @notice Shared base of the platform contracts: no backend key signs anything, the rules live in the contracts. It
///         holds the roles, three independent pause flags, a transient reentrancy guard and UUPS upgrades. All own
///         state lives in an ERC-7201 namespaced slot, so children can append storage freely.
///
///         Roles
///         - DEFAULT_ADMIN, UPGRADER: a 2-of-3 Safe (upgrades, wiring, rule parameters). There is no timelock: a
///           change takes effect when the Safe executes it. The deployer keeps DEFAULT_ADMIN as a backup until it
///           renounces the role.
///         - OPERATOR: the same Safe (daily limits, launches, funding); may pause and unpause ENTRIES and REWARDS.
///         - GUARDIAN: a backend key on a separate server with deny-only powers: it can pause ENTRIES and REWARDS,
///           never unpause them and never touch EXITS. OPERATOR (not DEFAULT_ADMIN) is its role admin, so the Safe
///           can revoke a leaked key and grant a new one with one OPERATOR transaction.
///         - EXIT_PAUSER: the Safe only; the only account that pauses or unpauses EXITS.
///
///         Pause flags (a bit set; `whenNotPaused(flag)` guards an entry point)
///         - ENTRIES: new stakes, buys, license purchases.
///         - REWARDS: reward claims.
///         - EXITS: matured closes and vested claims (kept open while the others are paused; emergency only).
abstract contract Managed is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant EXIT_PAUSER_ROLE = keccak256("EXIT_PAUSER_ROLE");

    uint8 public constant ENTRIES = 1;
    uint8 public constant REWARDS = 2;
    uint8 public constant EXITS = 4;
    /// @dev Every defined flag; a pause / unpause argument must be a non-empty subset of it.
    uint8 public constant ALL_FLAGS = 7;

    /// @custom:storage-location erc7201:vexaro.storage.Managed
    struct ManagedStorage {
        uint8 pausedFlags;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.Managed")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MANAGED_STORAGE_LOCATION =
        0x470c3be000c81231ae0f32abf7373c18de9f5cb52a491defb5cde4ce318af000;

    /// @notice `flags` is the set of flags that changed state (a flag already in the requested state is not repeated).
    event Paused(uint8 flags, address indexed by);
    event Unpaused(uint8 flags, address indexed by);

    error ZeroAddress();
    /// @dev `flags` is empty or holds a bit that is not a defined flag.
    error InvalidFlags(uint8 flags);
    /// @dev Every requested flag is already in the requested state.
    error NoChange(uint8 flags);
    /// @dev The entry point is guarded by a flag that is paused.
    error EnforcedPause(uint8 flag);

    /// @dev Reverts `EnforcedPause(flag)` while any bit of `flag` is paused.
    modifier whenNotPaused(uint8 flag) {
        _requireNotPaused(flag);
        _;
    }

    // solhint-disable-next-line func-name-mixedcase
    function __Managed_init(address admin) internal onlyInitializing {
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __ReentrancyGuardTransient_init();
        __UUPSUpgradeable_init();

        // The deployer-set admin starts with every governance role (the hand-over moves them to the Safe);
        // GUARDIAN is never granted here: it belongs to the separate backend key.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        _grantRole(EXIT_PAUSER_ROLE, admin);
        // A leaked guardian key must be rotatable by the Safe with a single OPERATOR transaction.
        _setRoleAdmin(GUARDIAN_ROLE, OPERATOR_ROLE);
    }

    /// @notice The paused flags as a bit set (0 = nothing paused).
    function pausedFlags() public view returns (uint8) {
        return _managedStorage().pausedFlags;
    }

    /// @notice True while any bit of `flag` is paused.
    function paused(uint8 flag) public view returns (bool) {
        return pausedFlags() & flag != 0;
    }

    /// @notice Pauses `flags`. ENTRIES / REWARDS: GUARDIAN or OPERATOR; EXITS: EXIT_PAUSER only. Mixed sets need
    ///         the authority for every part. Reverts `NoChange` when everything asked is already paused.
    function pause(uint8 flags) external {
        _checkFlags(flags);
        _checkPauseAuthority(flags, true);
        uint8 current = pausedFlags();
        uint8 changed = flags & ~current;
        if (changed == 0) revert NoChange(flags);
        _managedStorage().pausedFlags = current | changed;
        emit Paused(changed, msg.sender);
    }

    /// @notice Unpauses `flags`. ENTRIES / REWARDS: OPERATOR only (GUARDIAN cannot); EXITS: EXIT_PAUSER only.
    ///         Reverts `NoChange` when none of them is paused.
    function unpause(uint8 flags) external {
        _checkFlags(flags);
        _checkPauseAuthority(flags, false);
        uint8 current = pausedFlags();
        uint8 changed = flags & current;
        if (changed == 0) revert NoChange(flags);
        _managedStorage().pausedFlags = current & ~changed;
        emit Unpaused(changed, msg.sender);
    }

    function _requireNotPaused(uint8 flag) internal view {
        if (paused(flag)) revert EnforcedPause(flag);
    }

    function _checkFlags(uint8 flags) private pure {
        if (flags == 0 || flags & ~ALL_FLAGS != 0) revert InvalidFlags(flags);
    }

    function _checkPauseAuthority(uint8 flags, bool pausing) private view {
        if (flags & EXITS != 0) _checkRole(EXIT_PAUSER_ROLE);
        if (flags & (ENTRIES | REWARDS) != 0) {
            // GUARDIAN only denies: it may pause, never unpause.
            if (!(pausing && hasRole(GUARDIAN_ROLE, msg.sender))) _checkRole(OPERATOR_ROLE);
        }
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    function _managedStorage() private pure returns (ManagedStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := MANAGED_STORAGE_LOCATION
        }
    }
}
