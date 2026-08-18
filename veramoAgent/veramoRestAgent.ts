// Import Express
import express, {Request, response, Response} from 'express';
import {performance} from 'universal-perf-hooks'

import cors from 'cors';
// Import axios
import qrcode from 'qrcode'
import {agent} from "./src/veramo/setup.js"
import {agentETH} from "./src/veramo/setupETH.js"
import fs from 'fs';
import path from 'path';

import {
    CredentialSubject,
    ICredentialIssuer,
    IDataStoreSaveVerifiableCredentialArgs,
    IDIDManagerGetArgs,
    IIdentifier,
    VerifiableCredential,
    FindArgs,
    TCredentialColumns,
    Where,
    IVerifyResult,
    VerifiablePresentation,
    PresentationPayload,
    CredentialPayload,
    IssuerType,
    TPresentationColumns,
    W3CVerifiablePresentation,
    MinimalImportableKey, W3CVerifiableCredential
} from "@veramo/core";

import decode from 'jsqr'
// Create an app instance
import {PNG} from 'pngjs'
import jpeg from 'jpeg-js'
import {jwtDecode} from "jwt-decode";
import bodyParser from "body-parser"
import {Presentation} from "@veramo/data-store";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@veramo/utils";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";

import {createVCPayload, createVPPayload, verifyVPSelectiveDisclousureCorrectness} from "./src/hash/main.js";
import {} from "./src/hash/hashAttributes.js"
import {
    aggregateBlsKeys,
    IndividualBlsVPSignatures,
    buildVPPayloadWithAggKey,
    createPoO,
    createMultiHolderPresentation,
    storeCredential as storeBlsCredential,
    createSingleHolderPresentationFromStoredVCs
} from './MultiSignatureVeramo/src/server-demo/actors/holder_test.js';
import {verifyPoOVP, verifyMultiSignatureVP, verifyVCsFromVP, verifyVCs, verifyVP as verifyBlsVP} from './MultiSignatureVeramo/src/server-demo/actors/verifier_test.js';
import {createVC as createBlsVC} from './MultiSignatureVeramo/src/server-demo/actors/issuers_test.js';
import {singleActorSetup} from './MultiSignatureVeramo/src/server-demo/single_actor_setup.js';
import {createProofOfPossessionPerActor, verifyProofOfPossessionStrict} from './MultiSignatureVeramo/src/server-demo/ProofOfPossessionProtocol.js';
import {
    generatePayloadToSign,
    signPayloadWithIssuers,
    createProofsOfOwnershipPerIssuer,
    getAndAggregateBlsKeys,
} from './MultiSignatureVeramo/src/test/issuers_test.js';
import {verifyMultiSignatureVC} from './MultiSignatureVeramo/src/test/verifier_test.js';

const app = express();

// Enable CORS
app.use(cors());
app.use(bodyParser.json({limit: '100mb'}));

// Utility: resolve a BLS key reference for a DID if kid is not provided
async function ensureBlsKeyRefs(issuers: Array<{ did: string; kid_bls?: string }>): Promise<Array<{ did: string; kid_bls: string }>> {
    const resolved: Array<{ did: string; kid_bls: string }> = [];
    for (const i of issuers) {
        if (i.kid_bls) {
            resolved.push({ did: i.did, kid_bls: i.kid_bls });
            continue;
        }
        const identifier = await agent.didManagerGet({ did: i.did });
        const blsKey = identifier.keys.find((k: any) => k.type === 'Bls12381G1' || k.meta?.alg === 'BLS_SIGNATURE');
        if (!blsKey) {
            throw new Error(`No BLS key found for DID ${i.did}`);
        }
        resolved.push({ did: i.did, kid_bls: blsKey.kid });
    }
    return resolved;
}

// Health + multisignature/BLS routes (adapted from MultiSignatureVeramo server)
app.get('/health', (_req: Request, res: Response) => {
    res.json({ok: true, time: new Date().toISOString()});
});

function strip0x(value: string): string {
    return String(value || '').replace(/^0x/i, '');
}

function normalizeHex0x(value: string): string {
    return `0x${strip0x(value)}`;
}

function decodeDigestHex(value: string): Uint8Array {
    const hex = strip0x(String(value || ''));
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('digestHex must be 32 bytes hex');
    }
    return hexToBytes(hex);
}

function normalizeEthereumAddress(value: string): string {
    const hex = strip0x(String(value || '')).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hex)) {
        throw new Error('Expected a 20-byte Ethereum address');
    }
    return `0x${hex}`;
}

function rpcErrorText(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>;
        const nested = record.shortMessage || record.message || (record.error as Record<string, unknown> | undefined)?.message;
        if (nested) {
            return String(nested);
        }
    }
    return String(error || '');
}

function isTransientRpcError(error: unknown): boolean {
    const text = rpcErrorText(error).toLowerCase();
    return text.includes('429') ||
        text.includes('compute units per second capacity') ||
        text.includes('rate limit') ||
        text.includes('too many requests') ||
        text.includes('socket hang up') ||
        text.includes('econnreset') ||
        text.includes('timeout');
}

async function withRpcRetry<T>(label: string, operation: () => Promise<T>, attempts = 5, delayMs = 750): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!isTransientRpcError(error) || attempt >= attempts) {
                throw error;
            }
            const waitMs = delayMs * (2 ** (attempt - 1));
            console.warn(`${label} retry ${attempt}/${attempts} after transient RPC error: ${rpcErrorText(error)}`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
    throw lastError;
}

function normalizePrivateKeyHex(value: string): string {
    const hex = strip0x(String(value || ''));
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('Expected a 32-byte secp256k1 private key');
    }
    return hex.toLowerCase();
}

async function ensureConfiguredSepoliaDid(): Promise<IIdentifier | null> {
    const configuredPrivateKey =
        process.env.VERAMO_SUBMITTER_PRIVATE_KEY ||
        process.env.SUBMITTER_PRIVATE_KEY ||
        process.env.HOLDER_PRIVATE_KEY ||
        "";
    if (!configuredPrivateKey.trim()) {
        return null;
    }

    const privateKeyHex = normalizePrivateKeyHex(configuredPrivateKey);
    const wallet = new Wallet(`0x${privateKeyHex}`);
    const walletAddr = wallet.address;
    const alias = (process.env.VERAMO_SUBMITTER_ALIAS || walletAddr).trim() || walletAddr;
    const did = `did:ethr:sepolia:${walletAddr}`;

    try {
        return await agent.didManagerGet({ did });
    } catch (_err) {
    }

    try {
        return await agent.didManagerGetByAlias({ alias });
    } catch (_err) {
    }

    return await agent.didManagerImport({
        did,
        alias,
        provider: 'did:ethr:sepolia',
        keys: [
            {
                type: 'Secp256k1',
                kms: 'local',
                kid: `key-1-${walletAddr.toLowerCase()}`,
                privateKeyHex,
            } as MinimalImportableKey,
        ],
        services: [],
    });
}

const RUNTIME_ENV_FILE = process.env.VERAMO_RUNTIME_ENV_FILE || '/usr/src/app/runtime-config.env';
type OracleFundingResult = {
    funded: boolean;
    action: 'none' | 'top-up' | 'skipped';
    txHash?: string;
    currentBalanceWei?: string;
    targetBalanceWei?: string;
    finalBalanceWei?: string;
    reason?: string;
};
const fundingInFlight = new Map<string, Promise<OracleFundingResult>>();
let fundingQueue: Promise<void> = Promise.resolve();
const FUNDING_LOCK_DIR = process.env.OCR_FUNDING_LOCK_DIR || '/registry/oracle-funding.lock';
const FUNDING_LOCK_STALE_MS = Number(process.env.OCR_FUNDING_LOCK_STALE_MS || 90 * 1000);
const FUNDING_LOCK_WAIT_MS = Number(process.env.OCR_FUNDING_LOCK_WAIT_MS || 500);
const FUNDING_TX_WAIT_MS = Number(process.env.OCR_FUNDING_TX_WAIT_MS || 120 * 1000);

async function sleepMs(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function isReplacementFeeError(error: unknown): boolean {
    const text = rpcErrorText(error).toLowerCase();
    return text.includes('replacement fee too low') ||
        text.includes('replacement transaction underpriced') ||
        text.includes('replacement_underpriced');
}

function parseInsufficientFundsRequirement(error: unknown): { haveWei: bigint; wantWei: bigint } | null {
    const match = rpcErrorText(error).match(/have\s+(\d+)\s+want\s+(\d+)/i);
    if (!match) {
        return null;
    }
    return {
        haveWei: BigInt(match[1]),
        wantWei: BigInt(match[2]),
    };
}

function dynamicFundingBufferWei(): bigint {
    const configured =
        readRuntimeSetting('ORACLE_DYNAMIC_TOP_UP_BUFFER_ETH') ||
        readRuntimeSetting('DYNAMIC_TOP_UP_BUFFER_ETH') ||
        '0.002';
    return Number(configured) > 0 ? parseEther(configured) : 0n;
}

function minBigInt(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
}

async function acquireFundingLock(label: string): Promise<() => Promise<void>> {
    if (!FUNDING_LOCK_DIR) {
        return async () => {};
    }

    const ownerFile = path.join(FUNDING_LOCK_DIR, 'owner');
    while (true) {
        try {
            await fs.promises.mkdir(FUNDING_LOCK_DIR);
            await fs.promises.writeFile(ownerFile, `${process.pid} ${label} ${new Date().toISOString()}\n`, 'utf8');
            console.log(`funding lock acquired by ${label}`);
            return async () => {
                await fs.promises.rm(FUNDING_LOCK_DIR, {recursive: true, force: true});
                console.log(`funding lock released by ${label}`);
            };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') {
                console.warn(`funding lock disabled at ${FUNDING_LOCK_DIR}: ${rpcErrorText(error)}`);
                return async () => {};
            }
            try {
                const stat = await fs.promises.stat(FUNDING_LOCK_DIR);
                if (Date.now() - stat.mtimeMs > FUNDING_LOCK_STALE_MS) {
                    console.warn(`removing stale funding lock at ${FUNDING_LOCK_DIR}`);
                    await fs.promises.rm(FUNDING_LOCK_DIR, {recursive: true, force: true});
                    continue;
                }
            } catch (_err) {
            }
            await sleepMs(FUNDING_LOCK_WAIT_MS);
        }
    }
}

