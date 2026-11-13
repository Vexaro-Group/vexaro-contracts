// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice The Chainlink AggregatorV3Interface (same ABI), declared here so the repo needs no Chainlink package.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
