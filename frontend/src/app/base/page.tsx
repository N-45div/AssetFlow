import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { BASE, baseExplorer } from "@/lib/evm/base";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default async function BaseHome() {
  const t = await getTranslations("base.home");
  const points = ["register", "gate", "kyc"] as const;
  const contracts = [
    { key: "directory", address: BASE.directory, href: baseExplorer.address(BASE.directory) },
    { key: "testUsd", address: BASE.testUsd, href: baseExplorer.address(BASE.testUsd) },
    { key: "eas", address: BASE.eas, href: baseExplorer.address(BASE.eas) },
    { key: "schema", address: BASE.investorSchema, href: `https://base-sepolia.easscan.org/schema/view/${BASE.investorSchema}` },
  ] as const;
  const mainnet = [
    { key: "directory", address: "0x1C1867cC4899157B8c6fb2D1d351985f73fe125e" },
    { key: "registry", address: "0xbbE819AB63f68b6C39576F0356EB9087fFF5444f" },
    { key: "servicer", address: "0xCc673fD915EE01f2F712A880a51E42EDC9A7d320" },
    { key: "token", address: "0xDABea95f39ef319AE4C775Ca8c8b3c37971Aa977" },
  ] as const;
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <p className="text-sm font-semibold text-accent">{t("eyebrow")}</p>
      <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
      <p className="mt-4 max-w-3xl text-lg text-ink-2">{t("lede")}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link className="btn btn-primary" href="/base/issuer">
          {t("issuer")}
        </Link>
        <Link className="btn btn-secondary" href="/base/holder">
          {t("holder")}
        </Link>
        <Link className="btn btn-secondary" href="/base/kyc">
          {t("kyc")}
        </Link>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {points.map((k) => (
          <section key={k} className="card p-5">
            <h2 className="font-semibold">{t(`points.${k}.title`)}</h2>
            <p className="mt-2 text-sm text-ink-2">{t(`points.${k}.body`)}</p>
          </section>
        ))}
      </div>

      <section className="card mt-4 p-5">
        <h2 className="font-semibold">{t("contractsTitle")}</h2>
        <p className="mt-1 text-sm text-ink-2">{t("contractsLede")}</p>
        <ul className="mt-3 divide-y divide-line text-sm">
          {contracts.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{t(`contracts.${c.key}`)}</span>
              <a className="mono text-accent underline underline-offset-2" href={c.href} target="_blank" rel="noreferrer">
                {short(c.address)} ↗
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="card mt-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{t("mainnetTitle")}</h2>
          <span className="pill pill-ok">{t("mainnetPill")}</span>
        </div>
        <p className="mt-1 text-sm text-ink-2">{t("mainnetLede")}</p>
        <ul className="mt-3 divide-y divide-line text-sm">
          {mainnet.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{t(`mainnet.${c.key}`)}</span>
              <a className="mono text-accent underline underline-offset-2" href={`https://base.blockscout.com/address/${c.address}`} target="_blank" rel="noreferrer">
                {short(c.address)} ↗
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
