"use client";

import { useState } from "react";
import { zeroAddress, zeroHash, type Abi } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { shortKey } from "@/lib/chain/explorer";
import { registryAbi } from "@/lib/evm/abi";
import type { BondView } from "@/lib/evm/use-bond";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmWallet } from "@/lib/evm/wallet";
import { useEvmChain } from "@/lib/evm/use-evm-chain";
import { INVESTOR_SCHEMA, KYC_ATTESTER } from "@/lib/evm/chains";

/** The registry's policy, and the KYC provider (an EAS attester) it trusts. */
export function BasePolicy({ view, onChange }: { view: BondView; onChange: () => void }) {
  const { links } = useEvmChain();
  const t = useTranslations("issuer.policy");
  const to = useTranslations("issuer.onboarding");
  const tk = useTranslations("base.policy");
  const locale = useLocale();
  const { address } = useEvmWallet();
  const tx = useEvmTx();
  const kycTx = useEvmTx();
  const { registry } = view;
  const [minTier, setMinTier] = useState(registry.minTier);
  const [accredited, setAccredited] = useState(registry.requireAccredited);
  const [allowed, setAllowed] = useState<number[]>(registry.jurisdictions);
  const isCompliance = address?.toLowerCase() === registry.compliance.toLowerCase();
  const reg = { address: registry.address, abi: registryAbi as Abi };

  const added = allowed.filter((c) => !registry.jurisdictions.includes(c));
  const removed = registry.jurisdictions.filter((c) => !allowed.includes(c));
  const policyChanged = minTier !== registry.minTier || accredited !== registry.requireAccredited;
  const dirty = policyChanged || added.length > 0 || removed.length > 0;
  const trusting = registry.kycAttester !== zeroAddress;

  const save = async () => {
    const r = await tx.run([
      ...(policyChanged ? [{ ...reg, functionName: "setPolicy", args: [minTier, accredited] }] : []),
      ...added.map((c) => ({ ...reg, functionName: "setJurisdiction", args: [c, true] })),
      ...removed.map((c) => ({ ...reg, functionName: "setJurisdiction", args: [c, false] })),
    ]);
    if (r.status === "confirmed") onChange();
  };
  const setSource = async (trust: boolean) => {
    const r = await kycTx.run([
      { ...reg, functionName: "setKycSource", args: trust ? [INVESTOR_SCHEMA, KYC_ATTESTER] : [zeroHash, zeroAddress] },
    ]);
    if (r.status === "confirmed") onChange();
  };

  return (
    <div className="grid max-w-3xl gap-4">
      <section className="card p-5">
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
                  <input type="checkbox" checked={on} onChange={() => setAllowed((a) => (on ? a.filter((c) => c !== j.code) : [...a, j.code]))} />
                  <span>{locale.startsWith("zh") ? j.zh : j.en}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <button className="btn btn-primary mt-4" disabled={tx.busy || !dirty || !isCompliance} onClick={save}>
          {t("save")}
        </button>
        <TxReceipt state={tx.state} what={t("what")} link={links.tx} />
      </section>

      <section className="card p-5 text-sm">
        <h2 className="font-semibold">{tk("title")}</h2>
        <p className="mt-1 text-ink-2">{tk("lede")}</p>
        {trusting ? (
          <p className="mt-3">
            {tk("trusts")}{" "}
            <a className="mono text-accent underline" href={links.address(registry.kycAttester)} target="_blank" rel="noreferrer">
              {shortKey(registry.kycAttester)}
            </a>
            {registry.kycAttester.toLowerCase() === KYC_ATTESTER.toLowerCase() && <span className="text-ink-3"> ({tk("demoName")})</span>}
          </p>
        ) : (
          <p className="mt-3 text-ink-2">{tk("none")}</p>
        )}
        <button
          className={`btn mt-3 ${trusting ? "btn-secondary" : "btn-primary"}`}
          disabled={kycTx.busy || !isCompliance || (!trusting && !KYC_ATTESTER)}
          onClick={() => setSource(!trusting)}
        >
          {trusting ? tk("stop") : tk("trust")}
        </button>
        <TxReceipt state={kycTx.state} what={tk("what")} link={links.tx} />
      </section>
    </div>
  );
}
