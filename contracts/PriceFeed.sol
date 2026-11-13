// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Managed} from "./abstracts/Managed.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";
import {IRoundPriceSource} from "./interfaces/IRoundPriceSource.sol";
import {IVexPriceAdapter} from "./interfaces/IVexPriceAdapter.sol";

/// @title PriceFeed
/// @notice The prices behind every "≈ USDT" and every USDT rule of the contracts. All prices are USDT wei per
///         one whole unit of the asset (18 decimals); USDT is taken to be worth 1 USD.
///
///         `vexPrice()` follows the mode set by DEFAULT_ADMIN:
///         - ROUND: the active sale round's price, read from `roundSource` (TokenSale, `IRoundPriceSource`);
///         - MANUAL: the price stored by OPERATOR (`setManualPrice`), in force only while the mode is MANUAL;
///         - ADAPTER: the exchange rate from `adapter` (`IVexPriceAdapter`, a DEX TWAP), decided before listing.
///         A source that has no valid price (no active round, 0, a reverting adapter) makes `vexPrice()` revert
///         `PriceUnavailable`; callers never get a made-up price. A mode can only be selected once its source is
///         set, and sources can't be unset, so the selected mode is always configured (the initial ROUND mode before
///         `setRoundSource` is the only exception and simply reverts `PriceUnavailable`).
///
///         `bnbPrice()` reads a Chainlink BNB/USD AggregatorV3 feed (`bnbFeed`) and refuses an answer that is not
///         positive (`InvalidPrice`), whose round is not complete, in the future or from a feed that fails
///         (`PriceUnavailable`), older than `bnbMaxAge` seconds or answered in an older round (`StalePrice`). The
///         feed's `decimals()` is scaled to 18 (down-scaling rounds towards zero; a result of 0 is `InvalidPrice`).
///
///         Conversions use the current `vexPrice()` and 512-bit `mulDiv`, so they never overflow before the final
///         result: `usdtToVex` and `vexToUsdt` round down (credits, quotes), `usdtToVexCeil` rounds up (payments
///         taken from a user).
contract PriceFeed is IPriceFeed, Managed {
    enum VexPriceMode {
        ROUND,
        MANUAL,
        ADAPTER
    }

    uint256 private constant WAD = 1e18;
    /// @dev Largest power of ten that fits in a uint256 (10^77 < 2^256 < 10^78).
    uint256 private constant MAX_POW10 = 77;

    /// @custom:storage-location erc7201:vexaro.storage.PriceFeed
    struct PriceFeedStorage {
        VexPriceMode mode;
        address roundSource;
        address adapter;
        uint256 manualPrice;
        address bnbFeed;
        uint256 bnbMaxAge;
    }

    // keccak256(abi.encode(uint256(keccak256("vexaro.storage.PriceFeed")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PRICE_FEED_STORAGE_LOCATION =
        0x8865aec7db2d5f127e34778d8bf5401ce3d953798d88653437b69119502d6200;

    event VexPriceModeChanged(VexPriceMode oldMode, VexPriceMode newMode);
    event RoundSourceChanged(address indexed oldSource, address indexed newSource);
    event AdapterChanged(address indexed oldAdapter, address indexed newAdapter);
    event ManualPriceChanged(uint256 oldPrice, uint256 newPrice);
    event BnbFeedChanged(address indexed oldFeed, address indexed newFeed);
    event BnbMaxAgeChanged(uint256 oldMaxAge, uint256 newMaxAge);

    /// @dev No valid price: the source is missing, inactive, failing, or answers 0 / an incomplete round.
    error PriceUnavailable();
    /// @dev A zero or negative price, a zero maximum age, or a Chainlink answer that scales to 0.
    error InvalidPrice();
    /// @dev The BNB answer is older than the maximum age (or comes from an older round); `updatedAt` is its time.
    error StalePrice(uint256 updatedAt);
    /// @dev The mode's source (round source, manual price, adapter) is not set yet.
    error ModeNotConfigured(VexPriceMode mode);
    /// @dev The address has no code (a source must be a contract).
    error NotAContract(address account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __Managed_init(admin);
    }

    // ------------------------------------------------------------------ configuration

    /// @notice Selects where `vexPrice()` comes from (DEFAULT_ADMIN). The mode's source must already be set.
    function setVexPriceMode(VexPriceMode newMode) external onlyRole(DEFAULT_ADMIN_ROLE) {
        PriceFeedStorage storage $ = _priceFeedStorage();
        bool configured = newMode == VexPriceMode.ROUND
            ? $.roundSource != address(0)
            : newMode == VexPriceMode.MANUAL
                ? $.manualPrice != 0
                : $.adapter != address(0);
        if (!configured) revert ModeNotConfigured(newMode);
        emit VexPriceModeChanged($.mode, newMode);
        $.mode = newMode;
    }

    /// @notice The ROUND-mode source: TokenSale (DEFAULT_ADMIN).
    function setRoundSource(address source) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireContract(source);
        PriceFeedStorage storage $ = _priceFeedStorage();
        emit RoundSourceChanged($.roundSource, source);
        $.roundSource = source;
    }

    /// @notice The ADAPTER-mode exchange-rate adapter (DEFAULT_ADMIN).
    function setAdapter(address newAdapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireContract(newAdapter);
        PriceFeedStorage storage $ = _priceFeedStorage();
        emit AdapterChanged($.adapter, newAdapter);
        $.adapter = newAdapter;
    }

    /// @notice The admin's manual VEX price, USDT wei per VEX, > 0 (OPERATOR). It can be staged in any
    ///         mode and takes effect only while the mode is MANUAL, which only DEFAULT_ADMIN selects.
    function setManualPrice(uint256 price) external onlyRole(OPERATOR_ROLE) {
        if (price == 0) revert InvalidPrice();
        PriceFeedStorage storage $ = _priceFeedStorage();
        emit ManualPriceChanged($.manualPrice, price);
        $.manualPrice = price;
    }

    /// @notice The Chainlink BNB/USD feed and the maximum age of its answer in seconds, > 0 (DEFAULT_ADMIN).
    function setBnbFeed(address feed, uint256 maxAge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireContract(feed);
        PriceFeedStorage storage $ = _priceFeedStorage();
        emit BnbFeedChanged($.bnbFeed, feed);
        $.bnbFeed = feed;
        _setBnbMaxAge($, maxAge);
    }

    /// @notice Changes the maximum age of the BNB answer, > 0 (DEFAULT_ADMIN).
    function setBnbMaxAge(uint256 maxAge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setBnbMaxAge(_priceFeedStorage(), maxAge);
    }

    // ------------------------------------------------------------------ views

    function vexPriceMode() external view returns (VexPriceMode) {
        return _priceFeedStorage().mode;
    }

    function roundSource() external view returns (address) {
        return _priceFeedStorage().roundSource;
    }

    function adapter() external view returns (address) {
        return _priceFeedStorage().adapter;
    }

    function manualPrice() external view returns (uint256) {
        return _priceFeedStorage().manualPrice;
    }

    function bnbFeed() external view returns (address) {
        return _priceFeedStorage().bnbFeed;
    }

    function bnbMaxAge() external view returns (uint256) {
        return _priceFeedStorage().bnbMaxAge;
    }

    // ------------------------------------------------------------------ prices

    /// @inheritdoc IPriceFeed
    function vexPrice() public view override returns (uint256 price) {
        PriceFeedStorage storage $ = _priceFeedStorage();
        if ($.mode == VexPriceMode.ROUND) price = _roundPrice($.roundSource);
        else if ($.mode == VexPriceMode.MANUAL) price = $.manualPrice;
        else price = _adapterPrice($.adapter);
        if (price == 0) revert PriceUnavailable();
    }

    /// @inheritdoc IPriceFeed
    function bnbPrice() external view override returns (uint256) {
        PriceFeedStorage storage $ = _priceFeedStorage();
        IAggregatorV3 feed = IAggregatorV3($.bnbFeed);
        if (address(feed) == address(0)) revert PriceUnavailable();

        (uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) = _latestRound(feed);
        uint8 feedDecimals = _feedDecimals(feed);

        // An incomplete round (updatedAt 0) or a timestamp in the future is a malfunction, not an old price.
        if (updatedAt == 0 || updatedAt > block.timestamp) revert PriceUnavailable();
        if (answer <= 0) revert InvalidPrice();
        // `answeredInRound` is part of the AggregatorV3 interface: an answer carried over from an older round is stale.
        if (block.timestamp - updatedAt > $.bnbMaxAge || answeredInRound < roundId) revert StalePrice(updatedAt);
        return _scaleTo18(uint256(answer), feedDecimals);
    }

    // ------------------------------------------------------------------ conversions (current vexPrice)

    /// @inheritdoc IPriceFeed
    function usdtToVex(uint256 usdt) external view override returns (uint256) {
        return Math.mulDiv(usdt, WAD, vexPrice());
    }

    /// @inheritdoc IPriceFeed
    function usdtToVexCeil(uint256 usdt) external view override returns (uint256) {
        return Math.mulDiv(usdt, WAD, vexPrice(), Math.Rounding.Ceil);
    }

    /// @inheritdoc IPriceFeed
    function vexToUsdt(uint256 vex) external view override returns (uint256) {
        return Math.mulDiv(vex, vexPrice(), WAD);
    }

    // ------------------------------------------------------------------ internals

    /// @dev The feed's latest round without `startedAt`; a failing feed is `PriceUnavailable`.
    function _latestRound(
        IAggregatorV3 feed
    ) private view returns (uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) {
        // `startedAt` (the third value) is not needed: freshness is judged by `updatedAt`.
        // slither-disable-next-line unused-return
        try feed.latestRoundData() returns (uint80 r, int256 a, uint256, uint256 u, uint80 ar) {
            return (r, a, u, ar);
        } catch {
            revert PriceUnavailable();
        }
    }

    function _feedDecimals(IAggregatorV3 feed) private view returns (uint8) {
        try feed.decimals() returns (uint8 d) {
            return d;
        } catch {
            revert PriceUnavailable();
        }
    }

    function _roundPrice(address source) private view returns (uint256) {
        if (source == address(0)) return 0;
        try IRoundPriceSource(source).currentRoundPrice() returns (uint256 price, bool active) {
            return active ? price : 0;
        } catch {
            return 0;
        }
    }

    /// @dev No zero check: ADAPTER can only be selected once the adapter is set, and it can't be unset.
    function _adapterPrice(address source) private view returns (uint256) {
        try IVexPriceAdapter(source).vexPrice() returns (uint256 price) {
            return price;
        } catch {
            return 0;
        }
    }

    /// @dev Scales a positive Chainlink answer from `feedDecimals` to 18 decimals without overflow; `InvalidPrice`
    ///      when the result does not fit or rounds to 0.
    function _scaleTo18(uint256 answer, uint8 feedDecimals) private pure returns (uint256 scaled) {
        if (feedDecimals <= 18) {
            bool fits;
            (fits, scaled) = Math.tryMul(answer, 10 ** (18 - feedDecimals));
            if (!fits) revert InvalidPrice();
        } else {
            uint256 shift = feedDecimals - 18;
            if (shift > MAX_POW10) revert InvalidPrice();
            scaled = answer / 10 ** shift;
        }
        if (scaled == 0) revert InvalidPrice();
    }

    function _setBnbMaxAge(PriceFeedStorage storage $, uint256 maxAge) private {
        if (maxAge == 0) revert InvalidPrice();
        emit BnbMaxAgeChanged($.bnbMaxAge, maxAge);
        $.bnbMaxAge = maxAge;
    }

    function _requireContract(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotAContract(account);
    }

    function _priceFeedStorage() private pure returns (PriceFeedStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := PRICE_FEED_STORAGE_LOCATION
        }
    }
}
