/**
 * The browser's Solana RPC. Requests are forwarded to SOLANA_RPC_URL, a
 * keyed endpoint that never reaches the client, and only for the methods the
 * app actually uses, so the proxy cannot be borrowed as a general RPC.
 */
const UPSTREAM = process.env.SOLANA_RPC_URL;

const ALLOWED = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getBlockHeight",
  "getSlot",
  "getEpochInfo",
  "getVersion",
  "getGenesisHash",
  "getHealth",
  "getBalance",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getTransaction",
]);

const MAX_BODY = 64 * 1024;
const MAX_BATCH = 20;

function refuse(status: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message } }, { status });
}

export async function POST(request: Request) {
  if (!UPSTREAM) return refuse(503, "RPC is not configured on this deployment");
  const text = await request.text();
  if (text.length > MAX_BODY) return refuse(413, "request too large");

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "not JSON");
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > MAX_BATCH) return refuse(400, "batch too large");
  const blocked = calls.find((c) => !ALLOWED.has((c as { method?: string })?.method ?? ""));
  if (blocked) return refuse(403, `method not allowed: ${(blocked as { method?: string })?.method}`);

  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
