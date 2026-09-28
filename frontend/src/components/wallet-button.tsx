"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { CLUSTER } from "@/lib/chain/config";
import { shortKey } from "@/lib/chain/explorer";
import { useWalletDialog } from "./wallet-dialog";

export function WalletButton({ className = "" }: { className?: string }) {
  const t = useTranslations("wallet");
  const { connection } = useConnection();
  const { publicKey, connecting, disconnect } = useWallet();
  const { open } = useWalletDialog();
  const [menu, setMenu] = useState(false);
  const [funding, setFunding] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  if (!publicKey) {
    return (
      <button className={`btn btn-primary btn-sm ${className}`} onClick={open} disabled={connecting}>
        {connecting ? t("connecting") : t("connect")}
      </button>
    );
  }
  const address = publicKey.toBase58();
  return (
    <div className="relative" ref={root}>
      <button
        className={`btn btn-secondary btn-sm mono ${className}`}
        aria-expanded={menu}
        data-address={address}
        onClick={() => setMenu((m) => !m)}
      >
        {shortKey(address)}
      </button>
      {menu && (
        <div className="card absolute right-0 top-10 z-30 w-52 p-1 shadow-lg">
          <button
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2"
            onClick={() => {
              void navigator.clipboard.writeText(address);
              setMenu(false);
            }}
          >
            {t("copy")}
          </button>
          {CLUSTER !== "mainnet-beta" && (
            <button
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
              disabled={funding === "busy"}
              onClick={async () => {
                // Test SOL for fees; devnet's faucet rate-limits, so this can fail.
                setFunding("busy");
                try {
                  const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
                  await connection.confirmTransaction(sig, "confirmed");
                  setFunding("done");
                } catch {
                  setFunding("failed");
                }
              }}
            >
              {funding === "busy" ? t("funding") : funding === "done" ? t("funded") : funding === "failed" ? t("fundFailed") : t("fund")}
            </button>
          )}
          <button
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2"
            onClick={() => {
              setMenu(false);
              open();
            }}
          >
            {t("change")}
          </button>
          <button
            className="w-full rounded px-3 py-2 text-left text-sm text-bad hover:bg-bad-soft"
            onClick={() => {
              setMenu(false);
              void disconnect();
            }}
          >
            {t("disconnect")}
          </button>
        </div>
      )}
    </div>
  );
}
