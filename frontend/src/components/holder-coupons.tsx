"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { money } from "@/app/issuer/coupons";
import { TxReceipt } from "@/components/tx-receipt";
import { PROGRAM_ID } from "@/lib/chain/config";
import { Coupons, couponAmount, type CountedEntitlement, type Payout, type PaymentRecord, type Terms } from "@/lib/chain/coupons";
import { Redemptions } from "@/lib/chain/redemptions";
import type { AssetView } from "@/lib/chain/use-asset";
import { useTransaction } from "@/lib/chain/use-transaction";

const coupons = new Coupons(PROGRAM_ID);
const redemptions = new Redemptions(PROGRAM_ID);

interface Row {
  payout: Payout | null;
  record: PaymentRecord | null;
  /** What this wallet was counted for, while its coupon is unpaid. */
  entitlement: CountedEntitlement | null;
}

/** A holder's coupons: what was paid or held back, what is owed, and what the next ones come to. */
export function HolderCoupons({ view, wallet, units }: { view: AssetView; wallet: PublicKey; units: bigint }) {
  const t = useTranslations("holder.coupons");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [terms, setTerms] = useState<Terms | null | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [currencyProgram, setCurrencyProgram] = useState<PublicKey>(TOKEN_PROGRAM_ID);
  const [tick, setTick] = useState(0);
  // Units waiting in the redemption escrow are still this holder's on a record date.
  const [escrowed, setEscrowed] = useState(0n);

  useEffect(() => {
    let live = true;
    (async () => {
      const found = await coupons.fetchTerms(connection, view.asset.mint);
      if (!live) return;
      setTerms(found);
      if (!found) return;
      const [list, requests, owner] = await Promise.all([
        Promise.all(
          found.periods.map(async (_, i) => {
            const payout = await coupons.fetchPayout(connection, view.asset.mint, i);
            const [record, entitlement] = payout
              ? await Promise.all([
                  coupons.fetchPayment(connection, payout.address, wallet),
                  coupons.fetchEntitlement(connection, payout.address, wallet),
                ])
              : [null, null];
            return { payout, record, entitlement };
          }),
        ),
        redemptions.fetchRequests(connection, view.asset.address, wallet),
        connection.getAccountInfo(found.currencyMint).then((i) => i?.owner ?? TOKEN_PROGRAM_ID),
      ]);
      if (!live) return;
      setRows(list);
      setCurrencyProgram(owner);
      setEscrowed(requests.filter((r) => r.status === "requested").reduce((sum, r) => sum + r.units, 0n));
    })().catch(() => live && setTerms(null));
    return () => {
      live = false;
    };
  }, [connection, view.asset.mint, view.asset.address, wallet, tick]);

  if (terms === undefined) return null;
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(ts * 1000);
  const cur = (v: bigint) => money(v, terms?.currencyDecimals ?? 6, locale);

  // Anyone may pay a counted coupon; the holder need not wait for the issuer.
  const getPaid = async (period: number, entitlement: CountedEntitlement) => {
    if (!publicKey || !terms) return;
    const destination = getAssociatedTokenAddressSync(terms.currencyMint, wallet, false, currencyProgram);
    const r = await tx.run([
      createAssociatedTokenAccountIdempotentInstruction(publicKey, destination, wallet, terms.currencyMint, currencyProgram),
      coupons.payEntitlement(publicKey, view.registry.address, view.asset.mint, period, terms.currencyMint, currencyProgram, destination, wallet, entitlement.payer),
    ]);
    if (r.status === "confirmed") setTick((n) => n + 1);
  };

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
              const entitlement = row?.entitlement;
              let status: string;
              let amount: string;
              let tone = "pill-neutral";
              let action = false;
              if (record) {
                amount = cur(record.amount);
                status = record.heldBack ? t("heldBack") : t("paid");
                tone = record.heldBack ? "pill-warn" : "pill-ok";
              } else if (payout?.status === "counting") {
                amount = "—";
                status = t("counting");
              } else if (payout && entitlement) {
                amount = cur(couponAmount(terms, p, entitlement.units));
                if (payout.funded >= payout.required) {
                  status = t("owed");
                  action = true;
                } else status = t("funding");
              } else if (payout) {
                // counted, and nothing of this wallet's on it: it held nothing on the record date
                amount = "—";
                status = t("notOnRegister");
              } else {
                amount = `${cur(couponAmount(terms, p, units + escrowed))} ${t("est")}`;
                status = t("scheduled");
              }
              return (
                <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>
                    {t("row", { n: i + 1 })} <span className="text-ink-3">· {date(p.accrualEnd)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular">{amount}</span>
                    <span className={`pill ${tone}`}>{status}</span>
                    {action && entitlement && wallet.equals(publicKey ?? wallet) && (
                      <button className="btn btn-secondary btn-sm" disabled={tx.busy} onClick={() => getPaid(i, entitlement)}>
                        {t("getPaid")}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <TxReceipt state={tx.state} what={t("what")} />
        </>
      )}
    </section>
  );
}
