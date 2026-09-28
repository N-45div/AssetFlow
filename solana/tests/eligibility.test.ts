/**
 * Eligibility, end to end, against a local validator running AssetFlow and the
 * real Token ACL binary (see validator.sh).
 *
 * What is being proved: nothing in a plain transfer calls AssetFlow, yet only
 * eligible wallets can hold the asset, because every holder account starts
 * frozen and only the gate can let Token ACL thaw it. And a lapsed approval
 * is enforceable by anyone, because the gate says yes to freezing exactly
 * the wallets it would no longer thaw.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AssetFlow, ProfileTerms, TokenAcl, createServicedMint, send } from "../client";

const DECIMALS = 6;
const INDIA = 356;
const SINGAPORE = 702;
const UNITED_STATES = 840; // never allowed in this registry

const programId = new PublicKey(
  /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(
    readFileSync(join(__dirname, "../programs/assetflow/src/lib.rs"), "utf8"),
  )![1],
);
const af = new AssetFlow(programId);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

const issuer = Keypair.generate();
const alice = Keypair.generate(); // India, approved
const bob = Keypair.generate(); // Singapore, approved
const mallory = Keypair.generate(); // approved, but from a jurisdiction the registry refuses
const eve = Keypair.generate(); // no profile at all
const stranger = Keypair.generate(); // anyone: pays for permissionless freezes
const mintKey = Keypair.generate();
const mint = mintKey.publicKey;
const registry = af.registry(issuer.publicKey);

const now = () => Math.floor(Date.now() / 1000);
const approved = (jurisdiction: number, expiry = now() + 3600): ProfileTerms => ({
  approved: true,
  accredited: false,
  frozen: false,
  tier: 1,
  jurisdiction,
  expiry,
});
const ata = (owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

async function isFrozen(owner: PublicKey) {
  return (await getAccount(connection, ata(owner), "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen;
}

async function balance(owner: PublicKey) {
  return (await getAccount(connection, ata(owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
}

/** Fails the test unless the transaction is refused for the named reason. */
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

function openAccount(owner: Keypair) {
  return send(
    connection,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        ata(owner.publicKey),
        owner.publicKey,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [owner],
  );
}

function permissionless(question: "thaw" | "freeze", caller: Keypair, owner: PublicKey) {
  return send(
    connection,
    [
      TokenAcl.permissionless(
        question,
        caller.publicKey,
        mint,
        ata(owner),
        owner,
        programId,
        af.gateAccounts(question, mint, registry, owner),
      ),
    ],
    [caller],
  );
}

function transfer(from: Keypair, to: PublicKey, amount: bigint) {
  return send(
    connection,
    [
      createTransferCheckedInstruction(
        ata(from.publicKey),
        mint,
        ata(to),
        from.publicKey,
        amount,
        DECIMALS,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [from],
  );
}

describe("eligibility through Token ACL", () => {
  before(async () => {
    for (const k of [issuer, alice, bob, mallory, eve, stranger]) {
      const sig = await connection.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    await send(
      connection,
      [
        af.createRegistry(issuer.publicKey, 1, false),
        af.setJurisdiction(issuer.publicKey, registry, INDIA, true),
        af.setJurisdiction(issuer.publicKey, registry, SINGAPORE, true),
        af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, approved(INDIA)),
        af.setInvestorProfile(issuer.publicKey, registry, bob.publicKey, approved(SINGAPORE)),
        af.setInvestorProfile(issuer.publicKey, registry, mallory.publicKey, approved(UNITED_STATES)),
      ],
      [issuer],
    );

    await send(
      connection,
      await createServicedMint(connection, issuer.publicKey, mint, af.asset(mint), DECIMALS),
      [issuer, mintKey],
    );
    await send(
      connection,
      [
        af.registerAsset(issuer.publicKey, registry, mint),
        af.initializeGate(issuer.publicKey, mint),
        TokenAcl.createConfig(issuer.publicKey, issuer.publicKey, mint, programId),
        TokenAcl.togglePermissionless(issuer.publicKey, mint, true, true),
      ],
      [issuer],
    );

    for (const k of [alice, bob, mallory, eve]) await openAccount(k);
  });

  it("opens every holder account frozen", async () => {
    for (const k of [alice, bob, mallory, eve]) assert.equal(await isFrozen(k.publicKey), true);
  });

  it("lets an eligible holder thaw their own account", async () => {
    await permissionless("thaw", alice, alice.publicKey);
    await permissionless("thaw", bob, bob.publicKey);
    assert.equal(await isFrozen(alice.publicKey), false);
    assert.equal(await isFrozen(bob.publicKey), false);
  });

  it("refuses a thaw for a jurisdiction the registry does not allow", async () => {
    await refused(permissionless("thaw", mallory, mallory.publicKey), /NotEligible/);
    assert.equal(await isFrozen(mallory.publicKey), true);
  });

  it("refuses a thaw for a wallet with no profile", async () => {
    await refused(permissionless("thaw", eve, eve.publicKey), /NotEligible/);
  });

  it("issues only into thawed accounts", async () => {
    await send(connection, [af.issue(issuer.publicKey, mint, ata(alice.publicKey), 1_000_000_000n)], [issuer]);
    assert.equal(await balance(alice.publicKey), 1_000_000_000n);
    await refused(
      send(connection, [af.issue(issuer.publicKey, mint, ata(mallory.publicKey), 1n)], [issuer]),
      /frozen/i,
    );
  });

  it("moves units between eligible holders with a plain Token-2022 transfer", async () => {
    await transfer(alice, bob.publicKey, 250_000_000n);
    assert.equal(await balance(bob.publicKey), 250_000_000n);
  });

  it("cannot move units to an ineligible wallet", async () => {
    await refused(transfer(alice, mallory.publicKey, 1n), /frozen/i);
  });

  it("will not let anyone freeze a holder in good standing", async () => {
    await refused(permissionless("freeze", stranger, bob.publicKey), /StillEligible/);
    assert.equal(await isFrozen(bob.publicKey), false);
  });

  it("lets anyone freeze a holder whose approval lapsed, and that stops transfers", async () => {
    await send(
      connection,
      [af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, approved(INDIA, now() - 60))],
      [issuer],
    );
    await permissionless("freeze", stranger, alice.publicKey);
    assert.equal(await isFrozen(alice.publicKey), true);
    await refused(transfer(alice, bob.publicKey, 1n), /frozen/i);
  });

  it("lets a renewed holder thaw again", async () => {
    await send(
      connection,
      [af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, approved(INDIA))],
      [issuer],
    );
    await permissionless("thaw", alice, alice.publicKey);
    await transfer(alice, bob.publicKey, 1n);
    assert.equal(await balance(bob.publicKey), 250_000_001n);
  });
});
