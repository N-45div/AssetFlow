import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { Actions, ArrowLink, Card, CardGrid, Section, SectionHeader } from "@/components/landing";
import { PROGRAM_ID } from "@/lib/chain/config";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { REPO } from "@/lib/site";

/** The devnet bonds the page points at: one live (coupons, private holdings, a tripped pool), one run to maturity. */
const LIVE_BOND = "9jUHSrfKuCpyDA4GEVmJ6JHeAqz6N1mRYZAhjp8g927K";
const MATURED_BOND = "DaNBWNahN4WYznVc7d7BxTFQTPk7FuhToW2ipPzNWJVh";
const CONSOLE = `/issuer?asset=${LIVE_BOND}`;

/** What AssetFlow is built with, named in place of customer logos it does not have. */
const STANDARDS = ["Token-2022", "Token ACL (sRFC-37)", "Solana Attestation Service", "MagicBlock", "USDC"];

const PROOF = [
  { key: "tests", href: `${REPO}/tree/main/solana/tests` },
  { key: "guarantees", href: `/proof?asset=${LIVE_BOND}` },
  { key: "lifecycle", href: `/proof?asset=${MATURED_BOND}` },
  { key: "open", href: REPO },
] as const;

const JOBS = ["eligibility", "payments", "redemptions"] as const;

/** Readable close-ups of the live devnet screens, one per feature row; all shown in the same frame. */
const FEATURES = [
  { key: "eligibility", src: "/landing/feature-eligibility.webp", w: 1304, h: 766, href: `/holder?asset=${LIVE_BOND}` },
  { key: "kyc", src: "/landing/feature-kyc.webp", w: 1304, h: 720, href: "/kyc" },
  { key: "coupons", src: "/landing/feature-coupons.webp", w: 1364, h: 926, href: `${CONSOLE}&tab=coupons` },
  { key: "private", src: "/landing/feature-private.webp", w: 1304, h: 712, href: `${CONSOLE}&tab=private` },
  { key: "breaker", src: "/landing/feature-breaker.webp", w: 1304, h: 996, href: `${CONSOLE}&tab=pools` },
] as const;

const WHY = [
  { key: "tokenAcl", href: "https://github.com/solana-foundation/token-acl" },
  { key: "sas", href: "https://solana.com/news/solana-attestation-service" },
  { key: "fees", href: "https://solana.com/docs/core/fees" },
  { key: "privacy", href: "https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart" },
  { key: "institutions", href: "https://solana.com/news/overview-of-institutional-real-world-assets-on-solana" },
] as const;

const LIFECYCLE = ["issue", "admit", "record", "pay", "redeem", "mature"] as const;
const CHAINS = [
  { href: "/base", label: "Base" },
  { href: "/arbitrum", label: "Arbitrum" },
  { href: "/robinhood", label: "Robinhood Chain" },
];
const BUYERS = ["issuers", "admins", "platforms"] as const;
const REGISTER = [
  { key: "holderA", units: "2,500", amount: "$125.00" },
  { key: "holderB", units: "1,000", amount: "$50.00" },
  { key: "pool", units: "500", amount: "$25.00" },
] as const;

const num = (i: number) => String(i + 1).padStart(2, "0");
const sourceLink = "text-sm text-ink-3 underline underline-offset-2 hover:text-ink";

