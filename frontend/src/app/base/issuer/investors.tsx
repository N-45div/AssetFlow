"use client";

import { useState } from "react";
import { isAddress, type Abi, type Address } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { checkEligibility } from "@/lib/chain/eligibility";
import { shortKey } from "@/lib/chain/explorer";
import { JURISDICTIONS, jurisdictionName } from "@/lib/chain/jurisdictions";
import { NO_EXPIRY } from "@/lib/chain/kyc";
import { registryAbi } from "@/lib/evm/abi";
import type { EvmProfile } from "@/lib/evm/assetflow";
import { baseExplorer } from "@/lib/evm/base";
import type { BondView } from "@/lib/evm/use-bond";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmWallet } from "@/lib/evm/wallet";

const DAY = 86_400;

/** Every profile in the registry and every wallet that has held units, with what the chain says about each. */
export function BaseInvestors({ view, onChange }: { view: BondView; onChange: () => void }) {
  const t = useTranslations("issuer.investors");
  const te = useTranslations("eligibility");
  const locale = useLocale();
  const { address } = useEvmWallet();
  const tx = useEvmTx();
  const [what, setWhat] = useState("editor.what");
  const [editing, setEditing] = useState<EvmProfile | "new" | null>(null);
  const { registry } = view;
  const isCompliance = address?.toLowerCase() === registry.compliance.toLowerCase();
  const date = (s: number) => (s >= NO_EXPIRY ? t("noExpiry") : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(s * 1000));
  const reg = { address: registry.address, abi: registryAbi as Abi };

  const act = async (key: string, functionName: string, args: unknown[]) => {
    setWhat(key);
    const r = await tx.run([{ ...reg, functionName, args }]);
    if (r.status === "confirmed") onChange();
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">{t("lede")}</p>
        <button className="btn btn-primary btn-sm" disabled={!isCompliance} onClick={() => setEditing("new")}>
          {t("add")}
        </button>
      </div>
      {editing && (
        <Editor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (wallet, p) => {
            setWhat("editor.what");
            const r = await tx.run([{ ...reg, functionName: "setProfile", args: [wallet, p] }]);
            if (r.status === "confirmed") {
              setEditing(null);
              onChange();
            }
          }}
          busy={tx.busy}
        />
      )}
      <TxReceipt state={tx.state} what={t(what)} link={baseExplorer.tx} />

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-line text-ink-2">
            <tr>
              <th className="px-4 py-3 font-medium">{t("col.wallet")}</th>
              <th className="px-4 py-3 font-medium">{t("col.jurisdiction")}</th>
              <th className="px-4 py-3 font-medium">{t("col.tier")}</th>
              <th className="px-4 py-3 font-medium">{t("col.expiry")}</th>
              <th className="px-4 py-3 font-medium">{t("col.status")}</th>
              <th className="px-4 py-3 text-right font-medium">{t("col.units")}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {view.profiles.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-ink-2">
                  {t("empty")}
                </td>
              </tr>
            )}
            {view.profiles.map((p) => {
              const key = p.wallet.toLowerCase();
              const listed = p.expiry > 0 || p.approved;
              const check = checkEligibility(registry, listed ? p : null);
              const reason = check.rules.find((x) => !x.pass && !x.skipped)?.id ?? "profile";
              const vouches = view.attested[key];
              const held = view.units[key];
              return (
                <tr key={key}>
                  <td className="px-4 py-3">
                    <a className="mono text-accent" href={baseExplorer.address(p.wallet)} target="_blank" rel="noreferrer">
                      {shortKey(p.wallet)}
                    </a>
                    {p.attestedFrom && (
                      <span className={`pill ml-2 ${vouches ? "pill-neutral" : "pill-warn"}`}>{vouches ? t("attested") : t("attestationGone")}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{listed ? jurisdictionName(p.jurisdiction, locale) : "—"}</td>
                  <td className="tabular px-4 py-3">{listed ? p.tier : "—"}</td>
                  <td className="tabular px-4 py-3">{listed ? date(p.expiry) : "—"}</td>
                  <td className="px-4 py-3">
                    {check.eligible ? <span className="pill pill-ok">{te("eligible")}</span> : <span className="pill pill-bad">{t(`reason.${reason}`)}</span>}
                  </td>
                  <td className="tabular px-4 py-3 text-right">{(held?.units ?? 0n).toString()}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {p.attestedFrom && !vouches && p.approved && (
                      <button className="btn btn-danger btn-sm mr-2" disabled={tx.busy} onClick={() => act("lapseWhat", "lapseProfile", [p.wallet])}>
                        {t("lapse")}
                      </button>
                    )}
                    {listed && (
                      <button
                        className="btn btn-secondary btn-sm mr-2"
                        disabled={tx.busy || !isCompliance}
                        onClick={() => act("holdWhat", "setHold", [p.wallet, !p.frozen])}
                      >
                        {p.frozen ? t("liftHold") : t("hold")}
                      </button>
                    )}
                    <button className="btn btn-secondary btn-sm" disabled={!isCompliance} onClick={() => setEditing(p)}>
                      {listed ? t("edit") : t("onboard")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Editor({
  initial,
  onClose,
  onSave,
  busy,
}: {
  initial: EvmProfile | null;
  onClose: () => void;
  onSave: (wallet: Address, p: { approved: boolean; accredited: boolean; hold: boolean; tier: number; jurisdiction: number; expiry: bigint }) => void;
  busy: boolean;
}) {
  const t = useTranslations("issuer.investors.editor");
  const locale = useLocale();
  const [wallet, setWallet] = useState<string>(initial?.wallet ?? "");
  const [jurisdiction, setJurisdiction] = useState(initial?.jurisdiction || 344);
  const [tier, setTier] = useState(initial?.tier || 1);
  const [accredited, setAccredited] = useState(initial?.accredited ?? false);
  const [approved, setApproved] = useState(initial?.approved ?? true);
  const [hold, setHold] = useState(initial?.frozen ?? false);
  const [expiry, setExpiry] = useState(() => {
    const e = initial?.expiry && initial.expiry < NO_EXPIRY ? initial.expiry : Math.floor(Date.now() / 1000) + 365 * DAY;
    return new Date(e * 1000).toISOString().slice(0, 10);
  });
  const valid = isAddress(wallet);
  return (
    <section className="card p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="field-label">{t("wallet")}</span>
          <input className="input mono" value={wallet} disabled={!!initial} onChange={(e) => setWallet(e.target.value.trim())} placeholder="0x…" />
        </label>
        <label>
          <span className="field-label">{t("jurisdiction")}</span>
          <select className="input" value={jurisdiction} onChange={(e) => setJurisdiction(Number(e.target.value))}>
            {JURISDICTIONS.map((j) => (
              <option key={j.code} value={j.code}>
                {locale.startsWith("zh") ? j.zh : j.en}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t("tier")}</span>
          <select className="input" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t("expiry")}</span>
          <input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <div className="flex flex-col justify-end gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
            {t("approved")}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={accredited} onChange={(e) => setAccredited(e.target.checked)} />
            {t("accredited")}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
            {t("hold")}
          </label>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          className="btn btn-primary"
          disabled={busy || !valid}
          onClick={() =>
            onSave(wallet as Address, {
              approved,
              accredited,
              hold,
              tier,
              jurisdiction,
              expiry: BigInt(Math.floor(Date.parse(`${expiry}T23:59:59Z`) / 1000)),
            })
          }
        >
          {t("save")}
        </button>
        <button className="btn btn-secondary" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
    </section>
  );
}
