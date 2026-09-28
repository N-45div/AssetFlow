"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  type Account,
} from "@solana/spl-token";
import { AssetFlowProgram, type Asset, type InvestorProfile, type Registry } from "./program";
import { PROGRAM_ID } from "./config";

export const program = new AssetFlowProgram(PROGRAM_ID);

export interface AssetView {
  asset: Asset;
  registry: Registry;
  decimals: number;
  supply: bigint;
}

export interface HolderView {
  profile: InvestorProfile | null;
  tokenAccount: PublicKey;
  /** Null until the holder opens an account for this asset. */
  account: Account | null;
}

type Loadable<T> = { data: T | null; loading: boolean; missing: boolean; refresh: () => void };

function useLoad<T>(load: (() => Promise<T | null>) | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!load) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    load()
      .then((value) => {
        if (!live) return;
        setData(value);
        setMissing(value === null);
      })
      .catch(() => live && setMissing(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [load, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { data, loading, missing, refresh };
}

/** The asset, its registry and its mint, read straight from the chain. */
export function useAssetView(mint: PublicKey | null) {
  const { connection } = useConnection();
  const load = useCallback(async (): Promise<AssetView | null> => {
    if (!mint) return null;
    const asset = await program.fetchAsset(connection, mint);
    if (!asset) return null;
    const [registry, mintInfo] = await Promise.all([
      program.fetchRegistry(connection, asset.registry),
      getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID),
    ]);
    if (!registry) return null;
    return { asset, registry, decimals: mintInfo.decimals, supply: mintInfo.supply };
  }, [connection, mint]);
  return useLoad(mint ? load : null);
}

/** One wallet's standing with an asset: its profile and its holding account. */
export function useHolderView(view: AssetView | null, wallet: PublicKey | null) {
  const { connection } = useConnection();
  const load = useCallback(async (): Promise<HolderView | null> => {
    if (!view || !wallet) return null;
    const tokenAccount = getAssociatedTokenAddressSync(view.asset.mint, wallet, false, TOKEN_2022_PROGRAM_ID);
    const [profile, account] = await Promise.all([
      program.fetchInvestor(connection, view.registry.address, wallet),
      getAccount(connection, tokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null),
    ]);
    return { profile, tokenAccount, account };
  }, [connection, view, wallet]);
  return useLoad(view && wallet ? load : null);
}

export function formatUnits(amount: bigint, decimals: number, locale: string) {
  const whole = Number(amount) / 10 ** decimals;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals }).format(whole);
}
