// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice The prices and the USDT <-> VEX conversions the contracts use. All prices are USDT wei (18 decimals).
interface IPriceFeed {
    /// @return USDT wei per 1 VEX in force; reverts `PriceUnavailable` when there is none.
    function vexPrice() external view returns (uint256);

    /// @return USDT wei per 1 BNB (Chainlink BNB/USD); reverts when unavailable, stale or invalid.
    function bnbPrice() external view returns (uint256);

    /// @return floor(usdt * 1e18 / vexPrice): what a credit or a purchase of `usdt` yields.
    function usdtToVex(uint256 usdt) external view returns (uint256);

    /// @return ceil(usdt * 1e18 / vexPrice): what a payment worth `usdt` costs, rounded for the platform.
    function usdtToVexCeil(uint256 usdt) external view returns (uint256);

    /// @return floor(vex * vexPrice / 1e18): the USDT value of `vex`.
    function vexToUsdt(uint256 vex) external view returns (uint256);
}
