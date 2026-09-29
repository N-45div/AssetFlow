/**
 * A hand-built client for the AssetFlow program and the parts of Token ACL it
 * relies on.
 *
 * Anchor's instruction layout is a stable convention: an eight-byte
 * `sha256("global:<name>")` prefix followed by borsh arguments. Building it
 * here keeps the tests free of the Anchor CLI and its generated IDL. Token ACL
 * is not Anchor: its instructions start with a single discriminator byte.
 */
import { createHash } from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMint2Instruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";

export const TOKEN_ACL_ID = new PublicKey("TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP");

/** Anchor's instruction prefix: the first eight bytes of sha256("global:name"). */
export function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

const u8 = (n: number) => Buffer.from([n]);
const bool = (b: boolean) => u8(b ? 1 : 0);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

export class AssetFlow {
  constructor(readonly programId: PublicKey) {}

  registry(admin: PublicKey) {
    return pda([Buffer.from("registry"), admin.toBuffer()], this.programId);
  }
  investor(registry: PublicKey, wallet: PublicKey) {
    return pda([Buffer.from("investor"), registry.toBuffer(), wallet.toBuffer()], this.programId);
  }
  asset(mint: PublicKey) {
    return pda([Buffer.from("asset"), mint.toBuffer()], this.programId);
  }
  thawMetas(mint: PublicKey) {
    return pda([Buffer.from("thaw_extra_account_metas"), mint.toBuffer()], this.programId);
  }
  terms(mint: PublicKey) {
    return pda([Buffer.from("terms"), mint.toBuffer()], this.programId);
  }
  payout(mint: PublicKey, period: number) {
    return pda([Buffer.from("payout"), mint.toBuffer(), Buffer.from([period])], this.programId);
  }
  payoutVault(payout: PublicKey) {
    return pda([Buffer.from("payout_vault"), payout.toBuffer()], this.programId);
  }
  paymentRecord(payout: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("paid"), payout.toBuffer(), holder.toBuffer()], this.programId);
  }
  freezeMetas(mint: PublicKey) {
    return pda([Buffer.from("freeze_extra_account_metas"), mint.toBuffer()], this.programId);
  }
  redemption(mint: PublicKey, holder: PublicKey, id: number) {
    const n = Buffer.alloc(4);
    n.writeUInt32LE(id);
    return pda([Buffer.from("redemption"), mint.toBuffer(), holder.toBuffer(), n], this.programId);
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

  private ix(name: string, keys: TransactionInstruction["keys"], args: Buffer[] = []) {
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data: Buffer.concat([discriminator(name), ...args]),
    });
  }

  createRegistry(admin: PublicKey, minTier: number, requireAccredited: boolean) {
    return this.ix(
      "create_registry",
      [
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: this.registry(admin), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(minTier), bool(requireAccredited)],
    );
  }

  setJurisdiction(compliance: PublicKey, registry: PublicKey, code: number, allowed: boolean) {
    return this.ix(
      "set_jurisdiction",
      [
        { pubkey: compliance, isSigner: true, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: true },
      ],
      [u16(code), bool(allowed)],
    );
  }

  setInvestorProfile(
    compliance: PublicKey,
    registry: PublicKey,
    wallet: PublicKey,
    t: ProfileTerms,
  ) {
    return this.ix(
      "set_investor_profile",
      [
        { pubkey: compliance, isSigner: true, isWritable: true },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.investor(registry, wallet), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [
        wallet.toBuffer(),
        bool(t.approved),
        bool(t.accredited),
        bool(t.frozen),
        u8(t.tier),
        u16(t.jurisdiction),
        i64(t.expiry),
      ],
    );
  }

  /**
   * One step: checks the mint, writes the gate's account lists, and hands the
   * mint's freeze authority to Token ACL with this program as the gate. The
   * mint's own key and the registry admin both sign.
   */
  registerAsset(issuer: PublicKey, admin: PublicKey, registry: PublicKey, mint: PublicKey) {
    return this.ix("register_asset", [
      { pubkey: issuer, isSigner: true, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: this.asset(mint), isSigner: false, isWritable: true },
      { pubkey: this.thawMetas(mint), isSigner: false, isWritable: true },
      { pubkey: this.freezeMetas(mint), isSigner: false, isWritable: true },
      { pubkey: TokenAcl.mintConfig(mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_ACL_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  }

  setCompliance(admin: PublicKey, registry: PublicKey, compliance: PublicKey) {
    return this.ix(
      "set_compliance",
      [
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: true },
      ],
      [compliance.toBuffer()],
    );
  }

  issue(
    issuer: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    amount: bigint,
  ) {
    return this.ix(
      "issue",
      [
        { pubkey: issuer, isSigner: true, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: this.investor(registry, owner), isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      [u64(amount)],
    );
  }

  /** Compliance freezes an account outright, through Token ACL's own freeze. */
  forceFreeze(compliance: PublicKey, registry: PublicKey, mint: PublicKey, tokenAccount: PublicKey, reason: number) {
    return this.ix(
      "force_freeze",
      [
        { pubkey: compliance, isSigner: true, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: TokenAcl.mintConfig(mint), isSigner: false, isWritable: false },
        { pubkey: TOKEN_ACL_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      [u16(reason)],
    );
  }

  setTerms(
    issuer: PublicKey,
    mint: PublicKey,
    currencyMint: PublicKey,
    facePerUnit: bigint,
    couponBps: number,
    periods: Period[],
  ) {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(periods.length);
    return this.ix(
      "set_terms",
      [
        { pubkey: issuer, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [
        u64(facePerUnit),
        u16(couponBps),
        count,
        ...periods.flatMap((q) => [i64(q.accrualStart), i64(q.accrualEnd), i64(q.recordTs), i64(q.paymentTs)]),
      ],
    );
  }

  /** Anyone, once the record date has passed: pauses the mint for the register. */
  fixRegister(caller: PublicKey, mint: PublicKey, period: number) {
    return this.ix(
      "fix_register",
      [
        { pubkey: caller, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: this.payout(mint, period), isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(period)],
    );
  }

  commitEntitlements(
    issuer: PublicKey,
    mint: PublicKey,
    period: number,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    root: Buffer,
    totalUnits: bigint,
  ) {
    const payout = this.payout(mint, period);
    return this.ix(
      "commit_entitlements",
      [
        { pubkey: issuer, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: payout, isSigner: false, isWritable: true },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: this.payoutVault(payout), isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(period), root, u64(totalUnits)],
    );
  }

  fundPayout(
    funder: PublicKey,
    mint: PublicKey,
    period: number,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    source: PublicKey,
    amount: bigint,
  ) {
    const payout = this.payout(mint, period);
    return this.ix(
      "fund_payout",
      [
        { pubkey: funder, isSigner: true, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payout, isSigner: false, isWritable: true },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: this.payoutVault(payout), isSigner: false, isWritable: true },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
      ],
      [u8(period), u64(amount)],
    );
  }

  /** Anyone: pays one holder, or holds their coupon back if they are not eligible. */
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
    const count = Buffer.alloc(4);
    count.writeUInt32LE(proof.length);
    return this.ix(
      "pay_entitlement",
      [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payout, isSigner: false, isWritable: true },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: this.payoutVault(payout), isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
        { pubkey: this.paymentRecord(payout, holder), isSigner: false, isWritable: true },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(period), holder.toBuffer(), u64(units), count, ...proof],
    );
  }

  /** The holder moves units into escrow. Creates the escrow the first time. */
  requestRedemption(holder: PublicKey, registry: PublicKey, mint: PublicKey, source: PublicKey, id: number, units: bigint) {
    const n = Buffer.alloc(4);
    n.writeUInt32LE(id);
    return [
      createAssociatedTokenAccountIdempotentInstruction(holder, this.escrow(mint), this.asset(mint), mint, TOKEN_2022_PROGRAM_ID),
      this.ix(
        "request_redemption",
        [
          { pubkey: holder, isSigner: true, isWritable: true },
          { pubkey: this.asset(mint), isSigner: false, isWritable: false },
          { pubkey: registry, isSigner: false, isWritable: false },
          { pubkey: this.terms(mint), isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: source, isSigner: false, isWritable: true },
          { pubkey: this.escrow(mint), isSigner: false, isWritable: true },
          { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
          { pubkey: this.redemption(mint, holder, id), isSigner: false, isWritable: true },
          { pubkey: TokenAcl.mintConfig(mint), isSigner: false, isWritable: false },
          { pubkey: TOKEN_ACL_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        [n, u64(units)],
      ),
    ];
  }

  settleRedemption(
    issuer: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    request: PublicKey,
    holder: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    source: PublicKey,
    destination: PublicKey,
  ) {
    return this.ix("settle_redemption", [
      { pubkey: issuer, isSigner: true, isWritable: false },
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: this.terms(mint), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: request, isSigner: false, isWritable: true },
      { pubkey: this.escrow(mint), isSigner: false, isWritable: true },
      { pubkey: currencyMint, isSigner: false, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
      { pubkey: TokenAcl.mintConfig(mint), isSigner: false, isWritable: false },
      { pubkey: TOKEN_ACL_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: currencyProgram, isSigner: false, isWritable: false },
    ]);
  }

  /** "cancel" by the holder, "reject" by the issuer: the units go back either way. */
  returnRedemption(how: "cancel" | "reject", authority: PublicKey, mint: PublicKey, request: PublicKey, destination: PublicKey) {
    return this.ix(`${how}_redemption`, [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: request, isSigner: false, isWritable: true },
      { pubkey: this.escrow(mint), isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: TokenAcl.mintConfig(mint), isSigner: false, isWritable: false },
      { pubkey: TOKEN_ACL_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ]);
  }

  /** Anyone, after the last payment date: hands over every period's payout to prove each was committed. */
  startMaturity(caller: PublicKey, mint: PublicKey, currencyMint: PublicKey, currencyProgram: PublicKey, periods: number) {
    return this.ix("start_maturity", [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: this.terms(mint), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: this.maturity(mint), isSigner: false, isWritable: true },
      { pubkey: currencyMint, isSigner: false, isWritable: false },
      { pubkey: this.maturityVault(mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: currencyProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...Array.from({ length: periods }, (_, i) => ({ pubkey: this.payout(mint, i), isSigner: false, isWritable: false })),
    ]);
  }

  fundMaturity(funder: PublicKey, mint: PublicKey, currencyMint: PublicKey, currencyProgram: PublicKey, source: PublicKey, amount: bigint) {
    return this.ix(
      "fund_maturity",
      [
        { pubkey: funder, isSigner: true, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: this.maturity(mint), isSigner: false, isWritable: true },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: this.maturityVault(mint), isSigner: false, isWritable: true },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
      ],
      [u64(amount)],
    );
  }

  /** Anyone: burns one holding and pays its owner the face. */
  redeemAtMaturity(
    payer: PublicKey,
    registry: PublicKey,
    mint: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    holding: PublicKey,
    holder: PublicKey,
    destination: PublicKey,
  ) {
    return this.ix("redeem_at_maturity", [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: this.maturity(mint), isSigner: false, isWritable: true },
      { pubkey: currencyMint, isSigner: false, isWritable: false },
      { pubkey: this.maturityVault(mint), isSigner: false, isWritable: true },
      { pubkey: holding, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
      { pubkey: this.maturityRecord(mint, holder), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: currencyProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  }

  kycSource(registry: PublicKey) {
    return pda([Buffer.from("kyc_source"), registry.toBuffer()], this.programId);
  }
  attested(registry: PublicKey, wallet: PublicKey) {
    return pda([Buffer.from("attested"), registry.toBuffer(), wallet.toBuffer()], this.programId);
  }

  /** Compliance names the SAS credential and schema the registry trusts, or stops trusting any. */
  setKycSource(compliance: PublicKey, registry: PublicKey, credential: PublicKey, schema: PublicKey, accept = true) {
    return this.ix(
      "set_kyc_source",
      [
        { pubkey: compliance, isSigner: true, isWritable: true },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.kycSource(registry), isSigner: false, isWritable: true },
        { pubkey: credential, isSigner: false, isWritable: false },
        { pubkey: schema, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [bool(accept)],
    );
  }

  /** Anyone: writes the wallet's profile from its attestation. */
  claimProfile(payer: PublicKey, registry: PublicKey, attestation: PublicKey, wallet: PublicKey) {
    return this.ix("claim_profile", [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: this.kycSource(registry), isSigner: false, isWritable: false },
      { pubkey: attestation, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: this.investor(registry, wallet), isSigner: false, isWritable: true },
      { pubkey: this.attested(registry, wallet), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  }

  /** Anyone: withdraws the approval of a profile its attestation no longer backs. */
  lapseProfile(registry: PublicKey, wallet: PublicKey, attestation: PublicKey) {
    return this.ix("lapse_profile", [
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: this.kycSource(registry), isSigner: false, isWritable: false },
      { pubkey: this.attested(registry, wallet), isSigner: false, isWritable: false },
      { pubkey: this.investor(registry, wallet), isSigner: false, isWritable: true },
      { pubkey: attestation, isSigner: false, isWritable: false },
    ]);
  }

  /** The accounts Token ACL must be handed so it can resolve the gate's list. */
  gateAccounts(question: "thaw" | "freeze", mint: PublicKey, registry: PublicKey, owner: PublicKey) {
    const list = question === "thaw" ? this.thawMetas(mint) : this.freezeMetas(mint);
    return [list, this.asset(mint), registry, this.investor(registry, owner)].map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    }));
  }
}

export interface Period {
  /** Nominal accrual dates, unix seconds at UTC midnight. */
  accrualStart: number;
  accrualEnd: number;
  recordTs: number;
  paymentTs: number;
}

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

/** A leaf: domain byte 0, the payment, the holder, their units (as the program hashes it). */
export function entitlementLeaf(payout: PublicKey, holder: PublicKey, units: bigint) {
  return sha256(Buffer.from([0]), payout.toBuffer(), holder.toBuffer(), u64(units));
}

/**
 * The entitlement tree: sorted pairs under domain byte 1, an odd node carried
 * up unchanged. Returns the root and a proof per leaf, in input order.
 */
export function entitlementTree(leaves: Buffer[]) {
  let level = leaves.map((leaf, i) => ({ hash: leaf, members: [i] }));
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
      next.push({ hash: sha256(Buffer.from([1]), lo, hi), members: [...a.members, ...b.members] });
    }
    level = next;
  }
  return { root: level[0]?.hash ?? Buffer.alloc(32), proofs };
}

export interface ProfileTerms {
  approved: boolean;
  accredited: boolean;
  frozen: boolean;
  tier: number;
  jurisdiction: number;
  expiry: number;
}

/** Token ACL, the Solana Foundation's sRFC-37 program. */
export const TokenAcl = {
  mintConfig(mint: PublicKey) {
    return pda([Buffer.from("MINT_CONFIG"), mint.toBuffer()], TOKEN_ACL_ID);
  },
  flag(tokenAccount: PublicKey) {
    return pda([Buffer.from("FLAG_ACCOUNT"), tokenAccount.toBuffer()], TOKEN_ACL_ID);
  },

  /**
   * The freeze authority's own thaw, which skips the gate. Only the asset
   * account holds that authority, so any personal key calling it is refused.
   */
  thaw(authority: PublicKey, mint: PublicKey, tokenAccount: PublicKey) {
    return new TransactionInstruction({
      programId: TOKEN_ACL_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: this.mintConfig(mint), isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: u8(4),
    });
  },

  /** Anyone may call these; the gate decides. 6 = thaw, 7 = freeze. */
  permissionless(
    question: "thaw" | "freeze",
    caller: PublicKey,
    mint: PublicKey,
    tokenAccount: PublicKey,
    owner: PublicKey,
    gate: PublicKey,
    gateAccounts: TransactionInstruction["keys"],
  ) {
    return new TransactionInstruction({
      programId: TOKEN_ACL_ID,
      keys: [
        { pubkey: caller, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: this.flag(tokenAccount), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: this.mintConfig(mint), isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: gate, isSigner: false, isWritable: false },
        ...gateAccounts,
      ],
      data: u8(question === "thaw" ? 6 : 7),
    });
  },
};

/**
 * The Solana Foundation's Solana Attestation Service: the instructions a KYC
 * provider uses. Its instructions start with a single discriminator byte, and
 * strings and lists are prefixed with a u32 length.
 */
export const SAS_ID = new PublicKey("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const lenPrefixed = (bytes: Buffer) => Buffer.concat([u32(bytes.length), bytes]);

export const Sas = {
  credential(authority: PublicKey, name: string) {
    return pda([Buffer.from("credential"), authority.toBuffer(), Buffer.from(name)], SAS_ID);
  },
  schema(credential: PublicKey, name: string, version = 1) {
    return pda([Buffer.from("schema"), credential.toBuffer(), Buffer.from(name), Buffer.from([version])], SAS_ID);
  },
  attestation(credential: PublicKey, schema: PublicKey, nonce: PublicKey) {
    return pda([Buffer.from("attestation"), credential.toBuffer(), schema.toBuffer(), nonce.toBuffer()], SAS_ID);
  },
  eventAuthority() {
    return pda([Buffer.from("__event_authority")], SAS_ID);
  },

  createCredential(payer: PublicKey, authority: PublicKey, name: string, signers: PublicKey[]) {
    return new TransactionInstruction({
      programId: SAS_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: this.credential(authority, name), isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([u8(0), lenPrefixed(Buffer.from(name)), u32(signers.length), ...signers.map((s) => s.toBuffer())]),
    });
  },

  /** layout: SAS type codes (0 = u8, 1 = u16, 10 = bool, 12 = string, ...). */
  createSchema(payer: PublicKey, authority: PublicKey, credential: PublicKey, name: string, description: string, layout: number[], fields: string[]) {
    return new TransactionInstruction({
      programId: SAS_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: credential, isSigner: false, isWritable: false },
        { pubkey: this.schema(credential, name), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        u8(1),
        lenPrefixed(Buffer.from(name)),
        lenPrefixed(Buffer.from(description)),
        lenPrefixed(Buffer.from(layout)),
        u32(fields.length),
        ...fields.map((f) => lenPrefixed(Buffer.from(f))),
      ]),
    });
  },

  createAttestation(payer: PublicKey, signer: PublicKey, credential: PublicKey, schema: PublicKey, nonce: PublicKey, data: Buffer, expiry: number) {
    return new TransactionInstruction({
      programId: SAS_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: credential, isSigner: false, isWritable: false },
        { pubkey: schema, isSigner: false, isWritable: false },
        { pubkey: this.attestation(credential, schema, nonce), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([u8(6), nonce.toBuffer(), lenPrefixed(data), i64(expiry)]),
    });
  },

  /** Revocation: the provider closes the attestation. */
  closeAttestation(payer: PublicKey, signer: PublicKey, credential: PublicKey, attestation: PublicKey) {
    return new TransactionInstruction({
      programId: SAS_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: credential, isSigner: false, isWritable: false },
        { pubkey: attestation, isSigner: false, isWritable: true },
        { pubkey: this.eventAuthority(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SAS_ID, isSigner: false, isWritable: false },
      ],
      data: u8(7),
    });
  },
};

/** An AssetFlow investor attestation's data: jurisdiction (u16), tier (u8), accredited (bool). */
export function investorAttestationData(jurisdiction: number, tier: number, accredited: boolean) {
  return Buffer.concat([u16(jurisdiction), u8(tier), bool(accredited)]);
}

/**
 * The instructions that create a serviced asset's mint. Every authority the
 * issuer would otherwise hold personally, the freeze authority included,
 * belongs to the asset account; registration then hands the freeze authority
 * on to Token ACL. `extra` lets a test build a mint that must be refused.
 */
export async function createServicedMint(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  asset: PublicKey,
  decimals: number,
  extra: { freezeAuthority?: PublicKey; closeAuthority?: PublicKey } = {},
) {
  const extensions = [
    ExtensionType.DefaultAccountState,
    ExtensionType.PermanentDelegate,
    ExtensionType.PausableConfig,
    ...(extra.closeAuthority ? [ExtensionType.MintCloseAuthority] : []),
  ];
  const space = getMintLen(extensions);
  return [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space,
      lamports: await connection.getMinimumBalanceForRentExemption(space),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, TOKEN_2022_PROGRAM_ID),
    createInitializePermanentDelegateInstruction(mint, asset, TOKEN_2022_PROGRAM_ID),
    createInitializePausableConfigInstruction(mint, asset, TOKEN_2022_PROGRAM_ID),
    ...(extra.closeAuthority
      ? [createInitializeMintCloseAuthorityInstruction(mint, extra.closeAuthority, TOKEN_2022_PROGRAM_ID)]
      : []),
    createInitializeMint2Instruction(
      mint,
      decimals,
      asset,
      extra.freezeAuthority ?? asset,
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
}

export async function send(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
) {
  return sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, {
    commitment: "confirmed",
  });
}
