/**
 * Private holdings, end to end on MagicBlock's local stack: Solana, an
 * ephemeral rollup, and the query filtering service that keeps private
 * accounts readable only by their permission's members (what the private
 * rollup's TEE endpoint does on devnet).
 *
 *   ASSETFLOW_SO=... bash tests/rollup.sh     # terminal 1: the stack, with a local-rollup build
 *   npx mocha ... tests/private.test.ts       # terminal 2
 *
 * Skipped when no rollup answers at ER_URL.
 *
 * Alice and Bob park units in private holdings and trade between themselves
 * there; Carol stays public. The note pays 10% a year on US$1 of face per
 * unit, so a regular half-year coupon is US$50.00 per 1,000 units.
 */
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  AssetFlow,
  DELEGATION_PROGRAM_ID,
  LOCAL_VALIDATOR,
  Period,
  ProfileTerms,
  TokenAcl,
  countInstructions,
  createServicedMint,
  registerSources,
  send,
} from "../client";

const HONG_KONG = 344;
const USD = 1_000_000n;

const programId = new PublicKey(
  /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(
    readFileSync(join(__dirname, "../programs/assetflow/src/lib.rs"), "utf8"),
  )![1],
);
const af = new AssetFlow(programId);
const connection = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
/** The rollup's own port: unfiltered, so used only to check it is up. */
const ER_URL = process.env.ER_URL ?? "http://127.0.0.1:7799";
/** The read filter in front of the rollup: every client goes through it. */
const QFS_URL = process.env.QFS_URL ?? "http://127.0.0.1:6699";

const issuer = Keypair.generate(); // also the registry's compliance officer
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate(); // public only
const dave = Keypair.generate(); // no profile: not eligible
const stranger = Keypair.generate();
const mintKey = Keypair.generate();
const mint = mintKey.publicKey;
const registry = af.registry(issuer.publicKey);
let usdc: PublicKey;
let periods: Period[];

const now = () => Math.floor(Date.now() / 1000);
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const profile = (frozen = false): ProfileTerms => ({
  approved: true,
  accredited: false,
  frozen,
  tier: 1,
  jurisdiction: HONG_KONG,
  expiry: now() + 86_400,
});
const assetAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
const usdcAccount = (owner: PublicKey) => getAssociatedTokenAddressSync(usdc, owner, false, TOKEN_PROGRAM_ID);
const units = async (owner: PublicKey) =>
  (await getAccount(connection, assetAccount(owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
const dollars = async (owner: PublicKey) =>
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry until `check` passes: the rollup sees Solana accounts a moment late. */
async function eventually<T>(check: () => Promise<T>, what: string, tries = 40): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await check();
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw new Error(`${what}: ${(last as Error)?.message ?? last}`);
}

async function sleepUntil(ts: number) {
  while (true) {
    const t = await connection.getBlockTime(await connection.getSlot("confirmed"));
    if (t !== null && t >= ts) return;
    await sleep(1_000);
  }
}

// --- the query filtering service: a signed challenge buys a read token ---

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function signMessage(signer: Keypair, message: Uint8Array) {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), signer.secretKey.subarray(0, 32)]);
  return sign(null, message, createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
}

