"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, zeroAddress, type Abi, type Address } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { EligibilityChecklist } from "@/components/eligibility-checklist";
import { STATUS_TONE } from "@/components/holder-redemptions";
import { EvmWalletButton } from "@/components/evm-wallet-button";
import { PageShell } from "@/components/page-shell";
import { TxReceipt } from "@/components/tx-receipt";
import { money } from "@/app/issuer/coupons";
import { couponAmount } from "@/lib/chain/coupons";
import { checkEligibility } from "@/lib/chain/eligibility";
import { jurisdictionName } from "@/lib/chain/jurisdictions";
import { accruedInterest, principal } from "@/lib/chain/redemptions";
import { registryAbi, servicerAbi } from "@/lib/evm/abi";
import { balancesOf, readEntitlements, readProfiles, type EvmAttestation, type EvmProfile } from "@/lib/evm/assetflow";
import { findAttestation } from "@/lib/evm/kyc-base";
import { useBond, type BondView } from "@/lib/evm/use-bond";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmWallet } from "@/lib/evm/wallet";
import { useEvmChain } from "@/lib/evm/use-evm-chain";

interface Mine {
  profile: EvmProfile | null;
  units: bigint;
  locked: bigint;
  redeemedAtMaturity: bigint;
  coupons: ({ units: bigint; done: boolean; heldBack: boolean; amount: bigint } | null)[];
  attestation: EvmAttestation | null;
}

export function BaseHolderPortal() {
  const { cfg, pub, links } = useEvmChain();
  const t = useTranslations("holder");
  const locale = useLocale();
  const tb = useTranslations("base.holder");
  const params = useSearchParams();
  const servicer = useMemo(() => {
    const q = params.get("bond") ?? cfg.featuredBond ?? "";
    return isAddress(q) ? getAddress(q) : null;
  }, [params, cfg.featuredBond]);
  const { address } = useEvmWallet();
  const { view, refresh } = useBond(servicer);
  const [mine, setMine] = useState<Mine | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setTick((n) => n + 1);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!view || !address) return;
    let live = true;
    (async () => {
      const now = Math.floor(Date.now() / 1000);
      const [[profile], balances, coupons, attestation] = await Promise.all([
        readProfiles(pub, view.registry.address, [address]),
        balancesOf(pub, view.bond, address),
        Promise.all(view.bond.periods.map((p, i) => (now > p.recordTs ? readEntitlements(pub, view.bond, i, [address]).then((r) => r[0]) : null))),
        view.registry.kycAttester !== zeroAddress ? findAttestation(pub, cfg, address, view.registry.kycSchema, view.registry.kycAttester) : null,
      ]);
      const listed = profile.expiry > 0 || profile.approved;
      if (live) setMine({ profile: listed ? profile : null, ...balances, coupons, attestation });
    })().catch(() => live && setMine(null));
    return () => {
      live = false;
    };
  }, [view, address, tick, pub, cfg]);

  if (!servicer) {
    return (
      <PageShell title={tb("title", { chain: cfg.brand })}>
        <div className="card p-6">
          <p className="font-medium">{t("noAsset")}</p>
          <p className="mt-1 text-sm text-ink-2">{tb("noBondHint", { chain: cfg.brand })}</p>
          <Link href={`${cfg.prefix}/issuer`} className="btn btn-secondary mt-4">
            {t("toIssuer")}
          </Link>
        </div>
      </PageShell>
    );
  }
  const subtitle = view && (
    <span>
      {tb("bondLabel")}{" "}
      <a className="mono text-accent underline underline-offset-2" href={links.address(servicer)} target="_blank" rel="noreferrer">
        {view.bond.name} ({view.bond.symbol})
      </a>
    </span>
  );
  if (!address) {
    return (
      <PageShell title={tb("title", { chain: cfg.brand })} subtitle={subtitle}>
        <div className="card flex flex-col items-start gap-4 p-6">
          <div>
            <p className="font-medium">{t("connectTitle")}</p>
            <p className="mt-1 text-sm text-ink-2">{t("connectBody")}</p>
          </div>
          <EvmWalletButton />
        </div>
      </PageShell>
    );
  }
  if (!view || !mine) {
    return (
      <PageShell title={tb("title", { chain: cfg.brand })} subtitle={subtitle}>
        <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>
      </PageShell>
    );
  }

  const { eligible } = checkEligibility(view.registry, mine.profile);
  const n = (v: bigint) => new Intl.NumberFormat(locale).format(v);
  const share = view.bond.totalSupply > 0n ? Number((mine.units * 10_000n) / view.bond.totalSupply) / 100 : 0;
  return (
    <PageShell title={tb("title", { chain: cfg.brand })} subtitle={subtitle}>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="card p-5">
          <EligibilityChecklist registry={view.registry} profile={mine.profile} />
          {/* KYC once is for wallets not yet admitted, or admitted through an attestation. */}
          {(!eligible || mine.profile?.attestedFrom) && <Kyc view={view} mine={mine} onChange={reload} />}
          {!mine.profile && (
            <div className="mt-4 rounded-md bg-surface-2 p-4 text-sm">
              <p className="font-medium">{t("onboardTitle")}</p>
              <p className="mt-1 text-ink-2">{tb("onboardBody")}</p>
              <code className="mono mt-2 block break-all text-xs">{address}</code>
            </div>
          )}
        </section>
        <div className="flex flex-col gap-4">
          <section className="card p-5">
            <h2 className="font-semibold">{t("holdings.title")}</h2>
            <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-ink-2">{t("holdings.units")}</dt>
                <dd className="tabular mt-1 text-2xl font-semibold">{n(mine.units)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("holdings.share")}</dt>
                <dd className="tabular mt-1 text-2xl font-semibold">{share.toFixed(2)}%</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-ink-3">{t("holdings.outstanding", { units: n(view.bond.totalSupply) })}</p>
            {mine.locked > 0n && <p className="mt-1 text-xs text-ink-3">{tb("locked", { units: mine.locked.toString() })}</p>}
          </section>
          <Coupons view={view} mine={mine} />
          <Redemptions view={view} wallet={address} mine={mine} eligible={eligible} onChange={reload} />
        </div>
      </div>
    </PageShell>
  );
}

