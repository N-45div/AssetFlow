"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { DEV_WALLET, rpcEndpoint } from "@/lib/chain/config";
import { DevWalletAdapter } from "@/lib/chain/dev-wallet";
import { WalletDialogProvider } from "./wallet-dialog";

export function Providers({ children }: { children: ReactNode }) {
  // Phantom, Solflare, Backpack and every other Wallet Standard wallet are
  // discovered on their own. The dev wallet exists only on a local validator,
  // where no real wallet points by default.
  const wallets = useMemo(() => (DEV_WALLET ? [new DevWalletAdapter()] : []), []);
  const endpoint = useMemo(() => rpcEndpoint(), []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletDialogProvider>{children}</WalletDialogProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
