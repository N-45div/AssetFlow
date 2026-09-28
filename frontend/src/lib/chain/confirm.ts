import type { Connection, TransactionError } from "@solana/web3.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a signature by polling its status. web3.js's confirmTransaction
 * listens on a websocket, which an HTTP proxy in front of the RPC cannot
 * carry; polling works through anything.
 */
export async function waitForConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<{ err: TransactionError | null; slot: number }> {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) return { err: status.err, slot: status.slot };
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return { err: null, slot: status.slot };
    }
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error("The transaction expired before it was confirmed.");
    }
    await sleep(800);
  }
}
