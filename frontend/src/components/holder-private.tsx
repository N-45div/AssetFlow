"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useLocale, useTranslations } from "next-intl";
import { money } from "@/app/issuer/coupons";
import { TxReceipt } from "@/components/tx-receipt";
import { PROGRAM_ID } from "@/lib/chain/config";
import { Coupons, type Payout, type Terms } from "@/lib/chain/coupons";
import { shortKey } from "@/lib/chain/explorer";
import {
  PrivateHoldings,
  entitledAt,
  firstOpenPeriod,
  type PrivateExit,
  type PrivateHolding,
  type PrivateLedger,
  type PrivatePool,
} from "@/lib/chain/private";
import { formatUnits, type AssetView } from "@/lib/chain/use-asset";
import { parseUnits } from "@/lib/chain/use-register";
import { useRollup, useRollupTransaction } from "@/lib/chain/use-rollup";
import { useTransaction } from "@/lib/chain/use-transaction";

const holdings = new PrivateHoldings(PROGRAM_ID);
const coupons = new Coupons(PROGRAM_ID);

interface OnSolana {
  pool: PrivatePool;
  ledger: PrivateLedger | null;
  /** Whether the holding is in the rollup; null when there is none. */
  delegated: boolean | null;
  exit: PrivateExit | null;
  terms: Terms | null;
  payouts: (Payout | null)[];
  /** The first period whose register is not fixed yet. */
  open: number;
  currencyProgram: PublicKey;
}

/**
 * A holder's private holding: units parked in MagicBlock's private rollup,
 * where only the holder, the issuer, compliance and the auditor can see the
 * balance and the moves. Deposits and releases are public token movements on
 * Solana; everything in between is not.
 */
