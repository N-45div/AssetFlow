import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

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

const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const adminAddress = process.env.ADMIN_ADDRESS || wallet.address;

async function loadArtifact(contractName) {
  const abiPath = resolve(buildDir, `contracts_${contractName}_sol_${contractName}.abi`);
  const binPath = resolve(buildDir, `contracts_${contractName}_sol_${contractName}.bin`);

  const [abiRaw, binRaw] = await Promise.all([
    readFile(abiPath, "utf8"),
    readFile(binPath, "utf8")
  ]);

  return {
    abi: JSON.parse(abiRaw),
    bytecode: `0x${binRaw.trim()}`
  };
}

async function main() {
  const artifact = await loadArtifact("AssetOracleRouter");
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const router = await factory.deploy(adminAddress);
  await router.waitForDeployment();

  const asset = process.env.ORACLE_ASSET_ADDRESS;
  const feed = process.env.ORACLE_FEED_ADDRESS;

  if (asset && feed) {
    const assetDecimals = Number(process.env.ORACLE_ASSET_DECIMALS || "18");
    const staleAfter = Number(process.env.ORACLE_STALE_AFTER || "86400");
    const enabled = process.env.ORACLE_ENABLED !== "false";

    await (await router.setFeedConfig(asset, feed, assetDecimals, staleAfter, enabled)).wait();
  }

  console.log(
    JSON.stringify(
      {
        network,
        rpcUrl,
        deployer: wallet.address,
        adminAddress,
        oracleRouter: await router.getAddress(),
        configuredAsset: asset || null,
        configuredFeed: feed || null
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
