import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';

const CAVS_ORACLE_COORDINATOR_ABI = [
    "function oracleCount() view returns (uint8)",
    "function registeredOracleCount() view returns (uint256)",
    "function getRegisteredOracleIds() view returns (uint8[])",
    "function getOracle(uint8 oracleId) view returns (tuple(uint8 oracleId,address account,string did,bytes32 oraclesEncryptionKey,bool active,uint64 updatedAt))",
    "function registerOracle(uint8 oracleId,string did,bytes32 oraclesEncryptionKey)",
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const OCR_REGISTRY_DIR = process.env.OCR_REGISTRY_DIR || "/registry";
const OCR_DEPLOYMENT_FILE = path.join(OCR_REGISTRY_DIR, "ocr-contract-deployment.json");
const OCR_REGISTRY_RPC_POLL_INTERVAL_MS = normalizeNonNegativeNumber(
    process.env.OCR_REGISTRY_RPC_POLL_INTERVAL_MS,
    1000,
);
const OCR_REGISTRY_TX_TIMEOUT_MS = normalizeNonNegativeNumber(
    process.env.OCR_REGISTRY_TX_TIMEOUT_MS,
    300000,
);
const OCR_REGISTRY_VERAMO_TIMEOUT_MS = Math.max(
    100,
    normalizeNonNegativeNumber(process.env.OCR_REGISTRY_VERAMO_TIMEOUT_MS, 65000),
);

function normalizeNonNegativeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isAddress(value) {
    return ethers.isAddress ? ethers.isAddress(value) : ethers.utils.isAddress(value);
}

function getAddress(value) {
    return ethers.getAddress ? ethers.getAddress(value) : ethers.utils.getAddress(value);
}

function makeProvider(rpcUrl) {
    const provider = ethers.JsonRpcProvider
        ? new ethers.JsonRpcProvider(rpcUrl)
        : new ethers.providers.JsonRpcProvider(rpcUrl);
    if (OCR_REGISTRY_RPC_POLL_INTERVAL_MS >= 50) {
        provider.pollingInterval = OCR_REGISTRY_RPC_POLL_INTERVAL_MS;
    }
    return provider;
}

export async function closeRegistryProvider(provider) {
    if (!provider) return;
    try {
        if (typeof provider.destroy === 'function') {
            await provider.destroy();
        } else {
            provider.removeAllListeners?.();
            if ('polling' in provider) provider.polling = false;
        }
    } catch (error) {
        console.warn('Could not close OCR registry provider:', error?.message || error);
    }
}

export function withRegistryTimeout(promise, timeoutMs, label) {
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
        if (timer) clearTimeout(timer);
    });
}

function zeroValue() {
    return ethers.ZeroAddress ? 0n : ethers.constants.Zero;
}

function toNumber(value) {
    return typeof value === 'bigint' ? Number(value) : Number(value);
}

function toDecimalString(value) {
    return value?.toString?.() || String(value || '0');
}

function addGasBuffer(value) {
    return typeof value === 'bigint' ? (value * 12n) / 10n : value.mul(12).div(10);
}

async function populateRegisterOracle(contract, oracleId, did, oraclesEncryptionKey) {
    if (contract.registerOracle?.populateTransaction) {
        return await contract.registerOracle.populateTransaction(oracleId, did, oraclesEncryptionKey);
    }
    return await contract.populateTransaction.registerOracle(oracleId, did, oraclesEncryptionKey);
}

function unsignedTransactionDigest(unsignedTx) {
    if (ethers.Transaction) {
        return ethers.Transaction.from(unsignedTx).unsignedHash;
    }

    const unsignedRaw = ethers.utils.serializeTransaction(unsignedTx);
    return ethers.utils.keccak256(unsignedRaw);
}

