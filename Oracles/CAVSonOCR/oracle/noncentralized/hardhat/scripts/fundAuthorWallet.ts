import { network } from "hardhat";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../../.env") });

const { ethers, networkName } = await network.create();

const DEFAULT_VERAMO_ENDPOINT = process.env.AUTHOR_VERAMO_ENDPOINT || "http://127.0.0.1:3001";
const DEFAULT_TARGET_BALANCE_ETH = process.env.AUTHOR_TARGET_BALANCE_ETH || "0.05";
const JSON_OUTPUT = (process.env.AUTHOR_FUND_OUTPUT || "").trim().toLowerCase() === "json";

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

function emit(result: Record<string, unknown>, humanLines: string[]) {
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(result));
    return;
  }
  for (const line of humanLines) {
    console.log(line);
  }
}

function rpcErrorText(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, any>;
    return String(record.shortMessage || record.message || record.error?.message || error);
  }
  return String(error || "");
}

function isReplacementFeeError(error: unknown) {
  const text = rpcErrorText(error).toLowerCase();
  return (
    text.includes("replacement transaction underpriced") ||
    text.includes("replacement fee too low") ||
    text.includes("replacement_underpriced") ||
    text.includes("transaction underpriced")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fundingTxOverrides(funderAddress: string, attempt: number) {
  const nonce = await ethers.provider.getTransactionCount(funderAddress, "pending");
  const feeData = await ethers.provider.getFeeData();
  const multiplier = BigInt(120 + attempt * 20);
  const overrides: Record<string, unknown> = { nonce };

  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    overrides.maxFeePerGas = (feeData.maxFeePerGas * multiplier) / 100n;
    overrides.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * multiplier) / 100n;
  } else if (feeData.gasPrice) {
    overrides.gasPrice = (feeData.gasPrice * multiplier) / 100n;
  }

  return overrides;
}

function tryParseEthrDidAddress(did: string) {
  const parts = did.split(":");
  const tail = parts[parts.length - 1];
  return ethers.isAddress(tail) ? ethers.getAddress(tail) : "";
}

function tryComputeAddressFromPublicKey(value: string) {
  const normalized = value.trim().startsWith("0x") ? value.trim() : `0x${value.trim()}`;
  if (!/^0x[0-9a-fA-F]{130}$/.test(normalized)) {
    return "";
  }
  try {
    return ethers.computeAddress(normalized);
  } catch {
    return "";
  }
}

