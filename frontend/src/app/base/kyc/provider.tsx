"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { parseEventLogs, type Abi, type Hash, type Hex } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { EvmWalletButton } from "@/components/evm-wallet-button";
import { PageShell } from "@/components/page-shell";
import { TxReceipt } from "@/components/tx-receipt";
import { shortKey } from "@/lib/chain/explorer";
import { JURISDICTIONS, jurisdictionName } from "@/lib/chain/jurisdictions";
import type { EvmAttestation } from "@/lib/evm/assetflow";
import { BASE, basePublic, baseExplorer, easAbi } from "@/lib/evm/base";
import { findAttestation, kycMessage, rememberAttestation } from "@/lib/evm/kyc-base";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmWallet } from "@/lib/evm/wallet";

/** A stand-in KYC provider on Base: EAS attestations, signed by the provider and sent by the wallet. */
export function BaseKycProvider() {
  const t = useTranslations("kyc");
  const tb = useTranslations("base.kyc");
  const locale = useLocale();
  const params = useSearchParams();
  const bond = params.get("bond");
  const { address, client } = useEvmWallet();
  const tx = useEvmTx();
  const [attestation, setAttestation] = useState<EvmAttestation | null | undefined>(undefined);
  const [jurisdiction, setJurisdiction] = useState(344);
  const [tier, setTier] = useState(1);
  const [accredited, setAccredited] = useState(false);
  const [what, setWhat] = useState<"attest" | "revoke">("attest");
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!address || !BASE.kycAttester) return;
    let live = true;
    setAttestation(undefined);
    findAttestation(address, BASE.investorSchema, BASE.kycAttester)
      .then((a) => live && setAttestation(a))
      .catch(() => live && setAttestation(null));
    return () => {
      live = false;
    };
  }, [address, tick]);

  // The wallet signs a message to show it asks; the provider signs the attestation; the wallet sends it.
  const send = async (action: "attest" | "revoke") => {
    if (!address || !client) return;
    setWhat(action);
    setProblem(null);
    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const proof = await client.signMessage({ account: client.account ?? address, message: kycMessage(address, action, issuedAt) });
      // The provider's signatures count up one nonce: one signed for someone else at the same
      // moment, or read from a node a block behind, goes stale and fails its simulation.
      // Ask again with the same proof; the wallet is not prompted twice.
      let done: Awaited<ReturnType<typeof tx.run>> = { status: "idle" };
      for (let attempt = 0; attempt < 3 && done.status !== "confirmed"; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000));
        const res = await fetch("/api/kyc-base", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: address, action, jurisdiction, tier, accredited, uid: attestation?.uid, proof, issuedAt }),
        });
        const body = await res.json();
        if (!res.ok) {
          setProblem(body.error ?? t("unavailable"));
          return;
        }
        const r = body.request;
        const request =
          action === "attest"
            ? { ...r, data: { ...r.data, expirationTime: BigInt(r.data.expirationTime), value: 0n }, deadline: BigInt(r.deadline) }
            : { ...r, data: { uid: r.data.uid, value: 0n }, deadline: BigInt(r.deadline) };
        done = await tx.run([
          { address: BASE.eas, abi: easAbi as Abi, functionName: action === "attest" ? "attestByDelegation" : "revokeByDelegation", args: [request] },
        ]);
        // only a stale signature is worth another try; a refusal the user made stands
        if (done.status === "failed" && done.refusal.code === "Rejected") return;
      }
      if (done.status !== "confirmed") return;
      if (action === "attest") {
        const receipt = await basePublic.getTransactionReceipt({ hash: done.signature as Hash });
        const uid = parseEventLogs({ abi: easAbi, logs: receipt.logs, eventName: "Attested" })[0]?.args.uid as Hex | undefined;
        rememberAttestation(address, uid ?? null);
      } else {
        rememberAttestation(address, null);
      }
      reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  };

  const date = (ts: number) => (ts === 0 ? t("never") : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(ts * 1000));
  return (
    <PageShell title={tb("title")} subtitle={tb("subtitle")}>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="card p-5">
          <p className="rounded-md bg-warn-soft p-3 text-sm text-warn">{t("demoOnly")}</p>
          {!BASE.kycAttester ? (
            <p className="mt-4 text-sm text-ink-2">{t("unavailable")}</p>
          ) : !address ? (
            <div className="mt-4 flex flex-col items-start gap-3">
              <p className="text-sm text-ink-2">{t("connect")}</p>
              <EvmWalletButton />
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
                  <dd className="font-medium">{date(attestation.expirationTime)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-ink-3">
                {tb("onEas")}{" "}
                <a className="mono text-accent underline" href={`https://base-sepolia.easscan.org/attestation/view/${attestation.uid}`} target="_blank" rel="noreferrer">
                  {shortKey(attestation.uid)}
                </a>
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {bond && (
                  <Link className="btn btn-primary" href={`/base/holder?bond=${bond}`}>
                    {t("backToHolder")}
                  </Link>
                )}
                <button className="btn btn-danger" disabled={tx.busy} onClick={() => send("revoke")}>
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
              <p className="text-xs text-ink-3">{tb("twoSteps")}</p>
              <div>
                <button className="btn btn-primary" disabled={tx.busy} onClick={() => send("attest")}>
                  {t("attest")}
                </button>
              </div>
            </div>
          )}
          {problem && <p className="mt-3 rounded-md bg-bad-soft p-3 text-sm text-bad">{problem}</p>}
          <TxReceipt state={tx.state} what={t(`what.${what}`)} link={baseExplorer.tx} />
        </section>

        <section className="card p-5 text-sm">
          <h2 className="font-semibold">{t("howTitle")}</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-ink-2">
            <li>{tb("how1")}</li>
            <li>{t("how2")}</li>
            <li>{t("how3")}</li>
          </ol>
          {BASE.kycAttester && (
            <p className="mt-4 text-xs text-ink-3">
              {tb("attester")}{" "}
              <a className="mono text-accent underline" href={baseExplorer.address(BASE.kycAttester)} target="_blank" rel="noreferrer">
                {shortKey(BASE.kycAttester)}
              </a>
            </p>
          )}
        </section>
      </div>
    </PageShell>
  );
}
