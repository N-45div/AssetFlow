export const complianceRegistryAbi = [
  "function getInvestorProfile(address account) view returns ((bool approved,bool accredited,bool frozen,uint8 tier,uint32 jurisdiction,uint64 expiry))",
  "function isWalletEligible(address account) view returns (bool)",
  "function setInvestorProfile(address account,bool approved,bool accredited,bool frozen,uint8 tier,uint32 jurisdiction,uint64 expiry)",
  "function setAllowedJurisdiction(uint32 jurisdiction,bool allowed)",
  "function setExemptCounterparty(address account,bool allowed)"
];

export const distributionModuleAbi = [
  "function createDistribution(address payoutToken,bytes32 merkleRoot,uint128 totalAmount,uint64 snapshotTimestamp,string metadataURI) payable returns (uint256)",
  "function claim(uint256 distributionId,uint256 assetAmount,uint256 payoutAmount,bytes32[] merkleProof)",
  "function getDistribution(uint256 distributionId) view returns ((address payoutToken,bytes32 merkleRoot,uint128 totalAmount,uint128 claimedAmount,uint64 snapshotTimestamp,string metadataURI,bool cancelled))",
  "function nextDistributionId() view returns (uint256)",
  "function claimed(uint256 distributionId,address account) view returns (bool)",
  "event DistributionCreated(uint256 indexed distributionId,address indexed payoutToken,bytes32 merkleRoot,uint128 totalAmount,uint64 snapshotTimestamp,string metadataURI)"
];

export const redemptionModuleAbi = [
  "function requestRedemption(uint128 assetAmount,uint128 payoutAmount,string memo) returns (uint256)",
  "function approveRequest(uint256 requestId)",
  "function rejectRequest(uint256 requestId,string reason)",
  "function settleRequest(uint256 requestId)",
  "function getRequest(uint256 requestId) view returns ((address investor,uint128 assetAmount,uint128 payoutAmount,uint64 requestedAt,uint64 updatedAt,uint8 status,string memo))"
];

export const oracleRouterAbi = [
  "function getRedemptionQuote(address asset,uint256 assetAmount,uint16 feeBps,uint16 haircutBps) view returns ((uint256 grossUsdValue18,uint256 netUsdValue18,int256 answer,uint8 feedDecimals,uint256 updatedAt))"
];

export const servicedAssetTokenAbi = [
  "function mint(address to,uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)"
];
