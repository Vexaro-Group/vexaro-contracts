// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    ReentrancyGuardTransientUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {ITreasury} from "./interfaces/ITreasury.sol";

/// @title Treasury
/// @notice Collects the sales' payments (USDT or BNB, `token == address(0)`) by transfer-then-notify and splits each
///         one by percentage: every registered wallet's share is credited to its bucket and sent to the wallet in
///         the same transaction (together with anything older left in its bucket), the unshared remainder
///         (10_000 bps minus the sum of the rates) goes to the reserve that pays the sell-back and the current-price
///         sales of VEX (`payFromReserve`). License Rewards are paid in VEX by Network and never come out of the
///         reserve.
///         A wallet that cannot receive (a reverting or out-of-gas contract, a token that refuses the transfer)
///         never blocks the payment: its bucket is kept, `ReleaseSkipped` is emitted, and the wallet (or anyone, for
///         the registered wallets) pulls it later with `release` / `releaseAll`. BNB is pushed with at most
///         `WALLET_SEND_GAS`, so a receiver cannot burn the payer's gas.
///         Invariant per token, between calls: sum of buckets + reserve == accounted <= balance; the difference is
///         untracked excess (donations, forced BNB) that the admin can `rescue` or move to the reserve.
///         Shares are `amount * rate / 10_000` rounded down; the rounding dust stays in the reserve.
///         Buckets are keyed by account, so a wallet removed by `setWallets` keeps (and can `release`) what it was
///         already credited; `releaseAll` pays the currently registered wallets only.
///
///         Roles. DEFAULT_ADMIN and UPGRADER are held by a 2-of-3 Safe, and the deployer keeps DEFAULT_ADMIN as a
///         backup until it renounces it; there is no timelock. PAYER is held by the two sales, RESERVE_SPENDER by
///         TokenSale only.
contract Treasury is
    ITreasury,
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /// @dev Sales that may report a payment (TokenSale, LicenseSale).
    bytes32 public constant PAYER_ROLE = keccak256("PAYER_ROLE");
    /// @dev Contracts that may spend the reserve (TokenSale only).
    bytes32 public constant RESERVE_SPENDER_ROLE = keccak256("RESERVE_SPENDER_ROLE");

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_WALLETS = 16;
    /// @notice Gas given to the BNB send of a wallet's share in `notifyPayment` (a Safe proxy needs about 7 000).
    uint256 public constant WALLET_SEND_GAS = 50_000;

    struct Wallet {
        address account;
        uint16 rateBps;
    }

    /// @custom:storage-location erc7201:vexaro.storage.Treasury
    struct TreasuryStorage {
        Wallet[] wallets;
        mapping(address token => uint256 amount) reserve;
        mapping(address token => uint256 amount) bucketsTotal;
        mapping(address token => mapping(address account => uint256 amount)) bucket;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.Treasury")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant TREASURY_STORAGE_LOCATION =
        0x5f0628deb0e338b5d0a2a4c175cbd7ee435643cb86d02bcac5ea2c979441f300;

    event WalletsSet(address[] accounts, uint16[] ratesBps);
    event PaymentReceived(address indexed token, address indexed payer, uint256 amount, uint256 toReserve);
    event BucketCredited(address indexed token, address indexed account, uint256 amount);
    event Released(address indexed token, address indexed account, uint256 amount);
    event ReleaseSkipped(address indexed token, address indexed account, uint256 amount);
    event ReserveFunded(address indexed token, uint256 amount);
    event ReservePaid(address indexed token, address indexed spender, address indexed to, uint256 amount);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event ReserveWithdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error LengthMismatch();
    error TooManyWallets(uint256 count);
    error ZeroRate(address account);
    error DuplicateWallet(address account);
    error RatesTooHigh(uint256 totalBps);
    error PaymentNotReceived(address token, uint256 amount, uint256 available);
    error InsufficientReserve(address token, uint256 amount, uint256 reserve);
    error NothingToRelease(address token, address account);
    error TransferFailed(address token, address to, uint256 amount);
    error ExceedsExcess(address token, uint256 amount, uint256 excess);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __ReentrancyGuardTransient_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /// @dev BNB payments are forwarded here by the sales, then reported with `notifyPayment`.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}

    /// @notice Replaces the wallet set. `ratesBps` are shares of every payment in basis points; their sum may not
    ///         exceed 10_000, the rest goes to the reserve. An empty set sends everything to the reserve.
    function setWallets(address[] calldata accounts, uint16[] calldata ratesBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 count = accounts.length;
        if (count != ratesBps.length) revert LengthMismatch();
        if (count > MAX_WALLETS) revert TooManyWallets(count);

        TreasuryStorage storage $ = _treasuryStorage();
        delete $.wallets;

        // Starts at zero on purpose.
        // slither-disable-next-line uninitialized-local
        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            _checkWallet(accounts, ratesBps[i], i);
            total += ratesBps[i];
            $.wallets.push(Wallet(accounts[i], ratesBps[i]));
        }
        if (total > BPS_DENOMINATOR) revert RatesTooHigh(total);
        emit WalletsSet(accounts, ratesBps);
    }

    /// @notice Splits `amount` of `token` that the caller already transferred here and sends every registered wallet
    ///         its share, plus whatever an earlier failed send left in its bucket. Reverts unless the Treasury's
    ///         balance covers everything accounted so far plus `amount`. The books are settled before any send; a
    ///         send that fails keeps the bucket and emits `ReleaseSkipped`.
    function notifyPayment(address token, uint256 amount) external override onlyRole(PAYER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        TreasuryStorage storage $ = _treasuryStorage();

        uint256 available = _balance(token) - _accounted($, token);
        if (available < amount) revert PaymentNotReceived(token, amount, available);

        // Starts at zero on purpose.
        // slither-disable-next-line uninitialized-local
        uint256 credited;
        Wallet[] storage list = $.wallets;
        for (uint256 i = 0; i < list.length; ++i) {
            uint256 share = (amount * list[i].rateBps) / BPS_DENOMINATOR;
            if (share == 0) continue;
            $.bucket[token][list[i].account] += share;
            credited += share;
            emit BucketCredited(token, list[i].account, share);
        }
        $.bucketsTotal[token] += credited;
        uint256 toReserve = amount - credited;
        $.reserve[token] += toReserve;
        emit PaymentReceived(token, msg.sender, amount, toReserve);

        _payBuckets($, token, WALLET_SEND_GAS);
    }

    /// @notice Pays the caller's own bucket of `token` to the caller.
    function release(address token) external nonReentrant {
        TreasuryStorage storage $ = _treasuryStorage();
        uint256 amount = $.bucket[token][msg.sender];
        if (amount == 0) revert NothingToRelease(token, msg.sender);
        $.bucket[token][msg.sender] = 0;
        $.bucketsTotal[token] -= amount;
        if (!_trySend(token, msg.sender, amount)) revert TransferFailed(token, msg.sender, amount);
        emit Released(token, msg.sender, amount);
    }

    /// @notice Pays the bucket of every currently registered wallet. A wallet that cannot receive is skipped (its
    ///         bucket is kept and `ReleaseSkipped` is emitted) so one bad wallet cannot block the others.
    function releaseAll(address token) external nonReentrant {
        _payBuckets(_treasuryStorage(), token, 0);
    }

    /// @notice Pays `amount` of `token` from the reserve to `to`; never touches the buckets.
    function payFromReserve(
        address token,
        address to,
        uint256 amount
    ) external override onlyRole(RESERVE_SPENDER_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        TreasuryStorage storage $ = _treasuryStorage();
        uint256 reserve_ = $.reserve[token];
        if (reserve_ < amount) revert InsufficientReserve(token, amount, reserve_);
        $.reserve[token] = reserve_ - amount;
        if (!_trySend(token, to, amount)) revert TransferFailed(token, to, amount);
        emit ReservePaid(token, msg.sender, to, amount);
    }

    /// @notice Sends `amount` of the native BNB reserve to `to` (DEFAULT_ADMIN). The BNB part of
    ///         every payment that no wallet bucket takes lands in `reserve[address(0)]`, which no sell path spends;
    ///         without this exit it is stuck. The USDT reserve has no such exit: it only leaves through
    ///         RESERVE_SPENDER (the sell-back and the current-price sales of TokenSale).
    function withdrawBnbReserve(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        TreasuryStorage storage $ = _treasuryStorage();
        uint256 reserve_ = $.reserve[address(0)];
        if (reserve_ < amount) revert InsufficientReserve(address(0), amount, reserve_);
        $.reserve[address(0)] = reserve_ - amount;
        if (!_trySend(address(0), to, amount)) revert TransferFailed(address(0), to, amount);
        emit ReserveWithdrawn(address(0), to, amount);
    }

    /// @notice Moves untracked excess (tokens sent here without `notifyPayment`) into the reserve.
    function fundReserve(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        TreasuryStorage storage $ = _treasuryStorage();
        uint256 excess = _balance(token) - _accounted($, token);
        if (amount > excess) revert ExceedsExcess(token, amount, excess);
        $.reserve[token] += amount;
        emit ReserveFunded(token, amount);
    }

    /// @notice Sends untracked excess out; buckets and reserve are never touched.
    function rescue(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 excess = _balance(token) - _accounted(_treasuryStorage(), token);
        if (amount > excess) revert ExceedsExcess(token, amount, excess);
        if (!_trySend(token, to, amount)) revert TransferFailed(token, to, amount);
        emit Rescued(token, to, amount);
    }

    /// @notice The registered wallets and their rates.
    function wallets() external view returns (Wallet[] memory) {
        return _treasuryStorage().wallets;
    }

    function walletCount() external view returns (uint256) {
        return _treasuryStorage().wallets.length;
    }

    /// @notice Sum of the wallet rates in basis points.
    function totalRateBps() external view returns (uint256 total) {
        Wallet[] storage list = _treasuryStorage().wallets;
        for (uint256 i = 0; i < list.length; ++i) {
            total += list[i].rateBps;
        }
    }

    function bucketOf(address token, address account) external view returns (uint256) {
        return _treasuryStorage().bucket[token][account];
    }

    function bucketsTotal(address token) external view returns (uint256) {
        return _treasuryStorage().bucketsTotal[token];
    }

    function reserveOf(address token) external view returns (uint256) {
        return _treasuryStorage().reserve[token];
    }

    /// @notice Buckets + reserve of `token`: the part of the balance with an owner.
    function accounted(address token) external view returns (uint256) {
        return _accounted(_treasuryStorage(), token);
    }

    /// @notice Balance of `token` above what is accounted (not yet notified, or donated).
    function excessOf(address token) external view returns (uint256) {
        return _balance(token) - _accounted(_treasuryStorage(), token);
    }

    /// @dev Reverts for a zero address, a zero rate or an account that already appears before `index`.
    function _checkWallet(address[] calldata accounts, uint16 rateBps, uint256 index) private pure {
        address account = accounts[index];
        if (account == address(0)) revert ZeroAddress();
        if (rateBps == 0) revert ZeroRate(account);
        for (uint256 j = 0; j < index; ++j) {
            if (accounts[j] == account) revert DuplicateWallet(account);
        }
    }

    function _accounted(TreasuryStorage storage $, address token) private view returns (uint256) {
        return $.reserve[token] + $.bucketsTotal[token];
    }

    function _balance(address token) private view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    /// @dev Pays the bucket of every registered wallet; `bnbGas` caps the gas of a BNB send (0 = no cap). A wallet
    ///      that cannot receive keeps its bucket and gets `ReleaseSkipped`. Callers are `nonReentrant`.
    function _payBuckets(TreasuryStorage storage $, address token, uint256 bnbGas) private {
        Wallet[] storage list = $.wallets;
        for (uint256 i = 0; i < list.length; ++i) {
            address account = list[i].account;
            uint256 amount = $.bucket[token][account];
            if (amount == 0) continue;
            $.bucket[token][account] = 0;
            $.bucketsTotal[token] -= amount;
            if (_trySend(token, account, amount, bnbGas)) {
                emit Released(token, account, amount);
            } else {
                $.bucket[token][account] = amount;
                $.bucketsTotal[token] += amount;
                emit ReleaseSkipped(token, account, amount);
            }
        }
    }

    function _trySend(address token, address to, uint256 amount) private returns (bool) {
        return _trySend(token, to, amount, 0);
    }

    /// @dev `bnbGas` caps the gas of a BNB send (0 = all the gas left); it does not apply to tokens.
    function _trySend(address token, address to, uint256 amount, uint256 bnbGas) private returns (bool ok) {
        if (token == address(0)) {
            // `to` is the caller (`release`), a registered wallet (a failure skips the wallet, at most 16) or the
            // target of an authorised reserve payout / admin rescue; all entry points are `nonReentrant`.
            // slither-disable-next-line arbitrary-send-eth,calls-loop
            (ok, ) = bnbGas == 0 ? to.call{value: amount}("") : to.call{value: amount, gas: bnbGas}("");
        } else {
            ok = IERC20(token).trySafeTransfer(to, amount);
        }
    }

    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    function _treasuryStorage() private pure returns (TreasuryStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := TREASURY_STORAGE_LOCATION
        }
    }
}
