"use client";

import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Abi, type Address, type Hash } from "viem";
import type { Refusal, RefusalCode } from "@/lib/chain/errors";
import type { TxState } from "@/lib/chain/use-transaction";
import { useEvmChain } from "./use-evm-chain";
import { useEvmWallet } from "./wallet";

/** The contracts' custom errors the app names; anything else is "Unknown". */
const KNOWN = new Set<string>([
  "Unauthorized",
  "NotEligible",
  "InvalidAmount",
  "InvalidTerms",
  "InvalidPeriod",
  "RecordDateNotReached",
  "Underfunded",
  "Overdrawn",
  "AssetMatured",
  "MaturityNotReached",
  "RequestClosed",
  "KycSourceNotSet",
  "AttestationMismatch",
  "AttestationExpired",
  "StillAttested",
  "AlreadyPaid",
  "NothingHeld",
  "MaturityNotStarted",
  "OpenRequest",
  "UnitsLocked",
]);

export function explainEvmFailure(error: unknown): Refusal {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return { code: "Rejected", logs: [] };
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = reverted?.data?.errorName;
    if (name && KNOWN.has(name)) return { code: name as RefusalCode, logs: [error.shortMessage] };
    return { code: "Unknown", logs: [error.shortMessage] };
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/rejected|denied/i.test(text)) return { code: "Rejected", logs: [] };
  return { code: "Unknown", logs: [text] };
}

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Send contract calls one after another and keep every step visible. Each is
 * simulated first, so a refusal is named before the wallet asks to sign.
 * `deploy` sends a contract creation instead and resolves to its address.
 */
export function useEvmTx() {
  const { client, address } = useEvmWallet();
  const { pub } = useEvmChain();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const settle = useCallback(async (hash: Hash) => {
    setState({ status: "sent", signature: hash });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    // The public RPC is several nodes: wait until the one answering has the block, so what is read next includes it.
    for (let i = 0; i < 20 && (await pub.getBlockNumber({ cacheTime: 0 })) < receipt.blockNumber; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (receipt.status !== "success") {
      const next: TxState = { status: "failed", signature: hash, refusal: { code: "Unknown", logs: ["reverted"] } };
      setState(next);
      return { state: next, receipt };
    }
    const next: TxState = { status: "confirmed", signature: hash, slot: Number(receipt.blockNumber) };
    setState(next);
    return { state: next, receipt };
  }, [pub]);

  const run = useCallback(
    async (calls: Call[]): Promise<TxState> => {
      if (!client || !address) throw new Error("wallet not connected");
      let last: TxState = { status: "idle" };
      try {
        for (const call of calls) {
          setState({ status: "signing" });
          const { request } = await pub.simulateContract({ ...call, account: address } as Parameters<typeof pub.simulateContract>[0]);
          // Estimates can run with the last block's time, where the token's balance history
          // overwrites that second's entry instead of opening a new one: the real call costs more.
          const estimate = await pub.estimateContractGas({ ...call, account: address } as Parameters<typeof pub.estimateContractGas>[0]);
          const gas = (estimate * 13n) / 10n + 30_000n;
          const hash = await client.writeContract({
            ...(request as Parameters<typeof client.writeContract>[0]),
            gas,
            account: client.account ?? address,
            chain: client.chain,
          });
          last = (await settle(hash)).state;
          if (last.status !== "confirmed") return last;
        }
        return last;
      } catch (error) {
        const next: TxState = { status: "failed", refusal: explainEvmFailure(error) };
        setState(next);
        return next;
      }
    },
    [client, address, settle, pub],
  );

  const deploy = useCallback(
    async (abi: Abi, bytecode: `0x${string}`, args: readonly unknown[]): Promise<Address | null> => {
      if (!client || !address) throw new Error("wallet not connected");
      try {
        setState({ status: "signing" });
        const hash = await client.deployContract({ abi, bytecode, args, account: client.account ?? address, chain: client.chain } as Parameters<typeof client.deployContract>[0]);
        const { state: done, receipt } = await settle(hash);
        return done.status === "confirmed" ? (receipt.contractAddress ?? null) : null;
      } catch (error) {
        setState({ status: "failed", refusal: explainEvmFailure(error) });
        return null;
      }
    },
    [client, address, settle],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, deploy, reset, busy: state.status === "signing" || state.status === "sent" };
}
