import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-mocha";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./contracts/test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    "base-sepolia": {
      type: "http",
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      // DEPLOYER_PRIVATE_KEY is the current name; AGENTVAULT_PRIVATE_KEY is the
      // legacy fallback (pre-zx402 env name) so existing .env files keep working.
      accounts: (process.env.DEPLOYER_PRIVATE_KEY ?? process.env.AGENTVAULT_PRIVATE_KEY)
        ? [(process.env.DEPLOYER_PRIVATE_KEY ?? process.env.AGENTVAULT_PRIVATE_KEY) as string]
        : [],
      chainId: 84532,
    },
  },
};

export default config;