async function getJson(url: string) {
  const response = await fetch(url);
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

async function resolveAuthorAddress() {
  const explicitAddress = process.env.AUTHOR_WALLET_ADDRESS?.trim();
  if (explicitAddress) {
    return {
      did: process.env.AUTHOR_DID?.trim() || "",
      address: normalizeAddress(explicitAddress, "AUTHOR_WALLET_ADDRESS"),
      source: "AUTHOR_WALLET_ADDRESS",
    };
  }

  const authorDid = process.env.AUTHOR_DID?.trim();
  if (authorDid) {
    const parsed = tryParseEthrDidAddress(authorDid);
    if (parsed) {
      return { did: authorDid, address: parsed, source: "AUTHOR_DID" };
    }
  }

  const veramoEndpoint = DEFAULT_VERAMO_ENDPOINT.replace(/\/+$/, "");
  const didResponse = await getJson(`${veramoEndpoint}/get_own_did`);
  const dids = Array.isArray(didResponse?.dids) ? didResponse.dids : [];
  const did = authorDid || String(dids[0] || "").trim();
  if (!did) {
    throw new Error("No author DID available. Set AUTHOR_DID or start the Veramo wallet first.");
  }
  const parsed = tryParseEthrDidAddress(did);
  if (parsed) {
    return { did, address: parsed, source: "did:ethr address" };
  }

  const docResponse = await getJson(
    `${veramoEndpoint}/get_did_doc?did=${encodeURIComponent(did)}`,
  );
  const secpKey = Array.isArray(docResponse?.keys)
    ? docResponse.keys.find((key: any) => key?.type === "Secp256k1")
    : null;
  const providerValue = String(docResponse?.provider || "").trim();
  const controllerTail = String(docResponse?.controllerKeyId || "").trim().split("#")[0].split(":").pop() || "";
  const candidate =
    (ethers.isAddress(providerValue) ? providerValue : "") ||
    tryComputeAddressFromPublicKey(String(secpKey?.publicKeyHex || "")) ||
    tryComputeAddressFromPublicKey(String(docResponse?.controllerKeyId || "")) ||
    (ethers.isAddress(controllerTail) ? controllerTail : "") ||
    "";
  if (!candidate || !ethers.isAddress(candidate)) {
    throw new Error(`Unable to resolve Ethereum address for author DID ${did}`);
  }
  return {
    did,
    address: ethers.getAddress(candidate),
    source: `${veramoEndpoint}/get_did_doc`,
  };
}

async function main() {
  const targetBalance = parsePositiveEthEnv("AUTHOR_TARGET_BALANCE_ETH", DEFAULT_TARGET_BALANCE_ETH);
  const gasReserve = parsePositiveEthEnv("AUTHOR_FUNDER_GAS_RESERVE_ETH", "0.005");
  const target = await resolveAuthorAddress();

  const [funder] = await ethers.getSigners();
  if (!funder) {
    throw new Error("No funder signer available. Set PRIVATE_KEY in Oracles/CAVSonOCR/.env for Sepolia.");
  }

  const [funderBalance, currentBalance] = await Promise.all([
    ethers.provider.getBalance(funder.address),
    ethers.provider.getBalance(target.address),
  ]);
  if (funderBalance <= gasReserve) {
    throw new Error(
      `Insufficient balance on funder ${funder.address}. Balance ${formatEth(funderBalance)} ETH, reserve ${formatEth(gasReserve)} ETH.`,
    );
  }

  const missingBalance = currentBalance >= targetBalance ? 0n : targetBalance - currentBalance;
  const baseResult = {
    network: networkName,
    funder: funder.address,
    funderBalanceWei: funderBalance.toString(),
    currentBalanceWei: currentBalance.toString(),
    targetBalanceWei: targetBalance.toString(),
    gasReserveWei: gasReserve.toString(),
    authorDid: target.did || "",
    authorAddress: target.address,
    source: target.source,
  };

  if (target.address.toLowerCase() === funder.address.toLowerCase()) {
    emit(
      {
        ...baseResult,
        funded: false,
        action: "same-account",
        topUpWei: "0",
        txHash: "",
      },
      [
        `network=${networkName}`,
        `funder=${funder.address} balance=${formatEth(funderBalance)} ETH`,
        `authorDid=${target.did || "(not provided)"} authorAddress=${target.address} source=${target.source}`,
        `author balance already available on funder account target=${formatEth(targetBalance)} ETH`,
      ],
    );
    return;
  }
  if (missingBalance === 0n) {
    emit(
      {
        ...baseResult,
        funded: false,
        action: "none",
        topUpWei: "0",
        txHash: "",
      },
      [
        `network=${networkName}`,
        `funder=${funder.address} balance=${formatEth(funderBalance)} ETH`,
        `authorDid=${target.did || "(not provided)"} authorAddress=${target.address} source=${target.source}`,
        `author balance=${formatEth(currentBalance)} ETH target=${formatEth(targetBalance)} ETH action=none`,
      ],
    );
    return;
  }

  let receipt: Awaited<ReturnType<Awaited<ReturnType<typeof funder.sendTransaction>>["wait"]>> | null = null;
  let topUpWei = missingBalance;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const refreshedBalance = await ethers.provider.getBalance(target.address);
    if (refreshedBalance >= targetBalance) {
      topUpWei = 0n;
      break;
    }
    topUpWei = targetBalance - refreshedBalance;
    try {
      const tx = await funder.sendTransaction({
        to: target.address,
        value: topUpWei,
        ...(await fundingTxOverrides(funder.address, attempt)),
      });
      receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Funding tx ${tx.hash} reverted`);
      }
      break;
    } catch (error) {
      if (!isReplacementFeeError(error) || attempt >= 6) {
        throw error;
      }
      await sleep(1000 * attempt);
    }
  }

  if (topUpWei > 0n && !receipt) {
    throw new Error("Funding tx was not submitted");
  }

  emit(
    {
      ...baseResult,
      funded: Boolean(receipt),
      action: receipt ? "top-up" : "none",
      topUpWei: topUpWei.toString(),
      txHash: receipt?.hash || "",
    },
    [
      `network=${networkName}`,
      `funder=${funder.address} balance=${formatEth(funderBalance)} ETH`,
      `authorDid=${target.did || "(not provided)"} authorAddress=${target.address} source=${target.source}`,
      receipt
        ? `authorAddress=${target.address} toppedUp=${formatEth(topUpWei)} ETH target=${formatEth(targetBalance)} ETH tx=${receipt.hash}`
        : `author balance reached target=${formatEth(targetBalance)} ETH action=none`,
    ],
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
