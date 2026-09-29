"use client";

import { useState } from "react";
import type { Abi, Address } from "viem";
import { useLocale, useTranslations } from "next-intl";
import { TxReceipt } from "@/components/tx-receipt";
import { checkEligibility } from "@/lib/chain/eligibility";
import { shortKey } from "@/lib/chain/explorer";
import { servicedTokenAbi } from "@/lib/evm/abi";
import type { BondView } from "@/lib/evm/use-bond";
import { useEvmTx } from "@/lib/evm/use-evm-tx";
import { useEvmChain } from "@/lib/evm/use-evm-chain";

/** Issue units to a holder the registry admits today; the token itself refuses anyone else. */
export function BaseIssuance({ view, onChange }: { view: BondView; onChange: () => void }) {
  const { links } = useEvmChain();
  const t = useTranslations("issuer.issuance");
  const tb = useTranslations("base.issuer");
  const tx = useEvmTx();
  const locale = useLocale();
  const eligible = view.profiles.filter((p) => checkEligibility(view.registry, p).eligible);
  const [to, setTo] = useState<string>("");
  const [amount, setAmount] = useState("");
  const units = /^\d+$/.test(amount) ? BigInt(amount) : 0n;

  const issue = async () => {
    const r = await tx.run([{ address: view.bond.token, abi: servicedTokenAbi as Abi, functionName: "mint", args: [to as Address, units] }]);
    if (r.status === "confirmed") {
      setAmount("");
      onChange();
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <section className="card p-5">
        <h2 className="font-semibold">{t("title")}</h2>
        <p className="mt-1 text-sm text-ink-2">{tb("issueLede")}</p>
        {view.bond.matured ? (
          <p className="mt-4 text-sm text-warn">{tb("matured")}</p>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-[2fr_1fr]">
            <label>
              <span className="field-label">{t("to")}</span>
              <select className="input mono" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{eligible.length ? t("choose") : t("noneEligible")}</option>
                {eligible.map((p) => (
                  <option key={p.wallet} value={p.wallet}>
                    {shortKey(p.wallet)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t("amount")}</span>
              <input className="input tabular" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          </div>
        )}
        <button className="btn btn-primary mt-4" disabled={tx.busy || !to || units === 0n || view.bond.matured} onClick={issue}>
          {t("submit")}
        </button>
        <p className="mt-3 text-xs text-ink-3">{t("outstanding", { units: new Intl.NumberFormat(locale).format(view.bond.totalSupply) })}</p>
        <TxReceipt state={tx.state} what={t("what")} link={links.tx} />
      </section>
      <section className="card p-5 text-sm">
        <h2 className="font-semibold">{t("rulesTitle")}</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-ink-2">
          <li>{tb("rules.eligible")}</li>
          <li>{tb("rules.everyTransfer")}</li>
          <li>{tb("rules.history")}</li>
        </ul>
      </section>
    </div>
  );
}
