import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, ZeroAddress } from "ethers";

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
const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
const adminAddress = process.env.ADMIN_ADDRESS || wallet.address;
const issuerAddress = process.env.ISSUER_ADDRESS || wallet.address;
const defaultJurisdiction = Number(process.env.DEFAULT_JURISDICTION || "344");
const existingSettlementTokenAddress = process.env.SETTLEMENT_TOKEN_ADDRESS;
const useNativeSettlement = process.env.USE_NATIVE_SETTLEMENT === "true";
const settlementTokenName = process.env.SETTLEMENT_TOKEN_NAME || "Demo USD";
const settlementTokenSymbol = process.env.SETTLEMENT_TOKEN_SYMBOL || "dUSD";
const adminSigner = adminPrivateKey ? new Wallet(adminPrivateKey, provider) : wallet;

if (adminSigner.address.toLowerCase() !== adminAddress.toLowerCase()) {
  throw new Error("ADMIN_PRIVATE_KEY does not match ADMIN_ADDRESS");
}

if (adminAddress.toLowerCase() !== wallet.address.toLowerCase() && !adminPrivateKey) {
  throw new Error("ADMIN_PRIVATE_KEY is required when ADMIN_ADDRESS differs from the deployer");
}

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

async function deploy(contractName, args = []) {
  const artifact = await loadArtifact(contractName);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const compliance = await deploy("ComplianceRegistry", [adminAddress]);
  const settlementToken = useNativeSettlement
    ? { getAddress: async () => ZeroAddress }
    : existingSettlementTokenAddress
      ? { getAddress: async () => existingSettlementTokenAddress }
      : await deploy("MintableSettlementToken", [settlementTokenName, settlementTokenSymbol, issuerAddress]);
  const assetToken = await deploy("ServicedAssetToken", [
    "HashKey Serviced Fund Unit",
    "hsFU",
    adminAddress,
    issuerAddress,
    await compliance.getAddress()
  ]);
  const distribution = await deploy("DistributionModule", [adminAddress, issuerAddress]);
  const redemption = await deploy("RedemptionModule", [
    adminAddress,
    issuerAddress,
    await assetToken.getAddress(),
    await settlementToken.getAddress()
  ]);

  const servicingRole = await assetToken.SERVICING_ROLE();
  await (await assetToken.connect(adminSigner).grantRole(servicingRole, await redemption.getAddress())).wait();

  await (await compliance.connect(adminSigner).setAllowedJurisdiction(defaultJurisdiction, true)).wait();
  await (await compliance.connect(adminSigner).setExemptCounterparty(await redemption.getAddress(), true)).wait();

  console.log(
    JSON.stringify(
      {
        network,
        rpcUrl,
        deployer: wallet.address,
        adminAddress,
        issuerAddress,
        settlementTokenMode: useNativeSettlement ? "native-hsk" : existingSettlementTokenAddress ? "existing" : "deployed",
        complianceRegistry: await compliance.getAddress(),
        settlementToken: await settlementToken.getAddress(),
        servicedAssetToken: await assetToken.getAddress(),
        distributionModule: await distribution.getAddress(),
        redemptionModule: await redemption.getAddress()
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
