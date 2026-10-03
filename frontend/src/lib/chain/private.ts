/**
 * Private holdings in the browser: the instructions and accounts of the
 * program's private module (solana/programs/assetflow/src/private.rs), and
 * the sign-in to MagicBlock's private rollup.
 *
 * A holding lives in the rollup. Its balance can be read only through the
 * rollup's endpoint, with a token the wallet gets by signing a challenge,
 * and only by the holding's members: the holder, the issuer, compliance and
 * the auditor. Everything that touches Solana (opening, deposits, releases)
 * goes through the app's usual connection.
 */
import { Buffer } from "buffer";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { CLUSTER } from "./config";
import { hasDiscriminator, Reader } from "./coupons";
import { TOKEN_ACL_ID, TokenAcl } from "./program";

export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
/** MagicBlock's private (TEE) rollup validator, on devnet and mainnet. */
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/** The validator of MagicBlock's local development stack (solana/tests/rollup.sh). */
export const LOCAL_VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

/** The validator private holdings are delegated to on this cluster. */
export const ROLLUP_VALIDATOR = CLUSTER === "localnet" ? LOCAL_VALIDATOR : TEE_VALIDATOR;

/** The private rollup's endpoint: MagicBlock's TEE, or the local stack's read filter. */
export const ROLLUP_URL =
  process.env.NEXT_PUBLIC_PRIVATE_ROLLUP_URL ??
  (CLUSTER === "localnet"
    ? "http://127.0.0.1:6699"
    : CLUSTER === "mainnet-beta"
      ? "https://mainnet-tee.magicblock.app"
      : "https://devnet-tee.magicblock.app");

const IX = {
  enable_private_holdings: [3, 237, 74, 217, 254, 83, 159, 252],
  set_private_auditor: [171, 95, 151, 80, 84, 53, 12, 248],
  open_private: [192, 238, 115, 177, 212, 156, 179, 159],
  delegate_private_holding: [24, 197, 234, 190, 112, 116, 223, 28],
  delegate_private_exit: [11, 157, 95, 19, 219, 254, 169, 126],
  deposit_private: [185, 225, 196, 82, 37, 8, 2, 73],
  checkpoint_private_ledger: [142, 54, 186, 19, 167, 109, 78, 235],
  release_private: [38, 128, 2, 77, 147, 202, 58, 242],
  request_private_exit: [139, 154, 105, 154, 59, 172, 28, 89],
  recover_private: [154, 58, 177, 65, 146, 186, 147, 146],
  protect_private: [96, 229, 22, 220, 244, 247, 231, 41],
  credit_private: [172, 53, 212, 1, 193, 202, 12, 155],
  transfer_private: [8, 138, 216, 149, 36, 40, 49, 164],
  withdraw_private: [190, 147, 132, 10, 185, 24, 63, 213],
  claim_private_coupon: [169, 125, 6, 189, 247, 228, 9, 44],
  hold_private: [168, 19, 133, 99, 96, 75, 180, 237],
} as const;

const ACCOUNT = {
  PrivatePool: [132, 198, 208, 5, 198, 13, 18, 95],
  PrivateLedger: [87, 3, 181, 148, 141, 47, 197, 107],
  PrivateHolding: [237, 81, 132, 204, 165, 36, 208, 110],
  PrivateExit: [122, 108, 39, 255, 28, 80, 78, 225],
} as const;

const MAX_PERIODS = 8;

export interface PrivatePool {
  address: PublicKey;
  validator: PublicKey;
  /** The default key when there is none. */
  auditor: PublicKey;
  escrow: PublicKey;
  cashVault: PublicKey;
  totalDeposited: bigint;
  totalReleased: bigint;
  cashReleased: bigint;
}

/** A holder's public record on Solana. */
export interface PrivateLedger {
  address: PublicKey;
  holder: PublicKey;
  deposited: bigint;
  released: bigint;
  cashReleased: bigint;
  /** The first period whose register is not yet recorded on it. */
  nextPeriod: number;
  /** What had gone in and come out at each recorded register's fix. */
  atFix: { deposited: bigint; released: bigint }[];
}

