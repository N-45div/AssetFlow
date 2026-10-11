import { NextResponse } from "next/server";
import { buildState } from "@/lib/watch/state";

export const dynamic = "force-dynamic";

/** Every watched xStock's pools, priced against each other. Solami's pool data is cached for a minute. */
export async function GET() {
  try {
    const state = await buildState();
    return NextResponse.json(state, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
