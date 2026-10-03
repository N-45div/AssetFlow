/**
 * Coupons in the browser: the same instructions, accounts and coupon
 * arithmetic as the program (solana/programs/assetflow/src/coupons.rs), so the
 * console can count a register and show what a payment will cost before
 * anyone signs.
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
  count_holding: [208, 92, 73, 78, 161, 17, 56, 114],
  count_redemption: [248, 137, 12, 188, 16, 148, 166, 75],
  count_private_pool: [222, 88, 145, 48, 187, 23, 45, 50],
  close_register: [24, 125, 130, 213, 123, 221, 152, 30],
  fund_payout: [29, 105, 203, 76, 139, 85, 21, 111],
  pay_entitlement: [164, 119, 134, 1, 234, 77, 48, 71],
  pay_private_pool: [30, 229, 49, 211, 115, 45, 33, 218],
  release_counted: [29, 198, 168, 94, 147, 106, 88, 130],
} as const;

const ACCOUNT = {
  Terms: [223, 24, 40, 223, 249, 219, 14, 97],
  Payout: [69, 45, 245, 131, 218, 101, 158, 228],
  Entitlement: [220, 250, 27, 244, 55, 49, 74, 154],
  CountedSource: [61, 26, 69, 19, 231, 2, 132, 248],
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

/** Counting: the mint is paused and anyone counts the register; counted: it is on record. */
export type PayoutStatus = "counting" | "counted";

export interface Payout {
  address: PublicKey;
  period: number;
  status: PayoutStatus;
  fixedTs: number;
  fixedSlot: bigint;
  supplyAtFix: bigint;
  /** Units counted so far; the register is complete at the supply. */
  counted: bigint;
  required: bigint;
  funded: bigint;
  paid: bigint;
  heldBack: bigint;
  payments: number;
  /** The private escrow, counted as one line, and its coupon. */
  privateCounted: boolean;
  privateUnits: bigint;
  privateCoupon: bigint;
  privatePaid: boolean;
}

