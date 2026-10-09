import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PROGRAM_ID } from "@/lib/chain/config";
import { explorer, shortKey } from "@/lib/chain/explorer";

const REPO = "https://github.com/N-45div/AssetFlow";
const PILOT = "https://t.me/holaworked";
/** The devnet bonds the page points at: one live (coupons, private holdings, a tripped pool), one run to maturity. */
const LIVE_BOND = "9jUHSrfKuCpyDA4GEVmJ6JHeAqz6N1mRYZAhjp8g927K";
const MATURED_BOND = "DaNBWNahN4WYznVc7d7BxTFQTPk7FuhToW2ipPzNWJVh";

const PROOF = [
  { key: "tests", href: `${REPO}/tree/main/solana/tests` },
  { key: "guarantees", href: `/proof?asset=${LIVE_BOND}` },
  { key: "lifecycle", href: `/proof?asset=${MATURED_BOND}` },
  { key: "open", href: REPO },
] as const;

const WHY = [
  { key: "tokenAcl", href: "https://github.com/solana-foundation/token-acl" },
  { key: "sas", href: "https://solana.com/news/solana-attestation-service" },
  { key: "fees", href: "https://solana.com/docs/core/fees" },
  { key: "privacy", href: "https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart" },
  { key: "institutions", href: "https://solana.com/news/overview-of-institutional-real-world-assets-on-solana" },
] as const;

const LIFECYCLE = ["issue", "admit", "record", "pay", "redeem", "mature"] as const;
const JOBS = ["eligibility", "payments", "redemptions"] as const;
const SCREENS = [
  { key: "console", src: "/landing/console.webp", w: 1440, h: 998, href: "/issuer" },
  { key: "holder", src: "/landing/holder.webp", w: 1440, h: 825, href: "/holder" },
  { key: "proof", src: "/landing/proof.webp", w: 1440, h: 885, href: `/proof?asset=${LIVE_BOND}` },
] as const;
const PRICES = ["programs", "console", "servicing", "actions"] as const;
const BUYERS = ["issuers", "admins", "platforms"] as const;
const REGISTER = [
  { key: "holderA", units: "2,500", amount: "$125.00" },
  { key: "holderB", units: "1,000", amount: "$50.00" },
  { key: "pool", units: "500", amount: "$25.00" },
] as const;

