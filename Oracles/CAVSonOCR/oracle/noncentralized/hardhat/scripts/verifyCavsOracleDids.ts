import { network } from "hardhat";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../../.env") });

const { ethers, networkName } = await network.create();

type CavsIdentity = {
  oracleId: number;
  baseUrl: string;
  did: string;
  ethAddress: string;
};

const DEFAULT_CAVS_ENDPOINTS = [
  "http://127.0.0.1:4200",
  "http://127.0.0.1:4202",
  "http://127.0.0.1:4203",
  "http://127.0.0.1:4204",
];

function csvEnv(name: string, fallback: string[]) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeAddress(value: string, label: string) {
  if (!ethers.isAddress(value)) {
    throw new Error(`${label} is not an Ethereum address: ${value}`);
  }
  return ethers.getAddress(value);
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text}`);
  }
  return payload;
}

async function resolveCavsIdentities(): Promise<CavsIdentity[]> {
  const endpoints = csvEnv("CAVS_ORACLE_ENDPOINTS", DEFAULT_CAVS_ENDPOINTS);
  return Promise.all(
    endpoints.map(async (endpoint, oracleId) => {
      const baseUrl = endpoint.replace(/\/+$/, "");
      const setup = await postJson(`${baseUrl}/setup`, { oracleId });
      const did = String(setup.did || "").trim();
      const ethAddress = String(
        setup.eth_address || setup.ethAddress || setup.address || setup.ethereumAddress || ""
      ).trim();
      if (!did) {
        throw new Error(`${baseUrl}/setup did not return did`);
      }
      if (!ethAddress) {
        throw new Error(`${baseUrl}/setup did not return eth_address`);
      }
      return {
        oracleId,
        baseUrl,
        did,
        ethAddress: normalizeAddress(ethAddress, `oracle ${oracleId}`),
      };
    })
  );
}

async function main() {
  const address = process.env.OCR_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS;
  if (!address) {
    throw new Error("Set OCR_CONTRACT_ADDRESS or CONTRACT_ADDRESS to the deployed CAVSOracleCoordinator");
  }

  const contract = await ethers.getContractAt("CAVSOracleCoordinator", address);
  const oracleCount = Number(await contract.oracleCount());
  const identities = await resolveCavsIdentities();
  const results = [];
  let ok = true;

  for (const identity of identities) {
    if (identity.oracleId >= oracleCount) {
      ok = false;
      results.push({
        oracleId: identity.oracleId,
        ok: false,
        error: `slot is outside coordinator oracleCount=${oracleCount}`,
        cavs: identity,
      });
      continue;
    }

    const onchain = await contract.getOracle(identity.oracleId);
    const onchainAccount = normalizeAddress(onchain.account, `on-chain oracle ${identity.oracleId}`);
    const matchesDid = onchain.did === identity.did;
    const matchesAccount = onchainAccount === identity.ethAddress;
    const matchesActive = Boolean(onchain.active);
    const slotOk = matchesDid && matchesAccount && matchesActive;
    ok = ok && slotOk;

    results.push({
      oracleId: identity.oracleId,
      ok: slotOk,
      cavs: identity,
      onchain: {
        account: onchainAccount,
        did: onchain.did,
        oraclesEncryptionKey: onchain.oraclesEncryptionKey,
        active: Boolean(onchain.active),
        updatedAt: onchain.updatedAt.toString(),
      },
      checks: {
        did: matchesDid,
        account: matchesAccount,
        active: matchesActive,
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        ok,
        network: networkName,
        contract: ethers.getAddress(address),
        oracleCount,
        results,
      },
      null,
      2
    )
  );

  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
