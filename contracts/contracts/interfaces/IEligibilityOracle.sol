// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEligibilityOracle {
    function isEligible(address account) external view returns (bool);
}
