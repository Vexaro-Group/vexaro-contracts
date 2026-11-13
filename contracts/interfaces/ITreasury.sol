// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice What the sales and Rewards need from the Treasury. `token == address(0)` is native BNB.
interface ITreasury {
    /// @notice Splits a payment already transferred to the Treasury and sends every registered wallet its share
    ///         (PAYER_ROLE). A wallet that cannot receive keeps its share in a bucket; the call does not fail for it.
    function notifyPayment(address token, uint256 amount) external;

    /// @notice Pays `amount` of `token` from the reserve to `to` (RESERVE_SPENDER_ROLE).
    function payFromReserve(address token, address to, uint256 amount) external;

    /// @return The reserve of `token` (what `payFromReserve` can still pay).
    function reserveOf(address token) external view returns (uint256);
}
