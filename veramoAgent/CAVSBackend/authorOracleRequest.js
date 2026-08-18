import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { ethers } from 'ethers';
import { KZG } from 'micro-eth-signer/kzg';
import { trustedSetup } from '@paulmillr/trusted-setups/fast.js';

const CAVS_ORACLE_COORDINATOR_ABI = [
    'function oracleCount() view returns (uint8)',
    'function registeredOracleCount() view returns (uint256)',
    'function getRegisteredOracleIds() view returns (uint8[])',
    'function getOracle(uint8 oracleId) view returns (tuple(uint8 oracleId,address account,string did,bytes32 oraclesEncryptionKey,bool active,uint64 updatedAt))',
];

const CAVS_REQUEST_REGISTRY_ABI = [
    'function submitBlobRequest(bytes32 requestID,bytes32 oracleSetID,uint64 nonce,uint64 deadline,tuple(uint8 oracleId,bytes32 ephemeralPublicKey,bytes12 nonce,bytes wrappedARequestKey)[] keyEnvelopes)',
    'event CAVSRequestSubmitted(bytes32 indexed requestID,bytes32 indexed oracleSetID,address indexed requester,uint64 nonce,uint64 deadline,bytes32 blobHash,tuple(uint8 oracleId,bytes32 ephemeralPublicKey,bytes12 nonce,bytes wrappedARequestKey)[] keyEnvelopes)',
];

const OCR_REGISTRY_DIR = process.env.OCR_REGISTRY_DIR || '/registry';
const OCR_DEPLOYMENT_FILE = path.join(OCR_REGISTRY_DIR, 'ocr-contract-deployment.json');
const OCR_REQUEST_BLOB_CACHE_DIR = path.join(OCR_REGISTRY_DIR, 'request-blobs');
const OCR_REQUEST_SESSION_CACHE_DIR = path.join(OCR_REGISTRY_DIR, 'request-sessions');
const ORACLE_REQUEST_TIMEOUT_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_ORACLE_REQUEST_TIMEOUT_MS,
    0,
);
const ORACLE_REQUEST_RETENTION_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_ORACLE_REQUEST_RETENTION_MS,
    1800000,
);
const ORACLE_ACTIVE_REQUEST_RETENTION_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_ORACLE_ACTIVE_REQUEST_RETENTION_MS,
    86400000,
);
const AUTHOR_REQUEST_BLOB_GAS_LIMIT = normalizeBlobGasLimit(process.env.AUTHOR_REQUEST_BLOB_GAS_LIMIT || '5000000');
const BLOB_FIELD_ELEMENTS = 4096;
const BLOB_ELEMENT_BYTES = 32;
const BLOB_PAYLOAD_BYTES_PER_ELEMENT = 31;
const BLOB_TOTAL_BYTES = BLOB_FIELD_ELEMENTS * BLOB_ELEMENT_BYTES;
const BLOB_MAX_PAYLOAD_BYTES = BLOB_FIELD_ELEMENTS * BLOB_PAYLOAD_BYTES_PER_ELEMENT;
const HASH_ZERO = ethers.ZeroHash || ethers.constants?.HashZero || `0x${'00'.repeat(32)}`;
const ethersCompat = ethers.utils || ethers;
const AUTHOR_ORACLE_REQUEST_CALLBACK_BASE_URL = normalizeOptionalString(
    process.env.AUTHOR_ORACLE_REQUEST_CALLBACK_BASE_URL,
);

const sessions = new Map();
const requestSubmissionQueues = new Map();
const oracleRegistryCache = new Map();
const authorSignerCache = new Map();
const AUTHOR_SIGN_RETRY_ATTEMPTS = Math.max(
    1,
    Math.floor(normalizeNonNegativeNumber(process.env.AUTHOR_SIGN_RETRY_ATTEMPTS, 4)),
);
const AUTHOR_SIGN_RETRY_DELAY_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_SIGN_RETRY_DELAY_MS,
    1000,
);
const AUTHOR_TX_RETRY_ATTEMPTS = Math.floor(
    normalizeNonNegativeNumber(process.env.AUTHOR_TX_RETRY_ATTEMPTS, 8),
);
const AUTHOR_NONCE_CONFLICT_RETRY_ATTEMPTS = Math.floor(
    normalizeNonNegativeNumber(process.env.AUTHOR_NONCE_CONFLICT_RETRY_ATTEMPTS, 8),
);
const AUTHOR_ZERO_BLOB_HASH_RETRY_ATTEMPTS = Math.max(
    1,
    Math.floor(normalizeNonNegativeNumber(process.env.AUTHOR_ZERO_BLOB_HASH_RETRY_ATTEMPTS, 3)),
);
const AUTHOR_RPC_RETRY_ATTEMPTS = Math.max(
    1,
    Math.floor(normalizeNonNegativeNumber(process.env.AUTHOR_RPC_RETRY_ATTEMPTS, 8)),
);
const AUTHOR_RPC_RETRY_DELAY_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_RPC_RETRY_DELAY_MS,
    1000,
);
const AUTHOR_RPC_POLL_INTERVAL_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_RPC_POLL_INTERVAL_MS,
    1000,
);
const AUTHOR_VERAMO_HTTP_TIMEOUT_MS = Math.max(
    100,
    normalizeNonNegativeNumber(process.env.AUTHOR_VERAMO_HTTP_TIMEOUT_MS, 65000),
);
const AUTHOR_TX_RECEIPT_TIMEOUT_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_TX_RECEIPT_TIMEOUT_MS,
    300000,
);
const AUTHOR_REGISTRY_CACHE_TTL_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_REGISTRY_CACHE_TTL_MS,
    5000,
);
const AUTHOR_SIGNER_CACHE_TTL_MS = normalizeNonNegativeNumber(
    process.env.AUTHOR_SIGNER_CACHE_TTL_MS,
    30000,
);
const AUTHOR_REQUEST_CACHE_MAX_ENTRIES = Math.max(
    1,
    Math.floor(normalizeNonNegativeNumber(process.env.AUTHOR_REQUEST_CACHE_MAX_ENTRIES, 32)),
);
const AUTHOR_SESSION_LOG_LIMIT = Math.max(
    1,
    Math.floor(normalizeNonNegativeNumber(process.env.AUTHOR_SESSION_LOG_LIMIT, 250)),
);
const AUTHOR_DYNAMIC_TOP_UP_TARGET_ETH = normalizeOptionalString(
    process.env.AUTHOR_DYNAMIC_TOP_UP_TARGET_ETH ||
    process.env.AUTHOR_TARGET_BALANCE_ETH ||
    '0',
);
const AUTHOR_DYNAMIC_TOP_UP_CONFIRMATIONS = Math.max(
    1,
    Math.floor(normalizeNonNegativeNumber(process.env.AUTHOR_DYNAMIC_TOP_UP_CONFIRMATIONS, 1)),
);
const AUTHOR_DYNAMIC_TOP_UP_RETRY_ATTEMPTS = Math.max(
    1,
    Math.floor(normalizeNonNegativeNumber(process.env.AUTHOR_DYNAMIC_TOP_UP_RETRY_ATTEMPTS, 3)),
);
let sharedKzg = null;

function makeProvider(rpcUrl) {
    const provider = ethers.JsonRpcProvider
        ? new ethers.JsonRpcProvider(rpcUrl)
        : new ethers.providers.JsonRpcProvider(rpcUrl);
    if (
        Number.isFinite(AUTHOR_RPC_POLL_INTERVAL_MS) &&
        AUTHOR_RPC_POLL_INTERVAL_MS >= 50
    ) {
        provider.pollingInterval = AUTHOR_RPC_POLL_INTERVAL_MS;
    }
    return provider;
}

async function closeProvider(provider) {
    if (!provider) {
        return;
    }
    try {
        if (typeof provider.destroy === 'function') {
            await provider.destroy();
        } else {
            provider.removeAllListeners?.();
            if ('polling' in provider) {
                provider.polling = false;
            }
        }
    } catch (error) {
        console.warn('Could not close requester RPC provider:', errorText(error));
    }
}

function isAddress(value) {
    return ethersCompat.isAddress(value);
}

function getAddress(value) {
    return ethersCompat.getAddress(value);
}

function getBytes(value) {
    if (typeof ethersCompat.getBytes === 'function') {
        return ethersCompat.getBytes(value);
    }
    if (typeof ethersCompat.arrayify === 'function') {
        return ethersCompat.arrayify(value);
    }
    if (typeof ethers.getBytes === 'function') {
        return ethers.getBytes(value);
    }
    if (typeof ethers.utils?.arrayify === 'function') {
        return ethers.utils.arrayify(value);
    }
    throw new Error('ethers byte conversion helpers are unavailable');
}

function computeAddressFromPublicKey(value) {
    const normalized = with0x(value);
    if (!/^0x[0-9a-fA-F]{130}$/.test(normalized)) {
        return '';
    }
    return ethers.computeAddress
        ? ethers.computeAddress(normalized)
        : ethers.utils.computeAddress(normalized);
}

function with0x(value) {
    const normalized = normalizeOptionalString(value);
    if (!normalized) return '';
    return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
}

function strip0x(value) {
    const normalized = normalizeOptionalString(value);
    if (!normalized) return '';
    return normalized.startsWith('0x') ? normalized.slice(2) : normalized;
}

function normalizeOptionalString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function normalizeNonNegativeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nowIso() {
    return new Date().toISOString();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out after ${timeoutMs}ms`);
            error.code = 'CAVS_TIMEOUT';
            reject(error);
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

function setBoundedCacheEntry(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > AUTHOR_REQUEST_CACHE_MAX_ENTRIES) {
        cache.delete(cache.keys().next().value);
    }
}

function inferLocalCallbackBaseUrl() {
    if (AUTHOR_ORACLE_REQUEST_CALLBACK_BASE_URL) {
        return AUTHOR_ORACLE_REQUEST_CALLBACK_BASE_URL.replace(/\/+$/, '');
    }
    const oracleId = normalizeOptionalString(process.env.ORACLE_ID || process.env.OCR_ORACLE_ID || '0');
    const port = normalizeOptionalString(process.env.PORT || '4200');
    return `http://cavs${oracleId}:${port}`;
}

function buildAuthorOracleRequestCallbackUrl(sessionId) {
    return `${inferLocalCallbackBaseUrl()}/ocr/author_oracle_request/callback/${encodeURIComponent(sessionId)}`;
}

function toNumber(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    return Number(value.toString?.() || value);
}

