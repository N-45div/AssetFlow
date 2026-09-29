/** The parts of the Ethereum Attestation Service AssetFlow uses; the same across versions 1.0 to 1.4. */
import { parseAbi } from "viem";

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
