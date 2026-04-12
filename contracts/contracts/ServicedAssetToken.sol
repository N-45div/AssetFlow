// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IComplianceRegistry} from "./interfaces/IComplianceRegistry.sol";

contract ServicedAssetToken is ERC20, AccessControl, Pausable {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant SERVICING_ROLE = keccak256("SERVICING_ROLE");

    IComplianceRegistry public complianceRegistry;
    bool public restrictionsEnabled = true;
    bool private complianceBypassActive;

    event ComplianceRegistryUpdated(address indexed registry);
    event RestrictionsEnabledUpdated(bool enabled);
    event ServicingTransfer(address indexed from, address indexed to, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        address admin,
        address issuer,
        address complianceRegistry_
    ) ERC20(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, issuer);
        _grantRole(SERVICING_ROLE, issuer);
        complianceRegistry = IComplianceRegistry(complianceRegistry_);
    }

    function mint(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
    }

    function burnFrom(address account, uint256 amount) external onlyRole(SERVICING_ROLE) {
        _burn(account, amount);
    }

    function servicingTransfer(address from, address to, uint256 amount) external onlyRole(SERVICING_ROLE) {
        complianceBypassActive = true;
        _transfer(from, to, amount);
        complianceBypassActive = false;

        emit ServicingTransfer(from, to, amount);
    }

    function setComplianceRegistry(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        complianceRegistry = IComplianceRegistry(registry);
        emit ComplianceRegistryUpdated(registry);
    }

    function setRestrictionsEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        restrictionsEnabled = enabled;
        emit RestrictionsEnabledUpdated(enabled);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        if (
            !complianceBypassActive &&
            restrictionsEnabled &&
            address(complianceRegistry) != address(0) &&
            (from != address(0) || to != address(0))
        ) {
            complianceRegistry.requireTransferAllowed(from, to);
        }

        super._update(from, to, value);
    }
}