function toDecimalString(value) {
    if (value === undefined || value === null) return '0';
    return value.toString?.() || String(value);
}

function addGasBuffer(value) {
    return typeof value === 'bigint' ? (value * 12n) / 10n : value.mul(12).div(10);
}

function normalizeBlobGasLimit(value) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        return 1500000n;
    }
    return BigInt(trimmed);
}

function requireBlobTransactionSupport() {
    if (!ethers.Transaction || !ethers.Signature) {
        const error = new Error('ethers v6 blob transaction support is required for type-3 request submission');
        error.statusCode = 500;
        throw error;
    }
}

function createBlobTransaction(unsignedTx, blobBytes) {
    requireBlobTransactionSupport();
    const tx = ethers.Transaction.from(unsignedTx);
    if (!sharedKzg) {
        sharedKzg = new KZG(trustedSetup);
    }
    tx.kzg = sharedKzg;
    tx.blobs = [blobBytes];
    return tx;
}

function signBlobTransaction(blobTx, signatureHex) {
    blobTx.signature = ethers.Signature.from(signatureHex);
    return blobTx.serialized;
}

async function broadcastTransaction(provider, rawTx) {
    return provider.broadcastTransaction
        ? await provider.broadcastTransaction(rawTx)
        : await provider.sendTransaction(rawTx);
}

function errorText(value) {
    return normalizeOptionalString(
        value?.shortMessage ||
        value?.message ||
        value?.error?.message ||
        value?.info?.error?.message ||
        value?.response?.data?.error ||
        value,
    );
}

function parseEtherValue(value) {
    return ethers.parseEther
        ? ethers.parseEther(String(value))
        : ethers.utils.parseEther(String(value));
}

function formatEtherValue(value) {
    return ethers.formatEther
        ? ethers.formatEther(value)
        : ethers.utils.formatEther(value);
}

function isReplacementFeeError(error) {
    const text = errorText(error).toLowerCase();
    return text.includes('replacement fee too low') || text.includes('replacement transaction underpriced');
}

function isTransactionReplacedError(error) {
    const code = normalizeOptionalString(error?.code).toUpperCase();
    const text = errorText(error).toLowerCase();
    return code === 'TRANSACTION_REPLACED' || text.includes('transaction was replaced');
}

async function waitForBlobRequestReceipt(tx, session) {
    try {
        return await withTimeout(
            withRpcRetry('blobRequest.tx.wait', () => tx.wait()),
            AUTHOR_TX_RECEIPT_TIMEOUT_MS,
            'blob request receipt tracking',
        );
    } catch (error) {
        if (!isTransactionReplacedError(error)) {
            throw error;
        }

        const replacement = error?.replacement || null;
        let receipt = error?.receipt || null;
        if (!receipt && replacement?.wait) {
            receipt = await withRpcRetry('blobRequest.replacement.tx.wait', () => replacement.wait());
        }

        const replacementHash = normalizeOptionalString(
            replacement?.hash ||
            receipt?.hash ||
            receipt?.transactionHash,
        );
        if (replacementHash) {
            const originalHash = normalizeOptionalString(tx?.hash);
            session.registryTxHash = replacementHash;
            addSessionLog(
                session,
                originalHash && originalHash !== replacementHash
                    ? `Blob request tx ${originalHash} was replaced by mined tx ${replacementHash}.`
                    : `Blob request tx wait reported a replacement; using mined tx ${replacementHash}.`,
            );
        }

        if (receipt?.status === 1 || receipt?.status === undefined || receipt?.status === null) {
            return receipt;
        }
        throw error;
    }
}

function isNonceConflictError(error) {
    const text = errorText(error).toLowerCase();
    return text.includes('nonce too high') ||
        text.includes('nonce too low') ||
        text.includes('already known') ||
        text.includes('already imported');
}

function isInsufficientFundsError(error) {
    return errorText(error).toLowerCase().includes('insufficient funds');
}

function isZeroHash(value) {
    const normalized = normalizeOptionalString(value);
    return !normalized || normalized.toLowerCase() === HASH_ZERO.toLowerCase();
}

function requestSubmissionEventFromReceipt(requestRegistry, receipt, requestID) {
    const expectedRequestID = normalizeOptionalString(requestID).toLowerCase();
    const registryAddress = normalizeOptionalString(requestRegistry?.target || requestRegistry?.address).toLowerCase();
    for (const log of receipt?.logs || []) {
        if (registryAddress && normalizeOptionalString(log?.address).toLowerCase() !== registryAddress) {
            continue;
        }
        let parsed;
        try {
            parsed = requestRegistry.interface.parseLog(log);
        } catch {
            continue;
        }
        if (parsed?.name !== 'CAVSRequestSubmitted') {
            continue;
        }
        const emittedRequestID = normalizeOptionalString(parsed.args?.requestID).toLowerCase();
        if (emittedRequestID === expectedRequestID) {
            return parsed.args;
        }
    }
    return null;
}

function parseInsufficientFundsRequirement(value) {
    const text = normalizeOptionalString(value);
    const match = text.match(/have\s+(\d+)\s+want\s+(\d+)/i);
    if (!match) {
        return null;
    }
    return {
        haveWei: BigInt(match[1]),
        wantWei: BigInt(match[2]),
    };
}

function resolveDynamicTopUpTargetWei(reason) {
    const configured = AUTHOR_DYNAMIC_TOP_UP_TARGET_ETH && Number(AUTHOR_DYNAMIC_TOP_UP_TARGET_ETH) > 0
        ? parseEtherValue(AUTHOR_DYNAMIC_TOP_UP_TARGET_ETH)
        : 0n;
    const required = parseInsufficientFundsRequirement(reason);
    if (!required) {
        return configured;
    }
    const bufferEth = normalizeOptionalString(
        process.env.AUTHOR_DYNAMIC_TOP_UP_BUFFER_ETH ||
        process.env.DYNAMIC_TOP_UP_BUFFER_ETH ||
        '0.002',
    );
    const buffer = Number(bufferEth) > 0 ? parseEtherValue(bufferEth) : 0n;
    const requiredTarget = required.wantWei + buffer;
    return configured > requiredTarget ? configured : requiredTarget;
}

function isTransientRpcError(error) {
    const code = normalizeOptionalString(error?.code).toUpperCase();
    const text = errorText(error).toLowerCase();
    return code === 'SERVER_ERROR' ||
        code === 'TIMEOUT' ||
        code === 'ECONNRESET' ||
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        text.includes('429') ||
        text.includes('alchemy') ||
        text.includes('compute units per second capacity') ||
        text.includes('capacity exceeded') ||
        text.includes('request rate exceeded') ||
        text.includes('rate limit') ||
        text.includes('too many requests') ||
        text.includes('timeout') ||
        text.includes('deadline exceeded') ||
        text.includes('socket hang up') ||
        text.includes('connection reset') ||
        text.includes('econnreset') ||
        (
            text.includes('missing revert data') &&
            text.includes('action="call"') &&
            text.includes('data=null')
        );
}

function isRetryLimitReached(limit, attempts) {
    return Number.isFinite(limit) && limit > 0 && attempts >= limit;
}

async function withRpcRetry(label, operation, attempts = AUTHOR_RPC_RETRY_ATTEMPTS, delayMs = AUTHOR_RPC_RETRY_DELAY_MS) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!isTransientRpcError(error) || attempt >= attempts) {
                throw error;
            }
            const waitMs = delayMs * (2 ** (attempt - 1));
            console.warn(`${label} retry ${attempt}/${attempts} after transient RPC error: ${errorText(error)}`);
            await sleep(waitMs);
        }
    }
    throw lastError;
}

function resolveAuthorFunderPrivateKey() {
    const secretFile = process.env.AUTHOR_FUNDER_PRIVATE_KEY_FILE || process.env.OCR_FUNDER_PRIVATE_KEY_FILE || process.env.PRIVATE_KEY_FILE;
    let fileValue = '';
    if (secretFile) {
        try { fileValue = fs.readFileSync(secretFile, 'utf8').trim(); } catch (_) { fileValue = ''; }
    }
    return normalizeOptionalString(
        fileValue ||
        process.env.AUTHOR_FUNDER_PRIVATE_KEY ||
        process.env.OCR_FUNDER_PRIVATE_KEY ||
        process.env.PRIVATE_KEY,
    );
}

async function ensureWalletFunded(provider, address, session, reason = 'insufficient funds') {
    const target = resolveDynamicTopUpTargetWei(reason);
    if (target <= 0n) {
        throw new Error(`wallet ${address} needs funding after ${reason}, but no dynamic top-up target could be resolved`);
    }

    const normalizedAddress = getAddress(address);
    const current = await withRpcRetry(
        'dynamicTopUp.getBalance(target)',
        () => provider.getBalance(normalizedAddress),
    );
    if (current >= target) {
        addSessionLog(
            session,
            `Dynamic funding skipped for ${normalizedAddress}: balance ${formatEtherValue(current)} ETH already >= target ${formatEtherValue(target)} ETH.`,
        );
        return false;
    }

    const privateKey = resolveAuthorFunderPrivateKey();
    if (!privateKey) {
        throw new Error(`wallet ${normalizedAddress} needs funding after ${reason}, but no AUTHOR_FUNDER_PRIVATE_KEY/OCR_FUNDER_PRIVATE_KEY/PRIVATE_KEY is configured`);
    }

    const funder = new ethers.Wallet(privateKey, provider);
    if (getAddress(funder.address) === normalizedAddress) {
        throw new Error(`wallet ${normalizedAddress} needs funding after ${reason}, but the configured funder is the same wallet`);
    }

    const value = target - current;
    addSessionLog(
        session,
        `Dynamic funding ${normalizedAddress}: balance ${formatEtherValue(current)} ETH, target ${formatEtherValue(target)} ETH, sending ${formatEtherValue(value)} ETH from ${funder.address}.`,
    );
    const tx = await withRpcRetry(
        'dynamicTopUp.sendTransaction',
        () => funder.sendTransaction({ to: normalizedAddress, value }),
    );
    addSessionLog(session, `Dynamic funding tx submitted: ${tx.hash}.`);
    await withRpcRetry(
        'dynamicTopUp.tx.wait',
        () => tx.wait(AUTHOR_DYNAMIC_TOP_UP_CONFIRMATIONS),
    );
    const updated = await withRpcRetry(
        'dynamicTopUp.getBalance(updated)',
        () => provider.getBalance(normalizedAddress),
    );
    addSessionLog(
        session,
        `Dynamic funding confirmed for ${normalizedAddress}: new balance ${formatEtherValue(updated)} ETH.`,
    );
    return true;
}

