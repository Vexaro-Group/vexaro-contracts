// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// An optional helper that is not deployed on mainnet: the TimelockController the testnet hand-over mode deploys. The
// mainnet hand-over gives the roles to the Safe directly. Imported only so that the artifact is compiled; no wrapper
// contract.
// solhint-disable-next-line no-unused-import
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
