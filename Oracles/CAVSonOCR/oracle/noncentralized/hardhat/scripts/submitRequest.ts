import { network } from "hardhat";
import * as dotenv from "dotenv";
import * as crypto from "crypto";
import { KZG } from "micro-eth-signer/kzg";
import { trustedSetup } from "@paulmillr/trusted-setups/fast.js";

dotenv.config();

const { ethers } = await network.create();

const COORDINATOR_ABI = [
  "function getRegisteredOracleIds() view returns (uint8[])",
  "function getOracle(uint8 oracleId) view returns (tuple(uint8 oracleId,address account,string did,bytes32 oraclesEncryptionKey,bool active,uint64 updatedAt))",
];

const REQUEST_REGISTRY_ABI = [
  "function submitBlobRequest(bytes32 requestID, bytes32 oracleSetID, uint64 nonce, uint64 deadline, tuple(uint8 oracleId, bytes32 ephemeralPublicKey, bytes12 nonce, bytes wrappedARequestKey)[] keyEnvelopes)",
];

type Recipient = { oracleId: number; oEncryKey: string };

type KeyEnvelope = {
  oracleId: number;
  ephemeralPublicKey: string;
  nonce: string;
  wrappedARequestKey: string;
};

type BlobPayload = {
  version: string;
  oracleSetID: string;
  algorithm: string;
  nonce: string;
  deadline: number;
  ciphertext: string;
};

const BLOB_FIELD_ELEMENTS = 4096;
const BLOB_ELEMENT_BYTES = 32;
const BLOB_PAYLOAD_BYTES_PER_ELEMENT = 31;
const BLOB_TOTAL_BYTES = BLOB_FIELD_ELEMENTS * BLOB_ELEMENT_BYTES;
const BLOB_MAX_PAYLOAD_BYTES = BLOB_FIELD_ELEMENTS * BLOB_PAYLOAD_BYTES_PER_ELEMENT;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name]?.trim();
  return raw ? (JSON.parse(raw) as T) : fallback;
}

function normalizeBytes32(value: string, label: string): string {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return ethers.keccak256(ethers.toUtf8Bytes(trimmed));
}

function deriveOracleSetID(coordinatorAddress: string, oracleIds: string[]): string {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`cavs-oracle-set-v1:${ethers.getAddress(coordinatorAddress)}:${oracleIds.join(",")}`),
  );
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function requestAAD(kind: string, oracleSetID: string, oracleID: number): Buffer {
  return Buffer.from(`CAVS encrypted request|${kind}|${oracleSetID}|${oracleID}`, "utf8");
}

function sealChaCha(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function rawX25519PublicKey(key: crypto.KeyObject): Buffer {
  return key.export({ format: "der", type: "spki" }).subarray(-32);
}

function x25519PublicKeyFromRaw(raw: Buffer): crypto.KeyObject {
  const spkiPrefix = Buffer.from("302a300506032b656e032100", "hex");
  return crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

function deriveWrapKey(shared: Buffer, oracleSetID: string, oracleID: number): Buffer {
  const info = Buffer.from(`CAVS request key wrap v1|${oracleSetID}|${oracleID}`, "utf8");
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), info, 32));
}

function canonicalCommitmentBytes(blobPayload: BlobPayload, keyEnvelopes: KeyEnvelope[]): Uint8Array {
  return ethers.toUtf8Bytes(
    JSON.stringify({
      version: "cavs-request-v1",
      oracleSetID: blobPayload.oracleSetID,
      algorithm: blobPayload.algorithm,
      deadline: blobPayload.deadline,
      blobPayload,
      keyEnvelopes,
    }),
  );
}

function encodeBlobPayloadBytes(blobPayloadBytes: Uint8Array): Uint8Array {
  if (blobPayloadBytes.length + 4 > BLOB_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `encrypted blob payload too large (${blobPayloadBytes.length} bytes > ${BLOB_MAX_PAYLOAD_BYTES - 4} max)`,
    );
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
    blobBytes.set(payloadLane.subarray(payloadOffset, payloadOffset + BLOB_PAYLOAD_BYTES_PER_ELEMENT), blobOffset);
  }
  return blobBytes;
}

