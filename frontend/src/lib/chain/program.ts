/**
 * Instruction builders and account decoders for the AssetFlow program and the
 * parts of Token ACL it relies on. The browser copy of solana/client.ts: the
 * same layouts, with Anchor's discriminators written out as constants instead
 * of hashed at runtime.
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

/** sha256("global:<name>")[..8], Anchor's instruction prefix. */
const IX = {
  create_registry: [210, 219, 233, 49, 251, 19, 135, 13],
  set_jurisdiction: [100, 128, 232, 205, 243, 250, 51, 177],
  set_policy: [40, 133, 12, 157, 235, 202, 2, 132],
  set_investor_profile: [69, 233, 10, 20, 249, 102, 205, 165],
  set_compliance: [46, 128, 120, 26, 105, 175, 165, 6],
  register_asset: [21, 80, 155, 149, 117, 207, 235, 16],
  issue: [190, 1, 98, 214, 81, 99, 222, 247],
  force_freeze: [235, 53, 24, 210, 156, 72, 177, 162],
} as const;

/** sha256("account:<Name>")[..8], Anchor's account prefix. */
const ACCOUNT = {
  Registry: [47, 174, 110, 246, 184, 182, 252, 218],
  InvestorProfile: [167, 54, 230, 138, 108, 116, 117, 118],
  Asset: [234, 180, 241, 252, 139, 224, 160, 8],
} as const;

const u8 = (n: number) => Buffer.from([n]);
const bool = (b: boolean) => u8(b ? 1 : 0);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

const signer = (pubkey: PublicKey, isWritable = false): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable,
});
const account = (pubkey: PublicKey, isWritable = false): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable,
});

export interface ProfileTerms {
  approved: boolean;
  accredited: boolean;
  frozen: boolean;
  tier: number;
  jurisdiction: number;
  /** Unix seconds. */
  expiry: number;
}

export interface Registry {
  address: PublicKey;
  admin: PublicKey;
  compliance: PublicKey;
  minTier: number;
  requireAccredited: boolean;
  jurisdictions: number[];
}

export interface InvestorProfile extends ProfileTerms {
  address: PublicKey;
  registry: PublicKey;
  wallet: PublicKey;
}

export interface Asset {
  address: PublicKey;
  registry: PublicKey;
  mint: PublicKey;
  issuer: PublicKey;
}

function hasDiscriminator(data: Buffer, expected: readonly number[]) {
  return expected.every((byte, i) => data[i] === byte);
}

export class AssetFlowProgram {
  constructor(readonly programId: PublicKey) {}

  registryAddress(admin: PublicKey) {
    return pda([Buffer.from("registry"), admin.toBuffer()], this.programId);
  }
  investorAddress(registry: PublicKey, wallet: PublicKey) {
    return pda([Buffer.from("investor"), registry.toBuffer(), wallet.toBuffer()], this.programId);
  }
  assetAddress(mint: PublicKey) {
    return pda([Buffer.from("asset"), mint.toBuffer()], this.programId);
  }
  thawMetasAddress(mint: PublicKey) {
    return pda([Buffer.from("thaw_extra_account_metas"), mint.toBuffer()], this.programId);
  }
  freezeMetasAddress(mint: PublicKey) {
    return pda([Buffer.from("freeze_extra_account_metas"), mint.toBuffer()], this.programId);
  }

