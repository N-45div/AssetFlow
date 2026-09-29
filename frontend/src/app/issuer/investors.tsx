"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { PROGRAM_ID } from "@/lib/chain/config";
import { shortKey } from "@/lib/chain/explorer";
import { JURISDICTIONS, jurisdictionName } from "@/lib/chain/jurisdictions";
import { Kyc, NO_EXPIRY, attestationValid, fetchAttestation, type AttestedProfile } from "@/lib/chain/kyc";
import { TokenAcl, type InvestorProfile } from "@/lib/chain/program";
import { formatUnits, program, type AssetView } from "@/lib/chain/use-asset";
import type { RegisterRow } from "@/lib/chain/use-register";
import { useTransaction } from "@/lib/chain/use-transaction";

const DAY = 86_400;
const kyc = new Kyc(PROGRAM_ID);

/** Profiles written from an attestation, and whether that attestation still backs them. */
function useAttested(view: AssetView, rows: RegisterRow[] | null) {
  const { connection } = useConnection();
  const [attested, setAttested] = useState<Map<string, { marker: AttestedProfile; vouches: boolean }>>(new Map());
  const registry = view.registry.address;
  useEffect(() => {
    let live = true;
    (async () => {
      const [source, markers] = await Promise.all([kyc.fetchSource(connection, registry), kyc.fetchAttested(connection, registry)]);
      const out = new Map<string, { marker: AttestedProfile; vouches: boolean }>();
      await Promise.all(
        [...markers].map(async ([wallet, marker]) => {
          const a = await fetchAttestation(connection, marker.attestation);
          const vouches =
            !!a && !!source && attestationValid(a) && a.credential.equals(source.credential) && a.schema.equals(source.schema) && a.wallet.toBase58() === wallet;
          out.set(wallet, { marker, vouches });
        }),
      );
      if (live) setAttested(out);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connection, registry, rows]);
  return attested;
}

export function Investors({
  view,
  rows,
  onChange,
}: {
  view: AssetView;
  rows: RegisterRow[] | null;
  onChange: () => void;
}) {
  const t = useTranslations("issuer.investors");
  const te = useTranslations("eligibility");
  const locale = useLocale();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  // Owned here, not by the editor, so the receipt outlives the closed editor.
  const saveTx = useTransaction();
  const [editing, setEditing] = useState<InvestorProfile | "new" | null>(null);
  const date = (s: number) =>
    s >= NO_EXPIRY ? t("noExpiry") : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(s * 1000);
  const attested = useAttested(view, rows);
  const [what, setWhat] = useState<"enforceWhat" | "lapseWhat">("enforceWhat");

  // Anyone may withdraw an approval its attestation no longer backs.
  const lapse = async (row: RegisterRow, marker: AttestedProfile) => {
    if (!publicKey) return;
    setWhat("lapseWhat");
    const result = await tx.run([kyc.lapseProfile(view.registry.address, row.wallet, marker.attestation)]);
    if (result.status === "confirmed") onChange();
  };

  // Anyone may freeze a holder the gate would no longer admit; the issuer is
  // just the one who noticed.
  const enforce = async (row: RegisterRow) => {
    if (!publicKey) return;
    setWhat("enforceWhat");
    const result = await tx.run(
      row.accounts
        .filter((a) => !a.isFrozen)
        .map((a) =>
          TokenAcl.permissionless(
            "freeze",
            publicKey,
            view.asset.mint,
            a.address,
            row.wallet,
            PROGRAM_ID,
            program.gateAccounts("freeze", view.asset.mint, view.registry.address, row.wallet),
          ),
        ),
    );
    if (result.status === "confirmed") onChange();
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">{t("lede")}</p>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            saveTx.reset();
            setEditing("new");
          }}
        >
          {t("add")}
        </button>
      </div>
      <TxReceipt state={saveTx.state} what={t("editor.what")} />

      {editing && (
        <ProfileEditor
          view={view}
          initial={editing === "new" ? null : editing}
          tx={saveTx}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChange();
          }}
        />
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-line text-ink-2">
            <tr>
              <th className="px-4 py-3 font-medium">{t("col.wallet")}</th>
              <th className="px-4 py-3 font-medium">{t("col.jurisdiction")}</th>
              <th className="px-4 py-3 font-medium">{t("col.tier")}</th>
              <th className="px-4 py-3 font-medium">{t("col.expiry")}</th>
              <th className="px-4 py-3 font-medium">{t("col.status")}</th>
              <th className="px-4 py-3 font-medium">{t("col.account")}</th>
              <th className="px-4 py-3 text-right font-medium">{t("col.units")}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows === null && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-ink-2">
                  {t("loading")}
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-ink-2">
                  {t("empty")}
                </td>
              </tr>
            )}
            {rows?.map((r) => {
              const p = r.profile;
              const lapsedButActive = !r.eligible && r.anyActive;
              const att = attested.get(r.wallet.toBase58());
              return (
                <tr key={r.wallet.toBase58()}>
                  <td className="px-4 py-3">
                    <span className="mono">{shortKey(r.wallet.toBase58())}</span>
                    {att && (
                      <span className={`pill ml-2 ${att.vouches ? "pill-neutral" : "pill-warn"}`}>
                        {att.vouches ? t("attested") : t("attestationGone")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">{p ? jurisdictionName(p.jurisdiction, locale) : "—"}</td>
                  <td className="tabular px-4 py-3">{p ? p.tier : "—"}</td>
                  <td className="tabular px-4 py-3">{p ? date(p.expiry) : "—"}</td>
                  <td className="px-4 py-3">
                    {r.eligible ? (
                      <span className="pill pill-ok">{te("eligible")}</span>
                    ) : (
                      <span className="pill pill-bad">{t(`reason.${r.reason ?? "profile"}`)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.accounts.length === 0 ? (
                      <span className="text-ink-3">{t("account.none")}</span>
                    ) : r.anyActive ? (
                      <span className={`pill ${lapsedButActive ? "pill-warn" : "pill-ok"}`}>{t("account.active")}</span>
                    ) : (
                      <span className="pill pill-neutral">{t("account.frozen")}</span>
                    )}
                  </td>
                  <td className="tabular px-4 py-3 text-right">{formatUnits(r.units, view.decimals, locale)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {att && !att.vouches && p?.approved && (
                      <button className="btn btn-danger btn-sm mr-2" disabled={tx.busy} onClick={() => lapse(r, att.marker)}>
                        {t("lapse")}
                      </button>
                    )}
                    {lapsedButActive && (
                      <button className="btn btn-danger btn-sm mr-2" disabled={tx.busy} onClick={() => enforce(r)}>
                        {t("enforce")}
                      </button>
                    )}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        saveTx.reset();
                        setEditing(p ?? { ...blankProfile(view), wallet: r.wallet });
                      }}
                    >
                      {p ? t("edit") : t("onboard")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TxReceipt state={tx.state} what={t(what)} />
    </div>
  );
}

function blankProfile(view: AssetView): InvestorProfile {
  return {
    address: PublicKey.default,
    registry: view.registry.address,
    wallet: PublicKey.default,
    approved: true,
    accredited: false,
    frozen: false,
    tier: Math.max(1, view.registry.minTier),
    jurisdiction: 344,
    expiry: Math.floor(Date.now() / 1000) + 365 * DAY,
  };
}

function ProfileEditor({
  view,
  initial,
  tx,
  onClose,
  onSaved,
}: {
  view: AssetView;
  initial: InvestorProfile | null;
  tx: ReturnType<typeof useTransaction>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("issuer.investors.editor");
  const locale = useLocale();
  const { publicKey } = useWallet();
  const base = initial ?? blankProfile(view);
  const [wallet, setWallet] = useState(initial && !initial.wallet.equals(PublicKey.default) ? initial.wallet.toBase58() : "");
  const [jurisdiction, setJurisdiction] = useState(base.jurisdiction);
  const [tier, setTier] = useState(base.tier);
  const [accredited, setAccredited] = useState(base.accredited);
  const [approved, setApproved] = useState(base.approved);
  const [hold, setHold] = useState(base.frozen);
  const [expiry, setExpiry] = useState(new Date(base.expiry * 1000).toISOString().slice(0, 10));

  let walletKey: PublicKey | null = null;
  try {
    walletKey = wallet ? new PublicKey(wallet) : null;
  } catch {
    walletKey = null;
  }
  const allowed = new Set(view.registry.jurisdictions);

  const save = async () => {
    if (!publicKey || !walletKey) return;
    // KYC holds through the end of the chosen day (UTC).
    const expirySeconds = Math.floor(Date.parse(`${expiry}T23:59:59Z`) / 1000);
    const result = await tx.run([
      program.setInvestorProfile(publicKey, view.registry.address, walletKey, {
        approved,
        accredited,
        frozen: hold,
        tier,
        jurisdiction,
        expiry: expirySeconds,
      }),
    ]);
    if (result.status === "confirmed") onSaved();
  };

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{initial ? t("editTitle") : t("addTitle")}</h2>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="md:col-span-2">
          <span className="field-label">{t("wallet")}</span>
          <input
            className="input mono"
            value={wallet}
            onChange={(e) => setWallet(e.target.value.trim())}
            placeholder={t("walletPlaceholder")}
            aria-invalid={wallet !== "" && !walletKey}
          />
          {wallet !== "" && !walletKey && <span className="mt-1 block text-xs text-bad">{t("walletInvalid")}</span>}
        </label>
        <label>
          <span className="field-label">{t("jurisdiction")}</span>
          <select className="input" value={jurisdiction} onChange={(e) => setJurisdiction(Number(e.target.value))}>
            {JURISDICTIONS.map((j) => (
              <option key={j.code} value={j.code}>
                {(locale.startsWith("zh") ? j.zh : j.en) + (allowed.has(j.code) ? "" : ` (${t("notAllowed")})`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t("tier")}</span>
          <select className="input" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {t(`tier${n}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t("expiry")}</span>
          <input className="input tabular" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
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
      <p className="mt-4 text-xs text-ink-3">{t("note")}</p>
      <button className="btn btn-primary mt-4" disabled={tx.busy || !walletKey} onClick={save}>
        {t("save")}
      </button>
    </section>
  );
}
