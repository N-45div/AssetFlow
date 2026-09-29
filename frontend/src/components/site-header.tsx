"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocale } from "@/i18n/actions";
import { LOCALES } from "@/i18n/locales";
import { CLUSTER } from "@/lib/chain/config";
import { EvmWalletButton } from "./evm-wallet-button";
import { Logo } from "./logo";
import { WalletButton } from "./wallet-button";

const SOLANA_NAV = [
  { href: "/holder", key: "holder" },
  { href: "/issuer", key: "issuer" },
  { href: "/proof", key: "proof" },
  { href: "/research", key: "research" },
] as const;

const BASE_NAV = [
  { href: "/base/holder", key: "holder" },
  { href: "/base/issuer", key: "issuer" },
  { href: "/base/kyc", key: "kyc" },
  { href: "/research", key: "research" },
] as const;

/** The same page on the other chain, where there is one. */
function otherChain(pathname: string, toBase: boolean) {
  const pages = ["/holder", "/issuer", "/kyc"];
  if (toBase) return pages.find((p) => pathname.startsWith(p)) ? `/base${pathname}` : "/base";
  const page = pathname.replace(/^\/base/, "");
  return pages.find((p) => page.startsWith(p)) ? page : "/";
}

const LOCALE_LABEL: Record<string, string> = { en: "EN", "zh-Hans": "简", "zh-Hant": "繁" };

export function SiteHeader() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const onBase = pathname.startsWith("/base");
  const NAV = onBase ? BASE_NAV : SOLANA_NAV;
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
          <ChainSwitch onBase={onBase} pathname={pathname} />
          <ClusterBadge onBase={onBase} />
          <LocaleSwitch />
          {onBase ? <EvmWalletButton /> : <WalletButton />}
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

function ChainSwitch({ onBase, pathname }: { onBase: boolean; pathname: string }) {
  const t = useTranslations("nav");
  const tab = (base: boolean, label: string) => (
    <Link
      href={otherChain(pathname, base)}
      aria-current={onBase === base ? "true" : undefined}
      className={`flex h-7 items-center rounded px-2 text-xs font-semibold ${onBase === base ? "bg-ink text-white" : "text-ink-2 hover:text-ink"}`}
    >
      {label}
    </Link>
  );
  return (
    <div role="group" aria-label={t("chain")} className="hidden rounded-md border border-line-strong p-0.5 sm:flex">
      {tab(false, "Solana")}
      {tab(true, "Base")}
    </div>
  );
}

function ClusterBadge({ onBase }: { onBase: boolean }) {
  const t = useTranslations("nav");
  return (
    <span className="pill pill-neutral hidden lg:inline-flex" title={t("clusterHint")}>
      <span className={`h-1.5 w-1.5 rounded-full ${onBase ? "bg-[#0052ff]" : "bg-[#14f195]"}`} aria-hidden="true" />
      {onBase ? "Base Sepolia" : CLUSTER === "mainnet-beta" ? "Mainnet" : CLUSTER === "devnet" ? "Devnet" : "Localnet"}
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
