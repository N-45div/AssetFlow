import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EVM_CHAINS, INVESTOR_SCHEMA, linksFor, type EvmChainKey } from "@/lib/evm/chains";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A chain's page: what AssetFlow is there, where to go, and its contracts on testnet and mainnet. */
export async function EvmHome({ chain }: { chain: EvmChainKey }) {
  const t = await getTranslations("base.home");
  const cfg = EVM_CHAINS[chain];
  const links = linksFor(cfg);
  const vars = { chain: cfg.brand, network: cfg.network };
  const points = ["register", "gate", "kyc"] as const;
  const contracts = [
    { key: "directory", address: cfg.directory, href: links.address(cfg.directory) },
    { key: "testUsd", address: cfg.testUsd, href: links.address(cfg.testUsd) },
    { key: "eas", address: cfg.eas, href: links.address(cfg.eas) },
    {
      key: "schema",
      address: INVESTOR_SCHEMA,
      href: cfg.easscan ? `${cfg.easscan}/schema/view/${INVESTOR_SCHEMA}` : links.address(cfg.eas),
    },
  ] as const;
  const m = cfg.mainnet;
  const mainnet = m
    ? ([
        { key: "directory", address: m.directory },
        { key: "registry", address: m.registry },
        { key: "servicer", address: m.servicer },
        { key: "token", address: m.token },
      ] as const)
    : [];
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <p className="text-sm font-semibold text-accent">{t("eyebrow", vars)}</p>
      <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">{t("title", vars)}</h1>
      <p className="mt-4 max-w-3xl text-lg text-ink-2">{t("lede", vars)}</p>
      {chain === "robinhood" && <p className="mt-3 max-w-3xl text-sm text-ink-3">{t("ownEas")}</p>}
      <div className="mt-6 flex flex-wrap gap-2">
        <Link className="btn btn-primary" href={`${cfg.prefix}/issuer`}>
          {t("issuer")}
        </Link>
        <Link className="btn btn-secondary" href={`${cfg.prefix}/holder`}>
          {t("holder")}
        </Link>
        <Link className="btn btn-secondary" href={`${cfg.prefix}/kyc`}>
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
        <h2 className="font-semibold">{t("contractsTitle", vars)}</h2>
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

      {m && (
        <section className="card mt-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">{t("mainnetTitle", { name: m.name })}</h2>
            <span className="pill pill-ok">{t("mainnetPill")}</span>
          </div>
          <p className="mt-1 text-sm text-ink-2">{t("mainnetLede", { name: m.name })}</p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {mainnet.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{t(`mainnet.${c.key}`)}</span>
                <a className="mono text-accent underline underline-offset-2" href={`${m.explorer}/address/${c.address}`} target="_blank" rel="noreferrer">
                  {short(c.address)} ↗
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
