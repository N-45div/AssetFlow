"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, type Account } from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { PROGRAM_ID } from "@/lib/chain/config";
import { jurisdictionName } from "@/lib/chain/jurisdictions";
import {
  Kyc,
  attestationAddress,
  attestationValid,
  fetchAttestation,
  fetchCredentialName,
  type AttestedProfile,
  type InvestorAttestation,
  type KycSource,
} from "@/lib/chain/kyc";
import { TokenAcl, type InvestorProfile, type Registry } from "@/lib/chain/program";
import { program, type AssetView } from "@/lib/chain/use-asset";
import { useTransaction } from "@/lib/chain/use-transaction";

const kyc = new Kyc(PROGRAM_ID);

interface Loaded {
  source: KycSource;
  provider: string;
  attestation: InvestorAttestation | null;
  marker: AttestedProfile | null;
}

/** Whether the attested fields pass the registry's own policy. */
function passes(registry: Registry, a: InvestorAttestation) {
  return (
    registry.jurisdictions.includes(a.jurisdiction) &&
    a.tier >= registry.minTier &&
    (!registry.requireAccredited || a.accredited)
  );
}

interface Props {
  view: AssetView;
  wallet: PublicKey;
  profile: InvestorProfile | null;
  account: Account | null;
  tokenAccount: PublicKey;
  onChange: () => void;
}

/** KYC once: onboard into this registry by presenting an attestation from the provider it trusts. */
export function HolderKyc({ view, wallet, profile, account, tokenAccount, onChange }: Props) {
  const t = useTranslations("holder.kyc");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const registry = view.registry;

  useEffect(() => {
    let live = true;
    (async () => {
      const source = await kyc.fetchSource(connection, registry.address);
      if (!source) return null;
      const [provider, attestation, markers] = await Promise.all([
        fetchCredentialName(connection, source.credential),
        fetchAttestation(connection, attestationAddress(source.credential, source.schema, wallet)),
        kyc.fetchAttested(connection, registry.address),
      ]);
      return { source, provider: provider ?? t("aProvider"), attestation, marker: markers.get(wallet.toBase58()) ?? null };
    })()
      .then((l) => live && setLoaded(l))
      .catch(() => live && setLoaded(null));
    return () => {
      live = false;
    };
  }, [connection, registry.address, wallet, tick, t]);

  if (!loaded) return null;
  const { attestation, marker, provider } = loaded;
  const valid = attestation && attestationValid(attestation);
  const claimed = !!(attestation && marker?.attestation.equals(attestation.address) && profile?.approved);

  // Claiming, opening the account and asking the gate to activate it: one transaction.
  const onboard = async () => {
    if (!publicKey || !attestation) return;
    const letIn = passes(registry, attestation) && !profile?.frozen && (!account || account.isFrozen);
    const r = await tx.run([
      kyc.claimProfile(publicKey, registry.address, attestation.address, wallet),
      ...(letIn
        ? [
            createAssociatedTokenAccountIdempotentInstruction(publicKey, tokenAccount, wallet, view.asset.mint, TOKEN_2022_PROGRAM_ID),
            TokenAcl.permissionless("thaw", publicKey, view.asset.mint, tokenAccount, wallet, PROGRAM_ID, program.gateAccounts("thaw", view.asset.mint, registry.address, wallet)),
          ]
        : []),
    ]);
    if (r.status === "confirmed") {
      reload();
      onChange();
    }
  };

  return (
    <div className="mt-4 rounded-md border border-line p-4 text-sm">
      <p className="font-medium">{t("title")}</p>
      {claimed ? (
        <p className="mt-1 text-ink-2">
          {t("claimed", {
            provider,
            jurisdiction: jurisdictionName(attestation!.jurisdiction, locale),
            tier: attestation!.tier,
          })}
        </p>
      ) : valid ? (
        <>
          <p className="mt-1 text-ink-2">
            {t("ready", { provider, jurisdiction: jurisdictionName(attestation!.jurisdiction, locale), tier: attestation!.tier })}
          </p>
          {!passes(registry, attestation!) && <p className="mt-2 text-warn">{t("policyWarning")}</p>}
          <button className="btn btn-primary mt-3" disabled={tx.busy || !publicKey?.equals(wallet)} onClick={onboard}>
            {t("onboard")}
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-ink-2">{t(marker ? "revoked" : "none", { provider })}</p>
          <Link className="btn btn-secondary mt-3" href={`/kyc?asset=${view.asset.mint.toBase58()}`}>
            {t("getVerified", { provider })}
          </Link>
        </>
      )}
      <TxReceipt state={tx.state} what={t("what")} />
    </div>
  );
}