function readBlobPayload(): BlobPayload {
  const hex = process.env.ENCRYPTED_REQUEST_BLOB_HEX?.trim();
  if (hex) {
    return JSON.parse(ethers.toUtf8String(ethers.getBytes(hex))) as BlobPayload;
  }
  const rawJson = process.env.ENCRYPTED_REQUEST_BLOB_JSON?.trim();
  if (!rawJson) {
    throw new Error("Set request fields or ENCRYPTED_REQUEST_BLOB_JSON/ENCRYPTED_REQUEST_BLOB_HEX");
  }
  return JSON.parse(rawJson) as BlobPayload;
}

function readKeyEnvelopes(): KeyEnvelope[] {
  const rawJson = process.env.KEY_ENVELOPES_JSON?.trim();
  if (!rawJson) {
    throw new Error("Set KEY_ENVELOPES_JSON when using a prebuilt blob payload");
  }
  return JSON.parse(rawJson) as KeyEnvelope[];
}

function buildBlobRequestArtifacts(
  oracleSetID: string,
  recipients: Recipient[],
  nonce: bigint,
  deadline: bigint,
): { blobPayload: BlobPayload; keyEnvelopes: KeyEnvelope[]; requestID: string; blobBytes: Uint8Array } {
  const statement = requireEnv("STATEMENT");
  const holderDid = requireEnv("HOLDER_DID");
  const presentation = parseJsonEnv<unknown | undefined>("PRESENTATION_JSON", undefined);
  const payload = {
    version: "cavs-request-v1",
    oracleSetID,
    holderDid,
    ...(statement ? { statement } : {}),
    statementHash: process.env.STATEMENT_HASH?.trim() || sha256Hex(statement),
    ...(presentation ? { presentation } : {}),
    nonce: nonce.toString(),
    deadline: Number(deadline),
  };

  const aRequestKey = crypto.randomBytes(32);
  const payloadNonce = crypto.randomBytes(12);
  const ciphertext = sealChaCha(
    aRequestKey,
    payloadNonce,
    Buffer.from(JSON.stringify(payload), "utf8"),
    requestAAD("payload", oracleSetID, -1),
  );

  const keyEnvelopes = recipients.map((recipient) => {
    const oEncryKey = Buffer.from(ethers.getBytes(recipient.oEncryKey));
    if (oEncryKey.length !== 32 || recipient.oEncryKey === ethers.ZeroHash) {
      throw new Error(`Oracle ${recipient.oracleId} has no announced OEncryKey`);
    }
    const ephemeral = crypto.generateKeyPairSync("x25519");
    const shared = crypto.diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: x25519PublicKeyFromRaw(oEncryKey),
    });
    const wrapNonce = crypto.randomBytes(12);
    const wrappedARequestKey = sealChaCha(
      deriveWrapKey(shared, oracleSetID, recipient.oracleId),
      wrapNonce,
      aRequestKey,
      requestAAD("key", oracleSetID, recipient.oracleId),
    );
    return {
      oracleId: recipient.oracleId,
      ephemeralPublicKey: ethers.hexlify(rawX25519PublicKey(ephemeral.publicKey)),
      nonce: ethers.hexlify(wrapNonce),
      wrappedARequestKey: ethers.hexlify(wrappedARequestKey),
    };
  });

  const blobPayload: BlobPayload = {
    version: "cavs-request-v1",
    oracleSetID,
    algorithm: "X25519-HKDF-SHA256+ChaCha20Poly1305",
    nonce: payloadNonce.toString("hex"),
    deadline: Number(deadline),
    ciphertext: ciphertext.toString("hex"),
  };
  const blobBytes = encodeBlobPayloadBytes(ethers.toUtf8Bytes(JSON.stringify(blobPayload)));
  const requestID = ethers.keccak256(canonicalCommitmentBytes(blobPayload, keyEnvelopes));
  return { blobPayload, keyEnvelopes, requestID, blobBytes };
}

async function resolveBlobFeeCap(provider: typeof ethers.provider): Promise<bigint> {
  try {
    const raw = await provider.send("eth_blobBaseFee", []);
    const blobBaseFee = BigInt(raw);
    return blobBaseFee * 2n;
  } catch {
    return ethers.parseUnits(process.env.REQUEST_MAX_FEE_PER_BLOB_GWEI || "2", "gwei");
  }
}

