// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

contract AssetOracleRouter is AccessControl {
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    error FeedNotConfigured(address asset);
    error FeedDisabled(address asset);
    error StalePrice(address asset, uint256 updatedAt);
    error InvalidPrice(address asset, int256 answer);
    error InvalidBps();

    struct FeedConfig {
        address feed;
        uint8 assetDecimals;
        uint32 staleAfter;
        bool enabled;
    }

    struct Quote {
        uint256 grossUsdValue18;
        uint256 netUsdValue18;
        int256 answer;
        uint8 feedDecimals;
        uint256 updatedAt;
    }

    mapping(address => FeedConfig) public feedConfigs;

    event FeedConfigured(
        address indexed asset,
        address indexed feed,
        uint8 assetDecimals,
        uint32 staleAfter,
        bool enabled
    );

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ADMIN_ROLE, admin);
    }

    function setFeedConfig(
        address asset,
        address feed,
        uint8 assetDecimals,
        uint32 staleAfter,
        bool enabled
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        feedConfigs[asset] = FeedConfig({
            feed: feed,
            assetDecimals: assetDecimals,
            staleAfter: staleAfter,
            enabled: enabled
        });

        emit FeedConfigured(asset, feed, assetDecimals, staleAfter, enabled);
    }

    function getRedemptionQuote(
        address asset,
        uint256 assetAmount,
        uint16 feeBps,
        uint16 haircutBps
    ) external view returns (Quote memory quote) {
        if (feeBps > 10_000 || haircutBps > 10_000) {
            revert InvalidBps();
        }

        FeedConfig memory config = feedConfigs[asset];
        if (config.feed == address(0)) {
            revert FeedNotConfigured(asset);
        }
        if (!config.enabled) {
            revert FeedDisabled(asset);
        }

        (, int256 answer, , uint256 updatedAt, ) = IAggregatorV3(config.feed).latestRoundData();
        if (answer <= 0) {
            revert InvalidPrice(asset, answer);
        }
        if (config.staleAfter > 0 && updatedAt + config.staleAfter < block.timestamp) {
            revert StalePrice(asset, updatedAt);
        }

        uint8 feedDecimals = IAggregatorV3(config.feed).decimals();
        uint256 grossUsdValue18 = (assetAmount * uint256(answer) * 1e18) /
            (10 ** config.assetDecimals) /
            (10 ** feedDecimals);

        uint256 totalDiscountBps = uint256(feeBps) + uint256(haircutBps);
        if (totalDiscountBps > 10_000) {
            revert InvalidBps();
        }

        uint256 netUsdValue18 = (grossUsdValue18 * (10_000 - totalDiscountBps)) / 10_000;

        return Quote({
            grossUsdValue18: grossUsdValue18,
            netUsdValue18: netUsdValue18,
            answer: answer,
            feedDecimals: feedDecimals,
            updatedAt: updatedAt
        });
    }
}
