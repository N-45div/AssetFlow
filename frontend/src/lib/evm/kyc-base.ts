/**
 * KYC once on AssetFlow's EVM chains: finding a wallet's attestation from the
 * demo provider (EAS keeps no on-chain index by recipient) and the message a
 * wallet signs to ask the provider for one.
 */
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { readAttestation, type EvmAttestation } from "./assetflow";
import type { EvmChainConfig } from "./chains";
import { easAbi } from "./eas";

const REMEMBER = (chain: string, wallet: string) => `assetflow-${chain}-kyc:${wallet.toLowerCase()}`;
const LOG_WINDOW = 50_000n;
const LOG_WINDOWS = 20;

/** What the wallet signs to show it asked; /api/kyc-base rebuilds it to check. */
export function kycMessage(wallet: string, action: "attest" | "revoke", issuedAt: number, network = "Base") {
  return `AssetFlow demo KYC on ${network}\nAction: ${action}\nWallet: ${getAddress(wallet)}\nIssued: ${issuedAt}`;
}

export function rememberAttestation(cfg: EvmChainConfig, wallet: Address, uid: Hex | null) {
  try {
    if (uid) localStorage.setItem(REMEMBER(cfg.key, wallet), uid);
    else localStorage.removeItem(REMEMBER(cfg.key, wallet));
  } catch {
    // storage unavailable: the indexer or the logs are asked instead
  }
}

/** Attestation UIDs for a recipient from an attester, newest first: from the EAS indexer, else from the logs. */
async function candidates(pub: PublicClient, cfg: EvmChainConfig, wallet: Address, schema: Hex, attester: Address): Promise<Hex[]> {
  if (cfg.easscan) {
    const res = await fetch(`${cfg.easscan}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query($where: AttestationWhereInput) { attestations(where: $where, orderBy: [{ time: desc }], take: 3) { id } }",
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
    return res?.ok ? ((await res.json())?.data?.attestations ?? []).map((a: { id: Hex }) => a.id) : [];
  }
  // No indexer: walk back through recent blocks, a window at a time.
  const head = await pub.getBlockNumber();
  for (let i = 0, to = head; i < LOG_WINDOWS && to >= cfg.easFromBlock; i++, to -= LOG_WINDOW) {
    const from = to - LOG_WINDOW + 1n > cfg.easFromBlock ? to - LOG_WINDOW + 1n : cfg.easFromBlock;
    const logs = await pub
      .getContractEvents({
        address: cfg.eas,
        abi: easAbi,
        eventName: "Attested",
        args: { recipient: wallet, attester, schemaUID: schema },
        fromBlock: from,
        toBlock: to,
      })
      .catch(() => []);
    if (logs.length) return logs.map((l) => l.args.uid as Hex).reverse();
  }
  return [];
}

/**
 * The wallet's latest attestation under a schema from an attester: the one
 * this browser remembers, else the newest the indexer or the logs know. Read
 * back from the chain either way; null if there is none that is not revoked.
 */
export async function findAttestation(
  pub: PublicClient,
  cfg: EvmChainConfig,
  wallet: Address,
  schema: Hex,
  attester: Address,
): Promise<EvmAttestation | null> {
  const fits = (a: EvmAttestation | null) =>
    a && !a.revoked && a.recipient.toLowerCase() === wallet.toLowerCase() && a.schema === schema && a.attester.toLowerCase() === attester.toLowerCase();
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(REMEMBER(cfg.key, wallet));
  } catch {
    remembered = null;
  }
  if (remembered) {
    // Just made, it may not be on the node that answers yet: ask a few times.
    for (let i = 0; i < 5; i++) {
      const a = await readAttestation(pub, cfg.eas, remembered as Hex).catch(() => null);
      if (fits(a)) return a;
      if (a) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  for (const id of await candidates(pub, cfg, wallet, schema, attester)) {
    const a = await readAttestation(pub, cfg.eas, id).catch(() => null);
    if (fits(a)) {
      rememberAttestation(cfg, wallet, id);
      return a;
    }
  }
  return null;
}
