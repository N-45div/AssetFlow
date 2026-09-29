"use client";

import { useEffect, useState } from "react";
import { type Abi, type Address } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { money } from "@/app/issuer/coupons";
import { couponAmount, days30360 } from "@/lib/chain/coupons";
import { shortKey } from "@/lib/chain/explorer";
import { servicedTokenAbi, servicerAbi } from "@/lib/evm/abi";
import { readEntitlements } from "@/lib/evm/assetflow";
import { basePublic, baseExplorer } from "@/lib/evm/base";
import type { BondView } from "@/lib/evm/use-bond";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmWallet } from "@/lib/evm/wallet";

type Entitlement = Awaited<ReturnType<typeof readEntitlements>>[number];

/** The schedule, and the payment under way: funded, then paid to every holder on the record date. */
export function BaseCoupons({ view, onChange }: { view: BondView; onChange: () => void }) {
  const t = useTranslations("issuer.coupons");
  const tb = useTranslations("base.coupons");
  const locale = useLocale();
  const { address } = useEvmWallet();
  const tx = useEvmTx();
  const [what, setWhat] = useState("fund");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [rows, setRows] = useState<Entitlement[] | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const { bond, payments } = view;
  const cur = (v: bigint) => money(v, bond.currencyDecimals, locale);
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(ts * 1000);
  const time = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts * 1000);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(id);
  }, []);

  const settled = (i: number) => payments[i].required !== null && payments[i].paid + payments[i].heldBack >= payments[i].required!;
  const active = bond.periods.findIndex((_, i) => !settled(i));
  const current = active === -1 ? bond.periods.length - 1 : active;
  const period = bond.periods[current];
  const pay = payments[current];
  const recorded = now > period.recordTs;
  // The chain may need a block past the record date before the payment can be read.
  const required = pay.required;

  useEffect(() => {
    let live = true;
    setRows(null);
    if (!recorded) return;
    readEntitlements(bond, current)
      .then((r) => live && setRows(r.filter((e) => e.units > 0n)))
      .catch(() => live && setRows([]));
    if (address) {
      basePublic
        .readContract({ address: bond.currency, abi: servicedTokenAbi, functionName: "balanceOf", args: [address] })
        .then((b) => live && setBalance(b as bigint))
        .catch(() => live && setBalance(null));
    }
    return () => {
      live = false;
    };
  }, [bond, current, recorded, address, pay.funded, pay.paid, pay.heldBack]);

  const fund = async () => {
    if (required === null) return;
    const amount = required - pay.funded;
    setWhat("fund");
    const r = await tx.run([
      { address: bond.currency, abi: servicedTokenAbi as Abi, functionName: "approve", args: [bond.servicer, amount] },
      { address: bond.servicer, abi: servicerAbi as Abi, functionName: "fund", args: [BigInt(current), amount] },
    ]);
    if (r.status === "confirmed") onChange();
  };
  const payAll = async () => {
    const pending = (rows ?? []).filter((e) => !e.done).map((e) => e.holder as Address);
    setWhat("pay");
    const r = await tx.run([{ address: bond.servicer, abi: servicerAbi as Abi, functionName: "payMany", args: [BigInt(current), pending] }]);
    if (r.status === "confirmed") onChange();
  };

  const status = (i: number) => {
    const p = payments[i];
    if (now <= bond.periods[i].recordTs) return "scheduled";
    if (settled(i)) return "paid";
    if (p.required === null || p.funded < p.required) return "funding";
    return "paying";
  };
  const tone: Record<string, string> = { scheduled: "pill-neutral", funding: "pill-warn", paying: "pill-warn", paid: "pill-ok" };
  const pending = (rows ?? []).filter((e) => !e.done).length;

  return (
    <div className="grid gap-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t("scheduleTitle")}</h2>
          <span className="text-sm text-ink-2">{tb("termsLine", { face: cur(bond.facePerUnit), rate: (bond.couponBps / 100).toFixed(2) })}</span>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-ink-2">
              <tr>
                <th className="py-2 pr-4 font-medium">#</th>
                <th className="py-2 pr-4 font-medium">{t("col.accrual")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.days")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.record")}</th>
                <th className="py-2 pr-4 text-right font-medium">{t("col.cost")}</th>
                <th className="py-2 font-medium">{t("col.status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {bond.periods.map((p, i) => {
                const s = status(i);
                return (
                  <tr key={i} className={i === current ? "bg-surface-2" : ""}>
                    <td className="py-2 pr-4">{i + 1}</td>
                    <td className="py-2 pr-4">
                      {date(p.accrualStart)} – {date(p.accrualEnd)}
                    </td>
                    <td className="py-2 pr-4">{days30360(p.accrualStart, p.accrualEnd)}</td>
                    <td className="py-2 pr-4">{time(p.recordTs)}</td>
                    <td className="tabular py-2 pr-4 text-right">{cur(payments[i].required ?? couponAmount(bond, p, bond.totalSupply))}</td>
                    <td className="py-2">
                      <span className={`pill ${tone[s]}`}>{tb(`stage.${s}`)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-ink-3">{tb("registerNote")}</p>
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">{t("panelTitle", { n: current + 1, date: date(period.accrualEnd) })}</h2>
        {!recorded ? (
          <p className="mt-3 text-sm text-ink-2">{tb("waiting", { when: time(period.recordTs) })}</p>
        ) : (
          <div className="mt-3 text-sm">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-ink-2">{t("required")}</dt>
                <dd className="tabular text-lg font-semibold">{required === null ? "…" : cur(required)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("funded")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(pay.funded)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("paid")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(pay.paid)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("heldBack")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(pay.heldBack)}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              {required !== null && pay.funded < required && (
                <>
                  <button className="btn btn-primary" disabled={tx.busy || (balance ?? 0n) < required - pay.funded} onClick={fund}>
                    {t("fund", { amount: cur(required - pay.funded) })}
                  </button>
                  {balance !== null && balance < required - pay.funded && <p className="w-full text-xs text-warn">{tb("lowBalance", { balance: cur(balance) })}</p>}
                </>
              )}
              {required !== null && pay.funded >= required && pending > 0 && (
                <button className="btn btn-primary" disabled={tx.busy} onClick={payAll}>
                  {t("payAll", { n: pending })}
                </button>
              )}
            </div>
            {rows && rows.length > 0 && (
              <table className="mt-4 w-full text-sm">
                <thead className="text-left text-ink-2">
                  <tr>
                    <th className="py-2 pr-4 font-medium">{t("col.holder")}</th>
                    <th className="py-2 pr-4 text-right font-medium">{t("col.units")}</th>
                    <th className="py-2 pr-4 text-right font-medium">{t("col.entitlement")}</th>
                    <th className="py-2 font-medium">{t("col.payment")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((e) => (
                    <tr key={e.holder}>
                      <td className="mono py-2 pr-4">{shortKey(e.holder)}</td>
                      <td className="tabular py-2 pr-4 text-right">{e.units.toString()}</td>
                      <td className="tabular py-2 pr-4 text-right">{cur(couponAmount(bond, period, e.units))}</td>
                      <td className="py-2">
                        {e.done ? (
                          <span className={`pill ${e.heldBack ? "pill-warn" : "pill-ok"}`}>{e.heldBack ? t("heldBackPill") : t("paidPill")}</span>
                        ) : (
                          <span className="pill pill-neutral">{t("unpaid")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <TxReceipt state={tx.state} what={tb(`what.${what}`)} link={baseExplorer.tx} />
      </section>
    </div>
  );
}
