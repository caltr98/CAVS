import { network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

const { ethers } = await network.create();

function deriveEthrDid(address: string, chainId: bigint): string {
  if (chainId === 11155111n) {
    return `did:ethr:sepolia:${address}`;
  }
  return `did:ethr:${address}`;
}

function parseOracleId(raw: string | undefined): bigint {
  const value = (raw || "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Set ORACLE_ID to a non-negative integer");
  }
  const oracleId = BigInt(value);
  if (oracleId > 255n) {
    throw new Error("ORACLE_ID must fit uint8: 0 to 255");
  }
  return oracleId;
}

async function main() {
  const address = process.env.CONTRACT_ADDRESS;
  const oraclesEncryptionKey = process.env.CAVS_ORACLES_ENCRYPTION_KEY?.trim();
  const oracleId = parseOracleId(process.env.ORACLE_ID);

  if (!address || !oraclesEncryptionKey) {
    throw new Error("Set CONTRACT_ADDRESS, ORACLE_ID, CAVS_ORACLES_ENCRYPTION_KEY");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(oraclesEncryptionKey)) {
    throw new Error("CAVS_ORACLES_ENCRYPTION_KEY must be a bytes32 hex string");
  }

  const [signer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const oracleDid = process.env.ORACLE_DID?.trim() || deriveEthrDid(signer.address, chainId);

  const contract = await ethers.getContractAt("CAVSOracleCoordinator", address);
  const oracleCount = await contract.oracleCount();
  if (oracleId >= oracleCount) {
    throw new Error(`ORACLE_ID ${oracleId.toString()} is outside configured NUM_ORACLES ${oracleCount.toString()}`);
  }

  const tx = await contract.registerOracle(oracleId, oracleDid, oraclesEncryptionKey);
  const receipt = await tx.wait();
  const assignedOracleId = await contract.getOracleIdForAccount(signer.address);

  console.log("oracle ID:", assignedOracleId.toString());
  console.log("oracle DID:", oracleDid);
  console.log("oracle OEncryKey:", oraclesEncryptionKey);
  console.log("registerOracle tx:", receipt?.hash || tx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