async function main() {
  const coordinatorAddress = requireEnv("CONTRACT_ADDRESS");
  const requestRegistryAddress =
    process.env.REQUEST_REGISTRY_ADDRESS?.trim() ||
    process.env.CAVS_REQUEST_REGISTRY_ADDRESS?.trim();
  if (!requestRegistryAddress) throw new Error("Set REQUEST_REGISTRY_ADDRESS");

  const coordinator = await ethers.getContractAt(COORDINATOR_ABI, coordinatorAddress);
  const oracleIds: bigint[] = await coordinator.getRegisteredOracleIds();
  if (oracleIds.length === 0) throw new Error("No registered oracle IDs found in the coordinator");

  const activeOracleIds: string[] = [];
  const recipients: Recipient[] = [];
  for (const oracleId of oracleIds) {
    const oracle = await coordinator.getOracle(oracleId);
    if (oracle.active) {
      const id = Number(oracleId);
      activeOracleIds.push(id.toString());
      recipients.push({ oracleId: id, oEncryKey: oracle.oraclesEncryptionKey });
    }
  }
  if (activeOracleIds.length === 0) throw new Error("No active oracles found in the coordinator");

  const oracleSetID = process.env.ORACLE_SET_ID
    ? normalizeBytes32(process.env.ORACLE_SET_ID, "ORACLE_SET_ID")
    : deriveOracleSetID(coordinatorAddress, activeOracleIds);
  const nonce = BigInt(process.env.REQUEST_NONCE || Date.now().toString());
  const deadline = BigInt(
    process.env.REQUEST_DEADLINE ||
      Math.floor(Date.now() / 1000 + Number(process.env.REQUEST_DEADLINE_SECONDS || "3600")).toString(),
  );

  const artifacts =
    process.env.ENCRYPTED_REQUEST_BLOB_JSON || process.env.ENCRYPTED_REQUEST_BLOB_HEX
      ? (() => {
          const blobPayload = readBlobPayload();
          const keyEnvelopes = readKeyEnvelopes();
          const blobBytes = encodeBlobPayloadBytes(ethers.toUtf8Bytes(JSON.stringify(blobPayload)));
          const requestID = ethers.keccak256(canonicalCommitmentBytes(blobPayload, keyEnvelopes));
          return { blobPayload, keyEnvelopes, requestID, blobBytes };
        })()
      : buildBlobRequestArtifacts(oracleSetID, recipients, nonce, deadline);

  const requestID = artifacts.requestID;
  const keyEnvelopes = artifacts.keyEnvelopes.map((envelope) => ({
    oracleId: envelope.oracleId,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    nonce: envelope.nonce,
    wrappedARequestKey: envelope.wrappedARequestKey,
  }));

  const registryInterface = new ethers.Interface(REQUEST_REGISTRY_ABI);
  const data = registryInterface.encodeFunctionData("submitBlobRequest", [
    requestID,
    oracleSetID,
    nonce,
    deadline,
    keyEnvelopes,
  ]);

  const [signer] = await ethers.getSigners();
  const feeData = await ethers.provider.getFeeData();
  const latestBlock = await ethers.provider.getBlock("latest");
  const blobFeeCap = await resolveBlobFeeCap(ethers.provider);
  const gasLimit = ((await ethers.provider.estimateGas({
    from: signer.address,
    to: requestRegistryAddress,
    data,
  })) *
    12n) /
    10n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
  const maxFeePerGas =
    feeData.maxFeePerGas ??
    ((latestBlock?.baseFeePerGas ?? ethers.parseUnits("1", "gwei")) * 2n + maxPriorityFeePerGas);

  const kzg = new KZG(trustedSetup);
  const tx = await signer.sendTransaction({
    type: 3,
    to: requestRegistryAddress,
    data,
    gasLimit,
    maxPriorityFeePerGas,
    maxFeePerGas,
    maxFeePerBlobGas: blobFeeCap,
    blobs: [ethers.hexlify(artifacts.blobBytes)],
    kzg,
  } as any);
  const receipt = await tx.wait();

  console.log(
    JSON.stringify(
      {
        requestID,
        oracleSetID,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
        requestRegistryAddress: ethers.getAddress(requestRegistryAddress),
        coordinatorAddress: ethers.getAddress(coordinatorAddress),
        activeOracleIds,
        keyEnvelopeCount: keyEnvelopes.length,
        blobBytes: artifacts.blobBytes.length,
        transactionHash: receipt?.hash || tx.hash,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
