"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useLocale, useTranslations } from "next-intl";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { TransactionInstruction } from "@solana/web3.js";
import { TxReceipt } from "@/components/tx-receipt";
import { PROGRAM_ID } from "@/lib/chain/config";
import { shortKey } from "@/lib/chain/explorer";
import { jurisdictionName } from "@/lib/chain/jurisdictions";
import { TokenAcl } from "@/lib/chain/program";
import { formatUnits, program, type AssetView } from "@/lib/chain/use-asset";
import { parseUnits, type RegisterRow } from "@/lib/chain/use-register";
import { useTransaction } from "@/lib/chain/use-transaction";

export function Issuance({
  view,
  rows,
  onChange,
}: {
  view: AssetView;
  rows: RegisterRow[] | null;
  onChange: () => void;
}) {
  const t = useTranslations("issuer.issuance");
  const locale = useLocale();
  const { publicKey } = useWallet();
  const tx = useTransaction();
  const eligible = rows?.filter((r) => r.eligible) ?? [];
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const recipient = eligible.find((r) => r.wallet.toBase58() === to) ?? null;
  const units = parseUnits(amount, view.decimals);

  const submit = async () => {
    if (!publicKey || !recipient || !units) return;
    const owner = recipient.wallet;
    const account = getAssociatedTokenAddressSync(view.asset.mint, owner, false, TOKEN_2022_PROGRAM_ID);
    const ready = recipient.accounts.some((a) => a.address.equals(account) && !a.isFrozen);
    // An eligible holder's account can be opened and let through the gate by
    // anyone, so issuing to a new holder is still one transaction.
    const setup: TransactionInstruction[] = ready
      ? []
      : [
          createAssociatedTokenAccountIdempotentInstruction(publicKey, account, owner, view.asset.mint, TOKEN_2022_PROGRAM_ID),
          TokenAcl.permissionless(
            "thaw",
            publicKey,
            view.asset.mint,
            account,
            owner,
            PROGRAM_ID,
            program.gateAccounts("thaw", view.asset.mint, view.registry.address, owner),
          ),
        ];
    const result = await tx.run([
      ...setup,
      program.issue(publicKey, view.registry.address, view.asset.mint, account, owner, units),
    ]);
    if (result.status === "confirmed") {
      setAmount("");
      onChange();
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <section className="card p-5">
        <h2 className="font-semibold">{t("title")}</h2>
        <p className="mt-1 text-sm text-ink-2">{t("lede")}</p>
        <label className="mt-5 block">
          <span className="field-label">{t("to")}</span>
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{eligible.length ? t("choose") : t("noneEligible")}</option>
            {eligible.map((r) => (
              <option key={r.wallet.toBase58()} value={r.wallet.toBase58()}>
                {shortKey(r.wallet.toBase58(), 6)}
                {r.profile ? ` · ${jurisdictionName(r.profile.jurisdiction, locale)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-4 block">
          <span className="field-label">{t("amount")}</span>
          <input
            className="input tabular"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000"
            aria-invalid={amount !== "" && !units}
          />
        </label>
        <button className="btn btn-primary mt-5" disabled={tx.busy || !recipient || !units} onClick={submit}>
          {t("submit")}
        </button>
        <TxReceipt state={tx.state} what={t("what")} />
      </section>

      <section className="card p-5 text-sm">
        <h2 className="font-semibold">{t("rulesTitle")}</h2>
        <ul className="mt-3 space-y-2 text-ink-2">
          <li>{t("rules.eligible")}</li>
          <li>{t("rules.recheck")}</li>
          <li>{t("rules.authority")}</li>
        </ul>
        <p className="mt-4 text-ink-3">
          {t("outstanding", { units: formatUnits(view.supply, view.decimals, locale) })}
        </p>
      </section>
    </div>
  );
}
