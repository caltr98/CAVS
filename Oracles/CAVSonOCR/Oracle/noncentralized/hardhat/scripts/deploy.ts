import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function parsePositiveUint8Env(name: string, fallback: string): bigint {
  const raw = (process.env[name] || fallback).trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = BigInt(raw);
  if (value > 255n) {
    throw new Error(`${name} must fit uint8: 1 to 255`);
  }
  return value;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const numOracles = parsePositiveUint8Env("NUM_ORACLES", "4");

  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("Configured oracle slots:", numOracles.toString());

  const factory = await ethers.getContractFactory("CAVSOracleCoordinator");
  const contract = await factory.deploy(numOracles);
  await contract.waitForDeployment();

  console.log("Contract deployed at:", await contract.getAddress());
  console.log("NUM_ORACLES:", numOracles.toString());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
