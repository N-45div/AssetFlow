// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EAS} from "@eas/EAS.sol";
import {SchemaRegistry} from "@eas/SchemaRegistry.sol";
import {ISchemaResolver} from "@eas/resolver/ISchemaResolver.sol";
import {IEAS, AttestationRequest, AttestationRequestData, RevocationRequest, RevocationRequestData} from "@eas/IEAS.sol";
import {DayCount} from "../src/DayCount.sol";
import {Registry} from "../src/Registry.sol";
import {ServicedToken} from "../src/ServicedToken.sol";
import {Servicer} from "../src/Servicer.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// The Solana tests' note, on an EVM chain: US$1 of face per unit, 10% a
/// year, 30/360, held 3,000 / 1,000 / 1,500. Its first period began on 1 July
/// 2026, before the start; its record date is a day after, the next one two.
contract AssetFlowTest is Test {
    uint16 constant HONG_KONG = 344;
    uint16 constant SINGAPORE = 702;
    uint16 constant UNITED_STATES = 840;
    uint256 constant USD = 1e6;

    address issuer = makeAddr("issuer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");
    address provider = makeAddr("provider");

    EAS eas;
    bytes32 kycSchema;
    TestUSD usd;
    Registry registry;
    Servicer bond;
    ServicedToken units;
    uint256 t0;

    function setUp() public {
        vm.warp(1_790_000_000); // late Sep 2026
        t0 = block.timestamp;
        SchemaRegistry schemas = new SchemaRegistry();
        eas = new EAS(schemas);
        kycSchema = schemas.register("uint16 jurisdiction,uint8 tier,bool accredited", ISchemaResolver(address(0)), true);
        usd = new TestUSD();

        vm.startPrank(issuer);
        registry = new Registry(issuer, IEAS(address(eas)), 1, false);
        registry.setJurisdiction(HONG_KONG, true);
        registry.setJurisdiction(SINGAPORE, true);
        registry.setProfile(alice, _profile(HONG_KONG));
        registry.setProfile(bob, _profile(SINGAPORE));
        registry.setProfile(carol, _profile(HONG_KONG));

        // accrual on calendar dates, as 30/360 counts them: 1 Jul 2026 to 1 Jan 2027 to 1 Jul 2027
        uint64 jul26 = uint64(_ts(2026, 7, 1));
        uint64 jan27 = uint64(_ts(2027, 1, 1));
        uint64 jul27 = uint64(_ts(2027, 7, 1));
        Servicer.Period[] memory periods = new Servicer.Period[](2);
        periods[0] = Servicer.Period(jul26, jan27, uint64(t0 + 1 days), uint64(t0 + 1 days + 1));
        periods[1] = Servicer.Period(jan27, jul27, uint64(t0 + 2 days), uint64(t0 + 2 days + 1));
        bond = new Servicer("AssetFlow Note", "AFN", registry, IERC20(address(usd)), uint128(USD), 1_000, periods);
        units = bond.token();
        units.mint(alice, 3_000);
        units.mint(bob, 1_000);
        units.mint(carol, 1_500);
        for (uint256 i; i < 20; i++) usd.drip(); // US$20,000
        usd.approve(address(bond), type(uint256).max);
        vm.stopPrank();
    }

    function _profile(uint16 jurisdiction) internal view returns (Registry.Profile memory) {
        return Registry.Profile({
            approved: true, accredited: false, hold: false, tier: 1, jurisdiction: jurisdiction, expiry: uint64(block.timestamp + 365 days)
        });
    }

    function _fund(uint256 period, uint256 amount) internal {
        vm.prank(issuer);
        bond.fund(period, amount);
    }

    // ---- the arithmetic ----

    function test_thirty_360_matches_the_solana_program() public pure {
        assertEq(DayCount.days30360(_ts(2026, 10, 1), _ts(2027, 4, 1)), 180);
        assertEq(DayCount.days30360(_ts(2027, 1, 31), _ts(2027, 3, 31)), 60);
        assertEq(DayCount.days30360(_ts(2027, 4, 15), _ts(2027, 6, 15)), 60);
        assertEq(DayCount.days30360(_ts(2027, 3, 1), _ts(2027, 3, 31)), 30);
    }

    function test_rounds_down_to_the_cent_on_the_whole_holding() public pure {
        int256 d = DayCount.days30360(_ts(2027, 4, 15), _ts(2027, 6, 15));
        assertEq(DayCount.interest(1_000, USD, 1_000, d, 6), 16_660_000); // US$16.66
        assertEq(DayCount.interest(3_000, USD, 1_000, d, 6), 50_000_000); // US$50.00, not 3 x 16.66
    }

    function testFuzz_parts_never_exceed_the_whole(uint32 a, uint32 b, uint32 c, uint16 days_) public pure {
        int256 d = int256(uint256(days_ % 400) + 1);
        uint256 parts = DayCount.interest(a, USD, 1_000, d, 6) + DayCount.interest(b, USD, 1_000, d, 6)
            + DayCount.interest(c, USD, 1_000, d, 6);
        assertLe(parts, DayCount.interest(uint256(a) + b + c, USD, 1_000, d, 6));
    }

    // ---- the gate ----

    function test_issues_only_to_eligible_wallets() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ServicedToken.NotEligible.selector, stranger));
        units.mint(stranger, 1);
    }

    function test_moves_units_only_between_eligible_wallets() public {
        vm.prank(alice);
        units.transfer(bob, 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServicedToken.NotEligible.selector, stranger));
        units.transfer(stranger, 10);
    }

    function test_a_lapsed_approval_stops_the_next_transfer() public {
        vm.prank(issuer);
        registry.setHold(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServicedToken.NotEligible.selector, alice));
        units.transfer(bob, 10);
    }

    // ---- coupons ----

    function test_pays_nothing_before_the_record_date() public {
        vm.expectRevert(Servicer.RecordDateNotReached.selector);
        bond.pay(0, alice);
    }

    function test_the_register_is_the_balance_at_the_record_date() public {
        vm.warp(t0 + 1 days + 10);
        vm.prank(alice);
        units.transfer(bob, 1_000); // after the record date: changes nothing for coupon 1
        assertEq(bond.required(0), 275 * USD); // 5,500 units, half a year at 10%
        _fund(0, 275 * USD);
        bond.pay(0, alice);
        bond.pay(0, bob);
        assertEq(usd.balanceOf(alice), 150 * USD);
        assertEq(usd.balanceOf(bob), 50 * USD);
    }

    function test_pays_nothing_until_fully_funded_then_holds_back_the_ineligible() public {
        vm.warp(t0 + 1 days + 10);
        _fund(0, 200 * USD);
        vm.expectRevert(Servicer.Underfunded.selector);
        bond.pay(0, alice);
        _fund(0, 75 * USD);
        vm.prank(issuer);
        registry.setHold(carol, true);
        address[] memory all = units.holders();
        vm.prank(stranger);
        bond.payMany(0, all);
        assertEq(usd.balanceOf(carol), 0);
        Servicer.Payment memory p = bond.payment(0);
        assertEq(p.paid, 200 * USD);
        assertEq(p.heldBack, 75 * USD);
        vm.expectRevert(Servicer.AlreadyPaid.selector);
        bond.pay(0, alice);
    }

    function test_one_payment_never_draws_on_another() public {
        vm.warp(t0 + 2 days + 10);
        _fund(0, 275 * USD); // only coupon 1 is funded
        vm.expectRevert(Servicer.Underfunded.selector);
        bond.pay(1, alice);
    }

    // ---- early redemption ----

    function test_settles_at_face_plus_accrued_interest_and_burns_in_the_same_call() public {
        vm.prank(alice);
        uint256 id = bond.requestRedemption(1_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ServicedToken.UnitsLocked.selector, alice));
        units.transfer(bob, 2_500); // 1,000 of her 3,000 are locked

        vm.prank(stranger);
        vm.expectRevert(Servicer.Unauthorized.selector);
        bond.settle(id);

        (uint256 principal, uint256 interest) = bond.priceOf(1_000, block.timestamp);
        assertEq(principal, 1_000 * USD);
        assertGt(interest, 0);
        vm.prank(issuer);
        bond.settle(id);
        assertEq(usd.balanceOf(alice), principal + interest);
        assertEq(units.balanceOf(alice), 2_000);
        assertEq(units.totalSupply(), 4_500);
        vm.prank(issuer);
        vm.expectRevert(Servicer.RequestClosed.selector);
        bond.settle(id);
    }

    function test_the_holder_withdraws_and_the_issuer_rejects() public {
        vm.prank(bob);
        uint256 a = bond.requestRedemption(400);
        vm.prank(stranger);
        vm.expectRevert(Servicer.Unauthorized.selector);
        bond.cancel(a);
        vm.prank(bob);
        bond.cancel(a);
        vm.prank(bob);
        uint256 b = bond.requestRedemption(400);
        vm.prank(issuer);
        bond.reject(b);
        assertEq(units.locked(bob), 0);
        assertEq(uint8(bond.request(b).status), uint8(Servicer.Status.Rejected));
    }

    function test_locked_units_still_earn_their_coupon() public {
        vm.prank(bob);
        bond.requestRedemption(200);
        vm.warp(t0 + 1 days + 10);
        _fund(0, 275 * USD);
        bond.pay(0, bob);
        assertEq(usd.balanceOf(bob), 50 * USD); // on all 1,000
    }

    // ---- maturity ----

    function test_matures_after_the_last_payment_date_and_redeems_at_face() public {
        vm.expectRevert(Servicer.MaturityNotReached.selector);
        bond.startMaturity();
        vm.prank(bob);
        uint256 open = bond.requestRedemption(200);
        vm.warp(t0 + 2 days + 2);

        vm.prank(stranger);
        bond.startMaturity();
        vm.prank(issuer);
        vm.expectRevert(ServicedToken.AssetMatured.selector);
        units.mint(alice, 1);
        vm.prank(alice);
        vm.expectRevert(Servicer.AssetMatured.selector);
        bond.requestRedemption(1);

        vm.expectRevert(Servicer.Underfunded.selector);
        bond.redeem(alice);
        vm.prank(issuer);
        bond.fundMaturity(5_500 * USD);

        bond.redeem(alice);
        assertEq(usd.balanceOf(alice), 3_000 * USD);
        vm.expectRevert(Servicer.NothingHeld.selector);
        bond.redeem(alice);

        vm.expectRevert(Servicer.OpenRequest.selector);
        bond.redeem(bob);
        vm.prank(bob);
        bond.cancel(open);
        bond.redeem(bob);
        assertEq(usd.balanceOf(bob), 1_000 * USD);

        vm.prank(issuer);
        registry.setHold(carol, true);
        vm.expectRevert(abi.encodeWithSelector(Servicer.NotEligible.selector, carol));
        bond.redeem(carol);
        assertEq(units.balanceOf(carol), 1_500); // kept, and her principal waits
        assertEq(usd.balanceOf(address(bond)), 1_500 * USD);
    }

    // ---- KYC once, through EAS ----

    function _attest(address wallet, uint16 jurisdiction, uint64 expiry, address by) internal returns (bytes32) {
        vm.prank(by);
        return eas.attest(
            AttestationRequest({
                schema: kycSchema,
                data: AttestationRequestData({
                    recipient: wallet,
                    expirationTime: expiry,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(jurisdiction, uint8(1), false),
                    value: 0
                })
            })
        );
    }

    function test_an_attested_investor_onboards_themselves() public {
        address dana = makeAddr("dana");
        bytes32 uid = _attest(dana, HONG_KONG, 0, provider);
        vm.expectRevert(Registry.KycSourceNotSet.selector);
        registry.claimProfile(uid);
        vm.prank(issuer);
        registry.setKycSource(kycSchema, provider);

        vm.prank(stranger); // anyone may present it
        registry.claimProfile(uid);
        assertTrue(registry.isEligible(dana));
        assertEq(registry.profileOf(dana).expiry, registry.NO_EXPIRY());
        vm.prank(issuer);
        units.mint(dana, 10);
    }

    function test_refuses_an_untrusted_provider_and_an_expired_attestation() public {
        vm.prank(issuer);
        registry.setKycSource(kycSchema, provider);
        bytes32 rival = _attest(makeAddr("erin"), HONG_KONG, 0, makeAddr("rival"));
        vm.expectRevert(Registry.AttestationMismatch.selector);
        registry.claimProfile(rival);
        bytes32 soon = _attest(makeAddr("fay"), HONG_KONG, uint64(block.timestamp + 60), provider);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(Registry.AttestationExpired.selector);
        registry.claimProfile(soon);
    }

    function test_policy_still_applies_and_a_hold_is_never_lifted() public {
        vm.prank(issuer);
        registry.setKycSource(kycSchema, provider);
        address gus = makeAddr("gus");
        registry.claimProfile(_attest(gus, UNITED_STATES, 0, provider));
        assertFalse(registry.isEligible(gus)); // the US is not allowed here

        address hal = makeAddr("hal");
        bytes32 uid = _attest(hal, HONG_KONG, 0, provider);
        registry.claimProfile(uid);
        vm.prank(issuer);
        registry.setHold(hal, true);
        registry.claimProfile(uid);
        assertTrue(registry.profileOf(hal).hold);
        assertFalse(registry.isEligible(hal));
    }

    function test_a_revoked_attestation_lets_anyone_withdraw_the_approval() public {
        vm.prank(issuer);
        registry.setKycSource(kycSchema, provider);
        address ivy = makeAddr("ivy");
        bytes32 uid = _attest(ivy, HONG_KONG, 0, provider);
        registry.claimProfile(uid);
        vm.prank(issuer);
        units.mint(ivy, 10);

        vm.expectRevert(Registry.StillAttested.selector);
        registry.lapseProfile(ivy);
        vm.prank(provider);
        eas.revoke(RevocationRequest({schema: kycSchema, data: RevocationRequestData({uid: uid, value: 0})}));
        vm.prank(stranger);
        registry.lapseProfile(ivy);
        assertFalse(registry.isEligible(ivy));
        vm.prank(ivy);
        vm.expectRevert(abi.encodeWithSelector(ServicedToken.NotEligible.selector, ivy));
        units.transfer(alice, 1);
    }

    function test_switching_providers_lapses_the_old_ones_profiles() public {
        vm.prank(issuer);
        registry.setKycSource(kycSchema, provider);
        address jo = makeAddr("jo");
        registry.claimProfile(_attest(jo, HONG_KONG, 0, provider));
        vm.prank(issuer);
        registry.setKycSource(kycSchema, makeAddr("newProvider"));
        registry.lapseProfile(jo);
        assertFalse(registry.isEligible(jo));
    }

    /// UTC midnight of a civil date (the inverse of DayCount.civilFromDays).
    function _ts(int256 y, int256 m, int256 d) internal pure returns (uint256) {
        y = m <= 2 ? y - 1 : y;
        int256 era = (y >= 0 ? y : y - 399) / 400;
        int256 yoe = y - era * 400;
        int256 mp = m > 2 ? m - 3 : m + 9;
        int256 doy = (153 * mp + 2) / 5 + d - 1;
        int256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return uint256((era * 146_097 + doe - 719_468) * 86_400);
    }
}
