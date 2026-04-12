// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

contract MockPriceFeed is IAggregatorV3 {
    uint8 private immutable feedDecimals;
    int256 private answer;
    uint256 private updatedAt;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        feedDecimals = decimals_;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setRoundData(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256,
            uint256 startedAt,
            uint256,
            uint80 answeredInRound
        )
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
