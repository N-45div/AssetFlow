"use client";

import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { EVM_CHAINS, chainForPath, linksFor, publicClientFor } from "./chains";

/** The EVM chain this page is on (from its path: /base, /arbitrum, /robinhood), its client and its explorer links. */
export function useEvmChain() {
  const pathname = usePathname() ?? "";
  const key = (chainForPath(pathname) ?? EVM_CHAINS.base).key;
  return useMemo(() => {
    const cfg = EVM_CHAINS[key];
    return { cfg, pub: publicClientFor(cfg), links: linksFor(cfg) };
  }, [key]);
}
