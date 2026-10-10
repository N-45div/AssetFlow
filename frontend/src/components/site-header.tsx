"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useTransition } from "react";
import { setLocale } from "@/i18n/actions";
import { LOCALES } from "@/i18n/locales";
import { CLUSTER } from "@/lib/chain/config";
import { EVM_CHAINS, EVM_CHAIN_KEYS, chainForPath, type EvmChainConfig } from "@/lib/evm/chains";
import { PILOT } from "@/lib/site";
import { EvmWalletButton } from "./evm-wallet-button";
import { isLanding } from "./landing-frame";
import { Logo } from "./logo";
import { WalletButton } from "./wallet-button";

const SOLANA_NAV = [
  { href: "/holder", key: "holder" },
  { href: "/issuer", key: "issuer" },
  { href: "/proof", key: "proof" },
  { href: "/research", key: "research" },
] as const;

/** The chains, in the order the switch shows them. Solana's pages sit at the root. */
const CHAINS = [
  { key: "solana", label: "Solana", prefix: "", dot: "#14f195" },
  ...EVM_CHAIN_KEYS.map((k) => ({ key: k, label: EVM_CHAINS[k].brand, prefix: EVM_CHAINS[k].prefix, dot: EVM_CHAINS[k].dot })),
];

/** The marketing pages' nav: their own sections, then pricing. */
const LANDING_NAV = [
  { href: "/#product", key: "product" },
  { href: "/#why-solana", key: "why" },
  { href: "/#how-it-works", key: "how" },
  { href: "/#faq", key: "faq" },
  { href: "/pricing", key: "pricing" },
] as const;

const evmNav = (prefix: string) =>
  [
    { href: `${prefix}/holder`, key: "holder" },
    { href: `${prefix}/issuer`, key: "issuer" },
    { href: `${prefix}/kyc`, key: "kyc" },
    { href: "/research", key: "research" },
  ] as const;

/** The same page on another chain, where there is one; otherwise that chain's front page. */
function samePageOn(pathname: string, prefix: string) {
  const here = chainForPath(pathname);
  const page = here ? pathname.slice(here.prefix.length) : pathname;
  const hit = ["/holder", "/issuer", "/kyc"].find((p) => page.startsWith(p));
  return hit ? `${prefix}${hit}` : prefix || "/";
}

const LOCALE_LABEL: Record<string, string> = { en: "EN", "zh-Hans": "简", "zh-Hant": "繁" };

export function SiteHeader() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const evm = chainForPath(pathname);
  const landing = isLanding(pathname);
  const NAV = landing ? LANDING_NAV : evm ? evmNav(evm.prefix) : SOLANA_NAV;
  return (
    <header className={`sticky top-0 z-20 backdrop-blur-sm ${landing ? "bg-canvas/90" : "border-b border-line bg-surface/95"}`}>
      <div className={`mx-auto flex h-14 items-center gap-2 px-4 sm:gap-6 sm:px-6 ${landing ? "max-w-page" : "max-w-6xl"}`}>
        <Link href="/" aria-label="AssetFlow">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 lg:flex" aria-label={t("label")}>
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
                  active ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink"
                }`}
              >
                {t(item.key)}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
          {!landing && <ChainSwitch evm={evm} pathname={pathname} />}
          {!landing && <ClusterBadge evm={evm} />}
          <LocaleSwitch />
          {landing ? (
            <a href={PILOT} className="inline-flex h-8 items-center whitespace-nowrap rounded-full bg-ink px-4 text-[13px] font-medium text-white hover:bg-ink/85" target="_blank" rel="noreferrer">
              {t("pilot")}
            </a>
          ) : evm ? (
            <EvmWalletButton />
          ) : (
            <WalletButton />
          )}
        </div>
      </div>
      <nav className={`flex gap-1 overflow-x-auto px-4 py-2 lg:hidden ${landing ? "" : "border-t border-line"}`} aria-label={t("label")}>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ${
              pathname.startsWith(item.href) ? "bg-surface-2 text-ink" : "text-ink-2"
            }`}
          >
            {t(item.key)}
          </Link>
        ))}
      </nav>
    </header>
  );
}

function ChainSwitch({ evm, pathname }: { evm: EvmChainConfig | null; pathname: string }) {
  const t = useTranslations("nav");
  const menu = useRef<HTMLDetailsElement>(null);
  const current = CHAINS.find((c) => c.key === (evm?.key ?? "solana"))!;
  return (
    <details ref={menu} className="relative">
      <summary
        aria-label={t("chain")}
        className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-line-strong px-2 text-xs font-semibold [&::-webkit-details-marker]:hidden"
      >
        <span className="h-2 w-2 rounded-full" style={{ background: current.dot }} aria-hidden="true" />
        {/* the first word is enough in the button: "Robinhood Chain" crowds the header */}
        <span>{current.label.split(" ")[0]}</span>
        <span aria-hidden="true" className="text-ink-3">
          ▾
        </span>
      </summary>
      <ul className="absolute left-0 z-30 mt-1 w-44 rounded-md border border-line bg-surface p-1 shadow-lg sm:left-auto sm:right-0">
        {CHAINS.map((c) => (
          <li key={c.key}>
            <Link
              href={samePageOn(pathname, c.prefix)}
              aria-current={c.key === current.key ? "true" : undefined}
              onClick={() => menu.current?.removeAttribute("open")}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                c.key === current.key ? "bg-surface-2 font-semibold text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} aria-hidden="true" />
              {c.label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ClusterBadge({ evm }: { evm: EvmChainConfig | null }) {
  const t = useTranslations("nav");
  const solana = { "mainnet-beta": "Mainnet", devnet: "Devnet" }[CLUSTER as string] ?? "Localnet";
  return (
    // .pill sets display outside Tailwind's layers, so the breakpoint lives on a wrapper
    <span className="hidden xl:inline-flex">
      <span className="pill pill-neutral" title={evm ? undefined : t("clusterHint")}>
        {evm ? evm.network : solana}
      </span>
    </span>
  );
}

function LocaleSwitch() {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("nav");
  const [pending, start] = useTransition();
  return (
    <div role="group" aria-label={t("language")} className="flex rounded-md border border-line-strong p-0.5">
      {LOCALES.map((l) => (
        <button
          key={l}
          disabled={pending}
          aria-pressed={locale === l}
          onClick={() =>
            start(async () => {
              await setLocale(l);
              router.refresh();
            })
          }
          className={`h-7 min-w-8 rounded px-2 text-xs font-semibold ${
            locale === l ? "bg-ink text-white" : "text-ink-2 hover:text-ink"
          }`}
        >
          {LOCALE_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
