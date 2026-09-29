// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEAS} from "@eas/IEAS.sol";
import {Attestation} from "@eas/Common.sol";

/// @title AssetFlow investor registry
/// @notice The compliance policy and investor profiles one or more assets are
/// gated by: the same rules as the Solana program's registry. A profile can be
/// set by compliance, or written by anyone from an attestation by the KYC
/// provider the registry trusts (Ethereum Attestation Service, a predeploy on
/// Base), so an investor verified once onboards into every registry that
/// trusts the provider.
contract Registry {
    struct Profile {
        bool approved;
        bool accredited;
        /// A compliance hold: the registry's own word, never lifted by an attestation.
        bool hold;
        uint8 tier;
        /// ISO 3166-1 numeric.
        uint16 jurisdiction;
        uint64 expiry;
    }

    /// Profiles from attestations that never expire carry this date: 9999-12-31 23:59:59 UTC.
    uint64 public constant NO_EXPIRY = 253_402_300_799;

    IEAS public immutable eas;
    address public admin;
    address public compliance;
    uint8 public minTier;
    bool public requireAccredited;
    mapping(uint16 => bool) public jurisdictionAllowed;
    uint16[] private jurisdictionList;

    mapping(address => Profile) private profiles;
    address[] private investorList;
    mapping(address => bool) private listed;

    /// The KYC source: an EAS schema and the attester trusted for it. Zero means none.
    bytes32 public kycSchema;
    address public kycAttester;
    /// Which attestation a profile was written from, if any.
    mapping(address => bytes32) public attestedFrom;

    event ComplianceRotated(address compliance);
    event PolicyUpdated(uint8 minTier, bool requireAccredited);
    event JurisdictionUpdated(uint16 code, bool allowed);
    event ProfileUpdated(address indexed wallet, Profile profile);
    event KycSourceSet(bytes32 schema, address attester);
    event ProfileClaimed(address indexed wallet, bytes32 attestation, uint16 jurisdiction, uint8 tier, bool accredited);
    event ProfileLapsed(address indexed wallet, bytes32 attestation);

    error Unauthorized();
    error KycSourceNotSet();
    error AttestationMismatch();
    error AttestationExpired();
    error StillAttested();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyCompliance() {
        if (msg.sender != compliance) revert Unauthorized();
        _;
    }

    constructor(address admin_, IEAS eas_, uint8 minTier_, bool requireAccredited_) {
        admin = admin_;
        compliance = admin_;
        eas = eas_;
        minTier = minTier_;
        requireAccredited = requireAccredited_;
    }

    function setCompliance(address compliance_) external onlyAdmin {
        compliance = compliance_;
        emit ComplianceRotated(compliance_);
    }

    function setPolicy(uint8 minTier_, bool requireAccredited_) external onlyCompliance {
        minTier = minTier_;
        requireAccredited = requireAccredited_;
        emit PolicyUpdated(minTier_, requireAccredited_);
    }

    function setJurisdiction(uint16 code, bool allowed) external onlyCompliance {
        if (allowed && !jurisdictionAllowed[code]) {
            jurisdictionList.push(code);
        } else if (!allowed && jurisdictionAllowed[code]) {
            for (uint256 i; i < jurisdictionList.length; i++) {
                if (jurisdictionList[i] == code) {
                    jurisdictionList[i] = jurisdictionList[jurisdictionList.length - 1];
                    jurisdictionList.pop();
                    break;
                }
            }
        }
        jurisdictionAllowed[code] = allowed;
        emit JurisdictionUpdated(code, allowed);
    }

    /// Create or overwrite a wallet's profile. Compliance's own profile no
    /// longer follows any attestation it was claimed from.
    function setProfile(address wallet, Profile calldata profile) external onlyCompliance {
        delete attestedFrom[wallet];
        _write(wallet, profile);
    }

    /// Put a wallet on a compliance hold, or lift it, leaving the rest of the profile as it is.
    function setHold(address wallet, bool hold) external onlyCompliance {
        Profile memory p = profiles[wallet];
        p.hold = hold;
        _write(wallet, p);
    }

    /// Whether `wallet` may hold assets gated by this registry today.
    function isEligible(address wallet) public view returns (bool) {
        Profile memory p = profiles[wallet];
        return p.approved
            && !p.hold
            && p.expiry >= block.timestamp
            && p.tier >= minTier
            && jurisdictionAllowed[p.jurisdiction]
            && (!requireAccredited || p.accredited);
    }

    // ---- KYC once, through the Ethereum Attestation Service ----

    /// Trust an attester's attestations under `schema` (encoded as
    /// `uint16 jurisdiction, uint8 tier, bool accredited`), or zero to trust none.
    function setKycSource(bytes32 schema, address attester) external onlyCompliance {
        kycSchema = schema;
        kycAttester = attester;
        emit KycSourceSet(schema, attester);
    }

    /// Anyone: write the profile of an attestation's recipient from it. A
    /// compliance hold on the profile stays as it is.
    function claimProfile(bytes32 uid) external {
        if (kycAttester == address(0)) revert KycSourceNotSet();
        Attestation memory a = eas.getAttestation(uid);
        if (a.schema != kycSchema || a.attester != kycAttester || a.recipient == address(0) || a.revocationTime != 0) {
            revert AttestationMismatch();
        }
        if (a.expirationTime != 0 && a.expirationTime <= block.timestamp) revert AttestationExpired();
        (uint16 jurisdiction, uint8 tier, bool accredited) = abi.decode(a.data, (uint16, uint8, bool));
        _write(
            a.recipient,
            Profile({
                approved: true,
                accredited: accredited,
                hold: profiles[a.recipient].hold,
                tier: tier,
                jurisdiction: jurisdiction,
                expiry: a.expirationTime == 0 ? NO_EXPIRY : a.expirationTime
            })
        );
        attestedFrom[a.recipient] = uid;
        emit ProfileClaimed(a.recipient, uid, jurisdiction, tier, accredited);
    }

    /// Anyone: withdraw the approval of a profile whose attestation was
    /// revoked, has expired, or comes from a source no longer trusted.
    function lapseProfile(address wallet) external {
        bytes32 uid = attestedFrom[wallet];
        if (uid == bytes32(0)) revert AttestationMismatch();
        Attestation memory a = eas.getAttestation(uid);
        bool vouches = a.schema == kycSchema
            && a.attester == kycAttester
            && kycAttester != address(0)
            && a.recipient == wallet
            && a.revocationTime == 0
            && (a.expirationTime == 0 || a.expirationTime > block.timestamp);
        if (vouches) revert StillAttested();
        Profile memory p = profiles[wallet];
        p.approved = false;
        _write(wallet, p);
        emit ProfileLapsed(wallet, uid);
    }

    // ---- reads for the console ----

    function profileOf(address wallet) external view returns (Profile memory) {
        return profiles[wallet];
    }

    function jurisdictions() external view returns (uint16[] memory) {
        return jurisdictionList;
    }

    function investors() external view returns (address[] memory) {
        return investorList;
    }

    function _write(address wallet, Profile memory profile) internal {
        profiles[wallet] = profile;
        if (!listed[wallet]) {
            listed[wallet] = true;
            investorList.push(wallet);
        }
        emit ProfileUpdated(wallet, profile);
    }
}
