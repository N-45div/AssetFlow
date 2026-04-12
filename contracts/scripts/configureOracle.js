import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const buildDir = resolve(projectRoot, "build");

const network = process.argv[2] || "testnet";
const rpcUrl =
  network === "mainnet"
    ? process.env.HASHKEY_MAINNET_RPC_URL || "https://mainnet.hsk.xyz"
    : process.env.HASHKEY_TESTNET_RPC_URL || "https://testnet.hsk.xyz";

if (!process.env.PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY is required");
}
if (!process.env.ORACLE_ROUTER_ADDRESS) {
  throw new Error("ORACLE_ROUTER_ADDRESS is required");
}
if (!process.env.ORACLE_ASSET_ADDRESS) {
  throw new Error("ORACLE_ASSET_ADDRESS is required");
}
if (!process.env.ORACLE_FEED_ADDRESS) {
  throw new Error("ORACLE_FEED_ADDRESS is required");
}

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

async function loadAbi(contractName) {
  const abiPath = resolve(buildDir, `contracts_${contractName}_sol_${contractName}.abi`);
  return JSON.parse(await readFile(abiPath, "utf8"));
}

async function main() {
  const abi = await loadAbi("AssetOracleRouter");
  const router = new Contract(process.env.ORACLE_ROUTER_ADDRESS, abi, wallet);

  const assetDecimals = Number(process.env.ORACLE_ASSET_DECIMALS || "18");
  const staleAfter = Number(process.env.ORACLE_STALE_AFTER || "86400");
  const enabled = process.env.ORACLE_ENABLED !== "false";

  const tx = await router.setFeedConfig(
    process.env.ORACLE_ASSET_ADDRESS,
    process.env.ORACLE_FEED_ADDRESS,
    assetDecimals,
    staleAfter,
    enabled
  );
  await tx.wait();

  console.log(
    JSON.stringify(
      {
        network,
        rpcUrl,
        oracleRouter: process.env.ORACLE_ROUTER_ADDRESS,
        asset: process.env.ORACLE_ASSET_ADDRESS,
        feed: process.env.ORACLE_FEED_ADDRESS,
        assetDecimals,
        staleAfter,
        enabled,
        txHash: tx.hash
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
