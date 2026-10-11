import WebSocket from "ws";
import { ASSETS } from "@/lib/watch/state";
import { solamiKey, swapStreamUrl } from "@/lib/watch/solami";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A connection lives a little under the function limit; the browser's EventSource reconnects on its own. */
const LIFETIME_MS = 270_000;
const SYMBOL = new Map(ASSETS.map((a) => [a.mint, a.symbol]));

/** The fields a swap shows; nothing else from Solami's frame leaves the server. */
function sanitize(m: Record<string, unknown>) {
  return {
    symbol: SYMBOL.get(String(m.mint)) ?? "",
    mint: String(m.mint),
    pool: String(m.pool),
    quoteMint: String(m.quote_mint),
    dex: String(m.dex),
    side: m.side === "buy" ? "buy" : "sell",
    priceUsd: Number(m.price_usd) || 0,
    volumeUsd: Number(m.volume_usd) || 0,
    signature: String(m.signature),
    slot: Number(m.slot) || 0,
    blockTime: Number(m.block_time) || 0,
  };
}

/**
 * Every swap in a watched xStock's pools, as it lands: one Solami swap stream filtered server-side to the watched
 * mints, relayed to the browser as server-sent events.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        ws?.removeAllListeners();
        ws?.terminate();
        controller.close();
      };

      ws = new WebSocket(swapStreamUrl(ASSETS.map((a) => a.mint)), { headers: { "x-api-key": solamiKey() } });
      ws.on("message", (raw) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m.type === "connected") send("ready", { mints: ASSETS.length });
        else if (m.type === "swap") send("swap", sanitize(m));
      });
      ws.on("close", () => {
        send("end", { reason: "upstream closed" });
        finish();
      });
      ws.on("error", () => {
        send("end", { reason: "upstream error" });
        finish();
      });
      heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);
      lifetime = setTimeout(() => {
        send("end", { reason: "rotate" });
        finish();
      }, LIFETIME_MS);
      req.signal.addEventListener("abort", finish);
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      ws?.removeAllListeners();
      ws?.terminate();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
