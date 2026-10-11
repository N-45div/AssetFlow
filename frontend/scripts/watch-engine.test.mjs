// Pool Watch's rule, checked: node --test scripts/watch-engine.test.mjs (Node 22.18+ strips the engine's types itself).
import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, basisOf, deviationPct, isOfficialMint, referencePrice, toPool } from "../src/lib/watch/engine.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pool = (priceUsd, liquidityUsd, extra = {}) => ({ pool: `P${priceUsd}`, dex: "orca_whirlpool", quoteMint: USDC, priceUsd, liquidityUsd, volumeUsd: 0, trades: 0, ...extra });

test("the reference is the liquidity-weighted median, not the mean", () => {
  // one deep pool at 100 outweighs two shallow pools far away
  assert.equal(referencePrice([pool(100, 900_000), pool(130, 50_000), pool(70, 50_000)]), 100);
});

test("pools below the liquidity floor neither set the reference nor trip", () => {
  const a = assess([pool(100, 50_000), pool(101, 40_000), pool(500, 200)]);
  assert.equal(a.reference, 100);
  const dust = a.pools.find((p) => p.priceUsd === 500);
  assert.equal(dust.deviationPct, null);
  assert.equal(dust.outside, false);
  assert.equal(a.counted, 2);
});

test("a pool past the band is outside, one inside it is not", () => {
  const a = assess([pool(100, 100_000), pool(100.5, 40_000), pool(102, 20_000)]);
  assert.equal(a.outside, 1);
  assert.ok(Math.abs(a.widestPct - 2) < 1e-9);
});

test("no deep pools means no reference and nothing trips", () => {
  const a = assess([pool(10, 100), pool(20, 50)]);
  assert.equal(a.reference, null);
  assert.equal(a.outside, 0);
  assert.equal(a.widestPct, null);
});

test("deviation is signed: below the reference is negative", () => {
  assert.equal(deviationPct(99, 100), -1);
  assert.equal(deviationPct(101, 100), 1);
});

test("Solami's string fields parse, and junk becomes zero", () => {
  const p = toPool({ pool: "X", dex: "raydium_clmm", quote_mint: "Q", price_usd: "783.5", liquidity_usd: "2200959.04", volume_usd: null, trades: "x" });
  assert.equal(p.priceUsd, 783.5);
  assert.equal(p.liquidityUsd, 2200959.04);
  assert.equal(p.volumeUsd, 0);
  assert.equal(p.trades, 0);
});

test("only the issuer's mint authority makes a mint official", () => {
  const issuer = "7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj";
  assert.equal(isOfficialMint({ mintAuthority: issuer }, issuer), true);
  assert.equal(isOfficialMint({ mintAuthority: null }, issuer), false);
  assert.equal(isOfficialMint({ mintAuthority: "SomeoneElse111111111111111111111111111111111" }, issuer), false);
  assert.equal(isOfficialMint(null, issuer), false);
});

test("pools quoted in memecoins and order books are shown but never counted", () => {
  const meme = pool(150, 776_000, { quoteMint: "DEW9dSN6memecoin" });
  const book = pool(400, 28_000, { dex: "manifest" });
  const a = assess([pool(100, 50_000), pool(100.4, 30_000), meme, book]);
  assert.equal(a.reference, 100);
  assert.equal(a.outside, 0);
  assert.equal(basisOf(meme), "quote");
  assert.equal(basisOf(book), "book");
  assert.equal(a.pools.find((p) => p.dex === "manifest").deviationPct, null);
});
