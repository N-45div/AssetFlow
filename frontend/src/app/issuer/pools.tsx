"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { type Connection, PublicKey } from "@solana/web3.js";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { Breaker, deviationBps, fairValue, venueState, type Venue, type VenueState } from "@/lib/chain/breaker";
import { PROGRAM_ID } from "@/lib/chain/config";
import { Coupons, type Terms } from "@/lib/chain/coupons";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { TokenAcl } from "@/lib/chain/program";
import { program, type AssetView } from "@/lib/chain/use-asset";
import { useTransaction } from "@/lib/chain/use-transaction";
import { money } from "./coupons";

const breaker = new Breaker(PROGRAM_ID);
const coupons = new Coupons(PROGRAM_ID);
const HOUR = 3_600;
const DURATIONS = [HOUR, 24 * HOUR, 7 * 24 * HOUR] as const;

interface TokenAccountView {
  amount: bigint;
  frozen: boolean;
  owner: PublicKey;
  mint: PublicKey;
}

interface LoadedVenue {
  venue: Venue;
  base: TokenAccountView | null;
  quote: TokenAccountView | null;
}

async function readTokenAccount(connection: Connection, address: PublicKey): Promise<TokenAccountView | null> {
  const info = await connection.getParsedAccountInfo(address, "confirmed");
  const data = info.value?.data;
  if (!data || !("parsed" in data) || data.parsed?.type !== "account") return null;
  const a = data.parsed.info;
  return {
    amount: BigInt(a.tokenAmount.amount),
    frozen: a.state === "frozen",
    owner: new PublicKey(a.owner),
    mint: new PublicKey(a.mint),
  };
}

const keyOrNull = (v: string) => {
  try {
    return new PublicKey(v.trim());
  } catch {
    return null;
  }
};

const PILL: Record<VenueState, string> = {
  open: "pill pill-ok",
  tripped: "pill pill-bad",
  blocked: "pill pill-bad",
  expired: "pill pill-warn",
  new: "pill pill-neutral",
};

/** The circuit breaker: the pools this asset may trade in, and when they may trade. */
export function PoolsTab({ view }: { view: AssetView }) {
  const t = useTranslations("issuer.pools");
  const { connection } = useConnection();
  const [venues, setVenues] = useState<LoadedVenue[] | undefined>(undefined);
  const [terms, setTerms] = useState<Terms | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const registry = view.registry.address;
  const mint = view.asset.mint;

  useEffect(() => {
    let live = true;
    (async () => {
      const [list, tm] = await Promise.all([breaker.fetchVenues(connection, registry, mint), coupons.fetchTerms(connection, mint)]);
      const loaded = await Promise.all(
        list.map(async (venue) => ({
          venue,
          base: await readTokenAccount(connection, venue.baseVault),
          quote: await readTokenAccount(connection, venue.quoteVault),
        })),
      );
      if (!live) return;
      setTerms(tm);
      setVenues(loaded);
    })().catch(() => {
      if (!live) return;
      setTerms(null);
      setVenues([]);
    });
    return () => {
      live = false;
    };
  }, [connection, registry, mint, tick]);

  return (
    <div className="grid max-w-4xl gap-4">
      <section className="card p-5">
        <h2 className="font-semibold">{t("title")}</h2>
        <p className="mt-1 text-sm text-ink-2">{t("lede")}</p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
          <li>{t("how1")}</li>
          <li>{t("how2")}</li>
          <li>{t("how3")}</li>
        </ol>
      </section>
      {venues === undefined ? (
        <div className="card p-5 text-sm text-ink-2">{t("loading")}</div>
      ) : venues.length === 0 ? (
        <div className="card p-5 text-sm text-ink-2">{t("none")}</div>
      ) : (
        venues.map((v) => <VenueCard key={v.venue.address.toBase58()} view={view} loaded={v} terms={terms ?? null} onChange={reload} />)
      )}
      {terms === undefined ? null : terms === null ? (
        <div className="card p-5 text-sm text-ink-2">{t("termsFirst")}</div>
      ) : (
        <ApproveVenue view={view} terms={terms} onDone={reload} />
      )}
    </div>
  );
}

