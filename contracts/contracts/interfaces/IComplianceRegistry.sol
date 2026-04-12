// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IComplianceRegistry {
    function isWalletEligible(address account) external view returns (bool);

    function requireTransferAllowed(address from, address to) external view;
}
