/**
 * Reading AssetFlow's EVM contracts on any of its EVM chains: a registry and its investors, a
 * bond (its servicer, token and terms), each coupon payment and each
 * redemption request. Reads are batched through Multicall3.
 */
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { directoryAbi, registryAbi, servicedTokenAbi, servicerAbi } from "./abi";
import { easAbi } from "./eas";

export interface EvmProfile {
  wallet: Address;
  approved: boolean;
  accredited: boolean;
  /** Named like the Solana profile's flag so the same checklist reads both. */
  frozen: boolean;
  tier: number;
  jurisdiction: number;
  expiry: number;
  attestedFrom: Hex | null;
}

export interface EvmRegistry {
  address: Address;
  admin: Address;
  compliance: Address;
  minTier: number;
  requireAccredited: boolean;
  jurisdictions: number[];
  kycSchema: Hex;
  kycAttester: Address;
}

export interface EvmPeriod {
  accrualStart: number;
  accrualEnd: number;
  recordTs: number;
  paymentTs: number;
}

export interface EvmBond {
  servicer: Address;
  token: Address;
  registry: Address;
  issuer: Address;
  name: string;
  symbol: string;
  currency: Address;
  currencyDecimals: number;
  facePerUnit: bigint;
  couponBps: number;
  periods: EvmPeriod[];
  totalSupply: bigint;
  holders: Address[];
  matured: boolean;
  maturity: { startedTs: number; units: bigint; required: bigint; funded: bigint; paid: bigint; unitsRedeemed: bigint };
}

export interface EvmPayment {
  required: bigint | null;
  funded: bigint;
  paid: bigint;
  heldBack: bigint;
  payments: number;
}

export type EvmRequestStatus = "requested" | "settled" | "rejected" | "cancelled";
export interface EvmRequest {
  id: number;
  holder: Address;
  units: bigint;
  status: EvmRequestStatus;
  requestedTs: number;
  closedTs: number;
  principal: bigint;
  interest: bigint;
}

const STATUS: EvmRequestStatus[] = ["requested", "requested", "settled", "rejected", "cancelled"];

export async function listOf(pub: PublicClient, directory: Address, issuer: Address) {
  const [registries, bonds] = await pub.multicall({
    allowFailure: false,
    contracts: [
      { address: directory, abi: directoryAbi, functionName: "registriesOf", args: [issuer] },
      { address: directory, abi: directoryAbi, functionName: "bondsOf", args: [issuer] },
    ],
  });
  return { registries: registries as Address[], bonds: bonds as Address[] };
}

export async function readRegistry(pub: PublicClient, address: Address): Promise<EvmRegistry> {
  const c = { address, abi: registryAbi } as const;
  const [admin, compliance, minTier, requireAccredited, jurisdictions, kycSchema, kycAttester] = await pub.multicall({
    allowFailure: false,
    contracts: [
      { ...c, functionName: "admin" },
      { ...c, functionName: "compliance" },
      { ...c, functionName: "minTier" },
      { ...c, functionName: "requireAccredited" },
      { ...c, functionName: "jurisdictions" },
      { ...c, functionName: "kycSchema" },
      { ...c, functionName: "kycAttester" },
    ],
  });
  return {
    address,
    admin: admin as Address,
    compliance: compliance as Address,
    minTier: Number(minTier),
    requireAccredited: requireAccredited as boolean,
    jurisdictions: (jurisdictions as readonly number[]).map(Number),
    kycSchema: kycSchema as Hex,
    kycAttester: kycAttester as Address,
  };
}

/** Profiles for these wallets (every listed investor when none are given). */
export async function readProfiles(pub: PublicClient, registry: Address, wallets?: Address[]): Promise<EvmProfile[]> {
  const list = wallets ?? ((await pub.readContract({ address: registry, abi: registryAbi, functionName: "investors" })) as Address[]);
  if (list.length === 0) return [];
  const rows = await pub.multicall({
    allowFailure: false,
    contracts: list.flatMap((w) => [
      { address: registry, abi: registryAbi, functionName: "profileOf", args: [w] },
      { address: registry, abi: registryAbi, functionName: "attestedFrom", args: [w] },
    ]),
  });
  return list.map((wallet, i) => {
    const p = rows[2 * i] as unknown as { approved: boolean; accredited: boolean; hold: boolean; tier: number; jurisdiction: number; expiry: bigint };
    const from = rows[2 * i + 1] as Hex;
    return {
      wallet,
      approved: p.approved,
      accredited: p.accredited,
      frozen: p.hold,
      tier: Number(p.tier),
      jurisdiction: Number(p.jurisdiction),
      expiry: Number(p.expiry),
      attestedFrom: /^0x0+$/.test(from) ? null : from,
    };
  });
}

