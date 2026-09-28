import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function Home() {
  const t = await getTranslations("home");

  const jobs = ["eligibility", "payments", "redemptions"] as const;
  const facts = [
    { key: "jpm", href: "https://www.jpmorgan.com/about-us/corporate-news/2025/jpmorgan-commercial-paper-issuance-solana-blockchain" },
    { key: "hkma", href: "https://www.hkma.gov.hk/eng/news-and-media/press-releases/2025/11/20251111-6/" },
    { key: "stack", href: "https://solana.com/docs/tokenization" },
  ] as const;
  const terms = ["face", "coupon", "dayCount", "record", "settlement", "holders"] as const;

  return (
    <>
      <section className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.25fr_1fr] lg:py-20">
          <div>
            <p className="text-sm font-semibold text-accent">{t("kicker")}</p>
            <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight text-ink sm:text-5xl">
              {t("title")}
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">{t("lede")}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/issuer" className="btn btn-primary">
                {t("ctaIssuer")}
              </Link>
              <Link href="/holder" className="btn btn-secondary">
                {t("ctaHolder")}
              </Link>
              <Link href="/proof" className="btn text-accent hover:underline">
                {t("ctaProof")} →
              </Link>
            </div>
          </div>

          <aside className="card self-start p-5" aria-labelledby="term-sheet">
            <div className="flex items-center justify-between">
              <h2 id="term-sheet" className="text-sm font-semibold text-ink-2">
                {t("termSheet.label")}
              </h2>
              <span className="pill pill-neutral">{t("termSheet.demo")}</span>
            </div>
            <p className="mt-2 text-lg font-semibold">{t("termSheet.name")}</p>
            <dl className="mt-4 divide-y divide-line text-sm">
              {terms.map((k) => (
                <div key={k} className="flex justify-between gap-4 py-2.5">
                  <dt className="text-ink-2">{t(`termSheet.${k}.label`)}</dt>
                  <dd className="tabular text-right font-medium">{t(`termSheet.${k}.value`)}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">{t("jobsTitle")}</h2>
        <p className="mt-2 max-w-2xl text-ink-2">{t("jobsLede")}</p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {jobs.map((k) => (
            <article key={k} className="card flex flex-col p-5">
              <h3 className="font-semibold">{t(`jobs.${k}.title`)}</h3>
              <p className="mt-2 flex-1 text-sm text-ink-2">{t(`jobs.${k}.body`)}</p>
              <p className="mt-4 border-t border-line pt-3 text-xs text-ink-3">
                <span className="font-semibold text-ink-2">{t("onSolana")}</span> {t(`jobs.${k}.solana`)}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">{t("nowTitle")}</h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {facts.map((f, i) => (
              <li key={f.key}>
                <p className="tabular text-sm font-semibold text-accent">0{i + 1}</p>
                <p className="mt-2 text-ink">{t(`now.${f.key}`)}</p>
                <a className="mt-2 inline-block text-sm text-ink-3 underline underline-offset-2 hover:text-ink" href={f.href}>
                  {t("source")}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="card flex flex-col gap-4 p-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">{t("openTitle")}</h2>
            <p className="mt-1 max-w-2xl text-ink-2">{t("openBody")}</p>
          </div>
          <Link href="/proof" className="btn btn-secondary">
            {t("ctaProof")}
          </Link>
        </div>
      </section>
    </>
  );
}
