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

/** MagicBlock: the delegation program on Solana, and the rollup's own programs and accounts. */
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
/** MagicBlock's private (TEE) rollup validator, on devnet and mainnet. */
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/** The validator of MagicBlock's local development stack. */
export const LOCAL_VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

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
  /** What a holder was counted for: every account they held, and their escrowed units. */
  entitlement(payout: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("entitled"), payout.toBuffer(), holder.toBuffer()], this.programId);
  }
  /** Marks a holder account or a redemption request as counted for a payment. */
  counted(payout: PublicKey, source: PublicKey) {
    return pda([Buffer.from("counted"), payout.toBuffer(), source.toBuffer()], this.programId);
  }
  freezeMetas(mint: PublicKey) {
    return pda([Buffer.from("freeze_extra_account_metas"), mint.toBuffer()], this.programId);
  }
  redemption(mint: PublicKey, holder: PublicKey, id: number) {
    const n = Buffer.alloc(4);
    n.writeUInt32LE(id);
    return pda([Buffer.from("redemption"), mint.toBuffer(), holder.toBuffer(), n], this.programId);
  }
  privatePool(mint: PublicKey) {
    return pda([Buffer.from("private_pool"), mint.toBuffer()], this.programId);
  }
  /** Units in private holdings wait here, owned by the asset account. */
  privateEscrow(mint: PublicKey) {
    return pda([Buffer.from("private_escrow"), mint.toBuffer()], this.programId);
  }
  /** Private holders' coupons, until each takes theirs out. */
  privateCash(mint: PublicKey) {
    return pda([Buffer.from("private_cash"), mint.toBuffer()], this.programId);
  }
  privateLedger(mint: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("private_ledger"), mint.toBuffer(), holder.toBuffer()], this.programId);
  }
  privateHolding(mint: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("private_holding"), mint.toBuffer(), holder.toBuffer()], this.programId);
  }
  privateExit(mint: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("private_exit"), mint.toBuffer(), holder.toBuffer()], this.programId);
  }
  /** A holding's read permission in the rollup. */
  permission(account: PublicKey) {
    return pda([Buffer.from("permission:"), account.toBuffer()], PERMISSION_PROGRAM_ID);
  }
  /** The delegation program's accounts for `account` while it is in the rollup. */
  delegation(account: PublicKey) {
    return {
      buffer: pda([Buffer.from("buffer"), account.toBuffer()], this.programId),
      record: pda([Buffer.from("delegation"), account.toBuffer()], DELEGATION_PROGRAM_ID),
      metadata: pda([Buffer.from("delegation-metadata"), account.toBuffer()], DELEGATION_PROGRAM_ID),
      undelegationRequest: pda([Buffer.from("undelegation-request"), account.toBuffer()], DELEGATION_PROGRAM_ID),
    };
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

  /**
   * Anyone, once the record date has passed: pauses the mint for the register,
   * prices the payment from the supply and opens its vault. From the second
   * period on, the previous period's register must be counted.
   */
  fixRegister(caller: PublicKey, mint: PublicKey, period: number, currencyMint: PublicKey, currencyProgram: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "fix_register",
      [
        { pubkey: caller, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: payout, isSigner: false, isWritable: true },
        // an optional account Anchor reads as absent when it is the program id
        { pubkey: period > 0 ? this.payout(mint, period - 1) : this.programId, isSigner: false, isWritable: false },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: this.payoutVault(payout), isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(period)],
    );
  }

  /** Anyone, while the register is being counted: one holder account of the mint. */
  countHolding(caller: PublicKey, mint: PublicKey, period: number, holding: PublicKey, owner: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "count_holding",
      [
        { pubkey: caller, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payout, isSigner: false, isWritable: true },
        { pubkey: holding, isSigner: false, isWritable: false },
        { pubkey: this.counted(payout, holding), isSigner: false, isWritable: true },
        { pubkey: this.entitlement(payout, owner), isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(period)],
    );
  }

  /** Anyone, while the register is being counted: one open redemption request. */
  countRedemption(caller: PublicKey, mint: PublicKey, period: number, request: PublicKey, holder: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "count_redemption",
      [
        { pubkey: caller, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payout, isSigner: false, isWritable: true },
        { pubkey: request, isSigner: false, isWritable: false },
        { pubkey: this.counted(payout, request), isSigner: false, isWritable: true },
        { pubkey: this.entitlement(payout, holder), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(period)],
    );
  }

  /** Anyone, while the register is being counted: the private escrow, as one line. */
  countPrivatePool(mint: PublicKey, period: number) {
    return this.ix(
      "count_private_pool",
      [
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: this.payout(mint, period), isSigner: false, isWritable: true },
        { pubkey: this.privatePool(mint), isSigner: false, isWritable: false },
        { pubkey: this.privateEscrow(mint), isSigner: false, isWritable: false },
      ],
      [u8(period)],
    );
  }

  /** Anyone, once the count reaches the supply: the register is on record and the mint resumes. */
  closeRegister(mint: PublicKey, period: number) {
    return this.ix(
      "close_register",
      [
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: this.payout(mint, period), isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      [u8(period)],
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

  /**
   * Anyone: pays one holder what they were counted for, or holds their coupon
   * back if they are not eligible. The entitlement's rent goes back to
   * `rentReceiver`, whoever paid it.
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
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payout, isSigner: false, isWritable: true },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: this.payoutVault(payout), isSigner: false, isWritable: true },
        { pubkey: this.entitlement(payout, holder), isSigner: false, isWritable: true },
        { pubkey: rentReceiver, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
        { pubkey: this.paymentRecord(payout, holder), isSigner: false, isWritable: true },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(period), holder.toBuffer()],
    );
  }

  /** Anyone: the private pool's coupon, from the payment vault to the private cash vault. */
  payPrivatePool(mint: PublicKey, period: number, currencyMint: PublicKey, currencyProgram: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "pay_private_pool",
      [
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payout, isSigner: false, isWritable: true },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: this.payoutVault(payout), isSigner: false, isWritable: true },
        { pubkey: this.privatePool(mint), isSigner: false, isWritable: false },
        { pubkey: this.privateCash(mint), isSigner: false, isWritable: true },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
      ],
      [u8(period)],
    );
  }

  /** Anyone, once the register is counted: a counted marker's rent back to whoever paid it. */
  releaseCounted(mint: PublicKey, period: number, source: PublicKey, rentReceiver: PublicKey) {
    const payout = this.payout(mint, period);
    return this.ix(
      "release_counted",
      [
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payout, isSigner: false, isWritable: false },
        { pubkey: this.counted(payout, source), isSigner: false, isWritable: true },
        { pubkey: rentReceiver, isSigner: false, isWritable: true },
      ],
      [u8(period), source.toBuffer()],
    );
  }

  /** The issuer opens private holdings: the escrow, the coupon vault, and the rollup they live in. */
  enablePrivateHoldings(
    issuer: PublicKey,
    mint: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    validator: PublicKey,
    auditor: PublicKey = PublicKey.default,
  ) {
    return this.ix(
      "enable_private_holdings",
      [
        { pubkey: issuer, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: currencyMint, isSigner: false, isWritable: false },
        { pubkey: this.privatePool(mint), isSigner: false, isWritable: true },
        { pubkey: this.privateEscrow(mint), isSigner: false, isWritable: true },
        { pubkey: this.privateCash(mint), isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: currencyProgram, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [validator.toBuffer(), auditor.toBuffer()],
    );
  }

  setPrivateAuditor(issuer: PublicKey, mint: PublicKey, auditor: PublicKey) {
    return this.ix(
      "set_private_auditor",
      [
        { pubkey: issuer, isSigner: true, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.privatePool(mint), isSigner: false, isWritable: true },
      ],
      [auditor.toBuffer()],
    );
  }

  /**
   * An eligible holder opens their private account. `nextPeriod` is the first
   * period whose register is not fixed yet (the number of payouts that exist).
   */
  openPrivate(holder: PublicKey, registry: PublicKey, mint: PublicKey, nextPeriod: number) {
    return this.ix(
      "open_private",
      [
        { pubkey: holder, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: this.privatePool(mint), isSigner: false, isWritable: false },
        { pubkey: nextPeriod > 0 ? this.payout(mint, nextPeriod - 1) : this.programId, isSigner: false, isWritable: false },
        { pubkey: this.payout(mint, nextPeriod), isSigner: false, isWritable: false },
        { pubkey: this.privateLedger(mint, holder), isSigner: false, isWritable: true },
        { pubkey: this.privateHolding(mint, holder), isSigner: false, isWritable: true },
        { pubkey: this.privateExit(mint, holder), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      [u8(nextPeriod)],
    );
  }

  private delegatePrivate(name: string, holder: PublicKey, mint: PublicKey, account: PublicKey) {
    const d = this.delegation(account);
    return this.ix(name, [
      { pubkey: holder, isSigner: true, isWritable: true },
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: this.privatePool(mint), isSigner: false, isWritable: false },
      { pubkey: d.buffer, isSigner: false, isWritable: true },
      { pubkey: d.record, isSigner: false, isWritable: true },
      { pubkey: d.metadata, isSigner: false, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: this.programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  }

  /** The holder puts their holding in the rollup. */
  delegatePrivateHolding(holder: PublicKey, mint: PublicKey) {
    return this.delegatePrivate("delegate_private_holding", holder, mint, this.privateHolding(mint, holder));
  }

  /** The holder puts their exit ticket in the rollup, ready for the next exit. */
  delegatePrivateExit(holder: PublicKey, mint: PublicKey) {
    return this.delegatePrivate("delegate_private_exit", holder, mint, this.privateExit(mint, holder));
  }

  /** The holder moves units from their account into the private escrow. */
  depositPrivate(holder: PublicKey, registry: PublicKey, mint: PublicKey, source: PublicKey, nextPeriod: number, units: bigint) {
    return this.ix(
      "deposit_private",
      [
        { pubkey: holder, isSigner: true, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: this.privatePool(mint), isSigner: false, isWritable: true },
        { pubkey: this.privateLedger(mint, holder), isSigner: false, isWritable: true },
        { pubkey: this.payout(mint, nextPeriod), isSigner: false, isWritable: false },
        { pubkey: this.privateHolding(mint, holder), isSigner: false, isWritable: false },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: this.privateEscrow(mint), isSigner: false, isWritable: true },
        { pubkey: TokenAcl.mintConfig(mint), isSigner: false, isWritable: false },
        { pubkey: TOKEN_ACL_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      [u64(units)],
    );
  }

  /** Anyone, once register `period` is fixed: record it on a holder's private ledger. */
  checkpointPrivateLedger(mint: PublicKey, holder: PublicKey, period: number) {
    return this.ix("checkpoint_private_ledger", [
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: this.terms(mint), isSigner: false, isWritable: false },
      { pubkey: this.privateLedger(mint, holder), isSigner: false, isWritable: true },
      { pubkey: this.payout(mint, period), isSigner: false, isWritable: false },
    ]);
  }

  private payOutKeys(
    registry: PublicKey,
    mint: PublicKey,
    holder: PublicKey,
    nextPeriod: number,
    middle: TransactionInstruction["keys"],
    destination: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    cashDestination: PublicKey,
  ): TransactionInstruction["keys"] {
    return [
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: this.investor(registry, holder), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: this.privatePool(mint), isSigner: false, isWritable: true },
      { pubkey: this.privateLedger(mint, holder), isSigner: false, isWritable: true },
      { pubkey: this.payout(mint, nextPeriod), isSigner: false, isWritable: false },
      ...middle,
      { pubkey: this.privateEscrow(mint), isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: this.privateCash(mint), isSigner: false, isWritable: true },
      { pubkey: currencyMint, isSigner: false, isWritable: false },
      { pubkey: cashDestination, isSigner: false, isWritable: true },
      { pubkey: TokenAcl.mintConfig(mint), isSigner: false, isWritable: false },
      { pubkey: TOKEN_ACL_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: currencyProgram, isSigner: false, isWritable: false },
    ];
  }

  /** Anyone: pay out what a holder's settled exit ticket says they withdrew. */
  releasePrivate(
    registry: PublicKey,
    mint: PublicKey,
    holder: PublicKey,
    nextPeriod: number,
    destination: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    cashDestination: PublicKey,
  ) {
    return this.ix(
      "release_private",
      this.payOutKeys(
        registry,
        mint,
        holder,
        nextPeriod,
        [{ pubkey: this.privateExit(mint, holder), isSigner: false, isWritable: false }],
        destination,
        currencyMint,
        currencyProgram,
        cashDestination,
      ),
    );
  }

  /** The holder asks the delegation program to bring their holding back to Solana. */
  requestPrivateExit(holder: PublicKey, mint: PublicKey) {
    const holding = this.privateHolding(mint, holder);
    const d = this.delegation(holding);
    return this.ix("request_private_exit", [
      { pubkey: holder, isSigner: true, isWritable: true },
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: holding, isSigner: false, isWritable: false },
      { pubkey: this.programId, isSigner: false, isWritable: false },
      { pubkey: d.undelegationRequest, isSigner: false, isWritable: true },
      { pubkey: d.record, isSigner: false, isWritable: false },
      { pubkey: d.metadata, isSigner: false, isWritable: true },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  }

  /** Anyone, once a holding is back on Solana: pay out everything in it. */
  recoverPrivate(
    registry: PublicKey,
    mint: PublicKey,
    holder: PublicKey,
    nextPeriod: number,
    destination: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    cashDestination: PublicKey,
  ) {
    return this.ix(
      "recover_private",
      this.payOutKeys(
        registry,
        mint,
        holder,
        nextPeriod,
        [{ pubkey: this.privateHolding(mint, holder), isSigner: false, isWritable: true }],
        destination,
        currencyMint,
        currencyProgram,
        cashDestination,
      ),
    );
  }

  /** Rollup, anyone: give a holding its read permission, or rebuild it. */
  protectPrivate(registry: PublicKey, mint: PublicKey, holder: PublicKey) {
    const holding = this.privateHolding(mint, holder);
    return this.ix("protect_private", [
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: this.privatePool(mint), isSigner: false, isWritable: false },
      { pubkey: holding, isSigner: false, isWritable: true },
      { pubkey: this.permission(holding), isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ]);
  }

  /** Rollup, anyone: credit a holding with what its holder deposited. */
  creditPrivate(mint: PublicKey, holder: PublicKey, nextPeriod: number) {
    return this.ix("credit_private", [
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: this.privateHolding(mint, holder), isSigner: false, isWritable: true },
      { pubkey: this.privateLedger(mint, holder), isSigner: false, isWritable: false },
      { pubkey: this.payout(mint, nextPeriod), isSigner: false, isWritable: false },
    ]);
  }

  /** Rollup, the sender: move units to another holder's private holding. */
  transferPrivate(sender: PublicKey, registry: PublicKey, mint: PublicKey, recipient: PublicKey, nextPeriod: number, units: bigint) {
    return this.ix(
      "transfer_private",
      [
        { pubkey: sender, isSigner: true, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.privateHolding(mint, sender), isSigner: false, isWritable: true },
        { pubkey: this.privateHolding(mint, recipient), isSigner: false, isWritable: true },
        { pubkey: this.privateLedger(mint, sender), isSigner: false, isWritable: false },
        { pubkey: this.privateLedger(mint, recipient), isSigner: false, isWritable: false },
        { pubkey: this.investor(registry, sender), isSigner: false, isWritable: false },
        { pubkey: this.investor(registry, recipient), isSigner: false, isWritable: false },
        { pubkey: this.payout(mint, nextPeriod), isSigner: false, isWritable: false },
      ],
      [u64(units)],
    );
  }

  /**
   * Rollup, the holder (who must pay the transaction): take units and coupon
   * cash out of the holding; the exit ticket settles on Solana.
   */
  withdrawPrivate(holder: PublicKey, mint: PublicKey, nextPeriod: number, units: bigint, cash: bigint) {
    return this.ix(
      "withdraw_private",
      [
        { pubkey: holder, isSigner: true, isWritable: true },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.privateHolding(mint, holder), isSigner: false, isWritable: true },
        { pubkey: this.privateExit(mint, holder), isSigner: false, isWritable: true },
        { pubkey: this.privateLedger(mint, holder), isSigner: false, isWritable: false },
        { pubkey: this.payout(mint, nextPeriod), isSigner: false, isWritable: false },
        { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      ],
      [u64(units), u64(cash)],
    );
  }

  /** Rollup (or Solana, for a holding back there), anyone: credit a holding's coupon for `period`. */
  claimPrivateCoupon(mint: PublicKey, holder: PublicKey, period: number, nextPeriod: number) {
    return this.ix(
      "claim_private_coupon",
      [
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: this.terms(mint), isSigner: false, isWritable: false },
        { pubkey: this.payout(mint, period), isSigner: false, isWritable: false },
        { pubkey: this.privateHolding(mint, holder), isSigner: false, isWritable: true },
        { pubkey: this.privateLedger(mint, holder), isSigner: false, isWritable: false },
        { pubkey: this.payout(mint, nextPeriod), isSigner: false, isWritable: false },
      ],
      [u8(period)],
    );
  }

  /** Compliance puts a private holding on hold, or lifts the hold. */
  holdPrivate(compliance: PublicKey, registry: PublicKey, mint: PublicKey, holder: PublicKey, hold: boolean) {
    return this.ix(
      "hold_private",
      [
        { pubkey: compliance, isSigner: true, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: registry, isSigner: false, isWritable: false },
        { pubkey: this.privateHolding(mint, holder), isSigner: false, isWritable: true },
      ],
      [bool(hold)],
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

/** Anchor's account prefix: the first eight bytes of sha256("account:Name"). */
export function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/** One thing the register counts: a holder account, or an open redemption request. */
export type RegisterSource =
  | { kind: "holding"; address: PublicKey; owner: PublicKey; units: bigint }
  | { kind: "request"; address: PublicKey; holder: PublicKey; units: bigint };

/**
 * Every source the register of `mint` counts, read from the chain: each
 * Token-2022 account of the mint with units, except the asset's own (the
 * escrows), and each open redemption request. The program checks every one
 * as it is counted, so a wrong or missing source can only leave the count
 * short of the supply, never wrong.
 */
export async function registerSources(connection: Connection, af: AssetFlow, mint: PublicKey) {
  const asset = af.asset(mint);
  const sources: RegisterSource[] = [];
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  for (const { pubkey, account } of accounts) {
    if (account.data.length < 165) continue;
    const owner = new PublicKey(account.data.subarray(32, 64));
    const units = account.data.readBigUInt64LE(64);
    if (units === 0n || owner.equals(asset)) continue;
    sources.push({ kind: "holding", address: pubkey, owner, units });
  }
  const requests = await connection.getProgramAccounts(af.programId, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: accountDiscriminator("RedemptionRequest").toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 8, bytes: asset.toBase58() } },
    ],
  });
  for (const { pubkey, account } of requests) {
    // asset 8, holder 40, id 72, units 76, status 84 (0 = Requested)
    if (account.data[84] !== 0) continue;
    sources.push({
      kind: "request",
      address: pubkey,
      holder: new PublicKey(account.data.subarray(40, 72)),
      units: account.data.readBigUInt64LE(76),
    });
  }
  return sources;
}

/** The count instructions for `sources`, plus the private pool when the asset has one. */
export async function countInstructions(
  connection: Connection,
  af: AssetFlow,
  caller: PublicKey,
  mint: PublicKey,
  period: number,
  sources: RegisterSource[],
) {
  const ixs = sources.map((src) =>
    src.kind === "holding"
      ? af.countHolding(caller, mint, period, src.address, src.owner)
      : af.countRedemption(caller, mint, period, src.address, src.holder),
  );
  if (await connection.getAccountInfo(af.privatePool(mint), "confirmed")) ixs.push(af.countPrivatePool(mint, period));
  return ixs;
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