async function reserveSubmissionNonce(provider, address) {
    const normalizedAddress = getAddress(address);
    // enqueueRequestSubmission serializes this address until each request is
    // mined, so an optimistic local nonce cache can only become stale.
    return await withRpcRetry('reserveSubmissionNonce', () => provider.getTransactionCount(normalizedAddress, 'pending'));
}

async function syncSubmissionNonce(provider, address) {
    const normalizedAddress = getAddress(address);
    return await withRpcRetry('syncSubmissionNonce', () => provider.getTransactionCount(normalizedAddress, 'pending'));
}

function bumpBlobFeeSettings({ maxPriorityFeePerGas, maxFeePerGas, maxFeePerBlobGas }) {
    const bumpedPriority = maxPriorityFeePerGas + (maxPriorityFeePerGas / 5n) + 1n;
    const bumpedMaxFee = maxFeePerGas + (maxFeePerGas / 5n) + bumpedPriority;
    const bumpedBlobFee = maxFeePerBlobGas + (maxFeePerBlobGas / 5n) + 1n;
    return {
        maxPriorityFeePerGas: bumpedPriority,
        maxFeePerGas: bumpedMaxFee,
        maxFeePerBlobGas: bumpedBlobFee,
    };
}

function registryError(error) {
    const status = Number(error?.statusCode) || Number(error?.response?.status) || 502;
    const detail = error?.response?.data || error?.message || String(error);
    return {
        status,
        body: {
            ok: false,
            error: typeof detail === 'string' ? detail : detail?.error || 'oracle request failed',
            detail,
        },
    };
}

function collectErrorTextParts(value, parts, depth = 0) {
    if (value === null || value === undefined || depth > 4) {
        return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        parts.push(String(value));
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectErrorTextParts(item, parts, depth + 1);
        }
        return;
    }
    if (typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
            if (key === 'stack') continue;
            collectErrorTextParts(entry, parts, depth + 1);
        }
    }
}

function isMissingBlobHashEstimateError(error) {
    const parts = [];
    collectErrorTextParts(error, parts);
    const text = parts.join(' | ').toLowerCase();
    return text.includes('0x94245241') || text.includes('missingblobhash');
}

function readLocalDeployment() {
    try {
        if (!fs.existsSync(OCR_DEPLOYMENT_FILE)) {
            return null;
        }
        const raw = JSON.parse(fs.readFileSync(OCR_DEPLOYMENT_FILE, 'utf8'));
        const contractAddress = normalizeOptionalString(raw?.contract_address);
        const requestRegistryAddress = normalizeOptionalString(raw?.request_registry_address);
        if (!contractAddress || !isAddress(contractAddress)) {
            return null;
        }
        if (requestRegistryAddress && !isAddress(requestRegistryAddress)) {
            return null;
        }
        return {
            contractAddress: getAddress(contractAddress),
            requestRegistryAddress: requestRegistryAddress ? getAddress(requestRegistryAddress) : '',
            transactionHash: normalizeOptionalString(raw?.transaction_hash),
            oracleCount: raw?.oracle_count ?? null,
            deployer: normalizeOptionalString(raw?.deployer),
            source: normalizeOptionalString(raw?.source) || 'registry',
            path: OCR_DEPLOYMENT_FILE,
        };
    } catch (_error) {
        return null;
    }
}

function resolveRegistryDefaults() {
    const deployment = readLocalDeployment();
    const envContractAddress = normalizeOptionalString(process.env.OCR_CONTRACT_ADDRESS);
    return {
        rpcUrl: normalizeOptionalString(process.env.OCR_CONTRACT_RPC_URL),
        contractAddress: envContractAddress || deployment?.contractAddress || '',
        contractAddressSource: envContractAddress ? 'env' : deployment ? deployment.source : '',
        deployment,
    };
}

function resolveRpcUrl(value) {
    const rpcUrl = normalizeOptionalString(value) || resolveRegistryDefaults().rpcUrl;
    if (!rpcUrl) {
        const error = new Error('contractRpcUrl is required');
        error.statusCode = 400;
        throw error;
    }
    return rpcUrl;
}

function resolveContractAddress(value) {
    const contractAddress =
        normalizeOptionalString(value) || resolveRegistryDefaults().contractAddress;
    if (!contractAddress || !isAddress(contractAddress)) {
        const error = new Error('contractAddress must be an Ethereum address');
        error.statusCode = 400;
        throw error;
    }
    return getAddress(contractAddress);
}

function resolveRequestRegistryAddress(value) {
    const deployment = resolveRegistryDefaults().deployment;
    const requestRegistryAddress =
        normalizeOptionalString(value) ||
        normalizeOptionalString(deployment?.requestRegistryAddress) ||
        normalizeOptionalString(process.env.CAVS_REQUEST_REGISTRY_ADDRESS) ||
        normalizeOptionalString(process.env.REQUEST_REGISTRY_ADDRESS);
    if (!requestRegistryAddress || !isAddress(requestRegistryAddress)) {
        const error = new Error('requestRegistryAddress must be an Ethereum address');
        error.statusCode = 400;
        throw error;
    }
    return getAddress(requestRegistryAddress);
}

function cacheBlobPayload(requestID, blobPayload) {
    const normalizedRequestID = normalizeCachedRequestId(requestID);
    if (!normalizedRequestID || !blobPayload || typeof blobPayload !== 'object') {
        return;
    }
    fs.mkdirSync(OCR_REQUEST_BLOB_CACHE_DIR, { recursive: true });
    const filePath = path.join(OCR_REQUEST_BLOB_CACHE_DIR, `${normalizedRequestID}.json`);
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(blobPayload)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        // The request event can be observed by every oracle immediately after
        // broadcast/mining. Publish a complete cache entry in one rename so no
        // oracle can race a partially written JSON blob.
        fs.renameSync(temporary, filePath);
    } finally {
        try {
            fs.unlinkSync(temporary);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn('Could not remove temporary request blob:', errorText(error));
            }
        }
    }
}

