// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Pausable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title License
/// @notice ERC1155 license NFTs, not upgradeable. id = tier * 1000 + days (Lite = tier 0 -> id 30; Basic 1030 / 1180
///         / 1360; ... Ultra 4030 / 4180 / 4360); 1 unit = 1 license. Only valid ids can be minted. MINTER (the
///         LicenseSale and the admin Safe) mints, BURNER (the LicenseSale) burns without approval on activation.
///         Transferable until activated; no supply extension; pausable by PAUSER.
contract License is ERC1155, ERC1155Pausable, AccessControl {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 public constant TIER_LITE = 0;
    uint8 public constant TIER_BASIC = 1;
    uint8 public constant TIER_PRIME = 2;
    uint8 public constant TIER_ELITE = 3;
    uint8 public constant TIER_ULTRA = 4;

    uint16 public constant DAYS_30 = 30;
    uint16 public constant DAYS_180 = 180;
    uint16 public constant DAYS_360 = 360;

    uint256 private constant TIER_MULTIPLIER = 1000;

    string private _baseURI;

    event BaseURIChanged(string newBaseURI);

    error ZeroAddress();
    error InvalidLicenseId(uint256 id);

    constructor(address defaultAdmin, string memory baseURI_) ERC1155("") {
        if (defaultAdmin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(MINTER_ROLE, defaultAdmin);
        _grantRole(PAUSER_ROLE, defaultAdmin);
        _baseURI = baseURI_;
    }

    /// @notice Id of the license of `tier` lasting `duration` days; reverts `InvalidLicenseId` for a combination
    ///         that does not exist.
    function licenseId(uint8 tier, uint16 duration) public pure returns (uint256 id) {
        // a duration of 1000+ would alias into the next tier's ids
        if (duration >= TIER_MULTIPLIER) revert InvalidLicenseId(duration);
        id = uint256(tier) * TIER_MULTIPLIER + duration;
        if (!isValidId(id)) revert InvalidLicenseId(id);
    }

    /// @notice Splits a valid license id into (tier, days); reverts `InvalidLicenseId` otherwise.
    function decodeId(uint256 id) public pure returns (uint8 tier, uint16 duration) {
        if (!isValidId(id)) revert InvalidLicenseId(id);
        return (uint8(id / TIER_MULTIPLIER), uint16(id % TIER_MULTIPLIER));
    }

    /// @notice Lite exists for 30 days only; Basic..Ultra for 30, 180 and 360 days.
    function isValidId(uint256 id) public pure returns (bool) {
        uint256 tier = id / TIER_MULTIPLIER;
        uint256 duration = id % TIER_MULTIPLIER;
        if (tier > TIER_ULTRA) return false;
        if (duration == DAYS_30) return true;
        return tier != TIER_LITE && (duration == DAYS_180 || duration == DAYS_360);
    }

    /// @notice Metadata URI of `id`: base URI followed by the decimal id.
    function uri(uint256 id) public view override returns (string memory) {
        return string.concat(_baseURI, id.toString());
    }

    function setBaseURI(string calldata newBaseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _baseURI = newBaseURI;
        emit BaseURIChanged(newBaseURI);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function mint(address account, uint256 id, uint256 amount, bytes calldata data) external onlyRole(MINTER_ROLE) {
        _mint(account, id, amount, data);
    }

    function mintBatch(
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external onlyRole(MINTER_ROLE) {
        _mintBatch(to, ids, amounts, data);
    }

    /// @notice Burns `amount` of `account`'s `id` without any approval (BURNER only).
    function burn(address account, uint256 id, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(account, id, amount);
    }

    function burnBatch(
        address account,
        uint256[] calldata ids,
        uint256[] calldata amounts
    ) external onlyRole(BURNER_ROLE) {
        _burnBatch(account, ids, amounts);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /// @dev Pause check (ERC1155Pausable) plus the id whitelist on every mint.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Pausable) {
        if (from == address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                if (!isValidId(ids[i])) revert InvalidLicenseId(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }
}
