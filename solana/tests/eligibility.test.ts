/**
 * Eligibility, end to end, against a local validator running AssetFlow and the
 * real Token ACL binary (see validator.sh).
 *
 * What is being proved: nothing in a plain transfer calls AssetFlow, yet only
 * eligible wallets can hold the asset, because every holder account starts
 * frozen and only the gate can let Token ACL thaw it. A lapsed approval is
 * enforceable by anyone, because the gate says yes to freezing exactly the
 * wallets it would no longer thaw. And no personal key, the issuer's included,
 * can reach around the gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  createInitializeImmutableOwnerInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAccountLen,
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

const issuer = Keypair.generate(); // registry admin, compliance officer and issuer
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

async function isFrozen(account: PublicKey) {
  return (await getAccount(connection, account, "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen;
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

/** A hand-made (non-associated) holder account, with or without an immutable owner. */
async function openHandMadeAccount(owner: Keypair, immutableOwner: boolean) {
  const account = Keypair.generate();
  const extensions = [ExtensionType.PausableAccount, ...(immutableOwner ? [ExtensionType.ImmutableOwner] : [])];
  const space = getAccountLen(extensions);
  await send(
    connection,
    [
      SystemProgram.createAccount({
        fromPubkey: owner.publicKey,
        newAccountPubkey: account.publicKey,
        space,
        lamports: await connection.getMinimumBalanceForRentExemption(space),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      ...(immutableOwner
        ? [createInitializeImmutableOwnerInstruction(account.publicKey, TOKEN_2022_PROGRAM_ID)]
        : []),
      createInitializeAccount3Instruction(account.publicKey, mint, owner.publicKey, TOKEN_2022_PROGRAM_ID),
    ],
    [owner, account],
  );
  return account.publicKey;
}

function permissionless(
  question: "thaw" | "freeze",
  caller: Keypair,
  owner: PublicKey,
  account = ata(owner),
) {
  return send(
    connection,
    [
      TokenAcl.permissionless(
        question,
        caller.publicKey,
        mint,
        account,
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

function issue(owner: PublicKey, amount: bigint) {
  return send(
    connection,
    [af.issue(issuer.publicKey, registry, mint, ata(owner), owner, amount)],
    [issuer],
  );
}

function setProfile(wallet: PublicKey, terms: ProfileTerms) {
  return send(
    connection,
    [af.setInvestorProfile(issuer.publicKey, registry, wallet, terms)],
    [issuer],
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

    // Created and registered in one transaction, so there is no moment when
    // the mint exists unregistered.
    await send(
      connection,
      [
        ...(await createServicedMint(connection, issuer.publicKey, mint, af.asset(mint), DECIMALS)),
        af.registerAsset(issuer.publicKey, issuer.publicKey, registry, mint),
      ],
      [issuer, mintKey],
    );

    for (const k of [alice, bob, mallory, eve]) await openAccount(k);
  });

  it("opens every holder account frozen", async () => {
    for (const k of [alice, bob, mallory, eve]) assert.equal(await isFrozen(ata(k.publicKey)), true);
  });

  it("lets an eligible holder thaw their own account", async () => {
    await permissionless("thaw", alice, alice.publicKey);
    await permissionless("thaw", bob, bob.publicKey);
    assert.equal(await isFrozen(ata(alice.publicKey)), false);
    assert.equal(await isFrozen(ata(bob.publicKey)), false);
  });

  it("refuses a thaw for a jurisdiction the registry does not allow", async () => {
    await refused(permissionless("thaw", mallory, mallory.publicKey), /NotEligible/);
    assert.equal(await isFrozen(ata(mallory.publicKey)), true);
  });

  it("refuses a thaw for a wallet with no profile", async () => {
    await refused(permissionless("thaw", eve, eve.publicKey), /NotEligible/);
  });

  it("issues only to eligible holders", async () => {
    await issue(alice.publicKey, 1_000_000_000n);
    assert.equal(await balance(alice.publicKey), 1_000_000_000n);
    await refused(issue(mallory.publicKey, 1n), /NotEligible/);
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
    assert.equal(await isFrozen(ata(bob.publicKey)), false);
  });

  it("lets anyone freeze a holder whose approval lapsed, and that stops transfers", async () => {
    await setProfile(alice.publicKey, approved(INDIA, now() - 60));
    await permissionless("freeze", stranger, alice.publicKey);
    assert.equal(await isFrozen(ata(alice.publicKey)), true);
    await refused(transfer(alice, bob.publicKey, 1n), /frozen/i);
  });

  it("lets a renewed holder thaw again", async () => {
    await setProfile(alice.publicKey, approved(INDIA));
    await permissionless("thaw", alice, alice.publicKey);
    await transfer(alice, bob.publicKey, 1n);
    assert.equal(await balance(bob.publicKey), 250_000_001n);
  });
});

describe("no way around the gate", () => {
  it("refuses to thaw an account whose owner could be reassigned", async () => {
    // Otherwise alice could thaw it on her approval, then hand it to anyone.
    const account = await openHandMadeAccount(alice, false);
    await refused(permissionless("thaw", alice, alice.publicKey, account), /OwnerNotImmutable/);
    assert.equal(await isFrozen(account), true);
  });

  it("thaws a hand-made account that opted into an immutable owner", async () => {
    const account = await openHandMadeAccount(alice, true);
    await permissionless("thaw", alice, alice.publicKey, account);
    assert.equal(await isFrozen(account), false);
  });

  it("registers a mint only with the mint's own signature", async () => {
    const victim = Keypair.generate();
    await send(
      connection,
      await createServicedMint(connection, issuer.publicKey, victim.publicKey, af.asset(victim.publicKey), 0),
      [issuer, victim],
    );
    // mallory runs her own registry and tries to claim the victim's fresh mint
    const hers = af.registry(mallory.publicKey);
    await send(connection, [af.createRegistry(mallory.publicKey, 0, false)], [mallory]);
    const attempt = af.registerAsset(mallory.publicKey, mallory.publicKey, hers, victim.publicKey);
    const unsigned = new TransactionInstruction({
      ...attempt,
      keys: attempt.keys.map((k) => (k.pubkey.equals(victim.publicKey) ? { ...k, isSigner: false } : k)),
    });
    await refused(send(connection, [unsigned], [mallory]), /AccountNotSigner|missing required signature/i);
  });

  it("refuses a mint whose freeze authority is not the asset account", async () => {
    const other = Keypair.generate();
    await refused(
      send(
        connection,
        [
          ...(await createServicedMint(connection, issuer.publicKey, other.publicKey, af.asset(other.publicKey), 0, {
            freezeAuthority: issuer.publicKey,
          })),
          af.registerAsset(issuer.publicKey, issuer.publicKey, registry, other.publicKey),
        ],
        [issuer, other],
      ),
      /FreezeAuthorityNotAsset/,
    );
  });

  it("refuses a mint carrying an extension a serviced asset may not have", async () => {
    const other = Keypair.generate();
    await refused(
      send(
        connection,
        [
          ...(await createServicedMint(connection, issuer.publicKey, other.publicKey, af.asset(other.publicKey), 0, {
            closeAuthority: issuer.publicKey,
          })),
          af.registerAsset(issuer.publicKey, issuer.publicKey, registry, other.publicKey),
        ],
        [issuer, other],
      ),
      /ForbiddenExtension/,
    );
  });

  it("leaves no personal key able to thaw past the gate, the issuer's included", async () => {
    await refused(
      send(connection, [TokenAcl.thaw(issuer.publicKey, mint, ata(mallory.publicKey))], [issuer]),
      /custom program error: 0x0\b/,
    );
    assert.equal(await isFrozen(ata(mallory.publicKey)), true);
  });

  it("will not issue to a holder whose approval lapsed but whose account is still thawed", async () => {
    await setProfile(bob.publicKey, approved(SINGAPORE, now() - 60));
    assert.equal(await isFrozen(ata(bob.publicKey)), false);
    await refused(issue(bob.publicKey, 1n), /NotEligible/);
    await setProfile(bob.publicKey, approved(SINGAPORE));
  });

  it("lets compliance freeze an account outright, and nobody else", async () => {
    await refused(
      send(
        connection,
        [af.forceFreeze(stranger.publicKey, registry, mint, ata(bob.publicKey), 1)],
        [stranger],
      ),
      /Unauthorized/,
    );
    await send(connection, [af.forceFreeze(issuer.publicKey, registry, mint, ata(bob.publicKey), 1)], [issuer]);
    assert.equal(await isFrozen(ata(bob.publicKey)), true);
  });
});
