import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { config } from "./config.js";
import {
  complianceRegistryAbi,
  distributionModuleAbi,
  oracleRouterAbi,
  redemptionModuleAbi,
  servicedAssetTokenAbi
} from "./abis.js";

export const staticProvider = new JsonRpcProvider(
  config.HASHKEY_RPC_URL,
  { chainId: config.HASHKEY_CHAIN_ID, name: "hashkey" },
  { staticNetwork: true }
);
const defaultSigner = config.PRIVATE_KEY ? new Wallet(config.PRIVATE_KEY, staticProvider) : null;
const adminPrivateKey = config.ADMIN_PRIVATE_KEY || config.PRIVATE_KEY;
const issuerPrivateKey = config.ISSUER_PRIVATE_KEY || config.PRIVATE_KEY;

export const adminSigner = adminPrivateKey ? new Wallet(adminPrivateKey, staticProvider) : null;
export const issuerSigner = issuerPrivateKey ? new Wallet(issuerPrivateKey, staticProvider) : null;

function signerMatchesAddress(signer, expectedAddress) {
  if (!signer || !expectedAddress) {
    return true;
  }

  return signer.address.toLowerCase() === expectedAddress.toLowerCase();
}

if (!signerMatchesAddress(adminSigner, config.ADMIN_ADDRESS)) {
  throw new Error("ADMIN_PRIVATE_KEY does not match ADMIN_ADDRESS");
}

if (!signerMatchesAddress(issuerSigner, config.ISSUER_ADDRESS)) {
  throw new Error("ISSUER_PRIVATE_KEY does not match ISSUER_ADDRESS");
}

function contractAt(address, abi, signer = null) {
  if (!address) {
    return null;
  }

  return new Contract(address, abi, signer || staticProvider);
}

export const complianceRegistry = contractAt(
  config.COMPLIANCE_REGISTRY_ADDRESS,
  complianceRegistryAbi,
  adminSigner
);

export const distributionModule = contractAt(
  config.DISTRIBUTION_MODULE_ADDRESS,
  distributionModuleAbi,
  issuerSigner
);

export const redemptionModule = contractAt(
  config.REDEMPTION_MODULE_ADDRESS,
  redemptionModuleAbi,
  issuerSigner
);

export const oracleRouter = contractAt(
  config.ORACLE_ROUTER_ADDRESS,
  oracleRouterAbi,
  null
);

export const servicedAssetToken = contractAt(
  config.SERVICED_ASSET_TOKEN_ADDRESS,
  servicedAssetTokenAbi,
  issuerSigner || defaultSigner
);

export function chainStatus() {
  return {
    rpcUrl: config.HASHKEY_RPC_URL,
    chainId: config.HASHKEY_CHAIN_ID,
    hasSigner: Boolean(defaultSigner),
    hasAdminSigner: Boolean(adminSigner),
    hasIssuerSigner: Boolean(issuerSigner),
    adminSignerAddress: adminSigner?.address ?? null,
    issuerSignerAddress: issuerSigner?.address ?? null,
    hasComplianceRegistry: Boolean(complianceRegistry),
    hasDistributionModule: Boolean(distributionModule),
    hasRedemptionModule: Boolean(redemptionModule),
    hasServicedAssetToken: Boolean(servicedAssetToken),
    hasOracleRouter: Boolean(oracleRouter)
  };
}
