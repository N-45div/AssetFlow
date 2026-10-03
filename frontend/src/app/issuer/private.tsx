"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { CLUSTER, PROGRAM_ID } from "@/lib/chain/config";
import { Coupons, type Terms } from "@/lib/chain/coupons";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { PrivateHoldings, ROLLUP_VALIDATOR, type PrivateHolding, type PrivateLedger, type PrivatePool } from "@/lib/chain/private";
import { formatUnits, type AssetView } from "@/lib/chain/use-asset";
import { useRollup, useRollupTransaction } from "@/lib/chain/use-rollup";
import { useTransaction } from "@/lib/chain/use-transaction";
import { money } from "./coupons";

const holdings = new PrivateHoldings(PROGRAM_ID);
const coupons = new Coupons(PROGRAM_ID);

interface Loaded {
  terms: Terms | null;
  pool: PrivatePool | null;
  escrowUnits: bigint;
  ledgers: PrivateLedger[];
  currencyProgram: PublicKey;
}

const parseKey = (value: string) => {
  try {
    return value.trim() ? new PublicKey(value.trim()) : PublicKey.default;
  } catch {
    return null;
  }
};

/**
 * Private holdings, from the issuer's side: open them for the asset, name an
 * auditor, and read the private register through the rollup. The issuer and
 * compliance can read every private holding; compliance can hold one.
 */
