"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

function useTypewriter(text: string, speed = 38, delay = 600) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!started) return;
    setDisplayed("");
    setDone(false);
    let i = 0;
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      interval = setInterval(() => {
        i++;
        setDisplayed(text.slice(0, i));
        if (i >= text.length) {
          clearInterval(interval);
          setDone(true);
        }
      }, speed);
    }, delay);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [text, speed, delay, started]);

  return { displayed, done, start: () => setStarted(true) };
}

const contracts = [
  { name: "ComplianceRegistry", role: "Investor policy: jurisdiction, tier, accreditation, freeze, optional KYC oracle." },
  { name: "ServicedAssetToken", role: "Restricted ERC-20 with compliance-gated transfers and servicing hooks." },
  { name: "DistributionModule", role: "Merkle-root payout windows. Snapshots off-chain, claims and funds on-chain." },
  { name: "RedemptionModule", role: "Queued redemption requests with issuer review, approval, and settlement." },
  { name: "AssetOracleRouter", role: "Oracle-backed valuation for redemption quotes via Chainlink-style feeds." },
];

export default function Home() {
  const hero = useTypewriter("Post-issuance servicing infrastructure for tokenized assets on HashKey Chain.", 28, 400);
  const ctaLine = useTypewriter("Open the console and walk a tokenized asset through its full lifecycle.", 26, 300);
  const ctaRef = useRef<HTMLElement>(null);

  useEffect(() => {
    hero.start();
  }, []);

  useEffect(() => {
    const el = ctaRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { ctaLine.start(); observer.disconnect(); } },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="flex flex-1 flex-col">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden pb-16 pt-6">
        <header className="mx-auto flex w-full max-w-[1440px] items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="rise-in flex items-center gap-4">
            <div className="h-11 w-11 rounded-2xl border border-[var(--border)] bg-[linear-gradient(135deg,rgba(131,184,156,0.95),rgba(202,95,47,0.95))]" />
            <div>
              <p className="text-xs font-black uppercase tracking-[0.28em] text-[var(--foreground)]">AssetFlow</p>
              <p className="text-sm text-[var(--muted)]">HashKey Chain &middot; DeFi Track</p>
            </div>
          </div>
          <Link className="primary-cta text-sm" href="/console">
            Open Console
          </Link>
        </header>

        <div className="mx-auto mt-12 max-w-[1440px] px-4 sm:px-6 lg:px-8">
          <div className="max-w-[820px]">
            <p className="rise-in text-xs font-black uppercase tracking-[0.32em] text-[var(--muted)]">
              Horizon Hackathon &middot; Built on HashKey Chain
            </p>
            <div className="fade-in-delayed mt-5">
              <p className="display-face text-[clamp(3.5rem,8vw,6rem)] leading-[0.86] tracking-[-0.025em] text-[var(--ink-dark)]">
                AssetFlow
              </p>
              <h1 className={`display-face mt-4 min-h-[2em] text-[clamp(1.4rem,2.8vw,2.2rem)] leading-[1.3] text-[var(--muted)] typewriter-cursor typewriter-cursor-dark ${hero.done ? "typewriter-done" : ""}`}>
                {hero.displayed}&nbsp;
              </h1>
            </div>
            <p className="fade-in-delayed mt-6 max-w-[38rem] text-[0.95rem] leading-8 text-[var(--muted)]">
              Anyone can demo token issuance. The harder problem is what happens after: who can hold the asset,
              when payouts happen, how redemptions are reviewed, and how the issuer stays in control.
              AssetFlow is the servicing layer that makes tokenized assets actually operable.
            </p>
            <div className="fade-in-delayed mt-8 flex flex-wrap gap-3">
              <Link className="primary-cta" href="/console">
                Launch Console
              </Link>
              <a className="secondary-cta" href="#problem">
                Why This Matters
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem ── */}
      <section id="problem" className="border-t border-black/8 bg-[#f5ede4]">
        <div className="mx-auto grid w-full max-w-[1440px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
          <div>
            <p className="eyebrow">The problem</p>
            <h2 className="display-face mt-4 text-[clamp(2rem,4.5vw,3.4rem)] leading-[0.94] text-[var(--ink-dark)]">
              Issuance is solved. Servicing is not.
            </h2>
            <p className="mt-5 max-w-[28rem] text-[0.92rem] leading-7 text-[var(--muted)]">
              Tokenized RWA products on HashKey Chain can be issued, listed, and traded.
              But once investors hold units, the issuer still needs to manage compliance status,
              run periodic payouts, handle redemption queues, and pull valuation data &mdash;
              all without a standardized on-chain layer.
            </p>
          </div>
          <div className="space-y-0">
            {[
              ["Investor eligibility", "Who is approved, accredited, frozen? When does access expire? Which jurisdictions are whitelisted?", "Most issuers track this in spreadsheets or off-chain databases with no on-chain enforcement."],
              ["Payout distribution", "When a dividend or coupon payment is due, how does the issuer calculate allocations and let holders claim?", "Without a snapshot + merkle-proof model, payouts require manual transfers or centralized distribution."],
              ["Redemption management", "When a holder wants to exit, who reviews the request? How is it approved, rejected, or settled?", "No queue, no audit trail, no separation between approval and settlement."],
            ].map(([title, question, gap]) => (
              <div key={title} className="border-b border-black/8 py-6 first:pt-0 last:border-b-0 last:pb-0">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-[var(--accent)]">{title}</p>
                <p className="mt-2 text-[0.92rem] font-semibold leading-6 text-[var(--ink-dark)]">{question}</p>
                <p className="mt-1.5 text-[0.84rem] leading-6 text-[var(--muted)]">{gap}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── What AssetFlow does ── */}
      <section className="border-t border-black/8">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-20 sm:px-6 lg:px-8">
          <p className="eyebrow">What AssetFlow does</p>
          <h2 className="display-face mt-4 max-w-[32rem] text-[clamp(2rem,4.5vw,3.4rem)] leading-[0.94] text-[var(--ink-dark)]">
            One operating layer for everything after issuance.
          </h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: "Compliance gating", desc: "On-chain investor registry with jurisdiction, tier, accreditation, freeze state, and an optional external KYC oracle hook for HashKey-specific adapters." },
              { label: "Merkle distributions", desc: "Create snapshots off-chain, publish merkle roots on-chain, let holders claim with proofs. Cap-table stays off-chain, funds stay on-chain." },
              { label: "Redemption queues", desc: "Holders submit requests. Issuers review, approve or reject, then settle against a configured payout token. Full audit trail." },
              { label: "Oracle valuation", desc: "AssetOracleRouter quotes asset value and redemption value using Chainlink-style feeds (APRO, SUPRA on HashKey testnet)." },
              { label: "Safe-friendly admin", desc: "Issuer admin model works with multisig wallets. Admin and issuer roles can be split across different signers." },
              { label: "Backend + Console", desc: "Full API server with investor lookup, snapshot generation, distribution publishing, and a guided browser console." },
            ].map((item) => (
              <div key={item.label} className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-5">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-[var(--accent)]">{item.label}</p>
                <p className="mt-3 text-[0.84rem] leading-6 text-[var(--muted)]">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Architecture ── */}
      <section className="border-t border-black/8 bg-[var(--ink-dark)] text-white">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-20 sm:px-6 lg:px-8">
          <p className="eyebrow text-white/44">Contract architecture</p>
          <h2 className="display-face mt-4 max-w-[28rem] text-[clamp(2rem,4.5vw,3.4rem)] leading-[0.94]">
            Five contracts. One servicing stack.
          </h2>
          <p className="mt-4 max-w-[36rem] text-[0.92rem] leading-7 text-white/60">
            Deployed on HashKey Chain testnet (chain ID 133). The only replaceable demo dependency
            is the payout asset &mdash; use native HSK or point to any ERC-20.
          </p>
          <div className="mt-10 grid gap-4 lg:grid-cols-5">
            {contracts.map((c) => (
              <div key={c.name} className="rounded-[1.2rem] border border-white/8 bg-white/4 p-5">
                <p className="font-mono text-sm font-bold text-white/90">{c.name}</p>
                <p className="mt-2.5 text-[0.78rem] leading-5 text-white/50">{c.role}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Why HashKey Chain ── */}
      <section className="border-t border-black/8 bg-[#f5ede4]">
        <div className="mx-auto grid w-full max-w-[1440px] gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:px-8">
          <div>
            <p className="eyebrow">Why HashKey Chain</p>
            <h2 className="display-face mt-4 text-[clamp(2rem,4.5vw,3.2rem)] leading-[0.94] text-[var(--ink-dark)]">
              The only compliance-native chain built for institutional RWA.
            </h2>
          </div>
          <div className="grid gap-0">
            {[
              ["Compliance by design", "HashKey Chain is regulated under HashKey Group (3887.HK). KYC tooling, Safe support, and institutional onboarding are first-class."],
              ["RWA momentum", "Hong Kong's first regulated silver-backed RWA token launched on HashKey Chain (Mar 2026). eStable MMF hit $100M subscriptions day one."],
              ["Oracle coverage", "APRO, SUPRA, and Chainlink Streams are live on testnet. AssetFlow's oracle router already integrates them."],
              ["EVM compatible", "Standard Solidity deployment with Hardhat. No custom tooling required."],
            ].map(([title, desc]) => (
              <div key={title} className="border-b border-black/8 py-5 first:pt-0 last:border-b-0 last:pb-0">
                <p className="text-[0.84rem] font-bold text-[var(--ink-dark)]">{title}</p>
                <p className="mt-1.5 text-[0.84rem] leading-6 text-[var(--muted)]">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section ref={ctaRef} className="border-t border-black/8">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-20 sm:px-6 lg:px-8">
          <p className="eyebrow">Try it</p>
          <h2 className={`display-face mt-4 min-h-[1.6em] text-[clamp(1.4rem,2.8vw,2.4rem)] leading-[1.2] text-[var(--ink-dark)] typewriter-cursor typewriter-cursor-dark ${ctaLine.done ? "typewriter-done" : ""}`}>
            {ctaLine.displayed}&nbsp;
          </h2>
          <p className="mt-4 max-w-[36rem] text-[0.92rem] leading-7 text-[var(--muted)]">
            The console connects to the real backend. Approve an investor, issue units, publish a payout window,
            and settle a redemption &mdash; all from the browser.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link className="primary-cta" href="/console">
              Open Console
            </Link>
            <a
              className="secondary-cta"
              href="https://dorahacks.io/hackathon/2045/detail"
              target="_blank"
              rel="noreferrer"
            >
              Hackathon Page
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
