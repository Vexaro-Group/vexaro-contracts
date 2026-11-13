// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

interface IVexaro is IERC20, IERC20Metadata, IERC20Permit, IVotes {
    function burn(uint256 value) external;

    function burnFrom(address account, uint256 value) external;

    function feeBps() external view returns (uint16);

    function isExempt(address account) external view returns (bool);

    function isPlatformRestricted(address account) external view returns (bool);

    function airdropWallet() external view returns (address);

    function airdropLockedOf(address account) external view returns (uint256);

    function freeBalanceOf(address account) external view returns (uint256);

    /// @notice Moves `amount` of the account's airdrop-locked VEX to the caller (AIRDROP_SPENDER_ROLE).
    function spendAirdrop(address account, uint256 amount) external;
}
