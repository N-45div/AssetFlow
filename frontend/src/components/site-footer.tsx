import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PILOT, REPO } from "@/lib/site";
import { Logo } from "./logo";

export async function SiteFooter() {
  const t = await getTranslations("footer");
  const columns = [
    {
      title: t("product"),
      links: [
        { href: "/issuer", label: t("issuer") },
        { href: "/holder", label: t("holder") },
        { href: "/proof", label: t("proof") },
        { href: "/kyc", label: t("kyc") },
      ],
    },
    {
      title: t("developers"),
      links: [
        { href: REPO, label: t("source") },
        { href: `${REPO}/blob/main/ARCHITECTURE.md`, label: t("architecture") },
        { href: `${REPO}/blob/main/evm/SECURITY.md`, label: t("security") },
        { href: "/research", label: t("research") },
      ],
    },
    {
      title: t("company"),
      links: [
        { href: PILOT, label: t("pilot") },
        { href: "/pricing", label: t("pricing") },
        { href: "/base", label: t("evm") },
      ],
    },
  ];
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-ink-2">{t("tagline")}</p>
        </div>
        {columns.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">{c.title}</p>
            <ul className="mt-3 space-y-2 text-sm">
              {c.links.map((l) => (
                <li key={l.href}>
                  {l.href.startsWith("http") ? (
                    <a className="text-ink-2 hover:text-ink" href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                    </a>
                  ) : (
                    <Link className="text-ink-2 hover:text-ink" href={l.href}>
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-5 text-xs leading-relaxed text-ink-3 sm:px-6">
          <p>{t("line")}</p>
          <p className="mt-1">{t("legal")}</p>
        </div>
      </div>
    </footer>
  );
}