/** A holder's private balance, as the rollup shows it to a member. */
export interface PrivateHolding {
  holder: PublicKey;
  units: bigint;
  credited: bigint;
  withdrawn: bigint;
  cash: bigint;
  cashWithdrawn: bigint;
  hold: boolean;
  protected: boolean;
  nextPeriod: number;
  claimed: number;
  entitled: bigint[];
}

export interface PrivateExit {
  withdrawn: bigint;
  cashWithdrawn: bigint;
  /** In the rollup (ready for an exit) or on Solana (settled). */
  delegated: boolean;
}

const u8 = (n: number) => Buffer.from([n]);
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const signer = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: true, isWritable });
const account = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: false, isWritable });
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export class PrivateHoldings {
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
  pool(mint: PublicKey) {
    return pda([Buffer.from("private_pool"), mint.toBuffer()], this.programId);
  }
  escrow(mint: PublicKey) {
    return pda([Buffer.from("private_escrow"), mint.toBuffer()], this.programId);
  }
  cashVault(mint: PublicKey) {
    return pda([Buffer.from("private_cash"), mint.toBuffer()], this.programId);
  }
  ledger(mint: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("private_ledger"), mint.toBuffer(), holder.toBuffer()], this.programId);
  }
  holding(mint: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("private_holding"), mint.toBuffer(), holder.toBuffer()], this.programId);
  }
  exit(mint: PublicKey, holder: PublicKey) {
    return pda([Buffer.from("private_exit"), mint.toBuffer(), holder.toBuffer()], this.programId);
  }
  permission(account: PublicKey) {
    return pda([Buffer.from("permission:"), account.toBuffer()], PERMISSION_PROGRAM_ID);
  }
  delegation(account: PublicKey) {
    return {
      buffer: pda([Buffer.from("buffer"), account.toBuffer()], this.programId),
      record: pda([Buffer.from("delegation"), account.toBuffer()], DELEGATION_PROGRAM_ID),
      metadata: pda([Buffer.from("delegation-metadata"), account.toBuffer()], DELEGATION_PROGRAM_ID),
      undelegationRequest: pda([Buffer.from("undelegation-request"), account.toBuffer()], DELEGATION_PROGRAM_ID),
    };
  }

  private ix(name: keyof typeof IX, keys: AccountMeta[], args: Buffer[] = []) {
    return new TransactionInstruction({ programId: this.programId, keys, data: Buffer.concat([Buffer.from(IX[name]), ...args]) });
  }

  enable(issuer: PublicKey, mint: PublicKey, currencyMint: PublicKey, currencyProgram: PublicKey, validator: PublicKey, auditor: PublicKey) {
    return this.ix(
      "enable_private_holdings",
      [
        signer(issuer, true),
        account(this.asset(mint)),
        account(mint),
        account(this.terms(mint)),
        account(currencyMint),
        account(this.pool(mint), true),
        account(this.escrow(mint), true),
        account(this.cashVault(mint), true),
        account(TOKEN_2022_PROGRAM_ID),
        account(currencyProgram),
        account(SystemProgram.programId),
      ],
      [validator.toBuffer(), auditor.toBuffer()],
    );
  }

  setAuditor(issuer: PublicKey, mint: PublicKey, auditor: PublicKey) {
    return this.ix("set_private_auditor", [signer(issuer), account(this.asset(mint)), account(this.pool(mint), true)], [auditor.toBuffer()]);
  }

  /** `nextPeriod`: the first period whose register is not fixed yet. */
  open(holder: PublicKey, registry: PublicKey, mint: PublicKey, nextPeriod: number) {
    return this.ix(
      "open_private",
      [
        signer(holder, true),
        account(this.asset(mint)),
        account(registry),
        account(this.investor(registry, holder)),
        account(mint),
        account(this.terms(mint)),
        account(this.pool(mint)),
        account(nextPeriod > 0 ? this.payout(mint, nextPeriod - 1) : this.programId),
        account(this.payout(mint, nextPeriod)),
        account(this.ledger(mint, holder), true),
        account(this.holding(mint, holder), true),
        account(this.exit(mint, holder), true),
        account(SystemProgram.programId),
      ],
      [u8(nextPeriod)],
    );
  }

  private delegate(name: "delegate_private_holding" | "delegate_private_exit", holder: PublicKey, mint: PublicKey, target: PublicKey) {
    const d = this.delegation(target);
    return this.ix(name, [
      signer(holder, true),
      account(this.asset(mint)),
      account(this.pool(mint)),
      account(d.buffer, true),
      account(d.record, true),
      account(d.metadata, true),
      account(target, true),
      account(this.programId),
      account(DELEGATION_PROGRAM_ID),
      account(SystemProgram.programId),
    ]);
  }

  delegateHolding(holder: PublicKey, mint: PublicKey) {
    return this.delegate("delegate_private_holding", holder, mint, this.holding(mint, holder));
  }

  delegateExit(holder: PublicKey, mint: PublicKey) {
    return this.delegate("delegate_private_exit", holder, mint, this.exit(mint, holder));
  }

  deposit(holder: PublicKey, registry: PublicKey, mint: PublicKey, source: PublicKey, nextPeriod: number, units: bigint) {
    return this.ix(
      "deposit_private",
      [
        signer(holder),
        account(this.asset(mint)),
        account(registry),
        account(this.investor(registry, holder)),
        account(mint),
        account(this.pool(mint), true),
        account(this.ledger(mint, holder), true),
        account(this.payout(mint, nextPeriod)),
        account(this.holding(mint, holder)),
        account(source, true),
        account(this.escrow(mint), true),
        account(TokenAcl.mintConfig(mint)),
        account(TOKEN_ACL_ID),
        account(TOKEN_2022_PROGRAM_ID),
      ],
      [u64(units)],
    );
  }

  /** Anyone, once register `period` is fixed: record it on a holder's ledger. */
  checkpointLedger(mint: PublicKey, holder: PublicKey, period: number) {
    return this.ix("checkpoint_private_ledger", [
      account(this.asset(mint)),
      account(this.terms(mint)),
      account(this.ledger(mint, holder), true),
      account(this.payout(mint, period)),
    ]);
  }

  private payOutKeys(
    registry: PublicKey,
    mint: PublicKey,
    holder: PublicKey,
    nextPeriod: number,
    middle: AccountMeta,
    destination: PublicKey,
    currencyMint: PublicKey,
    currencyProgram: PublicKey,
    cashDestination: PublicKey,
  ): AccountMeta[] {
    return [
      account(this.asset(mint)),
      account(registry),
      account(this.investor(registry, holder)),
      account(mint),
      account(this.pool(mint), true),
      account(this.ledger(mint, holder), true),
      account(this.payout(mint, nextPeriod)),
      middle,
      account(this.escrow(mint), true),
      account(destination, true),
      account(this.cashVault(mint), true),
      account(currencyMint),
      account(cashDestination, true),
      account(TokenAcl.mintConfig(mint)),
      account(TOKEN_ACL_ID),
      account(TOKEN_2022_PROGRAM_ID),
      account(currencyProgram),
    ];
  }

  /** Anyone: pay out what a holder's settled exit ticket says they withdrew. */
  release(
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
      this.payOutKeys(registry, mint, holder, nextPeriod, account(this.exit(mint, holder)), destination, currencyMint, currencyProgram, cashDestination),
    );
  }

  requestExit(holder: PublicKey, mint: PublicKey) {
    const holding = this.holding(mint, holder);
    const d = this.delegation(holding);
    return this.ix("request_private_exit", [
      signer(holder, true),
      account(this.asset(mint)),
      account(holding),
      account(this.programId),
      account(d.undelegationRequest, true),
      account(d.record),
      account(d.metadata, true),
      account(DELEGATION_PROGRAM_ID),
      account(SystemProgram.programId),
    ]);
  }

  recover(
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
      this.payOutKeys(registry, mint, holder, nextPeriod, account(this.holding(mint, holder), true), destination, currencyMint, currencyProgram, cashDestination),
    );
  }

  // --- sent to the rollup ---

  protect(registry: PublicKey, mint: PublicKey, holder: PublicKey) {
    const holding = this.holding(mint, holder);
    return this.ix("protect_private", [
      account(this.asset(mint)),
      account(registry),
      account(this.pool(mint)),
      account(holding, true),
      account(this.permission(holding), true),
      account(PERMISSION_PROGRAM_ID),
      account(EPHEMERAL_VAULT_ID, true),
      account(MAGIC_PROGRAM_ID),
    ]);
  }

  credit(mint: PublicKey, holder: PublicKey, nextPeriod: number) {
    return this.ix("credit_private", [
      account(this.asset(mint)),
      account(this.holding(mint, holder), true),
      account(this.ledger(mint, holder)),
      account(this.payout(mint, nextPeriod)),
    ]);
  }

  transfer(sender: PublicKey, registry: PublicKey, mint: PublicKey, recipient: PublicKey, nextPeriod: number, units: bigint) {
    return this.ix(
      "transfer_private",
      [
        signer(sender),
        account(this.asset(mint)),
        account(registry),
        account(this.holding(mint, sender), true),
        account(this.holding(mint, recipient), true),
        account(this.ledger(mint, sender)),
        account(this.ledger(mint, recipient)),
        account(this.investor(registry, sender)),
        account(this.investor(registry, recipient)),
        account(this.payout(mint, nextPeriod)),
      ],
      [u64(units)],
    );
  }

  /** The holder must pay the transaction: the rollup's commit is charged to them. */
  withdraw(holder: PublicKey, mint: PublicKey, nextPeriod: number, units: bigint, cash: bigint) {
    return this.ix(
      "withdraw_private",
      [
        signer(holder, true),
        account(this.asset(mint)),
        account(this.holding(mint, holder), true),
        account(this.exit(mint, holder), true),
        account(this.ledger(mint, holder)),
        account(this.payout(mint, nextPeriod)),
        account(MAGIC_PROGRAM_ID),
        account(MAGIC_CONTEXT_ID, true),
      ],
      [u64(units), u64(cash)],
    );
  }

  claim(mint: PublicKey, holder: PublicKey, period: number, nextPeriod: number) {
    return this.ix(
      "claim_private_coupon",
      [
        account(this.asset(mint)),
        account(this.terms(mint)),
        account(this.payout(mint, period)),
        account(this.holding(mint, holder), true),
        account(this.ledger(mint, holder)),
        account(this.payout(mint, nextPeriod)),
      ],
      [u8(period)],
    );
  }

  hold(compliance: PublicKey, registry: PublicKey, mint: PublicKey, holder: PublicKey, hold: boolean) {
    return this.ix(
      "hold_private",
      [signer(compliance), account(this.asset(mint)), account(registry), account(this.holding(mint, holder), true)],
      [u8(hold ? 1 : 0)],
    );
  }

  // --- reading ---

  async fetchPool(connection: Connection, mint: PublicKey): Promise<PrivatePool | null> {
    const address = this.pool(mint);
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.PrivatePool)) return null;
    const r = new Reader(info.data);
    r.key(); // asset
    return {
      address,
      validator: r.key(),
      auditor: r.key(),
      escrow: r.key(),
      cashVault: r.key(),
      totalDeposited: r.u64(),
      totalReleased: r.u64(),
      cashReleased: r.u64(),
    };
  }

  async fetchLedger(connection: Connection, mint: PublicKey, holder: PublicKey): Promise<PrivateLedger | null> {
    const address = this.ledger(mint, holder);
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId) || !hasDiscriminator(info.data, ACCOUNT.PrivateLedger)) return null;
    return decodeLedger(address, info.data);
  }

  /** Every private ledger of an asset: the public side of every private holding. */
  async fetchLedgers(connection: Connection, asset: PublicKey): Promise<PrivateLedger[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.PrivateLedger).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: asset.toBase58() } },
      ],
    });
    return rows.map(({ pubkey, account: info }) => decodeLedger(pubkey, info.data));
  }

  /** The exit ticket as Solana holds it. */
  async fetchExit(connection: Connection, mint: PublicKey, holder: PublicKey): Promise<PrivateExit | null> {
    const info = await connection.getAccountInfo(this.exit(mint, holder));
    if (!info) return null;
    const delegated = info.owner.equals(DELEGATION_PROGRAM_ID);
    if (!delegated && !info.owner.equals(this.programId)) return null;
    const r = new Reader(info.data);
    r.key(); // asset
    r.key(); // holder
    return { withdrawn: r.u64(), cashWithdrawn: r.u64(), delegated };
  }

  /** Whether the holding is in the rollup, as Solana sees it. */
  async holdingDelegated(connection: Connection, mint: PublicKey, holder: PublicKey) {
    const info = await connection.getAccountInfo(this.holding(mint, holder));
    return info ? info.owner.equals(DELEGATION_PROGRAM_ID) : null;
  }

  /** A holding through the rollup; null when the reader is not one of its members. */
  async fetchHolding(rollup: Connection, mint: PublicKey, holder: PublicKey): Promise<PrivateHolding | null> {
    const info = await rollup.getAccountInfo(this.holding(mint, holder));
    if (!info || !hasDiscriminator(info.data, ACCOUNT.PrivateHolding)) return null;
    return decodeHolding(info.data);
  }

  /** Every holding of an asset the reader may see: for the issuer, compliance and the auditor, all of them. */
  async fetchHoldings(rollup: Connection, asset: PublicKey): Promise<PrivateHolding[]> {
    const rows = await rollup.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.PrivateHolding).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: asset.toBase58() } },
      ],
    });
    return rows.map(({ account: info }) => decodeHolding(info.data));
  }
}