function Kyc({ view, mine, onChange }: { view: BondView; mine: Mine; onChange: () => void }) {
  const { cfg, links } = useEvmChain();
  const t = useTranslations("holder.kyc");
  const locale = useLocale();
  const tx = useEvmTx();
  if (view.registry.kycAttester === zeroAddress) return null;
  const provider = "AssetFlow Demo KYC";
  const a = mine.attestation;
  const claimed = !!a && mine.profile?.attestedFrom === a.uid && mine.profile.approved;
  const onboard = async () => {
    if (!a) return;
    const r = await tx.run([{ address: view.registry.address, abi: registryAbi as Abi, functionName: "claimProfile", args: [a.uid] }]);
    if (r.status === "confirmed") onChange();
  };
  return (
    <div className="mt-4 rounded-md border border-line p-4 text-sm">
      <p className="font-medium">{t("title")}</p>
      {claimed ? (
        <p className="mt-1 text-ink-2">{t("claimed", { provider, jurisdiction: jurisdictionName(a!.jurisdiction, locale), tier: a!.tier })}</p>
      ) : a ? (
        <>
          <p className="mt-1 text-ink-2">{t("ready", { provider, jurisdiction: jurisdictionName(a.jurisdiction, locale), tier: a.tier })}</p>
          <button className="btn btn-primary mt-3" disabled={tx.busy} onClick={onboard}>
            {t("onboard")}
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-ink-2">{t(mine.profile?.attestedFrom ? "revoked" : "none", { provider })}</p>
          <Link className="btn btn-secondary mt-3" href={`${cfg.prefix}/kyc?bond=${view.bond.servicer}`}>
            {t("getVerified", { provider })}
          </Link>
        </>
      )}
      <TxReceipt state={tx.state} what={t("what")} link={links.tx} />
    </div>
  );
}

