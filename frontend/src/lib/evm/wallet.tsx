"use client";

/**
 * Wallets on AssetFlow's EVM chains: a Base Account (Coinbase's smart wallet),
 * whatever wallet the browser injects, or, when DEV_WALLET is on, a burner key
 * kept in this browser for testing. Whichever it is becomes a viem wallet
 * client for the chain the page is on; a browser wallet is asked to switch
 * networks as you move between chains.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  createWalletClient,
  custom,
  http,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type LocalAccount,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEV_WALLET } from "@/lib/chain/config";
import { EVM_CHAINS, EVM_CHAIN_KEYS, chainForPath, type EvmChainConfig } from "./chains";

export type EvmWalletKind = "base" | "injected" | "dev";

interface EvmWalletState {
  address: Address | null;
  kind: EvmWalletKind | null;
  client: WalletClient | null;
  connecting: boolean;
  error: string | null;
  canInject: boolean;
  canDev: boolean;
  connect: (kind: EvmWalletKind) => Promise<void>;
  disconnect: () => void;
}

/** What a connection is made of; the client is rebuilt from it for each chain. */
type Source = { kind: "dev"; account: LocalAccount } | { kind: "base" | "injected"; address: Address; provider: EIP1193Provider };

const Ctx = createContext<EvmWalletState | null>(null);
const KIND_KEY = "assetflow-evm-wallet-kind";
const DEV_KEY = "assetflow-dev-evm-wallet";

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // storage unavailable: the wallet still works for this visit
    }
  },
};

function injected(): EIP1193Provider | null {
  return typeof window !== "undefined" ? ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null) : null;
}

/** Ask the wallet to use this chain, adding it first if it does not know it. */
async function switchTo(provider: EIP1193Provider, cfg: EvmChainConfig) {
  const chainId = numberToHex(cfg.chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId, chainName: cfg.network, nativeCurrency: cfg.chain.nativeCurrency, rpcUrls: [cfg.rpcUrl], blockExplorerUrls: [cfg.explorer] }],
    });
  }
}

async function baseAccountProvider(): Promise<EIP1193Provider> {
  // the browser build: the package's node entry pulls in server-only dependencies
  const { createBaseAccountSDK } = await import("@base-org/account/browser");
  return createBaseAccountSDK({
    appName: "AssetFlow",
    appChainIds: EVM_CHAIN_KEYS.map((k) => EVM_CHAINS[k].chain.id),
  }).getProvider() as unknown as EIP1193Provider;
}

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const cfg = chainForPath(pathname) ?? EVM_CHAINS.base;
  const [source, setSource] = useState<Source | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canInject, setCanInject] = useState(false);

  const open = useCallback(async (next: EvmWalletKind, silent: boolean): Promise<Source> => {
    if (next === "dev") {
      let key = store.get(DEV_KEY) as `0x${string}` | null;
      if (!key) {
        key = generatePrivateKey();
        store.set(DEV_KEY, key);
      }
      return { kind: "dev", account: privateKeyToAccount(key) };
    }
    const provider = next === "base" ? await baseAccountProvider() : injected();
    if (!provider) throw new Error("No wallet found in this browser.");
    const accounts = (await provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" })) as Address[];
    if (!accounts[0]) throw new Error("The wallet shared no account.");
    return { kind: next, address: accounts[0], provider };
  }, []);

  const connect = useCallback(
    async (next: EvmWalletKind) => {
      setConnecting(true);
      setError(null);
      try {
        setSource(await open(next, false));
        store.set(KIND_KEY, next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setConnecting(false);
      }
    },
    [open],
  );

  const disconnect = useCallback(() => {
    setSource(null);
    store.set(KIND_KEY, null);
  }, []);

  // Reconnect silently to the wallet used last, if it still shares an account.
  useEffect(() => {
    setCanInject(injected() !== null);
    const last = store.get(KIND_KEY) as EvmWalletKind | null;
    if (!last || (last === "dev" && !DEV_WALLET) || last === "base") return;
    open(last, true)
      .then(setSource)
      .catch(() => store.set(KIND_KEY, null));
  }, [open]);

  // A browser wallet or Base Account follows the page's chain (where it supports it).
  useEffect(() => {
    if (source && source.kind !== "dev") switchTo(source.provider, cfg).catch(() => undefined);
  }, [source, cfg]);

  const client = useMemo(() => {
    if (!source) return null;
    return source.kind === "dev"
      ? createWalletClient({ account: source.account, chain: cfg.chain, transport: http(cfg.rpcUrl) })
      : createWalletClient({ account: source.address, chain: cfg.chain, transport: custom(source.provider) });
  }, [source, cfg]);
  const address = source ? (source.kind === "dev" ? source.account.address : source.address) : null;

  const value = useMemo(
    () => ({ address, kind: source?.kind ?? null, client, connecting, error, canInject, canDev: DEV_WALLET, connect, disconnect }),
    [address, source, client, connecting, error, canInject, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEvmWallet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useEvmWallet outside EvmWalletProvider");
  return ctx;
}
