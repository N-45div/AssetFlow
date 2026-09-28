/**
 * Redemptions and maturity, end to end on a local validator.
 *
 * The note is the coupon test's: US$1 of face per unit, 10% a year, 30/360,
 * held 3,000 / 1,000 / 1,500. Its first period began three months ago and
 * its record date is a minute away, so an early redemption settled now earns
 * interest; both record dates then pass, the registers are committed, and the
 * note matures.
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
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
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
const USD = 1_000_000n;

const programId = new PublicKey(
  /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(
    readFileSync(join(__dirname, "../programs/assetflow/src/lib.rs"), "utf8"),
  )![1],
);
const af = new AssetFlow(programId);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");

const issuer = Keypair.generate();
const alice = Keypair.generate(); // 3,000 units; redeems 1,000 early
const bob = Keypair.generate(); // 1,000 units; withdraws one request, leaves another open over a record date
const carol = Keypair.generate(); // 1,500 units; put on hold, so her request is rejected
const stranger = Keypair.generate();
const mintKey = Keypair.generate();
const mint = mintKey.publicKey;
const registry = af.registry(issuer.publicKey);
let usdc: PublicKey;
let periods: Period[];

const now = () => Math.floor(Date.now() / 1000);
const profile = (jurisdiction: number, frozen = false): ProfileTerms => ({
  approved: true,
  accredited: false,
  frozen,
  tier: 1,
  jurisdiction,
  expiry: now() + 86_400,
});
const assetAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
const usdcAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(usdc, owner, true, TOKEN_PROGRAM_ID);
const units = async (owner: PublicKey) =>
  (await getAccount(connection, assetAccount(owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
const cash = async (owner: PublicKey) =>
  (await getAccount(connection, usdcAccount(owner), "confirmed", TOKEN_PROGRAM_ID).catch(() => ({ amount: 0n }))).amount;
const supply = async () => (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
/** Wait for the chain's clock, which runs a little behind the wall clock on a local validator. */
const sleepUntil = async (ts: number) => {
  while (((await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? 0) < ts) {
    await new Promise((r) => setTimeout(r, 1_000));
  }
};

/** The program's 30/360 day count (MSRB G-33). */
function days30360(a: number, b: number) {
  const s = new Date(a * 1000);
  const e = new Date(b * 1000);
  const d1 = s.getUTCDate() === 31 ? 30 : s.getUTCDate();
  const d2 = e.getUTCDate() === 31 && d1 >= 30 ? 30 : e.getUTCDate();
  return 360 * (e.getUTCFullYear() - s.getUTCFullYear()) + 30 * (e.getUTCMonth() - s.getUTCMonth()) + (d2 - d1);
}

// RedemptionRequest: discriminator, asset, holder, id, units, then these.
const STATUS_AT = 8 + 32 + 32 + 4 + 8;
const STATUS = ["requested", "settled", "rejected", "cancelled"];
async function request(holder: PublicKey, id: number) {
  const data = (await connection.getAccountInfo(af.redemption(mint, holder, id)))!.data;
  return {
    status: STATUS[data[STATUS_AT]],
    principal: data.readBigUInt64LE(STATUS_AT + 1 + 8 + 8),
    interest: data.readBigUInt64LE(STATUS_AT + 1 + 8 + 8 + 8),
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

const ask = (holder: Keypair, id: number, n: bigint) =>
  send(connection, af.requestRedemption(holder.publicKey, registry, mint, assetAccount(holder.publicKey), id, n), [holder]);

const settle = (holder: PublicKey, id: number, signer = issuer) =>
  send(
    connection,
    [
      createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, usdcAccount(holder), holder, usdc, TOKEN_PROGRAM_ID),
      af.settleRedemption(
        signer.publicKey,
        registry,
        mint,
        af.redemption(mint, holder, id),
        holder,
        usdc,
        TOKEN_PROGRAM_ID,
        usdcAccount(signer.publicKey),
        usdcAccount(holder),
      ),
    ],
    [signer],
  );

const giveBack = (how: "cancel" | "reject", signer: Keypair, holder: PublicKey, id: number) =>
  send(connection, [af.returnRedemption(how, signer.publicKey, mint, af.redemption(mint, holder, id), assetAccount(holder))], [signer]);

const fixAndCommit = async (period: number, entitlements: [PublicKey, bigint][]) => {
  await send(connection, [af.fixRegister(stranger.publicKey, mint, period)], [stranger]);
  const payout = af.payout(mint, period);
  const tree = entitlementTree(entitlements.map(([h, u]) => entitlementLeaf(payout, h, u)));
  const total = entitlements.reduce((s, [, u]) => s + u, 0n);
  await send(connection, [af.commitEntitlements(issuer.publicKey, mint, period, usdc, TOKEN_PROGRAM_ID, tree.root, total)], [issuer]);
};

const redeem = (holder: PublicKey, holding = assetAccount(holder)) =>
  send(
    connection,
    [
      createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, usdcAccount(holder), holder, usdc, TOKEN_PROGRAM_ID),
      af.redeemAtMaturity(stranger.publicKey, registry, mint, usdc, TOKEN_PROGRAM_ID, holding, holder, usdcAccount(holder)),
    ],
    [stranger],
  );

describe("redemptions and maturity", () => {
  before(async () => {
    for (const k of [issuer, alice, bob, carol, stranger]) {
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
        af.setJurisdiction(issuer.publicKey, registry, SINGAPORE, true),
        af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, profile(HONG_KONG)),
        af.setInvestorProfile(issuer.publicKey, registry, bob.publicKey, profile(SINGAPORE)),
        af.setInvestorProfile(issuer.publicKey, registry, carol.publicKey, profile(HONG_KONG)),
      ],
      [issuer],
    );
    await send(
      connection,
      [...(await createServicedMint(connection, issuer.publicKey, mint, af.asset(mint), 0)), af.registerAsset(issuer.publicKey, issuer.publicKey, registry, mint)],
      [issuer, mintKey],
    );
    for (const [holder, n] of [[alice, 3_000n], [bob, 1_000n], [carol, 1_500n]] as const) {
      await send(
        connection,
        [
          createAssociatedTokenAccountIdempotentInstruction(issuer.publicKey, assetAccount(holder.publicKey), holder.publicKey, mint, TOKEN_2022_PROGRAM_ID),
          TokenAcl.permissionless("thaw", issuer.publicKey, mint, assetAccount(holder.publicKey), holder.publicKey, programId, af.gateAccounts("thaw", mint, registry, holder.publicKey)),
          af.issue(issuer.publicKey, registry, mint, assetAccount(holder.publicKey), holder.publicKey, n),
        ],
        [issuer],
      );
    }

    // Period 0 began three months ago (UTC midnight) and its record date is a
    // minute away; period 1 follows, with its record date just after.
    const today = new Date();
    const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, today.getUTCDate()) / 1000;
    const mid = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 3, today.getUTCDate()) / 1000;
    const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 9, today.getUTCDate()) / 1000;
    const t = now();
    periods = [
      { accrualStart: start, accrualEnd: mid, recordTs: t + 60, paymentTs: t + 61 },
      { accrualStart: mid, accrualEnd: end, recordTs: t + 75, paymentTs: t + 76 },
    ];
    await send(connection, [af.setTerms(issuer.publicKey, mint, usdc, USD, 1_000, periods)], [issuer]);
  });

  it("moves requested units into the asset's escrow", async () => {
    await ask(alice, 0, 1_000n);
    assert.equal(await units(alice.publicKey), 2_000n);
    assert.equal((await getAccount(connection, af.escrow(mint), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 1_000n);
    assert.equal((await request(alice.publicKey, 0)).status, "requested");
  });

  it("lets only the issuer settle", async () => {
    await send(
      connection,
      [createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, usdcAccount(stranger.publicKey), stranger.publicKey, usdc, TOKEN_PROGRAM_ID)],
      [stranger],
    );
    await refused(settle(alice.publicKey, 0, stranger), /Unauthorized/);
  });

  it("settles at face plus the interest accrued so far, burning the units in the same step", async () => {
    const before = await cash(issuer.publicKey);
    await settle(alice.publicKey, 0);
    // US$1,000 of face; 10% a year on it for the 30/360 days since the period began, to the cent
    const raw = (1_000n * USD * 1_000n * BigInt(days30360(periods[0].accrualStart, now()))) / (10_000n * 360n);
    const interest = raw - (raw % 10_000n);
    assert.ok(interest > 0n);
    assert.equal(await cash(alice.publicKey), 1_000n * USD + interest);
    assert.equal(before - (await cash(issuer.publicKey)), 1_000n * USD + interest);
    assert.equal(await supply(), 4_500n);
    assert.deepEqual(await request(alice.publicKey, 0), { status: "settled", principal: 1_000n * USD, interest });
  });

  it("answers a request only once", async () => {
    await refused(settle(alice.publicKey, 0), /RequestClosed/);
    await refused(giveBack("cancel", alice, alice.publicKey, 0), /RequestClosed/);
  });

  it("lets the holder, and only the holder, withdraw a request", async () => {
    await ask(bob, 0, 400n);
    await refused(giveBack("cancel", stranger, bob.publicKey, 0), /Unauthorized/);
    await giveBack("cancel", bob, bob.publicKey, 0);
    assert.equal(await units(bob.publicKey), 1_000n);
    assert.equal((await request(bob.publicKey, 0)).status, "cancelled");
  });

  it("will not pay a holder who is no longer eligible; rejecting returns the units to their frozen account", async () => {
    await ask(carol, 0, 500n);
    await send(
      connection,
      [
        af.setInvestorProfile(issuer.publicKey, registry, carol.publicKey, profile(HONG_KONG, true)),
        af.forceFreeze(issuer.publicKey, registry, mint, assetAccount(carol.publicKey), 1),
      ],
      [issuer],
    );
    await refused(settle(carol.publicKey, 0), /NotEligible/);
    await refused(giveBack("reject", bob, carol.publicKey, 0), /Unauthorized/);
    await giveBack("reject", issuer, carol.publicKey, 0);
    const account = await getAccount(connection, assetAccount(carol.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(account.amount, 1_500n);
    assert.ok(account.isFrozen, "still frozen");
    assert.equal((await request(carol.publicKey, 0)).status, "rejected");
  });

  it("refuses to start maturity before the last payment date", async () => {
    await ask(bob, 1, 200n); // left open over both record dates
    await refused(send(connection, [af.startMaturity(stranger.publicKey, mint, usdc, TOKEN_PROGRAM_ID, 2)], [stranger]), /MaturityNotReached/);
  });

  it("takes no request while the register is fixed; escrowed units count to their holder", async () => {
    await sleepUntil(periods[0].recordTs);
    await send(connection, [af.fixRegister(stranger.publicKey, mint, 0)], [stranger]);
    await refused(ask(alice, 1, 1n), /MintPaused/);
    const payout = af.payout(mint, 0);
    // Bob's 200 in escrow are still his: 800 in his account plus 200 waiting.
    const tree = entitlementTree([
      entitlementLeaf(payout, alice.publicKey, 2_000n),
      entitlementLeaf(payout, bob.publicKey, 1_000n),
      entitlementLeaf(payout, carol.publicKey, 1_500n),
    ]);
    await send(connection, [af.commitEntitlements(issuer.publicKey, mint, 0, usdc, TOKEN_PROGRAM_ID, tree.root, 4_500n)], [issuer]);
  });

  it("will not mature while a coupon's register is still open", async () => {
    await sleepUntil(periods[1].paymentTs);
    await refused(send(connection, [af.startMaturity(stranger.publicKey, mint, usdc, TOKEN_PROGRAM_ID, 2)], [stranger]), /CouponsOutstanding/);
    await fixAndCommit(1, [
      [alice.publicKey, 2_000n],
      [bob.publicKey, 1_000n],
      [carol.publicKey, 1_500n],
    ]);
  });

  it("matures: no unit can be issued or put up for early redemption again", async () => {
    await send(connection, [af.startMaturity(stranger.publicKey, mint, usdc, TOKEN_PROGRAM_ID, 2)], [stranger]);
    assert.equal((await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).mintAuthority, null);
    await refused(
      send(connection, [af.issue(issuer.publicKey, registry, mint, assetAccount(alice.publicKey), alice.publicKey, 1n)], [issuer]),
      /AssetMatured/,
    );
    await refused(ask(alice, 1, 1n), /AssetMatured/);
    await refused(settle(bob.publicKey, 1), /AssetMatured/);
  });

  it("pays nothing until all the principal is funded", async () => {
    await refused(redeem(alice.publicKey), /Underfunded/);
    await send(connection, [af.fundMaturity(issuer.publicKey, mint, usdc, TOKEN_PROGRAM_ID, usdcAccount(issuer.publicKey), 4_499n * USD)], [issuer]);
    await refused(redeem(alice.publicKey), /Underfunded/);
    await send(connection, [af.fundMaturity(issuer.publicKey, mint, usdc, TOKEN_PROGRAM_ID, usdcAccount(issuer.publicKey), 1n * USD)], [issuer]);
  });

  it("lets anyone redeem a holding at face, once", async () => {
    const before = await cash(alice.publicKey);
    await redeem(alice.publicKey);
    assert.equal((await cash(alice.publicKey)) - before, 2_000n * USD);
    assert.equal(await units(alice.publicKey), 0n);
    await refused(redeem(alice.publicKey), /InvalidAmount/);
  });

  it("never redeems the escrow itself; a request still open is withdrawn, then redeemed", async () => {
    await refused(redeem(af.asset(mint), af.escrow(mint)), /NotAHolding/);
    await giveBack("cancel", bob, bob.publicKey, 1);
    await redeem(bob.publicKey);
    assert.equal(await cash(bob.publicKey), 1_000n * USD);
  });

  it("keeps an ineligible holder's units and principal until they are cleared", async () => {
    await refused(redeem(carol.publicKey), /NotEligible/);
    await send(connection, [af.setInvestorProfile(issuer.publicKey, registry, carol.publicKey, profile(HONG_KONG))], [issuer]);
    await refused(redeem(carol.publicKey), /HoldingFrozen/);
    await send(
      connection,
      [TokenAcl.permissionless("thaw", stranger.publicKey, mint, assetAccount(carol.publicKey), carol.publicKey, programId, af.gateAccounts("thaw", mint, registry, carol.publicKey))],
      [stranger],
    );
    await redeem(carol.publicKey);
    assert.equal(await cash(carol.publicKey), 1_500n * USD);
  });

  it("ends with nothing outstanding and every dollar funded paid", async () => {
    assert.equal(await supply(), 0n);
    assert.equal((await getAccount(connection, af.maturityVault(mint), "confirmed", TOKEN_PROGRAM_ID)).amount, 0n);
    const data = (await connection.getAccountInfo(af.maturityRecord(mint, carol.publicKey)))!.data;
    // MaturityRecord: discriminator, maturity, holder, units, amount
    assert.equal(data.readBigUInt64LE(8 + 32 + 32), 1_500n);
    assert.equal(data.readBigUInt64LE(8 + 32 + 32 + 8), 1_500n * USD);
  });
});
