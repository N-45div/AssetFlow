"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useTranslations } from "next-intl";
import { PageShell } from "@/components/page-shell";
import { WalletButton } from "@/components/wallet-button";
import { explorer, shortKey } from "@/lib/chain/explorer";
import type { Asset, Registry } from "@/lib/chain/program";
import { program, useAssetView } from "@/lib/chain/use-asset";
import { useRegister } from "@/lib/chain/use-register";
import { CreateAsset, CreateRegistry } from "./onboarding";
import { Investors } from "./investors";
import { Issuance } from "./issuance";
import { Overview } from "./overview";
import { Policy } from "./policy";

const TABS = ["overview", "investors", "issuance", "policy"] as const;
type Tab = (typeof TABS)[number];

export function IssuerConsole() {
  const t = useTranslations("issuer");
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [registry, setRegistry] = useState<Registry | null | undefined>(undefined);
  const [assets, setAssets] = useState<Asset[] | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!publicKey) return;
    let live = true;
    setRegistry(undefined);
    setAssets(undefined);
    Promise.all([
      program.fetchRegistry(connection, program.registryAddress(publicKey)),
      program.fetchAssetsByIssuer(connection, publicKey),
    ])
      .then(([r, a]) => {
        if (!live) return;
        setRegistry(r);
        setAssets(a);
      })
      .catch(() => {
        if (!live) return;
        setRegistry(null);
        setAssets([]);
      });
    return () => {
      live = false;
    };
  }, [connection, publicKey, tick]);

  const selectedMint = useMemo(() => {
    const q = params.get("asset");
    if (q) {
      try {
        return new PublicKey(q);
      } catch {
        return null;
      }
    }
    return assets?.[0]?.mint ?? null;
  }, [params, assets]);
  const asset = useAssetView(selectedMint);
  const register = useRegister(asset.data);
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "")
    ? (params.get("tab") as Tab)
    : "overview";

  const go = (next: Tab) => {
    const q = new URLSearchParams(params.toString());
    q.set("tab", next);
    if (selectedMint) q.set("asset", selectedMint.toBase58());
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  if (!publicKey) {
    return (
      <PageShell title={t("title")}>
        <div className="card flex flex-col items-start gap-4 p-6">
          <div>
            <p className="font-medium">{t("connectTitle")}</p>
            <p className="mt-1 text-sm text-ink-2">{t("connectBody")}</p>
          </div>
          <WalletButton />
        </div>
      </PageShell>
    );
  }

  if (registry === undefined || assets === undefined) {
    return (
      <PageShell title={t("title")}>
        <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>
      </PageShell>
    );
  }

  if (!registry) {
    return (
      <PageShell title={t("title")} subtitle={t("onboarding.step", { n: 1, of: 2 })}>
        <CreateRegistry onDone={reload} />
      </PageShell>
    );
  }

  if (assets.length === 0) {
    return (
      <PageShell title={t("title")} subtitle={t("onboarding.step", { n: 2, of: 2 })}>
        <CreateAsset registry={registry} onDone={reload} />
      </PageShell>
    );
  }

  const view = asset.data;
  const mintKey = selectedMint?.toBase58() ?? "";
  return (
    <PageShell
      title={t("title")}
      subtitle={
        <span>
          {t("assetLabel")}{" "}
          <a className="mono text-accent underline underline-offset-2" href={explorer.address(mintKey)} target="_blank" rel="noreferrer">
            {shortKey(mintKey)}
          </a>
        </span>
      }
      actions={
        <Link href={`/holder?asset=${mintKey}`} className="btn btn-secondary btn-sm">
          {t("holderLink")}
        </Link>
      }
    >
      <div role="tablist" aria-label={t("tabsLabel")} className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => go(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === k ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>
      <div className="mt-6" role="tabpanel">
        {!view ? (
          <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>
        ) : tab === "overview" ? (
          <Overview view={view} rows={register.rows} />
        ) : tab === "investors" ? (
          <Investors view={view} rows={register.rows} onChange={() => register.refresh()} />
        ) : tab === "issuance" ? (
          <Issuance
            view={view}
            rows={register.rows}
            onChange={() => {
              register.refresh();
              asset.refresh();
            }}
          />
        ) : (
          <Policy
            view={view}
            onChange={() => {
              asset.refresh();
              register.refresh();
            }}
          />
        )}
      </div>
    </PageShell>
  );
}
