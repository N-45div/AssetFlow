/**
 * Redemptions and maturity in the browser: the program's instructions and
 * accounts (solana/programs/assetflow/src/redemptions.rs), and the price it
 * settles at, so a holder sees the amount before asking.
 */
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Reader, days30360, hasDiscriminator, type Entitlement, type Terms } from "./coupons";
import { TOKEN_ACL_ID } from "./program";

const IX = {
  request_redemption: [14, 62, 182, 237, 59, 79, 149, 22],
  settle_redemption: [21, 217, 64, 236, 36, 148, 2, 161],
  cancel_redemption: [197, 243, 101, 86, 2, 37, 105, 106],
  reject_redemption: [137, 154, 82, 200, 41, 45, 174, 61],
  start_maturity: [44, 145, 39, 164, 16, 189, 105, 122],
  fund_maturity: [194, 69, 134, 33, 103, 1, 145, 145],
  redeem_at_maturity: [36, 215, 239, 223, 72, 59, 123, 131],
} as const;

const ACCOUNT = {
  RedemptionRequest: [117, 157, 214, 214, 64, 160, 31, 58],
  Maturity: [110, 15, 67, 182, 221, 188, 158, 159],
  MaturityRecord: [203, 21, 70, 170, 210, 82, 66, 120],
} as const;

export type RedemptionStatus = "requested" | "settled" | "rejected" | "cancelled";
const STATUSES: RedemptionStatus[] = ["requested", "settled", "rejected", "cancelled"];

export interface RedemptionRequest {
  address: PublicKey;
  holder: PublicKey;
  id: number;
  units: bigint;
  status: RedemptionStatus;
  requestedTs: number;
  closedTs: number;
  principal: bigint;
  interest: bigint;
}

export interface Maturity {
  currencyMint: PublicKey;
  facePerUnit: bigint;
  startedTs: number;
  units: bigint;
  required: bigint;
  funded: bigint;
  paid: bigint;
  unitsRedeemed: bigint;
  redemptions: number;
}