function Coupons({ view, mine }: { view: BondView; mine: Mine }) {
  const t = useTranslations("holder.coupons");
  const locale = useLocale();
  const { bond } = view;
  const cur = (v: bigint) => money(v, bond.currencyDecimals, locale);
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(ts * 1000);
  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("title")}</h2>
      <p className="mt-1 text-sm text-ink-2">{t("lede", { rate: (bond.couponBps / 100).toFixed(2) })}</p>
      <ul className="mt-3 divide-y divide-line text-sm">
        {bond.periods.map((p, i) => {
          const c = mine.coupons[i];
          let amount = "—";
          let status = t("scheduled");
          let tone = "pill-neutral";
          if (c?.done) {
            amount = cur(c.amount);
            status = c.heldBack ? t("heldBack") : t("paid");
            tone = c.heldBack ? "pill-warn" : "pill-ok";
          } else if (c && c.units > 0n) {
            amount = cur(couponAmount(bond, p, c.units));
            status = t("paying");
          } else if (c) {
            status = t("notOnRegister");
          } else {
            amount = `${cur(couponAmount(bond, p, mine.units))} ${t("est")}`;
          }
          return (
            <li key={i} className="flex items-center justify-between gap-3 py-2">
              <span>
                {t("row", { n: i + 1 })} <span className="text-ink-3">· {date(p.accrualEnd)}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular">{amount}</span>
                <span className={`pill ${tone}`}>{status}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Redemptions({ view, wallet, mine, eligible, onChange }: { view: BondView; wallet: Address; mine: Mine; eligible: boolean; onChange: () => void }) {
  const { links } = useEvmChain();
  const t = useTranslations("holder.redeem");
  const tb = useTranslations("base.holder");
  const locale = useLocale();
  const tx = useEvmTx();
  const [what, setWhat] = useState("request");
  const [amount, setAmount] = useState("");
  const { bond } = view;
  const cur = (v: bigint) => money(v, bond.currencyDecimals, locale);
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(ts * 1000);
  const units = /^\d+$/.test(amount) ? BigInt(amount) : 0n;
  const free = mine.units - mine.locked;
  const now = Math.floor(Date.now() / 1000);
  const s = { address: bond.servicer, abi: servicerAbi as Abi };
  const requests = view.requests.filter((r) => r.holder.toLowerCase() === wallet.toLowerCase());
  const run = async (key: string, functionName: string, args: unknown[]) => {
    setWhat(key);
    const r = await tx.run([{ ...s, functionName, args }]);
    if (r.status === "confirmed") {
      setAmount("");
      onChange();
    }
  };
  const m = bond.maturity;

  return (
    <section className="card p-5">
      <h2 className="font-semibold">{t("title")}</h2>
      {bond.matured ? (
        <div className="mt-2 text-sm">
          <p className="text-ink-2">{t("matured", { date: date(m.startedTs), face: cur(bond.facePerUnit) })}</p>
          {mine.redeemedAtMaturity > 0n && (
            <p className="mt-3 flex items-center justify-between gap-2">
              <span>{t("redeemed", { units: (mine.redeemedAtMaturity / bond.facePerUnit).toString(), amount: cur(mine.redeemedAtMaturity) })}</span>
              <span className="pill pill-ok">{t("status.settled")}</span>
            </p>
          )}
          {mine.units > 0n &&
            (m.funded < m.required ? (
              <p className="mt-3 text-ink-2">{t("awaitingFunds", { funded: cur(m.funded), required: cur(m.required) })}</p>
            ) : eligible ? (
              <button className="btn btn-primary mt-3" disabled={tx.busy || mine.locked > 0n} onClick={() => run("redeem", "redeem", [wallet])}>
                {t("redeemAll", { units: mine.units.toString(), amount: cur(principal(bond.facePerUnit, mine.units)) })}
              </button>
            ) : (
              <p className="mt-3 text-warn">{t("heldAtMaturity")}</p>
            ))}
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-2">{tb("redeemLede")}</p>
          {eligible && free > 0n ? (
            <div className="mt-4 space-y-3 text-sm">
              <label className="block">
                <span className="text-ink-2">{t("units")}</span>
                <div className="mt-1 flex gap-2">
                  <input className="input tabular" inputMode="numeric" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
                  <button className="btn btn-secondary" type="button" onClick={() => setAmount(free.toString())}>
                    {t("max")}
                  </button>
                </div>
              </label>
              {units > 0n && units <= free && (
                <dl className="grid grid-cols-3 gap-2 rounded-md bg-surface-2 p-3">
                  <div>
                    <dt className="text-ink-2">{t("quoteFace")}</dt>
                    <dd className="tabular font-semibold">{cur(principal(bond.facePerUnit, units))}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-2">{t("quoteInterest")}</dt>
                    <dd className="tabular font-semibold">{cur(accruedInterest(bond, units, now))}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-2">{t("quoteTotal")}</dt>
                    <dd className="tabular font-semibold">{cur(principal(bond.facePerUnit, units) + accruedInterest(bond, units, now))}</dd>
                  </div>
                </dl>
              )}
              {units > free && <p className="text-warn">{t("tooMany", { units: free.toString() })}</p>}
              <p className="text-xs text-ink-3">{t("quoteNote")}</p>
              <button className="btn btn-primary" disabled={tx.busy || units === 0n || units > free} onClick={() => run("request", "requestRedemption", [units])}>
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
          <ul className="mt-2 divide-y divide-line text-sm">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {t("row", { units: r.units.toString(), date: date(r.requestedTs) })}
                  {r.status === "settled" && <span className="text-ink-3"> · {t("paidAmount", { amount: cur(r.principal + r.interest) })}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {r.status === "requested" && (
                    <button className="btn btn-secondary btn-sm" disabled={tx.busy} onClick={() => run("cancel", "cancel", [BigInt(r.id)])}>
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
      <TxReceipt state={tx.state} what={t(`what.${what}`)} link={links.tx} />
    </section>
  );
}
