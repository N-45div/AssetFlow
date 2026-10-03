"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SendTransactionError, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { waitForConfirmation } from "./confirm";
import { explainFailure } from "./errors";
import { rollupConnection, rollupToken } from "./private";
import type { TxState } from "./use-transaction";

const tokenKey = (wallet: string) => `assetflow:rollup:${wallet}`;

/**
 * This wallet's way into the private rollup: a read token from a signed
 * message, kept for the browser session. Without it the rollup shows the
 * wallet nothing private.
 */
export function useRollup() {
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [rollup, setRollup] = useState<Connection | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let token: string | null = null;
    try {
      token = wallet ? sessionStorage.getItem(tokenKey(wallet)) : null;
    } catch {
      token = null;
    }
    // A token saved in this session, or none: the wallet signs in again.
    queueMicrotask(() => setRollup(token ? rollupConnection(token) : null));
  }, [wallet]);

  const signIn = useCallback(async () => {
    if (!publicKey || !signMessage) return null;
    setSigningIn(true);
    setFailed(false);
    try {
      const token = await rollupToken(publicKey, signMessage);
      try {
        sessionStorage.setItem(tokenKey(publicKey.toBase58()), token);
      } catch {
        // storage unavailable: the token lasts as long as this page
      }
      const connection = rollupConnection(token);
      setRollup(connection);
      return connection;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setSigningIn(false);
    }
  }, [publicKey, signMessage]);

  return { rollup, signIn, signingIn, failed, canSign: !!signMessage };
}

/**
 * Sign one transaction with the wallet and send it to the private rollup.
 * The wallet only signs: sending it itself would go to Solana instead.
 * The rollup charges no fees, but the wallet still signs as fee payer.
 */
export function useRollupTransaction(rollup: Connection | null) {
  const { publicKey, signTransaction } = useWallet();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(
    async (instructions: TransactionInstruction[]): Promise<TxState> => {
      if (!publicKey || !signTransaction || !rollup) throw new Error("not signed in to the rollup");
      setState({ status: "signing" });
      let signature: string | undefined;
      try {
        const { blockhash, lastValidBlockHeight } = await rollup.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
        const signed = await signTransaction(tx);
        signature = await rollup.sendRawTransaction(signed.serialize(), { skipPreflight: true });
        setState({ status: "sent", signature });
        const result = await waitForConfirmation(rollup, signature, lastValidBlockHeight);
        if (result.err) {
          const landed = await rollup.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          const next: TxState = { status: "failed", signature, refusal: explainFailure(result.err, landed?.meta?.logMessages ?? []) };
          setState(next);
          return next;
        }
        const next: TxState = { status: "confirmed", signature, slot: result.slot };
        setState(next);
        return next;
      } catch (error) {
        const logs = error instanceof SendTransactionError ? (error.logs ?? []) : [];
        const next: TxState = { status: "failed", signature, refusal: explainFailure(error, logs) };
        setState(next);
        return next;
      }
    },
    [rollup, publicKey, signTransaction],
  );

  return { state, run, busy: state.status === "signing" || state.status === "sent" };
}