export interface MaturityRecord {
  units: bigint;
  amount: bigint;
  ts: number;
}

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
const signer = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: true, isWritable });
const account = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: false, isWritable });
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export class Redemptions {
  constructor(readonly programId: PublicKey) {}

  asset(mint: PublicKey) {
    return pda([Buffer.from("asset"), mint.toBuffer()], this.programId);
  }
  terms(mint: PublicKey) {
    return pda([Buffer.from("terms"), mint.toBuffer()], this.programId);
  }
  investor(registry: PublicKey, wallet: PublicKey) {
    return pda([Buffer.from("investor"), registry.toBuffer(), wallet.toBuffer()], this.programId);
  }
  payout(mint: PublicKey, period: number) {
    return pda([Buffer.from("payout"), mint.toBuffer(), Buffer.from([period])], this.programId);
  }
  request(mint: PublicKey, holder: PublicKey, id: number) {
    return pda([Buffer.from("redemption"), mint.toBuffer(), holder.toBuffer(), u32(id)], this.programId);
  }
  /** Where requested units wait: the asset's own associated account. */
  escrow(mint: PublicKey) {
    return getAssociatedTokenAddressSync(mint, this.asset(mint), true, TOKEN_2022_PROGRAM_ID);
  }
  maturity(mint: PublicKey) {
    return pda([Buffer.from("maturity"), mint.toBuffer()], this.programId);
  }
  maturityVault(mint: PublicKey) {
    return pda([Buffer.from("maturity_vault"), this.maturity(mint).toBuffer()], this.programId);
  }
  maturityRecord(mint: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("redeemed"), this.maturity(mint).toBuffer(), holder.toBuffer()], this.programId);
  }
  private mintConfig(mint: PublicKey) {
    return pda([Buffer.from("MINT_CONFIG"), mint.toBuffer()], TOKEN_ACL_ID);
  }

  private ix(name: keyof typeof IX, keys: AccountMeta[], args: Buffer[] = []) {
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data: Buffer.concat([Buffer.from(IX[name]), ...args]),
    });
  }

  /** The holder moves units into escrow; the escrow is created the first time. */
  requestRedemption(holder: PublicKey, registry: PublicKey, mint: PublicKey, source: PublicKey, id: number, units: bigint) {
    const escrow = this.escrow(mint);
    return [
      createAssociatedTokenAccountIdempotentInstruction(holder, escrow, this.asset(mint), mint, TOKEN_2022_PROGRAM_ID),
      this.ix(
        "request_redemption",
        [
          signer(holder, true),
          account(this.asset(mint)),
          account(registry),
          account(this.terms(mint)),
          account(mint),
          account(source, true),
          account(escrow, true),
          account(this.investor(registry, holder)),
          account(this.request(mint, holder, id), true),
          account(this.mintConfig(mint)),
          account(TOKEN_ACL_ID),
          account(TOKEN_2022_PROGRAM_ID),
          account(SystemProgram.programId),
        ],
        [u32(id), u64(units)],
      ),
    ];
  }

  settleRedemption(
    issuer: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    request: RedemptionRequest,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
  ) {
    const source = getAssociatedTokenAddressSync(currencyMint, issuer, true, currencyProgram);
    const destination = getAssociatedTokenAddressSync(currencyMint, request.holder, true, currencyProgram);
    return [
      createAssociatedTokenAccountIdempotentInstruction(issuer, destination, request.holder, currencyMint, currencyProgram),
      this.ix("settle_redemption", [
        signer(issuer),
        account(this.asset(mint)),
        account(registry),
        account(this.terms(mint)),
        account(mint, true),
        account(request.address, true),
        account(this.escrow(mint), true),
        account(currencyMint),
        account(source, true),
        account(destination, true),
        account(this.investor(registry, request.holder)),
        account(this.mintConfig(mint)),
        account(TOKEN_ACL_ID),
        account(TOKEN_2022_PROGRAM_ID),
        account(currencyProgram),
      ]),
    ];
  }

  /** "cancel" by the holder, "reject" by the issuer: the units go back to the holder's account. */
  returnRedemption(how: "cancel" | "reject", authority: PublicKey, mint: PublicKey, request: RedemptionRequest) {
    const destination = getAssociatedTokenAddressSync(mint, request.holder, true, TOKEN_2022_PROGRAM_ID);
    return this.ix(how === "cancel" ? "cancel_redemption" : "reject_redemption", [
      signer(authority),
      account(this.asset(mint)),
      account(mint),
      account(request.address, true),
      account(this.escrow(mint), true),
      account(destination, true),
      account(this.mintConfig(mint)),
      account(TOKEN_ACL_ID),
      account(TOKEN_2022_PROGRAM_ID),
    ]);
  }

  /** Anyone, after the last payment date; every period's payout goes along to show it was committed. */
  startMaturity(caller: PublicKey, mint: PublicKey, currencyMint: PublicKey, currencyProgram: PublicKey, periods: number) {
    return this.ix("start_maturity", [
      signer(caller, true),
      account(this.asset(mint)),
      account(this.terms(mint)),
      account(mint, true),
      account(this.maturity(mint), true),
      account(currencyMint),
      account(this.maturityVault(mint), true),
      account(TOKEN_2022_PROGRAM_ID),
      account(currencyProgram),
      account(SystemProgram.programId),
      ...Array.from({ length: periods }, (_, i) => account(this.payout(mint, i))),
    ]);
  }

  fundMaturity(funder: PublicKey, mint: PublicKey, currencyMint: PublicKey, currencyProgram: PublicKey, amount: bigint) {
    return this.ix(
      "fund_maturity",
      [
        signer(funder),
        account(mint),
        account(this.maturity(mint), true),
        account(currencyMint),
        account(getAssociatedTokenAddressSync(currencyMint, funder, true, currencyProgram), true),
        account(this.maturityVault(mint), true),
        account(currencyProgram),
      ],
      [u64(amount)],
    );
  }

  /** Anyone: burn one holding and pay its owner the face. Creates the owner's cash account if needed. */
  redeemAtMaturity(
    payer: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    holding: PublicKey,
    holder: PublicKey,
  ) {
    const destination = getAssociatedTokenAddressSync(currencyMint, holder, true, currencyProgram);
    return [
      createAssociatedTokenAccountIdempotentInstruction(payer, destination, holder, currencyMint, currencyProgram),
      this.ix("redeem_at_maturity", [
        signer(payer, true),
        account(this.asset(mint)),
        account(registry),
        account(mint, true),
        account(this.maturity(mint), true),
        account(currencyMint),
        account(this.maturityVault(mint), true),
        account(holding, true),
        account(destination, true),
        account(this.investor(registry, holder)),
        account(this.maturityRecord(mint, holder), true),
        account(TOKEN_2022_PROGRAM_ID),
        account(currencyProgram),
        account(SystemProgram.programId),
      ]),
    ];
  }

  /** Every request for an asset, or one holder's, newest first. */
  async fetchRequests(connection: Connection, asset: PublicKey, holder?: PublicKey): Promise<RedemptionRequest[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.RedemptionRequest).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: asset.toBase58() } },
        ...(holder ? [{ memcmp: { offset: 40, bytes: holder.toBase58() } }] : []),
      ],
    });
    return rows
      .map(({ pubkey, account: info }) => {
        const r = new Reader(info.data);
        r.key(); // asset
        return {
          address: pubkey,
          holder: r.key(),
          id: r.u32(),
          units: r.u64(),
          status: STATUSES[r.u8()] ?? "requested",
          requestedTs: Number(r.i64()),
          closedTs: Number(r.i64()),
          principal: r.u64(),
          interest: r.u64(),
        };
      })
      .sort((a, b) => b.requestedTs - a.requestedTs || b.id - a.id);
  }

  async fetchMaturity(connection: Connection, mint: PublicKey): Promise<Maturity | null> {
    const info = await connection.getAccountInfo(this.maturity(mint));
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.Maturity)) return null;
    const r = new Reader(info.data);
    r.key(); // asset
    return {
      currencyMint: r.key(),
      facePerUnit: r.u64(),
      startedTs: Number(r.i64()),
      units: r.u64(),
      required: r.u64(),
      funded: r.u64(),
      paid: r.u64(),
      unitsRedeemed: r.u64(),
      redemptions: r.u32(),
    };
  }

  async fetchMaturityRecord(connection: Connection, mint: PublicKey, holder: PublicKey): Promise<MaturityRecord | null> {
    const info = await connection.getAccountInfo(this.maturityRecord(mint, holder));
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.MaturityRecord)) return null;
    const r = new Reader(info.data);
    r.key(); // maturity
    r.key(); // holder
    return { units: r.u64(), amount: r.u64(), ts: Number(r.i64()) };
  }

  /**
   * Units waiting in escrow, by holder. They are still the holder's: a
   * register read on a record date counts them to whoever asked to redeem.
   */
  async pending(connection: Connection, asset: PublicKey): Promise<Entitlement[]> {
    const open = (await this.fetchRequests(connection, asset)).filter((r) => r.status === "requested");
    return open.map((r) => ({ holder: r.holder, units: r.units }));
  }
}

