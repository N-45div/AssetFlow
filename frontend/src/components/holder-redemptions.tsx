"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, type Account } from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { money } from "@/app/issuer/coupons";
import { TxReceipt } from "@/components/tx-receipt";
import { PROGRAM_ID } from "@/lib/chain/config";
import { Coupons, type Terms } from "@/lib/chain/coupons";
import { TokenAcl } from "@/lib/chain/program";
import {
  Redemptions,
  accruedInterest,
  nextRequestId,
  principal,
  type Maturity,
  type MaturityRecord,
  type RedemptionRequest,
} from "@/lib/chain/redemptions";
import { formatUnits, program, type AssetView } from "@/lib/chain/use-asset";
import { parseUnits } from "@/lib/chain/use-register";
import { useTransaction } from "@/lib/chain/use-transaction";

const coupons = new Coupons(PROGRAM_ID);
const redemptions = new Redemptions(PROGRAM_ID);

export const STATUS_TONE: Record<RedemptionRequest["status"], string> = {
  requested: "pill-warn",
  settled: "pill-ok",
  rejected: "pill-bad",
  cancelled: "pill-neutral",
};

interface Props {
  view: AssetView;
  wallet: PublicKey;
  account: Account | null;
  tokenAccount: PublicKey;
  eligible: boolean;
  onChange: () => void;
}

