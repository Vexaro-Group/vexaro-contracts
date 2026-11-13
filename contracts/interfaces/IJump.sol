// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice What Staking calls on the VEX Jump contract.
interface IJump {
    /// @notice A USER stake of a jump-eligible pool (P1-P5) was opened by `account` with `entryUsdt` USDT (wei) of
    ///         value; fills a slot of the sponsor's cycle when the VEX Jump rules say so. HOOK_ROLE only (Staking).
    function onStakeOpened(address account, uint256 poolId, uint256 entryUsdt) external;
}
