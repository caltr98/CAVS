import { network } from "hardhat";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../../.env") });

const { ethers } = await network.create();

function readContractAddressArg(): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--contract-address" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (token.startsWith("--contract-address=")) {
      return token.slice("--contract-address=".length);
    }
  }
  return "";
}

async function main() {
  const address =
    readContractAddressArg() ||
    process.env.OCR_CONTRACT_ADDRESS ||
    process.env.CONTRACT_ADDRESS;
  if (!address) {
    throw new Error("Set OCR_CONTRACT_ADDRESS or CONTRACT_ADDRESS");
  }

  const contract = await ethers.getContractAt("CAVSOracleCoordinator", address);
  const oracleCount = await contract.oracleCount();
  const oracleIds = await contract.getRegisteredOracleIds();

  const oracles = [];
  for (const oracleId of oracleIds) {
    const oracle = await contract.getOracle(oracleId);
    oracles.push({
      oracleId: oracle.oracleId.toString(),
      account: oracle.account,
      did: oracle.did,
      oraclesEncryptionKey: oracle.oraclesEncryptionKey,
      active: oracle.active,
      updatedAt: oracle.updatedAt.toString(),
    });
  }

  console.log(JSON.stringify({ oracleCount: oracleCount.toString(), oracles }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
