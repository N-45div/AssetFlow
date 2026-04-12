// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MintableSettlementToken is ERC20 {
    address public immutable owner;

    error NotOwner();

    constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) {
        owner = owner_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) {
            revert NotOwner();
        }

        _mint(to, amount);
    }
}