function Eyebrow({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <p className={`text-xs font-semibold uppercase tracking-[0.16em] ${dark ? "text-mint" : "text-accent"}`}>{children}</p>;
}

function Heading({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <h2 className={`mt-3 max-w-3xl font-serif text-4xl leading-[1.08] tracking-tight sm:text-5xl ${dark ? "text-white" : "text-ink"}`}>
      {children}
    </h2>
  );
}

export default async function Home() {
  const t = await getTranslations("home");

  return (
    <>
      {/* Hero */}
      <section className="bg-night text-white">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 pb-16 pt-14 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:pb-24 lg:pt-20">
          <div>
            <div className="flex flex-wrap gap-2">
              {(["live", "open", "audit"] as const).map((k) => (
                <span key={k} className="inline-flex items-center gap-2 rounded-full border border-night-line px-3 py-1 text-xs font-medium text-white/80">
                  <span className={`h-1.5 w-1.5 rounded-full ${k === "audit" ? "bg-amber-400" : "bg-mint"}`} aria-hidden="true" />
                  {t(`status.${k}`)}
                </span>
              ))}
            </div>
            <p className="mt-8 text-sm font-semibold uppercase tracking-[0.16em] text-mint">{t("kicker")}</p>
            <h1 className="mt-4 font-serif text-5xl leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">{t("title")}</h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/75">{t("lede")}</p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/issuer" className="btn h-11 bg-mint px-5 text-night hover:bg-white">
                {t("ctaConsole")}
              </Link>
              <a href={PILOT} className="btn h-11 border border-white/25 px-5 text-white hover:bg-white/10" target="_blank" rel="noreferrer">
                {t("ctaPilot")}
              </a>
              <Link href={`/proof?asset=${LIVE_BOND}`} className="px-2 text-sm font-medium text-mint hover:underline">
                {t("ctaProof")} →
              </Link>
            </div>
          </div>

          {/* A real register: coupon 1 of the live devnet bond, counted on-chain */}
          <aside className="self-start rounded-2xl border border-night-line bg-night-2 p-6 shadow-2xl shadow-black/40" aria-labelledby="register-title">
            <div className="flex items-center justify-between gap-3">
              <h2 id="register-title" className="text-sm font-semibold text-white">
                {t("register.title")}
              </h2>
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
                    <td className="tabular mono py-2.5 pl-4 text-right text-white">{r.amount}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2.5 font-semibold text-white">
                    {t("register.total")} <span className="ml-1 text-mint">✓ {t("register.supply")}</span>
                  </td>
                  <td className="tabular mono py-2.5 pl-3 text-right font-semibold text-white">4,000</td>
                  <td className="tabular mono py-2.5 pl-4 text-right font-semibold text-mint">$200.00</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-4 border-t border-night-line pt-4 text-xs leading-relaxed text-white/60">{t("register.note")}</p>
          </aside>
        </div>
      </section>

      {/* Proof strip, in place of logos */}
      <section className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {PROOF.map((p) => (
              <a key={p.key} href={p.href} className="group bg-surface p-5 hover:bg-surface-2">
                <p className="tabular text-3xl font-semibold tracking-tight text-ink">{t(`proof.${p.key}.value`)}</p>
                <p className="mt-2 text-sm text-ink-2">{t(`proof.${p.key}.label`)}</p>
                <p className="mt-3 text-xs font-medium text-accent group-hover:underline">{t(`proof.${p.key}.link`)} →</p>
              </a>
            ))}
          </div>
          <p className="mt-4 text-xs text-ink-3">{t("proof.footnote")}</p>
        </div>
      </section>

      {/* The problem */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t("problem.eyebrow")}</Eyebrow>
        <Heading>{t("problem.title")}</Heading>
        <p className="mt-5 max-w-2xl text-lg text-ink-2">{t("problem.lede")}</p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {JOBS.map((k, i) => (
            <article key={k} className="card flex flex-col p-6">
              <p className="mono text-xs text-ink-3">0{i + 1}</p>
              <h3 className="mt-3 text-lg font-semibold">{t(`jobs.${k}.title`)}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-2">{t(`jobs.${k}.body`)}</p>
              <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-ink-3">
                <span className="font-semibold text-ink-2">{t("onSolana")}</span> {t(`jobs.${k}.solana`)}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Why Solana */}
      <section id="why-solana" className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
            <div className="self-start lg:sticky lg:top-24">
              <Eyebrow>{t("why.eyebrow")}</Eyebrow>
              <Heading>{t("why.title")}</Heading>
              <p className="mt-5 text-ink-2">{t("why.lede")}</p>
              <a
                className="mono mt-6 inline-block text-sm text-accent underline underline-offset-2"
                href={explorer.address(PROGRAM_ID.toBase58())}
                target="_blank"
                rel="noreferrer"
              >
                {t("why.program")} {shortKey(PROGRAM_ID.toBase58())} ↗
              </a>
            </div>
            <ol className="grid gap-px overflow-hidden rounded-xl border border-line bg-line">
              {WHY.map((w, i) => (
                <li key={w.key} className="grid gap-2 bg-surface p-5 sm:grid-cols-[2.5rem_1fr]">
                  <span className="mono text-sm font-semibold text-accent">0{i + 1}</span>
                  <div>
                    <h3 className="font-semibold">{t(`why.reasons.${w.key}.title`)}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-ink-2">{t(`why.reasons.${w.key}.body`)}</p>
                    <a className="mt-2 inline-block text-xs text-ink-3 underline underline-offset-2 hover:text-ink" href={w.href} target="_blank" rel="noreferrer">
                      {t(`why.reasons.${w.key}.source`)}
                    </a>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* One bond's life */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t("life.eyebrow")}</Eyebrow>
        <Heading>{t("life.title")}</Heading>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {LIFECYCLE.map((k, i) => (
            <li key={k} className="relative rounded-xl border border-line bg-surface p-5">
              <p className="mono text-xs text-accent">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-2 font-semibold">{t(`life.steps.${k}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{t(`life.steps.${k}.body`)}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-ink-2">
          {t("life.note")}{" "}
          <Link className="font-medium text-accent underline underline-offset-2" href={`/proof?asset=${MATURED_BOND}`}>
            {t("life.noteLink")} →
          </Link>
        </p>
      </section>

      {/* Private holdings and the circuit breaker */}
      <section className="bg-night text-white">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-20 sm:px-6 lg:grid-cols-2">
          {(["breaker", "private"] as const).map((k) => (
            <article key={k} className="flex flex-col rounded-2xl border border-night-line bg-night-2 p-7">
              <Eyebrow dark>{t(`advanced.${k}.eyebrow`)}</Eyebrow>
              <h3 className="mt-3 font-serif text-3xl leading-tight">{t(`advanced.${k}.title`)}</h3>
              <p className="mt-4 text-sm leading-relaxed text-white/70">{t(`advanced.${k}.body`)}</p>
              <div className="mt-6 overflow-hidden rounded-lg border border-night-line bg-white">
                <Image
                  src={k === "breaker" ? "/landing/pool.webp" : "/landing/private.webp"}
                  alt={t(`advanced.${k}.alt`)}
                  width={1140}
                  height={k === "breaker" ? 450 : 322}
                  className="h-auto w-full"
                />
              </div>
              <p className="mt-5 text-sm font-medium text-mint">{t(`advanced.${k}.fact`)}</p>
            </article>
          ))}
        </div>
      </section>

      {/* The product, as it is */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Eyebrow>{t("product.eyebrow")}</Eyebrow>
        <Heading>{t("product.title")}</Heading>
        <p className="mt-5 max-w-2xl text-ink-2">{t("product.lede")}</p>
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {SCREENS.map((s) => (
            <Link key={s.key} href={s.href} className="group flex flex-col">
              <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition-shadow group-hover:shadow-md">
                <Image src={s.src} alt={t(`product.${s.key}.alt`)} width={s.w} height={s.h} className="h-auto w-full" />
              </div>
              <h3 className="mt-4 font-semibold">{t(`product.${s.key}.title`)}</h3>
              <p className="mt-1 text-sm text-ink-2">{t(`product.${s.key}.body`)}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Open source, and other chains */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2">
          <div>
            <Eyebrow>{t("open.eyebrow")}</Eyebrow>
            <Heading>{t("open.title")}</Heading>
            <p className="mt-5 text-ink-2">{t("open.body")}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a className="btn btn-secondary" href={REPO} target="_blank" rel="noreferrer">
                {t("open.repo")}
              </a>
              <a className="btn btn-secondary" href={`${REPO}/blob/main/ARCHITECTURE.md`} target="_blank" rel="noreferrer">
                {t("open.architecture")}
              </a>
            </div>
          </div>
          <div className="self-end">
            <h3 className="font-semibold">{t("open.chainsTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">{t("open.chainsBody")}</p>
            <div className="mt-5 flex flex-wrap gap-2 text-sm">
              {[
                { href: "/base", label: "Base" },
                { href: "/arbitrum", label: "Arbitrum" },
                { href: "/robinhood", label: "Robinhood Chain" },
              ].map((c) => (
                <Link key={c.href} href={c.href} className="rounded-md border border-line-strong px-3 py-1.5 text-ink-2 hover:text-ink">
                  {c.label} →
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Pilots and pricing */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <Eyebrow>{t("pilot.eyebrow")}</Eyebrow>
            <Heading>{t("pilot.title")}</Heading>
            <p className="mt-5 text-ink-2">{t("pilot.body")}</p>
            <ul className="mt-6 space-y-2 text-sm">
              {BUYERS.map((b) => (
                <li key={b} className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                  <span className="text-ink-2">{t(`pilot.buyers.${b}`)}</span>
                </li>
              ))}
            </ul>
            <a href={PILOT} className="btn btn-primary mt-8 h-11 px-5" target="_blank" rel="noreferrer">
              {t("ctaPilot")}
            </a>
          </div>
          <div className="card self-start p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">{t("pricing.title")}</h3>
              <span className="pill pill-neutral">{t("pricing.tag")}</span>
            </div>
            <dl className="mt-4 divide-y divide-line text-sm">
              {PRICES.map((k) => (
                <div key={k} className="flex justify-between gap-4 py-3">
                  <dt className="text-ink-2">{t(`pricing.${k}.label`)}</dt>
                  <dd className="tabular text-right font-medium">{t(`pricing.${k}.value`)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* Recognition */}
      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <Eyebrow>{t("recognition.eyebrow")}</Eyebrow>
          <ul className="mt-5 grid gap-4 md:grid-cols-2">
            {(["solar", "hashkey"] as const).map((k) => (
              <li key={k} className="rounded-xl border border-line p-5">
                <p className="font-semibold">{t(`recognition.${k}.title`)}</p>
                <p className="mt-1 text-sm text-ink-2">{t(`recognition.${k}.body`)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Closing */}
      <section className="bg-night text-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-20 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="max-w-2xl font-serif text-4xl leading-tight sm:text-5xl">{t("closing.title")}</h2>
            <p className="mt-4 max-w-xl text-white/70">{t("closing.body")}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a href={PILOT} className="btn h-11 bg-mint px-5 text-night hover:bg-white" target="_blank" rel="noreferrer">
              {t("ctaPilot")}
            </a>
            <Link href="/issuer" className="btn h-11 border border-white/25 px-5 text-white hover:bg-white/10">
              {t("ctaConsole")}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
