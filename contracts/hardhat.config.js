import "dotenv/config";
import "@nomicfoundation/hardhat-ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x" + "11".repeat(32);

export default {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    testnet: {
      url: process.env.HASHKEY_TESTNET_RPC_URL || "https://testnet.hsk.xyz",
      chainId: 133,
      accounts: process.env.PRIVATE_KEY ? [PRIVATE_KEY] : []
    },
    mainnet: {
      url: process.env.HASHKEY_MAINNET_RPC_URL || "https://mainnet.hsk.xyz",
      chainId: 177,
      accounts: process.env.PRIVATE_KEY ? [PRIVATE_KEY] : []
    }
  }
};
