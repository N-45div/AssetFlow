"use client";

import { useLocale, useTranslations } from "next-intl";
import { PROGRAM_ID } from "@/lib/chain/config";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { TokenAcl, TOKEN_ACL_ID } from "@/lib/chain/program";
import { formatUnits, type AssetView } from "@/lib/chain/use-asset";
import type { RegisterRow } from "@/lib/chain/use-register";

export function Overview({ view, rows }: { view: AssetView; rows: RegisterRow[] | null }) {
  const t = useTranslations("issuer.overview");
  const locale = useLocale();
  const investors = rows?.filter((r) => r.profile).length ?? 0;
  const eligible = rows?.filter((r) => r.eligible).length ?? 0;
  const active = rows?.filter((r) => r.anyActive).length ?? 0;
  const attention = rows?.filter((r) => !r.eligible && r.anyActive) ?? [];

  const stats = [
    { label: t("outstanding"), value: formatUnits(view.supply, view.decimals, locale) },
    { label: t("investors"), value: String(investors) },
    { label: t("eligible"), value: String(eligible) },
    { label: t("active"), value: String(active) },
  ];
  const facts = [
    { label: t("facts.mint"), key: view.asset.mint.toBase58() },
    { label: t("facts.asset"), key: view.asset.address.toBase58() },
    { label: t("facts.registry"), key: view.registry.address.toBase58() },
    { label: t("facts.mintConfig"), key: TokenAcl.mintConfig(view.asset.mint).toBase58() },
    { label: t("facts.gate"), key: PROGRAM_ID.toBase58() },
    { label: t("facts.tokenAcl"), key: TOKEN_ACL_ID.toBase58() },
  ];

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="card p-4">
            <p className="text-sm text-ink-2">{s.label}</p>
            <p className="tabular mt-1 text-2xl font-semibold">{rows || s.label === stats[0].label ? s.value : "…"}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="font-semibold">{t("attentionTitle")}</h2>
          {attention.length === 0 ? (
            <p className="mt-3 text-sm text-ink-2">{t("attentionNone")}</p>
          ) : (
            <ul className="mt-3 divide-y divide-line text-sm">
              {attention.map((r) => (
                <li key={r.wallet.toBase58()} className="flex items-center justify-between gap-3 py-2">
                  <span className="mono">{shortKey(r.wallet.toBase58())}</span>
                  <span className="pill pill-warn">{t("attentionLapsed")}</span>
                </li>
              ))}
            </ul>
          )}
          {attention.length > 0 && <p className="mt-3 text-xs text-ink-3">{t("attentionHint")}</p>}
        </section>

        <section className="card p-5">
          <h2 className="font-semibold">{t("factsTitle")}</h2>
          <dl className="mt-3 divide-y divide-line text-sm">
            {facts.map((f) => (
              <div key={f.label} className="flex items-center justify-between gap-3 py-2">
                <dt className="text-ink-2">{f.label}</dt>
                <dd>
                  <a
                    className="mono text-accent underline underline-offset-2"
                    href={explorer.address(f.key)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortKey(f.key)}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
