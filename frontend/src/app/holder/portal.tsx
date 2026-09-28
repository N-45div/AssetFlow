"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useLocale, useTranslations } from "next-intl";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { EligibilityChecklist } from "@/components/eligibility-checklist";
import { HolderCoupons } from "@/components/holder-coupons";
import { PageShell } from "@/components/page-shell";
import { TxReceipt } from "@/components/tx-receipt";
import { WalletButton } from "@/components/wallet-button";
import { assetFromQuery, PROGRAM_ID } from "@/lib/chain/config";
import { checkEligibility } from "@/lib/chain/eligibility";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { TokenAcl } from "@/lib/chain/program";
import { formatUnits, program, useAssetView, useHolderView } from "@/lib/chain/use-asset";
import { useTransaction } from "@/lib/chain/use-transaction";

export function HolderPortal() {
  const t = useTranslations("holder");
  const locale = useLocale();
  const params = useSearchParams();
  const mint = useMemo(() => assetFromQuery(params.get("asset")), [params]);
  const { publicKey } = useWallet();
  const asset = useAssetView(mint);
  const holder = useHolderView(asset.data, publicKey);
  const tx = useTransaction();

  if (!mint || asset.missing) {
    return (
      <PageShell title={t("title")}>
        <div className="card p-6">
          <p className="font-medium">{t("noAsset")}</p>
          <p className="mt-1 text-sm text-ink-2">{t("noAssetHint")}</p>
          <Link href="/issuer" className="btn btn-secondary mt-4">
            {t("toIssuer")}
          </Link>
        </div>
      </PageShell>
    );
  }

  const view = asset.data;
  const subtitle = view ? (
    <span>
      {t("assetLabel")}{" "}
      <a
        className="mono text-accent underline underline-offset-2"
        href={explorer.address(view.asset.mint.toBase58())}
        target="_blank"
        rel="noreferrer"
      >
        {shortKey(view.asset.mint.toBase58())}
      </a>
    </span>
  ) : null;

  if (!publicKey) {
    return (
      <PageShell title={t("title")} subtitle={subtitle}>
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

  if (!view || !holder.data) {
    return (
      <PageShell title={t("title")} subtitle={subtitle}>
        <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>
      </PageShell>
    );
  }

  const { profile, account, tokenAccount } = holder.data;
  const { eligible } = checkEligibility(view.registry, profile);
  const state = !account ? "none" : account.isFrozen ? "frozen" : "active";

  // Opening the account and asking the gate to thaw it are one transaction.
  const activate = async (tryAnyway: boolean) => {
    const owner = publicKey;
    const result = await tx.run(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          tokenAccount,
          owner,
          view.asset.mint,
          TOKEN_2022_PROGRAM_ID,
        ),
        TokenAcl.permissionless(
          "thaw",
          owner,
          view.asset.mint,
          tokenAccount,
          owner,
          PROGRAM_ID,
          program.gateAccounts("thaw", view.asset.mint, view.registry.address, owner),
        ),
      ],
      { recordRefusal: tryAnyway },
    );
    if (result.status === "confirmed") holder.refresh();
  };

  const share = account && view.supply > 0n ? Number((account.amount * 10_000n) / view.supply) / 100 : 0;
  const statePill = state === "active" ? "pill-ok" : state === "frozen" ? "pill-warn" : "pill-neutral";

  return (
    <PageShell title={t("title")} subtitle={subtitle}>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="card p-5">
          <EligibilityChecklist registry={view.registry} profile={profile} />
          {!profile && (
            <div className="mt-4 rounded-md bg-surface-2 p-4 text-sm">
              <p className="font-medium">{t("onboardTitle")}</p>
              <p className="mt-1 text-ink-2">{t("onboardBody")}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="mono break-all rounded border border-line bg-surface px-2 py-1 text-xs">
                  {publicKey.toBase58()}
                </code>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void navigator.clipboard.writeText(publicKey.toBase58())}
                >
                  {t("copyAddress")}
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="flex flex-col gap-4">
          <section className="card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{t("account.title")}</h2>
              <span className={`pill ${statePill}`}>{t(`account.${state}`)}</span>
            </div>
            <p className="mt-3 text-sm text-ink-2">{t(`account.${state}Body`)}</p>
            {state !== "active" && (
              <div className="mt-4">
                {eligible ? (
                  <button className="btn btn-primary" disabled={tx.busy} onClick={() => activate(false)}>
                    {t("account.activate")}
                  </button>
                ) : (
                  <>
                    <button className="btn btn-danger" disabled={tx.busy} onClick={() => activate(true)}>
                      {t("account.tryAnyway")}
                    </button>
                    <p className="mt-2 text-xs text-ink-3">{t("account.tryAnywayHint")}</p>
                  </>
                )}
              </div>
            )}
            <TxReceipt state={tx.state} what={t("account.what")} />
          </section>

          <section className="card p-5">
            <h2 className="font-semibold">{t("holdings.title")}</h2>
            <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-ink-2">{t("holdings.units")}</dt>
                <dd className="tabular mt-1 text-2xl font-semibold">
                  {formatUnits(account?.amount ?? 0n, view.decimals, locale)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("holdings.share")}</dt>
                <dd className="tabular mt-1 text-2xl font-semibold">{share.toFixed(2)}%</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-ink-3">
              {t("holdings.outstanding", { units: formatUnits(view.supply, view.decimals, locale) })}
            </p>
          </section>

          <HolderCoupons view={view} wallet={publicKey} units={account?.amount ?? 0n} />
        </div>
      </div>
    </PageShell>
  );
}