/** The next free request id for a holder. */
export function nextRequestId(requests: RedemptionRequest[]) {
  return requests.reduce((max, r) => Math.max(max, r.id + 1), 0);
}

/** Face value of `units`, in currency base units. */
export function principal(facePerUnit: bigint, units: bigint) {
  return units * facePerUnit;
}

/**
 * Interest accrued on `units` at `now`: 30/360 from the start of the running
 * period, rounded down to the cent; nothing once that period's record date
 * has passed. The program's formula.
 */
export function accruedInterest(terms: Pick<Terms, "facePerUnit" | "couponBps" | "currencyDecimals" | "periods">, units: bigint, now: number) {
  const p = terms.periods.find((q) => q.accrualStart <= now && now < q.accrualEnd);
  if (!p || now >= p.recordTs) return 0n;
  const days = BigInt(Math.max(0, days30360(p.accrualStart, now)));
  const raw = (units * terms.facePerUnit * BigInt(terms.couponBps) * days) / (10_000n * 360n);
  const cent = 10n ** BigInt(Math.max(0, terms.currencyDecimals - 2));
  return raw - (raw % cent);
}

/** Maturity may start once the last payment date has passed. */
export function maturityDate(terms: Pick<Terms, "periods">) {
  return terms.periods[terms.periods.length - 1]?.paymentTs ?? 0;
}
