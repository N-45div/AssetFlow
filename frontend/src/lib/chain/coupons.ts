/**
 * Coupons in the browser: the same instructions, accounts, entitlement tree
 * and coupon arithmetic as the program (solana/programs/assetflow/src/coupons.rs),
 * so the console can show what a payment will cost before anyone signs.
 */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";

const IX = {
  set_terms: [198, 18, 197, 226, 220, 230, 87, 173],
  fix_register: [149, 92, 228, 109, 14, 243, 82, 199],
  commit_entitlements: [143, 200, 170, 19, 197, 80, 163, 247],
  fund_payout: [29, 105, 203, 76, 139, 85, 21, 111],
  pay_entitlement: [164, 119, 134, 1, 234, 77, 48, 71],
} as const;

const ACCOUNT = {
  Terms: [223, 24, 40, 223, 249, 219, 14, 97],
  Payout: [69, 45, 245, 131, 218, 101, 158, 228],
  PaymentRecord: [202, 168, 56, 249, 127, 226, 86, 226],
} as const;

export interface Period {
  /** Nominal accrual dates, unix seconds at UTC midnight. */
  accrualStart: number;
  accrualEnd: number;
  recordTs: number;
  paymentTs: number;
}

export interface Terms {
  address: PublicKey;
  asset: PublicKey;
  currencyMint: PublicKey;
  currencyDecimals: number;
  facePerUnit: bigint;
  couponBps: number;
  periods: Period[];
}

export type PayoutStatus = "registerFixed" | "committed";

export interface Payout {
  address: PublicKey;
  period: number;
  status: PayoutStatus;
  fixedTs: number;
  fixedSlot: bigint;
  supplyAtFix: bigint;
  root: Buffer;
  totalUnits: bigint;
  required: bigint;
  funded: bigint;
  paid: bigint;
  heldBack: bigint;
  payments: number;
}

export interface PaymentRecord {
  holder: PublicKey;
  units: bigint;
  amount: bigint;
  heldBack: boolean;
  ts: number;
}

