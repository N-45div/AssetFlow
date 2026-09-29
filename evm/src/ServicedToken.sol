// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Registry} from "./Registry.sol";

interface IMaturity {
    function matured() external view returns (bool);
}

/// @title A serviced asset's units
/// @notice An ERC-20 whose units move only between wallets the registry admits
/// today, checked on every transfer. It keeps every holder's balance over time,
/// so the register on any record date is read straight from the chain: nobody
/// commits it and nothing is paused to take it. Its servicer (created with it)
/// locks units a holder has asked to redeem, and burns them when redeemed.
contract ServicedToken is ERC20 {
    using Checkpoints for Checkpoints.Trace208;

    Registry public immutable registry;
    address public immutable issuer;
    address public immutable servicer;

    mapping(address => Checkpoints.Trace208) private balanceHistory;
    Checkpoints.Trace208 private supplyHistory;
    /// Units waiting on a redemption request: still the holder's, but they cannot move.
    mapping(address => uint256) public locked;
    address[] private holderList;
    mapping(address => bool) private everHeld;

    error Unauthorized();
    error NotEligible(address wallet);
    error UnitsLocked(address holder);
    error AssetMatured();

    modifier only(address who) {
        if (msg.sender != who) revert Unauthorized();
        _;
    }

    constructor(string memory name_, string memory symbol_, Registry registry_, address issuer_, address servicer_)
        ERC20(name_, symbol_)
    {
        registry = registry_;
        issuer = issuer_;
        servicer = servicer_;
    }

    /// One unit is one note: whole units only.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// Issue to a wallet eligible today; never once the asset has matured.
    function mint(address to, uint256 amount) external only(issuer) {
        if (IMaturity(servicer).matured()) revert AssetMatured();
        if (!registry.isEligible(to)) revert NotEligible(to);
        _mint(to, amount);
    }

    function lock(address holder, uint256 amount) external only(servicer) {
        if (balanceOf(holder) - locked[holder] < amount) revert UnitsLocked(holder);
        locked[holder] += amount;
    }

    function unlock(address holder, uint256 amount) external only(servicer) {
        locked[holder] -= amount;
    }

    /// Burn a holder's units: locked ones on settlement, all of them at maturity.
    function burn(address holder, uint256 amount, bool fromLocked) external only(servicer) {
        if (fromLocked) locked[holder] -= amount;
        _burn(holder, amount);
    }

    /// Balance at the end of second `timestamp`.
    function balanceAt(address account, uint256 timestamp) external view returns (uint256) {
        return balanceHistory[account].upperLookupRecent(SafeCast.toUint48(timestamp));
    }

    function totalSupplyAt(uint256 timestamp) external view returns (uint256) {
        return supplyHistory.upperLookupRecent(SafeCast.toUint48(timestamp));
    }

    /// Every wallet that has ever held units, for the console.
    function holders() external view returns (address[] memory) {
        return holderList;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (!registry.isEligible(from)) revert NotEligible(from);
            if (!registry.isEligible(to)) revert NotEligible(to);
            if (balanceOf(from) - locked[from] < value) revert UnitsLocked(from);
        }
        super._update(from, to, value);
        uint48 now_ = SafeCast.toUint48(block.timestamp);
        if (from != address(0)) balanceHistory[from].push(now_, SafeCast.toUint208(balanceOf(from)));
        if (to != address(0)) {
            balanceHistory[to].push(now_, SafeCast.toUint208(balanceOf(to)));
            if (!everHeld[to]) {
                everHeld[to] = true;
                holderList.push(to);
            }
        }
        if (from == address(0) || to == address(0)) supplyHistory.push(now_, SafeCast.toUint208(totalSupply()));
    }
}
