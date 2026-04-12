// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ServicedAssetToken} from "./ServicedAssetToken.sol";

contract RedemptionModule is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    address public constant NATIVE_TOKEN = address(0);

    enum RedemptionStatus {
        None,
        Requested,
        Approved,
        Rejected,
        Cancelled,
        Settled
    }

    struct RedemptionRequest {
        address investor;
        uint128 assetAmount;
        uint128 payoutAmount;
        uint64 requestedAt;
        uint64 updatedAt;
        RedemptionStatus status;
        string memo;
    }

    ServicedAssetToken public immutable assetToken;
    address public immutable settlementToken;
    uint256 public nextRequestId;

    mapping(uint256 => RedemptionRequest) private requests;

    event RedemptionRequested(
        uint256 indexed requestId,
        address indexed investor,
        uint256 assetAmount,
        uint256 payoutAmount,
        string memo
    );
    event RedemptionApproved(uint256 indexed requestId);
    event RedemptionRejected(uint256 indexed requestId, string reason);
    event RedemptionCancelled(uint256 indexed requestId);
    event RedemptionSettled(uint256 indexed requestId, address indexed investor, uint256 payoutAmount);
    event NativeFundsReceived(address indexed sender, uint256 amount);

    constructor(address admin, address issuer, address assetToken_, address settlementToken_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, issuer);
        assetToken = ServicedAssetToken(assetToken_);
        settlementToken = settlementToken_;
    }

    function requestRedemption(
        uint128 assetAmount,
        uint128 payoutAmount,
        string calldata memo
    ) external returns (uint256 requestId) {
        require(assetAmount > 0, "asset amount required");
        require(payoutAmount > 0, "payout amount required");

        requestId = nextRequestId++;
        requests[requestId] = RedemptionRequest({
            investor: msg.sender,
            assetAmount: assetAmount,
            payoutAmount: payoutAmount,
            requestedAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            status: RedemptionStatus.Requested,
            memo: memo
        });

        assetToken.transferFrom(msg.sender, address(this), assetAmount);

        emit RedemptionRequested(requestId, msg.sender, assetAmount, payoutAmount, memo);
    }

    function approveRequest(uint256 requestId) external onlyRole(ISSUER_ROLE) {
        RedemptionRequest storage request = requests[requestId];
        require(request.status == RedemptionStatus.Requested, "not requested");
        request.status = RedemptionStatus.Approved;
        request.updatedAt = uint64(block.timestamp);

        emit RedemptionApproved(requestId);
    }

    function rejectRequest(uint256 requestId, string calldata reason) external onlyRole(ISSUER_ROLE) {
        RedemptionRequest storage request = requests[requestId];
        require(
            request.status == RedemptionStatus.Requested || request.status == RedemptionStatus.Approved,
            "not active"
        );

        request.status = RedemptionStatus.Rejected;
        request.updatedAt = uint64(block.timestamp);
        assetToken.servicingTransfer(address(this), request.investor, request.assetAmount);

        emit RedemptionRejected(requestId, reason);
    }

    function cancelRequest(uint256 requestId) external {
        RedemptionRequest storage request = requests[requestId];
        require(request.investor == msg.sender, "not investor");
        require(request.status == RedemptionStatus.Requested, "not cancellable");

        request.status = RedemptionStatus.Cancelled;
        request.updatedAt = uint64(block.timestamp);
        assetToken.servicingTransfer(address(this), request.investor, request.assetAmount);

        emit RedemptionCancelled(requestId);
    }

    function settleRequest(uint256 requestId) external onlyRole(ISSUER_ROLE) {
        RedemptionRequest storage request = requests[requestId];
        require(request.status == RedemptionStatus.Approved, "not approved");

        request.status = RedemptionStatus.Settled;
        request.updatedAt = uint64(block.timestamp);

        assetToken.burnFrom(address(this), request.assetAmount);
        _pay(request.investor, request.payoutAmount);

        emit RedemptionSettled(requestId, request.investor, request.payoutAmount);
    }

    function getRequest(uint256 requestId) external view returns (RedemptionRequest memory) {
        return requests[requestId];
    }

    receive() external payable {
        emit NativeFundsReceived(msg.sender, msg.value);
    }

    function _pay(address recipient, uint256 amount) internal {
        if (settlementToken == NATIVE_TOKEN) {
            (bool success, ) = payable(recipient).call{value: amount}("");
            require(success, "native transfer failed");
        } else {
            IERC20(settlementToken).safeTransfer(recipient, amount);
        }
    }
}
