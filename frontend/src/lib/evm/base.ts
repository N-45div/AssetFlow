/**
 * AssetFlow on Base: the chain, the shared contracts (evm/deployments), and
 * the Ethereum Attestation Service predeploy the registries read KYC from.
 */
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

export const BASE_CHAIN = baseSepolia;
export const BASE_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://sepolia.base.org";
export const BASE_EXPLORER = "https://base-sepolia.blockscout.com";

export const BASE = {
  directory: "0x1C1867cC4899157B8c6fb2D1d351985f73fe125e" as Address,
  testUsd: "0x9E0bDFa145cdF651A4Fee85E83E26E3e94aB5e2d" as Address,
  eas: "0x4200000000000000000000000000000000000021" as Address,
  /** uint16 jurisdiction, uint8 tier, bool accredited */
  investorSchema: "0xc4f99bbaebea35d982f583b35f80da7ea6871d64fadb9dd220f45f578db20384" as Hex,
  /** The demo KYC provider's attester address (its key signs on the server). */
  kycAttester: (process.env.NEXT_PUBLIC_BASE_KYC_ATTESTER ?? "") as Address,
};

/** The EIP-712 domain of Base Sepolia's EAS predeploy (version 1.2.0). */
export const EAS_DOMAIN = { name: "EAS", version: "1.2.0", chainId: BASE_CHAIN.id, verifyingContract: BASE.eas } as const;

export const easAbi = parseAbi([
  "struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }",
  "struct AttestationRequestData { address recipient; uint64 expirationTime; bool revocable; bytes32 refUID; bytes data; uint256 value; }",
  "struct Signature { uint8 v; bytes32 r; bytes32 s; }",
  "struct DelegatedAttestationRequest { bytes32 schema; AttestationRequestData data; Signature signature; address attester; uint64 deadline; }",
  "struct RevocationRequestData { bytes32 uid; uint256 value; }",
  "struct DelegatedRevocationRequest { bytes32 schema; RevocationRequestData data; Signature signature; address revoker; uint64 deadline; }",
  "function getAttestation(bytes32 uid) view returns (Attestation)",
  "function getNonce(address account) view returns (uint256)",
  "function attestByDelegation(DelegatedAttestationRequest request) payable returns (bytes32)",
  "function revokeByDelegation(DelegatedRevocationRequest request) payable",
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
]);

export const basePublic = createPublicClient({ chain: BASE_CHAIN, transport: http(BASE_RPC_URL) });

export const baseExplorer = {
  address: (a: string) => `${BASE_EXPLORER}/address/${a}`,
  tx: (h: string) => `${BASE_EXPLORER}/tx/${h}`,
};
