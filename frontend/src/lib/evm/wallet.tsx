"use client";

/**
 * Wallets on Base: a Base Account (Coinbase's smart wallet), whatever wallet
 * the browser injects, or, when DEV_WALLET is on, a burner key kept in this
 * browser for testing. All three become a viem wallet client on Base Sepolia.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, custom, http, numberToHex, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEV_WALLET } from "@/lib/chain/config";
import { BASE_CHAIN, BASE_RPC_URL } from "./base";

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

/** Ask the wallet to use Base Sepolia, adding it first if it does not know it. */
async function switchToBaseSepolia(provider: EIP1193Provider) {
  const chainId = numberToHex(BASE_CHAIN.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: BASE_CHAIN.name,
          nativeCurrency: BASE_CHAIN.nativeCurrency,
          rpcUrls: [BASE_RPC_URL],
          blockExplorerUrls: ["https://base-sepolia.blockscout.com"],
        },
      ],
    });
  }
}

async function baseAccountProvider(): Promise<EIP1193Provider> {
  const { createBaseAccountSDK } = await import("@base-org/account/browser");
  return createBaseAccountSDK({ appName: "AssetFlow", appChainIds: [BASE_CHAIN.id] }).getProvider() as unknown as EIP1193Provider;
}

export function EvmWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [kind, setKind] = useState<EvmWalletKind | null>(null);
  const [client, setClient] = useState<WalletClient | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canInject, setCanInject] = useState(false);

  const open = useCallback(async (next: EvmWalletKind, silent: boolean) => {
    if (next === "dev") {
      let key = store.get(DEV_KEY) as `0x${string}` | null;
      if (!key) {
        key = generatePrivateKey();
        store.set(DEV_KEY, key);
      }
      const account = privateKeyToAccount(key);
      return { address: account.address, client: createWalletClient({ account, chain: BASE_CHAIN, transport: http(BASE_RPC_URL) }) };
    }
    const provider = next === "base" ? await baseAccountProvider() : injected();
    if (!provider) throw new Error("No wallet found in this browser.");
    const accounts = (await provider.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" })) as Address[];
    if (!accounts[0]) throw new Error("The wallet shared no account.");
    if (next === "injected") await switchToBaseSepolia(provider);
    return {
      address: accounts[0],
      client: createWalletClient({ account: accounts[0], chain: BASE_CHAIN, transport: custom(provider) }),
    };
  }, []);

  const connect = useCallback(
    async (next: EvmWalletKind) => {
      setConnecting(true);
      setError(null);
      try {
        const w = await open(next, false);
        setAddress(w.address);
        setClient(w.client);
        setKind(next);
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
    setAddress(null);
    setClient(null);
    setKind(null);
    store.set(KIND_KEY, null);
  }, []);

  // Reconnect silently to the wallet used last, if it still shares an account.
  useEffect(() => {
    setCanInject(injected() !== null);
    const last = store.get(KIND_KEY) as EvmWalletKind | null;
    if (!last || (last === "dev" && !DEV_WALLET) || last === "base") return;
    open(last, true)
      .then((w) => {
        setAddress(w.address);
        setClient(w.client);
        setKind(last);
      })
      .catch(() => store.set(KIND_KEY, null));
  }, [open]);

  const value = useMemo(
    () => ({ address, kind, client, connecting, error, canInject, canDev: DEV_WALLET, connect, disconnect }),
    [address, kind, client, connecting, error, canInject, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEvmWallet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useEvmWallet outside EvmWalletProvider");
  return ctx;
}
