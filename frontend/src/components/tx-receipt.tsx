"use client";

import { useTranslations } from "next-intl";
import { explorer, shortKey } from "@/lib/chain/explorer";
import type { TxState } from "@/lib/chain/use-transaction";

/** One receipt for every transaction: what happened, and where to check it. */
export function TxReceipt({ state, what }: { state: TxState; what: string }) {
  const t = useTranslations("tx");
  const tr = useTranslations("refusal");
  if (state.status === "idle") return null;

  const tone =
    state.status === "confirmed"
      ? "border-ok/30 bg-ok-soft"
      : state.status === "failed"
        ? "border-bad/30 bg-bad-soft"
        : "border-line bg-surface-2";

  return (
    <div className={`mt-4 rounded-md border p-4 text-sm ${tone}`} role="status" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {state.status === "signing" && t("signing", { what })}
          {state.status === "sent" && t("sent", { what })}
          {state.status === "confirmed" && t("confirmed", { what })}
          {state.status === "failed" && t("failed", { what })}
        </p>
        {"signature" in state && state.signature && (
          <a
            className="mono text-accent underline underline-offset-2"
            href={explorer.tx(state.signature)}
            target="_blank"
            rel="noreferrer"
          >
            {shortKey(state.signature, 6)} ↗
          </a>
        )}
      </div>
      {state.status === "failed" && (
        <>
          <p className="mt-2 text-ink">{tr(state.refusal.code)}</p>
          {state.signature && <p className="mt-1 text-ink-2">{t("onChainRefusal")}</p>}
          {state.refusal.logs.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-ink-2">{t("logs")}</summary>
              <pre className="mono mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-surface p-3 text-xs text-ink-2">
                {state.refusal.logs.join("\n")}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
