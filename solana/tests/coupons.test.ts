/**
 * Coupons, end to end on a local validator: the register is fixed on the
 * record date, counted into the program by anyone, one account at a time,
 * and every amount paid is computed by the program from the instrument's
 * terms. No step after the terms needs the issuer's key.
 *
 * The note: US$1 of face per unit, 10% a year, 30/360. Three holders own
 * 3,000 (Alice, across two accounts), 1,000 and 1,500 units, so a regular
 * half-year costs US$275.00: US$150.00, US$50.00 and US$75.00.
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
  createInitializeMint2Instruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getAccountLen,
  getAssociatedTokenAddressSync,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  AssetFlow,
  Period,
  ProfileTerms,
  TokenAcl,
  countInstructions,
  createServicedMint,
  registerSources,
  send,
} from "../client";

const HONG_KONG = 344;
const SINGAPORE = 702;
const USD = 1_000_000n; // currency base units per dollar (6 decimals)

const programId = new PublicKey(
  /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(
    readFileSync(join(__dirname, "../programs/assetflow/src/lib.rs"), "utf8"),
  )![1],
);
const af = new AssetFlow(programId);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

const issuer = Keypair.generate();
const alice = Keypair.generate(); // 3,000 units, Hong Kong
const bob = Keypair.generate(); // 1,000 units, Singapore
const carol = Keypair.generate(); // 1,500 units, put on a compliance hold before she is paid
const stranger = Keypair.generate(); // sends the permissionless steps
const mintKey = Keypair.generate();
const mint = mintKey.publicKey;
const registry = af.registry(issuer.publicKey);
let usdc: PublicKey;

const now = () => Math.floor(Date.now() / 1000);
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const profile = (jurisdiction: number, frozen = false): ProfileTerms => ({
  approved: true,
  accredited: false,
  frozen,
  tier: 1,
  jurisdiction,
  expiry: now() + 86_400,
});
const unitsOf = new Map([
  [alice, 3_000n],
  [bob, 1_000n],
  [carol, 1_500n],
]);
let aliceSecond: PublicKey; // Alice keeps 500 of her units in a second, hand-made account
const assetAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
const usdcAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(usdc, owner, false, TOKEN_PROGRAM_ID);
const usdcBalance = async (owner: PublicKey) =>
  (await getAccount(connection, usdcAccount(owner), "confirmed", TOKEN_PROGRAM_ID).catch(() => ({ amount: 0n }))).amount;

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

let periods: Period[];

// Payout: discriminator, asset, period, status, fixed_ts, fixed_slot, supply_at_fix, then:
const COUNTED_AT = 8 + 32 + 1 + 1 + 8 + 8 + 8;
const REQUIRED_AT = COUNTED_AT + 8;
// Entitlement: discriminator, payout, holder, then units and payer.
const UNITS_AT = 8 + 32 + 32;
const PAYER_AT = UNITS_AT + 8;

const payoutData = async (period: number) => (await connection.getAccountInfo(af.payout(mint, period), "confirmed"))!.data;
const counted = async (period: number) => (await payoutData(period)).readBigUInt64LE(COUNTED_AT);
function count(caller: Keypair, period: number, holding: PublicKey, owner: PublicKey) {
  return send(connection, [af.countHolding(caller.publicKey, mint, period, holding, owner)], [caller]);
}

async function pay(holder: Keypair, period = 0) {
  const payout = af.payout(mint, period);
  const entitlement = await connection.getAccountInfo(af.entitlement(payout, holder.publicKey), "confirmed");
  const rentReceiver = entitlement ? new PublicKey(entitlement.data.subarray(PAYER_AT, PAYER_AT + 32)) : stranger.publicKey;
  return send(
    connection,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        stranger.publicKey,
        usdcAccount(holder.publicKey),
        holder.publicKey,
        usdc,
        TOKEN_PROGRAM_ID,
      ),
      af.payEntitlement(
        stranger.publicKey,
        registry,
        mint,
        period,
        usdc,
        TOKEN_PROGRAM_ID,
        usdcAccount(holder.publicKey),
        holder.publicKey,
        rentReceiver,
      ),
    ],
    [stranger],
  );
}

function fund(amount: bigint, period = 0) {
  return send(
    connection,
    [af.fundPayout(issuer.publicKey, mint, period, usdc, TOKEN_PROGRAM_ID, usdcAccount(issuer.publicKey), amount)],
    [issuer],
  );
}

function transferUnits(from: Keypair, to: PublicKey, amount: bigint, source = assetAccount(from.publicKey)) {
  return send(
    connection,
    [createTransferCheckedInstruction(source, mint, to, from.publicKey, amount, 0, [], TOKEN_2022_PROGRAM_ID)],
    [from],
  );
}

/** A hand-made holder account with an immutable owner, thawed through the gate. */
async function openSecondAccount(owner: Keypair) {
  const account = Keypair.generate();
  const space = getAccountLen([ExtensionType.PausableAccount, ExtensionType.ImmutableOwner]);
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
      createInitializeImmutableOwnerInstruction(account.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeAccount3Instruction(account.publicKey, mint, owner.publicKey, TOKEN_2022_PROGRAM_ID),
      TokenAcl.permissionless("thaw", owner.publicKey, mint, account.publicKey, owner.publicKey, programId, af.gateAccounts("thaw", mint, registry, owner.publicKey)),
    ],
    [owner, account],
  );
  return account.publicKey;
}