/** Ask to redeem early, follow a request, and redeem at maturity. */
export function HolderRedemptions({ view, wallet, account, tokenAccount, eligible, onChange }: Props) {
  const t = useTranslations("holder.redeem");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [what, setWhat] = useState("request");
  const [terms, setTerms] = useState<Terms | null | undefined>(undefined);
  const [maturity, setMaturity] = useState<Maturity | null>(null);
  const [record, setRecord] = useState<MaturityRecord | null>(null);
  const [requests, setRequests] = useState<RedemptionRequest[]>([]);
  const [currencyProgram, setCurrencyProgram] = useState<PublicKey>(TOKEN_PROGRAM_ID);
  const [amount, setAmount] = useState("");
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const mint = view.asset.mint;
  const held = account?.amount ?? 0n;

  useEffect(() => {
    let live = true;
    (async () => {
      const found = await coupons.fetchTerms(connection, mint);
      if (!live) return;
      if (!found) {
        setTerms(null);
        return;
      }
      const [owner, m, mine, r] = await Promise.all([
        connection.getAccountInfo(found.currencyMint).then((i) => i?.owner ?? TOKEN_PROGRAM_ID),
        redemptions.fetchMaturity(connection, mint),
        redemptions.fetchRequests(connection, view.asset.address, wallet),
        redemptions.fetchMaturityRecord(connection, mint, wallet),
      ]);
      if (!live) return;
      setCurrencyProgram(owner);
      setMaturity(m);
      setRequests(mine);
      setRecord(r);
      setTerms(found); // last, so the form never shows for an asset that has matured
    })().catch(() => live && setTerms(null));
    return () => {
      live = false;
    };
  }, [connection, mint, view.asset.address, wallet, tick]);

  const units = useMemo(() => parseUnits(amount, view.decimals), [amount, view.decimals]);
  if (terms === undefined) return null;
  const cur = (v: bigint) => money(v, terms?.currencyDecimals ?? 6, locale);
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(ts * 1000);
  const fmt = (v: bigint) => formatUnits(v, view.decimals, locale);

  const done = (status: string) => {
    if (status !== "confirmed") return;
    setAmount("");
    reload();
    onChange();
  };

  const request = async () => {
    if (!publicKey || !units) return;
    setWhat("request");
    const r = await tx.run(
      redemptions.requestRedemption(publicKey, view.registry.address, mint, tokenAccount, nextRequestId(requests), units),
    );
    done(r.status);
  };

  const withdraw = async (req: RedemptionRequest) => {
    if (!publicKey) return;
    setWhat("cancel");
    const r = await tx.run([redemptions.returnRedemption("cancel", publicKey, mint, req)]);
    done(r.status);
  };

  // An eligible holder whose account is frozen asks the gate to thaw it first, in the same transaction.
  const redeem = async () => {
    if (!publicKey || !terms) return;
    setWhat("redeem");
    const thaw = account?.isFrozen
      ? [TokenAcl.permissionless("thaw", publicKey, mint, tokenAccount, publicKey, PROGRAM_ID, program.gateAccounts("thaw", mint, view.registry.address, publicKey))]
      : [];
    const r = await tx.run([
      ...thaw,
      ...redemptions.redeemAtMaturity(publicKey, view.registry.address, mint, terms.currencyMint, currencyProgram, tokenAccount, publicKey),
    ]);
    done(r.status);
  };

  const now = Math.floor(Date.now() / 1000);
  const quote = terms && units ? { face: principal(terms.facePerUnit, units), interest: accruedInterest(terms, units, now) } : null;
  const tooMany = units !== null && units > held;

  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("title")}</h2>
      {!terms ? (
        <p className="mt-2 text-sm text-ink-2">{t("none")}</p>
      ) : maturity ? (
        <div className="mt-2 text-sm">
          <p className="text-ink-2">{t("matured", { date: date(maturity.startedTs), face: cur(maturity.facePerUnit) })}</p>
          {record && (
            <p className="mt-3 flex items-center justify-between gap-2">
              <span>{t("redeemed", { units: fmt(record.units), amount: cur(record.amount) })}</span>
              <span className="pill pill-ok">{t("status.settled")}</span>
            </p>
          )}
          {held > 0n &&
            (maturity.funded < maturity.required ? (
              <p className="mt-3 text-ink-2">{t("awaitingFunds", { funded: cur(maturity.funded), required: cur(maturity.required) })}</p>
            ) : eligible ? (
              <button className="btn btn-primary mt-3" disabled={tx.busy} onClick={redeem}>
                {t("redeemAll", { units: fmt(held), amount: cur(principal(maturity.facePerUnit, held)) })}
              </button>
            ) : (
              <p className="mt-3 text-warn">{t("heldAtMaturity")}</p>
            ))}
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-2">{t("lede")}</p>
          {eligible && held > 0n ? (
            <div className="mt-4 space-y-3 text-sm">
              <label className="block">
                <span className="text-ink-2">{t("units")}</span>
                <div className="mt-1 flex gap-2">
                  <input
                    className="input tabular"
                    inputMode="decimal"
                    value={amount}
                    placeholder="0"
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <button className="btn btn-secondary" type="button" onClick={() => setAmount(fmt(held).replace(/[^\d.]/g, ""))}>
                    {t("max")}
                  </button>
                </div>
              </label>
              {quote && !tooMany && (
                <dl className="grid grid-cols-3 gap-2 rounded-md bg-surface-2 p-3">
                  <div>
                    <dt className="text-ink-2">{t("quoteFace")}</dt>
                    <dd className="tabular font-semibold">{cur(quote.face)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-2">{t("quoteInterest")}</dt>
                    <dd className="tabular font-semibold">{cur(quote.interest)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-2">{t("quoteTotal")}</dt>
                    <dd className="tabular font-semibold">{cur(quote.face + quote.interest)}</dd>
                  </div>
                </dl>
              )}
              {tooMany && <p className="text-warn">{t("tooMany", { units: fmt(held) })}</p>}
              <p className="text-xs text-ink-3">{t("quoteNote")}</p>
              <button className="btn btn-primary" disabled={tx.busy || !units || tooMany || account?.isFrozen} onClick={request}>
                {t("request")}
              </button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-3">{eligible ? t("nothingHeld") : t("notEligible")}</p>
          )}
        </>
      )}

      {requests.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">{t("mine")}</h3>
          {requests.some((r) => r.status === "requested") && (
            <p className="mt-1 text-xs text-ink-3">
              {t("escrowNote", {
                units: fmt(requests.filter((r) => r.status === "requested").reduce((sum, r) => sum + r.units, 0n)),
              })}
            </p>
          )}
          <ul className="mt-2 divide-y divide-line text-sm">
            {requests.map((r) => (
              <li key={r.address.toBase58()} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {t("row", { units: fmt(r.units), date: date(r.requestedTs) })}
                  {r.status === "settled" && <span className="text-ink-3"> · {t("paidAmount", { amount: cur(r.principal + r.interest) })}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {r.status === "requested" && (
                    <button className="btn btn-secondary btn-sm" disabled={tx.busy} onClick={() => withdraw(r)}>
                      {t("withdraw")}
                    </button>
                  )}
                  <span className={`pill ${STATUS_TONE[r.status]}`}>{t(`status.${r.status}`)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <TxReceipt state={tx.state} what={t(`what.${what}`)} />
    </section>
  );
}
