// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEAS} from "@eas/IEAS.sol";
import {Directory} from "../src/Directory.sol";
import {Registry} from "../src/Registry.sol";
import {Servicer} from "../src/Servicer.sol";

/// A pilot bond for the broadcaster, set up the way an issuer does from the
/// console: a registry that admits Hong Kong and Singapore, the broadcaster's
/// own profile, a four-coupon note on the given currency, both listed in the
/// directory, and one unit issued, so the gate and the servicer run on the chain.
///
///   DIRECTORY=0x... CURRENCY=0x... forge script script/Pilot.s.sol --rpc-url base --private-key $KEY --broadcast
contract Pilot is Script {
    IEAS constant EAS = IEAS(0x4200000000000000000000000000000000000021);

    function run() external {
        Directory directory = Directory(vm.envAddress("DIRECTORY"));
        IERC20 currency = IERC20(vm.envAddress("CURRENCY"));
        address me = msg.sender;

        // 1 Oct 2026, then every six months; record date the day before each payment.
        uint64[5] memory dates = [uint64(1_790_812_800), 1_806_537_600, 1_822_348_800, 1_838_160_000, 1_853_971_200];
        Servicer.Period[] memory periods = new Servicer.Period[](4);
        for (uint256 i; i < 4; i++) {
            periods[i] = Servicer.Period(dates[i], dates[i + 1], dates[i + 1] - 1 days, dates[i + 1]);
        }

        vm.startBroadcast();
        Registry registry = new Registry(me, EAS, 1, false);
        registry.setJurisdiction(344, true);
        registry.setJurisdiction(702, true);
        registry.setProfile(
            me,
            Registry.Profile({approved: true, accredited: false, hold: false, tier: 1, jurisdiction: 702, expiry: uint64(block.timestamp + 365 days)})
        );
        Servicer bond = new Servicer("AssetFlow Pilot Note", "AFPN", registry, currency, 1_000_000, 1_000, periods);
        bond.token().mint(me, 1);
        directory.listRegistry(registry);
        directory.listBond(bond);
        vm.stopBroadcast();

        console.log("registry", address(registry));
        console.log("servicer", address(bond));
        console.log("token", address(bond.token()));
    }
}
