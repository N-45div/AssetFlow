// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ISchemaRegistry, SchemaRecord} from "@eas/ISchemaRegistry.sol";
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

    /// Where the chain's EAS schema registry lives.
    function schemaRegistry() internal view returns (ISchemaRegistry) {
        if (block.chainid == 42161) return ISchemaRegistry(0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB); // Arbitrum One
        return ISchemaRegistry(0x4200000000000000000000000000000000000020); // OP Stack predeploy: Base, Base Sepolia
    }

    function run() external {
        // Test dollars only where a chain is known to be a testnet.
        bool testnet = block.chainid == 84532 || block.chainid == 421614 || block.chainid == 31337;
        bytes32 uid = keccak256(abi.encodePacked(INVESTOR_SCHEMA, address(0), true));
        ISchemaRegistry schemas = schemaRegistry();

        vm.startBroadcast();
        Directory directory = new Directory();
        address usd = testnet ? address(new TestUSD()) : address(0);
        SchemaRecord memory existing = schemas.getSchema(uid);
        if (existing.uid == bytes32(0)) schemas.register(INVESTOR_SCHEMA, ISchemaResolver(address(0)), true);
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("directory", address(directory));
        console.log("testUsd", usd);
        console.log("investorSchema");
        console.logBytes32(uid);
    }
}
