/**
 * Coupons, end to end on a local validator: the register is fixed on the
 * record date, entitlements are committed as units, and every amount paid is
 * computed by the program from the instrument's terms.
 *
 * The note: US$1 of face per unit, 10% a year, 30/360. Three holders own
 * 3,000, 1,000 and 1,500 units, so a regular half-year costs US$275.00:
 * US$150.00, US$50.00 and US$75.00.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  AssetFlow,
  Period,
  ProfileTerms,
  TokenAcl,
  createServicedMint,
  entitlementLeaf,
  entitlementTree,
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
const holders = [...unitsOf.keys()];
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
let tree: ReturnType<typeof entitlementTree>;

function pay(holder: Keypair, units: bigint, proof: Buffer[]) {
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
        0,
        usdc,
        TOKEN_PROGRAM_ID,
        usdcAccount(holder.publicKey),
        holder.publicKey,
        units,
        proof,
      ),
    ],
    [stranger],
  );
}

function fund(amount: bigint) {
  return send(
    connection,
    [af.fundPayout(issuer.publicKey, mint, 0, usdc, TOKEN_PROGRAM_ID, usdcAccount(issuer.publicKey), amount)],
    [issuer],
  );
}

function transferUnits(from: Keypair, to: PublicKey, amount: bigint) {
  return send(
    connection,
    [createTransferCheckedInstruction(assetAccount(from.publicKey), mint, assetAccount(to), from.publicKey, amount, 0, [], TOKEN_2022_PROGRAM_ID)],
    [from],
  );
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

    // Period 0: accrual Oct 2026 - Apr 2027, record date already passed.
    // Period 1: its record date is an hour away.
    periods = [
      { accrualStart: utc(2026, 10, 1), accrualEnd: utc(2027, 4, 1), recordTs: now() - 60, paymentTs: now() - 30 },
      { accrualStart: utc(2027, 4, 1), accrualEnd: utc(2027, 10, 1), recordTs: now() + 3_600, paymentTs: now() + 7_200 },
    ];
  });

  it("sets the instrument terms once", async () => {
    await send(connection, [af.setTerms(issuer.publicKey, mint, usdc, USD, 1_000, periods)], [issuer]);
    await refused(
      send(connection, [af.setTerms(issuer.publicKey, mint, usdc, USD, 1_500, periods)], [issuer]),
      /already in use/,
    );
  });

  it("will not fix the register before the record date", async () => {
    await refused(send(connection, [af.fixRegister(stranger.publicKey, mint, 1)], [stranger]), /RecordDateNotReached/);
  });

  it("lets anyone fix the register after the record date, and nothing moves while it is fixed", async () => {
    await send(connection, [af.fixRegister(stranger.publicKey, mint, 0)], [stranger]);
    await refused(transferUnits(alice, bob.publicKey, 1n), /0x43|paused/i);
  });

  it("refuses entitlements that do not add up to the supply", async () => {
    const payout = af.payout(mint, 0);
    const bad = entitlementTree(holders.map((h) => entitlementLeaf(payout, h.publicKey, unitsOf.get(h)!)));
    await refused(
      send(connection, [af.commitEntitlements(issuer.publicKey, mint, 0, usdc, TOKEN_PROGRAM_ID, bad.root, 5_499n)], [issuer]),
      /TotalMismatch/,
    );
  });

  it("commits the entitlements, prices the payment from the terms and resumes the mint", async () => {
    const payout = af.payout(mint, 0);
    tree = entitlementTree(holders.map((h) => entitlementLeaf(payout, h.publicKey, unitsOf.get(h)!)));
    await send(
      connection,
      [af.commitEntitlements(issuer.publicKey, mint, 0, usdc, TOKEN_PROGRAM_ID, tree.root, 5_500n)],
      [issuer],
    );
    const data = (await connection.getAccountInfo(payout))!.data;
    // required sits after status, fixed_ts, fixed_slot, supply_at_fix, root, total_units
    const required = data.readBigUInt64LE(8 + 32 + 1 + 1 + 8 + 8 + 8 + 32 + 8);
    assert.equal(required, 275n * USD);
  });

  it("pays nothing until the payment is fully funded", async () => {
    await refused(pay(alice, 3_000n, tree.proofs[0]), /Underfunded/);
    await fund(200n * USD);
    await refused(pay(alice, 3_000n, tree.proofs[0]), /Underfunded/);
    await fund(75n * USD);
  });

  it("pays each eligible holder exactly the coupon the terms give their holding", async () => {
    await pay(alice, 3_000n, tree.proofs[0]);
    await pay(bob, 1_000n, tree.proofs[1]);
    assert.equal(await usdcBalance(alice.publicKey), 150n * USD);
    assert.equal(await usdcBalance(bob.publicKey), 50n * USD);
  });

  it("holds back the coupon of a holder who is no longer eligible", async () => {
    await send(
      connection,
      [af.setInvestorProfile(issuer.publicKey, registry, carol.publicKey, profile(HONG_KONG, true))],
      [issuer],
    );
    await pay(carol, 1_500n, tree.proofs[2]);
    assert.equal(await usdcBalance(carol.publicKey), 0n);
    const vault = await getAccount(connection, af.payoutVault(af.payout(mint, 0)), "confirmed", TOKEN_PROGRAM_ID);
    assert.equal(vault.amount, 75n * USD);
  });

  it("never pays the same holder twice", async () => {
    await refused(pay(alice, 3_000n, tree.proofs[0]), /already in use/);
  });

  it("refuses a proof for units the holder was not given", async () => {
    const extra = Keypair.generate();
    await refused(pay(extra, 3_000n, tree.proofs[0]), /InvalidProof/);
  });

  it("moves units again once the entitlements are committed", async () => {
    await transferUnits(alice, bob.publicKey, 10n);
    const bobUnits = (await getAccount(connection, assetAccount(bob.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    assert.equal(bobUnits, 1_010n);
  });
});
