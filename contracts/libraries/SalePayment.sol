// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceFeed} from "../interfaces/IPriceFeed.sol";
import {ITreasury} from "../interfaces/ITreasury.sol";

/// @title SalePayment
/// @notice The payment side shared by the sales (TokenSale, LicenseSale): pricing a payment in USDT or BNB and
///         moving it once, caller -> Treasury, then reporting it with `notifyPayment` (transfer-then-notify, V10). Only
///         internal functions, so they are compiled into the sale and add no linking, no storage and no public
///         function; the wiring addresses stay in the sale's own ERC-7201 namespace. The sale needs PAYER_ROLE on the
///         Treasury and must be `nonReentrant`: the BNB refund calls the caller.
///
///         `payToken == address(0)` is BNB, priced at `PriceFeed.bnbPrice()` (USDT wei per BNB, a stale answer
///         reverts). Rounding never favours the payer: a payment is valued rounded down (`usdtValue`), a price is
///         charged rounded up (`payFor`).
library SalePayment {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;

    error UnsupportedPayToken(address token);
    error WrongNativeValue(uint256 sent, uint256 expected);
    error NativeTransferFailed();

    /// @dev The USDT a payment of `payAmount` is worth, rounded down (BNB at the Chainlink price).
    function usdtValue(
        address priceFeed,
        address usdt,
        address payToken,
        uint256 payAmount
    ) internal view returns (uint256) {
        if (payToken == address(0)) return Math.mulDiv(payAmount, IPriceFeed(priceFeed).bnbPrice(), WAD);
        if (payToken != usdt) revert UnsupportedPayToken(payToken);
        return payAmount;
    }

    /// @dev What the payer pays in `payToken` for `usdtNeeded` USDT (rounded up) and what that is worth in USDT.
    function payFor(
        address priceFeed,
        address usdt,
        address payToken,
        uint256 usdtNeeded
    ) internal view returns (uint256 payAmount, uint256 usdtWorth) {
        if (payToken == address(0)) {
            uint256 bnbPrice = IPriceFeed(priceFeed).bnbPrice();
            payAmount = Math.mulDiv(usdtNeeded, WAD, bnbPrice, Math.Rounding.Ceil);
            return (payAmount, Math.mulDiv(payAmount, bnbPrice, WAD));
        }
        if (payToken != usdt) revert UnsupportedPayToken(payToken);
        return (usdtNeeded, usdtNeeded);
    }

    // Used inside the payable `buy` / `buyExact` / `buyLicense` of the sales; analysed alone, the library has no
    // payable function to reach it from.
    // slither-disable-start msg-value-in-nonpayable
    /// @dev Moves `payAmount` of `payToken` from the caller into the Treasury and reports it. For BNB `msg.value`
    ///      must be `sent` (>= payAmount) and the difference goes back to the caller; for USDT no BNB may be sent.
    ///      `payToken` must already have been checked by `usdtValue` / `payFor`.
    function collect(address treasury, address payToken, uint256 payAmount, uint256 sent) internal {
        if (payToken == address(0)) {
            if (msg.value != sent) revert WrongNativeValue(msg.value, sent);
            sendNative(treasury, payAmount);
            if (sent > payAmount) sendNative(msg.sender, sent - payAmount);
        } else {
            if (msg.value != 0) revert WrongNativeValue(msg.value, 0);
            IERC20(payToken).safeTransferFrom(msg.sender, treasury, payAmount);
        }
        ITreasury(treasury).notifyPayment(payToken, payAmount);
    }
    // slither-disable-end msg-value-in-nonpayable

    /// @dev `to` is the Treasury (set by DEFAULT_ADMIN) or the caller's own refund; all callers are `nonReentrant`.
    function sendNative(address to, uint256 amount) private {
        // slither-disable-next-line arbitrary-send-eth
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
