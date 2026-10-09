/**
 * The circuit breaker for trading pools in the browser: the program's venue
 * instructions and record (solana/programs/assetflow/src/breaker.rs), and the
 * same price check it runs, so the console shows a pool's deviation before
 * anyone sends one.
 */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { Reader, hasDiscriminator, type Terms } from "./coupons";
import { accruedInterest, principal } from "./redemptions";

const IX = {
  approve_venue: [254, 60, 62, 30, 179, 64, 176, 184],
  decide_venue: [111, 173, 57, 76, 22, 91, 232, 171],
  check_venue: [161, 230, 42, 134, 216, 84, 98, 18],
  close_venue: [215, 242, 157, 178, 170, 32, 162, 56],
} as const;

const ACCOUNT = {
  Venue: [8, 155, 85, 226, 234, 173, 42, 242],
} as const;

/** The longest an allow decision may stand, as the program enforces it. */
export const MAX_DECISION_SECS = 7 * 24 * 60 * 60;

export interface Venue {
  address: PublicKey;
  registry: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  riskAuthority: PublicKey;
  allow: boolean;
  decidedAt: number;
  validUntil: number;
  maxDeviationBps: number;
  trippedAt: number;
}

/** Why a venue is or is not trading right now. */
export type VenueState = "open" | "tripped" | "blocked" | "expired" | "new";

export function isOpen(v: Venue, now: number) {
  return v.allow && now <= v.validUntil && v.decidedAt > v.trippedAt;
}

export function venueState(v: Venue, now: number): VenueState {
  if (isOpen(v, now)) return "open";
  if (v.trippedAt > 0 && v.trippedAt >= v.decidedAt) return "tripped";
  if (v.decidedAt === 0) return "new";
  if (!v.allow) return "blocked";
  return "expired";
}

/** What `units` of the bond are worth now: face plus accrued interest, the program's price. */
export function fairValue(terms: Terms, units: bigint, now: number) {
  return principal(terms.facePerUnit, units) + accruedInterest(terms, units, now);
}

/** How far `quote` strays from `fair`, in basis points; the program's formula. */
export function deviationBps(quote: bigint, fair: bigint) {
  if (fair === 0n) return quote === 0n ? 0 : Number.MAX_SAFE_INTEGER;
  const gap = quote > fair ? quote - fair : fair - quote;
  return Number((gap * 10_000n) / fair);
}

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const signer = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: true, isWritable });
const account = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: false, isWritable });
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const i64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

export class Breaker {
  constructor(readonly programId: PublicKey) {}

  /** A venue lives at its pool authority's investor address, where the gate looks. */
  venueAddress(registry: PublicKey, owner: PublicKey) {
    return pda([Buffer.from("investor"), registry.toBuffer(), owner.toBuffer()], this.programId);
  }
  private asset(mint: PublicKey) {
    return pda([Buffer.from("asset"), mint.toBuffer()], this.programId);
  }
  private terms(mint: PublicKey) {
    return pda([Buffer.from("terms"), mint.toBuffer()], this.programId);
  }
  private ix(name: keyof typeof IX, keys: AccountMeta[], args: Buffer[] = []) {
    return new TransactionInstruction({ programId: this.programId, keys, data: Buffer.concat([Buffer.from(IX[name]), ...args]) });
  }

  /** Compliance approves one pool account of the asset as a venue. It starts closed. */
  approveVenue(
    compliance: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    baseVault: PublicKey,
    quoteVault: PublicKey,
    owner: PublicKey,
    riskAuthority: PublicKey,
    maxDeviationBps: number,
  ) {
    return this.ix(
      "approve_venue",
      [
        signer(compliance, true),
        account(registry),
        account(this.asset(mint)),
        account(mint),
        account(this.terms(mint)),
        account(baseVault),
        account(quoteVault),
        account(this.venueAddress(registry, owner), true),
        account(SystemProgram.programId),
      ],
      [riskAuthority.toBuffer(), u16(maxDeviationBps)],
    );
  }

  /** The risk authority, or compliance: allow for `validFor` seconds, or block now. */
  decideVenue(authority: PublicKey, registry: PublicKey, venue: PublicKey, allow: boolean, validFor: number) {
    return this.ix(
      "decide_venue",
      [signer(authority), account(registry), account(venue, true)],
      [Buffer.from([allow ? 1 : 0]), i64(validFor)],
    );
  }

  /** Anyone: price the pool against the bond's own value; trips the venue past its band. */
  checkVenue(v: Venue) {
    return this.ix("check_venue", [account(v.address, true), account(this.terms(v.mint)), account(v.baseVault), account(v.quoteVault)]);
  }

  /** Compliance withdraws a venue. */
  closeVenue(compliance: PublicKey, registry: PublicKey, venue: PublicKey) {
    return this.ix("close_venue", [signer(compliance, true), account(registry), account(venue, true)]);
  }

  async fetchVenues(connection: Connection, registry: PublicKey, mint?: PublicKey): Promise<Venue[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.Venue).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: registry.toBase58() } },
      ],
    });
    return rows
      .map((r) => decodeVenue(r.pubkey, r.account.data))
      .filter((v): v is Venue => v !== null && (!mint || v.mint.equals(mint)));
  }
}

export function decodeVenue(address: PublicKey, data: Buffer): Venue | null {
  if (!hasDiscriminator(data, ACCOUNT.Venue)) return null;
  const r = new Reader(data);
  return {
    address,
    registry: r.key(),
    owner: r.key(),
    mint: r.key(),
    baseVault: r.key(),
    quoteVault: r.key(),
    riskAuthority: r.key(),
    allow: r.bool(),
    decidedAt: Number(r.i64()),
    validUntil: Number(r.i64()),
    maxDeviationBps: r.u16(),
    trippedAt: Number(r.i64()),
  };
}