export async function readBond(pub: PublicClient, servicer: Address): Promise<EvmBond> {
  const s = { address: servicer, abi: servicerAbi } as const;
  const [token, registry, issuer, currency, currencyDecimals, facePerUnit, couponBps, periods, matured, maturity] =
    await pub.multicall({
      allowFailure: false,
      contracts: [
        { ...s, functionName: "token" },
        { ...s, functionName: "registry" },
        { ...s, functionName: "issuer" },
        { ...s, functionName: "currency" },
        { ...s, functionName: "currencyDecimals" },
        { ...s, functionName: "facePerUnit" },
        { ...s, functionName: "couponBps" },
        { ...s, functionName: "periods" },
        { ...s, functionName: "matured" },
        { ...s, functionName: "maturity" },
      ],
    });
  const t = { address: token as Address, abi: servicedTokenAbi } as const;
  const [name, symbol, totalSupply, holders] = await pub.multicall({
    allowFailure: false,
    contracts: [
      { ...t, functionName: "name" },
      { ...t, functionName: "symbol" },
      { ...t, functionName: "totalSupply" },
      { ...t, functionName: "holders" },
    ],
  });
  const m = maturity as { startedTs: bigint; units: bigint; required: bigint; funded: bigint; paid: bigint; unitsRedeemed: bigint };
  return {
    servicer,
    token: token as Address,
    registry: registry as Address,
    issuer: issuer as Address,
    name: name as string,
    symbol: symbol as string,
    currency: currency as Address,
    currencyDecimals: Number(currencyDecimals),
    facePerUnit: facePerUnit as bigint,
    couponBps: Number(couponBps),
    periods: (periods as readonly { accrualStart: bigint; accrualEnd: bigint; recordTs: bigint; paymentTs: bigint }[]).map((p) => ({
      accrualStart: Number(p.accrualStart),
      accrualEnd: Number(p.accrualEnd),
      recordTs: Number(p.recordTs),
      paymentTs: Number(p.paymentTs),
    })),
    totalSupply: totalSupply as bigint,
    holders: holders as Address[],
    matured: matured as boolean,
    maturity: {
      startedTs: Number(m.startedTs),
      units: m.units,
      required: m.required,
      funded: m.funded,
      paid: m.paid,
      unitsRedeemed: m.unitsRedeemed,
    },
  };
}

/** Each payment's state; `required` is known once its record date has passed. */
export async function readPayments(pub: PublicClient, bond: EvmBond, now = Math.floor(Date.now() / 1000)): Promise<EvmPayment[]> {
  const s = { address: bond.servicer, abi: servicerAbi } as const;
  const rows = await pub.multicall({
    allowFailure: true,
    contracts: bond.periods.flatMap((_, i) => [
      { ...s, functionName: "payment", args: [BigInt(i)] },
      { ...s, functionName: "required", args: [BigInt(i)] },
    ]),
  });
  return bond.periods.map((p, i) => {
    const pay = rows[2 * i].result as { funded: bigint; paid: bigint; heldBack: bigint; payments: number } | undefined;
    const req = rows[2 * i + 1];
    return {
      required: now > p.recordTs && req.status === "success" ? (req.result as bigint) : null,
      funded: pay?.funded ?? 0n,
      paid: pay?.paid ?? 0n,
      heldBack: pay?.heldBack ?? 0n,
      payments: Number(pay?.payments ?? 0),
    };
  });
}