const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const signer = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: true, isWritable });
const account = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: false, isWritable });
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export class Coupons {
  constructor(readonly programId: PublicKey) {}

  asset(mint: PublicKey) {
    return pda([Buffer.from("asset"), mint.toBuffer()], this.programId);
  }
  investor(registry: PublicKey, wallet: PublicKey) {
    return pda([Buffer.from("investor"), registry.toBuffer(), wallet.toBuffer()], this.programId);
  }
  terms(mint: PublicKey) {
    return pda([Buffer.from("terms"), mint.toBuffer()], this.programId);
  }
  payout(mint: PublicKey, period: number) {
    return pda([Buffer.from("payout"), mint.toBuffer(), Buffer.from([period])], this.programId);
  }
  vault(payout: PublicKey) {
    return pda([Buffer.from("payout_vault"), payout.toBuffer()], this.programId);
  }
  paymentRecord(payout: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("paid"), payout.toBuffer(), holder.toBuffer()], this.programId);
  }

  private ix(name: keyof typeof IX, keys: AccountMeta[], args: Buffer[]) {
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data: Buffer.concat([Buffer.from(IX[name]), ...args]),
    });
  }

  setTerms(issuer: PublicKey, mint: PublicKey, currencyMint: PublicKey, facePerUnit: bigint, couponBps: number, periods: Period[]) {
    return this.ix(
      "set_terms",
      [signer(issuer, true), account(this.asset(mint)), account(currencyMint), account(this.terms(mint), true), account(SystemProgram.programId)],
      [
        u64(facePerUnit),
        u16(couponBps),
        u32(periods.length),
        ...periods.flatMap((p) => [i64(p.accrualStart), i64(p.accrualEnd), i64(p.recordTs), i64(p.paymentTs)]),
      ],
    );
  }

  fixRegister(caller: PublicKey, mint: PublicKey, period: number) {
    return this.ix(
      "fix_register",
      [
        signer(caller, true),
        account(this.asset(mint)),
        account(this.terms(mint)),
        account(mint, true),
        account(this.payout(mint, period), true),
        account(TOKEN_2022_PROGRAM_ID),
        account(SystemProgram.programId),
      ],
      [u8(period)],
    );
  }

  commitEntitlements(issuer: PublicKey, mint: PublicKey, period: number, currencyMint: PublicKey, currencyProgram: PublicKey, root: Buffer, totalUnits: bigint) {
    const payout = this.payout(mint, period);
    return this.ix(
      "commit_entitlements",
      [
        signer(issuer, true),
        account(this.asset(mint)),
        account(this.terms(mint)),
        account(mint, true),
        account(payout, true),
        account(currencyMint),
        account(this.vault(payout), true),
        account(TOKEN_2022_PROGRAM_ID),
        account(currencyProgram),
        account(SystemProgram.programId),
      ],
      [u8(period), root, u64(totalUnits)],
    );
  }

  fundPayout(funder: PublicKey, mint: PublicKey, period: number, currencyMint: PublicKey, currencyProgram: PublicKey, source: PublicKey, amount: bigint) {
    const payout = this.payout(mint, period);
    return this.ix(
      "fund_payout",
      [
        signer(funder),
        account(this.asset(mint)),
        account(this.terms(mint)),
        account(mint),
        account(payout, true),
        account(currencyMint),
        account(source, true),
        account(this.vault(payout), true),
        account(currencyProgram),
      ],
      [u8(period), u64(amount)],
    );
  }

  payEntitlement(
    payer: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    period: number,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    destination: PublicKey,
    holder: PublicKey,
    units: bigint,
    proof: Buffer[],
  ) {
    const payout = this.payout(mint, period);
    return this.ix(
      "pay_entitlement",
      [
        signer(payer, true),
        account(this.asset(mint)),
        account(registry),
        account(this.terms(mint)),
        account(mint),
        account(payout, true),
        account(currencyMint),
        account(this.vault(payout), true),
        account(destination, true),
        account(this.investor(registry, holder)),
        account(this.paymentRecord(payout, holder), true),
        account(currencyProgram),
        account(SystemProgram.programId),
      ],
      [u8(period), holder.toBuffer(), u64(units), u32(proof.length), ...proof],
    );
  }

  async fetchTerms(connection: Connection, mint: PublicKey): Promise<Terms | null> {
    const address = this.terms(mint);
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.Terms)) return null;
    const r = new Reader(info.data);
    const asset = r.key();
    const currencyMint = r.key();
    const currencyDecimals = r.u8();
    const facePerUnit = r.u64();
    const couponBps = r.u16();
    const count = r.u32();
    const periods = Array.from({ length: count }, () => ({
      accrualStart: Number(r.i64()),
      accrualEnd: Number(r.i64()),
      recordTs: Number(r.i64()),
      paymentTs: Number(r.i64()),
    }));
    return { address, asset, currencyMint, currencyDecimals, facePerUnit, couponBps, periods };
  }

  async fetchPayout(connection: Connection, mint: PublicKey, period: number): Promise<Payout | null> {
    const address = this.payout(mint, period);
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.Payout)) return null;
    const r = new Reader(info.data);
    r.key(); // asset
    const p = r.u8();
    const status: PayoutStatus = r.u8() === 0 ? "registerFixed" : "committed";
    return {
      address,
      period: p,
      status,
      fixedTs: Number(r.i64()),
      fixedSlot: r.u64(),
      supplyAtFix: r.u64(),
      root: r.bytes(32),
      totalUnits: r.u64(),
      required: r.u64(),
      funded: r.u64(),
      paid: r.u64(),
      heldBack: r.u64(),
      payments: r.u32(),
    };
  }

  async fetchPayment(connection: Connection, payout: PublicKey, holder: PublicKey): Promise<PaymentRecord | null> {
    const info = await connection.getAccountInfo(this.paymentRecord(payout, holder));
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.PaymentRecord)) return null;
    const r = new Reader(info.data);
    r.key(); // payout
    return { holder: r.key(), units: r.u64(), amount: r.u64(), heldBack: r.bool(), ts: Number(r.i64()) };
  }
}

function hasDiscriminator(data: Buffer, expected: readonly number[]) {
  return expected.every((b, i) => data[i] === b);
}

