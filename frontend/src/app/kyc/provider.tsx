"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Buffer } from "buffer";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { useLocale, useTranslations } from "next-intl";
import { PageShell } from "@/components/page-shell";
import { TxReceipt } from "@/components/tx-receipt";
import { WalletButton } from "@/components/wallet-button";
import { KYC_CREDENTIAL, KYC_SCHEMA } from "@/lib/chain/config";
import { waitForConfirmation } from "@/lib/chain/confirm";
import { explainFailure } from "@/lib/chain/errors";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { JURISDICTIONS, jurisdictionName } from "@/lib/chain/jurisdictions";
import { attestationAddress, fetchAttestation, type InvestorAttestation } from "@/lib/chain/kyc";
import type { TxState } from "@/lib/chain/use-transaction";

/** A stand-in KYC provider: it attests what the visitor picks, on the Solana Attestation Service. */
export function KycProvider() {
  const t = useTranslations("kyc");
  const locale = useLocale();
  const params = useSearchParams();
  const asset = params.get("asset");
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [attestation, setAttestation] = useState<InvestorAttestation | null | undefined>(undefined);
  const [jurisdiction, setJurisdiction] = useState(344);
  const [tier, setTier] = useState(1);
  const [accredited, setAccredited] = useState(false);
  const [state, setState] = useState<TxState>({ status: "idle" });
  const [what, setWhat] = useState("attest");
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!publicKey || !KYC_CREDENTIAL || !KYC_SCHEMA) return;
    let live = true;
    fetchAttestation(connection, attestationAddress(KYC_CREDENTIAL, KYC_SCHEMA, publicKey))
      .then((a) => live && setAttestation(a))
      .catch(() => live && setAttestation(null));
    return () => {
      live = false;
    };
  }, [connection, publicKey, tick]);

  // The provider signs on the server; the wallet signs as fee payer and sends.
  const send = async (action: "attest" | "revoke") => {
    if (!publicKey || !signTransaction) return;
    setWhat(action);
    setProblem(null);
    setState({ status: "signing" });
    try {
      const res = await fetch("/api/kyc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), action, jurisdiction, tier, accredited }),
      });
      const body = await res.json();
      if (!res.ok) {
        setState({ status: "idle" });
        setProblem(body.error ?? t("unavailable"));
        return;
      }
      const signed = await signTransaction(Transaction.from(Buffer.from(body.transaction, "base64")));
      const signature = await connection.sendRawTransaction(signed.serialize());
      setState({ status: "sent", signature });
      const result = await waitForConfirmation(connection, signature, body.lastValidBlockHeight);
      if (result.err) {
        setState({ status: "failed", signature, refusal: explainFailure(result.err) });
        return;
      }
      setState({ status: "confirmed", signature, slot: result.slot });
      reload();
    } catch (error) {
      setState({ status: "failed", refusal: explainFailure(error) });
    }
  };

  const date = (ts: number) => (ts === 0 ? t("never") : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(ts * 1000));
  const busy = state.status === "signing" || state.status === "sent";

  return (
    <PageShell title={t("title")} subtitle={t("subtitle")}>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="card p-5">
          <p className="rounded-md bg-warn-soft p-3 text-sm text-warn">{t("demoOnly")}</p>
          {!KYC_CREDENTIAL || !KYC_SCHEMA ? (
            <p className="mt-4 text-sm text-ink-2">{t("unavailable")}</p>
          ) : !publicKey ? (
            <div className="mt-4 flex flex-col items-start gap-3">
              <p className="text-sm text-ink-2">{t("connect")}</p>
              <WalletButton />
            </div>
          ) : attestation === undefined ? (
            <p className="mt-4 text-sm text-ink-2">{t("loading")}</p>
          ) : attestation ? (
            <div className="mt-4 text-sm">
              <h2 className="font-semibold">{t("yours")}</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-ink-2">{t("jurisdiction")}</dt>
                  <dd className="font-medium">{jurisdictionName(attestation.jurisdiction, locale)}</dd>
                </div>
                <div>
                  <dt className="text-ink-2">{t("tier")}</dt>
                  <dd className="font-medium">{attestation.tier}</dd>
                </div>
                <div>
                  <dt className="text-ink-2">{t("accredited")}</dt>
                  <dd className="font-medium">{attestation.accredited ? t("yes") : t("no")}</dd>
                </div>
                <div>
                  <dt className="text-ink-2">{t("expires")}</dt>
                  <dd className="font-medium">{date(attestation.expiry)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-ink-3">
                {t("onChain")}{" "}
                <a className="mono text-accent underline" href={explorer.address(attestation.address.toBase58())} target="_blank" rel="noreferrer">
                  {shortKey(attestation.address.toBase58())}
                </a>
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {asset && (
                  <Link className="btn btn-primary" href={`/holder?asset=${asset}`}>
                    {t("backToHolder")}
                  </Link>
                )}
                <button className="btn btn-danger" disabled={busy} onClick={() => send("revoke")}>
                  {t("revoke")}
                </button>
              </div>
              <p className="mt-2 text-xs text-ink-3">{t("revokeNote")}</p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 text-sm">
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
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={accredited} onChange={(e) => setAccredited(e.target.checked)} />
                {t("accreditedCheck")}
              </label>
              <div>
                <button className="btn btn-primary" disabled={busy} onClick={() => send("attest")}>
                  {t("attest")}
                </button>
              </div>
            </div>
          )}
          {problem && <p className="mt-3 rounded-md bg-bad-soft p-3 text-sm text-bad">{problem}</p>}
          <TxReceipt state={state} what={t(`what.${what}`)} />
        </section>

        <section className="card p-5 text-sm">
          <h2 className="font-semibold">{t("howTitle")}</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-ink-2">
            <li>{t("how1")}</li>
            <li>{t("how2")}</li>
            <li>{t("how3")}</li>
          </ol>
          {KYC_CREDENTIAL && (
            <p className="mt-4 text-xs text-ink-3">
              {t("credential")}{" "}
              <a className="mono text-accent underline" href={explorer.address(KYC_CREDENTIAL.toBase58())} target="_blank" rel="noreferrer">
                {shortKey(KYC_CREDENTIAL.toBase58())}
              </a>
            </p>
          )}
        </section>
      </div>
    </PageShell>
  );
}