const tokens = new Map<string, string>();
async function rollupFor(who: Keypair) {
  const key = who.publicKey.toBase58();
  if (!tokens.has(key)) {
    const { challenge } = await (await fetch(`${QFS_URL}/auth/challenge?pubkey=${key}`)).json();
    const signature = base58(signMessage(who, Buffer.from(challenge, "utf8")));
    const login = await fetch(`${QFS_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey: key, challenge, signature }),
    });
    tokens.set(key, (await login.json()).token);
  }
  return new Connection(`${QFS_URL}?token=${tokens.get(key)}`, "confirmed");
}

const sentToRollup = new Set<string>();

/** Send to the rollup, through the filter, paid by the first signer. */
async function sendRollup(ixs: TransactionInstruction[], signers: Keypair[]) {
  const er = await rollupFor(signers[0]);
  // The local rollup confirms in milliseconds, so a repeat of the same instructions can land in the
  // same slot under the same blockhash: the same transaction, refused as already processed. Wait
  // for the next blockhash instead.
  let { blockhash, lastValidBlockHeight } = await er.getLatestBlockhash("confirmed");
  let tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  for (let i = 0; i < 40 && sentToRollup.has(base58(tx.signature!)); i++) {
    await new Promise((r) => setTimeout(r, 50));
    ({ blockhash, lastValidBlockHeight } = await er.getLatestBlockhash("confirmed"));
    tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(...signers);
  }
  sentToRollup.add(base58(tx.signature!));
  const signature = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  // web3.js resolves with the error, or rejects with it bare when its status poll sees it first
  const err = await er
    .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")
    .then((status) => status.value.err, (e) => {
      if (e instanceof Error) throw e;
      return e;
    });
  if (err) {
    const logs = (await (await rollupFor(issuer)).getTransaction(signature, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages;
    const raw = (await new Connection(ER_URL, "confirmed").getTransaction(signature, { maxSupportedTransactionVersion: 0 }))?.meta
      ?.logMessages;
    const e: any = new Error(`rollup transaction failed: ${JSON.stringify(err)}`);
    e.logs = [...(logs ?? []), ...(raw ?? [])];
    throw e;
  }
  return signature;
}

// PrivateHolding: discriminator, asset, holder, then these.
const HOLDING = { units: 72, credited: 80, withdrawn: 88, cash: 96, cashWithdrawn: 104, hold: 112, protected: 113, next: 114, entitled: 116 };
async function holdingAs(reader: Keypair, holder: PublicKey) {
  const info = await (await rollupFor(reader)).getAccountInfo(af.privateHolding(mint, holder), "confirmed");
  if (!info) return null;
  const d = info.data;
  return {
    units: d.readBigUInt64LE(HOLDING.units),
    withdrawn: d.readBigUInt64LE(HOLDING.withdrawn),
    cash: d.readBigUInt64LE(HOLDING.cash),
    hold: d[HOLDING.hold] === 1,
    protected: d[HOLDING.protected] === 1,
    nextPeriod: d[HOLDING.next],
    entitled: (p: number) => d.readBigUInt64LE(HOLDING.entitled + 8 * p),
  };
}
const holding = async (holder: Keypair) => (await holdingAs(holder, holder.publicKey))!;

// PrivateLedger: discriminator, asset, holder, deposited, released, cash_released, next_period.
async function ledger(holder: PublicKey) {
  const d = (await connection.getAccountInfo(af.privateLedger(mint, holder), "confirmed"))!.data;
  return { deposited: d.readBigUInt64LE(72), released: d.readBigUInt64LE(80), nextPeriod: d[96] };
}

const ownerOnSolana = async (account: PublicKey) => (await connection.getAccountInfo(account, "confirmed"))?.owner;

/** Wait until the rollup's copy of a Solana account passes `check`. */
async function rollupSees(account: PublicKey, check: (data: Buffer | null) => boolean, what: string) {
  const er = new Connection(ER_URL, "confirmed");
  await eventually(async () => assert.ok(check((await er.getAccountInfo(account, "confirmed"))?.data ?? null)), what, 80);
}
// InvestorProfile: discriminator, registry, wallet, approved, accredited, then frozen.
const profileFrozen = (frozen: boolean) => (d: Buffer | null) => d !== null && d[8 + 32 + 32 + 2] === (frozen ? 1 : 0);

async function open(holder: Keypair) {
  await send(
    connection,
    [
      af.openPrivate(holder.publicKey, registry, mint, 0),
      af.delegatePrivateHolding(holder.publicKey, mint),
      af.delegatePrivateExit(holder.publicKey, mint),
    ],
    [holder],
  );
}

const deposit = (holder: Keypair, n: bigint, nextPeriod = 0) =>
  send(connection, [af.depositPrivate(holder.publicKey, registry, mint, assetAccount(holder.publicKey), nextPeriod, n)], [holder]);

/** Credit what the ledger shows, once the rollup sees it. */
async function credit(holder: Keypair, expected: bigint, nextPeriod = 0) {
  await eventually(async () => {
    await sendRollup([af.creditPrivate(mint, holder.publicKey, nextPeriod)], [holder]);
    assert.equal((await holding(holder)).units, expected);
  }, "credit");
}

const transferPrivate = (from: Keypair, to: Keypair, n: bigint, nextPeriod = 0) =>
  sendRollup([af.transferPrivate(from.publicKey, registry, mint, to.publicKey, nextPeriod, n)], [from]);

/** Withdraw in the rollup, wait for the exit ticket to settle on Solana, release, and re-arm the ticket. */
async function exit(holder: Keypair, n: bigint, cash: bigint, nextPeriod = 0) {
  await sendRollup([af.withdrawPrivate(holder.publicKey, mint, nextPeriod, n, cash)], [holder]);
  await eventually(async () => assert.ok((await ownerOnSolana(af.privateExit(mint, holder.publicKey)))?.equals(programId)), "exit settles", 80);
  await send(
    connection,
    [
      createAssociatedTokenAccountIdempotentInstruction(holder.publicKey, usdcAccount(holder.publicKey), holder.publicKey, usdc, TOKEN_PROGRAM_ID),
      af.releasePrivate(registry, mint, holder.publicKey, nextPeriod, assetAccount(holder.publicKey), usdc, TOKEN_PROGRAM_ID, usdcAccount(holder.publicKey)),
      af.delegatePrivateExit(holder.publicKey, mint),
    ],
    [holder],
  );
}

describe("private holdings in a MagicBlock private rollup", function () {
  before(async function () {
    const up = await fetch(ER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    }).catch(() => null);
    if (!up?.ok) this.skip();

    for (const k of [issuer, alice, bob, carol, dave, stranger]) {
      const sig = await connection.requestAirdrop(k.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
    usdc = await createMint(connection, issuer, issuer.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    const treasury = await getOrCreateAssociatedTokenAccount(connection, issuer, usdc, issuer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, issuer, usdc, treasury.address, issuer, 1_000n * USD, [], undefined, TOKEN_PROGRAM_ID);
    await send(
      connection,
      [
        af.createRegistry(issuer.publicKey, 1, false),
        af.setJurisdiction(issuer.publicKey, registry, HONG_KONG, true),
        af.setInvestorProfile(issuer.publicKey, registry, alice.publicKey, profile()),
        af.setInvestorProfile(issuer.publicKey, registry, bob.publicKey, profile()),
        af.setInvestorProfile(issuer.publicKey, registry, carol.publicKey, profile()),
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
    // The first record date comes after the private trading below.
    periods = [
      { accrualStart: utc(2026, 10, 1), accrualEnd: utc(2027, 4, 1), recordTs: now() + 150, paymentTs: now() + 160 },
      { accrualStart: utc(2027, 4, 1), accrualEnd: utc(2027, 10, 1), recordTs: now() + 3_600, paymentTs: now() + 7_200 },
    ];
    await send(connection, [af.setTerms(issuer.publicKey, mint, usdc, USD, 1_000, periods)], [issuer]);
  });

  it("opens private holdings only on MagicBlock's private validator", async () => {
    await refused(
      send(connection, [af.enablePrivateHoldings(issuer.publicKey, mint, usdc, TOKEN_PROGRAM_ID, Keypair.generate().publicKey)], [issuer]),
      /ValidatorNotAllowed/,
    );
    await send(connection, [af.enablePrivateHoldings(issuer.publicKey, mint, usdc, TOKEN_PROGRAM_ID, LOCAL_VALIDATOR)], [issuer]);
    // the escrow belongs to the asset and starts frozen: the gate will never open it
    const escrow = await getAccount(connection, af.privateEscrow(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.ok(escrow.owner.equals(af.asset(mint)));
    assert.ok(escrow.isFrozen);
  });

  it("lets eligible holders open a private account in the rollup, and nobody else", async () => {
    await refused(send(connection, [af.openPrivate(dave.publicKey, registry, mint, 0)], [dave]), /NotEligible/);
    await open(alice);
    await open(bob);
    assert.ok((await ownerOnSolana(af.privateHolding(mint, alice.publicKey)))?.equals(DELEGATION_PROGRAM_ID));
    assert.ok((await ownerOnSolana(af.privateExit(mint, alice.publicKey)))?.equals(DELEGATION_PROGRAM_ID));
  });

  it("credits nothing until the holding is readable only by its members", async () => {
    await deposit(alice, 1_000n);
    await deposit(bob, 500n);
    await refused(sendRollup([af.creditPrivate(mint, alice.publicKey, 0)], [alice]), /NotProtected/);
    for (const h of [alice, bob]) {
      await eventually(() => sendRollup([af.protectPrivate(registry, mint, h.publicKey)], [stranger]), "protect");
    }
    await credit(alice, 1_000n);
    await credit(bob, 500n);
    // the deposits themselves are public token movements on Solana
    assert.equal(await units(alice.publicKey), 2_000n);
    assert.equal((await getAccount(connection, af.privateEscrow(mint), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 1_500n);
  });

  it("shows a private balance to the holder, the issuer and compliance, and to nobody else", async () => {
    assert.equal((await holdingAs(alice, alice.publicKey))!.units, 1_000n);
    assert.equal((await holdingAs(issuer, alice.publicKey))!.units, 1_000n);
    assert.equal(await holdingAs(bob, alice.publicKey), null);
    assert.equal(await holdingAs(stranger, alice.publicKey), null);
    const noToken = await new Connection(QFS_URL, "confirmed").getAccountInfo(af.privateHolding(mint, alice.publicKey)).catch(() => null);
    assert.equal(noToken, null);
    // on Solana the holding still shows the zeros it was delegated with
    const onSolana = (await connection.getAccountInfo(af.privateHolding(mint, alice.publicKey), "confirmed"))!.data;
    assert.equal(onSolana.readBigUInt64LE(HOLDING.units), 0n);
  });

  it("moves units privately between eligible holders", async () => {
    await transferPrivate(alice, bob, 300n);
    assert.equal((await holding(alice)).units, 700n);
    assert.equal((await holding(bob)).units, 800n);
    // nothing moved on Solana
    assert.equal(await units(alice.publicKey), 2_000n);
    assert.equal(await units(bob.publicKey), 500n);
  });

  it("will not move units from someone else's holding, whoever pays", async () => {
    const forged = af.transferPrivate(bob.publicKey, registry, mint, bob.publicKey, 0, 1n);
    forged.keys[3].pubkey = af.privateHolding(mint, alice.publicKey); // Alice's holding as the source, signed by Bob
    await refused(sendRollup([forged], [bob]), /ConstraintSeeds|2006/);
  });

  it("will not move units to a holder who is no longer eligible", async () => {
    const bobProfile = af.investor(registry, bob.publicKey);
    await send(connection, [af.setInvestorProfile(issuer.publicKey, registry, bob.publicKey, profile(true))], [issuer]);
    await rollupSees(bobProfile, profileFrozen(true), "the rollup sees the hold");
    await refused(transferPrivate(alice, bob, 1n), /NotEligible/);
    await send(connection, [af.setInvestorProfile(issuer.publicKey, registry, bob.publicKey, profile())], [issuer]);
    await rollupSees(bobProfile, profileFrozen(false), "the rollup sees the release");
    await transferPrivate(alice, bob, 1n);
    await transferPrivate(bob, alice, 1n);
  });

  it("gives a stranger simulating someone else's withdrawal no hint of the balance", async () => {
    const er = await rollupFor(stranger);
    const simulate = async (n: bigint) => {
      const { blockhash } = await er.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: alice.publicKey, recentBlockhash: blockhash }).add(
        af.withdrawPrivate(alice.publicKey, mint, 0, n, 0n),
      );
      const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
      const res = await fetch(`${QFS_URL}?token=${tokens.get(stranger.publicKey.toBase58())}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "simulateTransaction",
          params: [raw, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }],
        }),
      });
      const { result } = await res.json();
      // every simulated commit is sent under a signature of its own
      const logs = (result?.value?.logs ?? null)?.map((l: string) => l.replace(/signature: \w+/, "signature: _"));
      return JSON.stringify({ err: result?.value?.err ?? null, logs });
    };
    assert.equal(await simulate(700n), await simulate(701n));
  });

  it("lets compliance hold a private holding: it takes units in but sends none out", async () => {
    await sendRollup([af.holdPrivate(issuer.publicKey, registry, mint, alice.publicKey, true)], [issuer]);
    await refused(sendRollup([af.holdPrivate(bob.publicKey, registry, mint, alice.publicKey, false)], [bob]), /Unauthorized|ConstraintHasOne|2001/);
    await transferPrivate(alice, bob, 50n); // succeeds, and moves nothing
    assert.equal((await holding(alice)).units, 700n);
    await transferPrivate(bob, alice, 50n);
    assert.equal((await holding(alice)).units, 750n);
    await sendRollup([af.holdPrivate(issuer.publicKey, registry, mint, alice.publicKey, false)], [issuer]);
    await transferPrivate(alice, bob, 50n);
    assert.equal((await holding(alice)).units, 700n);
  });

  it("takes units out through a public exit ticket and the escrow", async () => {
    await exit(alice, 200n, 0n);
    assert.equal(await units(alice.publicKey), 2_200n);
    assert.equal((await holding(alice)).units, 500n);
    assert.equal((await ledger(alice.publicKey)).released, 200n);
    assert.equal((await getAccount(connection, af.privateEscrow(mint), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 1_300n);
  });

  it("counts the private escrow as one line of the register and splits it inside the rollup", async () => {
    await sleepUntil(periods[0].recordTs);
    await send(connection, [af.fixRegister(stranger.publicKey, mint, 0, usdc, TOKEN_PROGRAM_ID)], [stranger]);
    // a fixed register stops private moves until it is recorded on each ledger
    await rollupSees(af.payout(mint, 0), (d) => d !== null && d.length > 0, "the rollup sees the fix");
    await refused(transferPrivate(alice, bob, 1n), /CheckpointRequired/);
    await refused(send(connection, [af.checkpointPrivateLedger(mint, alice.publicKey, 1)], [stranger]), /AccountNotInitialized|3012/);
    for (const h of [alice, bob]) await send(connection, [af.checkpointPrivateLedger(mint, h.publicKey, 0)], [stranger]);

    const ixs = await countInstructions(connection, af, stranger.publicKey, mint, 0, await registerSources(connection, af, mint));
    for (let i = 0; i < ixs.length; i += 4) await send(connection, ixs.slice(i, i + 4), [stranger]);
    await send(connection, [af.closeRegister(mint, 0)], [stranger]);
    // public: Alice 2,200, Bob 500, Carol 1,500; private pool 1,300: 5,500 in all
    const payout = (await connection.getAccountInfo(af.payout(mint, 0), "confirmed"))!.data;
    assert.equal(payout.readBigUInt64LE(8 + 32 + 1 + 1 + 8 + 8 + 8), 5_500n);

    // Moves after the cut do not change it: Alice's first move records her 500.
    await eventually(() => transferPrivate(alice, bob, 100n, 1), "the rollup sees the ledgers");
    assert.equal((await holding(alice)).entitled(0), 500n);
    assert.equal((await holding(bob)).entitled(0), 800n);
    assert.equal((await holding(alice)).units, 400n);
  });

  it("pays the pool's coupon into the private cash vault, and each private holder their own share", async () => {
    await send(
      connection,
      [af.fundPayout(issuer.publicKey, mint, 0, usdc, TOKEN_PROGRAM_ID, usdcAccount(issuer.publicKey), 275n * USD)],
      [issuer],
    );
    await send(connection, [af.payPrivatePool(mint, 0, usdc, TOKEN_PROGRAM_ID)], [stranger]);
    assert.equal((await getAccount(connection, af.privateCash(mint), "confirmed", TOKEN_PROGRAM_ID)).amount, 65n * USD);
    for (const h of [alice, bob]) {
      await eventually(() => sendRollup([af.claimPrivateCoupon(mint, h.publicKey, 0, 1)], [stranger]), "the rollup sees the pool paid");
    }
    // a second claim changes nothing
    await sendRollup([af.claimPrivateCoupon(mint, alice.publicKey, 0, 1)], [stranger]);
    assert.equal((await holding(alice)).cash, 25n * USD);
    assert.equal((await holding(bob)).cash, 40n * USD);
  });

  it("pays coupon cash out to the holder's own account", async () => {
    await exit(bob, 0n, 40n * USD, 1);
    assert.equal(await dollars(bob.publicKey), 40n * USD);
    assert.equal((await holding(bob)).cash, 0n);
  });

  it("lets a holder bring their holding back to Solana and take everything out", async () => {
    await send(connection, [af.requestPrivateExit(alice.publicKey, mint)], [alice]);
    await eventually(async () => assert.ok((await ownerOnSolana(af.privateHolding(mint, alice.publicKey)))?.equals(programId)), "the holding comes back", 120);
    await send(
      connection,
      [
        createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, usdcAccount(alice.publicKey), alice.publicKey, usdc, TOKEN_PROGRAM_ID),
        af.recoverPrivate(registry, mint, alice.publicKey, 1, assetAccount(alice.publicKey), usdc, TOKEN_PROGRAM_ID, usdcAccount(alice.publicKey)),
      ],
      [stranger],
    );
    assert.equal(await units(alice.publicKey), 2_600n);
    assert.equal(await dollars(alice.publicKey), 25n * USD);
    // Bob's 900 are all the escrow still holds
    assert.equal((await getAccount(connection, af.privateEscrow(mint), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 900n);
  });
});
