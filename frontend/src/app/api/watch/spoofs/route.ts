import { NextResponse } from "next/server";
import { buildSpoofs, type SpoofState } from "@/lib/watch/state";

export const dynamic = "force-dynamic";

// Lookalike tokens change slowly; one scan serves this instance for a quarter of an hour.
const TTL_MS = 15 * 60 * 1000;
let cached: { at: number; state: SpoofState } | null = null;

/** Tokens copying a watched xStock's ticker without the issuer's key, verified mint by mint over Solami RPC. */
export async function GET() {
  try {
    if (!cached || Date.now() - cached.at > TTL_MS) cached = { at: Date.now(), state: await buildSpoofs() };
    return NextResponse.json(cached.state, { headers: { "cache-control": "public, s-maxage=900, stale-while-revalidate=1800" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
