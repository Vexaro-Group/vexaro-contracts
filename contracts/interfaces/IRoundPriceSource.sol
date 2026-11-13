// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice The price of the active VEX sale round (implemented by TokenSale), read by PriceFeed in ROUND mode.
interface IRoundPriceSource {
    /// @return price USDT wei per 1 VEX of the active round.
    /// @return active False when no round is running (the price is then not valid).
    function currentRoundPrice() external view returns (uint256 price, bool active);
}
