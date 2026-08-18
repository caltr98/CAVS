import { configVariable, defineConfig } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import * as dotenv from "dotenv";
import path from "node:path";

dotenv.config();
// Load the repository-level defaults without clobbering command-specific env.
// Test runners pass values such as AUTHOR_DID/AUTHOR_VERAMO_ENDPOINT to scripts.
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../.env") });

const DEFAULT_SEPOLIA_AVERAGE_BLOCK_MS = 12000;

function normalizePrivateKey(value: string | undefined, label = "PRIVATE_KEY") {
  const candidate = (value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!candidate) return undefined;

  const normalized = candidate.startsWith("0x") ? candidate : `0x${candidate}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 32-byte hex private key`);
  }
  return normalized;
}

function firstPrivateKey(...candidates: Array<[string, string | undefined]>) {
  for (const [label, value] of candidates) {
    const normalized = normalizePrivateKey(value, label);
    if (normalized) return normalized;
  }
  return undefined;
}

const PRIVATE_KEY = firstPrivateKey(
  ["OCR_FUNDER_PRIVATE_KEY", process.env.OCR_FUNDER_PRIVATE_KEY],
  ["AUTHOR_FUNDER_PRIVATE_KEY", process.env.AUTHOR_FUNDER_PRIVATE_KEY],
  ["PRIVATE_KEY", process.env.PRIVATE_KEY],
);
const SEPOLIA_RPC_URL =
  process.env.OCR_CONTRACT_RPC_URL || process.env.SEPOLIA_RPC_URL || "";
if (PRIVATE_KEY) process.env.PRIVATE_KEY = PRIVATE_KEY;
if (SEPOLIA_RPC_URL) process.env.OCR_CONTRACT_RPC_URL = SEPOLIA_RPC_URL;

const hardhatMiningIntervalMs = Number(
  process.env.HARDHAT_MINING_INTERVAL_MS ||
  process.env.SEPOLIA_AVERAGE_BLOCK_MS ||
  DEFAULT_SEPOLIA_AVERAGE_BLOCK_MS
);

export default defineConfig({
  plugins: [hardhatEthers, hardhatEthersChaiMatchers, hardhatMocha],
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      mining: {
        auto: false,
        interval: Number.isFinite(hardhatMiningIntervalMs) && hardhatMiningIntervalMs > 0
          ? hardhatMiningIntervalMs
          : DEFAULT_SEPOLIA_AVERAGE_BLOCK_MS
      }
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545"
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("OCR_CONTRACT_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")]
    }
  },
  test: {
    mocha: {
      timeout: 20_000
    }
  }
});
