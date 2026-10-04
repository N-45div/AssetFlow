/**
 * The EVM chains AssetFlow's console runs on, and what each one has: its
 * testnet, the shared contracts (the same addresses everywhere: one deployer,
 * one order), and the Ethereum Attestation Service its registries read KYC
 * from, whose signing format differs by version.
 */
import { createPublicClient, defineChain, http, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

export type EvmChainKey = "base" | "arbitrum" | "robinhood";

export interface EvmChainConfig {
  key: EvmChainKey;
  /** Where its pages live: /base, /arbitrum, /robinhood. */
  prefix: string;
  /** The ecosystem, as in "AssetFlow on Base". */
  brand: string;
  /** The network the console runs on. */
  network: string;
  chain: Chain;
  rpcUrl: string;
  explorer: string;
  faucet: string;
  dot: string;
  directory: Address;
  testUsd: Address;
  /** Paxos's USDG on this testnet, where Paxos deploys it (docs.paxos.com); its faucet gives 100 a day. */
  usdg?: Address;
  eas: Address;
  /** EAS 1.2 signs delegated requests without the attester; 1.3 and later with it. */
  easVersion: "1.2.0" | "1.3.0" | "1.4.0";
  /** An EAS indexer, where there is one; otherwise attestations are found in the logs. */
  easscan?: string;
  /** The first block worth searching for our attestations in the logs. */
  easFromBlock: bigint;
  /** Mainnet deployments of the same contracts, shown on the chain's page. */
  mainnet?: { name: string; explorer: string; directory: Address; registry: Address; servicer: Address; token: Address };
  featuredBond?: string;
}

const DIRECTORY = "0x1C1867cC4899157B8c6fb2D1d351985f73fe125e" as Address;
const TEST_USD = "0x9E0bDFa145cdF651A4Fee85E83E26E3e94aB5e2d" as Address;
const PILOT = {
  directory: DIRECTORY,
  registry: "0xbbE819AB63f68b6C39576F0356EB9087fFF5444f" as Address,
  servicer: "0xCc673fD915EE01f2F712A880a51E42EDC9A7d320" as Address,
  token: "0xDABea95f39ef319AE4C775Ca8c8b3c37971Aa977" as Address,
};

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" } },
  // every read the console makes is batched through Multicall3, at its usual address here too
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const EVM_CHAINS: Record<EvmChainKey, EvmChainConfig> = {
  base: {
    key: "base",
    prefix: "/base",
    brand: "Base",
    network: "Base Sepolia",
    chain: baseSepolia,
    rpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://sepolia.base.org",
    explorer: "https://base-sepolia.blockscout.com",
    faucet: "https://portal.cdp.coinbase.com/products/faucet",
    dot: "#0052ff",
    directory: DIRECTORY,
    testUsd: TEST_USD,
    eas: "0x4200000000000000000000000000000000000021",
    easVersion: "1.2.0",
    easscan: "https://base-sepolia.easscan.org",
    easFromBlock: 0n,
    mainnet: { name: "Base", explorer: "https://base.blockscout.com", ...PILOT },
    featuredBond: process.env.NEXT_PUBLIC_BASE_FEATURED_BOND,
  },
  arbitrum: {
    key: "arbitrum",
    prefix: "/arbitrum",
    brand: "Arbitrum",
    network: "Arbitrum Sepolia",
    chain: arbitrumSepolia,
    rpcUrl: process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://arbitrum-sepolia.blockscout.com",
    faucet: "https://www.alchemy.com/faucets/arbitrum-sepolia",
    dot: "#28a0f0",
    directory: DIRECTORY,
    testUsd: TEST_USD,
    usdg: "0xFFC95faa3d63Cde504a05B567C600B78C0b41892",
    eas: "0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE",
    easVersion: "1.3.0",
    easFromBlock: 313_800_000n,
    mainnet: { name: "Arbitrum One", explorer: "https://arbitrum.blockscout.com", ...PILOT },
    featuredBond: process.env.NEXT_PUBLIC_ARBITRUM_FEATURED_BOND,
  },
  robinhood: {
    key: "robinhood",
    prefix: "/robinhood",
    brand: "Robinhood Chain",
    network: "Robinhood Chain testnet",
    chain: robinhoodTestnet,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    faucet: "https://faucet.testnet.chain.robinhood.com",
    dot: "#00c805",
    directory: DIRECTORY,
    testUsd: TEST_USD,
    // Robinhood Chain has no EAS of its own yet: AssetFlow runs the Foundation's contracts there.
    usdg: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    eas: "0xdD5Fc46c9f5C87e887614DB3b124e51A4A5540A1",
    easVersion: "1.4.0",
    easFromBlock: 125_997_000n,
    featuredBond: process.env.NEXT_PUBLIC_ROBINHOOD_FEATURED_BOND,
  },
};

export const EVM_CHAIN_KEYS = Object.keys(EVM_CHAINS) as EvmChainKey[];

/** Paxos's testnet faucet: 100 USDG a day per wallet, on Arbitrum Sepolia and Robinhood Chain testnet among others. */
export const USDG_FAUCET = "https://faucet.paxos.com/";

/** What a bond's payment currency is, from its address. */
export function currencyKind(cfg: EvmChainConfig, currency: string): "usdg" | "testUsd" | "other" {
  const c = currency.toLowerCase();
  if (cfg.usdg && c === cfg.usdg.toLowerCase()) return "usdg";
  if (c === cfg.testUsd.toLowerCase()) return "testUsd";
  return "other";
}

/** AssetFlow's investor schema, the same UID on every chain: uint16 jurisdiction, uint8 tier, bool accredited. */
export const INVESTOR_SCHEMA: Hex = "0xc4f99bbaebea35d982f583b35f80da7ea6871d64fadb9dd220f45f578db20384";
/** The demo KYC provider's attester, the same key on every chain. */
export const KYC_ATTESTER = (process.env.NEXT_PUBLIC_BASE_KYC_ATTESTER ?? "") as Address;

/** The EVM chain a path belongs to, if any. */
export function chainForPath(pathname: string): EvmChainConfig | null {
  return EVM_CHAIN_KEYS.map((k) => EVM_CHAINS[k]).find((c) => pathname === c.prefix || pathname.startsWith(`${c.prefix}/`)) ?? null;
}

const clients = new Map<EvmChainKey, PublicClient>();
export function publicClientFor(cfg: EvmChainConfig): PublicClient {
  let c = clients.get(cfg.key);
  if (!c) {
    c = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) }) as PublicClient;
    clients.set(cfg.key, c);
  }
  return c;
}

export function linksFor(cfg: EvmChainConfig) {
  return {
    address: (a: string) => `${cfg.explorer}/address/${a}`,
    tx: (h: string) => `${cfg.explorer}/tx/${h}`,
    attestation: (uid: string) => (cfg.easscan ? `${cfg.easscan}/attestation/view/${uid}` : `${cfg.explorer}/address/${cfg.eas}`),
  };
}

/** The EIP-712 domain and types EAS signs delegated requests with, by version. */
export function easTypedData(cfg: EvmChainConfig) {
  const legacy = cfg.easVersion === "1.2.0";
  const common = [
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ];
  const revoke = [
    { name: "schema", type: "bytes32" },
    { name: "uid", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ];
  return {
    domain: { name: "EAS", version: cfg.easVersion, chainId: cfg.chain.id, verifyingContract: cfg.eas },
    attest: legacy ? common : [{ name: "attester", type: "address" }, ...common],
    revoke: legacy ? revoke : [{ name: "revoker", type: "address" }, ...revoke],
    withSigner: !legacy,
  };
}