function serializeSignedTransaction(unsignedTx, signatureHex) {
    if (ethers.Transaction) {
        const tx = ethers.Transaction.from(unsignedTx);
        tx.signature = ethers.Signature.from(signatureHex);
        return tx.serialized;
    }

    return ethers.utils.serializeTransaction(
        unsignedTx,
        ethers.utils.splitSignature(signatureHex),
    );
}

async function broadcastTransaction(provider, rawTx) {
    return provider.broadcastTransaction
        ? await provider.broadcastTransaction(rawTx)
        : await provider.sendTransaction(rawTx);
}

async function resolveGasPrice(provider, feeData) {
    if (feeData.gasPrice) {
        return feeData.gasPrice;
    }
    if (provider.getGasPrice) {
        return await provider.getGasPrice();
    }
    const refreshedFeeData = await provider.getFeeData();
    return refreshedFeeData.gasPrice;
}

function normalizeRpcUrl(value, normalizeOptionalString) {
    const explicit = normalizeOptionalString(value);
    const rpcUrl = explicit || normalizeOptionalString(process.env.OCR_CONTRACT_RPC_URL);
    if (!rpcUrl) {
        const error = new Error('missing rpcUrl');
        error.statusCode = 400;
        throw error;
    }
    return rpcUrl;
}

function readLocalDeployment() {
    try {
        if (!fs.existsSync(OCR_DEPLOYMENT_FILE)) {
            return null;
        }
        const raw = JSON.parse(fs.readFileSync(OCR_DEPLOYMENT_FILE, 'utf8'));
        const contractAddress = String(raw?.contract_address || '').trim();
        const requestRegistryAddress = String(raw?.request_registry_address || '').trim();
        if (!contractAddress || !isAddress(contractAddress)) {
            return null;
        }
        if (requestRegistryAddress && !isAddress(requestRegistryAddress)) {
            return null;
        }
        return {
            contractAddress: getAddress(contractAddress),
            requestRegistryAddress: requestRegistryAddress ? getAddress(requestRegistryAddress) : '',
            transactionHash: String(raw?.transaction_hash || '').trim(),
            oracleCount: raw?.oracle_count ?? null,
            deployer: String(raw?.deployer || '').trim(),
            source: String(raw?.source || '').trim() || 'registry',
            path: OCR_DEPLOYMENT_FILE,
        };
    } catch (error) {
        return null;
    }
}

function resolveRegistryDefaults(normalizeOptionalString) {
    const rpcUrl = normalizeOptionalString(process.env.OCR_CONTRACT_RPC_URL);
    const envContractAddress = normalizeOptionalString(process.env.OCR_CONTRACT_ADDRESS);
    const deployment = readLocalDeployment();
    const contractAddress = envContractAddress || deployment?.contractAddress || '';
    return {
        rpcUrl: rpcUrl || '',
        contractAddress,
        contractAddressSource: envContractAddress ? 'env' : deployment ? deployment.source : '',
        deployment,
    };
}

function normalizeContractAddress(value, normalizeOptionalString) {
    const explicit = normalizeOptionalString(value);
    const defaults = resolveRegistryDefaults(normalizeOptionalString);
    const raw = explicit || defaults.contractAddress;
    if (!raw || !isAddress(raw)) {
        const error = new Error('contractAddress must be an Ethereum address');
        error.statusCode = 400;
        throw error;
    }
    return getAddress(raw);
}

function normalizeRegistryOracleId(value, parseOracleIdLike) {
    const oracleId = parseOracleIdLike(value);
    if (oracleId === null || oracleId > 255) {
        const error = new Error('oracleId must be an integer from 0 to 255');
        error.statusCode = 400;
        throw error;
    }
    return oracleId;
}

function normalizeOraclesEncryptionKey(value, normalizeOptionalString) {
    const key = normalizeOptionalString(value);
    if (!/^0x[0-9a-fA-F]{64}$/.test(key) || key === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        const error = new Error('oraclesEncryptionKey must be a non-zero bytes32 hex string');
        error.statusCode = 400;
        throw error;
    }
    return key;
}

