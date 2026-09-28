/**
 * Create the test dollar the demo pays coupons in: a classic SPL token with 6
 * decimals, like USDC, whose mint authority is a faucet key of its own.
 *
 *   RPC_URL=<devnet rpc> npx ts-node scripts/test-usdc.ts
 *
 * The deployer only pays the rent. The faucet key is what the website holds
 * (as FAUCET_SECRET) to hand out test dollars: it controls this worthless
 * token and nothing else, never the program's upgrade authority.
 * Run again, it reuses the faucet key and mint it already made.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";

const RPC = process.env.RPC_URL;
if (!RPC) throw new Error("RPC_URL is required");
const dir = join(homedir(), "assetflow-target", "deploy");
const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

async function main() {
  const connection = new Connection(RPC!, "confirmed");
  const payer = load(process.env.PAYER ?? join(homedir(), ".config", "solana", "id.json"));
  const faucetPath = join(dir, "test-usdc-faucet.json");
  const mintPath = join(dir, "test-usdc-mint.txt");
  if (!existsSync(faucetPath)) writeFileSync(faucetPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  const faucet = load(faucetPath);

  if (existsSync(mintPath)) {
    console.log(`test USDC mint (existing): ${readFileSync(mintPath, "utf8").trim()}`);
  } else {
    const mint = await createMint(connection, payer, faucet.publicKey, null, 6, undefined, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    writeFileSync(mintPath, mint.toBase58());
    console.log(`test USDC mint: ${mint.toBase58()}`);
  }
  console.log(`faucet key: ${faucet.publicKey.toBase58()} (secret in ${faucetPath})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
