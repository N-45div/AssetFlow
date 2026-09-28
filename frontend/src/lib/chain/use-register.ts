"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount, type Account } from "@solana/spl-token";
import { checkEligibility } from "./eligibility";
import type { InvestorProfile } from "./program";
import { program, type AssetView } from "./use-asset";

export interface RegisterRow {
  wallet: PublicKey;
  profile: InvestorProfile | null;
  eligible: boolean;
  /** The first failing rule, for the status column. */
  reason: string | null;
  accounts: Account[];
  units: bigint;
  anyActive: boolean;
}

/**
 * The investor register as the chain has it: every profile in the registry,
 * joined with every holder account of the mint. A wallet can appear with an
 * account and no profile (it opened one and was never onboarded).
 */
export function useRegister(view: AssetView | null) {
  const { connection } = useConnection();
  const [rows, setRows] = useState<RegisterRow[] | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!view) return;
    let live = true;
    (async () => {
      const [profiles, raw] = await Promise.all([
        program.fetchInvestors(connection, view.registry.address),
        connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
          filters: [{ memcmp: { offset: 0, bytes: view.asset.mint.toBase58() } }],
        }),
      ]);
      const accounts: Account[] = [];
      for (const r of raw) {
        try {
          accounts.push(unpackAccount(r.pubkey, r.account, TOKEN_2022_PROGRAM_ID));
        } catch {
          // not a token account
        }
      }
      const byWallet = new Map<string, RegisterRow>();
      const row = (wallet: PublicKey): RegisterRow => {
        const key = wallet.toBase58();
        let r = byWallet.get(key);
        if (!r) {
          r = { wallet, profile: null, eligible: false, reason: "profile", accounts: [], units: 0n, anyActive: false };
          byWallet.set(key, r);
        }
        return r;
      };
      for (const p of profiles) {
        const r = row(p.wallet);
        r.profile = p;
      }
      for (const a of accounts) {
        // Vaults the asset itself owns are servicing accounts, not holders.
        if (a.owner.equals(view.asset.address)) continue;
        const r = row(a.owner);
        r.accounts.push(a);
        r.units += a.amount;
        r.anyActive ||= !a.isFrozen;
      }
      for (const r of byWallet.values()) {
        const check = checkEligibility(view.registry, r.profile);
        r.eligible = check.eligible;
        r.reason = check.rules.find((x) => !x.pass && !x.skipped)?.id ?? null;
      }
      if (live) setRows([...byWallet.values()].sort((a, b) => Number(b.units - a.units)));
    })().catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [connection, view, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { rows, refresh };
}

/** Parse a decimal amount into base units; null if it is not a positive amount. */
export function parseUnits(value: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;
  const [, whole, frac = ""] = match;
  if (frac.length > decimals) return null;
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return units > 0n ? units : null;
}
