// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ISchemaRegistry, SchemaRecord} from "@eas/ISchemaRegistry.sol";
import {EAS} from "@eas/EAS.sol";
import {SchemaRegistry} from "@eas/SchemaRegistry.sol";
import {ISchemaResolver} from "@eas/resolver/ISchemaResolver.sol";
import {Directory} from "../src/Directory.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// Deploy what every issuer on the chain shares: the directory the console
/// lists registries and bonds from, test dollars (testnets only), and
/// AssetFlow's investor schema on the chain's EAS schema registry. Registries
/// and bonds themselves are deployed by issuers, from the console.
///
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --private-key $KEY --broadcast
contract Deploy is Script {
    string constant INVESTOR_SCHEMA = "uint16 jurisdiction,uint8 tier,bool accredited";

    /// The chain's EAS and schema registry, where EAS already runs; zero where it does not.
    function knownEas() internal view returns (address eas, address schemas) {
        if (block.chainid == 8453 || block.chainid == 84532) {
            // OP Stack predeploys: Base and Base Sepolia
            return (0x4200000000000000000000000000000000000021, 0x4200000000000000000000000000000000000020);
        }
        if (block.chainid == 42161) return (0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458, 0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB);
        if (block.chainid == 421614) return (0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE, 0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475);
        return (address(0), address(0));
    }

    function run() external {
        // Test dollars only where a chain is known to be a testnet.
        bool testnet = block.chainid == 84532 || block.chainid == 421614 || block.chainid == 46630 || block.chainid == 31337;
        bytes32 uid = keccak256(abi.encodePacked(INVESTOR_SCHEMA, address(0), true));
        (address eas, address schemasAt) = knownEas();

        vm.startBroadcast();
        Directory directory = new Directory();
        address usd = testnet ? address(new TestUSD()) : address(0);
        // No EAS on this chain (Robinhood Chain, for one): run the Foundation's contracts ourselves.
        if (eas == address(0)) {
            SchemaRegistry registry = new SchemaRegistry();
            schemasAt = address(registry);
            eas = address(new EAS(registry));
        }
        ISchemaRegistry schemas = ISchemaRegistry(schemasAt);
        SchemaRecord memory existing = schemas.getSchema(uid);
        if (existing.uid == bytes32(0)) schemas.register(INVESTOR_SCHEMA, ISchemaResolver(address(0)), true);
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("directory", address(directory));
        console.log("testUsd", usd);
        console.log("eas", eas);
        console.log("schemaRegistry", schemasAt);
        console.log("investorSchema");
        console.logBytes32(uid);
    }
}
