/**
 * KYC once in the browser: reading Solana Attestation Service accounts, and
 * AssetFlow's instructions that trust a provider and turn its attestations
 * into investor profiles (solana/programs/assetflow/src/kyc.rs).
 */
import { Buffer } from "buffer";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";

export const SAS_ID = new PublicKey("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
/** Profiles from attestations that never expire carry this date: 9999-12-31 23:59:59 UTC. */
export const NO_EXPIRY = 253_402_300_799;
/** jurisdiction (u16), tier (u8), accredited (bool), as SAS type codes. */
export const INVESTOR_LAYOUT = [1, 0, 10];

const IX = {
  set_kyc_source: [62, 217, 35, 170, 246, 250, 25, 219],
  claim_profile: [58, 26, 130, 69, 27, 81, 106, 114],
  lapse_profile: [8, 99, 198, 140, 126, 246, 149, 28],
} as const;
const ACCOUNT = {
  KycSource: [15, 86, 199, 180, 90, 28, 79, 8],
  AttestedProfile: [233, 182, 60, 1, 2, 141, 74, 145],
} as const;

const signer = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: true, isWritable });
const account = (pubkey: PublicKey, isWritable = false): AccountMeta => ({ pubkey, isSigner: false, isWritable });
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export function attestationAddress(credential: PublicKey, schema: PublicKey, wallet: PublicKey) {
  return pda([Buffer.from("attestation"), credential.toBuffer(), schema.toBuffer(), wallet.toBuffer()], SAS_ID);
}

/** A provider's side: attest an investor (SAS instruction 6), or revoke (7, which closes it). */
export const SasProvider = {
  attest(payer: PublicKey, provider: PublicKey, credential: PublicKey, schema: PublicKey, wallet: PublicKey, fields: InvestorFields, expiry: number) {
    const data = Buffer.alloc(4);
    data.writeUInt16LE(fields.jurisdiction, 0);
    data[2] = fields.tier;
    data[3] = fields.accredited ? 1 : 0;
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length);
    const exp = Buffer.alloc(8);
    exp.writeBigInt64LE(BigInt(expiry));
    return new TransactionInstruction({
      programId: SAS_ID,
      keys: [
        signer(payer, true),
        signer(provider),
        account(credential),
        account(schema),
        account(attestationAddress(credential, schema, wallet), true),
        account(SystemProgram.programId),
      ],
      data: Buffer.concat([Buffer.from([6]), wallet.toBuffer(), len, data, exp]),
    });
  },
  revoke(payer: PublicKey, provider: PublicKey, credential: PublicKey, attestation: PublicKey) {
    return new TransactionInstruction({
      programId: SAS_ID,
      keys: [
        signer(payer, true),
        signer(provider),
        account(credential),
        account(attestation, true),
        account(pda([Buffer.from("__event_authority")], SAS_ID)),
        account(SystemProgram.programId),
        account(SAS_ID),
      ],
      data: Buffer.from([7]),
    });
  },
};

export interface InvestorFields {
  jurisdiction: number;
  tier: number;
  accredited: boolean;
}

export interface InvestorAttestation {
  address: PublicKey;
  wallet: PublicKey;
  credential: PublicKey;
  schema: PublicKey;
  jurisdiction: number;
  tier: number;
  accredited: boolean;
  signer: PublicKey;
  /** Unix seconds; 0 means it never expires. */
  expiry: number;
}

/** SAS's own layout: a one-byte discriminator, then u32-length-prefixed strings and lists. */
class SasReader {
  private at = 1;
  constructor(private readonly data: Buffer) {}
  key() {
    const k = new PublicKey(this.data.subarray(this.at, this.at + 32));
    this.at += 32;
    return k;
  }
  bytes() {
    const len = this.data.readUInt32LE(this.at);
    const out = this.data.subarray(this.at + 4, this.at + 4 + len);
    this.at += 4 + len;
    return out;
  }
  i64() {
    const v = this.data.readBigInt64LE(this.at);
    this.at += 8;
    return v;
  }
}

