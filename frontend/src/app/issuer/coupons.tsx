"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { CLUSTER, CURRENCY_MINT, PROGRAM_ID } from "@/lib/chain/config";
import { waitForConfirmation } from "@/lib/chain/confirm";
import {
  Coupons,
  couponAmount,
  days30360,
  entitlementTree,
  readRegister,
  type Entitlement,
  type Payout,
  type Period,
  type Terms,
} from "@/lib/chain/coupons";
import { explorer, shortKey } from "@/lib/chain/explorer";
import type { AssetView } from "@/lib/chain/use-asset";
import { useTransaction } from "@/lib/chain/use-transaction";

const coupons = new Coupons(PROGRAM_ID);
const DAY = 86_400;

export function money(amount: bigint, decimals: number, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(Number(amount) / 10 ** decimals);
}

const dateOf = (ts: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(ts * 1000);
const timeOf = (ts: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts * 1000);

/** The register committed for a payment, kept where the issuer can pay from it later. */
const registerKey = (payout: PublicKey) => `assetflow:register:${payout.toBase58()}`;
function saveRegister(payout: PublicKey, entitlements: Entitlement[]) {
  try {
    localStorage.setItem(
      registerKey(payout),
      JSON.stringify(entitlements.map((e) => ({ holder: e.holder.toBase58(), units: e.units.toString() }))),
    );
  } catch {
    // storage unavailable: the download below still works
  }
}
function parseRegister(text: string): Entitlement[] {
  return (JSON.parse(text) as { holder: string; units: string }[]).map((e) => ({
    holder: new PublicKey(e.holder),
    units: BigInt(e.units),
  }));
}
function loadRegister(payout: PublicKey): Entitlement[] | null {
  try {
    const text = localStorage.getItem(registerKey(payout));
    return text ? parseRegister(text) : null;
  } catch {
    return null;
  }
}

export function CouponsTab({ view }: { view: AssetView }) {
  const { connection } = useConnection();
  const t = useTranslations("issuer.coupons");
  const mint = view.asset.mint;
  const [terms, setTerms] = useState<Terms | null | undefined>(undefined);
  const [payouts, setPayouts] = useState<(Payout | null)[]>([]);
  const [currencyProgram, setCurrencyProgram] = useState<PublicKey>(TOKEN_PROGRAM_ID);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    (async () => {
      const found = await coupons.fetchTerms(connection, mint);
      if (!live) return;
      if (!found) {
        setTerms(null);
        return;
      }
      const [owner, list] = await Promise.all([
        connection.getAccountInfo(found.currencyMint).then((i) => i?.owner ?? TOKEN_PROGRAM_ID),
        Promise.all(found.periods.map((_, i) => coupons.fetchPayout(connection, mint, i))),
      ]);
      if (!live) return;
      // Terms and payouts together: the schedule shown without its payouts
      // would offer to fix a register that is already paid.
      setCurrencyProgram(owner);
      setPayouts(list);
      setTerms(found);
    })().catch(() => live && setTerms(null));
    return () => {
      live = false;
    };
  }, [connection, mint, tick]);

  if (terms === undefined) return <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>;
  if (!terms) return <TermsForm view={view} onDone={reload} />;
  return <Schedule view={view} terms={terms} payouts={payouts} currencyProgram={currencyProgram} onChange={reload} />;
}

function addMonths(ts: number, months: number) {
  const d = new Date(ts * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()) / 1000;
}

