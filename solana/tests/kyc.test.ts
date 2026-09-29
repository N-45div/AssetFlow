/**
 * KYC once, end to end on a local validator with the real Solana Attestation
 * Service: a provider attests an investor, a registry trusts the provider,
 * the investor onboards themselves by presenting the attestation, and the
 * provider's revocation lets anyone withdraw the approval and freeze them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AssetFlow,
  Sas,
  TokenAcl,
  createServicedMint,
  investorAttestationData,
  send,
} from "../client";

const HONG_KONG = 344;
const SINGAPORE = 702;
const UNITED_STATES = 840;

const programId = new PublicKey(
  /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(
    readFileSync(join(__dirname, "../programs/assetflow/src/lib.rs"), "utf8"),
  )![1],
);
const af = new AssetFlow(programId);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

const issuer = Keypair.generate();
const provider = Keypair.generate(); // a KYC provider, with its own SAS credential
const rival = Keypair.generate(); // another provider the registry does not trust
const alice = Keypair.generate(); // attested in Hong Kong
const bob = Keypair.generate(); // attested in Singapore
const dave = Keypair.generate(); // attested in the United States, a jurisdiction the registry does not allow
const erin = Keypair.generate(); // attested with an expiry seconds away
const stranger = Keypair.generate();
const mintKey = Keypair.generate();
const mint = mintKey.publicKey;
const registry = af.registry(issuer.publicKey);

const credential = Sas.credential(provider.publicKey, "Demo KYC");
const schema = Sas.schema(credential, "AssetFlow investor");
const rivalCredential = Sas.credential(rival.publicKey, "Rival KYC");
const rivalSchema = Sas.schema(rivalCredential, "AssetFlow investor");
const attestation = (who: Keypair, c = credential, s = schema) => Sas.attestation(c, s, who.publicKey);

const chainNow = async () => (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? 0;
const assetAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

// InvestorProfile: discriminator, registry, wallet, approved, accredited, frozen, tier, jurisdiction, expiry
async function profile(wallet: PublicKey) {
  const d = (await connection.getAccountInfo(af.investor(registry, wallet)))!.data;
  const at = 8 + 32 + 32;
  return {
    approved: d[at] === 1,
    accredited: d[at + 1] === 1,
    frozen: d[at + 2] === 1,
    tier: d[at + 3],
    jurisdiction: d.readUInt16LE(at + 4),
    expiry: Number(d.readBigInt64LE(at + 6)),
  };
}

async function refused(attempt: Promise<unknown>, reason: RegExp) {
  try {
    await attempt;
  } catch (e: any) {
    const text = [e?.message ?? String(e), ...(e?.logs ?? e?.transactionLogs ?? [])].join("\n");
    assert.match(text, reason, `refused, but not for ${reason}:\n${text}`);
    return;
  }
  assert.fail(`expected a refusal matching ${reason}`);
}

const attest = async (who: Keypair, jurisdiction: number, expiry = 0, by = provider, c = credential, s = schema) =>
  send(
    connection,
    [Sas.createAttestation(by.publicKey, by.publicKey, c, s, who.publicKey, investorAttestationData(jurisdiction, 1, false), expiry)],
    [by],
  );
const claim = (who: Keypair, att = attestation(who), payer = who) =>
  send(connection, [af.claimProfile(payer.publicKey, registry, att, who.publicKey)], [payer]);
const thaw = (who: Keypair) =>
  send(
    connection,
    [
      createAssociatedTokenAccountIdempotentInstruction(who.publicKey, assetAccount(who.publicKey), who.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      TokenAcl.permissionless("thaw", who.publicKey, mint, assetAccount(who.publicKey), who.publicKey, programId, af.gateAccounts("thaw", mint, registry, who.publicKey)),
    ],
    [who],
  );

describe("KYC once, through the Solana Attestation Service", () => {
  before(async () => {
    for (const k of [issuer, provider, rival, alice, bob, dave, erin, stranger]) {
      const sig = await connection.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
    // Two providers, each with a credential and an investor schema; one also
    // publishes a schema that does not carry the investor fields.
    const fields = ["jurisdiction", "tier", "accredited"];
    await send(
      connection,
      [
        Sas.createCredential(provider.publicKey, provider.publicKey, "Demo KYC", [provider.publicKey]),
        Sas.createSchema(provider.publicKey, provider.publicKey, credential, "AssetFlow investor", "KYC result", [1, 0, 10], fields),
        Sas.createSchema(provider.publicKey, provider.publicKey, credential, "Name only", "Just a name", [12], ["name"]),
      ],
      [provider],
    );
    await send(
      connection,
      [
        Sas.createCredential(rival.publicKey, rival.publicKey, "Rival KYC", [rival.publicKey]),
        Sas.createSchema(rival.publicKey, rival.publicKey, rivalCredential, "AssetFlow investor", "KYC result", [1, 0, 10], fields),
      ],
      [rival],
    );
    await attest(alice, HONG_KONG);
    await attest(bob, SINGAPORE, 0, rival, rivalCredential, rivalSchema); // bob's only attestation is the rival's
    await attest(dave, UNITED_STATES);

    await send(
      connection,
      [
        af.createRegistry(issuer.publicKey, 1, false),
        af.setJurisdiction(issuer.publicKey, registry, HONG_KONG, true),
        af.setJurisdiction(issuer.publicKey, registry, SINGAPORE, true),
      ],
      [issuer],
    );
    await send(
      connection,
      [...(await createServicedMint(connection, issuer.publicKey, mint, af.asset(mint), 0)), af.registerAsset(issuer.publicKey, issuer.publicKey, registry, mint)],
      [issuer, mintKey],
    );
  });

  it("takes no claim until the registry names a source", async () => {
    await refused(claim(alice), /AccountNotInitialized|KycSourceNotSet/);
  });

  it("lets only compliance name the source, and only a schema with the investor fields", async () => {
    await refused(send(connection, [af.setKycSource(stranger.publicKey, registry, credential, schema)], [stranger]), /Unauthorized/);
    await refused(
      send(connection, [af.setKycSource(issuer.publicKey, registry, credential, Sas.schema(credential, "Name only"))], [issuer]),
      /WrongSchemaLayout/,
    );
    await refused(
      send(connection, [af.setKycSource(issuer.publicKey, registry, credential, rivalSchema)], [issuer]),
      /AttestationMismatch/,
    );
    await send(connection, [af.setKycSource(issuer.publicKey, registry, credential, schema)], [issuer]);
  });

  it("lets an attested investor onboard themselves, and the gate then admits them", async () => {
    await claim(alice);
    const p = await profile(alice.publicKey);
    assert.deepEqual(
      { approved: p.approved, frozen: p.frozen, tier: p.tier, jurisdiction: p.jurisdiction },
      { approved: true, frozen: false, tier: 1, jurisdiction: HONG_KONG },
    );
    assert.equal(p.expiry, Date.UTC(9999, 11, 31, 23, 59, 59) / 1000, "an attestation that never expires");
    await thaw(alice);
    await send(connection, [af.issue(issuer.publicKey, registry, mint, assetAccount(alice.publicKey), alice.publicKey, 100n)], [issuer]);
    assert.equal((await getAccount(connection, assetAccount(alice.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 100n);
  });

  it("refuses someone else's attestation, and an untrusted provider's", async () => {
    await refused(claim(bob, attestation(alice)), /AttestationMismatch/);
    await refused(claim(bob, attestation(bob, rivalCredential, rivalSchema)), /AttestationMismatch/);
  });

  it("still applies the registry's own policy to an attested investor", async () => {
    await claim(dave, attestation(dave), stranger); // anyone may send the claim
    assert.equal((await profile(dave.publicKey)).jurisdiction, UNITED_STATES);
    await refused(thaw(dave), /NotEligible/);
  });

  it("refuses an attestation that has expired", async () => {
    const expiry = (await chainNow()) + 4;
    await attest(erin, HONG_KONG, expiry);
    while ((await chainNow()) <= expiry) await new Promise((r) => setTimeout(r, 1_000));
    await refused(claim(erin), /AttestationExpired/);
  });

  it("never lifts a compliance hold", async () => {
    const held = { ...(await profile(alice.publicKey)), frozen: true, expiry: (await chainNow()) + 86_400 };
    await send(connection, [af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, held)], [issuer]);
    await claim(alice);
    assert.equal((await profile(alice.publicKey)).frozen, true);
    await send(connection, [af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, { ...held, frozen: false })], [issuer]);
  });

  it("keeps the approval while the attestation stands; once revoked, anyone can lapse it and freeze the holder", async () => {
    await refused(send(connection, [af.lapseProfile(registry, alice.publicKey, attestation(alice))], [stranger]), /StillAttested/);
    await send(connection, [Sas.closeAttestation(provider.publicKey, provider.publicKey, credential, attestation(alice))], [provider]);
    await send(connection, [af.lapseProfile(registry, alice.publicKey, attestation(alice))], [stranger]);
    assert.equal((await profile(alice.publicKey)).approved, false);
    await send(
      connection,
      [TokenAcl.permissionless("freeze", stranger.publicKey, mint, assetAccount(alice.publicKey), alice.publicKey, programId, af.gateAccounts("freeze", mint, registry, alice.publicKey))],
      [stranger],
    );
    assert.ok((await getAccount(connection, assetAccount(alice.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen);
  });

  it("lapses every profile from a provider the registry stops trusting", async () => {
    await refused(send(connection, [af.lapseProfile(registry, dave.publicKey, attestation(dave))], [stranger]), /StillAttested/);
    await send(connection, [af.setKycSource(issuer.publicKey, registry, rivalCredential, rivalSchema)], [issuer]);
    await send(connection, [af.lapseProfile(registry, dave.publicKey, attestation(dave))], [stranger]);
    assert.equal((await profile(dave.publicKey)).approved, false);
    // and the new provider's investors can come in
    await claim(bob, attestation(bob, rivalCredential, rivalSchema));
    assert.equal((await profile(bob.publicKey)).approved, true);
  });
});
