import { network } from "hardhat";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../../.env") });

const { ethers, networkName } = await network.create();

type FundingTarget = {
  oracleId: number;
  address: string;
  source: string;
};

const DEFAULT_CAVS_ENDPOINTS = [
  "http://127.0.0.1:4200",
  "http://127.0.0.1:4202",
  "http://127.0.0.1:4203",
  "http://127.0.0.1:4204",
];
const SEPOLIA_CHAIN_ID = 11155111n;
const LOCAL_TARGET_BALANCE_ETH =
  process.env.CAVS_ORACLE_TARGET_BALANCE_ETH ?? "0.10";
const LIVE_PRIMARY_ORACLE_BALANCE_ETH =
  process.env.CAVS_PRIMARY_ORACLE_BALANCE_ETH ?? "0.05";
const LIVE_SECONDARY_ORACLE_BALANCE_ETH =
  process.env.CAVS_SECONDARY_ORACLE_BALANCE_ETH ?? "0.03";
const LIVE_COORDINATOR_DEPLOY_GAS_BUDGET = BigInt(
  process.env.CAVS_COORDINATOR_DEPLOY_GAS_BUDGET ?? "4500000"
);
const LIVE_REGISTER_ORACLE_GAS_BUDGET = BigInt(
  process.env.CAVS_REGISTER_ORACLE_GAS_BUDGET ?? "700000"
);
const LIVE_BALANCE_BUFFER_WEI = ethers.parseEther(
  process.env.CAVS_BALANCE_BUFFER_ETH ?? "0.015"
);
const LIVE_BALANCE_SAFETY_MULTIPLIER_BPS = BigInt(
  process.env.CAVS_BALANCE_SAFETY_MULTIPLIER_BPS ?? "25000"
);

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

function parsePositiveEthEnv(name: string, fallback: string) {
  const raw = process.env[name]?.trim() || fallback;
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw)) {
    throw new Error(`${name} must be a positive ETH amount, got ${raw}`);
  }
  const wei = ethers.parseEther(raw);
  if (wei <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }
  return wei;
}

function formatEth(value: bigint) {
  return Number(ethers.formatEther(value)).toFixed(6);
}

function isLiveChain(chainId: bigint) {
  return chainId !== 31337n && chainId !== 1337n;
}

function maxBigInt(left: bigint, right: bigint) {
  return left > right ? left : right;
}

function scaleWeiByBps(value: bigint, basisPoints: bigint) {
  return (value * basisPoints + 9_999n) / 10_000n;
}