  private ix(name: keyof typeof IX, keys: AccountMeta[], args: Buffer[] = []) {
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data: Buffer.concat([Buffer.from(IX[name]), ...args]),
    });
  }

  createRegistry(admin: PublicKey, minTier: number, requireAccredited: boolean) {
    return this.ix(
      "create_registry",
      [signer(admin, true), account(this.registryAddress(admin), true), account(SystemProgram.programId)],
      [u8(minTier), bool(requireAccredited)],
    );
  }

  setJurisdiction(compliance: PublicKey, registry: PublicKey, code: number, allowed: boolean) {
    return this.ix(
      "set_jurisdiction",
      [signer(compliance), account(registry, true)],
      [u16(code), bool(allowed)],
    );
  }

  setPolicy(compliance: PublicKey, registry: PublicKey, minTier: number, requireAccredited: boolean) {
    return this.ix(
      "set_policy",
      [signer(compliance), account(registry, true)],
      [u8(minTier), bool(requireAccredited)],
    );
  }

  setInvestorProfile(compliance: PublicKey, registry: PublicKey, wallet: PublicKey, t: ProfileTerms) {
    return this.ix(
      "set_investor_profile",
      [
        signer(compliance, true),
        account(registry),
        account(this.investorAddress(registry, wallet), true),
        account(SystemProgram.programId),
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
   * One step: the program checks the mint, writes the gate's account lists and
   * hands the mint's freeze authority to Token ACL. The mint's own key and the
   * registry admin both sign.
   */
  registerAsset(issuer: PublicKey, admin: PublicKey, registry: PublicKey, mint: PublicKey) {
    return this.ix("register_asset", [
      signer(issuer, true),
      signer(admin),
      account(registry),
      signer(mint, true),
      account(this.assetAddress(mint), true),
      account(this.thawMetasAddress(mint), true),
      account(this.freezeMetasAddress(mint), true),
      account(TokenAcl.mintConfig(mint), true),
      account(TOKEN_ACL_ID),
      account(TOKEN_2022_PROGRAM_ID),
      account(SystemProgram.programId),
    ]);
  }

  setCompliance(admin: PublicKey, registry: PublicKey, compliance: PublicKey) {
    return this.ix("set_compliance", [signer(admin), account(registry, true)], [compliance.toBuffer()]);
  }

  /** Issue to an eligible holder; the program re-checks eligibility. */
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
        signer(issuer),
        account(this.assetAddress(mint)),
        account(registry),
        account(mint, true),
        account(destination, true),
        account(this.investorAddress(registry, owner)),
        account(TOKEN_2022_PROGRAM_ID),
      ],
      [u64(amount)],
    );
  }

  /** Compliance freezes an account outright, through Token ACL's own freeze. */
  forceFreeze(compliance: PublicKey, registry: PublicKey, mint: PublicKey, tokenAccount: PublicKey, reason: number) {
    return this.ix(
      "force_freeze",
      [
        signer(compliance),
        account(registry),
        account(this.assetAddress(mint)),
        account(mint),
        account(tokenAccount, true),
        account(TokenAcl.mintConfig(mint)),
        account(TOKEN_ACL_ID),
        account(TOKEN_2022_PROGRAM_ID),
      ],
      [u16(reason)],
    );
  }

  /** The accounts Token ACL must be handed to resolve the gate's list. */
  gateAccounts(question: "thaw" | "freeze", mint: PublicKey, registry: PublicKey, owner: PublicKey) {
    const list = question === "thaw" ? this.thawMetasAddress(mint) : this.freezeMetasAddress(mint);
    return [list, this.assetAddress(mint), registry, this.investorAddress(registry, owner)].map((a) =>
      account(a),
    );
  }

  async fetchRegistry(connection: Connection, address: PublicKey): Promise<Registry | null> {
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId)) return null;
    return decodeRegistry(address, info.data);
  }

  async fetchInvestor(connection: Connection, registry: PublicKey, wallet: PublicKey) {
    const address = this.investorAddress(registry, wallet);
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId)) return null;
    return decodeInvestor(address, info.data);
  }

  async fetchAsset(connection: Connection, mint: PublicKey): Promise<Asset | null> {
    const address = this.assetAddress(mint);
    const info = await connection.getAccountInfo(address);
    if (!info?.owner.equals(this.programId)) return null;
    return decodeAsset(address, info.data);
  }

  /** Every profile in a registry: the investor register. */
  async fetchInvestors(connection: Connection, registry: PublicKey): Promise<InvestorProfile[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58(ACCOUNT.InvestorProfile) } },
        { memcmp: { offset: 8, bytes: registry.toBase58() } },
      ],
    });
    return rows.map((r) => decodeInvestor(r.pubkey, r.account.data)).filter((p) => p !== null);
  }

  /** Assets an issuer runs, found by the issuer field (after registry and mint). */
  async fetchAssetsByIssuer(connection: Connection, issuer: PublicKey): Promise<Asset[]> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58(ACCOUNT.Asset) } },
        { memcmp: { offset: 8 + 32 + 32, bytes: issuer.toBase58() } },
      ],
    });
    return rows.map((r) => decodeAsset(r.pubkey, r.account.data)).filter((a) => a !== null);
  }
}

