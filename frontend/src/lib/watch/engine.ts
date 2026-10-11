/*
 * Pool Watch's rule: the circuit breaker's band, run on live mainnet markets. A tokenized stock trades in many pools at
 * once; their liquidity-weighted median is the reference, and any pool (or trade) that strays past the band from it is
 * where AssetFlow's breaker would trip. Pure functions, no I/O: the server and the tests share them.
 */

export type Pool = {
  pool: string;
  dex: string;
  quoteMint: string;
  priceUsd: number;
  liquidityUsd: number;
  volumeUsd: number;
  trades: number;
};

/** Why a pool does or doesn't count: deep and priced in a trusted asset, or too thin, or an order book, or quoted in something else. */
export type Basis = "counted" | "thin" | "book" | "quote";
export type PoolView = Pool & { basis: Basis; deviationPct: number | null; outside: boolean };

export type Assessment = {
  reference: number | null;
  pools: PoolView[];
  /** pools deep enough to count: they set the reference and can trip */
  counted: number;
  outside: number;
  widestPct: number | null;
  liquidityUsd: number;
  volumeUsd: number;
};

/** The band AssetFlow's breaker uses by default, in percent either side of the reference. */
export const BAND_PCT = 1;
/** Pools shallower than this neither set the reference nor trip: a few dollars can move them anywhere. */
export const MIN_LIQUIDITY_USD = 1000;

/**
 * Quotes whose dollar value is not in question. A pool quoted in a memecoin (NVDAx/Super Inu holds $776k) is priced
 * only as well as that memecoin is, so it is shown but never sets the reference or trips.
 */
export const TRUSTED_QUOTES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCecSjYvBnF: "USDT",
  So11111111111111111111111111111111111111112: "SOL",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": "USDG",
};

/** Order-book venues report a quoted or last price, not a pool's spot price, so they are not compared with AMMs. */
export const ORDER_BOOKS = new Set(["manifest", "phoenix", "openbook", "openbook_v2"]);

export function basisOf(p: Pick<Pool, "dex" | "quoteMint" | "liquidityUsd" | "priceUsd">, minLiquidity = MIN_LIQUIDITY_USD): Basis {
  if (ORDER_BOOKS.has(p.dex)) return "book";
  if (!TRUSTED_QUOTES[p.quoteMint]) return "quote";
  if (p.liquidityUsd < minLiquidity || p.priceUsd <= 0) return "thin";
  return "counted";
}

/** The liquidity-weighted median price: the price at which half the pooled liquidity sits on either side. */
export function referencePrice(pools: Pool[], minLiquidity = MIN_LIQUIDITY_USD): number | null {
  const deep = pools.filter((p) => basisOf(p, minLiquidity) === "counted").sort((a, b) => a.priceUsd - b.priceUsd);
  const total = deep.reduce((s, p) => s + p.liquidityUsd, 0);
  if (!deep.length || total <= 0) return null;
  let seen = 0;
  for (const p of deep) {
    seen += p.liquidityUsd;
    if (seen >= total / 2) return p.priceUsd;
  }
  return deep[deep.length - 1].priceUsd;
}

export function deviationPct(price: number, reference: number): number {
  return ((price - reference) / reference) * 100;
}

export function isOutside(deviation: number | null, band = BAND_PCT): boolean {
  return deviation !== null && Math.abs(deviation) > band;
}

export function assess(pools: Pool[], band = BAND_PCT, minLiquidity = MIN_LIQUIDITY_USD): Assessment {
  const reference = referencePrice(pools, minLiquidity);
  const views: PoolView[] = pools
    .map((p) => {
      const basis = basisOf(p, minLiquidity);
      const deviation = reference && basis === "counted" ? deviationPct(p.priceUsd, reference) : null;
      return { ...p, basis, deviationPct: deviation, outside: isOutside(deviation, band) };
    })
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const deviations = views.map((v) => v.deviationPct).filter((d): d is number => d !== null);
  const widest = deviations.length ? deviations.reduce((w, d) => (Math.abs(d) > Math.abs(w) ? d : w)) : null;
  return {
    reference,
    pools: views,
    counted: deviations.length,
    outside: views.filter((v) => v.outside).length,
    widestPct: widest,
    liquidityUsd: pools.reduce((s, p) => s + p.liquidityUsd, 0),
    volumeUsd: pools.reduce((s, p) => s + p.volumeUsd, 0),
  };
}

/** Solami's pool rows carry numbers as strings; anything missing or unparseable becomes 0. */
export function toPool(row: Record<string, unknown>): Pool {
  const n = (v: unknown) => {
    const x = typeof v === "number" ? v : Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    pool: String(row.pool ?? ""),
    dex: String(row.dex ?? ""),
    quoteMint: String(row.quote_mint ?? ""),
    priceUsd: n(row.price_usd),
    liquidityUsd: n(row.liquidity_usd),
    volumeUsd: n(row.volume_usd),
    trades: n(row.trades),
  };
}

/** A token is official only if the issuer's key can mint it; a copied name, ticker or logo proves nothing. */
export function isOfficialMint(parsedMint: { mintAuthority?: string | null } | null | undefined, issuerMintAuthority: string): boolean {
  return !!parsedMint && parsedMint.mintAuthority === issuerMintAuthority;
}
