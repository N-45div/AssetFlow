// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Test dollars for the testnet demo
/// @notice A worthless 6-decimal token standing in for USDC: anyone may take
/// 1,000 at a time. Deployed on testnets only.
contract TestUSD is ERC20 {
    uint256 public constant DRIP = 1_000 * 10 ** 6;

    constructor() ERC20("AssetFlow Test USD", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function drip() external {
        _mint(msg.sender, DRIP);
    }
}
