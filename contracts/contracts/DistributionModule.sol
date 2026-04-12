// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract DistributionModule is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    address public constant NATIVE_TOKEN = address(0);

    struct Distribution {
        address payoutToken;
        bytes32 merkleRoot;
        uint128 totalAmount;
        uint128 claimedAmount;
        uint64 snapshotTimestamp;
        string metadataURI;
        bool cancelled;
    }

    uint256 public nextDistributionId;

    mapping(uint256 => Distribution) private distributions;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event DistributionCreated(
        uint256 indexed distributionId,
        address indexed payoutToken,
        bytes32 merkleRoot,
        uint128 totalAmount,
        uint64 snapshotTimestamp,
        string metadataURI
    );
    event DistributionClaimed(uint256 indexed distributionId, address indexed account, uint256 payoutAmount);
    event DistributionCancelled(uint256 indexed distributionId);
    event NativeFundsReceived(address indexed sender, uint256 amount);

    constructor(address admin, address issuer) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, issuer);
    }

    function createDistribution(
        address payoutToken,
        bytes32 merkleRoot,
        uint128 totalAmount,
        uint64 snapshotTimestamp,
        string calldata metadataURI
    ) external payable onlyRole(ISSUER_ROLE) returns (uint256 distributionId) {
        distributionId = nextDistributionId++;

        distributions[distributionId] = Distribution({
            payoutToken: payoutToken,
            merkleRoot: merkleRoot,
            totalAmount: totalAmount,
            claimedAmount: 0,
            snapshotTimestamp: snapshotTimestamp,
            metadataURI: metadataURI,
            cancelled: false
        });

        if (payoutToken == NATIVE_TOKEN) {
            require(msg.value == totalAmount, "invalid native funding");
        } else {
            require(msg.value == 0, "unexpected native funding");
            IERC20(payoutToken).safeTransferFrom(msg.sender, address(this), totalAmount);
        }

        emit DistributionCreated(
            distributionId,
            payoutToken,
            merkleRoot,
            totalAmount,
            snapshotTimestamp,
            metadataURI
        );
    }

    function claim(
        uint256 distributionId,
        uint256 assetAmount,
        uint256 payoutAmount,
        bytes32[] calldata merkleProof
    ) external {
        Distribution memory distribution = distributions[distributionId];
        require(!distribution.cancelled, "distribution cancelled");
        require(!claimed[distributionId][msg.sender], "already claimed");

        bytes32 leaf = keccak256(abi.encode(msg.sender, assetAmount, payoutAmount));
        require(MerkleProof.verify(merkleProof, distribution.merkleRoot, leaf), "invalid proof");

        claimed[distributionId][msg.sender] = true;
        distributions[distributionId].claimedAmount += uint128(payoutAmount);
        _pay(distribution.payoutToken, msg.sender, payoutAmount);

        emit DistributionClaimed(distributionId, msg.sender, payoutAmount);
    }

    function cancelDistribution(uint256 distributionId, address treasury) external onlyRole(ISSUER_ROLE) {
        Distribution storage distribution = distributions[distributionId];
        require(!distribution.cancelled, "distribution cancelled");
        distribution.cancelled = true;

        uint256 refundableAmount = uint256(distribution.totalAmount) - uint256(distribution.claimedAmount);
        if (refundableAmount > 0) {
            _pay(distribution.payoutToken, treasury, refundableAmount);
        }

        emit DistributionCancelled(distributionId);
    }

    function getDistribution(uint256 distributionId) external view returns (Distribution memory) {
        return distributions[distributionId];
    }

    receive() external payable {
        emit NativeFundsReceived(msg.sender, msg.value);
    }

    function _pay(address payoutToken, address recipient, uint256 amount) internal {
        if (payoutToken == NATIVE_TOKEN) {
            (bool success, ) = payable(recipient).call{value: amount}("");
            require(success, "native transfer failed");
        } else {
            IERC20(payoutToken).safeTransfer(recipient, amount);
        }
    }
}
