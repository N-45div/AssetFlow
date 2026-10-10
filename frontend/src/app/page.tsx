import { getTranslations } from "next-intl/server";
import { Actions, ArrowLink, Feature, Glass, GlassHead, GlassRows, Scene, Section, TextItem, Title } from "@/components/landing";
import { PROGRAM_ID } from "@/lib/chain/config";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { REPO } from "@/lib/site";

/** The devnet bonds the page reads from: one live (coupons, private holdings, a tripped pool), one run to maturity. */
const LIVE_BOND = "9jUHSrfKuCpyDA4GEVmJ6JHeAqz6N1mRYZAhjp8g927K";
const MATURED_BOND = "DaNBWNahN4WYznVc7d7BxTFQTPk7FuhToW2ipPzNWJVh";
/** The stand-in trading pool the circuit breaker tripped on devnet. */
const POOL_SHORT = "BR7C…8tsi";
const CONSOLE = `/issuer?asset=${LIVE_BOND}`;

/** What AssetFlow is built with, named in place of customer logos it does not have. */
const STANDARDS = ["Token-2022", "Token ACL", "Solana Attestation Service", "MagicBlock", "USDC"];

const PROOF = [
  { key: "tests", href: `${REPO}/tree/main/solana/tests` },
  { key: "guarantees", href: `/proof?asset=${LIVE_BOND}` },
  { key: "lifecycle", href: `/proof?asset=${MATURED_BOND}` },
  { key: "open", href: REPO },
] as const;

const REGISTER = [
  { key: "holderA", units: "2,500", amount: "$125.00" },
  { key: "holderB", units: "1,000", amount: "$50.00" },
  { key: "pool", units: "500", amount: "$25.00" },
] as const;

const WHY = [
  { key: "tokenAcl", href: "https://github.com/solana-foundation/token-acl" },
  { key: "sas", href: "https://solana.com/news/solana-attestation-service" },
  { key: "fees", href: "https://solana.com/docs/core/fees" },
  { key: "privacy", href: "https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart" },
  { key: "institutions", href: "https://solana.com/news/overview-of-institutional-real-world-assets-on-solana" },
] as const;

const LIFECYCLE = ["issue", "admit", "record", "pay", "redeem", "mature"] as const;
const BUYERS = ["issuers", "admins", "platforms"] as const;
const CHAINS = [
  { href: "/base", label: "Base" },
  { href: "/arbitrum", label: "Arbitrum" },
  { href: "/robinhood", label: "Robinhood Chain" },
];
const keys = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