/** What a holder was counted for, until their coupon is paid. */
export interface CountedEntitlement {
  address: PublicKey;
  holder: PublicKey;
  units: bigint;
  /** Paid the rent; gets it back when the coupon is paid. */
  payer: PublicKey;
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
  entitlement(payout: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("entitled"), payout.toBuffer(), holder.toBuffer()], this.programId);
  }
  counted(payout: PublicKey, source: PublicKey) {
    return pda([Buffer.from("counted"), payout.toBuffer(), source.toBuffer()], this.programId);
  }
  privatePool(mint: PublicKey) {
    return pda([Buffer.from("private_pool"), mint.toBuffer()], this.programId);
  }
  privateEscrow(mint: PublicKey) {
    return pda([Buffer.from("private_escrow"), mint.toBuffer()], this.programId);
  }
  privateCash(mint: PublicKey) {
    return pda([Buffer.from("private_cash"), mint.toBuffer()], this.programId);
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

  /**
   * Anyone, once the record date has passed: pauses the mint, prices the
   * payment and opens its vault. From the second period on, the previous
   * register must be counted.
   */
  fixRegister(caller: PublicKey, mint: PublicKey, period: number, currencyMint: PublicKey, currencyProgram: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "fix_register",
      [
        signer(caller, true),
        account(this.asset(mint)),
        account(this.terms(mint)),
        account(mint, true),
        account(payout, true),
        // an optional account, absent when it is the program id
        account(period > 0 ? this.payout(mint, period - 1) : this.programId),
        account(currencyMint),
        account(this.vault(payout), true),
        account(TOKEN_2022_PROGRAM_ID),
        account(currencyProgram),
        account(SystemProgram.programId),
      ],
      [u8(period)],
    );
  }

  /** Anyone, while the register is counted: one holder account of the mint. */
  countHolding(caller: PublicKey, mint: PublicKey, period: number, holding: PublicKey, owner: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "count_holding",
      [
        signer(caller, true),
        account(this.asset(mint)),
        account(mint),
        account(payout, true),
        account(holding),
        account(this.counted(payout, holding), true),
        account(this.entitlement(payout, owner), true),
        account(TOKEN_2022_PROGRAM_ID),
        account(SystemProgram.programId),
      ],
      [u8(period)],
    );
  }

  /** Anyone, while the register is counted: one open redemption request. */
  countRedemption(caller: PublicKey, mint: PublicKey, period: number, request: PublicKey, holder: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "count_redemption",
      [
        signer(caller, true),
        account(this.asset(mint)),
        account(mint),
        account(payout, true),
        account(request),
        account(this.counted(payout, request), true),
        account(this.entitlement(payout, holder), true),
        account(SystemProgram.programId),
      ],
      [u8(period)],
    );
  }

  /** Anyone, while the register is counted: the private escrow, as one line. */
  countPrivatePool(mint: PublicKey, period: number) {
    return this.ix(
      "count_private_pool",
      [
        account(this.asset(mint)),
        account(mint),
        account(this.payout(mint, period), true),
        account(this.privatePool(mint)),
        account(this.privateEscrow(mint)),
      ],
      [u8(period)],
    );
  }

  /** Anyone, once the count reaches the supply: the register is on record and the mint resumes. */
  closeRegister(mint: PublicKey, period: number) {
    return this.ix(
      "close_register",
      [account(this.asset(mint)), account(mint, true), account(this.payout(mint, period), true), account(TOKEN_2022_PROGRAM_ID)],
      [u8(period)],
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

  /**
   * Anyone: pay a holder what they were counted for, or hold the coupon back
   * if they are not eligible. The entitlement's rent goes back to whoever
   * counted it (`rentReceiver`).
   */
  payEntitlement(
    payer: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    period: number,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    destination: PublicKey,
    holder: PublicKey,
    rentReceiver: PublicKey,
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
        account(this.entitlement(payout, holder), true),
        account(rentReceiver, true),
        account(destination, true),
        account(this.investor(registry, holder)),
        account(this.paymentRecord(payout, holder), true),
        account(currencyProgram),
        account(SystemProgram.programId),
      ],
      [u8(period), holder.toBuffer()],
    );
  }

  /** Anyone: the private pool's coupon, from the payment vault into the private cash vault. */
  payPrivatePool(mint: PublicKey, period: number, currencyMint: PublicKey, currencyProgram: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "pay_private_pool",
      [
        account(this.asset(mint)),
        account(this.terms(mint)),
        account(mint),
        account(payout, true),
        account(currencyMint),
        account(this.vault(payout), true),
        account(this.privatePool(mint)),
        account(this.privateCash(mint), true),
        account(currencyProgram),
      ],
      [u8(period)],
    );
  }

  /** Anyone, once the register is counted: a counted marker's rent back to whoever paid it. */
  releaseCounted(mint: PublicKey, period: number, source: PublicKey, rentReceiver: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "release_counted",
      [account(this.asset(mint)), account(mint), account(payout), account(this.counted(payout, source), true), account(rentReceiver, true)],
      [u8(period), source.toBuffer()],
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
    const status: PayoutStatus = r.u8() === 0 ? "counting" : "counted";
    return {
      address,
      period: p,
      status,
      fixedTs: Number(r.i64()),
      fixedSlot: r.u64(),
      supplyAtFix: r.u64(),
      counted: r.u64(),
      required: r.u64(),
      funded: r.u64(),
      paid: r.u64(),
      heldBack: r.u64(),
      payments: r.u32(),
      privateCounted: r.bool(),
      privateUnits: r.u64(),
      privateCoupon: r.u64(),
      privatePaid: r.bool(),
    };
  }

  /** Every entitlement of a payment still waiting for its coupon. */
  async fetchEntitlements(connection: Connection, payout: PublicKey): Promise<CountedEntitlement[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.Entitlement).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: payout.toBase58() } },
      ],
    });
    return rows.map(({ pubkey, account: info }) => decodeEntitlement(pubkey, info.data));
  }

  /** Every coupon a payment has paid or held back. */
  async fetchPayments(connection: Connection, payout: PublicKey): Promise<PaymentRecord[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.PaymentRecord).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: payout.toBase58() } },
      ],
    });
    return rows.map(({ account: info }) => {
      const r = new Reader(info.data);
      r.key(); // payout
      return { holder: r.key(), units: r.u64(), amount: r.u64(), heldBack: r.bool(), ts: Number(r.i64()) };
    });
  }

  /** The markers a payment's count left, with whoever paid each one's rent. */
  async fetchMarkers(connection: Connection, payout: PublicKey): Promise<{ source: PublicKey; payer: PublicKey }[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.CountedSource).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: payout.toBase58() } },
      ],
    });
    return rows.map(({ account: info }) => {
      const r = new Reader(info.data);
      r.key(); // payout
      return { source: r.key(), payer: r.key() };
    });
  }

  async fetchEntitlement(connection: Connection, payout: PublicKey, holder: PublicKey): Promise<CountedEntitlement | null> {
    const address = this.entitlement(payout, holder);
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.Entitlement)) return null;
    return decodeEntitlement(address, info.data);
  }

  async fetchPayment(connection: Connection, payout: PublicKey, holder: PublicKey): Promise<PaymentRecord | null> {
    const info = await connection.getAccountInfo(this.paymentRecord(payout, holder));
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.PaymentRecord)) return null;
    const r = new Reader(info.data);
    r.key(); // payout
    return { holder: r.key(), units: r.u64(), amount: r.u64(), heldBack: r.bool(), ts: Number(r.i64()) };
  }
}

function decodeEntitlement(address: PublicKey, data: Buffer): CountedEntitlement {
  const r = new Reader(data);
  r.key(); // payout
  return { address, holder: r.key(), units: r.u64(), payer: r.key() };
}

export function hasDiscriminator(data: Buffer, expected: readonly number[]) {
  return expected.every((b, i) => data[i] === b);
}

export class Reader {
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

export interface Entitlement {
  holder: PublicKey;
  units: bigint;
}

/** One thing a register counts: a holder account, or an open redemption request. */
export type RegisterSource =
  | { kind: "holding"; address: PublicKey; owner: PublicKey; units: bigint }
  | { kind: "request"; address: PublicKey; holder: PublicKey; units: bigint };

/**
 * Every source the register of `mint` counts, read from the chain: each
 * holder account of the mint with units, except the asset's own (the escrows),
 * and each open redemption request. The program checks each one as it is
 * counted, so a source missing here leaves the count short of the supply,
 * never wrong.
 */
export async function registerSources(
  connection: Connection,
  mint: PublicKey,
  asset: PublicKey,
  openRequests: { address: PublicKey; holder: PublicKey; units: bigint }[],
): Promise<RegisterSource[]> {
  const rows = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  const sources: RegisterSource[] = [];
  for (const row of rows) {
    let acct;
    try {
      acct = unpackAccount(row.pubkey, row.account, TOKEN_2022_PROGRAM_ID);
    } catch {
      continue;
    }
    if (acct.amount === 0n || acct.owner.equals(asset)) continue;
    sources.push({ kind: "holding", address: row.pubkey, owner: acct.owner, units: acct.amount });
  }
  for (const r of openRequests) sources.push({ kind: "request", address: r.address, holder: r.holder, units: r.units });
  return sources;
}