/** Whether each holder has been paid (or held back) for a period, and their units at its record date. */
export async function readEntitlements(pub: PublicClient, bond: EvmBond, period: number, holders = bond.holders) {
  if (holders.length === 0) return [];
  const rec = bond.periods[period].recordTs;
  const rows = await pub.multicall({
    allowFailure: false,
    contracts: holders.flatMap((h) => [
      { address: bond.token, abi: servicedTokenAbi, functionName: "balanceAt", args: [h, BigInt(rec)] },
      { address: bond.servicer, abi: servicerAbi, functionName: "paidTo", args: [BigInt(period), h] },
    ]),
  });
  return holders.map((holder, i) => {
    const paid = rows[2 * i + 1] as unknown as { amount: bigint; done: boolean; heldBack: boolean };
    return { holder, units: rows[2 * i] as bigint, done: paid.done, heldBack: paid.heldBack, amount: paid.amount };
  });
}

export async function readRequests(pub: PublicClient, servicer: Address): Promise<EvmRequest[]> {
  const count = Number(await pub.readContract({ address: servicer, abi: servicerAbi, functionName: "requestCount" }));
  if (count === 0) return [];
  const rows = await pub.multicall({
    allowFailure: false,
    contracts: Array.from({ length: count }, (_, i) => ({ address: servicer, abi: servicerAbi, functionName: "request", args: [BigInt(i)] })),
  });
  return rows
    .map((r, id) => {
      const q = r as unknown as { holder: Address; units: bigint; status: number; requestedTs: bigint; closedTs: bigint; principal: bigint; interest: bigint };
      return {
        id,
        holder: q.holder,
        units: q.units,
        status: STATUS[q.status] ?? "requested",
        requestedTs: Number(q.requestedTs),
        closedTs: Number(q.closedTs),
        principal: q.principal,
        interest: q.interest,
      };
    })
    .reverse();
}

export async function balancesOf(pub: PublicClient, bond: EvmBond, wallet: Address) {
  const [units, locked, cash, redeemed] = await pub.multicall({
    allowFailure: false,
    contracts: [
      { address: bond.token, abi: servicedTokenAbi, functionName: "balanceOf", args: [wallet] },
      { address: bond.token, abi: servicedTokenAbi, functionName: "locked", args: [wallet] },
      { address: bond.currency, abi: servicedTokenAbi, functionName: "balanceOf", args: [wallet] },
      { address: bond.servicer, abi: servicerAbi, functionName: "redeemedAtMaturity", args: [wallet] },
    ],
  });
  return { units: units as bigint, locked: locked as bigint, cash: cash as bigint, redeemedAtMaturity: redeemed as bigint };
}

export interface EvmAttestation {
  uid: Hex;
  attester: Address;
  recipient: Address;
  schema: Hex;
  expirationTime: number;
  revoked: boolean;
  jurisdiction: number;
  tier: number;
  accredited: boolean;
}

export async function readAttestation(pub: PublicClient, eas: Address, uid: Hex): Promise<EvmAttestation | null> {
  const a = (await pub.readContract({ address: eas, abi: easAbi, functionName: "getAttestation", args: [uid] })) as {
    uid: Hex;
    schema: Hex;
    expirationTime: bigint;
    revocationTime: bigint;
    recipient: Address;
    attester: Address;
    data: Hex;
  };
  if (a.attester === zeroAddress) return null;
  const hex = a.data.slice(2);
  const word = (i: number) => BigInt(`0x${hex.slice(i * 64, (i + 1) * 64) || "0"}`);
  return {
    uid: a.uid,
    attester: a.attester,
    recipient: a.recipient,
    schema: a.schema,
    expirationTime: Number(a.expirationTime),
    revoked: a.revocationTime !== 0n,
    jurisdiction: Number(word(0)),
    tier: Number(word(1)),
    accredited: word(2) === 1n,
  };
}

/** Whether an attestation still vouches for its recipient under a registry's source. */
export function attestationVouches(a: EvmAttestation, registry: EvmRegistry, now = Math.floor(Date.now() / 1000)) {
  return (
    !a.revoked &&
    a.schema === registry.kycSchema &&
    a.attester.toLowerCase() === registry.kycAttester.toLowerCase() &&
    (a.expirationTime === 0 || a.expirationTime > now)
  );
}
