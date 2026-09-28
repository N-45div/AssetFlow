/**
 * Test dollars for the demo: a transaction that mints 1,000 test USDC to the
 * caller, signed here by the faucet key and left for the caller's wallet to
 * sign as fee payer. The faucet key controls that test token and nothing else.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const AMOUNT = 1_000n * 1_000_000n; // 1,000 test USDC at 6 decimals

export async function POST(request: Request) {
  const rpc = process.env.SOLANA_RPC_URL;
  const secret = process.env.FAUCET_SECRET;
  const mintAddress = process.env.NEXT_PUBLIC_CURRENCY_MINT;
  if (!rpc || !secret || !mintAddress) {
    return Response.json({ error: "The test-USDC faucet is not configured here." }, { status: 503 });
  }
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(((await request.json()) as { wallet?: string }).wallet ?? "");
  } catch {
    return Response.json({ error: "Send the wallet address as { wallet }." }, { status: 400 });
  }

  const faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  const mint = new PublicKey(mintAddress);
  const destination = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_PROGRAM_ID);
  const connection = new Connection(rpc, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, mint, TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, destination, faucet.publicKey, AMOUNT, [], TOKEN_PROGRAM_ID),
  );
  tx.partialSign(faucet);
  return Response.json({
    transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    lastValidBlockHeight,
  });
}