function normalizeOracleRegistration(registration) {
    if (!registration) return null;
    const account = String(registration.account || '').trim();
    return {
        oracleId: toNumber(registration.oracleId),
        account: isAddress(account) ? getAddress(account) : account,
        did: registration.did || '',
        oraclesEncryptionKey: String(registration.oraclesEncryptionKey || '').trim(),
        active: Boolean(registration.active),
        updatedAt: toDecimalString(registration.updatedAt),
    };
}

export async function readOracleRegistry(provider, contract, contractAddress) {
    const [network, oracleCountRaw, registeredCountRaw, registeredIdsRaw] = await Promise.all([
        provider.getNetwork(),
        contract.oracleCount(),
        contract.registeredOracleCount(),
        contract.getRegisteredOracleIds(),
    ]);
    const registeredOracleIds = registeredIdsRaw.map((id) => toNumber(id));
    const oracles = await Promise.all(
        registeredOracleIds.map(async (oracleId) => (
            normalizeOracleRegistration(await contract.getOracle(oracleId))
        )),
    );
    return {
        chainId: toNumber(network.chainId),
        contractAddress,
        oracleCount: toNumber(oracleCountRaw),
        registeredOracleCount: toDecimalString(registeredCountRaw),
        registeredOracleIds,
        oracles,
    };
}

async function resolveRegistryDid({
    oracleId,
    requestedDid,
    ensureOcrSignerIdentity,
    normalizeOptionalString,
    resolveDidIdentityViaVeramo,
}) {
    const identity = await ensureOcrSignerIdentity(oracleId);
    if (!identity?.kid_eth) {
        const error = new Error(`oracle ${oracleId} identity is missing kid_eth`);
        error.statusCode = 500;
        throw error;
    }

    const localResolved = await resolveDidIdentityViaVeramo(identity.did);
    let did = identity.did;
    let resolved = localResolved;

    const explicitDid = normalizeOptionalString(requestedDid);
    if (explicitDid && explicitDid !== identity.did) {
        const explicitResolved = await resolveDidIdentityViaVeramo(explicitDid);
        if (explicitResolved.eth_address.toLowerCase() !== localResolved.eth_address.toLowerCase()) {
            const error = new Error('explicit did does not resolve to the local oracle signer address');
            error.statusCode = 400;
            throw error;
        }
        did = explicitDid;
        resolved = explicitResolved;
    }

    return {
        identity,
        did,
        ethAddress: getAddress(resolved.eth_address),
    };
}

async function signDigestForOracleIdentity({ identity, digestHex, veramoAgentEndpoint }) {
    const signResp = await axios.post(
        `${veramoAgentEndpoint}/ocr/eth/sign`,
        { kid_eth: identity.kid_eth, digestHex },
        { timeout: OCR_REGISTRY_VERAMO_TIMEOUT_MS },
    );
    const signatureHex = String(signResp.data?.signatureHex || '').trim();
    if (!signatureHex) {
        const error = new Error('veramo /ocr/eth/sign returned empty signatureHex');
        error.statusCode = 502;
        throw error;
    }
    return signatureHex;
}

async function buildSignedRegistryTransaction({
    provider,
    contract,
    from,
    oracleId,
    did,
    oraclesEncryptionKey,
    identity,
    veramoAgentEndpoint,
}) {
    const populated = await populateRegisterOracle(contract, oracleId, did, oraclesEncryptionKey);
    const [network, nonce, feeData] = await Promise.all([
        provider.getNetwork(),
        provider.getTransactionCount(from, 'pending'),
        provider.getFeeData(),
    ]);
    const estimatedGas = await provider.estimateGas({
        ...populated,
        from,
        value: zeroValue(),
    });
    const gasLimit = addGasBuffer(estimatedGas);

    const unsignedTx = {
        to: populated.to,
        data: populated.data,
        nonce,
        gasLimit,
        value: zeroValue(),
        chainId: network.chainId,
    };

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        unsignedTx.type = 2;
        unsignedTx.maxFeePerGas = feeData.maxFeePerGas;
        unsignedTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else {
        unsignedTx.gasPrice = await resolveGasPrice(provider, feeData);
    }

    const digestHex = unsignedTransactionDigest(unsignedTx);
    const signatureHex = await signDigestForOracleIdentity({
        identity,
        digestHex,
        veramoAgentEndpoint,
    });
    const rawTx = serializeSignedTransaction(unsignedTx, signatureHex);

    return {
        rawTx,
        digestHex,
        gasLimit: gasLimit.toString(),
        nonce,
        type: unsignedTx.type ?? 0,
    };
}

