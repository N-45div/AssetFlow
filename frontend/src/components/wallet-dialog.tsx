"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useTranslations } from "next-intl";

const DialogContext = createContext<{ open: () => void }>({ open: () => {} });

export const useWalletDialog = () => useContext(DialogContext);

/** A plain wallet picker, styled like the rest of the app. */
export function WalletDialogProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("wallet");
  const { wallets, select } = useWallet();
  const [isOpen, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (isOpen && !el.open) el.showModal();
    if (!isOpen && el.open) el.close();
  }, [isOpen]);

  const open = useCallback(() => setOpen(true), []);
  const available = wallets.filter(
    (w) =>
      w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
  );

  return (
    <DialogContext.Provider value={{ open }}>
      {children}
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        className="m-auto w-[min(420px,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/30"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{t("choose")}</h2>
          <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)}>
            {t("close")}
          </button>
        </div>
        <ul className="p-2">
          {available.map((w) => (
            <li key={w.adapter.name}>
              <button
                className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left hover:bg-surface-2"
                onClick={() => {
                  select(w.adapter.name);
                  setOpen(false);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.adapter.icon} alt="" width={28} height={28} className="rounded" />
                <span className="font-medium">{w.adapter.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {available.length === 0 && (
          <p className="px-5 pb-5 text-sm text-ink-2">{t("none")}</p>
        )}
      </dialog>
    </DialogContext.Provider>
  );
}
