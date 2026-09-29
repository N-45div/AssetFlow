"use client";

import { useEffect, useState } from "react";
import type { Abi, Address } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { STATUS_TONE } from "@/components/holder-redemptions";
import { TxReceipt } from "@/components/tx-receipt";
import { money } from "@/app/issuer/coupons";
import { checkEligibility } from "@/lib/chain/eligibility";
import { shortKey } from "@/lib/chain/explorer";
import { accruedInterest, maturityDate, principal } from "@/lib/chain/redemptions";
import { servicedTokenAbi, servicerAbi } from "@/lib/evm/abi";
import type { EvmRequest } from "@/lib/evm/assetflow";
import type { BondView } from "@/lib/evm/use-bond";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmWallet } from "@/lib/evm/wallet";
import { useEvmChain } from "@/lib/evm/use-evm-chain";

const DAY = 86_400;

/** Early redemption requests, and maturity. */
export function BaseRedemptions({ view, onChange }: { view: BondView; onChange: () => void }) {
  const { pub, links } = useEvmChain();
  const t = useTranslations("issuer.redemptions");
  const tb = useTranslations("base.redemptions");
  const locale = useLocale();
  const { address } = useEvmWallet();
  const tx = useEvmTx();
  const [what, setWhat] = useState("settle");
  const [balance, setBalance] = useState<bigint | null>(null);
  const { bond, requests, registry } = view;
  const cur = (v: bigint) => money(v, bond.currencyDecimals, locale);
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts * 1000);
  const now = Math.floor(Date.now() / 1000);
  const quote = (r: EvmRequest, at = now) => principal(bond.facePerUnit, r.units) + accruedInterest(bond, r.units, at);
  const eligible = (w: Address) => checkEligibility(registry, view.profiles.find((p) => p.wallet.toLowerCase() === w.toLowerCase()) ?? null).eligible;
  const open = requests.filter((r) => r.status === "requested");
  const closed = requests.filter((r) => r.status !== "requested");
  const isIssuer = address?.toLowerCase() === bond.issuer.toLowerCase();
  const s = { address: bond.servicer, abi: servicerAbi as Abi };
  const approve = (amount: bigint) => ({ address: bond.currency, abi: servicedTokenAbi as Abi, functionName: "approve", args: [bond.servicer, amount] });

  useEffect(() => {
    if (!address) return;
    let live = true;
    pub
      .readContract({ address: bond.currency, abi: servicedTokenAbi, functionName: "balanceOf", args: [address] })
      .then((b) => live && setBalance(b as bigint))
      .catch(() => live && setBalance(null));
    return () => {
      live = false;
    };
  }, [address, bond.currency, bond.maturity.funded, requests.length, pub]);

  const run = async (key: string, calls: Parameters<typeof tx.run>[0]) => {
    setWhat(key);
    const r = await tx.run(calls);
    if (r.status === "confirmed") onChange();
  };
  // Approve what settlement could cost by tomorrow: interest only grows with the day, or drops to none.
  const settle = (r: EvmRequest) => run("settle", [approve(quote(r, now + DAY)), { ...s, functionName: "settle", args: [BigInt(r.id)] }]);

  const due = maturityDate(bond);
  const m = bond.maturity;
  const redeemable = view.profiles.filter((p) => {
    const u = view.units[p.wallet.toLowerCase()];
    return u && u.units > 0n && u.locked === 0n && eligible(p.wallet);
  });
  const held = view.profiles.filter((p) => (view.units[p.wallet.toLowerCase()]?.units ?? 0n) > 0n && !eligible(p.wallet));

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <h2 className="font-semibold">{t("requestsTitle")}</h2>
        <p className="mt-1 text-sm text-ink-2">{tb("requestsLede")}</p>
        {open.length === 0 ? (
          <p className="mt-4 text-sm text-ink-3">{t("noOpen")}</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-ink-2">
              <tr>
                <th className="py-2 pr-4 font-medium">{t("col.holder")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.units")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.requested")}</th>
                <th className="py-2 pr-4 font-medium">{t("col.price")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {open.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-4">
                    <span className="mono">{shortKey(r.holder)}</span>
                    {!eligible(r.holder) && <span className="pill pill-bad ml-2">{t("notEligible")}</span>}
                  </td>
                  <td className="tabular py-2 pr-4">{r.units.toString()}</td>
                  <td className="py-2 pr-4 text-ink-2">{date(r.requestedTs)}</td>
                  <td className="tabular py-2 pr-4">{cur(quote(r))}</td>
                  <td className="py-2">
                    <span className="flex justify-end gap-2">
                      {!bond.matured && (
                        <button className="btn btn-primary btn-sm" disabled={tx.busy || !isIssuer || !eligible(r.holder)} onClick={() => settle(r)}>
                          {t("settle", { amount: cur(quote(r)) })}
                        </button>
                      )}
                      <button className="btn btn-secondary btn-sm" disabled={tx.busy || !isIssuer} onClick={() => run("reject", [{ ...s, functionName: "reject", args: [BigInt(r.id)] }])}>
                        {t("reject")}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {balance !== null && <p className="mt-3 text-xs text-ink-3">{t("balance", { balance: cur(balance) })}</p>}
        <p className="mt-2 text-xs text-ink-3">{t("priceNote")}</p>
        {closed.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-ink-2">{t("history", { n: closed.length })}</summary>
            <ul className="mt-2 divide-y divide-line text-sm">
              {closed.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="mono">{shortKey(r.holder)}</span> · {r.units.toString()} {t("unitsWord")} · {date(r.closedTs)}
                    {r.status === "settled" && <span className="text-ink-3"> · {t("paidLine", { principal: cur(r.principal), interest: cur(r.interest) })}</span>}
                  </span>
                  <span className={`pill ${STATUS_TONE[r.status]}`}>{t(`status.${r.status}`)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card p-5 text-sm">
        <h2 className="font-semibold">{t("maturityTitle")}</h2>
        {!bond.matured ? (
          <>
            <p className="mt-2 text-ink-2">{t("maturityLede", { date: date(due), amount: cur(principal(bond.facePerUnit, bond.totalSupply)) })}</p>
            <p className="mt-2 text-xs text-ink-3">{tb("maturityNote")}</p>
            {open.length > 0 && <p className="mt-2 text-xs text-ink-3">{t("openAtMaturity", { n: open.length })}</p>}
            <button className="btn btn-primary mt-4" disabled={tx.busy || now < due} onClick={() => run("start", [{ ...s, functionName: "startMaturity" }])}>
              {t("start")}
            </button>
          </>
        ) : (
          <>
            <p className="mt-2 text-ink-2">{t("startedAt", { date: date(m.startedTs) })}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-ink-2">{t("required")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(m.required)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("funded")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(m.funded)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("paid")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(m.paid)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("outstanding")}</dt>
                <dd className="tabular text-lg font-semibold">{bond.totalSupply.toString()}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              {m.funded < m.required ? (
                <button
                  className="btn btn-primary"
                  disabled={tx.busy || (balance ?? 0n) < m.required - m.funded}
                  onClick={() => run("fund", [approve(m.required - m.funded), { ...s, functionName: "fundMaturity", args: [m.required - m.funded] }])}
                >
                  {t("fund", { amount: cur(m.required - m.funded) })}
                </button>
              ) : redeemable.length > 0 ? (
                <button
                  className="btn btn-primary"
                  disabled={tx.busy}
                  onClick={() => run("redeem", redeemable.map((p) => ({ ...s, functionName: "redeem", args: [p.wallet] })))}
                >
                  {t("redeemAll")}
                </button>
              ) : (
                <span className="pill pill-ok">{held.length ? t("allEligibleRedeemed") : t("allRedeemed")}</span>
              )}
            </div>
            {held.length > 0 && (
              <p className="mt-3 text-xs text-ink-3">
                {t("heldNote", { units: held.reduce((sum, p) => sum + (view.units[p.wallet.toLowerCase()]?.units ?? 0n), 0n).toString() })}
              </p>
            )}
          </>
        )}
      </section>
      <TxReceipt state={tx.state} what={tb(`what.${what}`)} link={links.tx} />
    </div>
  );
}
