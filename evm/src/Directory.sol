// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Registry} from "./Registry.sol";
import {Servicer} from "./Servicer.sol";

/// @title Where an issuer's registries and bonds are listed
/// @notice The console's index: an issuer lists what they deployed, and only
/// contracts that name them as admin or issuer can be listed under them.
contract Directory {
    mapping(address => address[]) private registries_;
    mapping(address => address[]) private bonds_;

    event RegistryListed(address indexed admin, address registry);
    event BondListed(address indexed issuer, address servicer);

    error NotYours();

    function listRegistry(Registry registry) external {
        if (registry.admin() != msg.sender) revert NotYours();
        registries_[msg.sender].push(address(registry));
        emit RegistryListed(msg.sender, address(registry));
    }

    function listBond(Servicer servicer) external {
        if (servicer.issuer() != msg.sender) revert NotYours();
        bonds_[msg.sender].push(address(servicer));
        emit BondListed(msg.sender, address(servicer));
    }

    function registriesOf(address admin) external view returns (address[] memory) {
        return registries_[admin];
    }

    function bondsOf(address issuer) external view returns (address[] memory) {
        return bonds_[issuer];
    }
}