function registryError(error) {
    return {
        status: error.statusCode || 502,
        body: {
            ok: false,
            error: String(error?.reason || error?.response?.data?.error || error?.message || error),
        },
    };
}

export function registerOcrOracleRegistryRoutes(app, {
    ensureOcrSignerIdentity,
    normalizeOptionalString,
    parseOracleIdLike,
    resolveDidIdentityViaVeramo,
    veramoAgentEndpoint,
}) {
    app.get('/ocr/oracle_registry/defaults', async (_req, res) => {
        try {
            const defaults = resolveRegistryDefaults(normalizeOptionalString);
            res.json({
                ok: true,
                rpcUrl: defaults.rpcUrl,
                contractAddress: defaults.contractAddress,
                contractAddressSource: defaults.contractAddressSource,
                deployment: defaults.deployment,
            });
        } catch (error) {
            console.error('Error in /ocr/oracle_registry/defaults:', error?.response?.data || error?.message || error);
            const { status, body } = registryError(error);
            res.status(status).json(body);
        }
    });

    app.post('/ocr/oracle_registry/identity', async (req, res) => {
        try {
            const oracleId = normalizeRegistryOracleId(
                req.body?.oracleId ?? req.body?.oracle_id,
                parseOracleIdLike,
            );
            const { identity, did, ethAddress } = await resolveRegistryDid({
                oracleId,
                requestedDid: req.body?.did,
                ensureOcrSignerIdentity,
                normalizeOptionalString,
                resolveDidIdentityViaVeramo,
            });
            res.json({
                ok: true,
                oracleId,
                did,
                eth_address: ethAddress,
                kid_eth: identity.kid_eth || '',
                kid_bls: identity.kid_bls || '',
                bls_pub_key: identity.bls_pub_key || '',
            });
        } catch (error) {
            console.error('Error in /ocr/oracle_registry/identity:', error?.response?.data || error?.message || error);
            const { status, body } = registryError(error);
            res.status(status).json(body);
        }
    });

    app.post('/ocr/oracle_registry/list', async (req, res) => {
        let provider = null;
        try {
            const rpcUrl = normalizeRpcUrl(
                req.body?.rpcUrl ?? req.body?.rpcURL ?? req.body?.contractRpcUrl,
                normalizeOptionalString,
            );
            const contractAddress = normalizeContractAddress(
                req.body?.contractAddress,
                normalizeOptionalString,
            );
            provider = makeProvider(rpcUrl);
            const contract = new ethers.Contract(contractAddress, CAVS_ORACLE_COORDINATOR_ABI, provider);
            const registry = await readOracleRegistry(provider, contract, contractAddress);
            res.json({ ok: true, ...registry });
        } catch (error) {
            console.error('Error in /ocr/oracle_registry/list:', error?.response?.data || error?.message || error);
            const { status, body } = registryError(error);
            res.status(status).json(body);
        } finally {
            await closeRegistryProvider(provider);
        }
    });

    app.post('/ocr/oracle_registry/update', async (req, res) => {
        let provider = null;
        try {
            const body = req.body || {};
            const oracleId = normalizeRegistryOracleId(
                body.oracleId ?? body.oracle_id,
                parseOracleIdLike,
            );
            const rpcUrl = normalizeRpcUrl(
                body.rpcUrl ?? body.rpcURL ?? body.contractRpcUrl,
                normalizeOptionalString,
            );
            const contractAddress = normalizeContractAddress(body.contractAddress, normalizeOptionalString);
            const confirmationsRaw = parseInt(String(body.confirmations ?? '1'), 10);
            const confirmations = Number.isInteger(confirmationsRaw) && confirmationsRaw >= 0
                ? confirmationsRaw
                : 1;

            provider = makeProvider(rpcUrl);
            const contract = new ethers.Contract(contractAddress, CAVS_ORACLE_COORDINATOR_ABI, provider);
            const oracleCount = toNumber(await contract.oracleCount());
            if (oracleId >= oracleCount) {
                return res.status(400).json({
                    ok: false,
                    error: `oracleId ${oracleId} is outside configured oracleCount ${oracleCount}`,
                });
            }

            const { identity, did, ethAddress } = await resolveRegistryDid({
                oracleId,
                requestedDid: body.did,
                ensureOcrSignerIdentity,
                normalizeOptionalString,
                resolveDidIdentityViaVeramo,
            });
            const currentRegistration = normalizeOracleRegistration(await contract.getOracle(oracleId));
            if (
                !currentRegistration?.active ||
                !currentRegistration.account ||
                currentRegistration.account === ZERO_ADDRESS
            ) {
                return res.status(409).json({
                    ok: false,
                    error: `oracle slot ${oracleId} is not registered yet; start the fixed OCR smart-contract network first`,
                    currentRegistration,
                });
            }
            if (
                currentRegistration.account.toLowerCase() !== ethAddress.toLowerCase()
            ) {
                return res.status(409).json({
                    ok: false,
                    error: `oracle slot ${oracleId} is already registered by ${currentRegistration.account}`,
                    currentRegistration,
                });
            }
            const oraclesEncryptionKey = normalizeOraclesEncryptionKey(
                body.oraclesEncryptionKey || currentRegistration.oraclesEncryptionKey,
                normalizeOptionalString,
            );

            const signed = await buildSignedRegistryTransaction({
                provider,
                contract,
                from: ethAddress,
                oracleId,
                did,
                oraclesEncryptionKey,
                identity,
                veramoAgentEndpoint,
            });
            const tx = await broadcastTransaction(provider, signed.rawTx);
            const receipt = confirmations === 0
                ? null
                : await withRegistryTimeout(
                    tx.wait(confirmations),
                    OCR_REGISTRY_TX_TIMEOUT_MS,
                    'oracle registry transaction receipt',
                );
            if (receipt && receipt.status !== 1) {
                return res.status(502).json({
                    ok: false,
                    error: `oracle slot update transaction reverted with status ${receipt.status}`,
                    transactionHash: tx.hash,
                });
            }

            const updatedRegistration = receipt
                ? normalizeOracleRegistration(await contract.getOracle(oracleId))
                : null;
            const registry = receipt
                ? await readOracleRegistry(provider, contract, contractAddress)
                : null;

            res.json({
                ok: true,
                oracleId,
                did,
                eth_address: ethAddress,
                oraclesEncryptionKey,
                transactionHash: tx.hash,
                confirmations,
                blockNumber: receipt?.blockNumber ?? null,
                gasUsed: receipt?.gasUsed ? toDecimalString(receipt.gasUsed) : null,
                signedDigestHex: signed.digestHex,
                gasLimit: signed.gasLimit,
                nonce: signed.nonce,
                transactionType: signed.type,
                currentRegistration,
                updatedRegistration,
                registry,
            });
        } catch (error) {
            console.error('Error in /ocr/oracle_registry/update:', error?.response?.data || error?.message || error);
            const { status, body } = registryError(error);
            res.status(status).json(body);
        } finally {
            await closeRegistryProvider(provider);
        }
    });
}