async function resolveFundingGasPriceWei() {
  const feeData = await ethers.provider.getFeeData();
  const candidates = [feeData.maxFeePerGas, feeData.gasPrice].filter(
    (candidate): candidate is bigint =>
      typeof candidate === "bigint" && candidate > 0n
  );

  if (candidates.length > 0) {
    return candidates.reduce((maxValue, candidate) =>
      candidate > maxValue ? candidate : maxValue
    );
  }

  return ethers.parseUnits("5", "gwei");
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

async function resolveTargetsFromCavs(): Promise<FundingTarget[]> {
  const endpoints = csvEnv("CAVS_ORACLE_ENDPOINTS", DEFAULT_CAVS_ENDPOINTS);
  return Promise.all(
    endpoints.map(async (endpoint, oracleId) => {
      const baseUrl = endpoint.replace(/\/+$/, "");
      const setup = await postJson(`${baseUrl}/setup`, { oracleId });
      const address =
        setup.eth_address ||
        setup.ethAddress ||
        setup.address ||
        setup.ethereumAddress;
      if (!address) {
        throw new Error(`${baseUrl}/setup did not return eth_address`);
      }
      return {
        oracleId,
        address: normalizeAddress(String(address), `oracle ${oracleId}`),
        source: baseUrl,
      };
    })
  );
}

function resolveTargetsFromEnv(): FundingTarget[] | null {
  const addresses = csvEnv("CAVS_ORACLE_ADDRESSES", []);
  if (addresses.length === 0) return null;
  return addresses.map((address, oracleId) => ({
    oracleId,
    address: normalizeAddress(address, `CAVS_ORACLE_ADDRESSES[${oracleId}]`),
    source: "CAVS_ORACLE_ADDRESSES",
  }));
}

async function buildFundingTargets(targets: FundingTarget[], chainId: bigint) {
  if (!isLiveChain(chainId)) {
    const targetBalance = parsePositiveEthEnv(
      "CAVS_ORACLE_TARGET_BALANCE_ETH",
      LOCAL_TARGET_BALANCE_ETH
    );
    return targets.map((target) => ({ ...target, targetBalance }));
  }

  const gasPriceWei = await resolveFundingGasPriceWei();
  const willDeployCoordinator = !(process.env.OCR_CONTRACT_ADDRESS || "").trim();
  return targets.map((target) => {
    const baseBalance = ethers.parseEther(
      target.oracleId === 0
        ? LIVE_PRIMARY_ORACLE_BALANCE_ETH
        : LIVE_SECONDARY_ORACLE_BALANCE_ETH
    );
    const gasBudget =
      LIVE_REGISTER_ORACLE_GAS_BUDGET +
      (target.oracleId === 0 && willDeployCoordinator
        ? LIVE_COORDINATOR_DEPLOY_GAS_BUDGET
        : 0n);
    const projectedTarget =
      scaleWeiByBps(
        gasBudget * gasPriceWei,
        LIVE_BALANCE_SAFETY_MULTIPLIER_BPS
      ) + LIVE_BALANCE_BUFFER_WEI;

    return {
      ...target,
      targetBalance: maxBigInt(baseBalance, projectedTarget),
    };
  });
}

async function waitForReceipt(txPromise: Promise<any>) {
  const tx = await txPromise;
  if (!tx || typeof tx.wait !== "function") {
    throw new Error("Expected a transaction response with wait()");
  }
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error(`Missing receipt for tx ${tx.hash}`);
  }
  if (receipt.status !== 1) {
    throw new Error(`Funding tx ${tx.hash} reverted with status ${receipt.status}`);
  }
  return receipt;
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const allowLiveFunding =
    process.env.CAVS_ALLOW_LIVE_FUNDING === "1" ||
    process.env.CAVS_ALLOW_LIVE_FUNDING?.toLowerCase() === "true";
  if (isLiveChain(chainId) && chainId !== SEPOLIA_CHAIN_ID && !allowLiveFunding) {
    throw new Error(
      `Refusing to fund on live chain ${chainId}. Set CAVS_ALLOW_LIVE_FUNDING=true only if this is intentional.`
    );
  }

  const gasReserve = parsePositiveEthEnv("CAVS_FUNDER_GAS_RESERVE_ETH", "0.005");
  const targets = resolveTargetsFromEnv() || (await resolveTargetsFromCavs());
  const uniqueTargets = targets.filter(
    (target, index, allTargets) =>
      allTargets.findIndex(
        (candidate) => candidate.address.toLowerCase() === target.address.toLowerCase()
      ) === index
  );

  const [funder] = await ethers.getSigners();
  if (!funder) {
    throw new Error("No funder signer available. Set PRIVATE_KEY in Oracles/CAVSonOCR/.env for Sepolia.");
  }
  const funderBalance = await ethers.provider.getBalance(funder.address);
  if (funderBalance <= gasReserve) {
    throw new Error(
      `Insufficient balance on funder ${funder.address}. Balance ${formatEth(funderBalance)} ETH, reserve ${formatEth(gasReserve)} ETH.`
    );
  }

  const fundingTargets = await buildFundingTargets(uniqueTargets, chainId);
  const topUps = await Promise.all(
    fundingTargets.map(async (target) => {
      const currentBalance = await ethers.provider.getBalance(target.address);
      const missingBalance =
        currentBalance >= target.targetBalance
          ? 0n
          : target.targetBalance - currentBalance;
      return {
        ...target,
        currentBalance,
        missingBalance,
        isFunder: target.address.toLowerCase() === funder.address.toLowerCase(),
      };
    })
  );

  const requiredSelfBalance = topUps.reduce(
    (maxValue, topUp) =>
      topUp.isFunder && topUp.targetBalance > maxValue
        ? topUp.targetBalance
        : maxValue,
    0n
  );
  const totalRequired = topUps.reduce(
    (sum, topUp) => sum + (topUp.isFunder ? 0n : topUp.missingBalance),
    0n
  );
  const availableBalance = funderBalance - gasReserve;

  if (
    requiredSelfBalance > availableBalance ||
    totalRequired > availableBalance - requiredSelfBalance
  ) {
    throw new Error(
      `Funder ${funder.address} cannot cover CAVS oracle top-ups. Need ${formatEth(
        totalRequired
      )} ETH for top-ups and ${formatEth(requiredSelfBalance)} ETH retained on itself; available ${formatEth(
        availableBalance
      )} ETH after reserve.`
    );
  }

  console.log(`network=${networkName} chainId=${chainId.toString()}`);
  console.log(`funder=${funder.address} balance=${formatEth(funderBalance)} ETH`);
  if (isLiveChain(chainId)) {
    console.log(
      `liveFunding deployCoordinator=${!(process.env.OCR_CONTRACT_ADDRESS || "").trim()} gasBudgetDeploy=${LIVE_COORDINATOR_DEPLOY_GAS_BUDGET.toString()} gasBudgetRegister=${LIVE_REGISTER_ORACLE_GAS_BUDGET.toString()}`
    );
  }

  for (const topUp of topUps) {
    if (topUp.isFunder) {
      console.log(
        `oracle=${topUp.oracleId} address=${topUp.address} source=${topUp.source} target=${formatEth(topUp.targetBalance)} ETH skipped=funder`
      );
      continue;
    }
    if (topUp.missingBalance === 0n) {
      console.log(
        `oracle=${topUp.oracleId} address=${topUp.address} source=${topUp.source} balance=${formatEth(
          topUp.currentBalance
        )} ETH target=${formatEth(topUp.targetBalance)} ETH action=none`
      );
      continue;
    }
    const receipt = await waitForReceipt(
      funder.sendTransaction({
        to: topUp.address,
        value: topUp.missingBalance,
      })
    );
    console.log(
      `oracle=${topUp.oracleId} address=${topUp.address} source=${topUp.source} toppedUp=${formatEth(
        topUp.missingBalance
      )} ETH target=${formatEth(topUp.targetBalance)} ETH tx=${receipt.hash}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
