/**
 * The demo KYC provider on Base: signs an Ethereum Attestation Service
 * delegated attestation (or revocation) about the caller's wallet, which the
 * caller's wallet then submits and pays for. Like /api/kyc on Solana it
 * verifies nobody and attests what the visitor picks. The caller first signs a
 * message with that wallet (smart wallets included), so nobody can attest or
 * revoke for a wallet they do not control.
 */
import { encodeAbiParameters, getAddress, isAddress, parseSignature, zeroHash, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { readAttestation } from "@/lib/evm/assetflow";
import { BASE, EAS_DOMAIN, basePublic, easAbi } from "@/lib/evm/base";
import { kycMessage } from "@/lib/evm/kyc-base";

const YEAR = 365 * 86_400;
const WINDOW = 10 * 60;

export async function POST(request: Request) {
  const key = process.env.BASE_KYC_PROVIDER_KEY as Hex | undefined;
  if (!key || !BASE.kycAttester) return Response.json({ error: "The demo KYC provider is not configured here." }, { status: 503 });
  const provider = privateKeyToAccount(key);

  let body: { wallet?: string; action?: string; jurisdiction?: number; tier?: number; accredited?: boolean; uid?: string; proof?: Hex; issuedAt?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  if (!body.wallet || !isAddress(body.wallet) || !body.proof || !body.issuedAt) {
    return Response.json({ error: "Send { wallet, action, proof, issuedAt, ... }." }, { status: 400 });
  }
  const wallet = getAddress(body.wallet);
  const action = body.action === "revoke" ? "revoke" : "attest";
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - body.issuedAt) > WINDOW) return Response.json({ error: "That signature is too old; try again." }, { status: 400 });
  const signed = await basePublic
    .verifyMessage({ address: wallet, message: kycMessage(wallet, action, body.issuedAt), signature: body.proof })
    .catch(() => false);
  if (!signed) return Response.json({ error: "The signature is not from that wallet." }, { status: 401 });

  const nonce = (await basePublic.readContract({ address: BASE.eas, abi: easAbi, functionName: "getNonce", args: [provider.address] })) as bigint;
  const deadline = BigInt(now + WINDOW);

  if (action === "revoke") {
    const uid = body.uid as Hex | undefined;
    // A freshly made attestation may not be on the node that answers yet: ask a few times.
    let a = uid ? await readAttestation(uid) : null;
    for (let i = 0; uid && !a && i < 8; i++) {
      await new Promise((r) => setTimeout(r, 750));
      a = await readAttestation(uid);
    }
    if (!a || a.revoked || a.recipient !== wallet || a.attester !== provider.address) {
      return Response.json({ error: "This wallet has no attestation from the demo provider to revoke." }, { status: 404 });
    }
    const signature = parseSignature(
      await provider.signTypedData({
        domain: EAS_DOMAIN,
        types: {
          Revoke: [
            { name: "schema", type: "bytes32" },
            { name: "uid", type: "bytes32" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint64" },
          ],
        },
        primaryType: "Revoke",
        message: { schema: BASE.investorSchema, uid: a.uid, value: 0n, nonce, deadline },
      }),
    );
    return Response.json({
      request: {
        schema: BASE.investorSchema,
        data: { uid: a.uid, value: "0" },
        signature: { v: Number(signature.v ?? BigInt(signature.yParity! + 27)), r: signature.r, s: signature.s },
        revoker: provider.address,
        deadline: deadline.toString(),
      },
    });
  }

  const jurisdiction = Number(body.jurisdiction);
  const tier = Number(body.tier ?? 1);
  if (!JURISDICTIONS.some((j) => j.code === jurisdiction) || ![1, 2, 3].includes(tier)) {
    return Response.json({ error: "Pick a listed jurisdiction and a tier from 1 to 3." }, { status: 400 });
  }
  const data = encodeAbiParameters(
    [{ type: "uint16" }, { type: "uint8" }, { type: "bool" }],
    [jurisdiction, tier, body.accredited === true],
  );
  const expirationTime = BigInt(now + YEAR);
  const signature = parseSignature(
    await provider.signTypedData({
      domain: EAS_DOMAIN,
      types: {
        Attest: [
          { name: "schema", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocable", type: "bool" },
          { name: "refUID", type: "bytes32" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      },
      primaryType: "Attest",
      message: { schema: BASE.investorSchema, recipient: wallet, expirationTime, revocable: true, refUID: zeroHash, data, value: 0n, nonce, deadline },
    }),
  );
  return Response.json({
    request: {
      schema: BASE.investorSchema,
      data: { recipient: wallet as Address, expirationTime: expirationTime.toString(), revocable: true, refUID: zeroHash, data, value: "0" },
      signature: { v: Number(signature.v ?? BigInt(signature.yParity! + 27)), r: signature.r, s: signature.s },
      attester: provider.address,
      deadline: deadline.toString(),
    },
  });
}
