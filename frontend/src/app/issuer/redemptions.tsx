"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { STATUS_TONE } from "@/components/holder-redemptions";
import { TxReceipt } from "@/components/tx-receipt";
import { PROGRAM_ID } from "@/lib/chain/config";
import { waitForConfirmation } from "@/lib/chain/confirm";
import { Coupons, type Payout, type Terms } from "@/lib/chain/coupons";
import { explorer, shortKey } from "@/lib/chain/explorer";
import { TokenAcl } from "@/lib/chain/program";
import {
  Redemptions,
  accruedInterest,
  maturityDate,
  principal,
  type Maturity,
  type RedemptionRequest,
} from "@/lib/chain/redemptions";
import { formatUnits, program, type AssetView } from "@/lib/chain/use-asset";
import type { RegisterRow } from "@/lib/chain/use-register";
import { useTransaction } from "@/lib/chain/use-transaction";
import { money } from "./coupons";

const coupons = new Coupons(PROGRAM_ID);
const redemptions = new Redemptions(PROGRAM_ID);

type Progress = { holder: string; signature?: string; state: "sent" | "done" | "failed" | "held" };
const PROGRESS_TONE: Record<Progress["state"], string> = {
  sent: "pill-neutral",
  done: "pill-ok",
  failed: "pill-bad",
  held: "pill-warn",
};

/** Every holding of the mint with units in it, as the chain has it now; the asset's own escrow excluded. */
async function readHoldings(connection: Connection, mint: PublicKey, asset: PublicKey) {
  const rows = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  return rows
    .map(({ pubkey, account }) => unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID))
    .filter((a) => a.amount > 0n && !a.owner.equals(asset));
}

