/**
 * The demo KYC provider: returns a transaction that creates (or revokes) a
 * Solana Attestation Service attestation about the caller's wallet, signed
 * here by the provider key and left for the caller's wallet to sign as fee
 * payer. It verifies nobody and attests what the visitor picks: it stands in
 * for a real provider, and its key controls this demo credential and nothing
 * else. Only the wallet itself can pay for, and so send, either transaction.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { SasProvider, attestationAddress } from "@/lib/chain/kyc";

const YEAR = 365 * 86_400;

export async function POST(request: Request) {
  const rpc = process.env.SOLANA_RPC_URL;
  const secret = process.env.KYC_PROVIDER_SECRET;
  const credentialKey = process.env.NEXT_PUBLIC_KYC_CREDENTIAL;
  const schemaKey = process.env.NEXT_PUBLIC_KYC_SCHEMA;
  if (!rpc || !secret || !credentialKey || !schemaKey) {
    return Response.json({ error: "The demo KYC provider is not configured here." }, { status: 503 });
  }

  let body: { wallet?: string; action?: string; jurisdiction?: number; tier?: number; accredited?: boolean };
  let wallet: PublicKey;
  try {
    body = await request.json();
    wallet = new PublicKey(body.wallet ?? "");
  } catch {
    return Response.json({ error: "Send { wallet, action, jurisdiction, tier, accredited }." }, { status: 400 });
  }
  const revoke = body.action === "revoke";
  const jurisdiction = Number(body.jurisdiction);
  const tier = Number(body.tier ?? 1);
  if (!revoke && (!JURISDICTIONS.some((j) => j.code === jurisdiction) || ![1, 2, 3].includes(tier))) {
    return Response.json({ error: "Pick a listed jurisdiction and a tier from 1 to 3." }, { status: 400 });
  }

  const provider = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  const credential = new PublicKey(credentialKey);
  const schema = new PublicKey(schemaKey);
  const attestation = attestationAddress(credential, schema, wallet);
  const connection = new Connection(rpc, "confirmed");
  const exists = (await connection.getAccountInfo(attestation)) !== null;
  if (revoke && !exists) return Response.json({ error: "This wallet has no attestation to revoke." }, { status: 404 });
  if (!revoke && exists) return Response.json({ error: "This wallet is already attested. Revoke it first to change it." }, { status: 409 });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const ix = revoke
    ? SasProvider.revoke(wallet, provider.publicKey, credential, attestation)
    : SasProvider.attest(wallet, provider.publicKey, credential, schema, wallet, {
        jurisdiction,
        tier,
        accredited: body.accredited === true,
      }, Math.floor(Date.now() / 1000) + YEAR);
  const tx = new Transaction({ feePayer: wallet, blockhash, lastValidBlockHeight }).add(ix);
  tx.partialSign(provider);
  return Response.json({
    transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    lastValidBlockHeight,
    attestation: attestation.toBase58(),
  });
}
