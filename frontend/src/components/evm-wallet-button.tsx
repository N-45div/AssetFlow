"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { shortKey } from "@/lib/chain/explorer";
import { testUSDAbi } from "@/lib/evm/abi";
import { BASE, basePublic } from "@/lib/evm/base";
import { useEvmWallet, type EvmWalletKind } from "@/lib/evm/wallet";

const FAUCET = "https://portal.cdp.coinbase.com/products/faucet";

/** Connect a wallet on Base, and the test-dollar and faucet shortcuts for the testnet demo. */
export function EvmWalletButton({ className = "" }: { className?: string }) {
  const t = useTranslations("wallet");
  const tb = useTranslations("base.wallet");
  const { address, kind, client, connecting, error, canInject, canDev, connect, disconnect } = useEvmWallet();
  const [menu, setMenu] = useState(false);
  const [dollars, setDollars] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [menu]);

  const item = "w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50";

  if (!address) {
    const options: { kind: EvmWalletKind; label: string; show: boolean }[] = [
      { kind: "base", label: tb("baseAccount"), show: true },
      { kind: "injected", label: tb("browser"), show: canInject },
      { kind: "dev", label: tb("dev"), show: canDev },
    ];
    return (
      <div className="relative" ref={root}>
        <button className={`btn btn-primary btn-sm ${className}`} disabled={connecting} onClick={() => setMenu((m) => !m)}>
          {connecting ? t("connecting") : t("connect")}
        </button>
        {menu && (
          <div className="card absolute right-0 top-10 z-30 w-56 p-1 shadow-lg">
            {options
              .filter((o) => o.show)
              .map((o) => (
                <button
                  key={o.kind}
                  className={item}
                  onClick={() => {
                    setMenu(false);
                    void connect(o.kind);
                  }}
                >
                  {o.label}
                </button>
              ))}
          </div>
        )}
        {error && <p className="absolute right-0 top-10 z-20 mt-1 w-56 text-xs text-bad">{error}</p>}
      </div>
    );
  }

  const drip = async () => {
    if (!client) return;
    setDollars("busy");
    try {
      const hash = await client.writeContract({ address: BASE.testUsd, abi: testUSDAbi, functionName: "drip", account: client.account ?? address, chain: client.chain });
      const r = await basePublic.waitForTransactionReceipt({ hash });
      setDollars(r.status === "success" ? "done" : "failed");
    } catch {
      setDollars("failed");
    }
  };

  return (
    <div className="relative" ref={root}>
      <button className={`btn btn-secondary btn-sm mono ${className}`} aria-expanded={menu} data-evm-address={address} onClick={() => setMenu((m) => !m)}>
        {shortKey(address)}
      </button>
      {menu && (
        <div className="card absolute right-0 top-10 z-30 w-60 p-1 shadow-lg">
          <p className="px-3 py-1 text-xs text-ink-3">{tb(`via.${kind}`)}</p>
          <button className={item} onClick={() => void navigator.clipboard.writeText(address)}>
            {t("copy")}
          </button>
          <a className={`${item} block`} href={FAUCET} target="_blank" rel="noreferrer">
            {tb("gas")} ↗
          </a>
          <button className={item} disabled={dollars === "busy"} onClick={drip}>
            {dollars === "busy" ? t("usdcBusy") : dollars === "done" ? tb("usdDone") : dollars === "failed" ? t("usdcFailed") : tb("usd")}
          </button>
          <button
            className="w-full rounded px-3 py-2 text-left text-sm text-bad hover:bg-bad-soft"
            onClick={() => {
              setMenu(false);
              disconnect();
            }}
          >
            {t("disconnect")}
          </button>
        </div>
      )}
    </div>
  );
}
