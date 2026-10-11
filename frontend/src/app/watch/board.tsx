"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { ArrowLink, Glass, GlassHead, Scene, Section, TextItem, Title } from "@/components/landing";
import { TRUSTED_QUOTES, basisOf, deviationPct, isOutside, type Basis } from "@/lib/watch/engine";
import type { AssetState, SpoofState, WatchState } from "@/lib/watch/state";
import { REPO } from "@/lib/site";

const LIVE_BOND = "9jUHSrfKuCpyDA4GEVmJ6JHeAqz6N1mRYZAhjp8g927K";
const STATE_EVERY_MS = 60_000;
const FEED_LENGTH = 12;

type SwapEvent = { symbol: string; mint: string; pool: string; quoteMint: string; dex: string; side: "buy" | "sell"; priceUsd: number; volumeUsd: number; signature: string; slot: number; blockTime: number };
type Swap = SwapEvent & { deviation: number | null; trip: boolean; counted: boolean };

const DEX: Record<string, string> = {
  raydium_clmm: "Raydium CLMM",
  raydium_cpmm: "Raydium CPMM",
  raydium_amm: "Raydium AMM",
  orca_whirlpool: "Orca",
  meteora_dlmm: "Meteora DLMM",
  meteora_damm: "Meteora DAMM",
  meteora_damm_v2: "Meteora DAMM v2",
  byreal: "Byreal",
  pancakeswap: "PancakeSwap",
  manifest: "Manifest",
  alphaq: "AlphaQ",
  pumpswap: "PumpSwap",
};
const dexName = (d: string) => DEX[d] ?? d.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const quoteName = (q: string) => TRUSTED_QUOTES[q] ?? short(q);
const solscan = (a: string, kind: "account" | "tx" = "account") => `https://solscan.io/${kind}/${a}`;
const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");
function price(n: number) {
  const digits = n >= 100 ? 2 : n >= 1 ? 3 : 5;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
const pct = (d: number) => `${d > 0 ? "+" : ""}${d.toFixed(2)}%`;
const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString("en-GB", { hour12: false });

const pill = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium";

export function WatchBoard({ initial, band, officialMints, watched }: { initial: WatchState | null; band: number; officialMints: number; watched: number }) {
  const t = useTranslations("watch");
  const [snap, setSnap] = useState<WatchState | null>(initial);
  const [spoofs, setSpoofs] = useState<SpoofState | null>(null);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [seen, setSeen] = useState(0);
  const [live, setLive] = useState(false);
  const [stale, setStale] = useState(false);
  // starts at the snapshot's own time so the server and the first client render agree; the tick takes over after
  const [now, setNow] = useState(() => initial?.generatedAt ?? 0);
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  // pools, refreshed every minute
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/watch/state")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((s: WatchState) => {
          if (alive) {
            setSnap(s);
            setStale(false);
          }
        })
        .catch(() => alive && setStale(true));
    if (!initial) load();
    const id = setInterval(load, STATE_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [initial]);

  // lookalikes, once (the server caches them for a quarter of an hour)
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/watch/spoofs")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((s: SpoofState) => alive && setSpoofs(s))
        .catch(() => alive && setTimeout(load, 30_000));
    load();
    return () => {
      alive = false;
    };
  }, []);

  // every swap, as it lands, judged against its asset's reference the way the table judges pools
  useEffect(() => {
    const es = new EventSource("/api/watch/stream");
    es.addEventListener("ready", () => setLive(true));
    es.addEventListener("swap", (e) => {
      const m = JSON.parse((e as MessageEvent).data) as SwapEvent;
      const asset = snapRef.current?.assets.find((a) => a.mint === m.mint);
      const basis: Basis = asset?.basisByPool[m.pool] ?? basisOf({ dex: m.dex, quoteMint: m.quoteMint, liquidityUsd: 0, priceUsd: m.priceUsd });
      const counted = basis === "counted" && !!asset?.reference && m.priceUsd > 0;
      const deviation = counted ? deviationPct(m.priceUsd, asset!.reference!) : null;
      setSwaps((prev) => [{ ...m, deviation, counted, trip: isOutside(deviation, band) }, ...prev].slice(0, FEED_LENGTH));
      setSeen((n) => n + 1);
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [band]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const stats: [string, string][] = [
    [count.format(officialMints), t("stats.official")],
    [String(watched), t("stats.watched", { pools: snap ? count.format(snap.poolCount) : "…" })],
    [count.format(seen), t("stats.swaps")],
    [snap ? String(snap.outside) : "…", t("stats.outside", { band })],
    [spoofs ? String(spoofs.count) : "…", t("stats.lookalikes", { liquidity: spoofs ? compactUsd.format(spoofs.liquidityUsd) : "…" })],
  ];

  return (
    <div className="bg-canvas">
      <Section>
        <p className="mb-4 flex items-center gap-2 text-[13px] text-ink-3">
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-ok" : "bg-warn"}`} aria-hidden="true" />
          {t("status")}
        </p>
        <Title as="h1" title={t("title")} lede={t("lede")} />
        <div className="mt-12 grid gap-x-8 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map(([value, label]) => (
            <div key={label}>
              <p className="tabular text-3xl font-medium tracking-tight text-ink">{value}</p>
              <p className="mt-1 text-[14px] leading-snug text-ink-2">{label}</p>
            </div>
          ))}
        </div>

        <Scene tone="deep" className="mt-12 p-3 sm:p-8">
          <Glass className="p-4 sm:p-5">
            <GlassHead title={t("live.title")} sub={t("live.sub", { n: watched })} badge={live ? "●" : "…"} />
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[13px] sm:min-w-[560px]">
                <thead>
                  <tr className="text-left text-[11px] text-white/65">
                    <th className="pb-1.5 font-medium">{t("live.time")}</th>
                    <th className="pb-1.5 font-medium">{t("live.asset")}</th>
                    <th className="hidden pb-1.5 font-medium sm:table-cell">{t("live.venue")}</th>
                    <th className="hidden pb-1.5 text-right font-medium sm:table-cell">{t("live.size")}</th>
                    <th className="hidden pb-1.5 text-right font-medium sm:table-cell">{t("live.price")}</th>
                    <th className="pb-1.5 text-right font-medium">{t("live.vsRef")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {swaps.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-white/70">
                        {live ? t("live.waiting") : t("live.connecting")}
                      </td>
                    </tr>
                  ) : (
                    swaps.map((s) => (
                      <tr key={`${s.signature}-${s.pool}`} className={s.trip ? "bg-white/10" : undefined}>
                        <td className="tabular py-1.5 text-white/70">
                          <a href={solscan(s.signature, "tx")} target="_blank" rel="noreferrer" className="hover:underline">
                            {clock(s.blockTime)}
                          </a>
                        </td>
                        <td className="py-1.5 font-semibold">
                          {s.symbol} <span className={`ml-1 text-[11px] font-normal ${s.side === "buy" ? "text-mint" : "text-white/60"}`}>{t(`live.${s.side}`)}</span>
                        </td>
                        <td className="hidden py-1.5 text-white/80 sm:table-cell">{dexName(s.dex)}</td>
                        <td className="tabular hidden py-1.5 text-right sm:table-cell">{s.volumeUsd > 0 ? wholeUsd.format(s.volumeUsd) : "—"}</td>
                        <td className="tabular hidden py-1.5 text-right sm:table-cell">{s.priceUsd > 0 ? price(s.priceUsd) : "—"}</td>
                        <td className="tabular py-1.5 text-right">
                          {s.deviation === null ? (
                            <span className="text-white/50">{t("live.notCompared")}</span>
                          ) : s.trip ? (
                            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-ink">
                              {pct(s.deviation)} · {t("live.trip")}
                            </span>
                          ) : (
                            pct(s.deviation)
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Glass>
        </Scene>
      </Section>

      <Section id="pools">
        <Title title={t("pools.title")} lede={t("pools.lede", { band })} />
        <p className="mt-6 text-[13px] text-ink-3">
          {stale ? t("error") : snap ? t("pools.updated", { seconds: Math.max(0, Math.round((now - snap.generatedAt) / 1000)) }) : t("error")}
        </p>
        <div className="mt-4 border-t border-line">
          <div className="hidden grid-cols-[1.4fr_1fr_0.6fr_1fr_0.8fr_0.9fr] gap-4 border-b border-line py-3 text-[12px] text-ink-3 md:grid">
            <span>{t("pools.asset")}</span>
            <span className="text-right">{t("pools.reference")}</span>
            <span className="text-right">{t("pools.pools")}</span>
            <span className="text-right">{t("pools.liquidity")}</span>
            <span className="text-right">{t("pools.widest")}</span>
            <span className="text-right">{t("pools.status")}</span>
          </div>
          {snap?.assets.map((a) => <AssetRow key={a.mint} a={a} t={t} />)}
        </div>
      </Section>

      <Section id="lookalikes">
        <Title title={t("spoofs.title")} lede={t("spoofs.lede")} />
        <div className="mt-10 border-t border-line">
          {!spoofs ? (
            <p className="py-6 text-[15px] text-ink-3">{t("spoofs.loading")}</p>
          ) : (
            <>
              <div className="hidden grid-cols-[0.8fr_0.7fr_1fr_1.2fr_1.6fr] gap-4 border-b border-line py-3 text-[12px] text-ink-3 md:grid">
                <span>{t("spoofs.ticker")}</span>
                <span className="text-right">{t("spoofs.count")}</span>
                <span className="text-right">{t("spoofs.liquidity")}</span>
                <span>{t("spoofs.official")}</span>
                <span>{t("spoofs.largest")}</span>
              </div>
              {spoofs.tickers.slice(0, 12).map((s) => (
                <div key={s.symbol} className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-line py-3 text-[15px] md:grid-cols-[0.8fr_0.7fr_1fr_1.2fr_1.6fr]">
                  <span className="font-medium text-ink">{s.symbol}</span>
                  <span className="tabular text-right text-ink">{s.count}</span>
                  <span className="tabular text-ink-2 md:text-right">{wholeUsd.format(s.liquidityUsd)}</span>
                  <a className="text-accent hover:underline" href={solscan(s.official)} target="_blank" rel="noreferrer">
                    {short(s.official)}
                  </a>
                  {s.impostors[0] && (
                    <a className="col-span-2 text-ink-2 hover:underline md:col-span-1" href={solscan(s.impostors[0].mint)} target="_blank" rel="noreferrer">
                      {short(s.impostors[0].mint)} · {wholeUsd.format(s.impostors[0].liquidityUsd)}
                    </a>
                  )}
                </div>
              ))}
              <p className="mt-4 text-[13px] text-ink-3">{t("spoofs.note")}</p>
            </>
          )}
        </div>
      </Section>

      <Section id="how">
        <Title title={t("how.title")} />
        <div className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2">
          <TextItem title={t("how.registry.title")}>{t("how.registry.body", { n: count.format(officialMints), watched })}</TextItem>
          <TextItem title={t("how.pools.title")}>{t("how.pools.body")}</TextItem>
          <TextItem title={t("how.stream.title")}>{t("how.stream.body")}</TextItem>
          <TextItem title={t("how.verify.title")}>{t("how.verify.body")}</TextItem>
        </div>
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2">
          <ArrowLink href={`${REPO}/tree/main/frontend/src/lib/watch`}>{t("links.code")}</ArrowLink>
          <ArrowLink href={`/issuer?asset=${LIVE_BOND}&tab=pools`}>{t("links.breaker")}</ArrowLink>
        </div>
        <p className="mt-8 text-[13px] text-ink-3">{t("disclaimer")}</p>
      </Section>
    </div>
  );
}

function AssetRow({ a, t }: { a: AssetState; t: ReturnType<typeof useTranslations> }) {
  const status =
    a.reference === null ? (
      <span className={`${pill} bg-surface-2 text-ink-3`}>{t("pools.noReference")}</span>
    ) : a.outside > 0 ? (
      <span className={`${pill} bg-warn-soft text-warn`}>{t("pools.outside", { n: a.outside })}</span>
    ) : (
      <span className={`${pill} bg-ok-soft text-ok`}>{t("pools.inBand")}</span>
    );
  return (
    <details className="group border-b border-line">
      <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] items-center gap-4 py-4 md:grid-cols-[1.4fr_1fr_0.6fr_1fr_0.8fr_0.9fr] [&::-webkit-details-marker]:hidden">
        <span>
          <span className="font-medium text-ink">{a.symbol}</span> <span className="text-[13px] text-ink-3">{a.name}</span>
        </span>
        <span className="tabular hidden text-right text-ink md:block">{a.reference ? price(a.reference) : "—"}</span>
        <span className="tabular hidden text-right text-ink-2 md:block">
          {a.counted}/{a.poolCount}
        </span>
        <span className="tabular hidden text-right text-ink-2 md:block">{compactUsd.format(a.liquidityUsd)}</span>
        <span className="tabular hidden text-right text-ink-2 md:block">{a.widestPct === null ? "—" : pct(a.widestPct)}</span>
        <span className="text-right">{status}</span>
      </summary>
      <div className="overflow-x-auto pb-5">
        <table className="w-full min-w-[620px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-ink-3">
              <th className="pb-2 font-medium">{t("pools.venue")}</th>
              <th className="pb-2 font-medium">{t("pools.quote")}</th>
              <th className="pb-2 text-right font-medium">{t("pools.liquidity")}</th>
              <th className="pb-2 text-right font-medium">{t("pools.price")}</th>
              <th className="pb-2 text-right font-medium">{t("pools.deviation")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {a.pools.map((p) => (
              <tr key={p.pool}>
                <td className="py-1.5">
                  <a className="text-ink hover:underline" href={solscan(p.pool)} target="_blank" rel="noreferrer">
                    {dexName(p.dex)} <span className="text-ink-3">{short(p.pool)}</span>
                  </a>
                </td>
                <td className="py-1.5 text-ink-2">{quoteName(p.quoteMint)}</td>
                <td className="tabular py-1.5 text-right text-ink-2">{wholeUsd.format(p.liquidityUsd)}</td>
                <td className="tabular py-1.5 text-right text-ink">{p.priceUsd > 0 ? price(p.priceUsd) : "—"}</td>
                <td className="tabular py-1.5 text-right">
                  {p.deviationPct === null ? (
                    <span className="text-ink-3">{t(`pools.basis.${p.basis as "thin" | "book" | "quote"}`)}</span>
                  ) : p.outside ? (
                    <span className={`${pill} bg-warn-soft text-warn`}>{pct(p.deviationPct)}</span>
                  ) : (
                    <span className="text-ink-2">{pct(p.deviationPct)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
