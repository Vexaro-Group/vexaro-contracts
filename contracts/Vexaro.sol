// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title Vexaro (VEX)
/// @notice Fixed-supply ERC20 (1B minted once in the constructor) with Permit, Burnable and Votes. Every transfer
///         between two non-exempt accounts burns `feeBps` of the moved amount (capped by `MAX_FEE_BPS`); mint and
///         burn are never charged. Not upgradeable, no ERC1363, no mint after deploy, no blacklist, no pause.
///
///         Airdrop lock. VEX that a normal account receives from the airdrop wallet (`airdropWallet`, set by
///         DEFAULT_ADMIN) is airdrop-locked: `airdropLockedOf(account)` of its balance. The lock is enforced on the
///         VEXARO platform only. Wallet-to-wallet transfers are free and the lock travels with the tokens: a move
///         spends the sender's free balance first, and only the part above it carries the lock to the receiver
///         (the fee burn takes the same share out of the moved lock, so `lock <= balance` holds on both sides).
///         A burn by the holder spends free VEX first, then locked. Sending VEX back to the airdrop wallet reduces
///         the lock by the amount sent. A send to an exempt account (DEX pair, router, platform contract) leaves the
///         lock behind, because exempt accounts never hold one, so locked VEX can be swapped on an external DEX.
///         A send to a platform-restricted account (`isPlatformRestricted`, set by DEFAULT_ADMIN: Staking,
///         TokenSale, Rewards, Treasury, Jump, ...) must stay within the sender's free balance and reverts
///         `AirdropLocked` otherwise. `spendAirdrop` (AIRDROP_SPENDER_ROLE, the Staking contract) is the only way
///         locked VEX enters the platform. The airdrop wallet itself is unrestricted. There is no blacklist and no
///         pause. Voting power follows balances as for any ERC20Votes token: locked VEX votes.
contract Vexaro is ERC20, ERC20Burnable, ERC20Permit, ERC20Votes, AccessControl {
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant EXEMPT_MANAGER_ROLE = keccak256("EXEMPT_MANAGER_ROLE");

    uint16 public constant MAX_FEE_BPS = 100;
    uint16 private constant BPS_DENOMINATOR = 10_000;

    bytes32 public constant AIRDROP_SPENDER_ROLE = keccak256("AIRDROP_SPENDER_ROLE");

    uint16 public feeBps;
    mapping(address account => bool exempt) public isExempt;

    /// @notice The only address whose outgoing transfers create airdrop locks (zero until DEFAULT_ADMIN sets it).
    address public airdropWallet;
    /// @notice Part of the account's balance that is airdrop-locked (never above the balance).
    mapping(address account => uint256 locked) public airdropLockedOf;

    /// @notice Platform contracts refuse locked VEX: a transfer to one of them must stay within the free balance.
    mapping(address account => bool restricted) public isPlatformRestricted;

    event FeeChanged(uint16 oldFeeBps, uint16 newFeeBps);
    event ExemptionSet(address indexed account, bool exempt);
    event AirdropWalletChanged(address indexed oldWallet, address indexed newWallet);
    /// @param locked The account's lock after the airdrop.
    event AirdropLockAdded(address indexed account, uint256 amount, uint256 locked);
    /// @param locked The account's lock after the stake.
    event AirdropLockSpent(address indexed account, address indexed spender, uint256 amount, uint256 locked);
    /// @param locked The account's lock after the return.
    event AirdropLockReturned(address indexed account, uint256 amount, uint256 locked);

    event PlatformRestrictedSet(address indexed account, bool restricted);
    /// @param amount Lock taken off `from` (the part of the move above its free balance).
    /// @param moved Part of it that arrived at `to` (0 for a burn, an exempt receiver, or after the fee share).
    /// @param fromLocked The sender's lock after the move.
    /// @param toLocked The receiver's lock after the move.
    event AirdropLockMoved(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 moved,
        uint256 fromLocked,
        uint256 toLocked
    );

    error FeeTooHigh(uint16 feeBps, uint16 maxFeeBps);
    error ZeroAddress();
    error ZeroAmount();
    /// @dev `value` is above the account's free balance (balance minus the airdrop lock).
    error AirdropLocked(address account, uint256 free, uint256 value);
    /// @dev `amount` is above the account's airdrop lock.
    error ExceedsAirdropLock(address account, uint256 locked, uint256 amount);
    /// @dev The account still holds a lock, so it can not become the airdrop wallet (which is unrestricted).
    error AccountHasLock(address account);

    /// @param recipient receives the whole supply and is exempt from the fee
    /// @param admin DEFAULT_ADMIN_ROLE holder; also gets both manager roles
    /// @param initialFeeBps starting fee, at most `MAX_FEE_BPS`
    constructor(address recipient, address admin, uint16 initialFeeBps) ERC20("Vexaro", "VEX") ERC20Permit("Vexaro") {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_MANAGER_ROLE, admin);
        _grantRole(EXEMPT_MANAGER_ROLE, admin);

        _setFee(initialFeeBps);
        _setExempt(recipient, true);
        _mint(recipient, 1_000_000_000 * 10 ** decimals());
    }

    function setFee(uint16 newFeeBps) external onlyRole(FEE_MANAGER_ROLE) {
        _setFee(newFeeBps);
    }

    function setExempt(address account, bool exempt) external onlyRole(EXEMPT_MANAGER_ROLE) {
        _setExempt(account, exempt);
    }

    /// @notice Marks (or unmarks) a platform contract as refusing locked VEX (DEFAULT_ADMIN). Independent of the
    ///         fee exemption.
    function setPlatformRestricted(address account, bool restricted) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isPlatformRestricted[account] = restricted;
        emit PlatformRestrictedSet(account, restricted);
    }

    /// @notice Sets the airdrop wallet (DEFAULT_ADMIN). Locks already created stay with their holders; only the new
    ///         wallet creates new ones. The new wallet must hold no lock itself.
    function setAirdropWallet(address newWallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWallet == address(0)) revert ZeroAddress();
        if (airdropLockedOf[newWallet] != 0) revert AccountHasLock(newWallet);
        emit AirdropWalletChanged(airdropWallet, newWallet);
        airdropWallet = newWallet;
    }

    /// @notice Moves `amount` of the account's airdrop-locked VEX to the caller (AIRDROP_SPENDER_ROLE, the Staking
    ///         contract) and releases that part of the lock. Reverts above the lock.
    function spendAirdrop(address account, uint256 amount) external onlyRole(AIRDROP_SPENDER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        uint256 locked = airdropLockedOf[account];
        if (amount > locked) revert ExceedsAirdropLock(account, locked, amount);
        unchecked {
            locked -= amount;
        }
        airdropLockedOf[account] = locked;
        emit AirdropLockSpent(account, msg.sender, amount, locked);
        // The released part is free now, so the move passes the lock check of `_update`.
        _transfer(account, msg.sender, amount);
    }

    /// @notice Balance minus the airdrop lock: what the account can move freely.
    function freeBalanceOf(address account) public view returns (uint256) {
        return balanceOf(account) - airdropLockedOf[account];
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function _setFee(uint16 newFeeBps) private {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        emit FeeChanged(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function _setExempt(address account, bool exempt) private {
        isExempt[account] = exempt;
        emit ExemptionSet(account, exempt);
    }

    /// @dev Transfers between two non-exempt accounts burn the fee from the moved amount; the receiver gets the rest.
    ///      A move out of the airdrop wallet locks what the receiver gets; a move out of a locked account carries
    ///      the lock or is refused by a platform contract (see `_airdropGate`).
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        // Zero means "no fee" (exempt side, mint, burn).
        // slither-disable-next-line uninitialized-local
        uint256 fee;
        if (from != address(0) && to != address(0) && !isExempt[from] && !isExempt[to]) {
            fee = (value * feeBps) / BPS_DENOMINATOR;
        }
        if (from != address(0)) _airdropGate(from, to, value, value - fee);
        if (fee == 0) {
            super._update(from, to, value);
            return;
        }
        super._update(from, to, value - fee);
        super._update(from, address(0), fee);
    }

    /// @dev The airdrop lock rules for a move of `value` out of `from` (not a mint); `received` is what `to` gets.
    function _airdropGate(address from, address to, uint256 value, uint256 received) private {
        address wallet = airdropWallet;
        if (from == wallet) {
            // The airdrop wallet is unrestricted; a normal receiver gets what it receives locked.
            if (received != 0 && to != address(0) && to != wallet && !isExempt[to]) {
                uint256 locked = airdropLockedOf[to] + received;
                airdropLockedOf[to] = locked;
                emit AirdropLockAdded(to, received, locked);
            }
            return;
        }
        uint256 lockedFrom = airdropLockedOf[from];
        // Free VEX is never blocked.
        if (lockedFrom == 0) return;
        // A lock exists only after the wallet was set, so `to == wallet` is never a burn here.
        if (to == wallet) {
            uint256 returned = value < lockedFrom ? value : lockedFrom;
            unchecked {
                lockedFrom -= returned;
            }
            airdropLockedOf[from] = lockedFrom;
            emit AirdropLockReturned(from, returned, lockedFrom);
            return;
        }
        uint256 free = balanceOf(from) - lockedFrom;
        if (value <= free) return;
        if (isPlatformRestricted[to]) revert AirdropLocked(from, free, value);
        // Free VEX moves first; only the part above it carries the lock.
        uint256 carried = value - free;
        lockedFrom -= carried;
        airdropLockedOf[from] = lockedFrom;
        uint256 moved = 0;
        uint256 toLocked = 0;
        // A burn or an exempt receiver (DEX pair, platform contract) keeps no lock: it is left behind.
        if (to != address(0) && !isExempt[to]) {
            // The fee burn takes its proportional share of the carried lock, so the receiver's lock never exceeds
            // what it gets.
            moved = (carried * received) / value;
            toLocked = airdropLockedOf[to] + moved;
            airdropLockedOf[to] = toLocked;
        }
        emit AirdropLockMoved(from, to, carried, moved, lockedFrom, toLocked);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
