// Rebuild Pool Watch's universe from the chain, through Solami:  SOLAMI_API_KEY=sk_... node scripts/watch-universe.mjs
//   1. getProgramAccountsV2 (paged) finds every Token-2022 mint whose mint authority is the xStocks issuer's key;
//   2. getMultipleAccounts reads each one's on-chain metadata and supply;
//   3. Blur's /data/token/pools says where each one trades; those with 2+ pools and $10,000+ of liquidity are watched.
// Writes src/lib/watch/universe.json. Takes a few minutes: the first step pages through all of Token-2022.
import { writeFileSync } from "node:fs";

const KEY = process.env.SOLAMI_API_KEY;
if (!KEY) throw new Error("set SOLAMI_API_KEY");
const RPC = `https://rpc.solami.dev/sol?api_key=${encodeURIComponent(KEY)}`;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ISSUER = { mintAuthority: "7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj", freezeAuthority: "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs", metadataHost: "xstocks-metadata.backed.fi" };
const MIN_LIQUIDITY = 10_000;
const MIN_POOLS = 2;

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function pools(mint) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.solami.dev/data/token/pools?chain=solana&address=${mint}&limit=50`, { headers: { "x-api-key": KEY } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return [];
}

// 1. every mint the issuer's key can mint (a mint's authority sits at bytes 4..36)
const mints = [];
let paginationKey;
for (let page = 1; page < 1000; page++) {
  const cfg = { encoding: "base64", dataSlice: { offset: 0, length: 0 }, limit: 1000, filters: [{ memcmp: { offset: 4, bytes: ISSUER.mintAuthority } }] };
  if (paginationKey) cfg.paginationKey = paginationKey;
  const { value } = await rpc("getProgramAccountsV2", [TOKEN_2022, cfg]);
  mints.push(...value.accounts.map((a) => a.pubkey));
  paginationKey = value.paginationKey;
  if (page % 25 === 0) console.log(`page ${page}: ${mints.length} mints so far`);
  if (!paginationKey) break;
}
console.log(`${mints.length} mints carry the issuer's key`);

// 2. their metadata and supply
const registry = {};
for (let i = 0; i < mints.length; i += 100) {
  const batch = mints.slice(i, i + 100);
  const { value } = await rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed" }]);
  batch.forEach((m, j) => {
    const info = value[j]?.data?.parsed?.info;
    if (!info || info.mintAuthority !== ISSUER.mintAuthority || Number(info.supply) === 0) return;
    const md = info.extensions?.find((e) => e.extension === "tokenMetadata")?.state ?? {};
    if (!String(md.uri ?? "").includes(ISSUER.metadataHost)) return;
    registry[m] = { symbol: md.symbol, name: md.name, decimals: info.decimals };
  });
}
console.log(`${Object.keys(registry).length} official mints with supply and the issuer's metadata`);

// 3. where they trade
const traded = [];
const queue = Object.keys(registry);
await Promise.all(
  Array.from({ length: 12 }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const ps = await pools(m);
      if (!ps.length) continue;
      const liquidity = ps.reduce((s, p) => s + (Number(p.liquidity_usd) || 0), 0);
      traded.push({ mint: m, pools: ps.length, liquidity });
    }
  }),
);
const assets = traded
  .filter((t) => t.pools >= MIN_POOLS && t.liquidity >= MIN_LIQUIDITY)
  .sort((a, b) => b.liquidity - a.liquidity)
  .map((t) => ({ symbol: registry[t.mint].symbol, name: registry[t.mint].name, mint: t.mint, decimals: registry[t.mint].decimals }));

const out = { generatedAt: new Date().toISOString().slice(0, 10), issuer: ISSUER, registry: { officialMints: Object.keys(registry).length, traded: traded.length }, assets };
writeFileSync(new URL("../src/lib/watch/universe.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`${traded.length} trade; ${assets.length} watched: ${assets.map((a) => a.symbol).join(" ")}`);
