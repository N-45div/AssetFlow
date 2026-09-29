"use client";

import { useCallback, useEffect, useState } from "react";
import { basePublic } from "./base";
import type { Address } from "viem";
import { servicedTokenAbi } from "./abi";
import {
  attestationVouches,
  readAttestation,
  readBond,
  readPayments,
  readProfiles,
  readRegistry,
  readRequests,
  type EvmBond,
  type EvmPayment,
  type EvmProfile,
  type EvmRegistry,
  type EvmRequest,
} from "./assetflow";

export interface BondView {
  bond: EvmBond;
  registry: EvmRegistry;
  /** Every listed investor and every wallet that ever held units. */
  profiles: EvmProfile[];
  payments: EvmPayment[];
  requests: EvmRequest[];
  /** Units and locked units per wallet (lowercase address). */
  units: Record<string, { units: bigint; locked: bigint }>;
  /** For profiles claimed from an attestation: whether it still vouches for them. */
  attested: Record<string, boolean>;
}

/** One bond on Base, everything the console shows about it, and a way to read it again. */
export function useBond(servicer: Address | null) {
  const [view, setView] = useState<BondView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!servicer) return;
    let live = true;
    (async () => {
      const bond = await readBond(servicer);
      const [registry, listed, payments, requests] = await Promise.all([
        readRegistry(bond.registry),
        readProfiles(bond.registry),
        readPayments(bond),
        readRequests(servicer),
      ]);
      const known = new Set(listed.map((p) => p.wallet.toLowerCase()));
      const unlisted = bond.holders.filter((h) => !known.has(h.toLowerCase()));
      const profiles = [...listed, ...(await readProfiles(bond.registry, unlisted))];
      const wallets = profiles.map((p) => p.wallet);
      const balances = wallets.length
        ? await basePublic.multicall({
            allowFailure: false,
            contracts: wallets.flatMap((w) => [
              { address: bond.token, abi: servicedTokenAbi, functionName: "balanceOf", args: [w] },
              { address: bond.token, abi: servicedTokenAbi, functionName: "locked", args: [w] },
            ]),
          })
        : [];
      const units: BondView["units"] = {};
      wallets.forEach((w, i) => (units[w.toLowerCase()] = { units: balances[2 * i] as bigint, locked: balances[2 * i + 1] as bigint }));
      const attested: BondView["attested"] = {};
      await Promise.all(
        profiles
          .filter((p) => p.attestedFrom)
          .map(async (p) => {
            const a = await readAttestation(p.attestedFrom!);
            attested[p.wallet.toLowerCase()] = !!a && a.recipient.toLowerCase() === p.wallet.toLowerCase() && attestationVouches(a, registry);
          }),
      );
      if (live) setView({ bond, registry, profiles, payments, requests, units, attested });
    })().catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [servicer, tick]);

  return { view, error, refresh };
}
