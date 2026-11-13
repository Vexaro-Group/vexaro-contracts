// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IStaking} from "./IStaking.sol";

/// @notice The Staking views the Jump contract reads to follow a stake after it was opened.
interface IStakeReader {
    /// @notice Everything known about one stake (empty for an unknown id).
    function stakeView(uint256 stakeId) external view returns (IStaking.StakeView memory);

    /// @notice Ids of the account's open stakes (at most 50); a stake opened in this transaction is the last one.
    function openStakesOf(address account) external view returns (uint256[] memory);
}
