import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Actions, Card, SectionHeader } from "@/components/landing";

const ROWS = ["programs", "console", "servicing", "actions"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pricing");
  return { title: t("metaTitle") };
}

/** The proposed prices, kept off the homepage: nothing is charged until a pilot turns into production. */
export default async function Pricing() {
  const t = await getTranslations("pricing");
  const home = await getTranslations("home");
  return (
    <div className="bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <SectionHeader as="h1" eyebrow={t("eyebrow")} title={t("title")} lede={t("lede")} />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <article className="card p-6">
            <span className="pill pill-neutral">{t("tag")}</span>
            <dl className="mt-4 divide-y divide-line">
              {ROWS.map((k) => (
                <div key={k} className="flex justify-between gap-4 py-4 text-base">
                  <dt className="text-ink-2">{t(`rows.${k}.label`)}</dt>
                  <dd className="tabular text-right font-semibold text-ink">{t(`rows.${k}.value`)}</dd>
                </div>
              ))}
            </dl>
          </article>
          <Card title={home("pilot.title")}>
            {home("pilot.lede")}
            <Actions pilot={home("ctaPilot")} console={home("ctaConsole")} />
          </Card>
        </div>
      </div>
    </div>
  );
}
