/**
 * The demo KYC provider on AssetFlow's EVM chains: signs an Ethereum
 * Attestation Service delegated attestation (or revocation) about the caller's
 * wallet on the chain asked for, which the caller's wallet then submits and
 * pays for. Like /api/kyc on Solana it verifies nobody and attests what the
 * visitor picks. The caller first signs a message with that wallet (smart
 * wallets included), so nobody can attest or revoke for a wallet they do not
 * control. The same provider key attests on every chain.
 */
import { encodeAbiParameters, getAddress, isAddress, parseSignature, zeroHash, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { readAttestation } from "@/lib/evm/assetflow";
import { EVM_CHAINS, INVESTOR_SCHEMA, KYC_ATTESTER, easTypedData, publicClientFor, type EvmChainKey } from "@/lib/evm/chains";
import { easAbi } from "@/lib/evm/eas";
import { kycMessage } from "@/lib/evm/kyc-base";

const YEAR = 365 * 86_400;
const WINDOW = 10 * 60;

export async function POST(request: Request) {
  const key = process.env.BASE_KYC_PROVIDER_KEY as Hex | undefined;
  if (!key || !KYC_ATTESTER) return Response.json({ error: "The demo KYC provider is not configured here." }, { status: 503 });
  const provider = privateKeyToAccount(key);

  let body: {
    chain?: string;
    wallet?: string;
    action?: string;
    jurisdiction?: number;
    tier?: number;
    accredited?: boolean;
    uid?: string;
    proof?: Hex;
    issuedAt?: number;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  const cfg = EVM_CHAINS[(body.chain ?? "base") as EvmChainKey];
  if (!cfg) return Response.json({ error: "Unknown chain." }, { status: 400 });
  if (!body.wallet || !isAddress(body.wallet) || !body.proof || !body.issuedAt) {
    return Response.json({ error: "Send { chain, wallet, action, proof, issuedAt, ... }." }, { status: 400 });
  }
  const pub = publicClientFor(cfg);
  const wallet = getAddress(body.wallet);
  const action = body.action === "revoke" ? "revoke" : "attest";
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - body.issuedAt) > WINDOW) return Response.json({ error: "That signature is too old; try again." }, { status: 400 });
  const signed = await pub
    .verifyMessage({ address: wallet, message: kycMessage(wallet, action, body.issuedAt, cfg.brand), signature: body.proof })
    .catch(() => false);
  if (!signed) return Response.json({ error: "The signature is not from that wallet." }, { status: 401 });

  const typed = easTypedData(cfg);
  const nonce = (await pub.readContract({ address: cfg.eas, abi: easAbi, functionName: "getNonce", args: [provider.address] })) as bigint;
  const deadline = BigInt(now + WINDOW);
  const vrs = (sig: Hex) => {
    const s = parseSignature(sig);
    return { v: Number(s.v ?? BigInt(s.yParity! + 27)), r: s.r, s: s.s };
  };

  if (action === "revoke") {
    const uid = body.uid as Hex | undefined;
    // A freshly made attestation may not be on the node that answers yet: ask a few times.
    let a = uid ? await readAttestation(pub, cfg.eas, uid) : null;
    for (let i = 0; uid && !a && i < 8; i++) {
      await new Promise((r) => setTimeout(r, 750));
      a = await readAttestation(pub, cfg.eas, uid);
    }
    if (!a || a.revoked || a.recipient !== wallet || a.attester !== provider.address) {
      return Response.json({ error: "This wallet has no attestation from the demo provider to revoke." }, { status: 404 });
    }
    const message = { schema: INVESTOR_SCHEMA, uid: a.uid, value: 0n, nonce, deadline };
    const signature = await provider.signTypedData({
      domain: typed.domain,
      types: { Revoke: typed.revoke },
      primaryType: "Revoke",
      message: typed.withSigner ? { revoker: provider.address, ...message } : message,
    });
    return Response.json({
      request: { schema: INVESTOR_SCHEMA, data: { uid: a.uid, value: "0" }, signature: vrs(signature), revoker: provider.address, deadline: deadline.toString() },
    });
  }

  const jurisdiction = Number(body.jurisdiction);
  const tier = Number(body.tier ?? 1);
  if (!JURISDICTIONS.some((j) => j.code === jurisdiction) || ![1, 2, 3].includes(tier)) {
    return Response.json({ error: "Pick a listed jurisdiction and a tier from 1 to 3." }, { status: 400 });
  }
  const data = encodeAbiParameters([{ type: "uint16" }, { type: "uint8" }, { type: "bool" }], [jurisdiction, tier, body.accredited === true]);
  const expirationTime = BigInt(now + YEAR);
  const message = { schema: INVESTOR_SCHEMA, recipient: wallet, expirationTime, revocable: true, refUID: zeroHash, data, value: 0n, nonce, deadline };
  const signature = await provider.signTypedData({
    domain: typed.domain,
    types: { Attest: typed.attest },
    primaryType: "Attest",
    message: typed.withSigner ? { attester: provider.address, ...message } : message,
  });
  return Response.json({
    request: {
      schema: INVESTOR_SCHEMA,
      data: { recipient: wallet as Address, expirationTime: expirationTime.toString(), revocable: true, refUID: zeroHash, data, value: "0" },
      signature: vrs(signature),
      attester: provider.address,
      deadline: deadline.toString(),
    },
  });
}