export async function fetchAttestation(connection: Connection, address: PublicKey): Promise<InvestorAttestation | null> {
  const info = await connection.getAccountInfo(address);
  if (!info?.owner.equals(SAS_ID) || info.data[0] !== 2) return null;
  const r = new SasReader(info.data);
  const wallet = r.key();
  const credential = r.key();
  const schema = r.key();
  const fields = r.bytes();
  const attestedBy = r.key();
  const expiry = Number(r.i64());
  if (fields.length !== 4) return null;
  return {
    address,
    wallet,
    credential,
    schema,
    jurisdiction: fields.readUInt16LE(0),
    tier: fields[2],
    accredited: fields[3] === 1,
    signer: attestedBy,
    expiry,
  };
}

/** A SAS credential's name, for showing which provider a registry trusts. */
export async function fetchCredentialName(connection: Connection, credential: PublicKey): Promise<string | null> {
  const info = await connection.getAccountInfo(credential);
  if (!info?.owner.equals(SAS_ID) || info.data[0] !== 0) return null;
  const r = new SasReader(info.data);
  r.key(); // authority
  return Buffer.from(r.bytes()).toString("utf8");
}

export function attestationValid(a: InvestorAttestation, now = Math.floor(Date.now() / 1000)) {
  return a.expiry === 0 || a.expiry > now;
}

export interface KycSource {
  credential: PublicKey;
  schema: PublicKey;
}

export interface AttestedProfile {
  attestation: PublicKey;
  claimedTs: number;
}

export class Kyc {
  constructor(readonly programId: PublicKey) {}

  source(registry: PublicKey) {
    return pda([Buffer.from("kyc_source"), registry.toBuffer()], this.programId);
  }
  attested(registry: PublicKey, wallet: PublicKey) {
    return pda([Buffer.from("attested"), registry.toBuffer(), wallet.toBuffer()], this.programId);
  }
  private investor(registry: PublicKey, wallet: PublicKey) {
    return pda([Buffer.from("investor"), registry.toBuffer(), wallet.toBuffer()], this.programId);
  }
  private ix(name: keyof typeof IX, keys: AccountMeta[], args: Buffer[] = []) {
    return new TransactionInstruction({ programId: this.programId, keys, data: Buffer.concat([Buffer.from(IX[name]), ...args]) });
  }

  setSource(compliance: PublicKey, registry: PublicKey, credential: PublicKey, schema: PublicKey, accept: boolean) {
    return this.ix(
      "set_kyc_source",
      [
        signer(compliance, true),
        account(registry),
        account(this.source(registry), true),
        account(credential),
        account(schema),
        account(SystemProgram.programId),
      ],
      [Buffer.from([accept ? 1 : 0])],
    );
  }

  claimProfile(payer: PublicKey, registry: PublicKey, attestation: PublicKey, wallet: PublicKey) {
    return this.ix("claim_profile", [
      signer(payer, true),
      account(registry),
      account(this.source(registry)),
      account(attestation),
      account(wallet),
      account(this.investor(registry, wallet), true),
      account(this.attested(registry, wallet), true),
      account(SystemProgram.programId),
    ]);
  }

  lapseProfile(registry: PublicKey, wallet: PublicKey, attestation: PublicKey) {
    return this.ix("lapse_profile", [
      account(registry),
      account(this.source(registry)),
      account(this.attested(registry, wallet)),
      account(this.investor(registry, wallet), true),
      account(attestation),
    ]);
  }

  /** The source a registry trusts; null if it has none. */
  async fetchSource(connection: Connection, registry: PublicKey): Promise<KycSource | null> {
    const info = await connection.getAccountInfo(this.source(registry));
    if (!info?.owner.equals(this.programId) || !ACCOUNT.KycSource.every((b, i) => info.data[i] === b)) return null;
    const credential = new PublicKey(info.data.subarray(40, 72));
    const schema = new PublicKey(info.data.subarray(72, 104));
    return credential.equals(PublicKey.default) ? null : { credential, schema };
  }

  /** Every profile in a registry written from an attestation, by wallet. */
  async fetchAttested(connection: Connection, registry: PublicKey): Promise<Map<string, AttestedProfile>> {
    const rows = await connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.AttestedProfile).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: 8, bytes: registry.toBase58() } },
      ],
    });
    const out = new Map<string, AttestedProfile>();
    for (const { account: info } of rows) {
      const wallet = new PublicKey(info.data.subarray(40, 72));
      out.set(wallet.toBase58(), {
        attestation: new PublicKey(info.data.subarray(72, 104)),
        claimedTs: Number(info.data.readBigInt64LE(104)),
      });
    }
    return out;
  }
}
