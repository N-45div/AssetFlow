"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getDefaultAccountState,
  getExtensionTypes,
  getMint,
  getPausableConfig,
  getPermanentDelegate,
} from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { PageShell } from "@/components/page-shell";
import { assetFromQuery, PROGRAM_ID } from "@/lib/chain/config";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { TokenAcl, TOKEN_ACL_ID } from "@/lib/chain/program";
import { formatUnits, program } from "@/lib/chain/use-asset";
import { HASHKEY_MAINNET, hashkeyAddressUrl } from "@/lib/evm/hashkey";

interface Check {
  id: string;
  pass: boolean;
  /** The account a reader can open to see it for themselves. */
  evidence: string;
}

interface Proof {
  checks: Check[];
  extensions: string[];
  supply: bigint;
  decimals: number;
}

/**
 * Every guarantee the product makes, read back from the chain rather than
 * asserted: a judge or an investor can open each account and check.
 */
export function ProofView() {
  const t = useTranslations("proof");
  const locale = useLocale();
  const { connection } = useConnection();
  const params = useSearchParams();
  const mint = useMemo(() => assetFromQuery(params.get("asset")), [params]);
  const [proof, setProof] = useState<Proof | null | undefined>(undefined);

  useEffect(() => {
    if (!mint) return;
    let live = true;
    (async (): Promise<Proof | null> => {
      const asset = program.assetAddress(mint);
      const mintConfig = TokenAcl.mintConfig(mint);
      const [info, configInfo, assetAccount] = await Promise.all([
        getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID),
        connection.getAccountInfo(mintConfig),
        program.fetchAsset(connection, mint),
      ]);
      if (!assetAccount) return null;
      const config = configInfo?.owner.equals(TOKEN_ACL_ID) ? decodeMintConfig(configInfo.data) : null;
      const same = (a: PublicKey | null | undefined, b: PublicKey) => !!a && a.equals(b);
      const checks: Check[] = [
        { id: "token2022", pass: true, evidence: mint.toBase58() },
        {
          id: "frozenDefault",
          pass: getDefaultAccountState(info)?.state === AccountState.Frozen,
          evidence: mint.toBase58(),
        },
        { id: "mintAuthority", pass: same(info.mintAuthority, asset), evidence: asset.toBase58() },
        { id: "freezeAuthority", pass: same(info.freezeAuthority, mintConfig), evidence: mintConfig.toBase58() },
        { id: "gate", pass: !!config && config.gatingProgram.equals(PROGRAM_ID), evidence: PROGRAM_ID.toBase58() },
        { id: "configAuthority", pass: !!config && config.freezeAuthority.equals(asset), evidence: mintConfig.toBase58() },
        {
          id: "permissionless",
          pass: !!config && config.thawEnabled && config.freezeEnabled,
          evidence: mintConfig.toBase58(),
        },
        { id: "delegate", pass: same(getPermanentDelegate(info)?.delegate, asset), evidence: asset.toBase58() },
        {
          id: "pause",
          pass: same(getPausableConfig(info)?.authority, asset) && !getPausableConfig(info)?.paused,
          evidence: asset.toBase58(),
        },
      ];
      const extensions = getExtensionTypes(info.tlvData).map((e) => ExtensionType[e]);
      return { checks, extensions, supply: info.supply, decimals: info.decimals };
    })()
      .then((p) => live && setProof(p))
      .catch(() => live && setProof(null));
    return () => {
      live = false;
    };
  }, [connection, mint]);

  if (!mint || proof === null) {
    return (
      <PageShell title={t("title")}>
        <div className="card p-6 text-sm text-ink-2">{t("noAsset")}</div>
      </PageShell>
    );
  }

  const passed = proof?.checks.filter((c) => c.pass).length ?? 0;
  return (
    <PageShell
      title={t("title")}
      subtitle={
        <span>
          {t("lede")}{" "}
          <a className="mono text-accent underline underline-offset-2" href={explorer.address(mint.toBase58())} target="_blank" rel="noreferrer">
            {shortKey(mint.toBase58())}
          </a>
        </span>
      }
    >
      {!proof ? (
        <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <section className="card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{t("checksTitle")}</h2>
              <span className={`pill ${passed === proof.checks.length ? "pill-ok" : "pill-bad"}`}>
                {t("passed", { passed, total: proof.checks.length })}
              </span>
            </div>
            <ul className="mt-3 divide-y divide-line">
              {proof.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-3 py-3 text-sm">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      c.pass ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"
                    }`}
                  >
                    {c.pass ? "✓" : "✕"}
                  </span>
                  <div className="flex-1">
                    <p className="font-medium">{t(`checks.${c.id}.title`)}</p>
                    <p className="text-ink-2">{t(`checks.${c.id}.why`)}</p>
                  </div>
                  <a
                    className="mono shrink-0 text-accent underline underline-offset-2"
                    href={explorer.address(c.evidence)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortKey(c.evidence)}
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <div className="flex flex-col gap-4">
            <section className="card p-5">
              <h2 className="font-semibold">{t("supplyTitle")}</h2>
              <p className="tabular mt-2 text-3xl font-semibold">{formatUnits(proof.supply, proof.decimals, locale)}</p>
              <p className="mt-1 text-sm text-ink-2">{t("supplyHint")}</p>
            </section>
            <section className="card p-5">
              <h2 className="font-semibold">{t("extensionsTitle")}</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {proof.extensions.map((e) => (
                  <li key={e} className="pill pill-neutral mono">
                    {e}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-ink-2">{t("extensionsHint")}</p>
            </section>
            <section className="card p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">{t("hashkeyTitle")}</h2>
                <span className="pill pill-ok">{t("hashkeyStatus")}</span>
              </div>
              <ul className="mt-3 divide-y divide-line text-sm">
                {HASHKEY_MAINNET.contracts.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-ink-2">{t(`hashkeyContracts.${c.key}`)}</span>
                    <a
                      className="mono text-accent underline underline-offset-2"
                      href={hashkeyAddressUrl(c.address)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortKey(c.address, 5)} ↗
                    </a>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-ink-2">{t("hashkeyHint", { date: HASHKEY_MAINNET.deployedAt })}</p>
            </section>
          </div>
        </div>
      )}
    </PageShell>
  );
}

/** Token ACL's MintConfig: discriminator, bump, thaw on, freeze on, mint, freeze authority, gate. */
function decodeMintConfig(data: Buffer) {
  return {
    thawEnabled: data[2] === 1,
    freezeEnabled: data[3] === 1,
    freezeAuthority: new PublicKey(data.subarray(36, 68)),
    gatingProgram: new PublicKey(data.subarray(68, 100)),
  };
}