export function HolderPrivate({
  view,
  wallet,
  units,
  tokenAccount,
  eligible,
  onChange,
}: {
  view: AssetView;
  wallet: PublicKey;
  units: bigint;
  tokenAccount: PublicKey;
  eligible: boolean;
  onChange: () => void;
}) {
  const t = useTranslations("holder.private");
  const locale = useLocale();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const solana = useTransaction();
  const { rollup, signIn, signingIn, failed, canSign } = useRollup();
  const inRollup = useRollupTransaction(rollup);
  const [chain, setChain] = useState<OnSolana | null | undefined>(undefined);
  const [holding, setHolding] = useState<PrivateHolding | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [settling, setSettling] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [outUnits, setOutUnits] = useState("");
  const [outCash, setOutCash] = useState("");
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const mint = view.asset.mint;
  const registry = view.registry.address;
  const mintAddress = mint.toBase58();
  const walletAddress = wallet.toBase58();
  const mine = !!publicKey && publicKey.equals(wallet);

  useEffect(() => {
    let live = true;
    (async (): Promise<OnSolana | null> => {
      const m = new PublicKey(mintAddress);
      const w = new PublicKey(walletAddress);
      const pool = await holdings.fetchPool(connection, m);
      if (!pool) return null;
      const [ledger, delegated, exit, terms] = await Promise.all([
        holdings.fetchLedger(connection, m, w),
        holdings.holdingDelegated(connection, m, w),
        holdings.fetchExit(connection, m, w),
        coupons.fetchTerms(connection, m),
      ]);
      const periods = terms?.periods.length ?? 0;
      const [payouts, open, currencyProgram] = await Promise.all([
        Promise.all(Array.from({ length: periods }, (_, i) => coupons.fetchPayout(connection, m, i))),
        firstOpenPeriod(connection, holdings, m, periods),
        terms ? connection.getAccountInfo(terms.currencyMint).then((i) => i?.owner ?? TOKEN_PROGRAM_ID) : TOKEN_PROGRAM_ID,
      ]);
      return { pool, ledger, delegated, exit, terms, payouts, open, currencyProgram };
    })()
      .then((found) => live && setChain(found))
      .catch(() => live && setChain(null));
    return () => {
      live = false;
    };
  }, [connection, mintAddress, walletAddress, tick]);

  useEffect(() => {
    if (!rollup || !chain?.delegated) return;
    let live = true;
    holdings
      .fetchHolding(rollup, new PublicKey(mintAddress), new PublicKey(walletAddress))
      .then((h) => live && setHolding(h))
      .catch(() => live && setHolding(null));
    return () => {
      live = false;
    };
  }, [rollup, chain?.delegated, mintAddress, walletAddress, tick]);

  // After a withdrawal the exit ticket settles on Solana a few seconds later.
  useEffect(() => {
    if (!settling) return;
    if (chain?.exit && !chain.exit.delegated) {
      queueMicrotask(() => setSettling(false));
      return;
    }
    const id = setTimeout(refresh, 2_000);
    return () => clearTimeout(id);
  }, [settling, chain, refresh]);

  if (!chain) return null;
  const { pool, ledger, delegated, exit, terms, payouts, open, currencyProgram } = chain;
  const currencyDecimals = terms?.currencyDecimals ?? 6;
  const unitsOf = (v: bigint) => formatUnits(v, view.decimals, locale);
  const cash = (v: bigint) => money(v, currencyDecimals, locale);
  const auditor = pool.auditor.equals(PublicKey.default) ? null : pool.auditor;

  /** Registers fixed since this ledger last moved: recorded first, by anyone, in the same transaction. */
  const recordCuts = (from: number): TransactionInstruction[] =>
    Array.from({ length: Math.max(0, open - from) }, (_, i) => holdings.checkpointLedger(mint, wallet, from + i));
  const after = async (r: { status: string }) => {
    if (r.status === "confirmed") {
      refresh();
      onChange();
    }
    return r.status === "confirmed";
  };
  const currencyAccount = terms ? getAssociatedTokenAddressSync(terms.currencyMint, wallet, false, currencyProgram) : null;

  const openAccount = async () => {
    await after(
      await solana.run([holdings.open(wallet, registry, mint, open), holdings.delegateHolding(wallet, mint), holdings.delegateExit(wallet, mint)]),
    );
  };

  const protect = async () => after(await inRollup.run([holdings.protect(registry, mint, wallet)]));
  const credit = async () => after(await inRollup.run([holdings.credit(mint, wallet, ledger?.nextPeriod ?? open)]));
  const record = async () => ledger && after(await solana.run(recordCuts(ledger.nextPeriod)));

  const deposit = async () => {
    const n = parseUnits(depositAmount, view.decimals);
    if (!ledger || !n) return;
    const ok = await after(
      await solana.run([...recordCuts(ledger.nextPeriod), holdings.deposit(wallet, registry, mint, tokenAccount, open, n)]),
    );
    if (ok) setDepositAmount("");
  };

  const send = async () => {
    const n = parseUnits(sendAmount, view.decimals);
    let to: PublicKey;
    try {
      to = new PublicKey(recipient.trim());
    } catch {
      return;
    }
    if (!ledger || !n) return;
    const ok = await after(await inRollup.run([holdings.transfer(wallet, registry, mint, to, ledger.nextPeriod, n)]));
    if (ok) setSendAmount("");
  };

  const takeOut = async () => {
    const u = outUnits ? parseUnits(outUnits, view.decimals) : 0n;
    const c = outCash ? parseUnits(outCash, currencyDecimals) : 0n;
    if (!ledger || u === null || c === null || (u === 0n && c === 0n)) return;
    const ok = await after(await inRollup.run([holdings.withdraw(wallet, mint, ledger.nextPeriod, u, c)]));
    if (ok) {
      setOutUnits("");
      setOutCash("");
      setSettling(true);
    }
  };

  // Pay out a settled exit ticket and put it back in the rollup for the next one.
  const release = async () => {
    if (!ledger || !terms || !currencyAccount) return;
    await after(
      await solana.run([
        ...recordCuts(ledger.nextPeriod),
        createAssociatedTokenAccountIdempotentInstruction(wallet, currencyAccount, wallet, terms.currencyMint, currencyProgram),
        holdings.release(registry, mint, wallet, open, tokenAccount, terms.currencyMint, currencyProgram, currencyAccount),
        holdings.delegateExit(wallet, mint),
      ]),
    );
  };

  // Coupons paid to the pool that this holding had units for and has not credited.
  const claimable =
    holding && ledger
      ? payouts
          .map((p, i) => (p?.privatePaid && !(holding.claimed & (1 << i)) && (entitledAt(holding, ledger, i) ?? 0n) > 0n ? i : -1))
          .filter((i) => i >= 0)
      : [];
  const claim = async () => {
    if (!ledger || claimable.length === 0) return;
    await after(await inRollup.run(claimable.map((p) => holdings.claim(mint, wallet, p, ledger.nextPeriod))));
  };

  const requestExit = async () => after(await solana.run([holdings.requestExit(wallet, mint)]));
  const recover = async () => {
    if (!ledger || !terms || !currencyAccount) return;
    await after(
      await solana.run([
        ...recordCuts(ledger.nextPeriod),
        createAssociatedTokenAccountIdempotentInstruction(wallet, currencyAccount, wallet, terms.currencyMint, currencyProgram),
        holdings.recover(registry, mint, wallet, open, tokenAccount, terms.currencyMint, currencyProgram, currencyAccount),
      ]),
    );
  };
  const returnToRollup = async () => after(await solana.run([holdings.delegateHolding(wallet, mint)]));

  const pendingCredit = holding && ledger ? ledger.deposited - holding.credited : 0n;
  const exitPending = !!exit && !!ledger && !exit.delegated && (exit.withdrawn > ledger.released || exit.cashWithdrawn > ledger.cashReleased);
  const exitIdle = !!exit && !exit.delegated && !exitPending;
  const unrecorded = !!ledger && ledger.nextPeriod < open;

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t("title")}</h2>
        {holding?.hold && <span className="pill pill-warn">{t("onHold")}</span>}
      </div>
      <p className="mt-1 text-sm text-ink-2">{auditor ? t("ledeAuditor", { auditor: shortKey(auditor.toBase58()) }) : t("lede")}</p>

      {!ledger ? (
        <div className="mt-4">
          <button className="btn btn-primary" disabled={!mine || !eligible || solana.busy} onClick={openAccount}>
            {t("open")}
          </button>
          <p className="mt-2 text-xs text-ink-3">{eligible ? t("openNote") : t("openIneligible")}</p>
        </div>
      ) : delegated === false ? (
        <div className="mt-4 space-y-3 text-sm">
          <p className="text-ink-2">{t("onSolana")}</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={!mine || solana.busy} onClick={recover}>
              {t("recover")}
            </button>
            <button className="btn btn-secondary" disabled={!mine || solana.busy} onClick={returnToRollup}>
              {t("returnToRollup")}
            </button>
          </div>
        </div>
      ) : !rollup ? (
        <div className="mt-4">
          <button className="btn btn-primary" disabled={!mine || !canSign || signingIn} onClick={signIn}>
            {t("signIn")}
          </button>
          <p className="mt-2 text-xs text-ink-3">{canSign ? t("signInNote") : t("cannotSign")}</p>
          {failed && <p className="mt-2 text-xs text-bad">{t("signInFailed")}</p>}
        </div>
      ) : holding === undefined ? (
        <p className="mt-4 text-sm text-ink-2">{t("loading")}</p>
      ) : !holding ? (
        <p className="mt-4 text-sm text-ink-2">{t("unreadable")}</p>
      ) : (
        <div className="mt-4 space-y-5 text-sm">
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-ink-2">{t("units")}</dt>
              <dd className="tabular mt-1 text-2xl font-semibold">{unitsOf(holding.units)}</dd>
            </div>
            <div>
              <dt className="text-ink-2">{t("cash")}</dt>
              <dd className="tabular mt-1 text-2xl font-semibold">{cash(holding.cash)}</dd>
            </div>
          </dl>
          <p className="text-xs text-ink-3">
            {t("publicLine", { deposited: unitsOf(ledger.deposited), released: unitsOf(ledger.released) })}
          </p>

          <div className="flex flex-wrap gap-2">
            {!holding.protected && (
              <button className="btn btn-primary" disabled={inRollup.busy} onClick={protect}>
                {t("protect")}
              </button>
            )}
            {holding.protected && pendingCredit > 0n && (
              <button className="btn btn-primary" disabled={inRollup.busy} onClick={credit}>
                {t("credit", { units: unitsOf(pendingCredit) })}
              </button>
            )}
            {unrecorded && (
              <button className="btn btn-primary" disabled={solana.busy} onClick={record}>
                {t("record")}
              </button>
            )}
            {claimable.length > 0 && (
              <button className="btn btn-primary" disabled={inRollup.busy} onClick={claim}>
                {t("claim", { n: claimable.length })}
              </button>
            )}
            {exitPending && (
              <button className="btn btn-primary" disabled={solana.busy} onClick={release}>
                {t("release", { units: unitsOf(exit!.withdrawn - ledger.released), cash: cash(exit!.cashWithdrawn - ledger.cashReleased) })}
              </button>
            )}
            {exitIdle && (
              <button className="btn btn-secondary" disabled={solana.busy} onClick={async () => after(await solana.run([holdings.delegateExit(wallet, mint)]))}>
                {t("rearm")}
              </button>
            )}
          </div>
          {!holding.protected && <p className="text-xs text-ink-3">{t("protectNote")}</p>}
          {unrecorded && <p className="text-xs text-ink-3">{t("recordNote")}</p>}
          {settling && <p className="text-xs text-ink-2">{t("settling")}</p>}

          <div>
            <span className="field-label">{t("depositLabel", { units: unitsOf(units) })}</span>
            <div className="flex flex-wrap gap-2">
              <input
                className="input tabular min-w-0 flex-1"
                inputMode="decimal"
                placeholder={t("amount")}
                aria-label={t("depositLabel", { units: unitsOf(units) })}
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
              />
              <button className="btn btn-secondary" disabled={!mine || solana.busy || !holding.protected} onClick={deposit}>
                {t("deposit")}
              </button>
            </div>
          </div>
          <div>
            <span className="field-label">{t("sendLabel")}</span>
            <div className="flex flex-wrap gap-2">
              <input className="input mono min-w-0 flex-[2]" placeholder={t("recipient")} aria-label={t("recipient")} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
              <input className="input tabular min-w-0 flex-1" inputMode="decimal" placeholder={t("amount")} aria-label={t("sendAmount")} value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />
              <button className="btn btn-secondary" disabled={!mine || inRollup.busy} onClick={send}>
                {t("send")}
              </button>
            </div>
          </div>
          <p className="text-xs text-ink-3">{t("sendNote")}</p>

          <div>
            <span className="field-label">{t("takeOutLabel")}</span>
            <div className="flex flex-wrap gap-2">
              <input className="input tabular min-w-0 flex-1" inputMode="decimal" placeholder={t("unitsPlaceholder")} aria-label={t("takeOutUnits")} value={outUnits} onChange={(e) => setOutUnits(e.target.value)} />
              <input className="input tabular min-w-0 flex-1" inputMode="decimal" placeholder={t("cashPlaceholder")} aria-label={t("takeOutCash")} value={outCash} onChange={(e) => setOutCash(e.target.value)} />
              <button className="btn btn-secondary" disabled={!mine || inRollup.busy || !exit?.delegated} onClick={takeOut}>
                {t("takeOut")}
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-3">{t("takeOutNote")}</p>
          </div>

          <details className="text-xs text-ink-2">
            <summary className="cursor-pointer">{t("escapeTitle")}</summary>
            <p className="mt-2">{t("escapeBody")}</p>
            <button className="btn btn-danger btn-sm mt-2" disabled={!mine || solana.busy} onClick={requestExit}>
              {t("escape")}
            </button>
          </details>
        </div>
      )}

      <TxReceipt state={solana.state} what={t("whatSolana")} />
      <TxReceipt state={inRollup.state} what={t("whatRollup")} link={null} />
    </section>
  );
}