function VenueCard({ view, loaded, terms, onChange }: { view: AssetView; loaded: LoadedVenue; terms: Terms | null; onChange: () => void }) {
  const t = useTranslations("issuer.pools");
  const locale = useLocale();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [what, setWhat] = useState("");
  const [duration, setDuration] = useState<number>(24 * HOUR);
  const { venue, base, quote } = loaded;
  const registry = view.registry;
  const now = Math.floor(Date.now() / 1000);
  const state = venueState(venue, now);
  const isCompliance = publicKey?.equals(registry.compliance) ?? false;
  const canDecide = isCompliance || (publicKey?.equals(venue.riskAuthority) ?? false);
  const decimals = terms?.currencyDecimals ?? 6;
  const fair = terms && base ? fairValue(terms, base.amount, now) : null;
  const deviation = fair !== null && quote ? deviationBps(quote.amount, fair) : null;
  const outOfBand = deviation !== null && base !== null && base.amount > 0n && deviation > venue.maxDeviationBps;
  const time = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts * 1000);
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

  const send = async (label: string, ixs: Parameters<typeof tx.run>[0]) => {
    setWhat(label);
    const r = await tx.run(ixs);
    if (r.status === "confirmed") onChange();
  };
  const gate = (question: "thaw" | "freeze") =>
    TokenAcl.permissionless(
      question,
      publicKey!,
      venue.mint,
      venue.baseVault,
      venue.owner,
      PROGRAM_ID,
      program.gateAccounts(question, venue.mint, registry.address, venue.owner),
    );

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {t("pool")}{" "}
          <a className="mono text-accent underline underline-offset-2" href={explorer.address(venue.owner.toBase58())} target="_blank" rel="noreferrer">
            {shortKey(venue.owner.toBase58())}
          </a>
        </h3>
        <span className={PILL[state]}>{t(`state.${state}`)}</span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-3">{t("baseAccount")}</dt>
          <dd>
            <a className="mono text-accent underline" href={explorer.address(venue.baseVault.toBase58())} target="_blank" rel="noreferrer">
              {shortKey(venue.baseVault.toBase58())}
            </a>{" "}
            {base && <span className={base.frozen ? "pill pill-bad" : "pill pill-ok"}>{base.frozen ? t("accountFrozen") : t("accountOpen")}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">{t("quoteAccount")}</dt>
          <dd>
            <a className="mono text-accent underline" href={explorer.address(venue.quoteVault.toBase58())} target="_blank" rel="noreferrer">
              {shortKey(venue.quoteVault.toBase58())}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">{t("reserves")}</dt>
          <dd>
            {base && quote
              ? t("reservesValue", { units: base.amount.toLocaleString(locale), quote: money(quote.amount, decimals, locale) })
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">{t("fair")}</dt>
          <dd>{fair !== null ? money(fair, decimals, locale) : "—"}</dd>
        </div>
        <div>
          <dt className="text-ink-3">{t("deviation")}</dt>
          <dd className={outOfBand ? "font-medium text-bad" : ""}>
            {deviation !== null && base && base.amount > 0n
              ? t("deviationValue", { pct: pct(deviation), band: pct(venue.maxDeviationBps) })
              : t("noPrice", { band: pct(venue.maxDeviationBps) })}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">{t("riskAuthority")}</dt>
          <dd>
            <a className="mono text-accent underline" href={explorer.address(venue.riskAuthority.toBase58())} target="_blank" rel="noreferrer">
              {shortKey(venue.riskAuthority.toBase58())}
            </a>
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-sm">
        {state === "open"
          ? t("allowedUntil", { time: time(venue.validUntil) })
          : state === "tripped"
            ? t("trippedAt", { time: time(venue.trippedAt) })
            : state === "blocked"
              ? t("blockedAt", { time: time(venue.decidedAt) })
              : state === "expired"
                ? t("expiredAt", { time: time(venue.validUntil) })
                : t("noDecision")}
      </p>

      {publicKey && (
        <div className="mt-4 grid gap-3">
          {canDecide && (
            <div className="flex flex-wrap items-end gap-2">
              <label>
                <span className="field-label">{t("allowFor")}</span>
                <select className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {t(`duration.${d}`)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn-primary"
                disabled={tx.busy}
                onClick={() => send(t("whatDecide"), [breaker.decideVenue(publicKey, registry.address, venue.address, true, duration)])}
              >
                {t("allow")}
              </button>
              <button
                className="btn btn-secondary"
                disabled={tx.busy}
                onClick={() => send(t("whatDecide"), [breaker.decideVenue(publicKey, registry.address, venue.address, false, 0)])}
              >
                {t("block")}
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-secondary" disabled={tx.busy} onClick={() => send(t("whatCheck"), [breaker.checkVenue(venue)])}>
              {t("check")}
            </button>
            <button
              className="btn btn-secondary"
              disabled={tx.busy || !base || base.frozen || (state === "open" && !outOfBand)}
              onClick={() =>
                // Out of band: trip and freeze in one transaction; otherwise the venue is already closed.
                send(t("whatFreeze"), state === "open" ? [breaker.checkVenue(venue), gate("freeze")] : [gate("freeze")])
              }
            >
              {t("freeze")}
            </button>
            <button
              className="btn btn-secondary"
              disabled={tx.busy || !base || !base.frozen || state !== "open"}
              onClick={() => send(t("whatThaw"), [gate("thaw")])}
            >
              {t("thaw")}
            </button>
            {isCompliance && (
              <button
                className="btn btn-secondary"
                disabled={tx.busy}
                onClick={() => send(t("whatWithdraw"), [breaker.closeVenue(publicKey, registry.address, venue.address)])}
              >
                {t("withdraw")}
              </button>
            )}
          </div>
          <p className="text-xs text-ink-3">{t("anyoneNote")}</p>
        </div>
      )}
      <TxReceipt state={tx.state} what={what} />
    </section>
  );
}

function ApproveVenue({ view, terms, onDone }: { view: AssetView; terms: Terms; onDone: () => void }) {
  const t = useTranslations("issuer.pools");
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [baseVault, setBaseVault] = useState("");
  const [quoteVault, setQuoteVault] = useState("");
  const [risk, setRisk] = useState("");
  const [band, setBand] = useState("5");
  const [problem, setProblem] = useState<string | null>(null);
  const registry = view.registry;
  const isCompliance = publicKey?.equals(registry.compliance) ?? false;
  const bandBps = Math.round(Number(band) * 100);
  const bandOk = Number.isFinite(bandBps) && bandBps > 0 && bandBps <= 5_000;

  const approve = async () => {
    if (!publicKey) return;
    setProblem(null);
    const b = keyOrNull(baseVault);
    const q = keyOrNull(quoteVault);
    const r = risk.trim() ? keyOrNull(risk) : publicKey;
    if (!b || !q || !r) return setProblem(t("badKey"));
    const [base, quote] = await Promise.all([readTokenAccount(connection, b), readTokenAccount(connection, q)]);
    if (!base || !base.mint.equals(view.asset.mint)) return setProblem(t("badBase"));
    if (!quote || !quote.owner.equals(base.owner) || !quote.mint.equals(terms.currencyMint)) return setProblem(t("badQuote"));
    const result = await tx.run([breaker.approveVenue(publicKey, registry.address, view.asset.mint, b, q, base.owner, r, bandBps)]);
    if (result.status === "confirmed") {
      setBaseVault("");
      setQuoteVault("");
      onDone();
    }
  };

  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("approveTitle")}</h2>
      <p className="mt-1 text-sm text-ink-2">{t("approveLede")}</p>
      {!isCompliance && <p className="mt-3 rounded-md bg-warn-soft p-3 text-sm text-warn">{t("notCompliance")}</p>}
      <div className="mt-4 grid gap-3 text-sm">
        <label>
          <span className="field-label">{t("baseVault")}</span>
          <input className="input mono" value={baseVault} onChange={(e) => setBaseVault(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("quoteVault")}</span>
          <input className="input mono" value={quoteVault} onChange={(e) => setQuoteVault(e.target.value)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <label>
            <span className="field-label">{t("riskAuthorityInput")}</span>
            <input className="input mono" placeholder={publicKey?.toBase58() ?? ""} value={risk} onChange={(e) => setRisk(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t("band")}</span>
            <input className="input" type="number" min="0.01" max="50" step="0.01" value={band} onChange={(e) => setBand(e.target.value)} />
          </label>
        </div>
        {problem && <p className="text-sm text-bad">{problem}</p>}
        <p className="text-xs text-ink-3">{t("startsClosed")}</p>
        <div>
          <button className="btn btn-primary" disabled={tx.busy || !isCompliance || !bandOk || !baseVault || !quoteVault} onClick={approve}>
            {t("approve")}
          </button>
        </div>
      </div>
      <TxReceipt state={tx.state} what={t("whatApprove")} />
    </section>
  );
}