function decodeLedger(address: PublicKey, data: Buffer): PrivateLedger {
  const r = new Reader(data);
  r.key(); // asset
  return {
    address,
    holder: r.key(),
    deposited: r.u64(),
    released: r.u64(),
    cashReleased: r.u64(),
    nextPeriod: r.u8(),
    atFix: Array.from({ length: MAX_PERIODS }, () => ({ deposited: r.u64(), released: r.u64() })),
  };
}

/**
 * A holding's units at a period's fix, as the program's catch-up counts them:
 * on the holding once it has caught up, from the ledger's record before.
 * Null while the ledger has not recorded that register.
 */
export function entitledAt(holding: PrivateHolding, ledger: PrivateLedger, period: number): bigint | null {
  if (period < holding.nextPeriod) return holding.entitled[period];
  if (period >= ledger.nextPeriod) return null;
  const cut = ledger.atFix[period];
  return holding.units + (cut.deposited - holding.credited) + (holding.withdrawn - cut.released);
}

function decodeHolding(data: Buffer): PrivateHolding {
  const r = new Reader(data);
  r.key(); // asset
  return {
    holder: r.key(),
    units: r.u64(),
    credited: r.u64(),
    withdrawn: r.u64(),
    cash: r.u64(),
    cashWithdrawn: r.u64(),
    hold: r.bool(),
    protected: r.bool(),
    nextPeriod: r.u8(),
    claimed: r.u8(),
    entitled: Array.from({ length: MAX_PERIODS }, () => r.u64()),
  };
}

