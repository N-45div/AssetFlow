/**
 * KYC once on Base: finding a wallet's attestation from the demo provider
 * (EAS keeps no on-chain index by recipient) and the message a wallet signs to
 * ask the provider for one.
 */
import { getAddress, type Address, type Hex } from "viem";
import { readAttestation, type EvmAttestation } from "./assetflow";

const GRAPHQL = "https://base-sepolia.easscan.org/graphql";
const REMEMBER = (wallet: string) => `assetflow-base-kyc:${wallet.toLowerCase()}`;

/** What the wallet signs to show it asked; /api/kyc-base rebuilds it to check. */
export function kycMessage(wallet: string, action: "attest" | "revoke", issuedAt: number) {
  return `AssetFlow demo KYC on Base\nAction: ${action}\nWallet: ${getAddress(wallet)}\nIssued: ${issuedAt}`;
}

export function rememberAttestation(wallet: Address, uid: Hex | null) {
  try {
    if (uid) localStorage.setItem(REMEMBER(wallet), uid);
    else localStorage.removeItem(REMEMBER(wallet));
  } catch {
    // storage unavailable: the indexer is asked instead
  }
}

/**
 * The wallet's latest attestation under a schema from an attester: the one
 * this browser remembers, else the newest the EAS indexer knows. Read back
 * from the chain either way; null if there is none that is not revoked.
 */
export async function findAttestation(wallet: Address, schema: Hex, attester: Address): Promise<EvmAttestation | null> {
  const fits = (a: EvmAttestation | null) =>
    a && !a.revoked && a.recipient.toLowerCase() === wallet.toLowerCase() && a.schema === schema && a.attester.toLowerCase() === attester.toLowerCase();
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(REMEMBER(wallet));
  } catch {
    remembered = null;
  }
  if (remembered) {
    // Just made, it may not be on the node that answers yet: ask a few times.
    for (let i = 0; i < 5; i++) {
      const a = await readAttestation(remembered as Hex).catch(() => null);
      if (fits(a)) return a;
      if (a) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "query($where: AttestationWhereInput) { attestations(where: $where, orderBy: [{ time: desc }], take: 3) { id } }",
      variables: {
        where: {
          recipient: { equals: getAddress(wallet) },
          schemaId: { equals: schema },
          attester: { equals: getAddress(attester) },
          revoked: { equals: false },
        },
      },
    }),
  }).catch(() => null);
  const ids: Hex[] = res?.ok ? ((await res.json())?.data?.attestations ?? []).map((a: { id: Hex }) => a.id) : [];
  for (const id of ids) {
    const a = await readAttestation(id).catch(() => null);
    if (fits(a)) {
      rememberAttestation(wallet, id);
      return a;
    }
  }
  return null;
}