/** Base58 for a memcmp filter; PublicKey only encodes 32-byte values. */
function bs58(bytes: readonly number[]) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
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

class Reader {
  private at = 8;
  constructor(private readonly data: Buffer) {}
  key() {
    const k = new PublicKey(this.data.subarray(this.at, this.at + 32));
    this.at += 32;
    return k;
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
  i64() {
    const v = this.data.readBigInt64LE(this.at);
    this.at += 8;
    return v;
  }
}

function decodeRegistry(address: PublicKey, data: Buffer): Registry | null {
  if (!hasDiscriminator(data, ACCOUNT.Registry)) return null;
  const r = new Reader(data);
  const admin = r.key();
  const compliance = r.key();
  const minTier = r.u8();
  const requireAccredited = r.bool();
  const count = r.u32();
  const jurisdictions = Array.from({ length: count }, () => r.u16());
  return { address, admin, compliance, minTier, requireAccredited, jurisdictions };
}

function decodeInvestor(address: PublicKey, data: Buffer): InvestorProfile | null {
  if (!hasDiscriminator(data, ACCOUNT.InvestorProfile)) return null;
  const r = new Reader(data);
  return {
    address,
    registry: r.key(),
    wallet: r.key(),
    approved: r.bool(),
    accredited: r.bool(),
    frozen: r.bool(),
    tier: r.u8(),
    jurisdiction: r.u16(),
    expiry: Number(r.i64()),
  };
}

function decodeAsset(address: PublicKey, data: Buffer): Asset | null {
  if (!hasDiscriminator(data, ACCOUNT.Asset)) return null;
  const r = new Reader(data);
  return { address, registry: r.key(), mint: r.key(), issuer: r.key() };
}

/** Token ACL, the Solana Foundation's sRFC-37 program. */
export const TokenAcl = {
  mintConfig(mint: PublicKey) {
    return pda([Buffer.from("MINT_CONFIG"), mint.toBuffer()], TOKEN_ACL_ID);
  },
  flag(tokenAccount: PublicKey) {
    return pda([Buffer.from("FLAG_ACCOUNT"), tokenAccount.toBuffer()], TOKEN_ACL_ID);
  },

  /** Anyone may call these; the gate decides. 6 = thaw, 7 = freeze. */
  permissionless(
    question: "thaw" | "freeze",
    caller: PublicKey,
    mint: PublicKey,
    tokenAccount: PublicKey,
    owner: PublicKey,
    gate: PublicKey,
    gateAccounts: AccountMeta[],
  ) {
    return new TransactionInstruction({
      programId: TOKEN_ACL_ID,
      keys: [
        signer(caller, true),
        account(mint),
        account(tokenAccount, true),
        account(this.flag(tokenAccount), true),
        account(owner),
        account(this.mintConfig(mint)),
        account(TOKEN_2022_PROGRAM_ID),
        account(SystemProgram.programId),
        account(gate),
        ...gateAccounts,
      ],
      data: u8(question === "thaw" ? 6 : 7),
    });
  },
};

/**
 * The instructions that create a serviced asset's mint. Every authority the
 * issuer would otherwise hold personally, the freeze authority included,
 * belongs to the asset account; registration hands the freeze authority on to
 * Token ACL. Send these with registerAsset in the same transaction.
 */
export async function createServicedMintInstructions(
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
    createInitializeMint2Instruction(mint, decimals, asset, asset, TOKEN_2022_PROGRAM_ID),
  ];
}
