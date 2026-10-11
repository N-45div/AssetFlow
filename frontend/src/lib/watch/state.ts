import { assess, isOfficialMint, toPool, type Basis, type PoolView } from "./engine";
import { blur, rpc } from "./solami";
import UNIVERSE from "./universe.json";

/*
 * What Pool Watch shows, built on the server from Solami: every watched xStock's pools priced against each other,
 * and the lookalike tokens that copy their tickers without the issuer's key.
 */

export const ISSUER = UNIVERSE.issuer;
export const ASSETS = UNIVERSE.assets;
export const REGISTRY = UNIVERSE.registry;

export type AssetState = {
  symbol: string;
  name: string;
  mint: string;
  reference: number | null;
  pools: PoolView[];
  /** every pool's basis, so a live swap in any of them is judged the way the table judges it */
  basisByPool: Record<string, Basis>;
  poolCount: number;
  counted: number;
  outside: number;
  widestPct: number | null;
  liquidityUsd: number;
  volumeUsd: number;
};

export type WatchState = { generatedAt: number; assets: AssetState[]; poolCount: number; outside: number; failed: string[] };

/** Pools per asset, from Blur's /data/token/pools; the shown list keeps the deepest pools. */
export async function buildState(): Promise<WatchState> {
  const failed: string[] = [];
  const assets = await Promise.all(
    ASSETS.map(async (a): Promise<AssetState> => {
      let rows: Record<string, unknown>[] = [];
      try {
        rows = await blur<Record<string, unknown>[]>("/data/token/pools", { address: a.mint, limit: 50 }, 60);
      } catch {
        failed.push(a.symbol);
      }
      const r = assess(rows.map(toPool));
      const basisByPool = Object.fromEntries(r.pools.map((p) => [p.pool, p.basis]));
      // the deepest pools, plus any pool outside the band however shallow, so every flagged pool can be found
      const shown = [...r.pools.slice(0, 16), ...r.pools.slice(16).filter((p) => p.outside)];
      return { symbol: a.symbol, name: a.name, mint: a.mint, ...r, basisByPool, poolCount: rows.length, pools: shown };
    }),
  );
  assets.sort((x, y) => y.liquidityUsd - x.liquidityUsd);
  return {
    generatedAt: Date.now(),
    assets,
    poolCount: assets.reduce((s, a) => s + a.poolCount, 0),
    outside: assets.reduce((s, a) => s + a.outside, 0),
    failed,
  };
}

export type Impostor = { mint: string; name: string; liquidityUsd: number; program: "Token" | "Token-2022" | "other"; mintAuthority: string | null };
export type Spoof = { symbol: string; official: string; impostors: Impostor[]; count: number; liquidityUsd: number };
export type SpoofState = { generatedAt: number; tickers: Spoof[]; count: number; liquidityUsd: number };

type SearchRow = { mint: string; name?: string; symbol?: string; liquidity_usd?: string };
type ParsedAccount = { owner: string; data: { parsed?: { type?: string; info?: { mintAuthority?: string | null } } } } | null;

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Tokens that copy a watched ticker. Blur's search finds every token answering to the ticker; each one's mint
 * account is then read over RPC, and any mint the issuer's key cannot mint is an impostor, whatever it calls itself.
 */
export async function buildSpoofs(): Promise<SpoofState> {
  const found = await Promise.all(
    ASSETS.map(async (a) => {
      try {
        const rows = await blur<SearchRow[]>("/data/token/search", { q: a.symbol, limit: 25 }, 1800);
        return { asset: a, rows: rows.filter((r) => r.mint !== a.mint && (r.symbol ?? "").toLowerCase() === a.symbol.toLowerCase()) };
      } catch {
        return { asset: a, rows: [] as SearchRow[] };
      }
    }),
  );
  const candidates = [...new Set(found.flatMap((f) => f.rows.map((r) => r.mint)))];
  const accounts = new Map<string, ParsedAccount>();
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100);
    const res = await rpc<{ value: ParsedAccount[] }>("getMultipleAccounts", [batch, { encoding: "jsonParsed" }]);
    batch.forEach((m, j) => accounts.set(m, res.value[j]));
  }
  const tickers: Spoof[] = found
    .map(({ asset, rows }) => {
      const impostors: Impostor[] = rows
        .map((r) => ({ r, acc: accounts.get(r.mint) ?? null }))
        .filter(({ acc }) => acc && acc.data.parsed?.type === "mint" && !isOfficialMint(acc.data.parsed.info, ISSUER.mintAuthority))
        .map(({ r, acc }) => ({
          mint: r.mint,
          name: r.name ?? "",
          liquidityUsd: Number(r.liquidity_usd) || 0,
          program: acc!.owner === TOKEN ? ("Token" as const) : acc!.owner === TOKEN_2022 ? ("Token-2022" as const) : ("other" as const),
          mintAuthority: acc!.data.parsed?.info?.mintAuthority ?? null,
        }))
        .sort((x, y) => y.liquidityUsd - x.liquidityUsd);
      return { symbol: asset.symbol, official: asset.mint, impostors: impostors.slice(0, 3), count: impostors.length, liquidityUsd: impostors.reduce((s, i) => s + i.liquidityUsd, 0) };
    })
    .filter((t) => t.count > 0)
    .sort((x, y) => y.liquidityUsd - x.liquidityUsd);
  return { generatedAt: Date.now(), tickers, count: tickers.reduce((s, t) => s + t.count, 0), liquidityUsd: tickers.reduce((s, t) => s + t.liquidityUsd, 0) };
}
