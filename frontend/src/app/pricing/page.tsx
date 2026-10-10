import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Actions, Scene, Section, Title } from "@/components/landing";

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
    <div className="bg-canvas">
      <Section>
        <Title as="h1" title={t("title")} lede={t("lede")} />
        <div className="mt-14 grid gap-12 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <p className="text-[13px] uppercase tracking-[0.08em] text-ink-3">{t("tag")}</p>
            <dl className="mt-4 divide-y divide-line border-y border-line">
              {ROWS.map((k) => (
                <div key={k} className="flex justify-between gap-6 py-5 text-lg">
                  <dt className="text-ink-2">{t(`rows.${k}.label`)}</dt>
                  <dd className="tabular text-right font-medium text-ink">{t(`rows.${k}.value`)}</dd>
                </div>
              ))}
            </dl>
          </div>
          <Scene tone="deep" className="p-8">
            <h2 className="font-serif text-3xl leading-[1.1] tracking-tight text-white">{home("closing.title")}</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-white/85">{home("closing.body")}</p>
            <Actions pilot={home("ctaPilot")} console={home("ctaConsole")} onScene />
          </Scene>
        </div>
      </Section>
    </div>
  );
}