export default async function Home() {
  const t = await getTranslations("home");
  const program = PROGRAM_ID.toBase58();
  const pairs = (base: string, n: number) => keys("r", n).map((r) => [t(`${base}.${r}.k`), t(`${base}.${r}.v`)] as [string, string]);
  const checks = (base: string) => keys("c", 3).map((c) => t(`${base}.${c}`));
  const foot = (text: string) => <p className="mt-3 text-[11px] text-white/70">{text}</p>;

  return (
    <div className="bg-canvas">
      {/* Hero: one status line, one title, one sentence, one pair of actions, then a real register from the chain */}
      <section className="mx-auto max-w-page px-4 pt-12 sm:px-6 lg:pt-20">
        <p className="mb-4 flex items-center gap-2 text-[13px] text-ink-3">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
          {t("pill")}
        </p>
        <Title as="h1" title={t("title")} lede={t("lede")} />
        <Actions pilot={t("ctaPilot")} console={t("ctaConsole")} />
        <Scene tone="sea" className="mt-12 flex items-center justify-center p-5 sm:min-h-[26rem] sm:p-12">
          <Glass className="max-w-md">
            <GlassHead
              title={t("register.title")}
              sub={
                <>
                  {t("register.sub")}{" "}
                  <a className="underline underline-offset-2 hover:text-white" href={explorer.address(LIVE_BOND)} target="_blank" rel="noreferrer">
                    {shortKey(LIVE_BOND)}
                  </a>
                </>
              }
              badge={t("register.paid")}
            />
            <table className="mt-3 w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] text-white/65">
                  <th className="pb-1.5 font-medium">{t("register.holder")}</th>
                  <th className="pb-1.5 pl-3 text-right font-medium">{t("register.units")}</th>
                  <th className="pb-1.5 pl-3 text-right font-medium">{t("register.coupon")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/15">
                {REGISTER.map((r) => (
                  <tr key={r.key}>
                    <td className="py-2 text-white/85">{t(`register.${r.key}`)}</td>
                    <td className="tabular py-2 pl-3 text-right">{r.units}</td>
                    <td className="tabular py-2 pl-3 text-right">{r.amount}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2">
                    {t("register.total")} · {t("register.supply")} ✓
                  </td>
                  <td className="tabular py-2 pl-3 text-right">4,000</td>
                  <td className="tabular py-2 pl-3 text-right">$200.00</td>
                </tr>
              </tbody>
            </table>
            {foot(t("register.note"))}
          </Glass>
        </Scene>
      </section>

      {/* Trust: what it is built with, what anyone can check, and who has judged it */}
      <Section>
        <p className="text-[13px] text-ink-3">{t("builtWith")}</p>
        <div className="mt-5 flex flex-wrap gap-x-10 gap-y-3 lg:justify-between">
          {STANDARDS.map((s) => (
            <p key={s} className="whitespace-nowrap text-base font-semibold tracking-tight text-ink-2 sm:text-lg">
              {s}
            </p>
          ))}
        </div>
        <div className="mt-16 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {PROOF.map((p) => (
            <div key={p.key}>
              <p className="tabular text-3xl font-medium tracking-tight text-ink">{t(`proof.${p.key}.value`)}</p>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{t(`proof.${p.key}.label`)}</p>
              <div className="mt-2">
                <ArrowLink href={p.href}>{t(`proof.${p.key}.link`)}</ArrowLink>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-12 space-y-1 text-[13px] text-ink-3">
          <p>
            <span className="text-ink-2">{t("recognition.eyebrow")}:</span> {t("recognition.solar.title")}, {t("recognition.solar.body")} · {t("recognition.hashkey.title")}, {t("recognition.hashkey.body")}
          </p>
          <p>{t("proof.footnote")}</p>
        </div>
      </Section>

      <Section id="product">
        <Title title={t("product.title")} lede={t("product.lede")} />
        <div className="mt-14 grid gap-x-6 gap-y-16 lg:grid-cols-2">
          <Feature
            label={t("features.admit.label")}
            title={t("features.admit.title")}
            body={t("features.admit.body")}
            checks={checks("features.admit.checks")}
            link={<ArrowLink href={`/holder?asset=${LIVE_BOND}`}>{t("features.admit.link")}</ArrowLink>}
          >
            <Scene tone="sky" className="flex h-[23rem] items-center justify-center p-5 sm:p-8">
              <Glass className="max-w-sm">
                <GlassHead title={t("features.admit.card.title")} badge={t("features.admit.card.badge")} />
                <ul className="mt-3 divide-y divide-white/15 text-[13px]">
                  {keys("r", 6).map((r) => (
                    <li key={r} className="flex gap-2.5 py-2">
                      <span aria-hidden="true">✓</span>
                      {t(`features.admit.card.rows.${r}`)}
                    </li>
                  ))}
                </ul>
              </Glass>
            </Scene>
          </Feature>
          <Feature
            label={t("features.pay.label")}
            title={t("features.pay.title")}
            body={t("features.pay.body")}
            checks={checks("features.pay.checks")}
            link={<ArrowLink href={`${CONSOLE}&tab=coupons`}>{t("features.pay.link")}</ArrowLink>}
          >
            <Scene tone="moss" className="flex h-[23rem] items-center justify-center p-5 sm:p-8">
              <Glass className="max-w-sm">
                <GlassHead title={t("features.pay.card.title")} sub={t("features.pay.card.sub")} badge={t("features.pay.card.badge")} />
                <GlassRows rows={pairs("features.pay.card.rows", 5)} />
              </Glass>
            </Scene>
          </Feature>
        </div>

        <div className="mt-20 grid gap-x-6 gap-y-16 lg:grid-cols-3">
          <Feature
            label={t("features.redeem.label")}
            title={t("features.redeem.title")}
            body={t("features.redeem.body")}
            link={<ArrowLink href={`/proof?asset=${MATURED_BOND}`}>{t("features.redeem.link")}</ArrowLink>}
          >
            <Scene tone="sand" className="flex h-[20rem] items-center justify-center p-5">
              <Glass className="p-4">
                <GlassHead title={t("features.redeem.card.title")} sub={shortKey(MATURED_BOND)} badge={t("features.redeem.card.badge")} />
                <GlassRows rows={pairs("features.redeem.card.rows", 4)} />
                {foot(t("features.redeem.card.foot"))}
              </Glass>
            </Scene>
          </Feature>
          <Feature
            label={t("features.private.label")}
            title={t("features.private.title")}
            body={t("features.private.body")}
            link={<ArrowLink href={`${CONSOLE}&tab=private`}>{t("features.private.link")}</ArrowLink>}
          >
            <Scene tone="dusk" className="flex h-[20rem] items-center justify-center p-5">
              <Glass className="p-4">
                <GlassHead title={t("features.private.card.title")} sub={shortKey(LIVE_BOND)} />
                <GlassRows rows={pairs("features.private.card.rows", 4)} />
                {foot(t("features.private.card.foot"))}
              </Glass>
            </Scene>
          </Feature>
          <Feature
            label={t("features.protect.label")}
            title={t("features.protect.title")}
            body={t("features.protect.body")}
            link={<ArrowLink href={`${CONSOLE}&tab=pools`}>{t("features.protect.link")}</ArrowLink>}
          >
            <Scene tone="sage" className="flex h-[20rem] items-center justify-center p-5">
              <Glass className="p-4">
                <GlassHead title={t("features.protect.card.title")} sub={POOL_SHORT} badge={t("features.protect.card.badge")} />
                <GlassRows rows={pairs("features.protect.card.rows", 4)} />
                {foot(t("features.protect.card.foot"))}
              </Glass>
            </Scene>
          </Feature>
        </div>
      </Section>

      <Section id="why-solana">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <Title title={t("why.title")} lede={t("why.lede")} />
            <div className="mt-6">
              <ArrowLink href={explorer.address(program)}>
                {t("why.program")} {shortKey(program)}
              </ArrowLink>
            </div>
          </div>
          <Scene tone="sea" className="flex items-center justify-center p-5 sm:p-10">
            <ol className="w-full max-w-sm space-y-2.5">
              {keys("r", 5).map((r, i) => (
                <li key={r}>
                  <Glass className="flex items-baseline gap-3 px-4 py-3">
                    <span className="tabular text-[11px] text-white/65">{i + 1}</span>
                    <span>
                      <span className="block text-sm font-semibold">{t(`why.layers.${r}.k`)}</span>
                      <span className="block text-xs text-white/75">{t(`why.layers.${r}.v`)}</span>
                    </span>
                  </Glass>
                </li>
              ))}
            </ol>
          </Scene>
        </div>
        <div className="mt-16 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {WHY.map((w) => (
            <TextItem key={w.key} title={t(`why.reasons.${w.key}.title`)} footer={<ArrowLink href={w.href}>{t(`why.reasons.${w.key}.source`)}</ArrowLink>}>
              {t(`why.reasons.${w.key}.body`)}
            </TextItem>
          ))}
          <TextItem title={t("why.programCard.title")} footer={<ArrowLink href={explorer.address(program)}>{`${t("why.program")} ${shortKey(program)}`}</ArrowLink>}>
            {t("why.programCard.body")}
          </TextItem>
        </div>
      </Section>

      <Section id="how-it-works">
        <Title
          title={t("life.title")}
          lede={
            <>
              {t("life.note")} <ArrowLink href={`/proof?asset=${MATURED_BOND}`}>{t("life.noteLink")}</ArrowLink>
            </>
          }
        />
        <Scene tone="sky" className="mt-12 p-5 sm:p-10">
          <ol className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LIFECYCLE.map((k, i) => (
              <li key={k}>
                <Glass className="h-full p-4">
                  <p className="tabular text-[11px] text-white/65">{String(i + 1).padStart(2, "0")}</p>
                  <p className="mt-1 text-sm font-semibold">{t(`life.steps.${k}.title`)}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-white/85">{t(`life.steps.${k}.body`)}</p>
                </Glass>
              </li>
            ))}
          </ol>
        </Scene>
      </Section>

      <Section id="buyers">
        <Title title={t("buyers.title")} />
        <div className="mt-12 grid gap-x-8 gap-y-10 md:grid-cols-3">
          {BUYERS.map((b) => (
            <TextItem key={b} title={t(`buyers.${b}.title`)}>
              {t(`buyers.${b}.body`)}
            </TextItem>
          ))}
        </div>
      </Section>

      <Section id="faq">
        <div className="grid gap-10 lg:grid-cols-[1fr_2fr]">
          <h2 className="font-serif text-4xl leading-[1.08] tracking-tight text-ink sm:text-5xl">{t("faq.title")}</h2>
          <div className="divide-y divide-line border-y border-line">
            {(["custody", "audit", "wallets", "pilot", "chains", "open"] as const).map((k, i) => (
              <details key={k} className="group" open={i === 0}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-lg font-medium text-ink [&::-webkit-details-marker]:hidden">
                  {t(`faq.${k}.q`)}
                  <span className="text-ink-3 transition-transform group-open:rotate-180" aria-hidden="true">
                    ▾
                  </span>
                </summary>
                <div className="pb-6 text-[15px] leading-relaxed text-ink-2">
                  <p>{t(`faq.${k}.a`)}</p>
                  {k === "pilot" && (
                    <div className="mt-3">
                      <ArrowLink href="/pricing">{t("faq.links.pricing")}</ArrowLink>
                    </div>
                  )}
                  {k === "chains" && (
                    <div className="mt-3 flex flex-wrap gap-x-4">
                      {CHAINS.map((c) => (
                        <ArrowLink key={c.href} href={c.href}>
                          {c.label}
                        </ArrowLink>
                      ))}
                    </div>
                  )}
                  {k === "open" && (
                    <div className="mt-3 flex flex-wrap gap-x-4">
                      <ArrowLink href={REPO}>{t("faq.links.code")}</ArrowLink>
                      <ArrowLink href={`${REPO}/blob/main/ARCHITECTURE.md`}>{t("faq.links.architecture")}</ArrowLink>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      </Section>

      <Section>
        <Scene tone="deep" className="p-8 sm:p-14">
          <div className="max-w-xl">
            <h2 className="font-serif text-4xl leading-[1.08] tracking-tight text-white sm:text-5xl">{t("closing.title")}</h2>
            <p className="mt-4 text-base leading-relaxed text-white/85 sm:text-[17px]">{t("closing.body")}</p>
            <Actions pilot={t("ctaPilot")} console={t("ctaConsole")} onScene />
          </div>
        </Scene>
      </Section>
    </div>
  );
}
