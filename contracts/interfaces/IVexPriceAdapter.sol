// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice The exchange-rate source of the VEX price after the sale rounds (a TWAP adapter over the DEX pair),
///         read by PriceFeed in ADAPTER mode. It reverts or returns 0 when it has no valid price.
interface IVexPriceAdapter {
    /// @return USDT wei per 1 VEX.
    function vexPrice() external view returns (uint256);
}