function readRuntimeSetting(name: string): string {
    const envValue = String(process.env[name] || '').trim();
    if (envValue) {
        return envValue;
    }
    try {
        const raw = fs.readFileSync(RUNTIME_ENV_FILE, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            if (!line.startsWith(`${name}=`)) continue;
            const value = line.slice(name.length + 1).trim();
            if (value) {
                return value;
            }
        }
    } catch (_err) {
    }
    return '';
}

function runtimeSettingIsTrue(name: string): boolean {
    const value = readRuntimeSetting(name).toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

async function ensureFundingForOracleAddress(address: string, targetBalanceEth?: string): Promise<OracleFundingResult> {
    const normalizedAddress = normalizeEthereumAddress(address);
    const existingTask = fundingInFlight.get(normalizedAddress);
    if (existingTask) {
        return await existingTask;
    }

    const task = (async (): Promise<OracleFundingResult> => {
        if (runtimeSettingIsTrue('OCR_DISABLE_ORACLE_FUNDING')) {
            return { funded: false, action: 'skipped', reason: 'OCR_DISABLE_ORACLE_FUNDING enabled' };
        }
        const rpcUrl = readRuntimeSetting('OCR_CONTRACT_RPC_URL');
        const funderKey = readRuntimeSetting('PRIVATE_KEY');
        if (!rpcUrl || !funderKey) {
            return { funded: false, action: 'skipped', reason: 'missing OCR_CONTRACT_RPC_URL or PRIVATE_KEY' };
        }

        const provider = new JsonRpcProvider(rpcUrl);
        const funder = new Wallet(normalizeHex0x(normalizePrivateKeyHex(funderKey)), provider);
        if (funder.address.toLowerCase() === normalizedAddress.toLowerCase()) {
            return { funded: false, action: 'skipped', reason: 'oracle address matches funder' };
        }

        const targetBalanceWei = parseEther(
            targetBalanceEth ||
            readRuntimeSetting('CAVS_ORACLE_TARGET_BALANCE_ETH') ||
            readRuntimeSetting('AUTHOR_TARGET_BALANCE_ETH') ||
            '0.03',
        );
        const reserveWei = parseEther(readRuntimeSetting('AUTHOR_FUNDER_GAS_RESERVE_ETH') || '0.005');
        const [currentBalanceWei, funderBalanceWei] = await Promise.all([
            withRpcRetry('provider.getBalance(target)', () => provider.getBalance(normalizedAddress)),
            withRpcRetry('provider.getBalance(funder)', () => provider.getBalance(funder.address)),
        ]);
        if (currentBalanceWei >= targetBalanceWei) {
            return {
                funded: false,
                action: 'none',
                currentBalanceWei: currentBalanceWei.toString(),
                targetBalanceWei: targetBalanceWei.toString(),
                finalBalanceWei: currentBalanceWei.toString(),
            };
        }
        if (funderBalanceWei <= reserveWei) {
            return {
                funded: false,
                action: 'skipped',
                currentBalanceWei: currentBalanceWei.toString(),
                targetBalanceWei: targetBalanceWei.toString(),
                reason: `funder balance ${funderBalanceWei.toString()} below reserve ${reserveWei.toString()}`,
            };
        }

        await fundingQueue;
        let releaseQueue: () => void = () => {};
        fundingQueue = new Promise<void>((resolve) => {
            releaseQueue = resolve;
        });
        const releaseDistributedFundingLock = await acquireFundingLock(normalizedAddress);
        try {
            const refreshedBalanceWei = await withRpcRetry('provider.getBalance(refresh)', () => provider.getBalance(normalizedAddress));
            if (refreshedBalanceWei >= targetBalanceWei) {
                return {
                    funded: false,
                    action: 'none',
                    currentBalanceWei: currentBalanceWei.toString(),
                    targetBalanceWei: targetBalanceWei.toString(),
                    finalBalanceWei: refreshedBalanceWei.toString(),
                };
            }

            const desiredTopUpWei = targetBalanceWei - refreshedBalanceWei;
            const funderBalanceAfterRefreshWei = await withRpcRetry('provider.getBalance(funder refresh)', () => provider.getBalance(funder.address));
            const availableFundingWei = funderBalanceAfterRefreshWei > reserveWei ? funderBalanceAfterRefreshWei - reserveWei : 0n;
            if (availableFundingWei <= 0n) {
                return {
                    funded: false,
                    action: 'skipped',
                    currentBalanceWei: currentBalanceWei.toString(),
                    targetBalanceWei: targetBalanceWei.toString(),
                    finalBalanceWei: refreshedBalanceWei.toString(),
                    reason: `funder balance ${funderBalanceAfterRefreshWei.toString()} leaves no spendable balance above reserve ${reserveWei.toString()}`,
                };
            }
            const topUpWei = minBigInt(desiredTopUpWei, availableFundingWei);
            let tx: Awaited<ReturnType<Wallet['sendTransaction']>> | undefined;
            for (let attempt = 1; attempt <= 5; attempt += 1) {
                try {
                    tx = await funder.sendTransaction({ to: normalizedAddress, value: topUpWei });
                    break;
                } catch (error) {
                    const requirement = parseInsufficientFundsRequirement(error);
                    if (requirement && attempt < 5) {
                        const adjustedAvailableWei = requirement.haveWei > reserveWei ? requirement.haveWei - reserveWei : 0n;
                        if (adjustedAvailableWei > 0n && adjustedAvailableWei < topUpWei) {
                            console.warn(`funder balance cannot reach full target; retrying partial top-up ${adjustedAvailableWei.toString()} wei after insufficient-funds error: ${rpcErrorText(error)}`);
                            tx = await funder.sendTransaction({ to: normalizedAddress, value: adjustedAvailableWei });
                            break;
                        }
                    }
                    if (!isReplacementFeeError(error) || attempt >= 5) {
                        throw error;
                    }
                    console.warn(`funder.sendTransaction replacement-fee retry ${attempt}/5: ${rpcErrorText(error)}`);
                    await sleepMs(1000 * attempt);
                    const afterErrorBalanceWei = await withRpcRetry('provider.getBalance(after replacement error)', () => provider.getBalance(normalizedAddress));
                    if (afterErrorBalanceWei >= targetBalanceWei) {
                        return {
                            funded: false,
                            action: 'none',
                            currentBalanceWei: currentBalanceWei.toString(),
                            targetBalanceWei: targetBalanceWei.toString(),
                            finalBalanceWei: afterErrorBalanceWei.toString(),
                            reason: 'target reached after concurrent funding transaction',
                        };
                    }
                }
            }
            if (!tx) {
                throw new Error('oracle funding tx was not submitted');
            }
            console.log(`oracle funding tx submitted to ${normalizedAddress}: ${tx.hash}`);
            const receipt = await withRpcRetry('tx.wait', () => withTimeout('oracle funding tx.wait', tx.wait(), FUNDING_TX_WAIT_MS));
            if (!receipt || receipt.status !== 1) {
                throw new Error(`oracle funding tx ${tx.hash} reverted`);
            }
            const finalBalanceWei = await withRpcRetry('provider.getBalance(final)', () => provider.getBalance(normalizedAddress));
            return {
                funded: true,
                action: 'top-up',
                txHash: tx.hash,
                currentBalanceWei: currentBalanceWei.toString(),
                targetBalanceWei: targetBalanceWei.toString(),
                finalBalanceWei: finalBalanceWei.toString(),
            };
        } finally {
            await releaseDistributedFundingLock();
            releaseQueue();
        }
    })();

    fundingInFlight.set(normalizedAddress, task);
    try {
        return await task;
    } finally {
        fundingInFlight.delete(normalizedAddress);
    }
}

function fundingAllowedForAlias(alias: string): boolean {
    const raw = readRuntimeSetting('OCR_FUND_ORACLE_ALIASES').trim();
    if (!raw) {
        return true;
    }
    const normalizedAlias = alias.toLowerCase();
    return raw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
        .includes(normalizedAlias);
}

async function ensureFundingForOracleAlias(alias: string, address: string): Promise<OracleFundingResult> {
    if (!fundingAllowedForAlias(alias)) {
        return { funded: false, action: 'skipped', reason: `oracle funding disabled for alias ${alias}` };
    }
    const bootstrapTarget = readRuntimeSetting('OCR_BOOTSTRAP_TARGET_BALANCE_ETH');
    const targetOverride = alias.trim().toLowerCase() === 'oracle0' && bootstrapTarget ? bootstrapTarget : undefined;
    return await ensureFundingForOracleAddress(address, targetOverride);
}

function normalizeRecoveryBit(v: number): number {
    if (v >= 27) {
        v -= 27;
    }
    if (v < 0 || v > 3) {
        throw new Error('Invalid signature recovery bit');
    }
    return v;
}

function standardSignatureBytesFromAnyHex(value: string): Uint8Array {
    const raw = hexToBytes(strip0x(String(value || '')));
    if (raw.length === 64) {
        const out = new Uint8Array(65);
        out.set(raw.slice(0, 32), 0);
        const s = raw.slice(32);
        const recovery = (s[0] & 0x80) >>> 7;
        s[0] &= 0x7f;
        out.set(s, 32);
        out[64] = recovery;
        return out;
    }
    if (raw.length !== 65) {
        throw new Error('signatureHex must be 64-byte compact or 65-byte standard hex');
    }
    raw[64] = normalizeRecoveryBit(raw[64]);
    return raw;
}

function recoverEthereumAddressFromRawSignature(digestHex: string, signatureHex: string): string {
    const digest = decodeDigestHex(digestHex);
    const standard = standardSignatureBytesFromAnyHex(signatureHex);
    const signature = secp256k1.Signature.fromCompact(standard.slice(0, 64)).addRecoveryBit(standard[64]);
    const pub = signature.recoverPublicKey(digest).toRawBytes(false);
    return normalizeEthereumAddress(bytesToHex(keccak_256(pub.slice(1)).slice(-20)));
}

function ethereumAddressFromVerificationMethod(vm: any): string | null {
    const blockchainAccountId = String(vm?.blockchainAccountId || '').trim();
    if (blockchainAccountId) {
        const maybeAddr = blockchainAccountId.split('@')[0];
        if (/^eip155:\d+:(0x[0-9a-fA-F]{40})$/.test(blockchainAccountId)) {
            return normalizeEthereumAddress(blockchainAccountId.split(':').pop() || '');
        }
        if (/^0x[0-9a-fA-F]{40}$/.test(maybeAddr)) {
            return normalizeEthereumAddress(maybeAddr);
        }
    }

    const ethereumAddress = String(vm?.ethereumAddress || '').trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(ethereumAddress)) {
        return normalizeEthereumAddress(ethereumAddress);
    }

    const publicKeyHexRaw = String(vm?.publicKeyHex || '').trim();
    if (publicKeyHexRaw) {
        const publicKey = hexToBytes(strip0x(publicKeyHexRaw));
        if (publicKey.length === 20) {
            return normalizeEthereumAddress(bytesToHex(publicKey));
        }
        if (publicKey.length === 33 || publicKey.length === 65) {
            const uncompressed = publicKey.length === 65 ? publicKey : secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
            return normalizeEthereumAddress(bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20)));
        }
    }

    return null;
}