class Reader {
  private at = 8;
  constructor(private readonly data: Buffer) {}
  bytes(n: number) {
    const v = Buffer.from(this.data.subarray(this.at, this.at + n));
    this.at += n;
    return v;
  }
  key() {
    return new PublicKey(this.bytes(32));
  }
  u8() {
    return this.data[this.at++];
  }
  bool() {
    return this.u8() === 1;
  }
  u16() {
    const v = this.data.readUInt16LE(this.at);
    this.at += 2;
    return v;
  }
  u32() {
    const v = this.data.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  u64() {
    const v = this.data.readBigUInt64LE(this.at);
    this.at += 8;
    return v;
  }
  i64() {
    const v = this.data.readBigInt64LE(this.at);
    this.at += 8;
    return v;
  }
}

/** Civil date for a day count since 1970-01-01 (Howard Hinnant), as the program does it. */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

export function days30360(startTs: number, endTs: number) {
  const [y1, m1, d1raw] = civilFromDays(Math.floor(startTs / 86_400));
  const [y2, m2, d2raw] = civilFromDays(Math.floor(endTs / 86_400));
  const d1 = d1raw === 31 ? 30 : d1raw;
  const d2 = d2raw === 31 && d1 >= 30 ? 30 : d2raw;
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
}

/** A holding's coupon for a period, rounded down to the cent: the program's formula. */
export function couponAmount(terms: Pick<Terms, "facePerUnit" | "couponBps" | "currencyDecimals">, period: Period, units: bigint) {
  const days = BigInt(days30360(period.accrualStart, period.accrualEnd));
  const raw = (units * terms.facePerUnit * BigInt(terms.couponBps) * days) / (10_000n * 360n);
  const cent = 10n ** BigInt(Math.max(0, terms.currencyDecimals - 2));
  return raw - (raw % cent);
}

async function sha256(...parts: Uint8Array[]) {
  const all = Buffer.concat(parts.map((p) => Buffer.from(p)));
  return Buffer.from(await crypto.subtle.digest("SHA-256", all));
}

export interface Entitlement {
  holder: PublicKey;
  units: bigint;
}

/**
 * The entitlement tree the program verifies: leaves over (payment, holder,
 * units) under domain byte 0, sorted pairs under domain byte 1, an odd node
 * carried up unchanged. Returns the root and each entitlement's proof.
 */
export async function entitlementTree(payout: PublicKey, entitlements: Entitlement[]) {
  const leaves = await Promise.all(
    entitlements.map((e) => sha256(Buffer.from([0]), payout.toBuffer(), e.holder.toBuffer(), u64(e.units))),
  );
  let level = leaves.map((hash, i) => ({ hash, members: [i] }));
  const proofs: Buffer[][] = leaves.map(() => []);
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      for (const m of a.members) proofs[m].push(b.hash);
      for (const m of b.members) proofs[m].push(a.hash);
      const [lo, hi] = Buffer.compare(a.hash, b.hash) <= 0 ? [a.hash, b.hash] : [b.hash, a.hash];
      next.push({ hash: await sha256(Buffer.from([1]), lo, hi), members: [...a.members, ...b.members] });
    }
    level = next;
  }
  return { root: level[0]?.hash ?? Buffer.alloc(32), proofs };
}

/**
 * The register as the chain holds it now: units per owner across every
 * holder account of the mint, leaving out accounts the asset itself owns.
 * Read while the mint is paused, this is the record-date register.
 */
export async function readRegister(connection: Connection, mint: PublicKey, asset: PublicKey): Promise<Entitlement[]> {
  const rows = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  const byOwner = new Map<string, Entitlement>();
  for (const row of rows) {
    let acct;
    try {
      acct = unpackAccount(row.pubkey, row.account, TOKEN_2022_PROGRAM_ID);
    } catch {
      continue;
    }
    if (acct.amount === 0n || acct.owner.equals(asset)) continue;
    const key = acct.owner.toBase58();
    const e = byOwner.get(key) ?? { holder: acct.owner, units: 0n };
    e.units += acct.amount;
    byOwner.set(key, e);
  }
  // A fixed order, so anyone who reads the same register builds the same tree.
  return [...byOwner.values()].sort((a, b) => Buffer.compare(a.holder.toBuffer(), b.holder.toBuffer()));
}