export default async function Home() {
  const t = await getTranslations("home");
  const program = PROGRAM_ID.toBase58();

  return (
    <>
      {/* Hero: one line, one sentence, one pair of actions, and a real register from the chain */}
      <section className="bg-surface">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:py-24">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs font-medium text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
              {t("pill")}
            </p>
            <h1 className="mt-6 font-serif text-5xl leading-[1.04] tracking-tight text-ink sm:text-6xl lg:text-[64px]">{t("title")}</h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">{t("lede")}</p>
            <Actions pilot={t("ctaPilot")} console={t("ctaConsole")} />
          </div>

          <aside className="rounded-lg bg-night p-6 text-white shadow-xl shadow-ink/20" aria-labelledby="register-title">
            <div className="flex items-center justify-between gap-3">
              <p id="register-title" className="text-sm font-semibold">
                {t("register.title")}
              </p>
              <span className="rounded-md bg-mint/15 px-2 py-0.5 text-xs font-semibold text-mint">{t("register.paid")}</span>
            </div>
            <p className="mt-1 text-xs text-white/55">
              {t("register.sub")}{" "}
              <a className="mono underline underline-offset-2 hover:text-white" href={explorer.address(LIVE_BOND)} target="_blank" rel="noreferrer">
                {shortKey(LIVE_BOND)}
              </a>
            </p>
            <table className="mt-5 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-white/45">
                  <th className="pb-2 font-medium">{t("register.holder")}</th>
                  <th className="pb-2 pl-3 text-right font-medium">{t("register.units")}</th>
                  <th className="pb-2 pl-4 text-right font-medium">{t("register.coupon")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-night-line">
                {REGISTER.map((r) => (
                  <tr key={r.key}>
                    <td className="py-2.5 text-white/85">{t(`register.${r.key}`)}</td>
                    <td className="tabular mono py-2.5 pl-3 text-right text-white/85">{r.units}</td>
                    <td className="tabular mono py-2.5 pl-4 text-right">{r.amount}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2.5 font-semibold">
                    {t("register.total")} <span className="ml-1 text-mint">✓ {t("register.supply")}</span>
                  </td>
                  <td className="tabular mono py-2.5 pl-3 text-right font-semibold">4,000</td>
                  <td className="tabular mono py-2.5 pl-4 text-right font-semibold text-mint">$200.00</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-4 border-t border-night-line pt-4 text-xs leading-relaxed text-white/60">{t("register.note")}</p>
          </aside>
        </div>
      </section>

      {/* Trust, near the top: what it is built with, what can be checked, and who has judged it */}
      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 lg:gap-x-10">
            <p className="w-full text-sm text-ink-3 lg:w-auto">{t("builtWith")}</p>
            {STANDARDS.map((s) => (
              <p key={s} className="text-base font-semibold tracking-tight text-ink-2 sm:text-lg">
                {s}
              </p>
            ))}
          </div>
          <CardGrid cols={4}>
            {PROOF.map((p) => (
              <article key={p.key} className="card flex flex-col p-6">
                <p className="tabular text-3xl font-semibold tracking-tight text-ink">{t(`proof.${p.key}.value`)}</p>
                <p className="mt-2 flex-1 text-base leading-relaxed text-ink-2">{t(`proof.${p.key}.label`)}</p>
                <div className="mt-5">
                  <ArrowLink href={p.href}>{t(`proof.${p.key}.link`)}</ArrowLink>
                </div>
              </article>
            ))}
          </CardGrid>
          <div className="mt-8 grid gap-4 text-sm text-ink-3 lg:grid-cols-[auto_1fr_1fr] lg:gap-8">
            <p className="font-semibold text-ink-2">{t("recognition.eyebrow")}</p>
            {(["solar", "hashkey"] as const).map((k) => (
              <p key={k}>
                <span className="font-semibold text-ink-2">{t(`recognition.${k}.title`)}</span> · {t(`recognition.${k}.body`)}
              </p>
            ))}
          </div>
          <p className="mt-4 text-sm text-ink-3">{t("proof.footnote")}</p>
        </div>
      </section>

      <Section>
        <SectionHeader eyebrow={t("problem.eyebrow")} title={t("problem.title")} lede={t("problem.lede")} />
        <CardGrid>
          {JOBS.map((k, i) => (
            <Card key={k} label={num(i)} title={t(`jobs.${k}.title`)}>
              {t(`jobs.${k}.body`)}
            </Card>
          ))}
        </CardGrid>
      </Section>

      {/* The product: one row per job, each with a readable close-up of the live screen */}
      <Section id="product">
        <SectionHeader eyebrow={t("product.eyebrow")} title={t("product.title")} lede={t("product.lede")} />
        <div className="mt-16 space-y-20">
          {FEATURES.map((f, i) => (
            <div key={f.key} className="grid items-center gap-10 lg:grid-cols-[2fr_3fr] lg:gap-16">
              <div>
                <p className="mono mb-3 text-xs text-accent">{num(i)}</p>
                <h3 className="text-xl font-semibold leading-snug tracking-tight text-ink">{t(`features.${f.key}.title`)}</h3>
                <p className="mt-2 text-base leading-relaxed text-ink-2">{t(`features.${f.key}.body`)}</p>
                <p className="mt-5 border-t border-line pt-4 text-sm leading-relaxed text-ink-3">
                  <span className="font-semibold text-ink-2">{t("onSolana")}</span> {t(`features.${f.key}.solana`)}
                </p>
                <div className="mt-5">
                  <ArrowLink href={f.href}>{t(`features.${f.key}.link`)}</ArrowLink>
                </div>
              </div>
              <div className="flex items-center justify-center rounded-lg border border-line bg-canvas p-4 sm:p-6 lg:h-[31rem]">
                <Image src={f.src} alt={t(`features.${f.key}.alt`)} width={f.w} height={f.h} sizes="(min-width: 1024px) 600px, 100vw" className="h-auto w-full rounded-lg shadow-sm" />
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="why-solana" tint>
        <SectionHeader eyebrow={t("why.eyebrow")} title={t("why.title")} lede={t("why.lede")} />
        <CardGrid>
          {WHY.map((w, i) => (
            <Card
              key={w.key}
              label={num(i)}
              title={t(`why.reasons.${w.key}.title`)}
              footer={
                <a className={sourceLink} href={w.href} target="_blank" rel="noreferrer">
                  {t(`why.reasons.${w.key}.source`)}
                </a>
              }
            >
              {t(`why.reasons.${w.key}.body`)}
            </Card>
          ))}
          <Card
            label="devnet"
            title={t("why.programCard.title")}
            footer={
              <a className={`${sourceLink} mono`} href={explorer.address(program)} target="_blank" rel="noreferrer">
                {t("why.program")} {shortKey(program)}
              </a>
            }
          >
            {t("why.programCard.body")}
          </Card>
        </CardGrid>
      </Section>

      <Section id="how-it-works">
        <SectionHeader eyebrow={t("life.eyebrow")} title={t("life.title")} />
        <CardGrid>
          {LIFECYCLE.map((k, i) => (
            <Card key={k} label={num(i)} title={t(`life.steps.${k}.title`)}>
              {t(`life.steps.${k}.body`)}
            </Card>
          ))}
        </CardGrid>
        <p className="mt-8 text-base text-ink-2">
          {t("life.note")} <ArrowLink href={`/proof?asset=${MATURED_BOND}`}>{t("life.noteLink")}</ArrowLink>
        </p>
      </Section>

      <Section id="open-source">
        <SectionHeader eyebrow={t("open.eyebrow")} title={t("open.title")} lede={t("open.lede")} />
        <CardGrid>
          <Card title={t("open.code.title")} footer={<ArrowLink href={REPO}>{t("open.code.link")}</ArrowLink>}>
            {t("open.code.body")}
          </Card>
          <Card title={t("open.architecture.title")} footer={<ArrowLink href={`${REPO}/blob/main/ARCHITECTURE.md`}>{t("open.architecture.link")}</ArrowLink>}>
            {t("open.architecture.body")}
          </Card>
          <Card
            title={t("open.chains.title")}
            footer={CHAINS.map((c) => (
              <ArrowLink key={c.href} href={c.href}>
                {c.label}
              </ArrowLink>
            ))}
          >
            {t("open.chains.body")}
          </Card>
        </CardGrid>
      </Section>

      <Section id="pilots">
        <SectionHeader eyebrow={t("pilot.eyebrow")} title={t("pilot.title")} lede={t("pilot.lede")} />
        <CardGrid>
          {BUYERS.map((b) => (
            <Card key={b} title={t(`pilot.buyers.${b}.title`)}>
              {t(`pilot.buyers.${b}.body`)}
            </Card>
          ))}
        </CardGrid>
        <p className="mt-8">
          <ArrowLink href="/pricing">{t("pilot.pricingLink")}</ArrowLink>
        </p>
      </Section>

      <Section tint>
        <SectionHeader title={t("closing.title")} lede={t("closing.body")} />
        <Actions pilot={t("ctaPilot")} console={t("ctaConsole")} />
      </Section>
    </>
  );
}