describe("coupons", () => {
  before(async () => {
    for (const k of [issuer, alice, bob, carol, stranger]) {
      const sig = await connection.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
    // The payment currency: a classic SPL token standing in for USDC.
    usdc = await createMint(connection, issuer, issuer.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    const treasury = await getOrCreateAssociatedTokenAccount(connection, issuer, usdc, issuer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, issuer, usdc, treasury.address, issuer, 1_000n * USD, [], undefined, TOKEN_PROGRAM_ID);

    await send(
      connection,
      [
        af.createRegistry(issuer.publicKey, 1, false),
        af.setJurisdiction(issuer.publicKey, registry, HONG_KONG, true),
        af.setJurisdiction(issuer.publicKey, registry, SINGAPORE, true),
        af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, profile(HONG_KONG)),
        af.setInvestorProfile(issuer.publicKey, registry, bob.publicKey, profile(SINGAPORE)),
        af.setInvestorProfile(issuer.publicKey, registry, carol.publicKey, profile(HONG_KONG)),
      ],
      [issuer],
    );
    await send(
      connection,
      [
        ...(await createServicedMint(connection, issuer.publicKey, mint, af.asset(mint), 0)),
        af.registerAsset(issuer.publicKey, issuer.publicKey, registry, mint),
      ],
      [issuer, mintKey],
    );
    for (const [holder, units] of unitsOf) {
      await send(
        connection,
        [
          createAssociatedTokenAccountIdempotentInstruction(issuer.publicKey, assetAccount(holder.publicKey), holder.publicKey, mint, TOKEN_2022_PROGRAM_ID),
          TokenAcl.permissionless("thaw", issuer.publicKey, mint, assetAccount(holder.publicKey), holder.publicKey, programId, af.gateAccounts("thaw", mint, registry, holder.publicKey)),
          af.issue(issuer.publicKey, registry, mint, assetAccount(holder.publicKey), holder.publicKey, units),
        ],
        [issuer],
      );
    }
    aliceSecond = await openSecondAccount(alice);
    await transferUnits(alice, aliceSecond, 500n);

    // Period 0 and period 1 have passed their record dates; period 2's is an hour away.
    periods = [
      { accrualStart: utc(2026, 10, 1), accrualEnd: utc(2027, 4, 1), recordTs: now() - 120, paymentTs: now() - 90 },
      { accrualStart: utc(2027, 4, 1), accrualEnd: utc(2027, 10, 1), recordTs: now() - 60, paymentTs: now() + 3_600 },
      { accrualStart: utc(2027, 10, 1), accrualEnd: utc(2028, 4, 1), recordTs: now() + 3_600, paymentTs: now() + 7_200 },
    ];
  });

  it("sets the instrument terms once", async () => {
    await send(connection, [af.setTerms(issuer.publicKey, mint, usdc, USD, 1_000, periods)], [issuer]);
    await refused(
      send(connection, [af.setTerms(issuer.publicKey, mint, usdc, USD, 1_500, periods)], [issuer]),
      /already in use/,
    );
  });

  it("lets anyone fix the register after the record date, prices it, and nothing moves while it is fixed", async () => {
    await send(connection, [af.fixRegister(stranger.publicKey, mint, 0, usdc, TOKEN_PROGRAM_ID)], [stranger]);
    await refused(transferUnits(alice, assetAccount(bob.publicKey), 1n), /0x43|paused/i);
    assert.equal((await payoutData(0)).readBigUInt64LE(REQUIRED_AT), 275n * USD);
  });

  it("will not open a later register while an earlier one is being counted", async () => {
    await refused(
      send(connection, [af.fixRegister(stranger.publicKey, mint, 1, usdc, TOKEN_PROGRAM_ID)], [stranger]),
      /PreviousPeriodOpen/,
    );
  });

  it("counts only holder accounts of this mint that hold units", async () => {
    // the asset's own account (where requested units wait) is never a holding
    const escrow = af.escrow(mint);
    await send(
      connection,
      [createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, escrow, af.asset(mint), mint, TOKEN_2022_PROGRAM_ID)],
      [stranger],
    );
    await refused(count(stranger, 0, escrow, af.asset(mint)), /NotAHolding/);
    // an empty account adds nothing, so it is not counted
    const empty = Keypair.generate();
    await send(
      connection,
      [createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, assetAccount(empty.publicKey), empty.publicKey, mint, TOKEN_2022_PROGRAM_ID)],
      [stranger],
    );
    await refused(count(stranger, 0, assetAccount(empty.publicKey), empty.publicKey), /InvalidAmount/);
    // an account of another mint
    const other = Keypair.generate();
    const space = getMintLen([]);
    await send(
      connection,
      [
        SystemProgram.createAccount({
          fromPubkey: stranger.publicKey,
          newAccountPubkey: other.publicKey,
          space,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(other.publicKey, 0, stranger.publicKey, null, TOKEN_2022_PROGRAM_ID),
      ],
      [stranger, other],
    );
    const foreign = getAssociatedTokenAddressSync(other.publicKey, stranger.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await send(
      connection,
      [createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, foreign, stranger.publicKey, other.publicKey, TOKEN_2022_PROGRAM_ID)],
      [stranger],
    );
    await refused(count(stranger, 0, foreign, stranger.publicKey), /ConstraintTokenMint|token mint|2014/);
  });

  it("keeps the mint paused until the count reaches the supply", async () => {
    await count(issuer, 0, assetAccount(alice.publicKey), alice.publicKey);
    await count(issuer, 0, assetAccount(bob.publicKey), bob.publicKey);
    assert.equal(await counted(0), 3_500n);
    await refused(send(connection, [af.closeRegister(mint, 0)], [stranger]), /CountIncomplete/);
    await refused(transferUnits(bob, assetAccount(alice.publicKey), 1n), /0x43|paused/i);
  });

  it("counts an account once, however often it is sent", async () => {
    await count(stranger, 0, assetAccount(alice.publicKey), alice.publicKey);
    assert.equal(await counted(0), 3_500n);
  });

  it("can be funded while the register is still being counted", async () => {
    await fund(200n * USD);
  });

  it("lets anyone finish the count and resume the mint, with no key of the issuer's", async () => {
    await refused(
      send(connection, [af.releaseCounted(mint, 0, assetAccount(alice.publicKey), issuer.publicKey)], [stranger]),
      /WrongPayoutStatus/,
    );
    await count(stranger, 0, aliceSecond, alice.publicKey);
    await count(stranger, 0, assetAccount(carol.publicKey), carol.publicKey);
    await send(connection, [af.closeRegister(mint, 0)], [stranger]);
    assert.equal(await counted(0), 5_500n);
    // Alice was counted across both of her accounts
    const entitlement = (await connection.getAccountInfo(af.entitlement(af.payout(mint, 0), alice.publicKey), "confirmed"))!;
    assert.equal(entitlement.data.readBigUInt64LE(UNITS_AT), 3_000n);
  });

  it("pays nothing until the payment is fully funded", async () => {
    await refused(pay(alice), /Underfunded/);
    await fund(75n * USD);
  });

  it("pays each eligible holder exactly the coupon the terms give their whole holding", async () => {
    const counter = await connection.getBalance(issuer.publicKey, "confirmed");
    await pay(alice);
    await pay(bob);
    assert.equal(await usdcBalance(alice.publicKey), 150n * USD);
    assert.equal(await usdcBalance(bob.publicKey), 50n * USD);
    // the entitlements are gone, their rent back with whoever counted them
    assert.equal(await connection.getAccountInfo(af.entitlement(af.payout(mint, 0), alice.publicKey), "confirmed"), null);
    assert.ok((await connection.getBalance(issuer.publicKey, "confirmed")) > counter);
  });

  it("holds back the coupon of a holder who is no longer eligible", async () => {
    await send(
      connection,
      [af.setInvestorProfile(issuer.publicKey, registry, carol.publicKey, profile(HONG_KONG, true))],
      [issuer],
    );
    await pay(carol);
    assert.equal(await usdcBalance(carol.publicKey), 0n);
    const vault = await getAccount(connection, af.payoutVault(af.payout(mint, 0)), "confirmed", TOKEN_PROGRAM_ID);
    assert.equal(vault.amount, 75n * USD);
  });

  it("never pays the same holder twice, and pays nobody who was not counted", async () => {
    await refused(pay(alice), /AccountNotInitialized|already in use/);
    await refused(pay(Keypair.generate()), /AccountNotInitialized/);
  });

  it("returns a counted marker's rent to whoever paid it, once", async () => {
    const marker = af.counted(af.payout(mint, 0), aliceSecond);
    await refused(
      send(connection, [af.releaseCounted(mint, 0, aliceSecond, issuer.publicKey)], [stranger]),
      /ConstraintAddress|2012/,
    );
    await send(connection, [af.releaseCounted(mint, 0, aliceSecond, stranger.publicKey)], [stranger]);
    assert.equal(await connection.getAccountInfo(marker, "confirmed"), null);
  });

  it("moves units again once the register is counted", async () => {
    await transferUnits(alice, assetAccount(bob.publicKey), 10n);
    const bobUnits = (await getAccount(connection, assetAccount(bob.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    assert.equal(bobUnits, 1_010n);
  });

  it("counts the next register from the chain alone", async () => {
    await send(connection, [af.fixRegister(stranger.publicKey, mint, 1, usdc, TOKEN_PROGRAM_ID)], [stranger]);
    const sources = await registerSources(connection, af, mint);
    const ixs = await countInstructions(connection, af, stranger.publicKey, mint, 1, sources);
    for (let i = 0; i < ixs.length; i += 4) await send(connection, ixs.slice(i, i + 4), [stranger]);
    await send(connection, [af.closeRegister(mint, 1)], [stranger]);
    const units = async (h: Keypair) =>
      (await connection.getAccountInfo(af.entitlement(af.payout(mint, 1), h.publicKey), "confirmed"))!.data.readBigUInt64LE(UNITS_AT);
    assert.equal(await units(alice), 2_990n);
    assert.equal(await units(bob), 1_010n);
    assert.equal(await units(carol), 1_500n);
  });

  it("will not fix a register before its record date", async () => {
    await refused(
      send(connection, [af.fixRegister(stranger.publicKey, mint, 2, usdc, TOKEN_PROGRAM_ID)], [stranger]),
      /RecordDateNotReached/,
    );
  });
});
