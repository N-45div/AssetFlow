"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useTransition } from "react";
import { setLocale } from "@/i18n/actions";
import { LOCALES } from "@/i18n/locales";
import { CLUSTER } from "@/lib/chain/config";
import { EVM_CHAINS, EVM_CHAIN_KEYS, chainForPath, type EvmChainConfig } from "@/lib/evm/chains";
import { EvmWalletButton } from "./evm-wallet-button";
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
  const NAV = evm ? evmNav(evm.prefix) : SOLANA_NAV;
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/" aria-label="AssetFlow">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label={t("label")}>
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  active ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink"
                }`}
              >
                {t(item.key)}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <ChainSwitch evm={evm} pathname={pathname} />
          <ClusterBadge evm={evm} />
          <LocaleSwitch />
          {evm ? <EvmWalletButton /> : <WalletButton />}
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-t border-line px-4 py-2 md:hidden" aria-label={t("label")}>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-1 text-sm font-medium ${
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
        <span className="max-w-24 truncate">{current.label}</span>
        <span aria-hidden="true" className="text-ink-3">
          ▾
        </span>
      </summary>
      <ul className="absolute right-0 z-30 mt-1 w-44 rounded-md border border-line bg-surface p-1 shadow-lg">
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
    <span className="pill pill-neutral hidden lg:inline-flex" title={evm ? undefined : t("clusterHint")}>
      {evm ? evm.network : solana}
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
