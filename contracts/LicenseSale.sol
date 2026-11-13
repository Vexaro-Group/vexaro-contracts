// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Managed} from "./abstracts/Managed.sol";
import {ILicense} from "./interfaces/ILicense.sol";
import {INetwork} from "./interfaces/INetwork.sol";
import {IStakingOwn} from "./interfaces/IStakingOwn.sol";
import {SalePayment} from "./libraries/SalePayment.sol";

/// @title LicenseSale
/// @notice The license shop: the price table, the Lite rules and the activation live in this contract, no backend
///         key signs a quote. It holds nothing; it mints and burns License units (ERC1155, id = tier * 1000 + days) and
///         tells Network who holds which license.
///
///         Prices. A USDT price and an on-sale flag per (tier 1..4, term 30 / 180 / 360 days), set by DEFAULT_ADMIN:
///         Basic 20 / 60 / 100, Prime 30 / 100 / 180, Elite 100 / 400 / 700, Ultra 200 / 900 / 1 500
///         USDT at the start. Lite (tier 0, 30 days) is never sold.
///
///         Buy. `buyLicense` sells any tier and term at any time, in any order, also after a license ended (no
///         ladder). Payment in USDT, or BNB (`payToken == address(0)`, sent as `msg.value` equal to `maxPay`)
///         at the Chainlink price of PriceFeed rounded up for the buyer, the excess of `maxPay` is refunded. The
///         payment moves once, buyer -> Treasury, and is then reported with `notifyPayment` (`SalePayment`; this
///         contract needs PAYER_ROLE on the Treasury). The first purchase registers the sponsor in Network (this
///         contract needs REGISTRAR_ROLE and LICENSE_HOOK_ROLE there); a frozen account is refused. The buyer gets one
///         License unit (MINTER_ROLE on License) and Network credits License Rewards to the upline on the license's
///         USDT list price, not on the BNB amount (`onLicenseBought`), so the credit never depends on the BNB
///         rounding; the credit is VEX on the upline's cashback balance. Only purchases pay License Rewards: Lite,
///         activations and the Safe's gifts (a plain `License.mint` by MINTER, nothing in this contract) never do.
///
///         Lite. `claimLite` mints a free Lite unit (id 30) to a registered, active account that has an open own P1-P5
///         stake now (`Staking.hasOpenOwnP15`: a USER or an AIRDROP stake), holds no unused Lite unit and
///         whose active license is not a Lite that is still running: after a Lite is activated the next one can be
///         claimed from the second it expires (a unit moved away counts as not held). A running paid license does not
///         block it. No License Rewards. Lite units are transferable until activated, so the limit is on the
///         activation: an account activates a Lite at most once every 30 days (`LiteActivationTooSoon`, measured from
///         the previous Lite activation of that account, also one made before the rule existed while it is still the
///         account's license). Only that 30-day re-activation of the same account refreshes the partner-bonus limit.
///
///         Activate. `activate(licenseId)` burns one unit of the caller (BURNER_ROLE on License, no approval) whether
///         it was bought, claimed, received or gifted, and tells Network (`onActivated`): the new license replaces
///         the active one (the remaining days are lost), it ends exactly `term` days later to the second
///         and the bonus-cap counter restarts (not for a Lite that would replace a running Lite, which is refused
///         here anyway). Network holds the mirror, `activeLicenseOf` forwards it.
///
///         Pauses. ENTRIES stops `buyLicense`, `claimLite` and `activate`; the admin setters stay open.
///
///         Recovery. The contract never keeps a balance (every payment goes straight to the Treasury and a BNB excess
///         is refunded in the same call), so whatever it holds was sent by mistake. `sweep` (DEFAULT_ADMIN) sends any
///         ERC-20 or BNB (`token == address(0)`) out.
///
///         Storage (ERC-7201 `vexaro.storage.LicenseSale`): six wiring addresses, then the price table
///         `prices[tier][term]` = usdt (uint128) | onSale (bool) in one slot, then (appended later) `liteActivatedAt`,
///         the time of each account's last Lite activation made through this contract.
contract LicenseSale is Managed {
    using SafeERC20 for IERC20;

    /// @notice The free Lite license (tier 0, 30 days).
    uint256 public constant LITE_ID = 30;
    /// @notice The highest sold tier (Ultra); tier 0 is Lite.
    uint8 public constant MAX_TIER = 4;
    /// @notice The least time between two Lite activations of one account.
    uint256 public constant LITE_ACTIVATION_PERIOD = 30 days;

    /// @notice `liteStatusOf` codes: 0 the account can claim, otherwise why not.
    uint8 public constant LITE_OK = 0;
    uint8 public constant LITE_NOT_ACTIVE = 1;
    uint8 public constant LITE_NO_STAKE = 2;
    uint8 public constant LITE_HELD = 3;
    uint8 public constant LITE_RUNNING = 4;

    /// @dev The list price of one (tier, term) and whether it can be bought now.
    struct Price {
        uint128 usdt;
        bool onSale;
    }

    /// @dev One row of the price table as the UI shows it.
    struct Offer {
        uint8 tier;
        uint16 term;
        uint256 licenseId;
        uint256 usdtPrice;
        bool onSale;
    }

    /// @custom:storage-location erc7201:vexaro.storage.LicenseSale
    struct LicenseSaleStorage {
        address license;
        address usdt;
        address treasury;
        address network;
        address priceFeed;
        address staking;
        mapping(uint8 tier => mapping(uint16 term => Price)) prices;
        // appended later; do not reorder
        mapping(address account => uint40) liteActivatedAt;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.LicenseSale")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LICENSE_SALE_STORAGE_LOCATION =
        0x174ebf9fcd9dc64c4c0d37116ceb537fe4a2eb9e28d96576b9270671a305f700;

    /// @param usdtValue The license's list price in USDT, which is what License Rewards are paid on (a BNB payment is
    ///        worth at least that much, rounded up for the buyer).
    event LicenseBought(
        address indexed account,
        uint256 indexed licenseId,
        uint8 tier,
        uint16 term,
        address payToken,
        uint256 payAmount,
        uint256 usdtValue
    );
    event LiteClaimed(address indexed account);
    /// @param expiresAt Activation time plus the term, to the second.
    event LicenseActivated(address indexed account, uint256 indexed licenseId, uint256 expiresAt);
    event PriceSet(uint8 indexed tier, uint16 indexed term, uint256 oldPrice, uint256 newPrice, bool onSale);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event NetworkChanged(address indexed oldNetwork, address indexed newNetwork);
    event PriceFeedChanged(address indexed oldPriceFeed, address indexed newPriceFeed);
    event StakingChanged(address indexed oldStaking, address indexed newStaking);
    event Swept(address indexed token, address indexed to, uint256 amount);

    /// @dev A zero price.
    error InvalidPrice();
    error ZeroAmount();
    error NotAContract(address account);
    /// @dev Lite (tier 0) is free and claimed with `claimLite`; it has no price.
    error LiteNotForSale();
    /// @dev No such (tier, term) in the price table.
    error InvalidLicense(uint8 tier, uint16 term);
    /// @dev The (tier, term) exists but the admin switched it off.
    error NotOnSale(uint8 tier, uint16 term);
    /// @dev The price in the payment token is above the limit the caller gave.
    error Slippage(uint256 actual, uint256 limit);
    /// @dev The account is not registered or is frozen.
    error NotActive(address account);
    /// @dev Lite needs an open own P1-P5 stake.
    error NoOwnStake(address account);
    /// @dev The account already holds an unused Lite unit.
    error LiteHeld(address account);
    /// @dev The account's active license is a Lite that has not ended yet; the next Lite can be claimed from the
    ///      second it expires.
    error LiteRunning(address account);
    /// @dev The account activated a Lite less than LITE_ACTIVATION_PERIOD ago; the next activation is possible from
    ///      `availableAt`.
    error LiteActivationTooSoon(address account, uint40 availableAt);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address license_,
        address usdt_,
        address treasury_,
        address network_,
        address priceFeed_,
        address staking_
    ) external initializer {
        __Managed_init(admin);
        _requireContract(license_);
        _requireContract(usdt_);
        LicenseSaleStorage storage $ = _licenseSaleStorage();
        $.license = license_;
        $.usdt = usdt_;
        _setTreasury($, treasury_);
        _setNetwork($, network_);
        _setPriceFeed($, priceFeed_);
        _setStaking($, staking_);

        // Default price table, USDT whole units: tier 1..4 x term 30 / 180 / 360.
        uint16[3] memory terms = [uint16(30), 180, 360];
        uint16[12] memory table = [uint16(20), 60, 100, 30, 100, 180, 100, 400, 700, 200, 900, 1500];
        for (uint8 tier = 1; tier <= MAX_TIER; ++tier) {
            for (uint256 t = 0; t < 3; ++t) {
                uint256 price = uint256(table[(tier - 1) * 3 + t]) * 1e18;
                $.prices[tier][terms[t]] = Price({usdt: uint128(price), onSale: true});
                emit PriceSet(tier, terms[t], 0, price, true);
            }
        }
    }

    // ------------------------------------------------------------------ admin

    /// @notice Sets the USDT price and the on-sale flag of one (tier, term) (DEFAULT_ADMIN).
    ///         Tier 1..4 and term 30 / 180 / 360 only; Lite has no price.
    function setPrice(uint8 tier, uint16 term, uint256 usdtPrice, bool onSale) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tier == 0) revert LiteNotForSale();
        LicenseSaleStorage storage $ = _licenseSaleStorage();
        // The call is the check: it reverts InvalidLicenseId for a combination License does not know (tier 5, 90 days).
        // slither-disable-next-line unused-return
        ILicense($.license).licenseId(tier, term);
        if (usdtPrice == 0) revert InvalidPrice();
        Price storage p = $.prices[tier][term];
        emit PriceSet(tier, term, p.usdt, usdtPrice, onSale);
        p.usdt = SafeCast.toUint128(usdtPrice);
        p.onSale = onSale;
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(_licenseSaleStorage(), newTreasury);
    }

    function setNetwork(address newNetwork) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setNetwork(_licenseSaleStorage(), newNetwork);
    }

    function setPriceFeed(address newPriceFeed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setPriceFeed(_licenseSaleStorage(), newPriceFeed);
    }

    function setStaking(address newStaking) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setStaking(_licenseSaleStorage(), newStaking);
    }

    /// @notice Sends out `amount` of `token` (an ERC-20, or BNB for the zero address) that was sent here by mistake
    ///         (DEFAULT_ADMIN). The contract holds no funds of its own.
    function sweep(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == address(0)) Address.sendValue(payable(to), amount);
        else IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    // ------------------------------------------------------------------ user entry points

    // Nothing is written after the payment moves (the mint and the hook are the last calls), and the transient guard
    // makes a re-entrant call revert.
    /// @notice Buys one license unit of (`tier`, `term`) with USDT, or BNB (`payToken == address(0)`, `msg.value` ==
    ///         `maxPay`, the part above the price is refunded). The first purchase of an account registers `sponsor`
    ///         in Network (later calls ignore it). Pays License Rewards to the upline.
    /// @param maxPay The most the caller accepts to pay in `payToken`; reverts `Slippage` above it.
    /// @return payAmount What was paid, in `payToken` wei.
    function buyLicense(
        uint8 tier,
        uint16 term,
        address payToken,
        uint256 maxPay,
        address sponsor
    ) external payable whenNotPaused(ENTRIES) nonReentrant returns (uint256 payAmount) {
        LicenseSaleStorage storage $ = _licenseSaleStorage();
        uint256 usdtPrice = _listPrice($, tier, term);
        _join($, sponsor);
        // The second answer (what the payment is worth) is the list price already in hand.
        // slither-disable-next-line unused-return
        (payAmount, ) = SalePayment.payFor($.priceFeed, $.usdt, payToken, usdtPrice);
        if (payAmount > maxPay) revert Slippage(payAmount, maxPay);

        SalePayment.collect($.treasury, payToken, payAmount, maxPay);
        uint256 id = uint256(tier) * 1000 + term;
        ILicense($.license).mint(msg.sender, id, 1, "");
        INetwork($.network).onLicenseBought(msg.sender, usdtPrice);
        emit LicenseBought(msg.sender, id, tier, term, payToken, payAmount, usdtPrice);
    }

    /// @notice Mints a free Lite unit to the caller: registered and not frozen, with an open own P1-P5 stake now and
    ///         no unused Lite unit. No License Rewards.
    function claimLite() external whenNotPaused(ENTRIES) nonReentrant {
        LicenseSaleStorage storage $ = _licenseSaleStorage();
        uint8 status = _liteStatus($, msg.sender);
        if (status == LITE_NOT_ACTIVE) revert NotActive(msg.sender);
        if (status == LITE_NO_STAKE) revert NoOwnStake(msg.sender);
        if (status == LITE_HELD) revert LiteHeld(msg.sender);
        if (status == LITE_RUNNING) revert LiteRunning(msg.sender);
        ILicense($.license).mint(msg.sender, LITE_ID, 1, "");
        emit LiteClaimed(msg.sender);
    }

    /// @notice Burns one `licenseId` unit of the caller and makes it the active license, replacing the previous one
    ///         (its remaining days are lost). It ends `term` days after this block's timestamp, to the second. A Lite
    ///         can be activated once every 30 days per account: reverts `LiteActivationTooSoon(account, availableAt)`.
    function activate(uint256 licenseId) external whenNotPaused(ENTRIES) nonReentrant {
        LicenseSaleStorage storage $ = _licenseSaleStorage();
        if (!INetwork($.network).isActive(msg.sender)) revert NotActive(msg.sender);
        // reverts InvalidLicenseId for an id License does not know
        (uint8 tier, uint16 term) = ILicense($.license).decodeId(licenseId);
        if (tier == 0) {
            uint40 availableAt = _liteAvailableAt($, msg.sender);
            if (block.timestamp < availableAt) revert LiteActivationTooSoon(msg.sender, availableAt);
            $.liteActivatedAt[msg.sender] = uint40(block.timestamp);
        }
        // the caller needs a unit: the burn reverts (ERC1155InsufficientBalance) otherwise
        ILicense($.license).burn(msg.sender, licenseId, 1);
        // a term is at most 360 days, so the sum fits uint40
        uint40 expiresAt = uint40(block.timestamp + uint256(term) * 1 days);
        INetwork($.network).onActivated(msg.sender, tier, expiresAt);
        emit LicenseActivated(msg.sender, licenseId, expiresAt);
    }

    // ------------------------------------------------------------------ views

    function license() external view returns (address) {
        return _licenseSaleStorage().license;
    }

    function usdt() external view returns (address) {
        return _licenseSaleStorage().usdt;
    }

    function treasury() external view returns (address) {
        return _licenseSaleStorage().treasury;
    }

    function network() external view returns (address) {
        return _licenseSaleStorage().network;
    }

    function priceFeed() external view returns (address) {
        return _licenseSaleStorage().priceFeed;
    }

    function staking() external view returns (address) {
        return _licenseSaleStorage().staking;
    }

    /// @notice The list price (USDT wei) and the on-sale flag of one (tier, term); zero for a combination that has no
    ///         price (Lite, tier 5, 90 days ...).
    function priceOf(uint8 tier, uint16 term) external view returns (uint256 usdtPrice, bool onSale) {
        Price storage p = _licenseSaleStorage().prices[tier][term];
        return (p.usdt, p.onSale);
    }

    /// @notice The active license of `account`, as Network mirrors it: the tier of the last activation (0 Lite .. 4
    ///         Ultra), when it ends (0 = never activated), how many licenses the account activated, and whether it is
    ///         still running (`expiresAt > now`, to the second).
    function activeLicenseOf(
        address account
    ) external view returns (uint8 tier, uint40 expiresAt, uint32 activationSeq, bool active) {
        return INetwork(_licenseSaleStorage().network).licenseOf(account);
    }

    /// @notice Why `account` can not claim Lite now (`LITE_*`), 0 when it can.
    function liteStatusOf(address account) external view returns (uint8) {
        return _liteStatus(_licenseSaleStorage(), account);
    }

    /// @notice When `account` can activate a Lite again (a timestamp; 0 or in the past = now). It is the later of the
    ///         account's last Lite activation through this contract plus 30 days and, while the account's license is a
    ///         Lite, that Lite's end (which covers a Lite activated before the 30-day rule existed).
    function liteAvailableAt(address account) external view returns (uint40) {
        return _liteAvailableAt(_licenseSaleStorage(), account);
    }

    /// @notice What the shop shows `account`: the 12 sold (tier, term) rows (tier 1..4 x 30 / 180 / 360 days, in that
    ///         order) with price and on-sale flag, and the Lite status (`LITE_*`).
    function licenseOptions(address account) external view returns (Offer[] memory offers, uint8 liteStatus) {
        LicenseSaleStorage storage $ = _licenseSaleStorage();
        uint16[3] memory terms = [uint16(30), 180, 360];
        offers = new Offer[](12);
        for (uint8 tier = 1; tier <= MAX_TIER; ++tier) {
            for (uint256 t = 0; t < 3; ++t) {
                Price storage p = $.prices[tier][terms[t]];
                offers[(tier - 1) * 3 + t] = Offer({
                    tier: tier,
                    term: terms[t],
                    licenseId: uint256(tier) * 1000 + terms[t],
                    usdtPrice: p.usdt,
                    onSale: p.onSale
                });
            }
        }
        liteStatus = _liteStatus($, account);
    }

    /// @notice What `buyLicense(tier, term, payToken, ...)` would charge now: `payAmount` in `payToken` wei (BNB at
    ///         the PriceFeed price, rounded up) and the license's USDT list price. Reverts like the purchase does for
    ///         a license that cannot be bought and for a stale BNB price.
    function quoteLicense(
        uint8 tier,
        uint16 term,
        address payToken
    ) external view returns (uint256 payAmount, uint256 usdtPrice) {
        LicenseSaleStorage storage $ = _licenseSaleStorage();
        usdtPrice = _listPrice($, tier, term);
        // slither-disable-next-line unused-return
        (payAmount, ) = SalePayment.payFor($.priceFeed, $.usdt, payToken, usdtPrice);
    }

    // ------------------------------------------------------------------ internals

    /// @dev The USDT price of a license that can be bought now; reverts when it cannot.
    function _listPrice(LicenseSaleStorage storage $, uint8 tier, uint16 term) private view returns (uint256) {
        if (tier == 0) revert LiteNotForSale();
        Price storage p = $.prices[tier][term];
        if (p.usdt == 0) revert InvalidLicense(tier, term);
        if (!p.onSale) revert NotOnSale(tier, term);
        return p.usdt;
    }

    /// @dev Registers the sponsor on the first purchase and refuses accounts that are not active (frozen).
    function _join(LicenseSaleStorage storage $, address sponsor) private {
        INetwork net = INetwork($.network);
        // `register` says whether the account joined just now, which `isActive` makes irrelevant here.
        // slither-disable-next-line unused-return
        net.register(msg.sender, sponsor);
        if (!net.isActive(msg.sender)) revert NotActive(msg.sender);
    }

    function _liteAvailableAt(LicenseSaleStorage storage $, address account) private view returns (uint40 at) {
        uint40 last = $.liteActivatedAt[account];
        if (last != 0) at = last + uint40(LITE_ACTIVATION_PERIOD);
        // A Lite is active for exactly 30 days, so its end is the earliest the next one is due; this also holds for a
        // Lite activated before `liteActivatedAt` was kept. Only the tier and the end matter here.
        // slither-disable-next-line unused-return
        (uint8 tier, uint40 expiresAt, , ) = INetwork($.network).licenseOf(account);
        if (tier == 0 && expiresAt > at) at = expiresAt;
    }

    function _liteStatus(LicenseSaleStorage storage $, address account) private view returns (uint8) {
        if (!INetwork($.network).isActive(account)) return LITE_NOT_ACTIVE;
        if (!IStakingOwn($.staking).hasOpenOwnP15(account)) return LITE_NO_STAKE;
        if (ILicense($.license).balanceOf(account, LITE_ID) != 0) return LITE_HELD;
        // A running Lite blocks the next claim until it expires, to the second; a running paid license does not.
        // Only the tier and the running flag matter here.
        // slither-disable-next-line unused-return
        (uint8 tier, , , bool active) = INetwork($.network).licenseOf(account);
        if (active && tier == 0) return LITE_RUNNING;
        return LITE_OK;
    }

    function _setTreasury(LicenseSaleStorage storage $, address newTreasury) private {
        _requireContract(newTreasury);
        emit TreasuryChanged($.treasury, newTreasury);
        $.treasury = newTreasury;
    }

    function _setNetwork(LicenseSaleStorage storage $, address newNetwork) private {
        _requireContract(newNetwork);
        emit NetworkChanged($.network, newNetwork);
        $.network = newNetwork;
    }

    function _setPriceFeed(LicenseSaleStorage storage $, address newPriceFeed) private {
        _requireContract(newPriceFeed);
        emit PriceFeedChanged($.priceFeed, newPriceFeed);
        $.priceFeed = newPriceFeed;
    }

    function _setStaking(LicenseSaleStorage storage $, address newStaking) private {
        _requireContract(newStaking);
        emit StakingChanged($.staking, newStaking);
        $.staking = newStaking;
    }

    function _requireContract(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotAContract(account);
    }

    function _licenseSaleStorage() private pure returns (LicenseSaleStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := LICENSE_SALE_STORAGE_LOCATION
        }
    }
}
