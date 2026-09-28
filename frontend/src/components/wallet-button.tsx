"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { CLUSTER, CURRENCY_MINT } from "@/lib/chain/config";
import { waitForConfirmation } from "@/lib/chain/confirm";
import { shortKey } from "@/lib/chain/explorer";
import { useWalletDialog } from "./wallet-dialog";

export function WalletButton({ className = "" }: { className?: string }) {
  const t = useTranslations("wallet");
  const { connection } = useConnection();
  const { publicKey, connecting, disconnect, signTransaction } = useWallet();
  const { open } = useWalletDialog();
  const [menu, setMenu] = useState(false);
  const [funding, setFunding] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [dollars, setDollars] = useState<"idle" | "busy" | "done" | "failed">("idle");
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
          {CLUSTER === "devnet" && (
            <a
              className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2"
              href="https://faucet.solana.com"
              target="_blank"
              rel="noreferrer"
            >
              {t("faucet")} ↗
            </a>
          )}
          {CLUSTER === "localnet" && (
            <button
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
              disabled={funding === "busy"}
              onClick={async () => {
                // A local validator hands out SOL freely; devnet links to its faucet instead.
                setFunding("busy");
                try {
                  const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
                  const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
                  await waitForConfirmation(connection, sig, lastValidBlockHeight);
                  setFunding("done");
                } catch {
                  setFunding("failed");
                }
              }}
            >
              {funding === "busy" ? t("funding") : funding === "done" ? t("funded") : funding === "failed" ? t("fundFailed") : t("fund")}
            </button>
          )}
          {CURRENCY_MINT && CLUSTER !== "mainnet-beta" && signTransaction && (
            <button
              className="w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
              disabled={dollars === "busy"}
              onClick={async () => {
                // The server signs the mint as faucet; the wallet signs as fee payer.
                setDollars("busy");
                try {
                  const res = await fetch("/api/faucet", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ wallet: publicKey.toBase58() }),
                  });
                  if (!res.ok) throw new Error(await res.text());
                  const { transaction, lastValidBlockHeight } = await res.json();
                  const signed = await signTransaction(Transaction.from(Buffer.from(transaction, "base64")));
                  const sig = await connection.sendRawTransaction(signed.serialize());
                  const result = await waitForConfirmation(connection, sig, lastValidBlockHeight);
                  setDollars(result.err ? "failed" : "done");
                } catch {
                  setDollars("failed");
                }
              }}
            >
              {dollars === "busy" ? t("usdcBusy") : dollars === "done" ? t("usdcDone") : dollars === "failed" ? t("usdcFailed") : t("usdc")}
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