export function RedemptionsTab({ view, rows, onChange }: { view: AssetView; rows: RegisterRow[] | null; onChange: () => void }) {
  const t = useTranslations("issuer.redemptions");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey, signAllTransactions, sendTransaction } = useWallet();
  const tx = useTransaction();
  const [what, setWhat] = useState("settle");
  const [terms, setTerms] = useState<Terms | null | undefined>(undefined);
  const [payouts, setPayouts] = useState<(Payout | null)[]>([]);
  const [maturity, setMaturity] = useState<Maturity | null>(null);
  const [requests, setRequests] = useState<RedemptionRequest[]>([]);
  const [currencyProgram, setCurrencyProgram] = useState<PublicKey>(TOKEN_PROGRAM_ID);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [cranking, setCranking] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const mint = view.asset.mint;

  useEffect(() => {
    let live = true;
    (async () => {
      const found = await coupons.fetchTerms(connection, mint);
      if (!live) return;
      if (!found) {
        setTerms(null);
        return;
      }
      const owner = (await connection.getAccountInfo(found.currencyMint))?.owner ?? TOKEN_PROGRAM_ID;
      const [list, m, reqs, cash] = await Promise.all([
        Promise.all(found.periods.map((_, i) => coupons.fetchPayout(connection, mint, i))),
        redemptions.fetchMaturity(connection, mint),
        redemptions.fetchRequests(connection, view.asset.address),
        publicKey
          ? getAccount(connection, getAssociatedTokenAddressSync(found.currencyMint, publicKey, true, owner), "confirmed", owner)
              .then((a) => a.amount)
              .catch(() => 0n)
          : Promise.resolve(null),
      ]);
      if (!live) return;
      setCurrencyProgram(owner);
      setPayouts(list);
      setMaturity(m);
      setRequests(reqs);
      setBalance(cash);
      setTerms(found); // last, so nothing renders from terms alone
    })().catch(() => live && setTerms(null));
    return () => {
      live = false;
    };
  }, [connection, mint, view.asset.address, publicKey, tick]);

  if (terms === undefined) return <div className="card p-6 text-sm text-ink-2">{t("loading")}</div>;
  if (!terms) return <div className="card p-6 text-sm text-ink-2">{t("noTerms")}</div>;

  const cur = (v: bigint) => money(v, terms.currencyDecimals, locale);
  const fmt = (v: bigint) => formatUnits(v, view.decimals, locale);
  const date = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts * 1000);
  const now = Math.floor(Date.now() / 1000);
  const eligibleOf = (holder: PublicKey) => rows?.find((r) => r.wallet.equals(holder))?.eligible ?? false;
  const quote = (r: RedemptionRequest) => principal(terms.facePerUnit, r.units) + accruedInterest(terms, r.units, now);
  const open = requests.filter((r) => r.status === "requested");
  const closed = requests.filter((r) => r.status !== "requested");

  const after = (status: string) => {
    if (status !== "confirmed") return;
    reload();
    onChange();
  };

  const settle = async (r: RedemptionRequest) => {
    if (!publicKey) return;
    setWhat("settle");
    after((await tx.run(redemptions.settleRedemption(publicKey, view.registry.address, mint, r, terms.currencyMint, currencyProgram))).status);
  };
  const reject = async (r: RedemptionRequest) => {
    if (!publicKey) return;
    setWhat("reject");
    after((await tx.run([redemptions.returnRedemption("reject", publicKey, mint, r)])).status);
  };
  const start = async () => {
    if (!publicKey) return;
    setWhat("start");
    after((await tx.run([redemptions.startMaturity(publicKey, mint, terms.currencyMint, currencyProgram, terms.periods.length)])).status);
  };
  const fund = async () => {
    if (!publicKey || !maturity) return;
    setWhat("fund");
    after((await tx.run([redemptions.fundMaturity(publicKey, mint, terms.currencyMint, currencyProgram, maturity.required - maturity.funded)])).status);
  };

  // Redeem every holding, one transaction each, signed together. Anyone may
  // send these; a holder who is not eligible is left as they are.
  const redeemAll = async () => {
    if (!publicKey || !rows) return;
    setCranking(true);
    const out: Progress[] = [];
    const todo: { holder: PublicKey; holding: PublicKey; frozen: boolean }[] = [];
    setProgress([]);
    try {
      // Balances as they are now, not as the console last read them.
      for (const a of await readHoldings(connection, mint, view.asset.address)) {
        if (!eligibleOf(a.owner)) out.push({ holder: a.owner.toBase58(), state: "held" });
        else todo.push({ holder: a.owner, holding: a.address, frozen: a.isFrozen });
      }
      setProgress([...out]);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const txs = todo.map(({ holder, holding, frozen }) =>
        new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(
          // an eligible holder's frozen account goes through the gate first
          ...(frozen
            ? [TokenAcl.permissionless("thaw", publicKey, mint, holding, holder, PROGRAM_ID, program.gateAccounts("thaw", mint, view.registry.address, holder))]
            : []),
          ...redemptions.redeemAtMaturity(publicKey, view.registry.address, mint, terms.currencyMint, currencyProgram, holding, holder),
        ),
      );
      const signed = signAllTransactions && txs.length ? await signAllTransactions(txs) : null;
      for (let i = 0; i < txs.length; i++) {
        const holder = todo[i].holder.toBase58();
        try {
          const signature = signed ? await connection.sendRawTransaction(signed[i].serialize()) : await sendTransaction(txs[i], connection);
          out.push({ holder, signature, state: "sent" });
          setProgress([...out]);
          const result = await waitForConfirmation(connection, signature, lastValidBlockHeight);
          out[out.length - 1] = { holder, signature, state: result.err ? "failed" : "done" };
        } catch {
          out.push({ holder, state: "failed" });
        }
        setProgress([...out]);
      }
    } finally {
      setCranking(false);
      reload();
      onChange();
    }
  };

  const due = maturityDate(terms);
  const committed = payouts.filter((p) => p?.status === "committed").length;
  const ready = now >= due && committed === terms.periods.length;
  const outstanding = rows?.reduce((s, r) => s + r.units, 0n) ?? 0n;
  // Units of holders who are not eligible stay put until compliance clears them.
  const held = rows?.filter((r) => !r.eligible).reduce((s, r) => s + r.units, 0n) ?? 0n;
  const check = (ok: boolean, label: string) => (
    <li className="flex items-center gap-2">
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${ok ? "bg-ok-soft text-ok" : "bg-surface-2 text-ink-3"}`}>
        {ok ? "✓" : "·"}
      </span>
      <span className={ok ? "text-ink-2" : ""}>{label}</span>
    </li>
  );

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <h2 className="font-semibold">{t("requestsTitle")}</h2>
        <p className="mt-1 text-sm text-ink-2">{t("requestsLede")}</p>
        {open.length === 0 ? (
          <p className="mt-4 text-sm text-ink-3">{t("noOpen")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-ink-2">
                <tr>
                  <th className="py-2 pr-4 font-medium">{t("col.holder")}</th>
                  <th className="py-2 pr-4 font-medium">{t("col.units")}</th>
                  <th className="py-2 pr-4 font-medium">{t("col.requested")}</th>
                  <th className="py-2 pr-4 font-medium">{t("col.price")}</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {open.map((r) => {
                  const eligible = eligibleOf(r.holder);
                  return (
                    <tr key={r.address.toBase58()}>
                      <td className="py-2 pr-4">
                        <a className="mono text-accent" href={explorer.address(r.holder.toBase58())} target="_blank" rel="noreferrer">
                          {shortKey(r.holder.toBase58())}
                        </a>
                        {!eligible && <span className="pill pill-bad ml-2">{t("notEligible")}</span>}
                      </td>
                      <td className="tabular py-2 pr-4">{fmt(r.units)}</td>
                      <td className="py-2 pr-4 text-ink-2">{date(r.requestedTs)}</td>
                      <td className="tabular py-2 pr-4">{cur(quote(r))}</td>
                      <td className="py-2">
                        <span className="flex justify-end gap-2">
                          {!maturity && (
                            <button className="btn btn-primary btn-sm" disabled={tx.busy || !eligible || (balance ?? 0n) < quote(r)} onClick={() => settle(r)}>
                              {t("settle", { amount: cur(quote(r)) })}
                            </button>
                          )}
                          <button className="btn btn-secondary btn-sm" disabled={tx.busy} onClick={() => reject(r)}>
                            {t("reject")}
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {balance !== null && <p className="mt-3 text-xs text-ink-3">{t("balance", { balance: cur(balance) })}</p>}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">{t("priceNote")}</p>

        {closed.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-ink-2">{t("history", { n: closed.length })}</summary>
            <ul className="mt-2 divide-y divide-line text-sm">
              {closed.map((r) => (
                <li key={r.address.toBase58()} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="mono">{shortKey(r.holder.toBase58())}</span> · {fmt(r.units)} {t("unitsWord")} · {date(r.closedTs)}
                    {r.status === "settled" && (
                      <span className="text-ink-3">
                        {" "}
                        · {t("paidLine", { principal: cur(r.principal), interest: cur(r.interest) })}
                      </span>
                    )}
                  </span>
                  <span className={`pill ${STATUS_TONE[r.status]}`}>{t(`status.${r.status}`)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">{t("maturityTitle")}</h2>
        {!maturity ? (
          <div className="mt-2 text-sm">
            <p className="text-ink-2">
              {t("maturityLede", { date: date(due), amount: cur(principal(terms.facePerUnit, view.supply)) })}
            </p>
            <ul className="mt-4 space-y-2">
              {check(now >= due, t("checkDate", { date: date(due) }))}
              {check(committed === terms.periods.length, t("checkCoupons", { done: committed, of: terms.periods.length }))}
            </ul>
            {open.length > 0 && <p className="mt-3 text-xs text-ink-3">{t("openAtMaturity", { n: open.length })}</p>}
            <button className="btn btn-primary mt-4" disabled={tx.busy || !ready} onClick={start}>
              {t("start")}
            </button>
          </div>
        ) : (
          <div className="mt-2 text-sm">
            <p className="text-ink-2">{t("startedAt", { date: date(maturity.startedTs) })}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-ink-2">{t("required")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(maturity.required)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("funded")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(maturity.funded)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("paid")}</dt>
                <dd className="tabular text-lg font-semibold">{cur(maturity.paid)}</dd>
              </div>
              <div>
                <dt className="text-ink-2">{t("outstanding")}</dt>
                <dd className="tabular text-lg font-semibold">{fmt(outstanding)}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              {maturity.funded < maturity.required ? (
                <>
                  <button
                    className="btn btn-primary"
                    disabled={tx.busy || balance === null || balance < maturity.required - maturity.funded}
                    onClick={fund}
                  >
                    {t("fund", { amount: cur(maturity.required - maturity.funded) })}
                  </button>
                  {balance !== null && balance < maturity.required - maturity.funded && (
                    <p className="w-full text-xs text-warn">{t("lowBalance", { balance: cur(balance) })}</p>
                  )}
                </>
              ) : outstanding > held ? (
                <button className="btn btn-primary" disabled={cranking || !rows} onClick={redeemAll}>
                  {t("redeemAll")}
                </button>
              ) : (
                <span className="pill pill-ok">{held > 0n ? t("allEligibleRedeemed") : t("allRedeemed")}</span>
              )}
            </div>
            {held > 0n && <p className="mt-3 text-xs text-ink-3">{t("heldNote", { units: fmt(held) })}</p>}
            {open.length > 0 && <p className="mt-3 text-xs text-ink-3">{t("openAtMaturity", { n: open.length })}</p>}
            {progress.length > 0 && (
              <ul className="mt-4 divide-y divide-line">
                {progress.map((p, i) => (
                  <li key={`${p.holder}-${i}`} className="flex items-center justify-between gap-2 py-2">
                    <span className="mono">{shortKey(p.holder)}</span>
                    <span className="flex items-center gap-2">
                      {p.signature && (
                        <a className="mono text-accent" href={explorer.tx(p.signature)} target="_blank" rel="noreferrer">
                          {shortKey(p.signature, 4)} ↗
                        </a>
                      )}
                      <span className={`pill ${PROGRESS_TONE[p.state]}`}>
                        {t(`crank.${p.state}`)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      <TxReceipt state={tx.state} what={t(`what.${what}`)} />
    </div>
  );
}
