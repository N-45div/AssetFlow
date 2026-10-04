"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, type Abi, type Address, type PublicClient } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { EvmWalletButton } from "@/components/evm-wallet-button";
import { PageShell } from "@/components/page-shell";
import { TxReceipt } from "@/components/tx-receipt";
import { money } from "@/app/issuer/coupons";
import { JURISDICTIONS } from "@/lib/chain/jurisdictions";
import { shortKey } from "@/lib/chain/explorer";
import { directoryAbi, registryAbi, servicerAbi } from "@/lib/evm/abi";
import { listOf } from "@/lib/evm/assetflow";
import { registryBytecode, servicerBytecode } from "@/lib/evm/bytecode";
import { useBond } from "@/lib/evm/use-bond";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmWallet } from "@/lib/evm/wallet";
import { BaseCoupons } from "./coupons";
import { BaseInvestors } from "./investors";
import { BaseIssuance } from "./issuance";
import { BasePolicy } from "./policy";
import { BaseRedemptions } from "./redemptions";
import { useEvmChain } from "@/lib/evm/use-evm-chain";
import { INVESTOR_SCHEMA, KYC_ATTESTER } from "@/lib/evm/chains";

const TABS = ["investors", "issuance", "coupons", "redemptions", "policy"] as const;

/** Read until the directory shows what was just listed: a lagging RPC node may not have it yet. */
async function listed(pub: PublicClient, directory: Address, issuer: Address, what: "registries" | "bonds", address: Address) {
  for (let i = 0; i < 20; i++) {
    const l = await listOf(pub, directory, issuer).catch(() => null);
    if (l?.[what].some((a) => a.toLowerCase() === address.toLowerCase())) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
type Tab = (typeof TABS)[number];
const DAY = 86_400;

export function BaseIssuerConsole() {
  const { cfg, pub, links } = useEvmChain();
  const t = useTranslations("issuer");
  const tb = useTranslations("base.issuer");
  const { address } = useEvmWallet();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [lists, setLists] = useState<{ registries: Address[]; bonds: Address[] } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!address) return;
    let live = true;
    listOf(pub, cfg.directory, address)
      .then((l) => live && setLists(l))
      .catch(() => live && setLists({ registries: [], bonds: [] }));
    return () => {
      live = false;
    };
  }, [address, tick, pub, cfg.directory]);

  const selected = useMemo(() => {
    const q = params.get("bond");
    if (q && isAddress(q)) return getAddress(q);
    return lists?.bonds[lists.bonds.length - 1] ?? null;
  }, [params, lists]);
  const { view, refresh } = useBond(selected);
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "investors";
  const go = (next: Tab, bond: Address | null = selected) => {
    const q = new URLSearchParams(params.toString());
    q.set("tab", next);
    if (bond) q.set("bond", bond);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  if (!address) {
    return (
      <PageShell title={tb("title", { chain: cfg.brand })}>
        <div className="card flex flex-col items-start gap-4 p-6">
          <div>
            <p className="font-medium">{t("connectTitle")}</p>
            <p className="mt-1 text-sm text-ink-2">{tb("connectBody", { network: cfg.network })}</p>
          </div>
          <EvmWalletButton />
        </div>
      </PageShell>
    );
  }
  if (!lists) {
    return (
      <PageShell title={tb("title", { chain: cfg.brand })}>
        <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>
      </PageShell>
    );
  }
  if (lists.registries.length === 0) {
    return (
      <PageShell title={tb("title", { chain: cfg.brand })} subtitle={t("onboarding.step", { n: 1, of: 2 })}>
        <CreateRegistry onDone={reload} />
      </PageShell>
    );
  }
  if (lists.bonds.length === 0) {
    return (
      <PageShell title={tb("title", { chain: cfg.brand })} subtitle={t("onboarding.step", { n: 2, of: 2 })}>
        <CreateBond registry={lists.registries[lists.registries.length - 1]} onDone={reload} />
      </PageShell>
    );
  }
  // Another bond under the same registry: each has its own terms, token and payment currency.
  if (creating) {
    return (
      <PageShell
        title={tb("title", { chain: cfg.brand })}
        actions={
          <button className="btn btn-secondary btn-sm" onClick={() => setCreating(false)}>
            {tb("backToBond")}
          </button>
        }
      >
        <CreateBond
          registry={lists.registries[lists.registries.length - 1]}
          onDone={(servicer) => {
            setCreating(false);
            reload();
            if (servicer) go("issuance", servicer);
          }}
        />
      </PageShell>
    );
  }

  const onChange = () => refresh();
  return (
    <PageShell
      title={tb("title", { chain: cfg.brand })}
      subtitle={
        selected && (
          <span>
            {tb("bondLabel")}{" "}
            <a className="mono text-accent underline underline-offset-2" href={links.address(selected)} target="_blank" rel="noreferrer">
              {view ? `${view.bond.name} (${view.bond.symbol})` : shortKey(selected)}
            </a>
          </span>
        )
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {lists.bonds.length > 1 && selected && (
            <select
              className="input h-9 w-auto py-1 text-sm"
              aria-label={tb("yourBonds")}
              value={selected}
              onChange={(e) => go(tab, e.target.value as Address)}
            >
              {lists.bonds.map((b) => (
                <option key={b} value={b}>
                  {b === selected && view ? `${view.bond.symbol} · ${shortKey(b)}` : shortKey(b)}
                </option>
              ))}
            </select>
          )}
          {selected && (
            <Link href={`${cfg.prefix}/holder?bond=${selected}`} className="btn btn-secondary btn-sm">
              {t("holderLink")}
            </Link>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}>
            {tb("newBond")}
          </button>
        </div>
      }
    >
      <div role="tablist" aria-label={t("tabsLabel")} className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => go(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>
      <div className="mt-6" role="tabpanel">
        {!view ? (
          <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>
        ) : tab === "investors" ? (
          <BaseInvestors view={view} onChange={onChange} />
        ) : tab === "issuance" ? (
          <BaseIssuance view={view} onChange={onChange} />
        ) : tab === "coupons" ? (
          <BaseCoupons view={view} onChange={onChange} />
        ) : tab === "redemptions" ? (
          <BaseRedemptions view={view} onChange={onChange} />
        ) : (
          <BasePolicy view={view} onChange={onChange} />
        )}
      </div>
    </PageShell>
  );
}

/** Step 1: deploy a registry, allow its jurisdictions, and list it under the issuer. */
function CreateRegistry({ onDone }: { onDone: () => void }) {
  const { cfg, pub, links } = useEvmChain();
  const t = useTranslations("issuer.onboarding");
  const tb = useTranslations("base.issuer");
  const locale = useLocale();
  const { address } = useEvmWallet();
  const tx = useEvmTx();
  const [allowed, setAllowed] = useState<number[]>([344, 702]);
  const [trustDemo, setTrustDemo] = useState(!!KYC_ATTESTER);

  const create = async () => {
    if (!address) return;
    const registry = await tx.deploy(registryAbi as Abi, registryBytecode, [address, cfg.eas, 1, false]);
    if (!registry) return;
    const r = await tx.run([
      ...allowed.map((code) => ({ address: registry, abi: registryAbi as Abi, functionName: "setJurisdiction", args: [code, true] })),
      ...(trustDemo ? [{ address: registry, abi: registryAbi as Abi, functionName: "setKycSource", args: [INVESTOR_SCHEMA, KYC_ATTESTER] }] : []),
      { address: cfg.directory, abi: directoryAbi as Abi, functionName: "listRegistry", args: [registry] },
    ]);
    if (r.status !== "confirmed") return;
    await listed(pub, cfg.directory, address, "registries", registry);
    onDone();
  };

  return (
    <section className="card max-w-3xl p-5">
      <h2 className="font-semibold">{t("registryTitle")}</h2>
      <p className="mt-1 text-sm text-ink-2">{tb("registryLede")}</p>
      <fieldset className="mt-5">
        <legend className="field-label">{t("jurisdictions")}</legend>
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
      {KYC_ATTESTER && (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={trustDemo} onChange={(e) => setTrustDemo(e.target.checked)} />
          {tb("trustDemo")}
        </label>
      )}
      <p className="mt-4 text-xs text-ink-3">{tb("steps", { n: allowed.length + (trustDemo ? 3 : 2) })}</p>
      <button className="btn btn-primary mt-3" disabled={tx.busy || allowed.length === 0} onClick={create}>
        {t("createRegistry")}
      </button>
      <TxReceipt state={tx.state} what={tb("registryWhat")} link={links.tx} />
    </section>
  );
}

function addMonths(ts: number, months: number) {
  const d = new Date(ts * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()) / 1000;
}

/** Step 2: deploy a bond (its servicer, which creates the token) on test dollars, and list it. */
function CreateBond({ registry, onDone }: { registry: Address; onDone: (servicer?: Address) => void }) {
  const { cfg, pub, links } = useEvmChain();
  const t = useTranslations("issuer.coupons");
  const tb = useTranslations("base.issuer");
  const locale = useLocale();
  const { address } = useEvmWallet();
  const tx = useEvmTx();
  const [name, setName] = useState("AssetFlow Note");
  const [symbol, setSymbol] = useState("AFN");
  const [face, setFace] = useState("1");
  const [rate, setRate] = useState("10");
  const [first, setFirst] = useState("2026-10-01");
  const [count, setCount] = useState(4);
  const [demo, setDemo] = useState(true);
  const [anchor] = useState(() => Math.floor(Date.now() / 1000));
  // USDG where Paxos runs it on this testnet; the test dollar anyone can mint otherwise, or by choice.
  const [currency, setCurrency] = useState<Address>(cfg.usdg ?? cfg.testUsd);

  const periods = useMemo(() => {
    const start = Date.parse(`${first}T00:00:00Z`) / 1000;
    if (!Number.isFinite(start)) return [];
    return Array.from({ length: count }, (_, i) => {
      const accrualStart = addMonths(start, 6 * i);
      const accrualEnd = addMonths(start, 6 * (i + 1));
      // A demo schedule puts record dates minutes apart so a whole payment can be shown live.
      const recordTs = demo ? anchor + 60 * (5 * i + 3) : accrualEnd - DAY;
      const paymentTs = demo ? recordTs + 60 : accrualEnd;
      return { accrualStart, accrualEnd, recordTs, paymentTs };
    });
  }, [first, count, demo, anchor]);
  const bps = Math.round(Number(rate) * 100);
  const facePerUnit = BigInt(Math.round(Number(face) * 1e6));
  const valid = name && symbol && facePerUnit > 0n && bps > 0 && bps <= 10_000 && periods.length > 0;

  const create = async () => {
    const servicer = await tx.deploy(servicerAbi as Abi, servicerBytecode, [
      name,
      symbol,
      registry,
      currency,
      facePerUnit,
      bps,
      periods.map((p) => ({ accrualStart: BigInt(p.accrualStart), accrualEnd: BigInt(p.accrualEnd), recordTs: BigInt(p.recordTs), paymentTs: BigInt(p.paymentTs) })),
    ]);
    if (!servicer) return;
    const r = await tx.run([{ address: cfg.directory, abi: directoryAbi as Abi, functionName: "listBond", args: [servicer] }]);
    if (r.status !== "confirmed" || !address) return;
    await listed(pub, cfg.directory, address, "bonds", servicer);
    onDone(servicer);
  };

  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(ts * 1000);
  const time = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts * 1000);
  return (
    <section className="card max-w-3xl p-5">
      <h2 className="font-semibold">{tb("bondTitle")}</h2>
      <p className="mt-1 text-sm text-ink-2">{tb("bondLede")}</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label>
          <span className="field-label">{tb("name")}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{tb("symbol")}</span>
          <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
        </label>
        <label>
          <span className="field-label">{t("face")}</span>
          <input className="input" inputMode="decimal" value={face} onChange={(e) => setFace(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("rate")}</span>
          <input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("first")}</span>
          <input className="input" type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
        </label>
        <label>
          <span className="field-label">{t("count")}</span>
          <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[1, 2, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {t("countOption", { n, years: n / 2 })}
              </option>
            ))}
          </select>
        </label>
      </div>
      {cfg.usdg && (
        <label className="mt-4 block max-w-sm">
          <span className="field-label">{tb("currencyLabel")}</span>
          <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value as Address)}>
            <option value={cfg.usdg}>{tb("currencyUsdg")}</option>
            <option value={cfg.testUsd}>{tb("currencyTest")}</option>
          </select>
        </label>
      )}
      <p className="mt-3 text-xs text-ink-3">
        {cfg.usdg && currency === cfg.usdg ? tb("currencyUsdgNote", { network: cfg.network }) : tb("currency", { network: cfg.network })}
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
        {t("demo")}
      </label>
      <table className="mt-4 w-full text-sm">
        <thead className="text-left text-ink-2">
          <tr>
            <th className="py-1 pr-4 font-medium">{t("col.accrual")}</th>
            <th className="py-1 pr-4 font-medium">{t("col.record")}</th>
            <th className="py-1 font-medium">{t("col.perThousand")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {periods.map((p) => (
            <tr key={p.accrualStart}>
              <td className="py-1 pr-4">
                {date(p.accrualStart)} – {date(p.accrualEnd)}
              </td>
              <td className="py-1 pr-4">{time(p.recordTs)}</td>
              <td className="tabular py-1">{money((1_000n * facePerUnit * BigInt(bps) * 180n) / (10_000n * 360n), 6, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-primary mt-4" disabled={tx.busy || !valid} onClick={create}>
        {tb("createBond")}
      </button>
      <TxReceipt state={tx.state} what={tb("bondWhat")} link={links.tx} />
    </section>
  );
}