const didEthResolutionCache = new Map<string, { expectedAddress: string; verificationMethodId: string }>();

function tryResolveDidEthAddressLocally(did: string, verificationMethodId?: string): { expectedAddress: string; verificationMethodId: string } | null {
    const normalizedDid = String(did || '').trim();
    const match = normalizedDid.match(/^did:ethr(?::[^:]+)?:0x[0-9a-fA-F]{40}$/);
    if (!match) {
        return null;
    }
    const expectedAddress = ethAddressFromDid(normalizedDid);
    return {
        expectedAddress,
        verificationMethodId: String(verificationMethodId || `${normalizedDid}#controllerKey`),
    };
}

async function resolveDidEthVerificationMethodAddress(did: string, verificationMethodId?: string): Promise<{ expectedAddress: string; verificationMethodId: string }> {
    const cacheKey = `${String(did || '').trim()}|${String(verificationMethodId || '').trim()}`;
    const cached = didEthResolutionCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const local = tryResolveDidEthAddressLocally(did, verificationMethodId);
    if (local) {
        didEthResolutionCache.set(cacheKey, local);
        return local;
    }

    const resolved = await withRpcRetry(
        `agent.resolveDid(${did})`,
        () => agent.resolveDid({ didUrl: did }),
    );
    const didDocument = resolved?.didDocument;
    if (!didDocument) {
        throw new Error(`Could not resolve DID document for ${did}`);
    }

    const methods = Array.isArray((didDocument as any).verificationMethod) ? (didDocument as any).verificationMethod : [];
    if (methods.length === 0) {
        throw new Error(`No verificationMethod entries found for ${did}`);
    }

    const selected = verificationMethodId
        ? methods.find((vm: any) => vm?.id === verificationMethodId)
        : methods.find((vm: any) => vm?.type === 'EcdsaSecp256k1RecoveryMethod2020') || methods[0];

    if (!selected) {
        throw new Error(`Verification method ${verificationMethodId} not found for ${did}`);
    }

    const expectedAddress = ethereumAddressFromVerificationMethod(selected);
    if (!expectedAddress) {
        throw new Error(`Verification method ${selected.id || '(unknown)'} does not expose an Ethereum address/public key`);
    }

    const result = {
        expectedAddress,
        verificationMethodId: String(selected.id || verificationMethodId || ''),
    };
    didEthResolutionCache.set(cacheKey, result);
    return result;
}

function ethAddressFromDid(did: string): string {
    const parts = String(did || '').split(':');
    const last = parts[parts.length - 1] || '';
    const addr = normalizeHex0x(last);
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        throw new Error(`Could not extract Ethereum address from DID ${did}`);
    }
    return addr;
}

async function getManagedOcrIdentityByAlias(alias: string) {
    const identifier = await agent.didManagerGetByAlias({alias});
    const kid_eth =
        identifier.controllerKeyId ||
        identifier.keys.find((k: any) => k.type === 'Secp256k1')?.kid;
    let kid_bls = identifier.keys.find((k: any) => k.type === 'Bls12381G1' || k.meta?.alg === 'BLS_SIGNATURE')?.kid;
    if (!kid_eth) {
        throw new Error(`No managed Secp256k1 key found for alias ${alias}`);
    }
    let bls_pub_key: string | undefined;
    if (kid_bls) {
        const blsKey = await agent.keyManagerGet({kid: kid_bls});
        bls_pub_key = blsKey.publicKeyHex;
    } else {
        const blsKey = await agent.keyManagerCreate({
            kms: 'local',
            type: 'Bls12381G1',
        });
        await agent.didManagerAddKey({
            did: identifier.did,
            key: blsKey,
            key_type: 'Bls12381G1',
            key_ref: blsKey.kid,
            NoPublish: true,
        } as any);
        kid_bls = blsKey.kid;
        bls_pub_key = blsKey.publicKeyHex;
    }
    return {
        did: identifier.did,
        kid_eth,
        kid_bls,
        bls_pub_key,
        address: ethAddressFromDid(identifier.did),
    };
}

const managedOcrIdentityInFlight = new Map<string, Promise<any>>();

async function ensureManagedOcrIdentity(name: string) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
        throw new Error('Missing required field: name');
    }
    const existingTask = managedOcrIdentityInFlight.get(normalizedName);
    if (existingTask) {
        return await existingTask;
    }

    const task = (async () => {
        try {
            const existing = await getManagedOcrIdentityByAlias(normalizedName);
            const funding = await ensureFundingForOracleAlias(normalizedName, existing.address);
            return {ok: true, source: 'existing', ...existing, alias: normalizedName, funding};
        } catch (_err) {
        }

        try {
            const actorInfo = await singleActorSetup(normalizedName);
            const address = ethAddressFromDid(actorInfo.did);
            const funding = await ensureFundingForOracleAlias(normalizedName, address);
            return {
                ok: true,
                source: 'created',
                ...actorInfo,
                address,
                alias: normalizedName,
                funding,
            };
        } catch (err: any) {
            const msg = String(err?.message || err);
            if (msg.includes('UNIQUE constraint failed: identifier.alias') || msg.includes('already exists')) {
                const existing = await getManagedOcrIdentityByAlias(normalizedName);
                const funding = await ensureFundingForOracleAlias(normalizedName, existing.address);
                return {ok: true, source: 'existing_after_race', ...existing, alias: normalizedName, funding};
            }
            throw err;
        }
    })();

    managedOcrIdentityInFlight.set(normalizedName, task);
    try {
        return await task;
    } finally {
        managedOcrIdentityInFlight.delete(normalizedName);
    }
}