function TermsForm({ view, onDone }: { view: AssetView; onDone: () => void }) {
  const t = useTranslations("issuer.coupons");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [face, setFace] = useState("1");
  const [rate, setRate] = useState("10");
  const [first, setFirst] = useState("2026-10-01");
  const [count, setCount] = useState(4);
  const [demo, setDemo] = useState(CLUSTER !== "mainnet-beta");
  const [currency, setCurrency] = useState(CURRENCY_MINT?.toBase58() ?? "");
  const [currencyDecimals, setCurrencyDecimals] = useState<number | null>(null);
  const [anchor] = useState(() => Math.floor(Date.now() / 1000));

  let currencyKey: PublicKey | null = null;
  try {
    currencyKey = currency ? new PublicKey(currency) : null;
  } catch {
    currencyKey = null;
  }
  useEffect(() => {
    if (!currencyKey) return;
    let live = true;
    const key = currencyKey;
    // Classic SPL (USDC) or Token-2022: read the mint with whichever program owns it.
    connection
      .getAccountInfo(key)
      .then((info) => getMint(connection, key, "confirmed", info?.owner))
      .then((m) => live && setCurrencyDecimals(m.decimals))
      .catch(() => live && setCurrencyDecimals(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, currency]);

  const periods: Period[] = useMemo(() => {
    const start = Date.parse(`${first}T00:00:00Z`) / 1000;
    if (!Number.isFinite(start)) return [];
    return Array.from({ length: count }, (_, i) => {
      const accrualStart = addMonths(start, 6 * i);
      const accrualEnd = addMonths(start, 6 * (i + 1));
      // A demo schedule puts record dates minutes apart so a whole payment can be shown live.
      const recordTs = demo ? anchor + 60 * (5 * i + 1) : accrualEnd - DAY;
      const paymentTs = demo ? recordTs + 60 : accrualEnd;
      return { accrualStart, accrualEnd, recordTs, paymentTs };
    });
  }, [first, count, demo, anchor]);

  const faceNumber = Number(face);
  const bps = Math.round(Number(rate) * 100);
  const valid =
    currencyKey && currencyDecimals !== null && currencyDecimals >= 2 && faceNumber > 0 && bps > 0 && bps <= 10_000 && periods.length > 0;
  const facePerUnit = valid
    ? BigInt(Math.round((faceNumber * 10 ** currencyDecimals!) / 10 ** view.decimals))
    : 0n;
  const preview = valid ? { facePerUnit, couponBps: bps, currencyDecimals: currencyDecimals! } : null;
  const perThousand = 1_000n * 10n ** BigInt(view.decimals);

  const submit = async () => {
    if (!publicKey || !currencyKey || !valid) return;
    const result = await tx.run([coupons.setTerms(publicKey, view.asset.mint, currencyKey, facePerUnit, bps, periods)]);
    if (result.status === "confirmed") onDone();
  };

  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("termsTitle")}</h2>
      <p className="mt-1 text-sm text-ink-2">{t("termsLede")}</p>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <label>
          <span className="field-label">{t("face")}</span>
          <input className="input tabular" inputMode="decimal" value={face} onChange={(e) => setFace(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("rate")}</span>
          <input className="input tabular" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("first")}</span>
          <input className="input tabular" type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("count")}</span>
          <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {t("countOption", { n, years: n / 2 })}
              </option>
            ))}
          </select>
        </label>
        <label className="md:col-span-2">
          <span className="field-label">{t("currency")}</span>
          <input className="input mono" value={currency} onChange={(e) => setCurrency(e.target.value.trim())} />
          {CURRENCY_MINT && currency === CURRENCY_MINT.toBase58() && (
            <span className="mt-1 block text-xs text-ink-3">{t("testUsdc")}</span>
          )}
        </label>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
        {t("demo")}
      </label>

      {preview && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-line text-ink-2">
              <tr>
                <th className="py-2 pr-4 font-medium">#</th>
                <th className="py-2 pr-4 font-medium">{t("col.accrual")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.days")}</th>
                <th className="py-2 pr-4 text-right font-medium">{t("col.perThousand")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.record")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular">
              {periods.map((p, i) => (
                <tr key={i}>
                  <td className="py-2 pr-4">{i + 1}</td>
                  <td className="py-2 pr-4">
                    {dateOf(p.accrualStart, locale)} – {dateOf(p.accrualEnd, locale)}
                  </td>
                  <td className="py-2 pr-4">{days30360(p.accrualStart, p.accrualEnd)}</td>
                  <td className="py-2 pr-4 text-right">{money(couponAmount(preview, p, perThousand), preview.currencyDecimals, locale)}</td>
                  <td className="py-2 pr-4">{timeOf(p.recordTs, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-3">{t("termsNote")}</p>
      <button className="btn btn-primary mt-4" disabled={tx.busy || !valid} onClick={submit}>
        {t("setTerms")}
      </button>
      <TxReceipt state={tx.state} what={t("termsWhat")} />
    </section>
  );
}

type Stage = "scheduled" | "due" | "fixed" | "funding" | "paying";

function stageOf(period: Period, payout: Payout | null, now: number): Stage {
  if (!payout) return now >= period.recordTs ? "due" : "scheduled";
  if (payout.status === "registerFixed") return "fixed";
  if (payout.funded < payout.required) return "funding";
  return "paying";
}

function Schedule({
  view,
  terms,
  payouts,
  currencyProgram,
  onChange,
}: {
  view: AssetView;
  terms: Terms;
  payouts: (Payout | null)[];
  currencyProgram: PublicKey;
  onChange: () => void;
}) {
  const t = useTranslations("issuer.coupons");
  const locale = useLocale();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(id);
  }, []);
  const active = terms.periods.findIndex((p, i) => {
    const payout = payouts[i];
    return !payout || payout.status !== "committed" || payout.funded < payout.required || payout.paid + payout.heldBack < payout.required;
  });
  const [selected, setSelected] = useState<number | null>(null);
  const current = selected ?? (active === -1 ? terms.periods.length - 1 : active);
  const unit = 10n ** BigInt(view.decimals);

  return (
    <div className="grid gap-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t("scheduleTitle")}</h2>
          <span className="text-sm text-ink-2">
            {t("termsLine", {
              face: money(terms.facePerUnit * unit, terms.currencyDecimals, locale),
              rate: (terms.couponBps / 100).toFixed(2),
            })}{" "}
            <a className="mono text-accent underline underline-offset-2" href={explorer.address(terms.currencyMint.toBase58())} target="_blank" rel="noreferrer">
              {shortKey(terms.currencyMint.toBase58())}
            </a>
          </span>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-ink-2">
              <tr>
                <th className="py-2 pr-4 font-medium">#</th>
                <th className="py-2 pr-4 font-medium">{t("col.accrual")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.record")}</th>
                <th className="py-2 pr-4 text-right font-medium">{t("col.cost")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular">
              {terms.periods.map((p, i) => {
                const payout = payouts[i] ?? null;
                const stage = stageOf(p, payout, now);
                const done = payout && payout.funded >= payout.required && payout.paid + payout.heldBack >= payout.required && payout.status === "committed";
                const cost = payout?.status === "committed" ? payout.required : couponAmount(terms, p, view.supply);
                return (
                  <tr
                    key={i}
                    className={`cursor-pointer ${i === current ? "bg-surface-2" : "hover:bg-surface-2/60"}`}
                    onClick={() => setSelected(i)}
                  >
                    <td className="py-2 pr-4">{i + 1}</td>
                    <td className="py-2 pr-4">
                      {dateOf(p.accrualStart, locale)} – {dateOf(p.accrualEnd, locale)}
                    </td>
                    <td className="py-2 pr-4">{timeOf(p.recordTs, locale)}</td>
                    <td className="py-2 pr-4 text-right">{money(cost, terms.currencyDecimals, locale)}</td>
                    <td className="py-2 pr-4">
                      <span className={`pill ${done ? "pill-ok" : stage === "scheduled" ? "pill-neutral" : "pill-warn"}`}>
                        {done ? t("stage.paid") : t(`stage.${stage}`)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <PaymentPanel
        key={current}
        view={view}
        terms={terms}
        period={current}
        payout={payouts[current] ?? null}
        now={now}
        currencyProgram={currencyProgram}
        onChange={onChange}
      />
    </div>
  );
}

function PaymentPanel({
  view,
  terms,
  period,
  payout,
  now,
  currencyProgram,
  onChange,
}: {
  view: AssetView;
  terms: Terms;
  period: number;
  payout: Payout | null;
  now: number;
  currencyProgram: PublicKey;
  onChange: () => void;
}) {
  const t = useTranslations("issuer.coupons");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey, signAllTransactions, sendTransaction } = useWallet();
  const tx = useTransaction();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [register, setRegister] = useState<Entitlement[] | null>(null);
  const [progress, setProgress] = useState<{ holder: string; signature?: string; state: "sent" | "done" | "failed" | "skipped" }[]>([]);
  const [paying, setPaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const schedule = terms.periods[period];
  const stage = stageOf(schedule, payout, now);
  const cur = (v: bigint) => money(v, terms.currencyDecimals, locale);
  // One PublicKey per payment, not one per render: effects below depend on it.
  const mintAddress = view.asset.mint.toBase58();
  const payoutKey = useMemo(() => coupons.payout(new PublicKey(mintAddress), period), [mintAddress, period]);

  useEffect(() => {
    if (!publicKey) return;
    const source = getAssociatedTokenAddressSync(terms.currencyMint, publicKey, false, currencyProgram);
    getAccount(connection, source, "confirmed", currencyProgram)
      .then((a) => setBalance(a.amount))
      .catch(() => setBalance(0n));
  }, [connection, publicKey, terms.currencyMint, currencyProgram, payout?.status, payout?.funded]);

  useEffect(() => {
    setRegister(loadRegister(payoutKey));
  }, [payoutKey]);

  const fix = async () => {
    if (!publicKey) return;
    const r = await tx.run([coupons.fixRegister(publicKey, view.asset.mint, period)]);
    if (r.status === "confirmed") onChange();
  };

  const commit = async () => {
    if (!publicKey || !payout) return;
    setProblem(null);
    const entitlements = await readRegister(connection, view.asset.mint, view.asset.address);
    const total = entitlements.reduce((s, e) => s + e.units, 0n);
    if (total !== payout.supplyAtFix) {
      setProblem(t("totalMismatch", { read: total.toString(), supply: payout.supplyAtFix.toString() }));
      return;
    }
    const tree = await entitlementTree(payoutKey, entitlements);
    saveRegister(payoutKey, entitlements);
    setRegister(entitlements);
    const r = await tx.run([
      coupons.commitEntitlements(publicKey, view.asset.mint, period, terms.currencyMint, currencyProgram, tree.root, total),
    ]);
    if (r.status === "confirmed") onChange();
  };

  const fund = async () => {
    if (!publicKey || !payout) return;
    const source = getAssociatedTokenAddressSync(terms.currencyMint, publicKey, false, currencyProgram);
    const r = await tx.run([
      coupons.fundPayout(publicKey, view.asset.mint, period, terms.currencyMint, currencyProgram, source, payout.required - payout.funded),
    ]);
    if (r.status === "confirmed") onChange();
  };

  // Pay every holder in the committed register, one transaction each, signed
  // together: anyone could send these, the issuer is simply the one who does.
  const payAll = async () => {
    if (!publicKey || !payout || !register) return;
    setProblem(null);
    const tree = await entitlementTree(payoutKey, register);
    if (!tree.root.equals(payout.root)) {
      setProblem(t("rootMismatch"));
      return;
    }
    setPaying(true);
    const pending: { entitlement: Entitlement; proof: Buffer[] }[] = [];
    const rows: typeof progress = [];
    for (let i = 0; i < register.length; i++) {
      const e = register[i];
      const done = await coupons.fetchPayment(connection, payoutKey, e.holder);
      if (done) rows.push({ holder: e.holder.toBase58(), state: "skipped" });
      else pending.push({ entitlement: e, proof: tree.proofs[i] });
    }
    setProgress([...rows]);
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const txs = pending.map(({ entitlement: e, proof }) => {
        const destination = getAssociatedTokenAddressSync(terms.currencyMint, e.holder, true, currencyProgram);
        return new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(
          createAssociatedTokenAccountIdempotentInstruction(publicKey, destination, e.holder, terms.currencyMint, currencyProgram),
          coupons.payEntitlement(publicKey, view.registry.address, view.asset.mint, period, terms.currencyMint, currencyProgram, destination, e.holder, e.units, proof),
        );
      });
      const signed = signAllTransactions ? await signAllTransactions(txs) : null;
      for (let i = 0; i < txs.length; i++) {
        const holder = pending[i].entitlement.holder.toBase58();
        try {
          const signature = signed
            ? await connection.sendRawTransaction(signed[i].serialize())
            : await sendTransaction(txs[i], connection);
          rows.push({ holder, signature, state: "sent" });
          setProgress([...rows]);
          const result = await waitForConfirmation(connection, signature, lastValidBlockHeight);
          rows[rows.length - 1] = { holder, signature, state: result.err ? "failed" : "done" };
        } catch {
          rows.push({ holder, state: "failed" });
        }
        setProgress([...rows]);
      }
    } finally {
      setPaying(false);
      onChange();
    }
  };

  const download = () => {
    if (!register) return;
    const blob = new Blob(
      [JSON.stringify(register.map((e) => ({ holder: e.holder.toBase58(), units: e.units.toString() })), null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `register-${view.asset.mint.toBase58().slice(0, 8)}-coupon-${period + 1}.json`;
    a.click();
  };

  // No saved copy in this browser: read the register again and keep it only
  // if it rebuilds the root committed on-chain, which it does until a unit moves.
  const rebuild = async () => {
    if (!payout) return;
    setProblem(null);
    const entitlements = await readRegister(connection, view.asset.mint, view.asset.address);
    const tree = await entitlementTree(payoutKey, entitlements);
    if (!tree.root.equals(payout.root)) {
      setProblem(t("rebuildMismatch"));
      return;
    }
    saveRegister(payoutKey, entitlements);
    setRegister(entitlements);
  };

  const importFile = async (file: File) => {
    try {
      const entitlements = parseRegister(await file.text());
      saveRegister(payoutKey, entitlements);
      setRegister(entitlements);
    } catch {
      setProblem(t("badFile"));
    }
  };

  const step = (n: number, label: string, done: boolean, activeNow: boolean) => (
    <li className="flex items-center gap-3 text-sm">
      <span
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          done ? "bg-ok-soft text-ok" : activeNow ? "bg-accent text-white" : "bg-surface-2 text-ink-3"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className={activeNow ? "font-medium" : done ? "text-ink-2" : "text-ink-3"}>{label}</span>
    </li>
  );

  const committed = payout?.status === "committed";
  const funded = committed && payout!.funded >= payout!.required;
  const settled = funded && payout!.paid + payout!.heldBack >= payout!.required;

  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("panelTitle", { n: period + 1, date: dateOf(schedule.accrualEnd, locale) })}</h2>
      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <ol className="space-y-3">
          {step(1, t("steps.record", { when: timeOf(schedule.recordTs, locale) }), now >= schedule.recordTs, stage === "scheduled")}
          {step(2, t("steps.fix"), !!payout, stage === "due")}
          {step(3, t("steps.commit"), committed, stage === "fixed")}
          {step(4, t("steps.fund"), funded, stage === "funding")}
          {step(5, t("steps.pay"), !!settled, stage === "paying" && !settled)}
        </ol>

        <div className="text-sm">
          {payout && committed && (
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-ink-2">{t("required")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(payout.required)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("funded")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(payout.funded)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("paid")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(payout.paid)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("heldBack")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(payout.heldBack)}</dd>
              </div>
            </dl>
          )}
          {payout && (
            <p className="mt-3 text-xs text-ink-3">
              {t("fixedAt", { units: payout.supplyAtFix.toString(), slot: payout.fixedSlot.toString() })}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {stage === "scheduled" && <p className="text-ink-2">{t("waiting")}</p>}
            {stage === "due" && (
              <button className="btn btn-primary" disabled={tx.busy} onClick={fix}>
                {t("fix")}
              </button>
            )}
            {stage === "fixed" && (
              <button className="btn btn-primary" disabled={tx.busy} onClick={commit}>
                {t("commit")}
              </button>
            )}
            {stage === "funding" && payout && (
              <>
                <button
                  className="btn btn-primary"
                  disabled={tx.busy || balance === null || balance < payout.required - payout.funded}
                  onClick={fund}
                >
                  {t("fund", { amount: cur(payout.required - payout.funded) })}
                </button>
                {balance !== null && balance < payout.required - payout.funded && (
                  <p className="w-full text-xs text-warn">{t("lowBalance", { balance: cur(balance) })}</p>
                )}
              </>
            )}
            {stage === "paying" && !settled && (
              <button className="btn btn-primary" disabled={paying || !register} onClick={payAll}>
                {t("payAll", { n: register?.length ?? 0 })}
              </button>
            )}
            {committed && register && (
              <button className="btn btn-secondary" onClick={download}>
                {t("download")}
              </button>
            )}
            {committed && !register && (
              <button className="btn btn-secondary" onClick={rebuild}>
                {t("rebuild")}
              </button>
            )}
            {committed && !register && (
              <label className="btn btn-secondary cursor-pointer">
                {t("import")}
                <input type="file" accept="application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
              </label>
            )}
          </div>
          {problem && <p className="mt-3 rounded-md bg-bad-soft p-3 text-bad">{problem}</p>}
        </div>
      </div>

      <TxReceipt state={tx.state} what={t(`what.${stage}`)} />

      {committed && register && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-line text-ink-2">
              <tr>
                <th className="py-2 pr-4 font-medium">{t("col.holder")}</th>
                <th className="py-2 pr-4 text-right font-medium">{t("col.units")}</th>
                <th className="py-2 pr-4 text-right font-medium">{t("col.entitlement")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.payment")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular">
              {register.map((e) => {
                const row = progress.find((p) => p.holder === e.holder.toBase58());
                return (
                  <tr key={e.holder.toBase58()}>
                    <td className="mono py-2 pr-4">{shortKey(e.holder.toBase58())}</td>
                    <td className="py-2 pr-4 text-right">{e.units.toString()}</td>
                    <td className="py-2 pr-4 text-right">{cur(couponAmount(terms, schedule, e.units))}</td>
                    <td className="py-2 pr-4">
                      <PaymentState payout={payoutKey} holder={e.holder} row={row} tick={payout?.payments ?? 0} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-3">{t("registerNote")}</p>
        </div>
      )}
    </section>
  );
}

/** A holder's payment as the chain records it, or the transaction in flight. */
function PaymentState({
  payout,
  holder,
  row,
  tick,
}: {
  payout: PublicKey;
  holder: PublicKey;
  row?: { signature?: string; state: string };
  tick: number;
}) {
  const t = useTranslations("issuer.coupons");
  const { connection } = useConnection();
  const [record, setRecord] = useState<{ heldBack: boolean } | null | undefined>(undefined);
  const payoutAddress = payout.toBase58();
  const holderAddress = holder.toBase58();
  useEffect(() => {
    coupons
      .fetchPayment(connection, new PublicKey(payoutAddress), new PublicKey(holderAddress))
      .then(setRecord)
      .catch(() => setRecord(null));
  }, [connection, payoutAddress, holderAddress, tick, row?.state]);
  if (row?.state === "sent") return <span className="pill pill-neutral">{t("sending")}</span>;
  if (row?.state === "failed")
    return (
      <span className="pill pill-bad">
        {t("failed")}
        {row.signature && (
          <a className="underline" href={explorer.tx(row.signature)} target="_blank" rel="noreferrer">
            ↗
          </a>
        )}
      </span>
    );
  if (record === undefined) return <span className="text-ink-3">…</span>;
  if (!record) return <span className="pill pill-neutral">{t("unpaid")}</span>;
  return (
    <span className={`pill ${record.heldBack ? "pill-warn" : "pill-ok"}`}>
      {record.heldBack ? t("heldBackPill") : t("paidPill")}
      {row?.signature && (
        <a className="underline" href={explorer.tx(row.signature)} target="_blank" rel="noreferrer">
          ↗
        </a>
      )}
    </span>
  );
}
