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
    /// OP Stack predeploys, the same address on Base and Base Sepolia.
    ISchemaRegistry constant SCHEMAS = ISchemaRegistry(0x4200000000000000000000000000000000000020);
    string constant INVESTOR_SCHEMA = "uint16 jurisdiction,uint8 tier,bool accredited";

    function run() external {
        bool testnet = block.chainid != 8453;
        bytes32 uid = keccak256(abi.encodePacked(INVESTOR_SCHEMA, address(0), true));

        vm.startBroadcast();
        Directory directory = new Directory();
        address usd = testnet ? address(new TestUSD()) : address(0);
        SchemaRecord memory existing = SCHEMAS.getSchema(uid);
        if (existing.uid == bytes32(0)) SCHEMAS.register(INVESTOR_SCHEMA, ISchemaResolver(address(0)), true);
        vm.stopBroadcast();

        console.log("chain", block.chainid);
        console.log("directory", address(directory));
        console.log("testUsd", usd);
        console.log("investorSchema");
        console.logBytes32(uid);
    }
}
