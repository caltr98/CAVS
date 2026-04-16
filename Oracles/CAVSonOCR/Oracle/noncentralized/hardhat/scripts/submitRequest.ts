import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

type RequestBody = {
  requesterEndpoint: string;
  statement: string;
  holderDid: string;
  authorSkills: string[];
};

function normalizeTargetOracleIds(ids: Array<string | number | bigint>): bigint[] {
  return ids.map((value) => {
    const oracleId = BigInt(value);
    if (oracleId < 0n || oracleId > 255n) {
      throw new Error("TARGET_ORACLE_IDS_JSON values must fit uint8: 0 to 255");
    }
    return oracleId;
  });
}

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw) as T;
}

async function postDirectRequest(endpoint: string, body: RequestBody) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${endpoint} failed with HTTP ${response.status}: ${payload}`);
  }

  try {
    return JSON.parse(payload) as { requestId?: string; status?: string };
  } catch (_err) {
    return { status: payload };
  }
}

async function main() {
  const address = process.env.CONTRACT_ADDRESS;
  const requesterEndpoint = process.env.REQUESTER_ENDPOINT;
  const statement = process.env.STATEMENT;
  const holderDid = process.env.HOLDER_DID;

  if (!address || !requesterEndpoint || !statement || !holderDid) {
    throw new Error("Set CONTRACT_ADDRESS, REQUESTER_ENDPOINT, STATEMENT, HOLDER_DID");
  }

  const authorSkills = parseJsonEnv<string[]>("AUTHOR_SKILLS_JSON", []);
  const targetOracleIds = normalizeTargetOracleIds(
    parseJsonEnv<Array<string | number | bigint>>("TARGET_ORACLE_IDS_JSON", []),
  );

  const contract = await ethers.getContractAt("CAVSOracleCoordinator", address);

  let oracleIds: bigint[] = targetOracleIds;
  if (oracleIds.length === 0) {
    oracleIds = await contract.getRegisteredOracleIds();
  }
  if (oracleIds.length === 0) {
    throw new Error("No registered oracle IDs found in the contract");
  }

  const requestBody: RequestBody = {
    requesterEndpoint,
    statement,
    holderDid,
    authorSkills,
  };

  const submitted: Array<{ oracleId: string; endpoint: string; response: { requestId?: string; status?: string } }> = [];
  for (const oracleId of oracleIds) {
    const oracle = await contract.getOracle(oracleId);
    if (!oracle.active) {
      continue;
    }
    const endpoint = String(oracle.endpoint || "").trim();
    if (!endpoint) {
      throw new Error(`Oracle ${oracleId.toString()} has no endpoint registered`);
    }
    const response = await postDirectRequest(endpoint, requestBody);
    submitted.push({
      oracleId: oracleId.toString(),
      endpoint,
      response,
    });
  }

  console.log(JSON.stringify({ submitted }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
