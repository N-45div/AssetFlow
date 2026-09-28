import { PublicKey } from "@solana/web3.js";

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

export const CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "localnet") as Cluster;

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ??
  (CLUSTER === "localnet" ? "http://127.0.0.1:8899" : `https://api.${CLUSTER}.solana.com`);

/**
 * Where the browser sends RPC. With NEXT_PUBLIC_RPC_PROXY=1 that is this
 * site's own /api/rpc, which holds the keyed endpoint server-side.
 */
export function rpcEndpoint() {
  if (process.env.NEXT_PUBLIC_RPC_PROXY === "1" && typeof window !== "undefined") {
    return `${window.location.origin}/api/rpc`;
  }
  return RPC_URL;
}

/** Local validators get a dev wallet; NEXT_PUBLIC_DEV_WALLET=1 forces it elsewhere, for testing only. */
export const DEV_WALLET = CLUSTER === "localnet" || process.env.NEXT_PUBLIC_DEV_WALLET === "1";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ASSETFLOW_PROGRAM_ID ?? "BWDCF6dLYETPYquDGKm8X6pyLnMZGhisporuTbozjtwR",
);

/** The payment currency coupons are set in: test USDC on devnet, from the faucet route. */
export const CURRENCY_MINT = process.env.NEXT_PUBLIC_CURRENCY_MINT
  ? new PublicKey(process.env.NEXT_PUBLIC_CURRENCY_MINT)
  : null;

/** The asset the holder portal and proof page open on when no ?asset= is given. */
export const FEATURED_MINT = process.env.NEXT_PUBLIC_FEATURED_MINT
  ? new PublicKey(process.env.NEXT_PUBLIC_FEATURED_MINT)
  : null;

export function assetFromQuery(value: string | null): PublicKey | null {
  if (!value) return FEATURED_MINT;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}