app.post('/setup', async (req: Request, res: Response) => {
    try {
        const name = String((req.body as any)?.name || 'actor1').trim() || 'actor1';
        return res.json(await ensureManagedOcrIdentity(name));
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/ocr/identity/setup', async (req: Request, res: Response) => {
    try {
        const name = String((req.body as any)?.name || '').trim();
        if (!name) {
            return res.status(400).json({ok: false, error: 'Missing required field: name'});
        }
        return res.json(await ensureManagedOcrIdentity(name));
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/ocr/identity/resolve', async (req: Request, res: Response) => {
    try {
        const {did, verificationMethodId} = req.body ?? {};
        if (!did) {
            return res.status(400).json({ok: false, error: 'Missing required field: did'});
        }
        const resolved = await resolveDidEthVerificationMethodAddress(
            String(did),
            verificationMethodId ? String(verificationMethodId) : undefined,
        );
        res.json({
            ok: true,
            did: String(did),
            address: resolved.expectedAddress,
            eth_address: resolved.expectedAddress,
            verificationMethodId: resolved.verificationMethodId || undefined,
        });
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/ocr/eth/sign', async (req: Request, res: Response) => {
    try {
        const {kid_eth, digestHex} = req.body ?? {};
        if (!kid_eth || !digestHex) {
            return res.status(400).json({ok: false, error: 'Missing required fields: kid_eth, digestHex'});
        }
        const digest = strip0x(String(digestHex));
        if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
            return res.status(400).json({ok: false, error: 'digestHex must be 32 bytes hex'});
        }
        const signatureHex = await agent.keyManagerSign({
            keyRef: String(kid_eth),
            data: digest,
            algorithm: 'eth_rawSign',
            encoding: 'hex',
        });
        res.json({ok: true, signatureHex});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/ocr/eth/verify', async (req: Request, res: Response) => {
    try {
        const {digestHex, signatureHex, did, verificationMethodId} = req.body ?? {};
        if (!digestHex || !signatureHex || !did) {
            return res.status(400).json({ok: false, error: 'Missing required fields: digestHex, signatureHex, did'});
        }
        const resolved = await resolveDidEthVerificationMethodAddress(String(did), verificationMethodId ? String(verificationMethodId) : undefined);
        const recoveredAddress = recoverEthereumAddressFromRawSignature(String(digestHex), String(signatureHex));
        res.json({
            ok: true,
            verified: recoveredAddress.toLowerCase() === resolved.expectedAddress.toLowerCase(),
            recoveredAddress,
            expectedAddress: resolved.expectedAddress,
            verificationMethodId: resolved.verificationMethodId || undefined,
        });
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/bls/aggregate', async (req: Request, res: Response) => {
    try {
        const {keys} = req.body ?? {};
        if (!Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ok: false, error: 'Missing or invalid body.keys (expected string[])'});
        }
        const aggregatedKey = await aggregateBlsKeys(keys);
        res.json({ok: true, aggregatedKey});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/signbls', async (req: Request, res: Response) => {
    try {
        const {presentation, did, kid_bls} = req.body ?? {};
        if (!presentation || !did || !kid_bls) {
            return res.status(400).json({ok: false, error: 'Missing required fields: presentation, did, kid_bls'});
        }
        const {signature, payloadToSign} = await IndividualBlsVPSignatures(presentation, did, kid_bls);
        res.json({ok: true, signature, payloadToSign});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/poo', async (req: Request, res: Response) => {
    try {
        const {did, kid_eth, payloadToSign} = req.body ?? {};
        if (!did || !kid_eth || !payloadToSign) {
            return res.status(400).json({ok: false, error: 'Missing required fields: did, kid_eth, payloadToSign'});
        }
        const signature = await createPoO(did, kid_eth, payloadToSign);
        res.json({ok: true, signature});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/generatepayload', async (req: Request, res: Response) => {
    try {
        const {holder_dids, aggregatedKey, vcs, attributes} = req.body ?? {};
        if (!Array.isArray(holder_dids) || !aggregatedKey) {
            return res.status(400).json({ok: false, error: 'Missing required fields: holder_dids[], aggregatedKey'});
        }
        const payload = buildVPPayloadWithAggKey(holder_dids, aggregatedKey, vcs, attributes);
        res.json({ok: true, payload});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/createfullvp', async (req: Request, res: Response) => {
    try {
        const holders_dids = req.body?.holders_dids;
        const usePoO = true;
        const blssignaturesRaw = req.body?.blssignatures;
        const blssignatures = Array.isArray(blssignaturesRaw) ? blssignaturesRaw : JSON.parse(blssignaturesRaw);
        const aggkey = req.body?.aggkey;
        const proofsofownership = req.body?.proofsofownership;
        const payload = req.body?.payload;
        const attributes = typeof req.body?.attributes === 'object' && req.body?.attributes ? req.body.attributes : undefined;
        const vcs = typeof req.body?.vcs === 'object' && req.body?.vcs ? req.body.vcs : undefined;
        const vp = await createMultiHolderPresentation(
            holders_dids,
            usePoO,
            aggkey,
            blssignatures,
            proofsofownership,
            payload,
        );
        res.json({ok: true, vp});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/multi/verify', async (req: Request, res: Response) => {
    try {
        const usePoO = Boolean(req.body?.usePoO ?? true);
        const vp = req.body?.vp;
        if (!vp || typeof vp !== 'object') {
            return res.status(400).json({ok: false, error: 'Missing body.vp'});
        }
        const result = usePoO ? await verifyPoOVP(vp) : await verifyMultiSignatureVP(vp);
        res.json({ok: true, verified: !!(result as any)?.verified, result});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/verify', async (req: Request, res: Response) => {
    try {
        const vp = req.body?.vp;
        if (!vp || typeof vp !== 'object') {
            return res.status(400).json({ok: false, error: 'Missing body.vp'});
        }
        const result = await verifyBlsVP(vp);
        res.json({ok: true, verified: !!(result as any)?.verified, result});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vc/create', async (req: Request, res: Response) => {
    try {
        const {issuerDid, holderDid, attributes} = req.body ?? {};
        if (!issuerDid || !holderDid) {
            return res.status(400).json({ok: false, error: 'Missing required fields: issuerDid, holderDid'});
        }
        if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
            return res.status(400).json({ok: false, error: 'Missing or invalid required field: attributes (must be an object)'});
        }
        const {payload, vc} = await createBlsVC(issuerDid, holderDid, attributes);
        res.json({ok: true, payload, vc});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vc/store', async (req: Request, res: Response) => {
    try {
        const {vc} = req.body ?? {};
        if (!vc || typeof vc !== 'object') {
            return res.status(400).json({ok: false, error: 'Missing or invalid "vc" (must be an object)'});
        }
        const result = await storeBlsCredential(vc);
        res.json({ok: true, result});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/from-all', async (req: Request, res: Response) => {
    try {
        const {holderDid, proofFormat} = req.body ?? {};
        if (!holderDid || typeof holderDid !== 'string') {
            return res.status(400).json({ok: false, error: 'Missing or invalid "holderDid" (string required)'});
        }
        const vp = await createSingleHolderPresentationFromStoredVCs(holderDid, proofFormat ?? 'jwt');
        res.json({ok: true, vp});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/pop/create', async (req: Request, res: Response) => {
    try {
        const {kid_bls, nonce} = req.body ?? {};
        if (!kid_bls || !nonce) {
            return res.status(400).json({ok: false, error: 'Missing required fields: kid_bls, nonce'});
        }
        const {message, signature, publicKeyHex} = await createProofOfPossessionPerActor(kid_bls, nonce);
        res.json({ok: true, message, signature, publicKeyHex});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/pop/verify', async (req: Request, res: Response) => {
    try {
        const {message, signatureHex, expectedNonce, expectedPublicKeyHex} = req.body ?? {};
        if (!message || !signatureHex || !expectedNonce || !expectedPublicKeyHex) {
            return res.status(400).json({ok: false, error: 'Missing required fields: message, signatureHex, expectedNonce, expectedPublicKeyHex'});
        }
        const result = await verifyProofOfPossessionStrict(message, signatureHex, expectedNonce, expectedPublicKeyHex);
        res.json({ok: true, ...result});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vp/verify-vcs', async (req: Request, res: Response) => {
    try {
        const vp = req.body?.vp;
        if (!vp || typeof vp !== 'object') {
            return res.status(400).json({ok: false, error: 'Missing body.vp'});
        }
        const verified = await verifyVCsFromVP(vp);
        res.json({ok: true, verified});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/vc/verify-vcs', async (req: Request, res: Response) => {
    try {
        const vcs = req.body?.vcs;
        if (!vcs) {
            return res.status(400).json({ok: false, error: 'Missing body.vcs'});
        }
        const verified = await verifyVCs(vcs);
        res.json({ok: true, verified});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

// -------- Multi-issuer VC (BLS + PoO) routes --------

app.post('/mi-vc/aggregate-keys', async (req: Request, res: Response) => {
    try {
        const issuers = req.body?.issuers;
        if (!Array.isArray(issuers) || issuers.length === 0) {
            return res.status(400).json({ok: false, error: 'Missing or invalid issuers (array of {did,kid_bls?})'});
        }
        const resolved = await ensureBlsKeyRefs(issuers);
        const aggregatedKey = await getAndAggregateBlsKeys(resolved);
        const publicKeys = await Promise.all(resolved.map(async i => {
            const key = await agent.keyManagerGet({kid: i.kid_bls});
            return {did: i.did, kid_bls: i.kid_bls, publicKeyHex: key.publicKeyHex};
        }));
        res.json({ok: true, aggregatedKey, publicKeys});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/mi-vc/payload', async (req: Request, res: Response) => {
    try {
        const issuers = req.body?.issuers;
        const holderDid = req.body?.holder_did;
        const claimCount = req.body?.claimCount ?? 1;
        const valueSize = req.body?.valueSize ?? 1;
        const seed = req.body?.seed ?? 42;
        if (!Array.isArray(issuers) || issuers.length === 0 || !holderDid) {
            return res.status(400).json({ok: false, error: 'Missing issuers or holder_did'});
        }
        const resolved = await ensureBlsKeyRefs(issuers);
        const aggregatedKey = req.body?.aggregatedKey || await getAndAggregateBlsKeys(resolved);
        const payload = await generatePayloadToSign(resolved, holderDid, aggregatedKey, claimCount, valueSize, seed);
        res.json({ok: true, payload, aggregatedKey});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/mi-vc/sign', async (req: Request, res: Response) => {
    try {
        const issuers = req.body?.issuers;
        const payload = req.body?.payload;
        if (!Array.isArray(issuers) || issuers.length === 0 || !payload) {
            return res.status(400).json({ok: false, error: 'Missing issuers or payload'});
        }
        const resolved = await ensureBlsKeyRefs(issuers);
        const {signatures, payloads} = await signPayloadWithIssuers(payload, resolved);
        res.json({ok: true, signatures, payloads});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/mi-vc/proofs', async (req: Request, res: Response) => {
    try {
        const issuers = req.body?.issuers;
        const payload = req.body?.payload;
        const holderDid = req.body?.holder_did;
        if (!Array.isArray(issuers) || issuers.length === 0 || !payload || !holderDid) {
            return res.status(400).json({ok: false, error: 'Missing issuers, holder_did, or payload'});
        }
        const resolved = await ensureBlsKeyRefs(issuers);
        const proofs = await createProofsOfOwnershipPerIssuer(resolved, holderDid, payload);
        res.json({ok: true, proofsOfOwnership: proofs});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/mi-vc/finalize', async (req: Request, res: Response) => {
    try {
        const payload = req.body?.payload;
        const signatures = req.body?.signatures;
        const aggregatedKey = req.body?.aggregatedKey;
        const proofsOfOwnership = req.body?.proofsOfOwnership;
        const type = req.body?.type ?? ['Sign_MultiSign_VerifiableCredential'];
        const store = Boolean(req.body?.store);
        if (!payload || !Array.isArray(signatures) || signatures.length === 0 || !aggregatedKey || !Array.isArray(proofsOfOwnership)) {
            return res.status(400).json({ok: false, error: 'Missing payload, signatures[], aggregatedKey, or proofsOfOwnership[]'});
        }
        const vc = await agent.createProofOfOwnershipMultiIssuerVerifiableCredential({
            credential: payload,
            proofData: {signatures, publicKey: aggregatedKey},
            type,
            proofsOfOwnership,
            proofFormat: 'ProofOfOwnership-aggregate-bls-multi-signature',
            signatures,
        });
        if (store) {
            await agent.dataStoreSaveVerifiableCredential({verifiableCredential: vc});
        }
        res.json({ok: true, vc});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});

app.post('/mi-vc/verify', async (req: Request, res: Response) => {
    try {
        const vc = req.body?.vc;
        if (!vc || typeof vc !== 'object') {
            return res.status(400).json({ok: false, error: 'Missing body.vc'});
        }
        const result = await verifyMultiSignatureVC(vc);
        res.json({ok: true, verified: !!(result as any)?.verified, result});
    } catch (e: any) {
        res.status(500).json({ok: false, error: String(e?.message || e)});
    }
});


// Endpoint to get DID ETHR by private key
app.get("/api/v0/check/", async (req: Request, res: Response) => {
    const walletAddr: string = <string>req.query.walletaddr;
    try {
        console.log(`Checking DID for wallet address: ${walletAddr}`);
        const identifier = await agentETH.didManagerGetByAlias({alias: walletAddr});
        console.log(`Identifier found: ${JSON.stringify(identifier)}`);
        res.send(identifier);
    } catch (error) {
        console.error(`Error retrieving DID for wallet address ${walletAddr}:`, error);
        res.send({result: 'null'});
    }
});

// Import a DID ETHR identity. POST keeps private key material out of request
// URLs and access logs; GET remains as a backwards-compatible legacy route.
async function setupEthDid(req: Request, res: Response) {
    const input = req.method === 'POST' ? req.body : req.query;
    const privateKey = typeof input?.privatekey === 'string'
        ? input.privatekey.trim()
        : '';
    const walletAddr = typeof input?.walletaddr === 'string'
        ? input.walletaddr.trim()
        : '';
    const privateKeyHex = privateKey.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex) || !/^0x[0-9a-fA-F]{40}$/.test(walletAddr)) {
        return res.status(400).send({error: 'A valid privatekey and walletaddr are required.'});
    }
    let derivedAddress: string;
    try {
        derivedAddress = new Wallet(`0x${privateKeyHex}`).address;
    } catch (_error) {
        return res.status(400).send({error: 'A valid privatekey and walletaddr are required.'});
    }
    if (derivedAddress.toLowerCase() !== walletAddr.toLowerCase()) {
        return res.status(400).send({error: 'walletaddr does not match privatekey.'});
    }

    try {
        console.log(`Setting up DID for wallet address: ${walletAddr}`);
        let identifier = await agentETH.didManagerGetByAlias({alias: walletAddr});
        console.log(`Identifier found: ${JSON.stringify(identifier)}`);
        res.send(identifier);
        return;
    } catch (error) {
        console.warn(`DID not found for wallet address ${walletAddr}, proceeding to import. Error:`, error);
    }

    // If identifier not found, then import it
    try {
        const identifier = await agentETH.didManagerImport({
            did: "did:ethr:" + walletAddr,
            alias: walletAddr,
            provider: "did:ethr",
            keys: [
                {
                    type: "Secp256k1",
                    kms: "local",
                    kid: "key-1" + walletAddr,
                    privateKeyHex,
                } as MinimalImportableKey,
            ],
            services: [],
        });
        console.log(`Identifier created: ${JSON.stringify(identifier)}`);
        res.send(identifier);
    } catch (error) {
        console.error(`Error creating identifier for wallet address ${walletAddr}:`, error);
        res.status(500).send({error: 'An error occurred while creating the identifier.'});
    }
}

app.post("/api/v0/setup/", setupEthDid);
app.get("/api/v0/setup/", setupEthDid);

app.get("/api/v0/confirm/", async (req: Request, res: Response) => {
    let privateKey: string = <string>req.query.privatekey;

    let walletAddr: string = <string>req.query.walletaddr;

    let identifier;
    // Use the private key directly without converting it
    console.log(`Confirming DID for wallet address: ${walletAddr}`)
    try {
        identifier = await agentETH.didManagerGetByAlias({alias: walletAddr});
        console.log(identifier)

    } catch (error) {
        console.log(error)

    }
    if (identifier) {
        console.log(identifier);
        res.send(identifier);
        return;
    }

    try {
        identifier = await agentETH.didManagerImport({
            did: "did:ethr:" + walletAddr,
            alias: walletAddr,
            provider: "did:ethr",
            keys: [
                {
                    "type": "Secp256k1",
                    "kms": "local",
                    "kid": "key-1" + walletAddr,
                    privateKeyHex: privateKey
                } as MinimalImportableKey,
            ],
            services: []
        });
        console.log(identifier);
        res.send(identifier);
    } catch (error) {
        console.error(error);
        res.status(500).send({error: 'An error occurred while creating the identifier.'});
    }
});

app.get("/create_did_by_alias", async (req: Request, res: Response) => {
    let gotalias: string = <string>req.query.alias

    const identifier = await agent.didManagerCreate({alias: gotalias})
    res.send(identifier);
});

app.get("/create_did", async (req: Request, res: Response) => {
    try {
        const configuredIdentifier = await ensureConfiguredSepoliaDid();
        if (configuredIdentifier) {
            res.send(configuredIdentifier);
            return;
        }

        const identifier = await agent.didManagerCreate({})
        res.send(identifier);
    } catch (error) {
        console.error('Error creating/importing DID:', error);
        res.status(500).send({ error: 'Failed to create or import DID' });
    }
});


// Define a route that returns a list of dids from the wallet
app.get('/get_own_did', async (req: Request, res: Response) => {
    const identifiers = await agent.didManagerFind()
    const identifiersETHR = await agentETH.didManagerFind()

    console.log(`There are ${identifiers.length} identifiers`)

    let list: string[] = []


    if (identifiers.length > 0) {
        identifiers.map((id) => {
            list.push(id.did)
        })
    }
    if (identifiersETHR.length > 0) {
        identifiersETHR.map((id) => {
            list.push(id.did)
        })
    }
    res.send({"dids": list});
});

// Define a route that returns a list of dids from the wallet
app.get('/get_own_did_eth', async (req: Request, res: Response) => {
    const identifiers = await agentETH.didManagerFind()
    console.log(`There are ${identifiers.length} identifiers`)

    let list: string[] = []
    if (identifiers.length > 0) {
        identifiers.map((id) => {
            list.push(id.did)
        })
    }
    res.send({"dids": list});
});


// Define a route that returns a did document from the wallet
app.get('/get_did_doc', async (req: Request, res: Response) => {
    let gotstring: string = <string>req.query.did;

    // Choose the appropriate agent based on the presence of ":sepolia" in the did
    const agentToUse = !gotstring.includes(':sepolia') ? agentETH : agent;

    try {
        const identifier = await agentToUse.didManagerGet({did: gotstring});
        console.log('identifier', identifier);

        res.send(identifier);
    } catch (error) {
        console.error('Error fetching DID document:', error);
        res.status(500).send({error: 'Failed to fetch DID document'});
    }
});


// Define an interface representing the structure of your JSON object
interface VerifiableCredentialDecoded {
    vc: any; // Define the type of vc accordingly
    sub: string;
    nbf: number;
    iss: string;
}

// Define an interface representing the structure of your JSON object
interface VerifiableCredentialDecoded {
    vc: any; // Define the type of vc accordingly
    sub: string;
    nbf: number;
    iss: string;
}

// Define the route to store a verifiable credential
app.post('/store_vc', bodyParser.json(), async (req: Request, res: Response) => {
    try {
        console.log("here");
        console.log(req.body); // This should work
        // Log the keys of the JSON object
        const did = req.body.did;

        // Choose the appropriate agent based on the presence of "sepolia" in the did
        const agentToUse = !did.includes('sepolia') ? agentETH : agent;

        const decoded_jwt: VerifiableCredentialDecoded = jwtDecode(req.body.verifiableCredential);
        const verifiable_credential = format_jwt_decoded_to_VC(req.body.verifiableCredential, decoded_jwt) as VerifiableCredential;

        try {
            console.log(req.body.verifiableCredential);
            console.log(req.body.credentialSubject);

            let vc: IDataStoreSaveVerifiableCredentialArgs = ({verifiableCredential: verifiable_credential}) as IDataStoreSaveVerifiableCredentialArgs;
            console.log("here is vc" + JSON.stringify(vc));

            // Use the selected agent to save the verifiable credential
            const hash = await agentToUse.dataStoreSaveVerifiableCredential(vc);
            res.send({res: "OK", hash: hash});

        } catch (error) {
            console.log(error);
            // We'll proceed, but let's report it
            res.status(500).send({
                message: `error in store`
            });
        }

    } catch (error) {
        console.log(error);
        // Handle errors
        res.status(500).send({
            message: `error in processing`
        });
    }
});

// Internal function to issue a verifiable credential
async function issueCredential(
    issuer_did: string,
    holder_did: string,
    type_cred: string,
    attributes: JSON,
    toStore: boolean
) {
    let credential_subject_full = {...{id: holder_did}, ...attributes};
    let typeToPut: string[] = [];

    if (type_cred) {
        typeToPut.push(type_cred);
    }

    // Choose the appropriate agent based on the presence of "sepolia" in the issuer_did
    const agentToUse = !issuer_did.includes(':sepolia') ? agentETH : agent;

    // Create the verifiable credential
    let verifiableCredential = await agentToUse.createVerifiableCredential({
        credential: {
            "@context": ["https://www.w3.org/ns/credentials/v2"],
            issuer: {id: issuer_did},
            type: typeToPut,
            credentialSubject: credential_subject_full,
        },
        proofFormat: 'jwt',
        fetchRemoteContexts: true
    });

    // Optionally store the credential
    if (toStore) {
        const hash = await agentToUse.dataStoreSaveVerifiableCredential({verifiableCredential});
        console.log("Stored credential with hash: " + hash);
    }

    return verifiableCredential; // Return the JWT of the credential
}

// Route without measuring execution time
app.post('/issue_verifiable_credential', async (req: Request, res: Response) => {
    let issuer_did: string = <string>req.body.issuer;
    let holder_did: string = <string>req.body.holder;
    let type_cred: string = <string>req.body.type;
    const attributes: JSON = req.body.attributes;
    const toStore: boolean = req.body.store === true;

    try {
        const jwt = (await issueCredential(issuer_did, holder_did, type_cred, attributes, toStore)).proof.jwt;
        res.send({res: "OK", jwt});
    } catch (error) {
        console.log(error);
        res.status(500).send({message: `Credential issuer must be a DID managed by this agent`});
    }
});

// Test route that measures execution time
app.post('/test_issue_verifiable_credential', async (req: Request, res: Response) => {
    let issuer_did: string = <string>req.body.issuer;
    let holder_did: string = <string>req.body.holder;
    let type_cred: string = <string>req.body.type;
    const attributes: JSON = req.body.attributes;
    const toStore: boolean = req.body.store === true;
    const numTrials: number = req.body.numTrials || 1; // Number of trials, default is 1

    let times: number[] = [];

    for (let i = 0; i < numTrials; i++) {
        const start = performance.now();
        try {
            (await issueCredential(issuer_did, holder_did, type_cred, attributes, toStore)).proof.jwt;
        } catch (error) {
            console.log(error);
            res.status(500).send({message: `Credential issuer must be a DID managed by this agent`});
            return;
        }
        const end = performance.now();
        times.push(end - start);
    }

    // Calculate mean and standard deviation
    const mean = times.reduce((a, b) => a + b, 0) / numTrials;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
    const stdev = Math.sqrt(variance);

    res.send({mean, stdev});
});



app.post('/issue_verifiable_credential/selective_disclosure', async (req: Request, res: Response) => {
    let issuer_did: string = <string>req.body.issuer;
    let holder_did: string = <string>req.body.holder;
    let type_cred: string = <string>req.body.type;
    const attributes: JSON = req.body.attributes;
    const toStore: boolean = req.body.store === true;
    // The route generates a proof (PVC) by signing the new credential,
    // which consists of hashed claims (ChV_C) and metadata (MVC).
    try {
        // The route then returns the Verifiable Credential (VCh) and the attributes data structure:
        // VCh = < ChV_C, MVC, PVC >
        // attributes = < (path(claim1), val1, key1), ..., (path(claimn), valn, keyn) >

        //console.log("pre creation of VCPayload")
        let resultFromHashing = await createVCPayload(attributes)
        //console.log("post creation of VCPayload")
        let mapStructure = resultFromHashing['disclosure']

        let jwt: any = {}
        //console.log("pre issue")

        jwt['vc'] = await issueCredential(issuer_did, holder_did, type_cred, resultFromHashing['hashedAttributes'], toStore);
        jwt['map'] = mapStructure;

        res.status(200).send(jwt)
    } catch (error) {
        console.log(error);
        res.status(500).send({message: `Error in creating VCPayload`});

    }
});


app.post('/test/issue_verifiable_credential/selective_disclosure', async (req: Request, res: Response) => {
    let issuer_did: string = <string>req.body.issuer;
    let holder_did: string = <string>req.body.holder;
    let type_cred: string = <string>req.body.type;
    const attributes: JSON = req.body.attributes;
    const toStore: boolean = req.body.store === true;
    const numTrials: number = req.body.numTrials || 1; // Number of trials, default is 1
    let times: number[] = [];
    let jwt: any = {}

    for (let i = 0; i < numTrials; i++) {
        const start = performance.now();
        try {
            let resultFromHashing = await createVCPayload(attributes)
            //console.log("post creation of VCPayload")
            let mapStructure = resultFromHashing['disclosure']

            //console.log("pre issue")

            jwt['vc'] = [await issueCredential(issuer_did, holder_did, type_cred, resultFromHashing['hashedAttributes'], toStore)];
            jwt['map'] = mapStructure;
        } catch (error) {
            console.log(error);
            res.status(500).send({message: `Credential issuer must be a DID managed by this agent`});
            return;
        }
        const end = performance.now();
        times.push(end - start);
    }

    // Calculate mean and standard deviation
    const mean = times.reduce((a, b) => a + b, 0) / numTrials;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
    const stdev = Math.sqrt(variance);

    res.send({mean, stdev,jwt});
});


app.post('/issue_verifiable_presentation/selective_disclosure', async (req: Request, res: Response) => {
    const holderDid: string = req.body.holder;
    const typeVP: string = req.body.type;
    const attributesToDisclose = req.body.attributesToDisclose;
    const hashOfVCs: string[] = req.body.hashOfVCs;  // Assuming it's an array of hash values
    let vcs: VerifiableCredential[] = [];
    try {
        // Fetch disclosures from files named by {hash_of_vc}.json
        const disclosures: any[] = [];

        for (const hash of hashOfVCs) {

            const filePath = path.join("./", `${hash}.json`);

            let respose = await agent.dataStoreGetVerifiableCredential({hash})
            if (!respose) {
                //if not in the agent connected to sepolia, find it in the ETH sepolia agent
                respose = await agentETH.dataStoreGetVerifiableCredential({hash})
            }

            vcs.push(respose)
            try {
                // Check if file exists
                if (fs.existsSync(filePath)) {
                    // Read the file content and parse it
                    const fileData = fs.readFileSync(filePath, 'utf-8');
                    const disclosure = JSON.parse(fileData);
                    disclosures.push(disclosure);
                } else {
                    console.warn(`Disclosure file for ${hash} not found.`);
                }
            } catch (err) {
                console.error(`Error reading file for ${hash}:`, err);
            }



        }
        let payload_attributes = createVPPayload(vcs, attributesToDisclose, disclosures); // Pass disclosures to the payload


        let vp =await  createVP(typeVP,"",holderDid,vcs,payload_attributes);



        // Send the response back with the JWT
        res.send({res: "OK", vp});
    } catch (error) {
        console.error(error);
        res.status(500).send({message: "Internal server error"});
    }
});


app.post("list_verifiable_for_selective_disclosure")

app.post('/test/issue_verifiable_presentation/selective_disclosure', async (req: Request, res: Response) => {
    const holderDid: string = req.body.holder;
    const typeVP: string = req.body.type;
    const attributesToDisclose = req.body.attributesToDisclose;
    const hashOfVCs: string[] = req.body.hashOfVCs;  // Assuming it's an array of hash values
    let vcs: VerifiableCredential[] = [];
    const numTrials: number = req.body.numTrials || 1; // Number of trials, default is 1

    try {
        // Fetch disclosures from files named by {hash_of_vc}.json
        const disclosures: any[] = [];

        for (const hash of hashOfVCs) {

            const filePath = path.join("./", `${hash}.json`);

            let respose = await agent.dataStoreGetVerifiableCredential({hash})
            if (!respose) {
                //if not in the agent connected to sepolia, find it in the ETH sepolia agent
                respose = await agentETH.dataStoreGetVerifiableCredential({hash})
            }

            vcs.push(respose)
            try {
                // Check if file exists
                if (fs.existsSync(filePath)) {
                    // Read the file content and parse it
                    const fileData = fs.readFileSync(filePath, 'utf-8');
                    const disclosure = JSON.parse(fileData);
                    disclosures.push(disclosure);
                } else {
                    console.warn(`Disclosure file for ${hash} not found.`);
                }
            } catch (err) {
                console.error(`Error reading file for ${hash}:`, err);
            }



        }


        let times: number[] = [];
        let vp;
        for (let i = 0; i < numTrials; i++) {
            const start = performance.now();
            try {
                let payload_attributes = createVPPayload(vcs, attributesToDisclose, disclosures); // Pass disclosures to the payload
                let vp =await  createVP(typeVP,"",holderDid,vcs,payload_attributes);
            } catch (error) {
                console.log(error);
                res.status(500).send({message: `Credential issuer must be a DID managed by this agent`});
                return;
            }
            const end = performance.now();
            times.push(end - start);
        }

        // Calculate mean and standard deviation
        const mean = times.reduce((a, b) => a + b, 0) / numTrials;
        const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
        const stdev = Math.sqrt(variance);

        res.send({mean, stdev,vp});



        // Send the response back with the JWT
        res.send({res: "OK", vp});
    } catch (error) {
        console.error(error);
        res.status(500).send({message: "Internal server error"});
    }
});

async function createVP(typeVP: string, assertion: string, holder: string, vcs: VerifiableCredential[], jsonVar: any[]): Promise<VerifiablePresentation | null> {
    let presentationPayload: PresentationPayload = {} as PresentationPayload;


    console.log("those are VCS "+ vcs)

    presentationPayload.type = ["VerifiablePresentation", typeVP]
    presentationPayload["@context"] = ["https://www.w3.org/ns/credentials/v2"]
    presentationPayload.holder = holder
    presentationPayload.verifiableCredential = vcs as [VerifiableCredential];



    const agentToUse = !holder.includes('sepolia') ? agentETH : agent;


    //create a uuid for the VP
    let uuid = crypto.randomUUID()
    presentationPayload.id = uuid;
    presentationPayload.attributes = jsonVar;


    try {
        let verifiablePresentation = await agentToUse.createVerifiablePresentation({
            presentation: presentationPayload,
            proofFormat: 'jwt'
        })
        return verifiablePresentation;
    } catch (error) {
        console.log(error)
        return null
    }
    return null
}


app.post('/verify/vp/selective_disclosure_correctness', async (req: Request, res: Response) => {
        const vp = req.body.vp;
        let jwt:any = {}
    try{
        jwt["verificationRES"] = await verifyVPSelectiveDisclousureCorrectness(vp)
        res.send({res: "OK", jwt});
    } catch (error) {
        console.log(error);
        res.status(500).send({message: `Error`});
    }
});


app.post('/test/verify/vp/selective_disclosure_correctness', async (req: Request, res: Response) => {
    const vp = req.body.vp;
    const numTrials: number = req.body.numTrials || 1; // Number of trials, default is 1
    let times: number[] = [];

    for (let i = 0; i < numTrials; i++) {
        const start = performance.now();
        try {
            (await verifyVPSelectiveDisclousureCorrectness(vp));
        } catch (error) {
            console.log(error);
            res.status(500).send({message: `Credential issuer must be a DID managed by this agent`});
            return;
        }
        const end = performance.now();
        times.push(end - start);
    }

    // Calculate mean and standard deviation
    const mean = times.reduce((a, b) => a + b, 0) / numTrials;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
    const stdev = Math.sqrt(variance);

    res.send({mean, stdev});
});


// Define the route to store a verifiable credential for selective disclousure
app.post('/store_vc/selective_disclosure', bodyParser.json(), async (req: Request, res: Response) => {
    try {
        // Log the keys of the JSON object
        const did = req.body.did;
        const vc = req.body.vc;
        const map = req.body.map;

        // Choose the appropriate agent based on the presence of "sepolia" in the did
        const agentToUse = !did.includes('sepolia') ? agentETH : agent;

        const verifiable_credential = vc as VerifiableCredential;

        try {
            let vc: IDataStoreSaveVerifiableCredentialArgs = ({ verifiableCredential: verifiable_credential }) as IDataStoreSaveVerifiableCredentialArgs;

            // Use the selected agent to save the verifiable credential
            const hash = await agentToUse.dataStoreSaveVerifiableCredential(vc);

            // Define file path to store mapping
            const filePath = path.join("./", `${hash}.json`);
            const fileData = JSON.stringify(map, null, 2);

            // Write mapping to a file named after the hash
            fs.writeFileSync(filePath, fileData);
            //console.log(`Mapping stored in file: ${filePath}`);

            res.send({ res: "OK", hash: hash });

        } catch (error) {
            console.log(error);
            // We'll proceed, but let's report it
            res.status(500).send({
                message: `error in store`
            });
        }
    } catch (error) {
        console.log(error);
        // Handle errors
        res.status(500).send({
            message: `error in processing`
        });
    }
});





// Internal function to issue a verifiable presentation for holder claim
async function issueHolderClaimPresentation(
    holderDid: string,
    typeCred: string,
    attributes: JSON,
    assertion: string,
    toStore: boolean
) {
    // Choose the appropriate agent based on the presence of "sepolia" in the holderDid
    const agentToUse = !holderDid.includes('sepolia') ? agentETH : agent;



    // Create verifiable presentation
    const verifiablePresentation = await createVPwithHolderClaim(typeCred, assertion, holderDid, attributes);

    if (verifiablePresentation) {
        // Optionally store the verifiable presentation
        if (toStore) {
            const hash = await agentToUse.dataStoreSaveVerifiablePresentation({verifiablePresentation});
            console.log("Stored verifiable presentation with hash: " + hash);
        }
        return verifiablePresentation.proof.jwt; // Return the JWT of the presentation
    } else {
        throw new Error("Failed to create verifiable presentation");
    }
}

// Route without measuring execution time
app.post('/issue_verifiable_presentation/holder_claim', async (req: Request, res: Response) => {
    const holderDid: string = req.body.holder;
    const typeCred: string = req.body.type;
    const attributes: JSON = req.body.attributes;
    const assertion: string = req.body.assertion;
    const toStore: boolean = req.body.store === true;

    try {
        const jwt = await issueHolderClaimPresentation(holderDid, typeCred, attributes, assertion, toStore);
        res.send({res: "OK", jwt});
    } catch (error) {
        console.error(error);
        res.status(500).send({message: "Internal server error"});
    }
});

// Test route that measures execution time
app.post('/test_issue_verifiable_presentation/holder_claim', async (req: Request, res: Response) => {
    const holderDid: string = req.body.holder;
    const typeCred: string = req.body.type;
    const attributes: JSON = req.body.attributes;
    const assertion: string = req.body.assertion;
    const toStore: boolean = req.body.store === true;
    const numTrials: number = req.body.numTrials || 1; // Number of trials, default is 1

    let times: number[] = [];

    for (let i = 0; i < numTrials; i++) {
        const start = performance.now();
        try {
            await issueHolderClaimPresentation(holderDid, typeCred, attributes, assertion, toStore);
        } catch (error) {
            console.error(error);
            res.status(500).send({message: "Internal server error"});
            return;
        }
        const end = performance.now();
        times.push(end - start); // store the execution time
    }

    // Calculate mean and standard deviation
    const mean = times.reduce((a, b) => a + b, 0) / numTrials;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
    const stdev = Math.sqrt(variance);

    res.send({mean, stdev});
});


// Define a route that returns a list of verifiable presentations from the wallet
app.get('/list_verifiable_presentations', async (req: Request, res: Response) => {
    try {
        // Retrieve the list of verifiable presentations from the wallet
        const verifiablePresentations = await agent.dataStoreORMGetVerifiablePresentations();
        verifiablePresentations.concat(await agentETH.dataStoreORMGetVerifiablePresentations())
        // Send the list of verifiable presentations as the response
        res.send(verifiablePresentations);
    } catch (error) {
        // If an error occurs, send an error response
        console.error(error);
        res.status(500).send({message: "Internal server error"});
    }
});


// Define a route that returns a list of verifiable credentials from wallet without type needed
app.get('/api/v0/list-verifiable-credentials', async (req: Request, res: Response) => {
    console.log("received request to get verifiable credentials with type")
    // Fetch results from both data stores
    let response1 = await agent.dataStoreORMGetVerifiableCredentials();
    let response2 = await agentETH.dataStoreORMGetVerifiableCredentials();

    // Concatenate the results
    let concatenatedResponse = response1.concat(response2);
    console.log("respon" + concatenatedResponse.toString())

    res.send(concatenatedResponse);
});

// Define a route that returns a list of verifiable credentials from wallet
app.get('/api/v0/list-verifiable-credentials-with-type', async (req: Request, res: Response) => {
    console.log("received request to get verifiable credentials with type")
    let queryParam = <string>req.query.type
    const query: FindArgs<TCredentialColumns> = {
        where: [
            {
                column: 'type',
                value: ['VerifiableCredential,' + queryParam],
                op: 'Equal',
            }
        ],
        order: [{column: 'issuanceDate', direction: 'ASC'}],
    }


    // Fetch results from both data stores
    let response1 = await agent.dataStoreORMGetVerifiableCredentials(query);
    let response2 = await agentETH.dataStoreORMGetVerifiableCredentials(query);

    // Concatenate the results
    let concatenatedResponse = response1.concat(response2);
    console.log("respon" + concatenatedResponse.toString())

    res.send(concatenatedResponse);
});


// Define a route that returns a list of verifiable credentials along with their mappings
app.get('/api/v0/list-verifiable-credentials-with-type/selective_disclosure', async (req: Request, res: Response) => {
    console.log("Received request to get verifiable credentials with type");

    let queryParam = <string>req.query.type;
    const query: FindArgs<TCredentialColumns> = {
        where: [
            {
                column: 'type',
                value: ['VerifiableCredential,' + queryParam],
                op: 'Equal',
            }
        ],
        order: [{ column: 'issuanceDate', direction: 'ASC' }],
    };

    try {
        // Fetch results from both data stores
        let response1 = await agent.dataStoreORMGetVerifiableCredentials(query);
        let response2 = await agentETH.dataStoreORMGetVerifiableCredentials(query);

        // Concatenate the results
        let concatenatedResponse = response1.concat(response2);

        // Read mappings from files
        let enrichedResponse = concatenatedResponse.map(vc => {
            const filePath = path.join("./", `${vc.hash}.json`);
            let mapping = null;

            if (fs.existsSync(filePath)) {
                try {
                    const fileData = fs.readFileSync(filePath, 'utf8');
                    mapping = JSON.parse(fileData);
                } catch (error) {
                    console.error(`Error reading mapping for ${vc.hash}:`, error);
                }
            }

            return { ...vc, mapping };
        });

        res.send(enrichedResponse);
    } catch (error) {
        console.error("Error fetching credentials:", error);
        res.status(500).send({ message: "Error fetching credentials" });
    }
});
// Define a route that returns a list of verifiable presentations from the wallet based on a specific type
app.get('/list_verifiable_presentations_with_type', async (req: Request, res: Response) => {
    try {
        // Extract the type query parameter from the request
        const queryParam: string = req.query.type as string;

        // Define the query to filter verifiable presentations by type
        const query: FindArgs<TPresentationColumns> = {
            where: [
                {
                    column: 'type',
                    value: ['VerifiablePresentation,' + queryParam],
                    op: 'Equal',
                }
            ],
            order: [{column: 'issuanceDate', direction: 'ASC'}],
        };

        // Retrieve the list of verifiable presentations from the wallet based on the type query
        // Fetch results from both data stores
        let response1 = await agent.dataStoreORMGetVerifiablePresentations(query);
        let response2 = await agentETH.dataStoreORMGetVerifiablePresentations(query);

        // Concatenate the results
        let concatenatedResponse = response1.concat(response2);
        console.log("response" + concatenatedResponse.toString())

        res.send(concatenatedResponse);
    } catch (error) {
        // If an error occurs, send an error response
        console.error(error);
        res.status(500).send({message: "Internal server error"});
    }
});


// Define a route that returns ONE verifiable credentials from wallet given an HASH
app.get('/get_verifiable_credential', async (req: Request, res: Response) => {
    let hash: string = <string>req.query.hash_cred
    let respose = await agent.dataStoreGetVerifiableCredential({hash})
    if (!respose) {
        //if not in the agent connected to sepolia, find it in the ETH sepolia agent
        respose = await agentETH.dataStoreGetVerifiableCredential({hash})
    }

    res.send(respose);
});


//route to get a verifiable presentation from qr code
app.post('/decode_jwt/image', async (req: Request, res: Response) => {
    let png_data = req.body.img_data

    const buffer: Buffer = Buffer.from(png_data, 'base64')
    console.log(buffer.length + "len of buf\n")
    const png = PNG.sync.read(buffer);

    const code = decode(Uint8ClampedArray.from(png.data), png.width, png.height);
    console.log("after code decode")
    let code_jwt: string = <string>code?.data
    //remove initial and final " as the string seems double stringified
    if (code_jwt.startsWith('"') && code_jwt.endsWith('"')) {
        code_jwt = code_jwt.substring(1, code_jwt.length - 1);
    }


    let decoded = jwtDecode(code_jwt);
    let result = decoded; //result can be any json if not in the following two categories
    if (decoded.hasOwnProperty('vc')) {
        //if a veriable credential
        let result: VerifiableCredential = format_jwt_decoded_to_VC(code_jwt, decoded)
        res.send(result);
        return;
    } else if (decoded.hasOwnProperty('vp')) {
        let result: VerifiablePresentation = format_jwt_decoded_to_VP(code_jwt, decoded)

        res.send(result);

        return;
    }
    res.send(result);
});


// Define a route that returns a qr-code for a verifiable credential
app.get('/get_qr_code/wallet_hash', async (req: Request, res: Response) => {

    let hash: string = <string>req.query.hash
    let loaded_credential;
    //loaded_credential = await agent.dataStoreGetVerifiableCredential({hash: hash})

    try {
        loaded_credential = await agent.dataStoreGetVerifiableCredential({hash: hash})
        console.log(loaded_credential.proof['jwt'])

        qrcode.toFile('./filename.png', (loaded_credential.proof['jwt']), {
            color: {
                dark: '#000000',  // Blue dots
                light: '#ffffff' // White background
            }
        }, function (err) {
            if (err) throw err
            console.log('done')
        })
        // reading of qr code from file and obtain the jwt
        // code obtained from https://stackoverflow.com/questions/51948472/image-base64-string-to-uint8clampedarray
        // mixed with https://github.com/pngjs/pngjs/blob/c565210c602527eb459f857eeb78183997482d5b/README.md?plain=1#L258
        let data = fs.readFileSync('filename.png');


        const png = PNG.sync.read(data);

        console.log("this is png " + png)
        const code = decode(Uint8ClampedArray.from(png.data), png.width, png.height);
        let code_jwt: string = <string>code?.data
        //remove initial and final " as the string seems double stringified
        if (code_jwt.startsWith('"') && code_jwt.endsWith('"')) {
            code_jwt = code_jwt.substring(1, code_jwt.length - 1);
        }

        //var rawImageData = jpeg.decode(jpegData);
        //It follows an alternative way to decode a png, It seems to work but I have no source for it
        // Read the PNG image file
        /*
            fs.createReadStream('filename.png')
                .pipe(new PNG())
                .on('parsed', function () {
                    // Convert the image data into a Uint8Array
                    const imageData = new Uint8ClampedArray(this.width * this.height * 4);
                    for (let y = 0; y < this.height; y++) {
                        for (let x = 0; x < this.width; x++) {
                            const idx = (this.width * y + x) << 2;
                            imageData[idx] = this.data[idx];
                            imageData[idx + 1] = this.data[idx + 1];
                            imageData[idx + 2] = this.data[idx + 2];
                            imageData[idx + 3] = this.data[idx + 3];
                        }
                    }

                    // Use jsQR to decode the QR code
                    const code = decode(imageData, this.width, this.height);
                    if (code) {
                        console.log('Decoded QR code:', code.data);
                    } else {
                        console.log('No QR code found in the image.');
                    }
                });    });

         */
        let decoded_jwt = jwtDecode(code_jwt)

        // Set the appropriate content type in the response headers

        res.setHeader('Content-Type', 'image/png');
        res.send(data);
    } catch (Error) {
        res.status(500).send({
            message: `Response: unsupported engine}`
        });
    }


    //res.send({encoded_jwt:code_jwt,decoded_jwt:decoded_jwt,origin:format_jwt_decoded(code_jwt,decoded_jwt)})
});

// Define a route that returns a qr-code for a verifiable credential
app.post('/get_qr_code/jwt', async (req: Request, res: Response) => {
    let jwt: string = <string>req.body.jwt;
    try {
        qrcode.toFile('./filename.png', jwt, {
            color: {
                dark: '#000000',  // Blue dots
                light: '#ffffff' // White background
            }
        }, async function (err) {
            if (err) {
                throw err;
            } else {
                try {
                    // Wait for the file to be written before reading it
                    let data = await fs.promises.readFile('./filename.png');
                    console.log(data);
                    res.setHeader('Content-Type', 'image/png');
                    res.send(data);
                } catch (error) {
                    console.error('Error reading QR code file:', error);
                    res.status(500).send({
                        message: 'Error reading QR code file'
                    });
                }
            }
        });
    } catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).send({
            message: 'Error generating QR code'
        });
    }
});


//route to convert a jwt to VP or VC (or any other text)
//
// Shared decoder used by both GET (legacy) and POST (added for large VCs).
// Large authors carry up to 200 ESCO skills which produce ~30 KB JWTs;
// most HTTP servers refuse query strings that big, so GET fails the moment
// the dataset includes those authors. POST avoids the URL length limit
// entirely by carrying the JWT in the JSON body.
async function handleDecodeJwt(jwt: string | undefined, res: Response) {
    if (!jwt) {
        res.status(400).send("missing jwt");
        return;
    }
    try {
        let decoded = jwtDecode(jwt);
        if (decoded.hasOwnProperty('vc')) {
            let result: VerifiableCredential = format_jwt_decoded_to_VC(jwt, decoded);
            res.send(result);
            return;
        } else if (decoded.hasOwnProperty('vp')) {
            let result: VerifiablePresentation = format_jwt_decoded_to_VP(jwt, decoded);
            res.send(result);
            return;
        }
        res.send(decoded);
    } catch (error) {
        res.status(500).send("error decoding");
    }
}

app.get("/decode_jwt", async (req: Request, res: Response) => {
    return handleDecodeJwt(<string>req.query.jwt, res);
});

app.post("/decode_jwt", async (req: Request, res: Response) => {
    return handleDecodeJwt((req.body || {}).jwt, res);
});

function convertTimestampToIssuanceDate(timestampInSeconds: number): string {
    // Ensure timestamp is a valid number
    if (isNaN(timestampInSeconds) || !isFinite(timestampInSeconds)) {
        throw new Error("Invalid timestamp");
    }

    // Convert Unix timestamp to milliseconds
    const milliseconds = timestampInSeconds * 1000;

    // Create a new Date object from the milliseconds
    const date = new Date(milliseconds);

    // Format the date as YYYY-MM-DDTHH:mm:ss.000Z
    return date.toISOString();
}

function format_jwt_decoded_to_VC(jwt_encoded: string, jwt_decoded: any): VerifiableCredential {
    // Create an empty object
    let obj: any = {};
    let credSubj: any = {};
    let proofObj: any = {};
    let issuerObj: any = {};

    // Example usage
    console.log("date is" + jwt_decoded.nbf)
    const issuanceDate = convertTimestampToIssuanceDate(jwt_decoded.nbf);
    console.log("Issuance Date:", issuanceDate);

    obj["issuanceDate"] = issuanceDate;

    obj["@context"] = jwt_decoded.vc["@context"];
    console.log("obj[\"@context\"] =" + obj["@context"] + "\n\n")

    obj.type = jwt_decoded.vc.type;

    credSubj = jwt_decoded.vc.credentialSubject;
    credSubj.id = jwt_decoded.sub;
    obj.credentialSubject = credSubj;


    issuerObj.id = jwt_decoded.iss
    obj.issuer = issuerObj

    proofObj.type = "JwtProof2020";
    proofObj.jwt = jwt_encoded;

    obj.proof = proofObj;

    return (obj);
}

function format_jwt_decoded_to_VP(jwt_encoded: string, jwt_decoded: any): VerifiablePresentation {
    // Create an empty object
    let obj: any = {};
    let credentials: any = {};
    let proofObj: any = {};


    console.log("the keys of deconded" + jwt_decoded.keys)
    // Example usage
    console.log("date is" + jwt_decoded.nbf)
    const issuanceDate = convertTimestampToIssuanceDate(jwt_decoded.nbf);
    console.log("Issuance Date:", issuanceDate);

    obj["issuanceDate"] = issuanceDate;

    obj["@context"] = jwt_decoded.vp["@context"];


    obj.type = jwt_decoded.vp.type;
    obj.holder = jwt_decoded.iss //iss corresponds to the holder, the one creating the vp
    obj.id = jwt_decoded.jti;//jti corresponds to the id (Which can be a uuid) assigned to the claim


    credentials = jwt_decoded.vp.verifiableCredential;
    if (credentials) {
        let jwt_cred;
        for (let i = 0; i < credentials.length; i++) {
            if (!credentials[i].hasOwnProperty('vc')) { // if already decoded vc, keep as it is
                //if not then it is encoded as jwt, we decode and assign
                jwt_cred = jwtDecode(credentials[i]);
                credentials[i] = format_jwt_decoded_to_VC(credentials[i], jwt_cred); // assign decoded jwt
            }
        }
        obj.verifiableCredential = credentials
    }
    proofObj.type = "JwtProof2020";
    proofObj.jwt = jwt_encoded;

    obj.proof = proofObj;
    obj.attributes = jwt_decoded.attributes;
    console.log("obj before return" + obj)
    return (obj);
}


async function createVPwithHolderClaim(typeVP: string, assertion: string, holder: string, jsonVar: JSON): Promise<VerifiablePresentation | null> {
    let presentationPayload: PresentationPayload = {} as PresentationPayload;


    presentationPayload.type = ["VerifiablePresentation", typeVP]
    presentationPayload["@context"] = ["https://www.w3.org/ns/credentials/v2"]
    presentationPayload.holder = holder

    const agentToUse = !holder.includes('sepolia') ? agentETH : agent;


    //create a uuid for the VP
    let uuid = crypto.randomUUID()
    presentationPayload.id = uuid;
    presentationPayload.attributes = jsonVar;


    try {
        let verifiablePresentation = await agentToUse.createVerifiablePresentation({
            presentation: presentationPayload,
            proofFormat: 'jwt'
        })

        return verifiablePresentation
    } catch (error) {
        console.log(error)
        return null
    }
    return null
}

//verify_credential
app.post('/verify', async (req: Request, res: Response) => {

    const credential = <VerifiableCredential>req.body.credential
    // Choose the appropriate agent based on the presence of "sepolia" in the holderDid
    const agentToUse = !req.body.credential.issuer.id.includes(':sepolia') ? agentETH : agent;
    const result: IVerifyResult = await agentToUse.verifyCredential({
        credential: credential
    })

    console.log("result of verification" + result.verified)
    res.send({res: result.verified})
});

//verify_presentation (prefer multisignature verifier when available)
app.post('/verify/vp', async (req: Request, res: Response) => {
    const vp: W3CVerifiablePresentation | undefined = req.body?.vp;
    if (!vp) {
        return res.status(400).send({message: 'Missing body.vp'});
    }
    try {
        const result = await verifyBlsVP(vp);
        res.send({res: !!(result as any)?.verified, result});
    } catch (error) {
        console.error(error);
        res.status(500).send({message: 'Verification failed'});
    }
});

async function verifyPresentation(VP: W3CVerifiablePresentation, did: string): Promise<IVerifyResult> {
    //simple verification call, you need to provide the internal content of VerifiablePresentation:
    const agentToUse = !did.includes(':sepolia') ? agentETH : agent;
    let ris: IVerifyResult = await agentToUse.verifyPresentation({presentation: VP});
    return ris;
}

//test for X trials of verification of VC
app.post('/test_verify', async (req: Request, res: Response) => {
    const credential = <VerifiableCredential>req.body.credential;
    const numTrials = req.body.numTrials || 1; // Number of trials from the request, default is 1

    const agentToUse = !req.body.credential.issuer.id.includes(':sepolia') ? agentETH : agent;

    let times: number[] = [];

    for (let i = 0; i < numTrials; i++) {
        const start = performance.now();

        const result: IVerifyResult = await agentToUse.verifyCredential({
            credential: credential
        });

        const end = performance.now();
        times.push(end - start); // store the execution time
    }

    const mean = times.reduce((a, b) => a + b, 0) / numTrials;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
    const stdev = Math.sqrt(variance);

    console.log(`Result of verification: ${mean}, Stdev: ${stdev}`);
    res.send({mean, stdev});
});

//test for X trials of verification of VP
app.post('/test_verify/vp', async (req: Request, res: Response) => {
    const vp: W3CVerifiablePresentation = <W3CVerifiablePresentation>req.body.vp;
    const did = req.body.vp.holder;
    const numTrials = req.body.numTrials || 1; // Number of trials from the request, default is 1

    let times: number[] = [];

    for (let i = 0; i < numTrials; i++) {
        const start = performance.now();

        const result = await verifyPresentation(vp, did);

        const end = performance.now();
        times.push(end - start); // store the execution time
    }

    const mean = times.reduce((a, b) => a + b, 0) / numTrials;
    const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
    const stdev = Math.sqrt(variance);

    res.send({mean, stdev});
});


// Listen on port 3001
app.listen(3001, () => {
    console.log('Server is running on port 3001');
});
