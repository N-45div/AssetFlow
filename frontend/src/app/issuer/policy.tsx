"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { program, type AssetView } from "@/lib/chain/use-asset";
import { useTransaction } from "@/lib/chain/use-transaction";
import { BLOCKED_BY_DEFAULT } from "./onboarding";

export function Policy({ view, onChange }: { view: AssetView; onChange: () => void }) {
  const t = useTranslations("issuer.policy");
  const to = useTranslations("issuer.onboarding");
  const locale = useLocale();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const registry = view.registry;
  const [minTier, setMinTier] = useState(registry.minTier);
  const [accredited, setAccredited] = useState(registry.requireAccredited);
  const [allowed, setAllowed] = useState<number[]>(registry.jurisdictions);
  const isCompliance = publicKey?.equals(registry.compliance) ?? false;

  const added = allowed.filter((c) => !registry.jurisdictions.includes(c));
  const removed = registry.jurisdictions.filter((c) => !allowed.includes(c));
  const policyChanged = minTier !== registry.minTier || accredited !== registry.requireAccredited;
  const dirty = policyChanged || added.length > 0 || removed.length > 0;

  const save = async () => {
    if (!publicKey) return;
    const result = await tx.run([
      ...(policyChanged ? [program.setPolicy(publicKey, registry.address, minTier, accredited)] : []),
      ...added.map((c) => program.setJurisdiction(publicKey, registry.address, c, true)),
      ...removed.map((c) => program.setJurisdiction(publicKey, registry.address, c, false)),
    ]);
    if (result.status === "confirmed") onChange();
  };

  return (
    <section className="card max-w-3xl p-5">
      <h2 className="font-semibold">{t("title")}</h2>
      <p className="mt-1 text-sm text-ink-2">{t("lede")}</p>
      {!isCompliance && <p className="mt-3 rounded-md bg-warn-soft p-3 text-sm text-warn">{t("notCompliance")}</p>}

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <label>
          <span className="field-label">{to("minTier")}</span>
          <select className="input" value={minTier} onChange={(e) => setMinTier(Number(e.target.value))}>
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {to(`tier${n}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={accredited} onChange={(e) => setAccredited(e.target.checked)} />
          {to("requireAccredited")}
        </label>
      </div>

      <fieldset className="mt-6">
        <legend className="field-label">{to("jurisdictions")}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {JURISDICTIONS.map((j) => {
            const on = allowed.includes(j.code);
            return (
              <label key={j.code} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setAllowed((a) => (on ? a.filter((c) => c !== j.code) : [...a, j.code]))}
                />
                <span>{locale.startsWith("zh") ? j.zh : j.en}</span>
                {BLOCKED_BY_DEFAULT.includes(j.code) && !on && (
                  <span className="pill pill-warn ml-auto">{to("offByDefault")}</span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="mt-4 text-xs text-ink-3">{t("effect")}</p>
      <button className="btn btn-primary mt-4" disabled={tx.busy || !dirty || !isCompliance} onClick={save}>
        {t("save")}
      </button>
      <TxReceipt state={tx.state} what={t("what")} />
    </section>
  );
}