function loadCachedBlobPayload(requestID) {
    const normalizedRequestID = normalizeCachedRequestId(requestID);
    if (!normalizedRequestID) {
        return null;
    }
    const filePath = path.join(OCR_REQUEST_BLOB_CACHE_DIR, `${normalizedRequestID}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
        return null;
    }
}

function normalizeCachedRequestId(value) {
    const normalized = normalizeOptionalString(value);
    return /^0x[0-9a-fA-F]{64}$/.test(normalized) ? normalized.toLowerCase() : '';
}

function enqueueRequestSubmission(address, task) {
    const normalizedAddress = getAddress(address);
    const previous = requestSubmissionQueues.get(normalizedAddress) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(task);
    const tracked = next
        .finally(() => {
            if (requestSubmissionQueues.get(normalizedAddress) === tracked) {
                requestSubmissionQueues.delete(normalizedAddress);
            }
        })
        .catch(() => undefined);
    requestSubmissionQueues.set(
        normalizedAddress,
        tracked,
    );
    return next;
}

// /start returns a durable session immediately and lets the chain submission
// continue in the background.  This is important because the OCR callback can
// arrive before ethers' receipt poll resolves.  Keeping the request handler
// blocked on tx.wait() hides that useful concurrency from the caller.
export async function trackBackgroundRequestSubmission(session, submission) {
    try {
        await submission;
    } catch (error) {
        const message = errorText(error) || 'unknown background request submission error';
        if (session.finalVc || session.registryTxHash || session.requestBroadcastAt) {
            // A valid final VC proves that the request reached the DON.  A late
            // receipt/RPC tracking failure must not overwrite that success.
            // Likewise, once a transaction hash exists, an RPC tracking error
            // does not prove that the already-broadcast transaction failed.
            session.requestTxTrackingError = message;
            addSessionLog(
                session,
                session.finalVc
                    ? `Request submission tracking failed after the final oracle result was received: ${message}.`
                    : `Request was broadcast, but receipt tracking failed: ${message}.`,
            );
        } else {
            session.requestTxError = message;
            addSessionLog(session, `Request submission failed in the background: ${message}.`);
        }
        refreshSessionStatus(session);
        persistSession(session);
    }
}

async function resolveAuthorSignerIdentityUncached(veramoAgentEndpoint, did) {
    const normalizedDid = normalizeOptionalString(did);
    if (!normalizedDid) {
        const error = new Error('holderDid is required to resolve the author signer');
        error.statusCode = 400;
        throw error;
    }
    const response = await axios.get(`${veramoAgentEndpoint}/get_did_doc`, {
        params: { did: normalizedDid },
        timeout: AUTHOR_VERAMO_HTTP_TIMEOUT_MS,
    });
    const identifier = response.data || {};
    const keys = Array.isArray(identifier.keys) ? identifier.keys : [];
    const kidEth = normalizeOptionalString(
        keys.find((key) => key?.type === 'Secp256k1')?.kid,
    );
    const controllerKeyId = normalizeOptionalString(identifier.controllerKeyId);
    const secpKey = keys.find((key) => key?.type === 'Secp256k1');
    const providerValue = normalizeOptionalString(identifier.provider);
    const controllerTail = normalizeOptionalString(controllerKeyId).split('#')[0].split(':').pop();
    const addressCandidate =
        (isAddress(providerValue) ? providerValue : '') ||
        computeAddressFromPublicKey(normalizeOptionalString(secpKey?.publicKeyHex)) ||
        computeAddressFromPublicKey(controllerKeyId.startsWith('0x') ? controllerKeyId : `0x${controllerKeyId}`) ||
        (isAddress(controllerTail) ? controllerTail : '');
    if (!kidEth || !addressCandidate || !isAddress(addressCandidate)) {
        const error = new Error(`unable to resolve author signer for DID ${normalizedDid}`);
        error.statusCode = 502;
        throw error;
    }
    return {
        did: normalizedDid,
        kidEth,
        address: getAddress(addressCandidate),
    };
}

async function resolveAuthorSignerIdentity(veramoAgentEndpoint, did) {
    const normalizedDid = normalizeOptionalString(did);
    const cacheKey = `${normalizeOptionalString(veramoAgentEndpoint)}|${normalizedDid}`;
    const now = Date.now();
    const cached = authorSignerCache.get(cacheKey);
    if (AUTHOR_SIGNER_CACHE_TTL_MS > 0 && cached && cached.expiresAt > now) {
        return cached.value;
    }

    const pending = resolveAuthorSignerIdentityUncached(veramoAgentEndpoint, normalizedDid);
    if (AUTHOR_SIGNER_CACHE_TTL_MS > 0) {
        setBoundedCacheEntry(authorSignerCache, cacheKey, {
            expiresAt: now + AUTHOR_SIGNER_CACHE_TTL_MS,
            value: pending,
        });
    }
    try {
        return await pending;
    } catch (error) {
        if (authorSignerCache.get(cacheKey)?.value === pending) {
            authorSignerCache.delete(cacheKey);
        }
        throw error;
    }
}

async function signDigestForAuthor({ veramoAgentEndpoint, kidEth, digestHex }) {
    let lastError = null;
    for (let attempt = 1; attempt <= AUTHOR_SIGN_RETRY_ATTEMPTS; attempt += 1) {
        try {
            const signResp = await axios.post(
                `${veramoAgentEndpoint}/ocr/eth/sign`,
                { kid_eth: kidEth, digestHex },
                { timeout: AUTHOR_VERAMO_HTTP_TIMEOUT_MS },
            );
            const signatureHex = normalizeOptionalString(signResp.data?.signatureHex);
            if (!signatureHex) {
                const error = new Error('veramo /ocr/eth/sign returned empty signatureHex for author DID');
                error.statusCode = 502;
                throw error;
            }
            return signatureHex;
        } catch (error) {
            lastError = error;
            const code = normalizeOptionalString(error?.code).toUpperCase();
            const message = normalizeOptionalString(error?.message).toLowerCase();
            const retryable = code === 'ECONNRESET' || code === 'ECONNABORTED' || message.includes('socket hang up');
            if (!retryable || attempt >= AUTHOR_SIGN_RETRY_ATTEMPTS) {
                break;
            }
            await sleep(AUTHOR_SIGN_RETRY_DELAY_MS * attempt);
        }
    }
    throw lastError;
}

async function resolveBlobFeeCap(provider) {
    try {
        const raw = await provider.send('eth_blobBaseFee', []);
        return BigInt(raw) * 2n;
    } catch (error) {
        if (isTransientRpcError(error)) {
            throw error;
        }
        return 2000000000n;
    }
}

function normalizeBytes32(value, label) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        const error = new Error(`${label} cannot be empty`);
        error.statusCode = 400;
        throw error;
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
        return trimmed;
    }
    return ethersCompat.keccak256(ethersCompat.toUtf8Bytes(trimmed));
}

function normalizeBlobPayload(input) {
    if (input === undefined || input === null) {
        const error = new Error('encryptedBlobPayload is required; plaintext oracle fan-out is disabled');
        error.statusCode = 400;
        throw error;
    }

    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!trimmed) {
            const error = new Error('encryptedBlobPayload cannot be empty');
            error.statusCode = 400;
            throw error;
        }
        if (/^0x[0-9a-fA-F]*$/.test(trimmed)) {
            return JSON.parse(ethersCompat.toUtf8String(getBytes(trimmed)));
        }
        return JSON.parse(trimmed);
    }
    return input;
}

function deriveOracleSetID(contractAddress, oracleIds) {
    return ethersCompat.keccak256(
        ethersCompat.toUtf8Bytes(
            `cavs-oracle-set-v1:${getAddress(contractAddress)}:${oracleIds.map(String).join(',')}`,
        ),
    );
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function requestAAD(kind, oracleSetID, oracleID) {
    return Buffer.from(`CAVS encrypted request|${kind}|${oracleSetID}|${oracleID}`, 'utf8');
}

function sealChaCha(key, nonce, plaintext, aad) {
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function rawX25519PublicKey(key) {
    return key.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function x25519PublicKeyFromRaw(raw) {
    const spkiPrefix = Buffer.from('302a300506032b656e032100', 'hex');
    return crypto.createPublicKey({
        key: Buffer.concat([spkiPrefix, raw]),
        format: 'der',
        type: 'spki',
    });
}

function deriveWrapKey(shared, oracleSetID, oracleID) {
    const info = Buffer.from(`CAVS request key wrap v1|${oracleSetID}|${oracleID}`, 'utf8');
    return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
}

function canonicalizeKeyEnvelopesForCommitment(keyEnvelopes) {
    return (Array.isArray(keyEnvelopes) ? keyEnvelopes : []).map((envelope) => ({
        oracleId: toNumber(envelope.oracleId),
        ephemeralPublicKey: strip0x(envelope.ephemeralPublicKey),
        nonce: strip0x(envelope.nonce),
        wrappedKey: strip0x(envelope.wrappedKey || envelope.wrappedARequestKey),
    }));
}

function normalizeKeyEnvelopesForContract(keyEnvelopes) {
    return (Array.isArray(keyEnvelopes) ? keyEnvelopes : []).map((envelope) => ({
        oracleId: toNumber(envelope.oracleId),
        ephemeralPublicKey: with0x(envelope.ephemeralPublicKey),
        nonce: with0x(envelope.nonce),
        wrappedARequestKey: with0x(envelope.wrappedARequestKey || envelope.wrappedKey),
    }));
}

function canonicalRequestCommitmentBytes(blobPayload, keyEnvelopes) {
    return ethersCompat.toUtf8Bytes(JSON.stringify({
        version: 'cavs-request-v1',
        oracleSetID: blobPayload.oracleSetID,
        algorithm: blobPayload.algorithm,
        deadline: blobPayload.deadline,
        blobPayload,
        keyEnvelopes: canonicalizeKeyEnvelopesForCommitment(keyEnvelopes),
    }));
}

function encodeBlobPayloadBytes(blobPayloadBytes) {
    if (!(blobPayloadBytes instanceof Uint8Array)) {
        blobPayloadBytes = Uint8Array.from(blobPayloadBytes || []);
    }
    if (blobPayloadBytes.length + 4 > BLOB_MAX_PAYLOAD_BYTES) {
        const error = new Error(
            `encrypted blob payload too large (${blobPayloadBytes.length} bytes > ${BLOB_MAX_PAYLOAD_BYTES - 4} max)`,
        );
        error.statusCode = 400;
        throw error;
    }

    const payloadLane = new Uint8Array(BLOB_MAX_PAYLOAD_BYTES);
    const payloadLength = blobPayloadBytes.length;
    payloadLane[0] = (payloadLength >>> 24) & 0xff;
    payloadLane[1] = (payloadLength >>> 16) & 0xff;
    payloadLane[2] = (payloadLength >>> 8) & 0xff;
    payloadLane[3] = payloadLength & 0xff;
    payloadLane.set(blobPayloadBytes, 4);

    const blobBytes = new Uint8Array(BLOB_TOTAL_BYTES);
    for (let i = 0; i < BLOB_FIELD_ELEMENTS; i += 1) {
        const payloadOffset = i * BLOB_PAYLOAD_BYTES_PER_ELEMENT;
        const blobOffset = i * BLOB_ELEMENT_BYTES + 1;
        blobBytes.set(
            payloadLane.subarray(
                payloadOffset,
                payloadOffset + BLOB_PAYLOAD_BYTES_PER_ELEMENT,
            ),
            blobOffset,
        );
    }
    return blobBytes;
}

function buildEncryptedRequestArtifacts({
    oracleSetID,
    recipients,
    requesterEndpoint,
    statement,
    holderDid,
    statementHash,
    presentation,
    nonce,
    deadline,
}) {
    if (!recipients.length) {
        const error = new Error('no active oracle encryption recipients are registered');
        error.statusCode = 409;
        throw error;
    }
    const normalizedStatement = normalizeOptionalString(statement);
    const payload = {
        version: 'cavs-request-v1',
        oracleSetID,
        requesterEndpoint: normalizeOptionalString(requesterEndpoint),
        holderDid: normalizeOptionalString(holderDid),
        ...(normalizedStatement ? { statement: normalizedStatement } : {}),
        statementHash: normalizeOptionalString(statementHash) || sha256Hex(normalizedStatement),
        ...(presentation ? { presentation } : {}),
        nonce: nonce.toString(),
        deadline: Number(deadline.toString()),
    };
    const aEncryKey = crypto.randomBytes(32);
    const payloadNonce = crypto.randomBytes(12);
    const ciphertext = sealChaCha(
        aEncryKey,
        payloadNonce,
        Buffer.from(JSON.stringify(payload), 'utf8'),
        requestAAD('payload', oracleSetID, -1),
    );

    const keyEnvelopes = recipients.map((recipient) => {
        const oEncryKey = Buffer.from(getBytes(recipient.oraclesEncryptionKey));
        if (
            oEncryKey.length !== 32 ||
            normalizeOptionalString(recipient.oraclesEncryptionKey).toLowerCase() === HASH_ZERO.toLowerCase()
        ) {
            const error = new Error(`oracle ${recipient.oracleId} has no announced OEncryKey`);
            error.statusCode = 409;
            throw error;
        }
        const ephemeral = crypto.generateKeyPairSync('x25519');
        const shared = crypto.diffieHellman({
            privateKey: ephemeral.privateKey,
            publicKey: x25519PublicKeyFromRaw(oEncryKey),
        });
        const wrapNonce = crypto.randomBytes(12);
        const wrappedKey = sealChaCha(
            deriveWrapKey(shared, oracleSetID, recipient.oracleId),
            wrapNonce,
            aEncryKey,
            requestAAD('key', oracleSetID, recipient.oracleId),
        );
        return {
            oracleId: recipient.oracleId,
            ephemeralPublicKey: with0x(rawX25519PublicKey(ephemeral.publicKey).toString('hex')),
            nonce: with0x(wrapNonce.toString('hex')),
            wrappedARequestKey: with0x(wrappedKey.toString('hex')),
        };
    });

    const blobPayload = {
        version: 'cavs-request-v1',
        oracleSetID,
        algorithm: 'X25519-HKDF-SHA256+ChaCha20Poly1305',
        nonce: payloadNonce.toString('hex'),
        deadline: Number(deadline.toString()),
        ciphertext: ciphertext.toString('hex'),
    };
    const blobBytes = encodeBlobPayloadBytes(
        ethersCompat.toUtf8Bytes(JSON.stringify(blobPayload)),
    );
    const requestID = ethersCompat.keccak256(canonicalRequestCommitmentBytes(blobPayload, keyEnvelopes));
    return {
        blobPayload,
        blobBytes,
        keyEnvelopes,
        requestID,
    };
}

function normalizeUint64(value, label) {
    const asString = normalizeOptionalString(value);
    if (!asString) {
        const error = new Error(`${label} is required`);
        error.statusCode = 400;
        throw error;
    }
    const parsed = BigInt(asString);
    if (parsed < 0n || parsed > 18446744073709551615n) {
        const error = new Error(`${label} must fit uint64`);
        error.statusCode = 400;
        throw error;
    }
    return parsed;
}

function normalizeOracleRegistration(registration) {
    if (!registration) {
        return null;
    }
    const account = normalizeOptionalString(registration.account);
    return {
        oracleId: toNumber(registration.oracleId),
        account: isAddress(account) ? getAddress(account) : account,
        did: registration.did || '',
        oraclesEncryptionKey: normalizeOptionalString(registration.oraclesEncryptionKey),
        active: Boolean(registration.active),
        updatedAt: toDecimalString(registration.updatedAt),
    };
}

async function readOracleRegistry(provider, contract, contractAddress) {
    const [network, oracleCountRaw, registeredCountRaw, registeredIdsRaw] = await Promise.all([
        withRpcRetry('readOracleRegistry.getNetwork', () => provider.getNetwork()),
        withRpcRetry('readOracleRegistry.oracleCount', () => contract.oracleCount()),
        withRpcRetry('readOracleRegistry.registeredOracleCount', () => contract.registeredOracleCount()),
        withRpcRetry('readOracleRegistry.getRegisteredOracleIds', () => contract.getRegisteredOracleIds()),
    ]);
    const registeredOracleIds = registeredIdsRaw.map((id) => toNumber(id));
    const oracles = (
        await Promise.all(
            registeredOracleIds.map(async (oracleId) => {
                const registration = await withRpcRetry(
                    `readOracleRegistry.getOracle(${oracleId})`,
                    () => contract.getOracle(oracleId),
                );
                return normalizeOracleRegistration(registration);
            }),
        )
    ).filter(Boolean);
    return {
        chainId: toNumber(network.chainId),
        contractAddress,
        oracleCount: toNumber(oracleCountRaw),
        registeredOracleCount: toDecimalString(registeredCountRaw),
        registeredOracleIds,
        oracles,
    };
}

async function readOracleRegistryCached(provider, contract, contractAddress, rpcUrl) {
    if (AUTHOR_REGISTRY_CACHE_TTL_MS <= 0) {
        return readOracleRegistry(provider, contract, contractAddress);
    }
    const rpcFingerprint = crypto
        .createHash('sha256')
        .update(normalizeOptionalString(rpcUrl), 'utf8')
        .digest('hex')
        .slice(0, 16);
    const cacheKey = `${rpcFingerprint}|${getAddress(contractAddress)}`;
    const now = Date.now();
    const cached = oracleRegistryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const pending = readOracleRegistry(provider, contract, contractAddress);
    setBoundedCacheEntry(oracleRegistryCache, cacheKey, {
        expiresAt: now + AUTHOR_REGISTRY_CACHE_TTL_MS,
        value: pending,
    });
    try {
        return await pending;
    } catch (error) {
        if (oracleRegistryCache.get(cacheKey)?.value === pending) {
            oracleRegistryCache.delete(cacheKey);
        }
        throw error;
    }
}

function cleanupExpiredSessions() {
    const now = Date.now();
    const terminalStatuses = new Set(['done', 'failed', 'timeout', 'partial', 'error']);
    for (const [sessionId, session] of sessions.entries()) {
        const terminal = terminalStatuses.has(normalizeOptionalString(session.status));
        const retentionMs = terminal
            ? ORACLE_REQUEST_RETENTION_MS
            : ORACLE_ACTIVE_REQUEST_RETENTION_MS;
        const referenceMs = terminal
            ? Number(session.updatedAtMs || session.createdAtMs || 0)
            : Number(session.createdAtMs || 0);
        if (retentionMs > 0 && referenceMs > 0 && now - referenceMs > retentionMs) {
            sessions.delete(sessionId);
            removePersistedSession(sessionId);
        }
    }
}

function createSessionId() {
    return `oracle-${crypto.randomUUID()}`;
}

function addSessionLog(session, message, persist = true) {
    const line = `[${nowIso()}] ${message}`;
    session.logs.push(line);
    if (session.logs.length > AUTHOR_SESSION_LOG_LIMIT) {
        session.logs.splice(0, session.logs.length - AUTHOR_SESSION_LOG_LIMIT);
    }
    session.updatedAt = nowIso();
    session.updatedAtMs = Date.now();
    if (persist) {
        persistSession(session);
    }
}

function normalizeSessionId(value) {
    const normalized = normalizeOptionalString(value);
    return /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : '';
}

function requestSessionCachePath(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) {
        throw new Error('invalid oracle request session id');
    }
    return path.join(OCR_REQUEST_SESSION_CACHE_DIR, `${normalized}.json`);
}

function removePersistedSession(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) {
        return;
    }
    try {
        fs.rmSync(requestSessionCachePath(normalized), { force: true });
    } catch (_error) {
        // ignore cache cleanup failures
    }
}

function persistSession(session) {
    const sessionId = normalizeSessionId(session?.sessionId);
    if (!sessionId || !session || typeof session !== 'object') {
        return;
    }
    fs.mkdirSync(OCR_REQUEST_SESSION_CACHE_DIR, { recursive: true });
    const destination = requestSessionCachePath(sessionId);
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(session)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporary, destination);
    } finally {
        try {
            fs.rmSync(temporary, { force: true });
        } catch (_error) {
            // ignore cleanup failure for an already-renamed temporary file
        }
    }
}

function loadPersistedSession(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) {
        return null;
    }
    const filePath = requestSessionCachePath(normalized);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        parsed.sessionId = normalized;
        parsed.logs = Array.isArray(parsed.logs) ? parsed.logs : [];
        parsed.oracles = Array.isArray(parsed.oracles) ? parsed.oracles : [];
        parsed.authorSkills = Array.isArray(parsed.authorSkills) ? parsed.authorSkills : [];
        parsed.createdAtMs = Number(parsed.createdAtMs)
            || Date.parse(parsed.createdAt || '')
            || Date.now();
        parsed.updatedAtMs = Number(parsed.updatedAtMs)
            || Date.parse(parsed.updatedAt || '')
            || parsed.createdAtMs;
        sessions.set(normalized, parsed);
        return parsed;
    } catch (_error) {
        return null;
    }
}

function getSession(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) {
        return null;
    }
    return sessions.get(normalized) || loadPersistedSession(normalized);
}

function findPersistedSessionByRequestId(requestID) {
    const normalizedRequestID = normalizeCachedRequestId(requestID);
    if (!normalizedRequestID || !fs.existsSync(OCR_REQUEST_SESSION_CACHE_DIR)) {
        return null;
    }
    try {
        for (const entry of fs.readdirSync(OCR_REQUEST_SESSION_CACHE_DIR)) {
            if (!entry.endsWith('.json')) {
                continue;
            }
            const filePath = path.join(OCR_REQUEST_SESSION_CACHE_DIR, entry);
            try {
                const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (normalizeCachedRequestId(parsed?.requestID) === normalizedRequestID) {
                    return parsed;
                }
            } catch (_error) {
                // ignore unreadable session files during recovery scans
            }
        }
    } catch (_error) {
        return null;
    }
    return null;
}

function recoverSessionFromCallback(sessionId, incomingResult) {
    const requestedSessionId = normalizeSessionId(sessionId);
    const requestID = normalizeOptionalString(incomingResult?.requestId);
    if (!requestedSessionId || !requestID) {
        return null;
    }

    const persisted = findPersistedSessionByRequestId(requestID);
    if (persisted) {
        const recovered = normalizeOptionalString(persisted.sessionId) === requestedSessionId
            ? persisted
            : {
                ...persisted,
                sessionId: requestedSessionId,
                logs: Array.isArray(persisted.logs) ? [...persisted.logs] : [],
            };
        sessions.set(requestedSessionId, recovered);
        persistSession(recovered);
        return recovered;
    }

    const cachedBlob = loadCachedBlobPayload(requestID);
    const defaults = resolveRegistryDefaults();
    const deployment = defaults.deployment;
    const now = nowIso();
    const recovered = {
        sessionId: requestedSessionId,
        status: 'waiting',
        createdAt: now,
        createdAtMs: Date.now(),
        updatedAt: now,
        updatedAtMs: Date.now(),
        contractRpcUrl: defaults.rpcUrl || '',
        contractAddress: defaults.contractAddress || '',
        requestRegistryAddress: normalizeOptionalString(deployment?.requestRegistryAddress),
        chainId: deployment?.chainId ?? null,
        requestID,
        oracleSetID: normalizeOptionalString(incomingResult?.oracleSetID) || normalizeOptionalString(cachedBlob?.oracleSetID),
        registryTxHash: '',
        gasUsed: '',
        effectiveGasPriceWei: '',
        blockNumber: null,
        requestSubmittedAt: null,
        requestMinedAt: null,
        requestMinedObservedAt: null,
        requestBlockTimestamp: null,
        requestTxDurationMs: null,
        requestTxError: '',
        requestTxTrackingError: '',
        requestBroadcastStartedAt: null,
        requestBroadcastAt: null,
        requestReceiptObservedAt: null,
        resultReceivedAt: null,
        completedAt: null,
        blobHash: '',
        oracleCount: deployment?.oracleCount ?? null,
        registeredOracleCount: '',
        logs: [],
        finalResult: null,
        finalVc: null,
        attestation: null,
        authorSkills: [],
        submittedOracleCount: 0,
        completedOracleCount: 0,
        failedOracleCount: 0,
        oracles: [],
    };
    sessions.set(requestedSessionId, recovered);
    addSessionLog(
        recovered,
        `Recovered missing requester session from oracle callback for requestId=${requestID}.`,
    );
    persistSession(recovered);
    return recovered;
}

function normalizeSkillPair(label, uri) {
    const normalizedLabel = normalizeOptionalString(label);
    const normalizedUri = normalizeOptionalString(uri);
    if (!normalizedLabel || !normalizedUri) {
        return null;
    }
    return { label: normalizedLabel, uri: normalizedUri };
}

function parseSkillValue(value) {
    if (!value) {
        return null;
    }
    if (Array.isArray(value)) {
        return normalizeSkillPair(value[0], value[1]);
    }
    if (typeof value === 'object') {
        return normalizeSkillPair(
            value.label || value.name || value.skill || value[0],
            value.uri || value.id || value.match_id || value[1],
        );
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        if (trimmed.includes('|')) {
            const [label, ...rest] = trimmed.split('|');
            return normalizeSkillPair(label, rest.join('|'));
        }
        const httpIndex = trimmed.search(/https?:\/\//i);
        if (httpIndex > 0) {
            return normalizeSkillPair(trimmed.slice(0, httpIndex), trimmed.slice(httpIndex));
        }
    }
    return null;
}

function extractAuthorSkillsFromCredentials(credentials) {
    const unique = new Map();

    for (const credential of credentials || []) {
        const subject = credential?.credentialSubject;
        const skills = subject?.skills;
        if (!skills) {
            continue;
        }

        if (Array.isArray(skills)) {
            for (const entry of skills) {
                const parsed = parseSkillValue(entry);
                if (parsed) {
                    unique.set(`${parsed.label}|${parsed.uri}`, parsed);
                }
            }
            continue;
        }

        if (typeof skills === 'object') {
            for (const value of Object.values(skills)) {
                const parsed = parseSkillValue(value);
                if (parsed) {
                    unique.set(`${parsed.label}|${parsed.uri}`, parsed);
                }
            }
            continue;
        }

        const parsed = parseSkillValue(skills);
        if (parsed) {
            unique.set(`${parsed.label}|${parsed.uri}`, parsed);
        }
    }

    return [...unique.values()];
}

function summarizeOracleResult(payload) {
    return {
        requestId: normalizeOptionalString(payload?.requestId),
        statementHash: normalizeOptionalString(payload?.statementHash),
        competent: Boolean(payload?.competent),
        confidence: Number(payload?.confidence ?? 0),
        reason: normalizeOptionalString(payload?.reason),
        holderDid: normalizeOptionalString(payload?.holderDid),
        hasVc: Boolean(payload?.vc),
        skillsCount: Array.isArray(payload?.skills) ? payload.skills.length : 0,
        attestation: extractAttestation(payload),
    };
}

// extractAttestation pulls the off-chain attestation envelope written by the
// oracle transmitter onto the relayed outcome. The envelope lists every oracle
// that contributed a valid report signature and the f+1 threshold any subset
// of them must satisfy. Returns null if the relay did not carry an envelope
// (e.g. pre-upgrade oracles that still send only the consensus outcome).
function extractAttestation(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const rawSigners = payload.attestedSignerOracleIds
        ?? payload.attestedSignerOracleIDs
        ?? payload.attested_signer_oracle_ids;
    if (!Array.isArray(rawSigners) || rawSigners.length === 0) {
        return null;
    }
    const signerOracleIds = Array.from(
        new Set(
            rawSigners
                .map((value) => parseInt(String(value), 10))
                .filter((value) => Number.isInteger(value) && value >= 0),
        ),
    ).sort((a, b) => a - b);
    if (signerOracleIds.length === 0) {
        return null;
    }
    const threshold = Number(
        payload.attestedThreshold
        ?? payload.attested_threshold
        ?? 0,
    );
    return {
        signerOracleIds,
        threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : signerOracleIds.length,
        seqNr: Number(payload.attestedSeqNr ?? payload.attested_seq_nr ?? 0) || 0,
        configDigest: normalizeOptionalString(
            payload.attestedConfigDigest ?? payload.attested_config_digest,
        ),
    };
}

function normalizeOracleIdList(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return Array.from(
        new Set(
            raw
                .map((value) => parseInt(String(value), 10))
                .filter((value) => Number.isInteger(value) && value >= 0),
        ),
    ).sort((a, b) => a - b);
}

export function refreshSessionStatus(session) {
    const completedCount = session.oracles.filter((oracle) => oracle.result).length;
    const failedCount = session.oracles.filter((oracle) => oracle.error).length;
    const submittedCount = session.oracles.filter((oracle) => oracle.requestId || oracle.submissionStatus === 'pending').length;
    const hasTimedOut = ORACLE_REQUEST_TIMEOUT_MS > 0
        && (Date.now() - session.createdAtMs > ORACLE_REQUEST_TIMEOUT_MS);

    session.completedOracleCount = completedCount;
    session.failedOracleCount = failedCount;
    session.submittedOracleCount = submittedCount;

    if (session.finalResult?.vc && !session.finalVc) {
        session.finalVc = session.finalResult.vc;
    }

    // A final VC is authoritative proof of success. It must win races with a
    // prior broadcast/receipt tracking error recorded by the background task.
    if (session.finalVc) {
        session.status = 'done';
        session.completedAt = session.completedAt || nowIso();
        return;
    }

    if (session.requestTxError) {
        session.status = 'failed';
        return;
    }

    if (session.finalResult) {
        session.status = session.attestation && !session.vcMintError ? 'vc_pending' : 'partial';
        return;
    }

    // Apply the request deadline even if receipt observation is unavailable;
    // otherwise a lost RPC poll leaves the session in request_pending forever.
    if (hasTimedOut) {
        session.status = 'timeout';
        return;
    }

    if (!session.requestMinedAt) {
        session.status = session.registryTxHash ? 'request_pending' : 'submitting';
        return;
    }

    if (completedCount + failedCount >= session.oracles.length && session.oracles.length > 0) {
        session.status = session.finalVc ? 'done' : 'partial';
        if (session.status === 'done') {
            session.completedAt = session.completedAt || nowIso();
        }
        return;
    }

    if (submittedCount > 0) {
        session.status = 'waiting';
        return;
    }

    session.status = 'error';
}

function publicSession(session) {
    refreshSessionStatus(session);
    return {
        ok: true,
        sessionId: session.sessionId,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        contractRpcUrl: session.contractRpcUrl,
        contractAddress: session.contractAddress,
        requestRegistryAddress: session.requestRegistryAddress || '',
        chainId: session.chainId,
        requestID: session.requestID || '',
        oracleSetID: session.oracleSetID || '',
        blobHash: session.blobHash || '',
        registryTxHash: session.registryTxHash || '',
        gasUsed: session.gasUsed || '',
        effectiveGasPriceWei: session.effectiveGasPriceWei || '',
        blockNumber: session.blockNumber || null,
        requestSubmittedAt: session.requestSubmittedAt || null,
        requestMinedAt: session.requestMinedAt || null,
        requestMinedObservedAt: session.requestMinedObservedAt || null,
        requestBlockTimestamp: session.requestBlockTimestamp || null,
        requestTxDurationMs: session.requestTxDurationMs ?? null,
        requestTxError: session.requestTxError || '',
        requestTxTrackingError: session.requestTxTrackingError || '',
        requestBroadcastStartedAt: session.requestBroadcastStartedAt || null,
        requestBroadcastAt: session.requestBroadcastAt || null,
        requestReceiptObservedAt: session.requestReceiptObservedAt || null,
        resultReceivedAt: session.resultReceivedAt || null,
        completedAt: session.completedAt || null,
        oracleCount: session.oracleCount,
        registeredOracleCount: session.registeredOracleCount,
        authorSkillCount: session.authorSkills.length,
        submittedOracleCount: session.submittedOracleCount,
        completedOracleCount: session.completedOracleCount,
        failedOracleCount: session.failedOracleCount,
        logs: [...session.logs],
        oracles: session.oracles.map((oracle) => ({
            oracleId: oracle.oracleId,
            callbackUrl: oracle.callbackUrl || '',
            did: oracle.did,
            account: oracle.account,
            requestId: oracle.requestId,
            submissionStatus: oracle.submissionStatus,
            error: oracle.error,
            resultAt: oracle.resultAt || null,
            resultSummary: oracle.result ? summarizeOracleResult(oracle.result) : null,
        })),
        finalResult: session.finalResult
            ? {
                ...summarizeOracleResult(session.finalResult),
                vc: session.finalResult.vc || null,
            }
            : null,
        finalVc: session.finalVc || null,
        vcSignerOracleIds: normalizeOracleIdList(session.vcSignerOracleIds),
        vcDroppedSignerOracleIds: normalizeOracleIdList(session.vcDroppedSignerOracleIds),
        vcUnavailableSignerOracleIds: normalizeOracleIdList(session.vcUnavailableSignerOracleIds),
        vcThreshold: session.vcThreshold || 0,
        vcMintDurationMs: session.vcMintDurationMs ?? null,
        vcMintError: session.vcMintError || '',
        attestation: session.attestation
            ?? extractAttestation(session.finalResult)
            ?? null,
    };
}

export function registerAuthorOracleRequestRoutes(app, {
    veramoAgentEndpoint,
}) {
    app.post('/ocr/author_oracle_request/start', async (req, res) => {
        cleanupExpiredSessions();
        let provider = null;

        try {
            const body = req.body || {};
            const statement = normalizeOptionalString(body.statement || body.document);
            const holderDid = normalizeOptionalString(body.holderDid || body.holderDID);
            const presentation = body.presentation || body.vp || body.verifiablePresentation || null;
            const encryptedBlobPayloadInput = body.encryptedBlobPayload || body.encryptedRequestBlob || null;
            const keyEnvelopesInput = body.keyEnvelopes || null;
            const contractRpcUrl = resolveRpcUrl(body.contractRpcUrl || body.rpcUrl);
            const contractAddress = resolveContractAddress(body.contractAddress);
            const requestRegistryAddress = resolveRequestRegistryAddress(body.requestRegistryAddress);

            if (!encryptedBlobPayloadInput && !statement) {
                return res.status(400).json({ ok: false, error: 'statement is required' });
            }
            if (!encryptedBlobPayloadInput && !holderDid) {
                return res.status(400).json({ ok: false, error: 'holderDid is required' });
            }
            if (!encryptedBlobPayloadInput && (!presentation || typeof presentation !== 'object')) {
                return res.status(400).json({ ok: false, error: 'holder verifiable presentation is required' });
            }

            provider = makeProvider(contractRpcUrl);
            const contract = new ethers.Contract(
                contractAddress,
                CAVS_ORACLE_COORDINATOR_ABI,
                provider,
            );
            const registry = await readOracleRegistryCached(
                provider,
                contract,
                contractAddress,
                contractRpcUrl,
            );
            const activeOracles = (registry.oracles || []).filter(
                (oracle) => oracle.active && normalizeOptionalString(oracle.oraclesEncryptionKey),
            );
            if (!activeOracles.length) {
                return res.status(409).json({
                    ok: false,
                    error: 'no active oracle OEncryKeys are registered in the coordinator',
                    registry,
                });
            }
            const activeOracleIds = activeOracles.map((oracle) => String(oracle.oracleId));
            const oracleSetID = body.oracleSetID
                ? normalizeBytes32(body.oracleSetID, 'oracleSetID')
                : deriveOracleSetID(contractAddress, activeOracleIds);
            const nonce = normalizeUint64(body.nonce || Date.now(), 'nonce');
            const deadline = normalizeUint64(
                body.deadline ||
                    Math.floor(Date.now() / 1000 + Number(body.deadlineSeconds || process.env.AUTHOR_ORACLE_REQUEST_DEADLINE_SECONDS || '3600')),
                'deadline',
            );
            const sessionId = createSessionId();
            const requesterEndpoint = buildAuthorOracleRequestCallbackUrl(sessionId);
            const artifacts = encryptedBlobPayloadInput
                ? (() => {
                    const blobPayload = normalizeBlobPayload(encryptedBlobPayloadInput);
                    const keyEnvelopes = Array.isArray(keyEnvelopesInput) ? keyEnvelopesInput : [];
                    if (!keyEnvelopes.length) {
                        const error = new Error('keyEnvelopes are required when supplying a prebuilt encrypted blob payload');
                        error.statusCode = 400;
                        throw error;
                    }
                    const blobBytes = encodeBlobPayloadBytes(
                        ethersCompat.toUtf8Bytes(JSON.stringify(blobPayload)),
                    );
                    const requestID = ethersCompat.keccak256(canonicalRequestCommitmentBytes(blobPayload, keyEnvelopes));
                    return { blobPayload, blobBytes, keyEnvelopes: normalizeKeyEnvelopesForContract(keyEnvelopes), requestID };
                })()
                : buildEncryptedRequestArtifacts({
                    oracleSetID,
                    recipients: activeOracles,
                    requesterEndpoint,
                    statement,
                    holderDid,
                    statementHash: body.statementHash,
                    presentation,
                    nonce,
                    deadline,
                });
            const authorSigner = await resolveAuthorSignerIdentity(veramoAgentEndpoint, holderDid);
            const requestRegistry = new ethers.Contract(
                requestRegistryAddress,
                CAVS_REQUEST_REGISTRY_ABI,
                provider,
            );
            const registryInterface = requestRegistry.interface;
            const keyEnvelopesForContract = normalizeKeyEnvelopesForContract(artifacts.keyEnvelopes);
            const txData = registryInterface.encodeFunctionData('submitBlobRequest', [
                artifacts.requestID,
                oracleSetID,
                nonce,
                deadline,
                keyEnvelopesForContract,
            ]);
            const createdAt = nowIso();
            const session = {
                sessionId,
                status: 'submitting',
                createdAt,
                createdAtMs: Date.now(),
                updatedAt: createdAt,
                updatedAtMs: Date.now(),
                contractRpcUrl,
                contractAddress,
                requestRegistryAddress,
                chainId: registry.chainId,
                requestID: artifacts.requestID,
                oracleSetID,
                registryTxHash: '',
                gasUsed: '',
                effectiveGasPriceWei: '',
                blockNumber: null,
                requestSubmittedAt: null,
                requestMinedAt: null,
                requestMinedObservedAt: null,
                requestBlockTimestamp: null,
                requestTxDurationMs: null,
                requestTxError: '',
                requestTxTrackingError: '',
                requestBroadcastStartedAt: null,
                requestBroadcastAt: null,
                requestReceiptObservedAt: null,
                resultReceivedAt: null,
                completedAt: null,
                blobHash: '',
                oracleCount: registry.oracleCount,
                registeredOracleCount: registry.registeredOracleCount,
                logs: [],
                finalResult: null,
                finalVc: null,
                attestation: null,
                authorSkills: [],
                submittedOracleCount: activeOracles.length,
                completedOracleCount: 0,
                failedOracleCount: 0,
                oracles: activeOracles.map((oracle) => ({
                    oracleId: oracle.oracleId,
                    callbackUrl: requesterEndpoint,
                    did: oracle.did,
                    account: oracle.account,
                    requestId: artifacts.requestID,
                    submissionStatus: 'pending_chain',
                    error: '',
                    result: null,
                    resultAt: null,
                })),
            };

            sessions.set(sessionId, session);
            addSessionLog(
                session,
                `Resolved ${activeOracles.length} active oracle OEncryKeys from coordinator ${contractAddress}.`,
                false,
            );
            addSessionLog(session, `Oracle callback endpoint: ${requesterEndpoint}.`, false);
            addSessionLog(session, 'Plaintext fan-out to oracle HTTP queues is disabled.', false);
            addSessionLog(
                session,
                `Preparing blob request ${artifacts.requestID} for ${requestRegistryAddress}.`,
                false,
            );
            persistSession(session);

            const queuedSubmission = enqueueRequestSubmission(authorSigner.address, async () => {
                const submissionProvider = makeProvider(contractRpcUrl);
                try {
                    const feeData = await withRpcRetry('provider.getFeeData', () => submissionProvider.getFeeData());
                    const latestBlock = await withRpcRetry('provider.getBlock(latest)', () => submissionProvider.getBlock('latest'));
                    let gasLimit;
                    try {
                        const gasEstimate = await withRpcRetry('provider.estimateGas', () => submissionProvider.estimateGas({
                            from: authorSigner.address,
                            to: requestRegistryAddress,
                            data: txData,
                            value: 0n,
                        }));
                        gasLimit = addGasBuffer(gasEstimate);
                    } catch (error) {
                        if (!isMissingBlobHashEstimateError(error)) {
                            throw error;
                        }
                        gasLimit = AUTHOR_REQUEST_BLOB_GAS_LIMIT;
                    }
                    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 1000000000n;
                    const latestBaseFee = latestBlock?.baseFeePerGas || 1000000000n;
                    let maxFeePerGas = feeData.maxFeePerGas || (latestBaseFee * 2n + maxPriorityFeePerGas);
                    let maxFeePerBlobGas = await withRpcRetry('resolveBlobFeeCap', () => resolveBlobFeeCap(submissionProvider));
                    const chainId = (await withRpcRetry('provider.getNetwork', () => submissionProvider.getNetwork())).chainId;
                    let transactionCount = await reserveSubmissionNonce(submissionProvider, authorSigner.address);
                    session.requestSubmittedAt = nowIso();
                    const requestTxStartedAtMs = Date.now();
                    let lastBroadcastError = null;
                    let broadcastAttempts = 0;
                    let replacementFeeAttempts = 0;
                    let nonceConflictAttempts = 0;
                    let insufficientFundsAttempts = 0;
                    let zeroBlobHashAttempts = 0;
                    // Publish the immutable payload to the shared cache before
                    // broadcasting. Anvil automines and the WS log notification
                    // can wake all oracles before broadcastTransaction returns;
                    // caching afterwards forced those oracles into the one-second
                    // pending-blob retry path despite a healthy local system.
                    cacheBlobPayload(artifacts.requestID, artifacts.blobPayload);
                    for (;;) {
                        let tx = null;
                        try {
                            for (;;) {
                                try {
                                    broadcastAttempts += 1;
                                    const unsignedTx = {
                                        type: 3,
                                        to: requestRegistryAddress,
                                        data: txData,
                                        nonce: transactionCount,
                                        gasLimit,
                                        value: 0n,
                                        chainId,
                                        maxPriorityFeePerGas,
                                        maxFeePerGas,
                                        maxFeePerBlobGas,
                                    };
                                    const blobTx = createBlobTransaction(unsignedTx, artifacts.blobBytes);
                                    const digestHex = blobTx.unsignedHash;
                                    const signatureHex = await signDigestForAuthor({
                                        veramoAgentEndpoint,
                                        kidEth: authorSigner.kidEth,
                                        digestHex,
                                    });
                                    const rawTx = signBlobTransaction(blobTx, signatureHex);
                                    // This causal timestamp precedes the RPC
                                    // call. A WebSocket log can reach an oracle
                                    // before the JSON-RPC response reaches this
                                    // process, so the post-response timestamp
                                    // below is not a safe event-import origin.
                                    session.requestBroadcastStartedAt = nowIso();
                                    tx = await withRpcRetry('broadcastTransaction', () => broadcastTransaction(submissionProvider, rawTx));
                                    break;
                                } catch (error) {
                                    lastBroadcastError = error;
                                    const message = errorText(error);
                                    console.warn(
                                        `authorOracleRequest broadcast attempt ${broadcastAttempts} failed for ${authorSigner.address} nonce=${transactionCount}: ${message}`,
                                    );
                                    addSessionLog(
                                        session,
                                        `Broadcast attempt ${broadcastAttempts} failed for nonce ${transactionCount}: ${message}.`,
                                    );
                                    if (isReplacementFeeError(error)) {
                                        replacementFeeAttempts += 1;
                                        ({
                                            maxPriorityFeePerGas,
                                            maxFeePerGas,
                                            maxFeePerBlobGas,
                                        } = bumpBlobFeeSettings({ maxPriorityFeePerGas, maxFeePerGas, maxFeePerBlobGas }));
                                        const syncedNonce = await syncSubmissionNonce(submissionProvider, authorSigner.address);
                                        if (syncedNonce > transactionCount) {
                                            transactionCount = syncedNonce;
                                        }
                                        if (isRetryLimitReached(AUTHOR_TX_RETRY_ATTEMPTS, replacementFeeAttempts)) {
                                            break;
                                        }
                                        await sleep(250 * Math.min(replacementFeeAttempts, 8));
                                        continue;
                                    }
                                    if (isNonceConflictError(error)) {
                                        nonceConflictAttempts += 1;
                                        transactionCount = await syncSubmissionNonce(submissionProvider, authorSigner.address);
                                        ({
                                            maxPriorityFeePerGas,
                                            maxFeePerGas,
                                            maxFeePerBlobGas,
                                        } = bumpBlobFeeSettings({ maxPriorityFeePerGas, maxFeePerGas, maxFeePerBlobGas }));
                                        if (isRetryLimitReached(AUTHOR_NONCE_CONFLICT_RETRY_ATTEMPTS, nonceConflictAttempts)) {
                                            break;
                                        }
                                        await sleep(250 * Math.min(nonceConflictAttempts, 8));
                                        continue;
                                    }
                                    if (isInsufficientFundsError(error)) {
                                        insufficientFundsAttempts += 1;
                                        if (isRetryLimitReached(AUTHOR_DYNAMIC_TOP_UP_RETRY_ATTEMPTS, insufficientFundsAttempts - 1)) {
                                            break;
                                        }
                                        await ensureWalletFunded(submissionProvider, authorSigner.address, session, message);
                                        transactionCount = await syncSubmissionNonce(submissionProvider, authorSigner.address);
                                        ({
                                            maxPriorityFeePerGas,
                                            maxFeePerGas,
                                            maxFeePerBlobGas,
                                        } = bumpBlobFeeSettings({ maxPriorityFeePerGas, maxFeePerGas, maxFeePerBlobGas }));
                                        await sleep(500 * Math.min(insufficientFundsAttempts, 8));
                                        continue;
                                    }
                                    throw error;
                                }
                            }
                        } catch (error) {
                            await syncSubmissionNonce(submissionProvider, authorSigner.address).catch(() => undefined);
                            throw error;
                        }
                        if (!tx) {
                            await syncSubmissionNonce(submissionProvider, authorSigner.address).catch(() => undefined);
                            throw lastBroadcastError || new Error('failed to broadcast blob request transaction');
                        }
                        session.registryTxHash = tx.hash;
                        session.requestTxStartedAtMs = requestTxStartedAtMs;
                        session.requestBroadcastAt = nowIso();
                        addSessionLog(
                            session,
                            `Broadcast blob request to ${requestRegistryAddress} (requestID=${artifacts.requestID}, tx=${session.registryTxHash}).`,
                        );
                        addSessionLog(session, `Author DID signer ${authorSigner.did} submitted the blob transaction from ${authorSigner.address}.`);
                        refreshSessionStatus(session);
                        persistSession(session);

                        const receipt = await waitForBlobRequestReceipt(tx, session);
                        session.requestReceiptObservedAt = nowIso();
                        session.requestMinedObservedAt = session.requestReceiptObservedAt;
                        session.requestTxDurationMs = Date.now() - requestTxStartedAtMs;
                        session.gasUsed = receipt?.gasUsed != null ? receipt.gasUsed.toString() : '';
                        session.effectiveGasPriceWei = receipt?.gasPrice != null
                            ? receipt.gasPrice.toString()
                            : (receipt?.effectiveGasPrice != null ? receipt.effectiveGasPrice.toString() : '');
                        session.blockNumber = receipt?.blockNumber != null ? Number(receipt.blockNumber) : null;
                        // High-resolution local observation. Preserve the
                        // integer-second chain timestamp separately; replacing
                        // this field with it injected up to one second of
                        // quantization noise into causal phase metrics.
                        session.requestMinedAt = session.requestMinedObservedAt;
                        if (receipt?.blockNumber != null) {
                            try {
                                const minedBlock = await withRpcRetry('provider.getBlock(mined)', () => submissionProvider.getBlock(receipt.blockNumber));
                                if (minedBlock?.timestamp != null) {
                                    session.requestBlockTimestamp = new Date(Number(minedBlock.timestamp) * 1000).toISOString();
                                }
                            } catch (error) {
                                console.warn('Could not resolve request mined block timestamp:', error?.message || error);
                            }
                        }
                        const submittedEvent = requestSubmissionEventFromReceipt(requestRegistry, receipt, artifacts.requestID);
                        session.blobHash = normalizeOptionalString(submittedEvent?.blobHash);
                        if (isZeroHash(session.blobHash)) {
                            zeroBlobHashAttempts += 1;
                            const zeroHashMessage = submittedEvent
                                ? `Request tx ${session.registryTxHash} mined but request ${artifacts.requestID} emitted zero blobHash`
                                : `Request tx ${session.registryTxHash} mined without CAVSRequestSubmitted for request ${artifacts.requestID}`;
                            if (session.finalVc) {
                                session.requestTxTrackingError = zeroHashMessage;
                                addSessionLog(
                                    session,
                                    `${zeroHashMessage}; preserving the completed request because its final VC was already received.`,
                                );
                                return { tx, receipt, requestTxStartedAtMs };
                            }
                            addSessionLog(session, `${zeroHashMessage}; retrying blob submission.`);
                            session.blobHash = '';
                            session.gasUsed = '';
                            session.effectiveGasPriceWei = '';
                            session.blockNumber = null;
                            session.requestMinedAt = null;
                            session.requestTxDurationMs = null;
                            refreshSessionStatus(session);
                            persistSession(session);
                            if (isRetryLimitReached(AUTHOR_ZERO_BLOB_HASH_RETRY_ATTEMPTS, zeroBlobHashAttempts)) {
                                await syncSubmissionNonce(submissionProvider, authorSigner.address).catch(() => undefined);
                                throw new Error(`${zeroHashMessage} after ${zeroBlobHashAttempts} attempt(s)`);
                            }
                            transactionCount = await syncSubmissionNonce(submissionProvider, authorSigner.address);
                            ({
                                maxPriorityFeePerGas,
                                maxFeePerGas,
                                maxFeePerBlobGas,
                            } = bumpBlobFeeSettings({ maxPriorityFeePerGas, maxFeePerGas, maxFeePerBlobGas }));
                            await sleep(500 * Math.min(zeroBlobHashAttempts, 8));
                            continue;
                        }
                        for (const oracle of session.oracles) {
                            if (!oracle.error) {
                                oracle.submissionStatus = 'triggered';
                            }
                        }
                        addSessionLog(
                            session,
                            `Request tx mined in ${session.requestTxDurationMs}ms at block ${session.blockNumber ?? 'unknown'}.`,
                        );
                        refreshSessionStatus(session);
                        persistSession(session);
                        return { tx, receipt, requestTxStartedAtMs };
                    }
                } finally {
                    await closeProvider(submissionProvider);
                }
            });
            void trackBackgroundRequestSubmission(session, queuedSubmission);

            refreshSessionStatus(session);
            persistSession(session);
            res.status(202).json(publicSession(session));
        } catch (error) {
            console.error('Error in /ocr/author_oracle_request/start:', error?.response?.data || error?.message || error);
            const { status, body } = registryError(error);
            res.status(status).json(body);
        } finally {
            // This provider is used only for the registry preflight. The
            // serialized background task creates its own provider when it
            // actually reaches the head of the signer queue, avoiding an idle
            // provider per queued request.
            if (provider) {
                await closeProvider(provider);
            }
        }
    });

    app.get('/ocr/author_oracle_request/status/:sessionId', (req, res) => {
        try {
            cleanupExpiredSessions();
            const session = getSession(req.params.sessionId);
            if (!session) {
                return res.status(404).json({ ok: false, error: 'unknown oracle request session' });
            }
            return res.json(publicSession(session));
        } catch (error) {
            console.error('Error reading oracle request session:', error?.message || error);
            return res.status(500).json({
                ok: false,
                error: 'could not read oracle request session',
            });
        }
    });

    async function handleOracleRequestCallback(req, res) {
        cleanupExpiredSessions();
        const incomingResult = req.body || {};
        let session = getSession(req.params.sessionId);
        if (!session) {
            session = recoverSessionFromCallback(req.params.sessionId, incomingResult);
        }
        if (!session) {
            return res.status(404).json({ ok: false, error: 'unknown oracle request session' });
        }
        const incomingRequestId = normalizeCachedRequestId(incomingResult.requestId);
        const expectedRequestId = normalizeCachedRequestId(session.requestID);
        if (!incomingRequestId || (expectedRequestId && incomingRequestId !== expectedRequestId)) {
            return res.status(409).json({
                ok: false,
                error: 'oracle callback requestId does not match the requester session',
            });
        }
        const incomingStatementHash = normalizeOptionalString(incomingResult.statementHash);
        const sameAsCurrent =
            session.finalResult &&
            normalizeCachedRequestId(session.finalResult.requestId) === incomingRequestId &&
            normalizeOptionalString(session.finalResult.statementHash) === incomingStatementHash;

        if (sameAsCurrent && session.finalVc) {
            return res.json({
                ok: true,
                duplicate: true,
                signerOracleIds: normalizeOracleIdList(session.vcSignerOracleIds),
                droppedSignerOracleIds: normalizeOracleIdList(session.vcDroppedSignerOracleIds),
                unavailableSignerOracleIds: normalizeOracleIdList(session.vcUnavailableSignerOracleIds),
                threshold: session.vcThreshold || session.attestation?.threshold || 0,
            });
        }

        const now = nowIso();
        session.resultReceivedAt = session.resultReceivedAt || now;
        if (sameAsCurrent && incomingResult?.vc && !session.finalVc) {
            session.finalVc = incomingResult.vc;
            session.finalResult = incomingResult;
            addSessionLog(session, 'Oracle callback returned the final multi-issuer VC.', false);
        } else if (!sameAsCurrent) {
            for (const oracle of session.oracles) {
                if (oracle.error) {
                    continue;
                }
                oracle.result = incomingResult;
                oracle.resultAt = now;
                oracle.submissionStatus = 'done';
            }

            session.finalResult = incomingResult;
            if (incomingResult?.vc) {
                session.finalVc = incomingResult.vc;
            }
            const attestation = extractAttestation(incomingResult);
            if (attestation) {
                session.attestation = attestation;
            }

            const summary = summarizeOracleResult(incomingResult);
            addSessionLog(
                session,
                `Oracle network replied: competent=${summary.competent} confidence=${summary.confidence} reason="${summary.reason || 'no reason'}".`,
                false,
            );
            if (attestation) {
                addSessionLog(
                    session,
                    `Attested signer pool: oracles=[${attestation.signerOracleIds.join(',')}] threshold=${attestation.threshold} seqNr=${attestation.seqNr}.`,
                    false,
                );
            }
            if (incomingResult?.vc) {
                addSessionLog(session, 'Oracle callback returned the final multi-issuer VC.', false);
            }
        }

        refreshSessionStatus(session);
        persistSession(session);
        res.json({ ok: true, duplicate: !!sameAsCurrent, hasFinalVc: Boolean(session.finalVc) });
    }

    function safeOracleRequestCallback(req, res) {
        void handleOracleRequestCallback(req, res).catch((error) => {
            console.error('Error processing oracle request callback:', error?.message || error);
            if (!res.headersSent) {
                res.status(500).json({
                    ok: false,
                    error: 'oracle request callback failed',
                });
            }
        });
    }

    app.post('/ocr/author_oracle_request/callback/:sessionId/:oracleId', safeOracleRequestCallback);
    app.post('/ocr/author_oracle_request/callback/:sessionId', safeOracleRequestCallback);
}
