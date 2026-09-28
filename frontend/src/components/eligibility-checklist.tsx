"use client";

import { useLocale, useTranslations } from "next-intl";
import { checkEligibility } from "@/lib/chain/eligibility";
import { jurisdictionName } from "@/lib/chain/jurisdictions";
import type { InvestorProfile, Registry } from "@/lib/chain/program";

/** The rules the gate applies, one row each, so a refusal names its reason. */
export function EligibilityChecklist({
  registry,
  profile,
}: {
  registry: Registry;
  profile: InvestorProfile | null;
}) {
  const t = useTranslations("eligibility");
  const locale = useLocale();
  const { eligible, rules } = checkEligibility(registry, profile);
  const date = (s: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(s * 1000);

  const detail = (id: string, pass: boolean): string => {
    if (!profile) return t("profile.fail");
    switch (id) {
      case "profile":
        return t("profile.pass");
      case "approved":
        return pass ? t("approved.pass") : t("approved.fail");
      case "hold":
        return pass ? t("hold.pass") : t("hold.fail");
      case "expiry":
        return t(pass ? "expiry.pass" : "expiry.fail", { date: date(profile.expiry) });
      case "tier":
        return t(pass ? "tier.pass" : "tier.fail", { tier: profile.tier, min: registry.minTier });
      case "jurisdiction":
        return t(pass ? "jurisdiction.pass" : "jurisdiction.fail", {
          name: jurisdictionName(profile.jurisdiction, locale),
        });
      case "accredited":
        if (!registry.requireAccredited) return t("accredited.skipped");
        return pass ? t("accredited.pass") : t("accredited.fail");
      default:
        return id;
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t("title")}</h2>
        <span className={`pill ${eligible ? "pill-ok" : "pill-bad"}`}>
          {eligible ? t("eligible") : t("notEligible")}
        </span>
      </div>
      <ul className="mt-4 divide-y divide-line">
        {rules.map((r) => (
          <li key={r.id} className="flex items-start gap-3 py-2.5 text-sm">
            <span
              aria-hidden="true"
              className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                r.skipped ? "bg-surface-2 text-ink-3" : r.pass ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"
              }`}
            >
              {r.skipped ? "–" : r.pass ? "✓" : "✕"}
            </span>
            <span className={r.pass || r.skipped ? "text-ink" : "font-medium text-bad"}>
              {detail(r.id, r.pass)}
            </span>
            <span className="sr-only">{r.skipped ? t("skipped") : r.pass ? t("passed") : t("failed")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
