/*
 * Solami, Pool Watch's whole data path: Blur's decoded market data over REST, its swap stream over WebSocket, and
 * Solana RPC. Server-side only: the key comes from SOLAMI_API_KEY and never reaches the browser, and nothing Solami
 * returns is passed through whole (its token metadata frames carry image URLs with the key in them).
 */

export const SOLAMI_DATA = "https://api.solami.dev";
export const SOLAMI_RPC = "https://rpc.solami.dev/sol";
export const SOLAMI_STREAM = "wss://ws.solami.dev/data/subscribe";

export function solamiKey(): string {
  const key = process.env.SOLAMI_API_KEY;
  if (!key) throw new Error("SOLAMI_API_KEY is not set");
  return key;
}

/** GET a Blur data endpoint; responses are cached for `revalidate` seconds across requests. */
export async function blur<T>(path: string, params: Record<string, string | number>, revalidate = 60): Promise<T> {
  const qs = new URLSearchParams({ chain: "solana", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`${SOLAMI_DATA}${path}?${qs}`, { headers: { "x-api-key": solamiKey() }, next: { revalidate } });
  if (!res.ok) throw new Error(`Solami ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

/** One JSON-RPC call to Solami's Solana mainnet RPC. */
export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`${SOLAMI_RPC}?api_key=${encodeURIComponent(solamiKey())}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`Solami RPC ${method}: ${body.error?.message ?? res.status}`);
  return body.result;
}

/** The URL for Blur's swap stream, filtered server-side to the given mints. The key travels as a header, not here. */
export function swapStreamUrl(mints: string[]): string {
  return `${SOLAMI_STREAM}?chain=solana&type=swap&address=${mints.join(",")}`;
}
