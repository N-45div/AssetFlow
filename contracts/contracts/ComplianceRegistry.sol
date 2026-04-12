// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IEligibilityOracle} from "./interfaces/IEligibilityOracle.sol";

contract ComplianceRegistry is AccessControl {
    bytes32 public constant COMPLIANCE_ADMIN_ROLE = keccak256("COMPLIANCE_ADMIN_ROLE");

    error WalletNotEligible(address account);
    error TransferNotAllowed(address from, address to);

    struct InvestorProfile {
        bool approved;
        bool accredited;
        bool frozen;
        uint8 tier;
        uint32 jurisdiction;
        uint64 expiry;
    }

    mapping(address => InvestorProfile) private profiles;
    mapping(uint32 => bool) public allowedJurisdictions;
    mapping(address => bool) public exemptCounterparties;

    address public externalEligibilityOracle;
    bool public externalEligibilityRequired;
    bool public requireAccredited;
    uint8 public minimumTier;

    event InvestorProfileUpdated(
        address indexed account,
        bool approved,
        bool accredited,
        bool frozen,
        uint8 tier,
        uint32 jurisdiction,
        uint64 expiry
    );
    event AllowedJurisdictionUpdated(uint32 indexed jurisdiction, bool allowed);
    event ExemptCounterpartyUpdated(address indexed account, bool allowed);
    event ExternalOracleUpdated(address indexed oracle, bool required);
    event MinimumTierUpdated(uint8 minimumTier);
    event AccreditationRequirementUpdated(bool required);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COMPLIANCE_ADMIN_ROLE, admin);
    }

    function setInvestorProfile(
        address account,
        bool approved,
        bool accredited,
        bool frozen,
        uint8 tier,
        uint32 jurisdiction,
        uint64 expiry
    ) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        profiles[account] = InvestorProfile({
            approved: approved,
            accredited: accredited,
            frozen: frozen,
            tier: tier,
            jurisdiction: jurisdiction,
            expiry: expiry
        });

        emit InvestorProfileUpdated(account, approved, accredited, frozen, tier, jurisdiction, expiry);
    }

    function setAllowedJurisdiction(uint32 jurisdiction, bool allowed) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        allowedJurisdictions[jurisdiction] = allowed;
        emit AllowedJurisdictionUpdated(jurisdiction, allowed);
    }

    function setExemptCounterparty(address account, bool allowed) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        exemptCounterparties[account] = allowed;
        emit ExemptCounterpartyUpdated(account, allowed);
    }

    function setExternalEligibilityOracle(address oracle, bool required) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        externalEligibilityOracle = oracle;
        externalEligibilityRequired = required;
        emit ExternalOracleUpdated(oracle, required);
    }

    function setMinimumTier(uint8 tier) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        minimumTier = tier;
        emit MinimumTierUpdated(tier);
    }

    function setRequireAccredited(bool required) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        requireAccredited = required;
        emit AccreditationRequirementUpdated(required);
    }

    function getInvestorProfile(address account) external view returns (InvestorProfile memory) {
        return profiles[account];
    }

    function isWalletEligible(address account) public view returns (bool) {
        if (exemptCounterparties[account]) {
            return true;
        }

        InvestorProfile memory profile = profiles[account];

        if (!profile.approved || profile.frozen) {
            return false;
        }

        if (profile.expiry < block.timestamp) {
            return false;
        }

        if (profile.tier < minimumTier) {
            return false;
        }

        if (!allowedJurisdictions[profile.jurisdiction]) {
            return false;
        }

        if (requireAccredited && !profile.accredited) {
            return false;
        }

        if (externalEligibilityOracle == address(0)) {
            return true;
        }

        bool oracleEligible = IEligibilityOracle(externalEligibilityOracle).isEligible(account);
        return externalEligibilityRequired ? oracleEligible : oracleEligible || profile.approved;
    }

    function requireTransferAllowed(address from, address to) external view {
        if (from != address(0) && !isWalletEligible(from)) {
            revert WalletNotEligible(from);
        }

        if (to != address(0) && !isWalletEligible(to)) {
            revert WalletNotEligible(to);
        }
    }
}
