"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { createServicedMintInstructions, type Registry } from "@/lib/chain/program";
import { program } from "@/lib/chain/use-asset";
import { useTransaction } from "@/lib/chain/use-transaction";

/** Mainland China stays off by default: its 2026 rules bar offshore RWA business on mainland assets without approval. */
export const BLOCKED_BY_DEFAULT = [156];
const DEFAULT_ALLOWED = [344, 702, 158, 356];

export function CreateRegistry({ onDone }: { onDone: () => void }) {
  const t = useTranslations("issuer.onboarding");
  const locale = useLocale();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [minTier, setMinTier] = useState(1);
  const [accredited, setAccredited] = useState(false);
  const [allowed, setAllowed] = useState<number[]>(DEFAULT_ALLOWED);

  const submit = async () => {
    if (!publicKey) return;
    const registry = program.registryAddress(publicKey);
    const result = await tx.run([
      program.createRegistry(publicKey, minTier, accredited),
      ...allowed.map((code) => program.setJurisdiction(publicKey, registry, code, true)),
    ]);
    if (result.status === "confirmed") onDone();
  };

  return (
    <section className="card max-w-3xl p-6">
      <h2 className="text-lg font-semibold">{t("registryTitle")}</h2>
      <p className="mt-1 text-sm text-ink-2">{t("registryBody")}</p>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <label>
          <span className="field-label">{t("minTier")}</span>
          <select className="input" value={minTier} onChange={(e) => setMinTier(Number(e.target.value))}>
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {t(`tier${n}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={accredited} onChange={(e) => setAccredited(e.target.checked)} />
          {t("requireAccredited")}
        </label>
      </div>

      <fieldset className="mt-6">
        <legend className="field-label">{t("jurisdictions")}</legend>
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
                {BLOCKED_BY_DEFAULT.includes(j.code) && <span className="pill pill-warn ml-auto">{t("offByDefault")}</span>}
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-ink-3">{t("chinaNote")}</p>
      </fieldset>

      <button className="btn btn-primary mt-6" disabled={tx.busy || allowed.length === 0} onClick={submit}>
        {t("createRegistry")}
      </button>
      <TxReceipt state={tx.state} what={t("registryWhat")} />
    </section>
  );
}

export function CreateAsset({ registry, onDone }: { registry: Registry; onDone: () => void }) {
  const t = useTranslations("issuer.onboarding");
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTransaction();

  const submit = async () => {
    if (!publicKey) return;
    const mint = Keypair.generate();
    // Created and registered in one transaction: there is never a moment when
    // the mint exists but is not yet under AssetFlow.
    const result = await tx.run(
      [
        ...(await createServicedMintInstructions(
          connection,
          publicKey,
          mint.publicKey,
          program.assetAddress(mint.publicKey),
          0,
        )),
        program.registerAsset(publicKey, publicKey, registry.address, mint.publicKey),
      ],
      { signers: [mint] },
    );
    if (result.status === "confirmed") onDone();
  };

  const points = ["frozen", "gate", "authorities", "extensions"] as const;
  return (
    <section className="card max-w-3xl p-6">
      <h2 className="text-lg font-semibold">{t("assetTitle")}</h2>
      <p className="mt-1 text-sm text-ink-2">{t("assetBody")}</p>
      <ul className="mt-4 space-y-2 text-sm">
        {points.map((p) => (
          <li key={p} className="flex gap-2">
            <span className="text-ok" aria-hidden="true">
              ✓
            </span>
            {t(`assetPoints.${p}`)}
          </li>
        ))}
      </ul>
      <button className="btn btn-primary mt-6" disabled={tx.busy} onClick={submit}>
        {t("createAsset")}
      </button>
      <TxReceipt state={tx.state} what={t("assetWhat")} />
    </section>
  );
}
