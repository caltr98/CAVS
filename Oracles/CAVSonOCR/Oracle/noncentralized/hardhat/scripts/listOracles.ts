import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const address = process.env.CONTRACT_ADDRESS;
  if (!address) {
    throw new Error("Set CONTRACT_ADDRESS");
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
      endpoint: oracle.endpoint,
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
