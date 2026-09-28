"use client";

import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, SendTransactionError, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { waitForConfirmation } from "./confirm";
import { explainFailure, type Refusal } from "./errors";

export type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "sent"; signature: string }
  | { status: "confirmed"; signature: string; slot: number }
  | { status: "failed"; signature?: string; refusal: Refusal };

export interface SendOptions {
  /** Keys the app holds itself, such as a mint being created. */
  signers?: Keypair[];
  /**
   * Land the transaction even if simulation says it will fail, so a refusal
   * gets a signature anyone can open in an explorer.
   */
  recordRefusal?: boolean;
}

/** Sign, send and confirm one transaction, keeping every step visible. */
export function useTransaction() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(
    async (instructions: TransactionInstruction[], options: SendOptions = {}) => {
      if (!publicKey) throw new Error("wallet not connected");
      setState({ status: "signing" });
      let signature: string | undefined;
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(
          ...instructions,
        );
        signature = await sendTransaction(tx, connection, {
          signers: options.signers,
          skipPreflight: options.recordRefusal ?? false,
        });
        setState({ status: "sent", signature });
        const result = await waitForConfirmation(connection, signature, lastValidBlockHeight);
        if (result.err) {
          const landed = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const logs = landed?.meta?.logMessages ?? [];
          const next: TxState = { status: "failed", signature, refusal: explainFailure(result.err, logs) };
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
    [connection, publicKey, sendTransaction],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset, busy: state.status === "signing" || state.status === "sent" };
}
