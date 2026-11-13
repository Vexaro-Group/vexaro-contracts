// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

interface ILicense is IERC1155 {
    function mint(address account, uint256 id, uint256 amount, bytes calldata data) external;

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external;

    function burn(address account, uint256 id, uint256 amount) external;

    function burnBatch(address account, uint256[] calldata ids, uint256[] calldata amounts) external;

    function licenseId(uint8 tier, uint16 duration) external pure returns (uint256);

    function decodeId(uint256 id) external pure returns (uint8 tier, uint16 duration);

    function isValidId(uint256 id) external pure returns (bool);
}
