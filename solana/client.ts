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
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
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
  freezeMetas(mint: PublicKey) {
    return pda([Buffer.from("freeze_extra_account_metas"), mint.toBuffer()], this.programId);
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

  registerAsset(admin: PublicKey, registry: PublicKey, mint: PublicKey) {
    return this.ix("register_asset", [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: this.asset(mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  }

  initializeGate(issuer: PublicKey, mint: PublicKey) {
    return this.ix("initialize_gate", [
      { pubkey: issuer, isSigner: true, isWritable: true },
      { pubkey: this.asset(mint), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: this.thawMetas(mint), isSigner: false, isWritable: true },
      { pubkey: this.freezeMetas(mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  }

  issue(issuer: PublicKey, mint: PublicKey, destination: PublicKey, amount: bigint) {
    return this.ix(
      "issue",
      [
        { pubkey: issuer, isSigner: true, isWritable: false },
        { pubkey: this.asset(mint), isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      [u64(amount)],
    );
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

  /** Hands the mint's freeze authority to Token ACL, naming the gate. */
  createConfig(payer: PublicKey, authority: PublicKey, mint: PublicKey, gate: PublicKey) {
    return new TransactionInstruction({
      programId: TOKEN_ACL_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: this.mintConfig(mint), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([u8(0), gate.toBuffer()]),
    });
  },

  togglePermissionless(authority: PublicKey, mint: PublicKey, freeze: boolean, thaw: boolean) {
    return new TransactionInstruction({
      programId: TOKEN_ACL_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: this.mintConfig(mint), isSigner: false, isWritable: true },
      ],
      data: Buffer.from([8, freeze ? 1 : 0, thaw ? 1 : 0]),
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
 * The instructions that create a serviced asset's mint. Every authority the
 * issuer would otherwise hold personally belongs to the asset account, so it
 * is only ever exercised through the program's role checks. The freeze
 * authority starts with the issuer only so Token ACL can take it over.
 */
export async function createServicedMint(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  asset: PublicKey,
  decimals: number,
) {
  const extensions = [
    ExtensionType.DefaultAccountState,
    ExtensionType.PermanentDelegate,
    ExtensionType.PausableConfig,
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
    createInitializeMint2Instruction(mint, decimals, asset, payer, TOKEN_2022_PROGRAM_ID),
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
