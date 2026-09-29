"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { KYC_CREDENTIAL, KYC_SCHEMA, PROGRAM_ID } from "@/lib/chain/config";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { Kyc, fetchCredentialName, type KycSource } from "@/lib/chain/kyc";
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
      <KycSourceCard view={view} isCompliance={isCompliance} />
    </div>
  );
}

const kyc = new Kyc(PROGRAM_ID);
const keyOrNull = (v: string) => {
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
};

/** Which KYC provider's attestations the registry turns into investor profiles. */
function KycSourceCard({ view, isCompliance }: { view: AssetView; isCompliance: boolean }) {
  const t = useTranslations("issuer.policy.kyc");
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [source, setSource] = useState<KycSource | null | undefined>(undefined);
  const [name, setName] = useState<string | null>(null);
  const [credential, setCredential] = useState(KYC_CREDENTIAL?.toBase58() ?? "");
  const [schema, setSchema] = useState(KYC_SCHEMA?.toBase58() ?? "");
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const registry = view.registry.address;

  useEffect(() => {
    let live = true;
    (async () => {
      const s = await kyc.fetchSource(connection, registry);
      const n = s ? await fetchCredentialName(connection, s.credential) : null;
      if (!live) return;
      setName(n);
      setSource(s);
    })().catch(() => live && setSource(null));
    return () => {
      live = false;
    };
  }, [connection, registry, tick]);

  const set = async (accept: boolean) => {
    if (!publicKey) return;
    const c = accept ? keyOrNull(credential) : source?.credential;
    const s = accept ? keyOrNull(schema) : source?.schema;
    if (!c || !s) return;
    const r = await tx.run([kyc.setSource(publicKey, registry, c, s, accept)]);
    if (r.status === "confirmed") reload();
  };

  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("title")}</h2>
      <p className="mt-1 text-sm text-ink-2">{t("lede")}</p>
      {source === undefined ? null : source ? (
        <div className="mt-4 text-sm">
          <p>
            {t("trusts")} <span className="font-medium">{name ?? shortKey(source.credential.toBase58())}</span>{" "}
            <a className="mono text-accent underline" href={explorer.address(source.credential.toBase58())} target="_blank" rel="noreferrer">
              {shortKey(source.credential.toBase58())}
            </a>
          </p>
          <p className="mt-2 text-xs text-ink-3">{t("trustsNote")}</p>
          <button className="btn btn-secondary mt-3" disabled={tx.busy || !isCompliance} onClick={() => set(false)}>
            {t("stop")}
          </button>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 text-sm">
          <p className="text-ink-2">{t("none")}</p>
          <label>
            <span className="field-label">{t("credential")}</span>
            <input className="input mono" value={credential} onChange={(e) => setCredential(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t("schema")}</span>
            <input className="input mono" value={schema} onChange={(e) => setSchema(e.target.value)} />
          </label>
          {KYC_CREDENTIAL && credential === KYC_CREDENTIAL.toBase58() && (
            <p className="text-xs text-ink-3">
              {t("demoNote")}{" "}
              <Link className="text-accent underline" href="/kyc">
                {t("demoLink")}
              </Link>
            </p>
          )}
          <div>
            <button
              className="btn btn-primary"
              disabled={tx.busy || !isCompliance || !keyOrNull(credential) || !keyOrNull(schema)}
              onClick={() => set(true)}
            >
              {t("trust")}
            </button>
          </div>
        </div>
      )}
      <TxReceipt state={tx.state} what={t("what")} />
    </section>
  );
}
