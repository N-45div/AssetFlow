/**
 * The circuit breaker for trading pools, end to end, against a local
 * validator running AssetFlow and the real Token ACL binary (see validator.sh).
 *
 * What is being proved: a pool's account of the asset trades only while its
 * venue is open, that is, while a fresh allow decision made after the last
 * trip stands; the moment that stops being true anyone can freeze the
 * account, and a frozen pool account can neither send nor receive units, so
 * a dump into it fails before it trades. The price check needs no oracle: it
 * compares the pool's reserves with the bond's own value. Wallet-to-wallet
 * transfers never touch any of it.
 *
 * The pool here is a stand-in: a keypair owns its two accounts and the test
 * moves reserves the way a constant-product pool would. The gate only ever
 * sees the pool's token accounts, so a real AMM's authority looks the same.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  createInitializeImmutableOwnerInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getAccountLen,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { AssetFlow, Period, ProfileTerms, TokenAcl, createServicedMint, send } from "../client";

const USD = 1_000_000n; // the payment currency has 6 decimals; one unit of the bond has a $1 face
const HONG_KONG = 344;
const DAY = 86_400;
const BAND_BPS = 500; // trip past 5% from the bond's value

const programId = new PublicKey(
  /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(
    readFileSync(join(__dirname, "../programs/assetflow/src/lib.rs"), "utf8"),
  )![1],
);
const af = new AssetFlow(programId);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

const issuer = Keypair.generate(); // registry admin, compliance officer and issuer
const risk = Keypair.generate(); // the venue's risk system
const alice = Keypair.generate(); // an investor who provides liquidity, and later dumps
const bob = Keypair.generate(); // an investor who trades wallet to wallet
const pool = Keypair.generate(); // the stand-in pool's authority
const stranger = Keypair.generate(); // anyone
const mintKey = Keypair.generate();
const mint = mintKey.publicKey;
const registry = af.registry(issuer.publicKey);
let usdc: PublicKey;

const units = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const dollars = (owner: PublicKey) => getAssociatedTokenAddressSync(usdc, owner, true, TOKEN_PROGRAM_ID);
const baseVault = () => units(pool.publicKey);
const quoteVault = () => dollars(pool.publicKey);
const venue = () => af.venue(registry, pool.publicKey);

const profile = (jurisdiction: number): ProfileTerms => ({
  approved: true,
  accredited: false,
  frozen: false,
  tier: 1,
  jurisdiction,
  expiry: Math.floor(Date.now() / 1000) + 30 * DAY,
});

async function isFrozen(account: PublicKey) {
  return (await getAccount(connection, account, "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen;
}

async function amount(account: PublicKey, program = TOKEN_2022_PROGRAM_ID) {
  return (await getAccount(connection, account, "confirmed", program)).amount;
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

/** The validator's clock lags wall time; wait until it has moved past `ts`. */
async function waitPast(ts: number) {
  for (;;) {
    const now = (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? 0;
    if (now > ts) return now;
    await new Promise((r) => setTimeout(r, 400));
  }
}

function permissionless(question: "thaw" | "freeze", account: PublicKey, owner: PublicKey) {
  return send(
    connection,
    [TokenAcl.permissionless(question, stranger.publicKey, mint, account, owner, programId, af.gateAccounts(question, mint, registry, owner))],
    [stranger],
  );
}

const decide = (by: Keypair, allow: boolean, validFor = 3_600) =>
  send(connection, [af.decideVenue(by.publicKey, registry, venue(), allow, validFor)], [by]);
const check = () => send(connection, [af.checkVenue(venue(), mint, baseVault(), quoteVault())], [stranger]);

async function readVenue() {
  const data = (await connection.getAccountInfo(venue(), "confirmed"))!.data;
  // registry 8, owner 40, mint 72, base 104, quote 136, risk 168, allow 200,
  // decided_at 201, valid_until 209, band 217, tripped_at 219
  return {
    allow: data[200] === 1,
    decidedAt: Number(data.readBigInt64LE(201)),
    validUntil: Number(data.readBigInt64LE(209)),
    band: data.readUInt16LE(217),
    trippedAt: Number(data.readBigInt64LE(219)),
  };
}

function sendUnits(from: Keypair, to: PublicKey, n: bigint) {
  return send(
    connection,
    [createTransferCheckedInstruction(units(from.publicKey), mint, to, from.publicKey, n, 0, [], TOKEN_2022_PROGRAM_ID)],
    [from],
  );
}

function sendDollars(from: Keypair, to: PublicKey, n: bigint) {
  return send(
    connection,
    [createTransferCheckedInstruction(dollars(from.publicKey), usdc, to, from.publicKey, n, 6, [], TOKEN_PROGRAM_ID)],
    [from],
  );
}

/** A constant-product swap of `n` units into the stand-in pool, paid out of its currency reserve. */
async function sellIntoPool(seller: Keypair, n: bigint) {
  const base = await amount(baseVault());
  const quote = await amount(quoteVault(), TOKEN_PROGRAM_ID);
  const out = (quote * n) / (base + n);
  await send(
    connection,
    [
      createTransferCheckedInstruction(units(seller.publicKey), mint, baseVault(), seller.publicKey, n, 0, [], TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(quoteVault(), usdc, dollars(seller.publicKey), pool.publicKey, out, 6, [], TOKEN_PROGRAM_ID),
    ],
    [seller, pool],
  );
  return out;
}

describe("circuit breaker for trading pools", () => {
  before(async () => {
    for (const k of [issuer, risk, alice, bob, pool, stranger]) {
      const sig = await connection.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
    usdc = await createMint(connection, issuer, issuer.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    const treasury = await getOrCreateAssociatedTokenAccount(connection, issuer, usdc, issuer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, issuer, usdc, treasury.address, issuer, 10_000n * USD, [], undefined, TOKEN_PROGRAM_ID);

    await send(
      connection,
      [
        af.createRegistry(issuer.publicKey, 1, false),
        af.setJurisdiction(issuer.publicKey, registry, HONG_KONG, true),
        af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, profile(HONG_KONG)),
        af.setInvestorProfile(issuer.publicKey, registry, bob.publicKey, profile(HONG_KONG)),
      ],
      [issuer],
    );
    await send(
      connection,
      [...(await createServicedMint(connection, issuer.publicKey, mint, af.asset(mint), 0)), af.registerAsset(issuer.publicKey, issuer.publicKey, registry, mint)],
      [issuer, mintKey],
    );
    // A schedule that starts next year: no interest has accrued yet, so the
    // bond's value is exactly its face, $1 a unit.
    const start = Math.floor(Date.now() / 1000 / DAY) * DAY + 365 * DAY;
    const periods: Period[] = [{ accrualStart: start, accrualEnd: start + 180 * DAY, recordTs: start + 170 * DAY, paymentTs: start + 180 * DAY }];
    await send(connection, [af.setTerms(issuer.publicKey, mint, usdc, USD, 1_000, periods)], [issuer]);

    for (const holder of [alice, bob]) {
      await send(
        connection,
        [
          createAssociatedTokenAccountIdempotentInstruction(issuer.publicKey, units(holder.publicKey), holder.publicKey, mint, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountIdempotentInstruction(issuer.publicKey, dollars(holder.publicKey), holder.publicKey, usdc, TOKEN_PROGRAM_ID),
          TokenAcl.permissionless("thaw", issuer.publicKey, mint, units(holder.publicKey), holder.publicKey, programId, af.gateAccounts("thaw", mint, registry, holder.publicKey)),
        ],
        [issuer],
      );
    }
    await send(connection, [af.issue(issuer.publicKey, registry, mint, units(alice.publicKey), alice.publicKey, 2_000n)], [issuer]);
    // The pool's two accounts, opened like any AMM opens its vaults.
    await send(
      connection,
      [
        createAssociatedTokenAccountIdempotentInstruction(pool.publicKey, baseVault(), pool.publicKey, mint, TOKEN_2022_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(pool.publicKey, quoteVault(), pool.publicKey, usdc, TOKEN_PROGRAM_ID),
      ],
      [pool],
    );
  });

  it("keeps a pool's account frozen until compliance approves it as a venue", async () => {
    assert.equal(await isFrozen(baseVault()), true);
    await refused(permissionless("thaw", baseVault(), pool.publicKey), /NotEligible/);
    await refused(
      send(connection, [af.issue(issuer.publicKey, registry, mint, baseVault(), pool.publicKey, 1n)], [issuer]),
      /NotEligible/,
    );
  });

  it("lets only compliance approve a venue, and only with a sane band and the bond's own currency", async () => {
    await refused(
      send(connection, [af.approveVenue(stranger.publicKey, registry, mint, baseVault(), quoteVault(), pool.publicKey, risk.publicKey, BAND_BPS)], [stranger]),
      /Unauthorized/,
    );
    await refused(
      send(connection, [af.approveVenue(issuer.publicKey, registry, mint, baseVault(), quoteVault(), pool.publicKey, risk.publicKey, 0)], [issuer]),
      /InvalidVenue/,
    );
    await refused(
      send(connection, [af.approveVenue(issuer.publicKey, registry, mint, baseVault(), baseVault(), pool.publicKey, risk.publicKey, BAND_BPS)], [issuer]),
      /InvalidVenue/,
    );
  });

  it("refuses to make an investor's wallet a venue", async () => {
    await refused(
      send(connection, [af.approveVenue(issuer.publicKey, registry, mint, units(alice.publicKey), dollars(alice.publicKey), alice.publicKey, risk.publicKey, BAND_BPS)], [issuer]),
      /already in use/,
    );
  });

  it("opens a venue closed: approval alone does not let the pool trade", async () => {
    await send(connection, [af.approveVenue(issuer.publicKey, registry, mint, baseVault(), quoteVault(), pool.publicKey, risk.publicKey, BAND_BPS)], [issuer]);
    const v = await readVenue();
    assert.equal(v.allow, false);
    assert.equal(v.band, BAND_BPS);
    await refused(permissionless("thaw", baseVault(), pool.publicKey), /VenueClosed/);
  });

  it("takes decisions only from the venue's risk authority or compliance", async () => {
    await refused(decide(stranger, true), /Unauthorized/);
    await refused(decide(risk, true, 0), /InvalidVenue/);
    await refused(decide(risk, true, 8 * DAY), /InvalidVenue/);
  });

  it("on a fresh allow, anyone can thaw the pool and nobody can freeze it", async () => {
    await decide(risk, true);
    await permissionless("thaw", baseVault(), pool.publicKey);
    assert.equal(await isFrozen(baseVault()), false);
    await refused(permissionless("freeze", baseVault(), pool.publicKey), /VenueOpen/);
  });

  it("does not trip while the pool prices the bond within its band", async () => {
    // Liquidity at the bond's value: 1,000 units against $1,000.
    await sendUnits(alice, baseVault(), 1_000n);
    await sendDollars(issuer, quoteVault(), 1_000n * USD);
    await check();
    assert.equal((await readVenue()).trippedAt, 0);
    // A small trade moves the price less than 5%.
    await sellIntoPool(alice, 20n);
    await check();
    assert.equal((await readVenue()).trippedAt, 0);
    await refused(permissionless("freeze", baseVault(), pool.publicKey), /VenueOpen/);
  });

  it("trips on a dump past the band, and then anyone can freeze the pool", async () => {
    // A compromised holder sells 800 units into the pool: the price falls far below $1.
    await sellIntoPool(alice, 800n);
    await check();
    const v = await readVenue();
    assert.ok(v.trippedAt >= v.decidedAt, "tripped after the decision");
    await refused(permissionless("thaw", baseVault(), pool.publicKey), /VenueClosed/);
    await permissionless("freeze", baseVault(), pool.publicKey);
    assert.equal(await isFrozen(baseVault()), true);
  });

  it("stops every further trade against the frozen pool, in both directions", async () => {
    await refused(sellIntoPool(alice, 10n), /frozen/i);
    await refused(
      send(
        connection,
        [createTransferCheckedInstruction(baseVault(), mint, units(bob.publicKey), pool.publicKey, 1n, 0, [], TOKEN_2022_PROGRAM_ID)],
        [pool],
      ),
      /frozen/i,
    );
  });

  it("leaves wallet-to-wallet transfers untouched", async () => {
    const before = await amount(units(bob.publicKey));
    await sendUnits(alice, units(bob.publicKey), 5n);
    assert.equal(await amount(units(bob.publicKey)), before + 5n);
  });

  it("checking again does not move a trip that already stands", async () => {
    const first = (await readVenue()).trippedAt;
    await waitPast(first);
    await check();
    assert.equal((await readVenue()).trippedAt, first);
  });

  it("reopens only on a decision made after the trip, and trips again while the price is still off", async () => {
    const { trippedAt } = await readVenue();
    await waitPast(trippedAt);
    await decide(risk, true);
    await permissionless("thaw", baseVault(), pool.publicKey);
    assert.equal(await isFrozen(baseVault()), false);
    // Nothing traded the price back, so the next check trips it at once.
    const { decidedAt } = await readVenue();
    await waitPast(decidedAt);
    await check();
    await permissionless("freeze", baseVault(), pool.publicKey);
    assert.equal(await isFrozen(baseVault()), true);
  });

  it("stays open once the price is restored and a new decision allows it", async () => {
    // The issuer restores the pool's price by adding currency until the reserves match the bond's value.
    const base = await amount(baseVault());
    const quote = await amount(quoteVault(), TOKEN_PROGRAM_ID);
    await sendDollars(issuer, quoteVault(), base * USD - quote);
    const { trippedAt } = await readVenue();
    await waitPast(trippedAt);
    await decide(risk, true);
    await permissionless("thaw", baseVault(), pool.publicKey);
    const { decidedAt } = await readVenue();
    await waitPast(decidedAt);
    await check();
    const v = await readVenue();
    assert.ok(v.decidedAt > v.trippedAt, "no new trip");
    await refused(permissionless("freeze", baseVault(), pool.publicKey), /VenueOpen/);
  });

  it("closes the moment compliance blocks it, whatever the risk authority said", async () => {
    await decide(issuer, false);
    await permissionless("freeze", baseVault(), pool.publicKey);
    assert.equal(await isFrozen(baseVault()), true);
    await refused(permissionless("thaw", baseVault(), pool.publicKey), /VenueClosed/);
  });

  it("closes when an allow expires without renewal", async () => {
    await decide(risk, true, 2);
    await permissionless("thaw", baseVault(), pool.publicKey);
    const { validUntil } = await readVenue();
    await waitPast(validUntil);
    await permissionless("freeze", baseVault(), pool.publicKey);
    assert.equal(await isFrozen(baseVault()), true);
  });

  it("thaws only the approved account, never another account of the pool's authority", async () => {
    await decide(risk, true);
    const other = Keypair.generate();
    const space = getAccountLen([ExtensionType.PausableAccount, ExtensionType.ImmutableOwner]);
    await send(
      connection,
      [
        SystemProgram.createAccount({
          fromPubkey: pool.publicKey,
          newAccountPubkey: other.publicKey,
          space,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeImmutableOwnerInstruction(other.publicKey, TOKEN_2022_PROGRAM_ID),
        createInitializeAccount3Instruction(other.publicKey, mint, pool.publicKey, TOKEN_2022_PROGRAM_ID),
      ],
      [pool, other],
    );
    await refused(permissionless("thaw", other.publicKey, pool.publicKey), /NotTheVenueAccount/);
  });

  it("treats a venue's pool as no investor: issuance to it is refused", async () => {
    // Issuance, coupons and redemptions read the record at the pool's address as no eligible investor.
    await refused(
      send(connection, [af.issue(issuer.publicKey, registry, mint, baseVault(), pool.publicKey, 1n)], [issuer]),
      /NotEligible/,
    );
  });

  it("once compliance withdraws the venue, the pool is held by no one eligible", async () => {
    await permissionless("thaw", baseVault(), pool.publicKey);
    await send(connection, [af.closeVenue(issuer.publicKey, registry, venue())], [issuer]);
    assert.equal(await connection.getAccountInfo(venue(), "confirmed"), null);
    await permissionless("freeze", baseVault(), pool.publicKey);
    await refused(permissionless("thaw", baseVault(), pool.publicKey), /NotEligible/);
    assert.equal(await isFrozen(baseVault()), true);
  });
});
