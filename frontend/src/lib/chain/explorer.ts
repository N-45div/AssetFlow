import { CLUSTER, RPC_URL } from "./config";

function clusterQuery() {
  if (CLUSTER === "mainnet-beta") return "";
  if (CLUSTER === "localnet") return `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
  return `?cluster=${CLUSTER}`;
}

export const explorer = {
  tx: (signature: string) => `https://explorer.solana.com/tx/${signature}${clusterQuery()}`,
  address: (address: string) => `https://explorer.solana.com/address/${address}${clusterQuery()}`,
};

export function shortKey(key: string, chars = 4) {
  return key.length <= chars * 2 + 1 ? key : `${key.slice(0, chars)}…${key.slice(-chars)}`;
}