/** The first period whose register is not fixed yet: the number of payouts that exist. */
export async function firstOpenPeriod(connection: Connection, holdings: PrivateHoldings, mint: PublicKey, periods: number) {
  const infos = await connection.getMultipleAccountsInfo(Array.from({ length: periods }, (_, i) => holdings.payout(mint, i)));
  const open = infos.findIndex((i) => !i);
  return open === -1 ? periods : open;
}

// --- signing in to the rollup ---

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

/**
 * A read token for the rollup: the wallet signs the endpoint's challenge.
 * Only a message is signed, never a transaction.
 */
export async function rollupToken(publicKey: PublicKey, signMessage: (message: Uint8Array) => Promise<Uint8Array>) {
  const challengeRes = await fetch(`${ROLLUP_URL}/auth/challenge?pubkey=${publicKey.toBase58()}`);
  const { challenge, error } = await challengeRes.json();
  if (typeof challenge !== "string" || !challenge) throw new Error(error || "no challenge");
  const signature = base58(await signMessage(new TextEncoder().encode(challenge)));
  const loginRes = await fetch(`${ROLLUP_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: publicKey.toBase58(), challenge, signature }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || typeof login.token !== "string") throw new Error(login.error || "login refused");
  return login.token as string;
}

export function rollupConnection(token: string) {
  return new Connection(`${ROLLUP_URL}?token=${encodeURIComponent(token)}`, "confirmed");
}
