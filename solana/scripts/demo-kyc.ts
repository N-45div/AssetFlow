/**
 * Create the demo KYC provider on devnet: a Solana Attestation Service
 * credential, "AssetFlow Demo KYC", and its investor schema (jurisdiction,
 * tier, accredited), both controlled by a provider key of their own.
 *
 *   RPC_URL=<devnet rpc> npx ts-node scripts/demo-kyc.ts
 *
 * The website holds that key (as KYC_PROVIDER_SECRET) to attest whatever a
 * visitor picks: it stands in for a real provider, verifies nobody, and
 * controls this demo credential and nothing else. The deployer only pays the
 * rent. Run again, it reuses the key and whatever it already created.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { Sas, send } from "../client";

export const DEMO_CREDENTIAL_NAME = "AssetFlow Demo KYC";
export const INVESTOR_SCHEMA_NAME = "AssetFlow investor";

const RPC = process.env.RPC_URL;
if (!RPC) throw new Error("RPC_URL is required");
const dir = join(homedir(), "assetflow-target", "deploy");
const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

async function main() {
  const connection = new Connection(RPC!, "confirmed");
  const payer = load(process.env.PAYER ?? join(homedir(), ".config", "solana", "id.json"));
  const keyPath = join(dir, "kyc-provider.json");
  if (!existsSync(keyPath)) writeFileSync(keyPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  const provider = load(keyPath);

  const credential = Sas.credential(provider.publicKey, DEMO_CREDENTIAL_NAME);
  const schema = Sas.schema(credential, INVESTOR_SCHEMA_NAME);
  const ixs = [];
  if (!(await connection.getAccountInfo(credential))) {
    ixs.push(Sas.createCredential(payer.publicKey, provider.publicKey, DEMO_CREDENTIAL_NAME, [provider.publicKey]));
  }
  if (!(await connection.getAccountInfo(schema))) {
    ixs.push(
      Sas.createSchema(
        payer.publicKey,
        provider.publicKey,
        credential,
        INVESTOR_SCHEMA_NAME,
        "An investor's KYC result: ISO 3166-1 numeric jurisdiction, investor tier, accredited status",
        [1, 0, 10],
        ["jurisdiction", "tier", "accredited"],
      ),
    );
  }
  if (ixs.length) console.log(`created: ${await send(connection, ixs, [payer, provider])}`);
  console.log(`provider key: ${provider.publicKey.toBase58()} (secret in ${keyPath})`);
  console.log(`credential:   ${credential.toBase58()}`);
  console.log(`schema:       ${schema.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
