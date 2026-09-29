"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { useLocale, useTranslations } from "next-intl";
import { money } from "@/app/issuer/coupons";
import { PROGRAM_ID } from "@/lib/chain/config";
import { Coupons, couponAmount, type Payout, type PaymentRecord, type Terms } from "@/lib/chain/coupons";
import { Redemptions } from "@/lib/chain/redemptions";
import type { AssetView } from "@/lib/chain/use-asset";

const coupons = new Coupons(PROGRAM_ID);
const redemptions = new Redemptions(PROGRAM_ID);

interface Row {
  payout: Payout | null;
  record: PaymentRecord | null;
}

/** A holder's coupons: what was paid or held back, and what the next ones come to. */
export function HolderCoupons({ view, wallet, units }: { view: AssetView; wallet: PublicKey; units: bigint }) {
  const t = useTranslations("holder.coupons");
  const locale = useLocale();
  const { connection } = useConnection();
  const [terms, setTerms] = useState<Terms | null | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  // Units waiting in the redemption escrow are still this holder's on a record date.
  const [escrowed, setEscrowed] = useState(0n);

  useEffect(() => {
    let live = true;
    (async () => {
      const found = await coupons.fetchTerms(connection, view.asset.mint);
      if (!live) return;
      setTerms(found);
      if (!found) return;
      const [list, requests] = await Promise.all([
        Promise.all(
          found.periods.map(async (_, i) => {
            const payout = await coupons.fetchPayout(connection, view.asset.mint, i);
            const record = payout ? await coupons.fetchPayment(connection, payout.address, wallet) : null;
            return { payout, record };
          }),
        ),
        redemptions.fetchRequests(connection, view.asset.address, wallet),
      ]);
      if (!live) return;
      setRows(list);
      setEscrowed(requests.filter((r) => r.status === "requested").reduce((sum, r) => sum + r.units, 0n));
    })().catch(() => live && setTerms(null));
    return () => {
      live = false;
    };
  }, [connection, view.asset.mint, view.asset.address, wallet]);

  if (terms === undefined) return null;
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(ts * 1000);
  const cur = (v: bigint) => money(v, terms?.currencyDecimals ?? 6, locale);

  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("title")}</h2>
      {!terms ? (
        <p className="mt-2 text-sm text-ink-2">{t("none")}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-2">{t("lede", { rate: (terms.couponBps / 100).toFixed(2) })}</p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {terms.periods.map((p, i) => {
              const row = rows[i];
              const record = row?.record;
              const payout = row?.payout;
              let status: string;
              let amount: string;
              let tone = "pill-neutral";
              if (record) {
                amount = cur(record.amount);
                status = record.heldBack ? t("heldBack") : t("paid");
                tone = record.heldBack ? "pill-warn" : "pill-ok";
              } else if (payout) {
                amount = "—";
                // every entitlement settled and none of them this wallet's: it held nothing on the record date
                const settled = payout.status === "committed" && payout.paid + payout.heldBack >= payout.required;
                if (settled) status = t("notOnRegister");
                else status = payout.status === "committed" ? t("paying") : t("fixed");
              } else {
                amount = `${cur(couponAmount(terms, p, units + escrowed))} ${t("est")}`;
                status = t("scheduled");
              }
              return (
                <li key={i} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    {t("row", { n: i + 1 })} <span className="text-ink-3">· {date(p.accrualEnd)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular">{amount}</span>
                    <span className={`pill ${tone}`}>{status}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