export function PrivateTab({ view }: { view: AssetView }) {
  const t = useTranslations("issuer.private");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const solana = useTransaction();
  const { rollup, signIn, signingIn, failed, canSign } = useRollup();
  const inRollup = useRollupTransaction(rollup);
  const [data, setData] = useState<Loaded | null | undefined>(undefined);
  const [rows, setRows] = useState<PrivateHolding[] | null>(null);
  const [auditor, setAuditor] = useState("");
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const mint = view.asset.mint;
  const mintAddress = mint.toBase58();
  const assetAddress = view.asset.address.toBase58();
  const isCompliance = !!publicKey && publicKey.equals(view.registry.compliance);

  useEffect(() => {
    let live = true;
    (async (): Promise<Loaded> => {
      const m = new PublicKey(mintAddress);
      const [terms, pool, ledgers] = await Promise.all([
        coupons.fetchTerms(connection, m),
        holdings.fetchPool(connection, m),
        holdings.fetchLedgers(connection, new PublicKey(assetAddress)),
      ]);
      const [escrow, currencyProgram] = await Promise.all([
        pool ? getAccount(connection, pool.escrow, "confirmed", TOKEN_2022_PROGRAM_ID) : null,
        terms ? connection.getAccountInfo(terms.currencyMint).then((i) => i?.owner ?? TOKEN_PROGRAM_ID) : TOKEN_PROGRAM_ID,
      ]);
      return { terms, pool, escrowUnits: escrow?.amount ?? 0n, ledgers, currencyProgram };
    })()
      .then((found) => live && setData(found))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [connection, mintAddress, assetAddress, tick]);

  useEffect(() => {
    if (!rollup || !data?.pool) return;
    let live = true;
    holdings
      .fetchHoldings(rollup, new PublicKey(assetAddress))
      .then((found) => live && setRows(found))
      .catch(() => live && setRows(null));
    return () => {
      live = false;
    };
  }, [rollup, data?.pool, assetAddress, tick]);

  if (data === undefined) return <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>;
  if (!data) return <div className="card p-6 text-sm text-ink-2">{t("unreadable")}</div>;
  const { terms, pool, escrowUnits, ledgers, currencyProgram } = data;
  const units = (v: bigint) => formatUnits(v, view.decimals, locale);
  const cash = (v: bigint) => money(v, terms?.currencyDecimals ?? 6, locale);
  const auditorKey = parseKey(auditor);

  const enable = async () => {
    if (!publicKey || !terms || !auditorKey) return;
    const r = await solana.run([holdings.enable(publicKey, mint, terms.currencyMint, currencyProgram, ROLLUP_VALIDATOR, auditorKey)]);
    if (r.status === "confirmed") refresh();
  };

  const setPoolAuditor = async () => {
    if (!publicKey || !auditorKey) return;
    const r = await solana.run([holdings.setAuditor(publicKey, mint, auditorKey)]);
    if (r.status === "confirmed") {
      setAuditor("");
      refresh();
    }
  };

  // After a new auditor or compliance key, every holding's read permission is rebuilt.
  const reprotect = async () => {
    if (!rows || rows.length === 0) return;
    const r = await inRollup.run(rows.map((h) => holdings.protect(view.registry.address, mint, h.holder)));
    if (r.status === "confirmed") refresh();
  };

  const hold = async (holder: PublicKey, on: boolean) => {
    if (!publicKey) return;
    const r = await inRollup.run([holdings.hold(publicKey, view.registry.address, mint, holder, on)]);
    if (r.status === "confirmed") refresh();
  };

  if (!pool) {
    return (
      <section className="card p-5">
        <h2 className="font-semibold">{t("enableTitle")}</h2>
        <p className="mt-1 text-sm text-ink-2">{t("enableLede")}</p>
        <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
          <div>
            <dt className="text-ink-2">{t("validator")}</dt>
            <dd className="mono mt-1">{shortKey(ROLLUP_VALIDATOR.toBase58(), 6)}</dd>
            <dd className="mt-1 text-xs text-ink-3">{CLUSTER === "localnet" ? t("validatorLocal") : t("validatorTee")}</dd>
          </div>
          <label>
            <span className="field-label">{t("auditor")}</span>
            <input className="input mono" placeholder={t("auditorPlaceholder")} value={auditor} onChange={(e) => setAuditor(e.target.value)} />
          </label>
        </dl>
        {!terms && <p className="mt-3 text-sm text-warn">{t("needsTerms")}</p>}
        <button className="btn btn-primary mt-4" disabled={solana.busy || !terms || !auditorKey} onClick={enable}>
          {t("enable")}
        </button>
        <p className="mt-3 text-xs text-ink-3">{t("enableNote")}</p>
        <TxReceipt state={solana.state} what={t("whatEnable")} />
      </section>
    );
  }

  const poolAuditor = pool.auditor.equals(PublicKey.default) ? null : pool.auditor;
  return (
    <div className="grid gap-4">
      <section className="card p-5">
        <h2 className="font-semibold">{t("poolTitle")}</h2>
        <p className="mt-1 text-sm text-ink-2">{t("poolLede")}</p>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-ink-2">{t("escrow")}</dt>
            <dd className="tabular mt-1 text-lg font-semibold">{units(escrowUnits)}</dd>
          </div>
          <div>
            <dt className="text-ink-2">{t("deposited")}</dt>
            <dd className="tabular mt-1 text-lg font-semibold">{units(pool.totalDeposited)}</dd>
          </div>
          <div>
            <dt className="text-ink-2">{t("released")}</dt>
            <dd className="tabular mt-1 text-lg font-semibold">{units(pool.totalReleased)}</dd>
          </div>
          <div>
            <dt className="text-ink-2">{t("holders")}</dt>
            <dd className="tabular mt-1 text-lg font-semibold">{ledgers.length}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-ink-3">
          {t("validatorLine")}{" "}
          <a className="mono text-accent underline underline-offset-2" href={explorer.address(pool.address.toBase58())} target="_blank" rel="noreferrer">
            {shortKey(pool.validator.toBase58(), 6)}
          </a>
          {pool.validator.equals(ROLLUP_VALIDATOR) ? "" : ` · ${t("validatorOther")}`}
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="field-label">{poolAuditor ? t("auditorNow", { auditor: shortKey(poolAuditor.toBase58()) }) : t("auditorNone")}</span>
            <input className="input mono" placeholder={t("auditorPlaceholder")} value={auditor} onChange={(e) => setAuditor(e.target.value)} />
          </label>
          <button className="btn btn-secondary" disabled={solana.busy || !auditorKey || !auditor.trim()} onClick={setPoolAuditor}>
            {t("setAuditor")}
          </button>
        </div>
        <TxReceipt state={solana.state} what={t("whatAuditor")} />
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t("registerTitle")}</h2>
          {rollup && rows && rows.length > 0 && (
            <button className="btn btn-secondary btn-sm" disabled={inRollup.busy} onClick={reprotect}>
              {t("reprotect")}
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-2">{t("registerLede")}</p>
        {!rollup ? (
          <div className="mt-4">
            <button className="btn btn-primary" disabled={!canSign || signingIn} onClick={signIn}>
              {t("signIn")}
            </button>
            <p className="mt-2 text-xs text-ink-3">{canSign ? t("signInNote") : t("cannotSign")}</p>
            {failed && <p className="mt-2 text-xs text-bad">{t("signInFailed")}</p>}
          </div>
        ) : rows === null ? (
          <p className="mt-4 text-sm text-ink-2">{t("loadingRegister")}</p>
        ) : rows.length === 0 ? (
          <p className="mt-4 text-sm text-ink-2">{t("empty")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-line text-ink-2">
                <tr>
                  <th className="py-2 pr-4 font-medium">{t("col.holder")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("col.units")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("col.cash")}</th>
                  <th className="py-2 pr-4 font-medium">{t("col.status")}</th>
                  {isCompliance && <th className="py-2 pr-4 font-medium" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular">
                {rows.map((h) => (
                  <tr key={h.holder.toBase58()}>
                    <td className="mono py-2 pr-4">{shortKey(h.holder.toBase58())}</td>
                    <td className="py-2 pr-4 text-right">{units(h.units)}</td>
                    <td className="py-2 pr-4 text-right">{cash(h.cash)}</td>
                    <td className="py-2 pr-4">
                      <span className={`pill ${h.hold ? "pill-warn" : h.protected ? "pill-ok" : "pill-neutral"}`}>
                        {h.hold ? t("held") : h.protected ? t("private") : t("unprotected")}
                      </span>
                    </td>
                    {isCompliance && (
                      <td className="py-2 pr-4 text-right">
                        <button className="btn btn-secondary btn-sm" disabled={inRollup.busy} onClick={() => hold(h.holder, !h.hold)}>
                          {h.hold ? t("releaseHold") : t("hold")}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">{t("publicNote")}</p>
        <TxReceipt state={inRollup.state} what={t("whatRollup")} link={null} />
      </section>
    </div>
  );
}
