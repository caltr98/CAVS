import express from 'express';
import cors from 'cors';
import axios from 'axios';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getAddress, Wallet } from 'ethers';
import { registerAuthorOracleRequestRoutes } from './authorOracleRequest.js';
import { registerOcrOracleRegistryRoutes } from './ocrOracleRegistry.js';
import {
    ExtractIdempotencyStore,
    IdempotencyCapacityError,
    IdempotencyConflictError,
    InvalidIdempotencyKeyError,
} from './extractIdempotency.js';
import config from './config.json' with { type: 'json' };
import trustedissuers from './trustedissuers.json' with { type: 'json' };

const app = express();
const outPort = 4200;
const PORT = 17005;

const PIPELINE_CONFIG_PATH = path.resolve('./pipeline.config.json');

const DEFAULT_PIPELINE_CONFIG = {
    keywordExtraction: {
        roberta: {
            top_n: 30,
            nr_candidates: 300,
            ngram_max: 2,
            use_mmr: true,
            diversity: 0.7,
            score_threshold: 0.30,
            timeout_s: 60,
        },
        keybert: {
            top_n: 30,
            nr_candidates: 300,
            ngram_max: 2,
            use_mmr: true,
            diversity: 0.7,
            score_threshold: 0.30,
            timeout_s: 60,
        },
        keyllm: {
            top_n: 30,
            temperature: 0.3,
            seed: 123,
            model: "gpt-4.1",
        },
    },
    enrichment: {
        max_per_keyword: 10,
        gpt: {
            temperature: 0.3,
            seed: 123,
            model: "gpt-4.1",
        },
    },
    competence: {
        support_threshold: 0.0,
        // Match Validation/liar2/scripts/competence_roberta_nesta/tokenize_and_call_nesta.py default mode.
        skill_mapping_mode: "keywords",
    },
    skillMapping: {
        // "keywords": map provided keywords to skills (default pipeline behaviour)
        // "extract": run OJD-DAPS extract directly on the original document text
        mode: "keywords",
        skill_match_thresh: null,
        per_keyword: false,
        fallback_extract: false,
        timeout_s: 90,
    },
};

let pipelineConfig = structuredClone(DEFAULT_PIPELINE_CONFIG);

function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const [key, value] of Object.entries(source)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
            continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            deepMerge(target[key], value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

function loadPipelineConfig() {
    try {
        const data = fs.readFileSync(PIPELINE_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(data);
        pipelineConfig = structuredClone(DEFAULT_PIPELINE_CONFIG);
        deepMerge(pipelineConfig, parsed);
        console.log('Loaded pipeline config from', PIPELINE_CONFIG_PATH);
    } catch (err) {
        pipelineConfig = structuredClone(DEFAULT_PIPELINE_CONFIG);
        console.warn('Using default pipeline config (could not load file):', err.message);
    }
}

function savePipelineConfig(value = pipelineConfig) {
    writeJsonFileAtomic(PIPELINE_CONFIG_PATH, value);
}

function writeJsonFileAtomic(filePath, value) {
    const destination = path.resolve(filePath);
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporary, destination);
    } finally {
        try {
            fs.rmSync(temporary, { force: true });
        } catch (_error) {
            // The temporary file normally no longer exists after rename.
        }
    }
}

let keywordExtractorEngines = ["RoBERTa"];
let enricherEngines = ["NONE", "YAGO"];
let skillExtractorEngines = ["OJD_DAPS"];

let selectedExtractorEngine = keywordExtractorEngines[0];
let selectedEnricherEngine = enricherEngines[0];
let selectedSkillExtractorEngine = skillExtractorEngines[0];
let selectedSelectiveDisclosureMode = false;
const selectedDIDPrivKey = String(
    readSecretFile(process.env.CAVS_DID_PRIVATE_KEY_FILE)
    || readSecretFile(process.env.PRIVATE_KEY_FILE)
    || process.env.CAVS_DID_PRIVATE_KEY
    || '',
).trim();
const selectedDIDWallet = selectedDIDPrivKey ? new Wallet(selectedDIDPrivKey) : null;
const configuredDIDWalletAddress = String(process.env.CAVS_DID_WALLET_ADDRESS || '').trim();
const selectedDIDETHAWalletAddr = configuredDIDWalletAddress
    ? getAddress(configuredDIDWalletAddress)
    : (selectedDIDWallet?.address || '');
if (
    selectedDIDWallet
    && selectedDIDETHAWalletAddr
    && selectedDIDWallet.address.toLowerCase() !== selectedDIDETHAWalletAddr.toLowerCase()
) {
    throw new Error('CAVS_DID_WALLET_ADDRESS does not match CAVS DID private key');
}
let selectedDID = '';

const keywordExtractorServiceEndpoint =
    process.env.ROBERTA_ENDPOINT ||
    process.env.KEYWORD_EXTRACTOR_ENDPOINT ||
    process.env.KEYBERT_ENDPOINT ||
    config.keywordExtractorServiceEndpoint ||
    config.keyBertServiceEndpoint;
const keyLLMServiceEndpoint = process.env.KEYLLM_ENDPOINT || config.keyLLMServiceEndpoint;
const yagoServiceEndpoint = process.env.YAGO_ENDPOINT || config.yagoServiceEndpoint;
const ojdDapsSkillsEndpoint = process.env.OJD_ENDPOINT || config.ojdDapsSkillsEndpoint;
const veramoAgentEndpoint = process.env.VERAMO_ENDPOINT || config.veramoAgentEndpoint;
const veramoRequestTimeoutMs = Math.max(
    65000,
    parseInt(process.env.CAVS_VERAMO_TIMEOUT_MS || process.env.VERAMO_REQUEST_TIMEOUT_MS || '600000', 10) || 600000,
);
const ocrVcSignerRequestTimeoutMs = Math.max(
    1000,
    parseInt(process.env.OCR_VC_SIGNER_TIMEOUT_MS || '5000', 10) || 5000,
);
const ocrVcLocalRequestTimeoutMs = Math.max(
    1000,
    parseInt(process.env.OCR_VC_LOCAL_TIMEOUT_MS || '65000', 10) || 65000,
);
const ocrVerificationRequestTimeoutMs = Math.max(
    1000,
    parseInt(process.env.OCR_VERIFICATION_TIMEOUT_MS || '120000', 10) || 120000,
);
// Keep this outer request deadline above the remote checker/proxy deadline
// (200 s in the publication runtime) while remaining below OCR's 300 s
// observation cap.  A shorter hard-coded deadline used to discard valid late
// checker responses and let OCR quorum mask the unavailable observation.
const competenceCheckerRequestTimeoutMs = Math.max(
    1000,
    parseInt(process.env.CAVS_COMPETENCE_TIMEOUT_MS || '220000', 10) || 220000,
);
const ocrRequesterCallbackTimeoutMs = Math.max(
    1000,
    parseInt(process.env.OCR_REQUESTER_CALLBACK_TIMEOUT_MS || '15000', 10) || 15000,
);
const ocrVcCallbackTimeoutMs = Math.max(
    1000,
    parseInt(process.env.OCR_VC_CALLBACK_TIMEOUT_MS || '15000', 10) || 15000,
);
const didSetupRequestTimeoutMs = Math.max(
    1000,
    parseInt(process.env.CAVS_DID_SETUP_TIMEOUT_MS || '15000', 10) || 15000,
);
const extractIdempotencyMaxInFlight = readBoundedIntegerEnvironment(
    'CAVS_EXTRACT_IDEMPOTENCY_MAX_IN_FLIGHT',
    256,
    1,
    4096,
);
const extractIdempotencyMaxResults = readBoundedIntegerEnvironment(
    'CAVS_EXTRACT_IDEMPOTENCY_MAX_RESULTS',
    512,
    1,
    16384,
);
const extractIdempotencyResultTtlMs = readBoundedIntegerEnvironment(
    'CAVS_EXTRACT_IDEMPOTENCY_TTL_MS',
    15 * 60 * 1000,
    1000,
    24 * 60 * 60 * 1000,
);
// Go's dedicated extractor transport retires idle connections after 60s.
// Keep the server side open longer so the client is always the endpoint that
// closes an idle pooled socket; the inverse ordering caused the archived
// mid-campaign `write: broken pipe`.
const cavsHttpKeepAliveTimeoutMs = readBoundedIntegerEnvironment(
    'CAVS_HTTP_KEEP_ALIVE_TIMEOUT_MS',
    120 * 1000,
    65 * 1000,
    10 * 60 * 1000,
);
const cavsHttpHeadersTimeoutMs = cavsHttpKeepAliveTimeoutMs + 5 * 1000;
const startupRetryDelayMs = Math.max(
    100,
    parseInt(process.env.CAVS_STARTUP_RETRY_DELAY_MS || '5000', 10) || 5000,
);
const remoteSignerIdentityCacheTtlMs = Math.max(
    0,
    parseInt(process.env.OCR_SIGNER_IDENTITY_CACHE_TTL_MS || '5000', 10) || 0,
);
const remoteSignerIdentityCacheMaxEntries = Math.max(
    1,
    parseInt(process.env.OCR_SIGNER_IDENTITY_CACHE_MAX_ENTRIES || '64', 10) || 64,
);
const ocrMaxRemoteEndpoints = Math.max(
    1,
    Math.min(
        256,
        parseInt(process.env.OCR_MAX_REMOTE_ENDPOINTS || '32', 10) || 32,
    ),
);
const ocrMaxVcSigners = Math.max(
    1,
    Math.min(
        256,
        parseInt(process.env.OCR_MAX_VC_SIGNERS || '32', 10) || 32,
    ),
);
const ocrMaxEmbeddedCredentials = Math.max(
    1,
    Math.min(
        64,
        parseInt(process.env.OCR_MAX_EMBEDDED_CREDENTIALS || '16', 10) || 16,
    ),
);
const ocrVcRemoteSignersDefault = !['0', 'false', 'no'].includes(
    String(process.env.OCR_VC_REMOTE_SIGNERS || 'true').trim().toLowerCase(),
);
const gptCompetenceEndpoint = process.env.GPT_COMP_ENDPOINT || config.gptCompServiceEndpoint || 'http://gptcomp:3030';
const azureOpenAICompetenceEndpoint = process.env.AZURE_OPENAI_COMP_ENDPOINT || 'http://azurecomp:3030';
const qwenCompetenceEndpoint = process.env.QWEN_COMP_ENDPOINT || config.qwenCompServiceEndpoint || 'http://qwencomp:3030';
const deepseekCompetenceEndpoint = process.env.DEEPSEEK_COMP_ENDPOINT || config.deepseekCompServiceEndpoint || 'http://deepseekcomp:3030';
const llamaCompetenceEndpoint = process.env.LLAMA_COMP_ENDPOINT || 'http://llamacomp:3030';
const gemmaCompetenceEndpoint = process.env.GEMMA_COMP_ENDPOINT || 'http://gemmacomp:3030';
const GPT_COMPETENCE_MODE_LABEL = "GPT competence service";
const AZURE_OPENAI_COMPETENCE_MODE_LABEL = "Azure model competence service";
const QWEN_COMPETENCE_MODE_LABEL = "Qwen competence service";
const DEEPSEEK_COMPETENCE_MODE_LABEL = "DeepSeek competence service";
const LLAMA_COMPETENCE_MODE_LABEL = "Llama competence service";
const GEMMA_COMPETENCE_MODE_LABEL = "Gemma competence service";
const ROBERTA_TO_NESTA_MODE_LABEL = "RoBERTa to Nesta mode";
const nestaKeywordEngine = String(process.env.NESTA_KEYWORD_ENGINE || "roberta").trim().toLowerCase();
const DEFAULT_COMPETENCE_MODE = parseCompetenceMode(
    process.env.CAVS_COMPETENCE_MODE || config.competenceMode || "nesta"
) || "ojd_daps";
let selectedCompetenceMode = DEFAULT_COMPETENCE_MODE;
const runtimeOpenAIConfig = {
    apiKey: readSecretFile(process.env.OPENAI_API_KEY_FILE) || process.env.OPENAI_COMPETENCE_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_COMPETENCE_BASE_URL || process.env.OPENAI_BASE_URL || "",
    model: process.env.OPENAI_COMPETENCE_MODEL || process.env.OPENAI_MODEL || "",
};

function readBoundedIntegerEnvironment(name, fallback, minimum, maximum) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
}

function readSecretFile(path) {
    if (!path) return '';
    try { return fs.readFileSync(path, 'utf8').trim(); } catch (_) { return ''; }
}
const DEFAULT_ESCO_FILE_PATH = '/usr/src/app/esco-v1.2.1.jsonl';
const escoFilePath =
    process.env.ESCO_JSONL_PATH ||
    config?.escoFilePath ||
    DEFAULT_ESCO_FILE_PATH;
const HTTP_BODY_LIMIT = process.env.CAVS_HTTP_BODY_LIMIT || '8mb';
app.use(cors(), express.json({ limit: HTTP_BODY_LIMIT }));

const extractIdempotencyStore = new ExtractIdempotencyStore({
    maxInFlight: extractIdempotencyMaxInFlight,
    maxResults: extractIdempotencyMaxResults,
    resultTtlMs: extractIdempotencyResultTtlMs,
    isCacheable: (result) => (
        Number.isInteger(result?.status)
        && result.status >= 200
        && result.status < 300
    ),
});

function parseOracleIdLike(value) {
    if (Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = parseInt(value.trim(), 10);
        if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
    return null;
}

function inferLocalOracleId() {
    const explicit =
        parseOracleIdLike(process.env.OCR_ORACLE_ID) ??
        parseOracleIdLike(process.env.ORACLE_ID) ??
        parseOracleIdLike(process.env.ORACLE_IDENTITY_ID);
    if (explicit !== null) return explicit;

    try {
        const host = new URL(veramoAgentEndpoint).hostname || '';
        const m = host.match(/(\d+)$/);
        if (m) {
            const parsed = parseInt(m[1], 10);
            if (Number.isInteger(parsed) && parsed >= 0) return parsed;
        }
    } catch (_err) {
    }
    return 0;
}

const DEFAULT_LOCAL_ORACLE_ID = inferLocalOracleId();

function normalizeStr(s) {
    return typeof s === 'string' ? s.trim().toLowerCase() : "";
}

function normalizeExtractorEngine(engine) {
    const normalized = normalizeStr(engine);
    if (!normalized) return null;

    if (normalized === "roberta" || normalized === "bert") return "RoBERTa";
    if (normalized === "gpt" || normalized === "llm") return "GPT";
    if (normalized === "bert+gpt" || normalized === "roberta+gpt" || normalized === "bert+llm") {
        return "RoBERTa+GPT";
    }
    return null;
}

function setSelectedExtractorEngine(engine) {
    const normalized = normalizeExtractorEngine(engine);
    if (normalized) {
        selectedExtractorEngine = normalized;
        return true;
    }
    if (engine !== undefined && engine !== null) {
        selectedExtractorEngine = String(engine);
    }
    return false;
}

function parseHierarchyMaxHops(value) {
    if (value === undefined || value === null || value === "") return Infinity;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return Infinity;
        return value < 0 ? Infinity : Math.floor(value);
    }
    const normalized = normalizeStr(String(value));
    if (!normalized) return Infinity;
    if (["any", "all", "unbounded", "unlimited", "inf", "infinity"].includes(normalized)) {
        return Infinity;
    }
    const parsed = parseInt(normalized, 10);
    if (!Number.isFinite(parsed)) return Infinity;
    return parsed < 0 ? Infinity : parsed;
}

const ESCO_MAX_HOPS = parseHierarchyMaxHops(process.env.ESCO_MAX_HOPS);

function timeoutMsFromSeconds(value, fallbackMs) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
    return Math.floor(seconds * 1000);
}

function definedOptions(options = {}) {
    return Object.fromEntries(
        Object.entries(options).filter(([_key, value]) => value !== undefined && value !== null && value !== "")
    );
}

function parseCompetenceMode(mode) {
    const m = normalizeStr(mode);
    if (!m) return null;

    if (
        m === "azure-openai" ||
        m === "azure_openai" ||
        m === "azure" ||
        m === "azure_model" ||
        m === normalizeStr(AZURE_OPENAI_COMPETENCE_MODE_LABEL)
    ) {
        return "azure-openai";
    }
    if (
        m === "gpt" ||
        m === "gpt_service" ||
        m === "gpt_comp" ||
        m === "gpt_competence" ||
        m === "gpt_competence_service" ||
        m === "gpt checker" ||
        m === "gpt_checker" ||
        m === "validation_gpt" ||
        m === normalizeStr(GPT_COMPETENCE_MODE_LABEL) ||
        m === "openai"
    ) {
        return "gpt";
    }
    if (
        m === "qwen" ||
        m === "qwen_service" ||
        m === "qwen_comp" ||
        m === "qwen_competence" ||
        m === "qwen_competence_service" ||
        m === normalizeStr(QWEN_COMPETENCE_MODE_LABEL)
    ) {
        return "qwen";
    }
    if (
        m === "deepseek" ||
        m === "deepseek_service" ||
        m === "deepseek_comp" ||
        m === "deepseek_competence" ||
        m === "deepseek_competence_service" ||
        m === normalizeStr(DEEPSEEK_COMPETENCE_MODE_LABEL)
    ) {
        return "deepseek";
    }
    if (m === "llama" || m === normalizeStr(LLAMA_COMPETENCE_MODE_LABEL)) {
        return "llama";
    }
    if (m === "gemma" || m === normalizeStr(GEMMA_COMPETENCE_MODE_LABEL)) {
        return "gemma";
    }
    if (
        m === "ojd" ||
        m === "ojd_daps" ||
        m === "nesta" ||
        m === "nesta-keybert" ||
        m === "nesta-yake" ||
        m === "nesta_skill_extraction" ||
        m === normalizeStr(ROBERTA_TO_NESTA_MODE_LABEL)
    ) {
        return "ojd_daps";
    }
    return null;
}

function resolveCompetenceMode(modeInput) {
    const parsed = parseCompetenceMode(modeInput);
    if (parsed) return parsed;
    if (modeInput === undefined || modeInput === null || (typeof modeInput === 'string' && !modeInput.trim())) {
        return selectedCompetenceMode;
    }
    return null;
}

function formatCompetenceModeForUi(mode) {
    if (mode === "ojd_daps") return ROBERTA_TO_NESTA_MODE_LABEL;
    if (mode === "qwen") return QWEN_COMPETENCE_MODE_LABEL;
    if (mode === "deepseek") return DEEPSEEK_COMPETENCE_MODE_LABEL;
    if (mode === "llama") return LLAMA_COMPETENCE_MODE_LABEL;
    if (mode === "gemma") return GEMMA_COMPETENCE_MODE_LABEL;
    if (mode === "azure-openai") return AZURE_OPENAI_COMPETENCE_MODE_LABEL;
    return GPT_COMPETENCE_MODE_LABEL;
}

function normalizeOptionalString(value) {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed;
}

function maskSecret(value) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) return "";
    if (trimmed.length <= 8) return "*".repeat(trimmed.length);
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function getOpenAIConfigSummary() {
    return {
        openAIApiKeyConfigured: Boolean(runtimeOpenAIConfig.apiKey),
        openAIApiKeyMasked: maskSecret(runtimeOpenAIConfig.apiKey),
        openAIBaseUrl: runtimeOpenAIConfig.baseUrl || "",
        openAIModel: runtimeOpenAIConfig.model || "",
    };
}

async function syncKeyLLMOpenAIConfig() {
    try {
        const response = await axios.post(
            `${keyLLMServiceEndpoint}/config/openai`,
            {
                api_key: runtimeOpenAIConfig.apiKey,
                base_url: runtimeOpenAIConfig.baseUrl,
            },
            {
                timeout: veramoRequestTimeoutMs,
                headers: { 'Content-Type': 'application/json' },
            },
        );
        return {
            ok: true,
            detail: response.data || {},
        };
    } catch (err) {
        return {
            ok: false,
            detail: err.response?.data || err.message,
        };
    }
}

function buildOpenAIOverridePayload() {
    const payload = {};
    if (runtimeOpenAIConfig.apiKey) payload.api_key = runtimeOpenAIConfig.apiKey;
    if (runtimeOpenAIConfig.baseUrl) payload.base_url = runtimeOpenAIConfig.baseUrl;
    if (runtimeOpenAIConfig.model) payload.model = runtimeOpenAIConfig.model;
    return payload;
}

function parseBooleanLoose(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const norm = normalizeStr(value);
        if (norm === "true" || norm === "1" || norm === "yes") return true;
        if (norm === "false" || norm === "0" || norm === "no") return false;
    }
    return false;
}

const ESCO_SKILL_URI_RE = /http:\/\/data\.europa\.eu\/esco\/skill\/[A-Za-z0-9-]+/;

function cleanupSkillLabel(value) {
    if (typeof value !== 'string') return "";
    return value
        .trim()
        .replace(/^[\(\[\{\"'\s,;:|]+/, '')
        .replace(/[\)\]\}\"'\s,;:|]+$/, '')
        .trim();
}

function parseAuthorSkillEntry(entry) {
    if (Array.isArray(entry) && entry.length >= 2) {
        const label = cleanupSkillLabel(String(entry[0] ?? ""));
        const uri = String(entry[1] ?? "").trim();
        if (label && uri) return { label, uri };
        return null;
    }

    if (entry && typeof entry === "object") {
        const label = cleanupSkillLabel(String(entry.label ?? ""));
        const uri = String(entry.uri ?? "").trim();
        if (label && uri) return { label, uri };
        return null;
    }

    if (typeof entry === "string") {
        const raw = entry.trim();
        if (!raw) return null;
        if (raw.startsWith("(") && raw.endsWith(")")) {
            const inner = raw.slice(1, -1).trim();
            const splitIndex = inner.lastIndexOf(",");
            if (splitIndex > 0) {
                const label = cleanupSkillLabel(inner.slice(0, splitIndex));
                const uri = inner.slice(splitIndex + 1).trim();
                if (label && uri) return { label, uri };
            }
        }
        if (raw.includes("|")) {
            const splitIndex = raw.lastIndexOf("|");
            if (splitIndex > 0) {
                const label = cleanupSkillLabel(raw.slice(0, splitIndex));
                const uri = raw.slice(splitIndex + 1).trim();
                if (label && uri) return { label, uri };
            }
        }
        const m = raw.match(ESCO_SKILL_URI_RE);
        if (!m) return null;
        const uri = m[0];
        const idx = raw.indexOf(uri);
        const before = idx >= 0 ? raw.slice(0, idx).trim() : "";
        const after = idx >= 0 ? raw.slice(idx + uri.length).trim() : "";
        const label = cleanupSkillLabel(before || after);
        if (label && uri) return { label, uri };
        return null;
    }

    return null;
}

function normalizeAuthorSkillsForCompetence(authorSkills = []) {
    const out = [];
    const seenByUri = new Set();
    for (const entry of (Array.isArray(authorSkills) ? authorSkills : [])) {
        const parsed = parseAuthorSkillEntry(entry);
        if (!parsed) continue;
        if (seenByUri.has(parsed.uri)) continue;
        seenByUri.add(parsed.uri);
        out.push(`(${parsed.label}, ${parsed.uri})`);
    }
    return out;
}

function buildAuthorSkillTokenSet(authorSkills = []) {
    const out = new Set();
    for (const entry of (Array.isArray(authorSkills) ? authorSkills : [])) {
        const parsed = parseAuthorSkillEntry(entry);
        if (parsed) {
            const labelNorm = normalizeStr(parsed.label);
            const uriNorm = normalizeStr(parsed.uri);
            if (labelNorm) out.add(labelNorm);
            if (uriNorm) out.add(uriNorm);
            continue;
        }
        if (typeof entry === 'string') {
            const raw = normalizeStr(entry);
            if (raw) out.add(raw);
        }
    }
    return out;
}

let escoIndexPromise = null;
let escoIndexError = null;
let escoUnavailableWarned = false;

function extractSkillUris(value) {
    if (typeof value !== 'string' || !value) return [];
    return value.match(/http:\/\/data\.europa\.eu\/esco\/skill\/[A-Za-z0-9-]+/g) || [];
}

function addLabelIndex(labelToUris, label, uri) {
    const key = normalizeStr(label);
    if (!key || !uri) return;
    const curr = labelToUris.get(key);
    if (curr) {
        curr.add(uri);
        return;
    }
    labelToUris.set(key, new Set([uri]));
}

function addUndirectedEdge(graph, a, b) {
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
}

function newEscoGraphObject() {
    return {
        uri: "",
        preferredEn: "",
        altEn: new Set(),
        broaderSkillUris: new Set(),
        narrowerSkillUris: new Set(),
        relatedEssentialSkillUris: new Set(),
        relatedOptionalSkillUris: new Set(),
    };
}

function finalizeEscoGraphObject(obj, graph, labelToUris) {
    if (!obj || !obj.uri.startsWith('http://data.europa.eu/esco/skill/')) return;

    if (!graph.has(obj.uri)) {
        graph.set(obj.uri, new Set());
    }

    if (obj.preferredEn) {
        addLabelIndex(labelToUris, obj.preferredEn, obj.uri);
    }
    for (const alt of obj.altEn) {
        addLabelIndex(labelToUris, alt, obj.uri);
    }

    for (const dst of obj.broaderSkillUris) {
        addUndirectedEdge(graph, obj.uri, dst);
    }
    for (const dst of obj.narrowerSkillUris) {
        addUndirectedEdge(graph, obj.uri, dst);
    }
    for (const dst of obj.relatedEssentialSkillUris) {
        addUndirectedEdge(graph, obj.uri, dst);
    }
    for (const dst of obj.relatedOptionalSkillUris) {
        addUndirectedEdge(graph, obj.uri, dst);
    }
}

async function loadEscoIndex(filePath) {
    const graph = new Map();
    const labelToUris = new Map();

    if (!fs.existsSync(filePath)) {
        throw new Error(`ESCO file not found: ${filePath}`);
    }

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let inGraph = false;
    let current = null;
    let section = null;
    let sectionDepth = 0;

    for await (const lineRaw of rl) {
        // Top-level graph starts once we hit "@graph".
        if (!inGraph) {
            if (lineRaw.includes('"@graph"')) {
                inGraph = true;
                current = newEscoGraphObject();
            }
            continue;
        }

        // Top-level graph object separator: "}, {" with no indentation.
        if (lineRaw.startsWith('}, {')) {
            finalizeEscoGraphObject(current, graph, labelToUris);
            current = newEscoGraphObject();
            section = null;
            sectionDepth = 0;
            continue;
        }

        // End of @graph array.
        if (lineRaw.startsWith('} ]')) {
            finalizeEscoGraphObject(current, graph, labelToUris);
            current = null;
            break;
        }

        if (!current) continue;

        if (lineRaw.startsWith('  "uri" : ')) {
            const m = lineRaw.match(/"uri"\s*:\s*"([^"]+)"/);
            if (m) current.uri = m[1];
        }

        if (lineRaw.startsWith('  "broader" : ')) {
            for (const u of extractSkillUris(lineRaw)) current.broaderSkillUris.add(u);
        }
        if (lineRaw.startsWith('  "narrower" : ')) {
            for (const u of extractSkillUris(lineRaw)) current.narrowerSkillUris.add(u);
        }
        if (lineRaw.startsWith('  "relatedEssentialSkill" : ')) {
            for (const u of extractSkillUris(lineRaw)) current.relatedEssentialSkillUris.add(u);
        }
        if (lineRaw.startsWith('  "relatedOptionalSkill" : ')) {
            for (const u of extractSkillUris(lineRaw)) current.relatedOptionalSkillUris.add(u);
        }

        if (lineRaw.startsWith('  "preferredLabel" : ')) {
            section = "preferred";
            sectionDepth = (lineRaw.match(/\[/g) || []).length - (lineRaw.match(/\]/g) || []).length;
            if (sectionDepth <= 0) section = null;
            continue;
        }
        if (lineRaw.startsWith('  "alternativeLabel" : ')) {
            section = "alternative";
            sectionDepth = (lineRaw.match(/\[/g) || []).length - (lineRaw.match(/\]/g) || []).length;
            if (sectionDepth <= 0) section = null;
            continue;
        }

        if (section) {
            const m = lineRaw.match(/"en"\s*:\s*"([^"]+)"/);
            if (m) {
                if (section === "preferred" && !current.preferredEn) {
                    current.preferredEn = m[1];
                }
                if (section === "alternative") {
                    current.altEn.add(m[1]);
                }
            }
            sectionDepth += (lineRaw.match(/\[/g) || []).length;
            sectionDepth -= (lineRaw.match(/\]/g) || []).length;
            if (sectionDepth <= 0) {
                section = null;
                sectionDepth = 0;
            }
        }
    }

    // Also make sure every URI present in labels is represented as a node.
    for (const uriSet of labelToUris.values()) {
        for (const uri of uriSet) {
            if (!graph.has(uri)) graph.set(uri, new Set());
        }
    }

    const edgeCount = Array.from(graph.values()).reduce((acc, s) => acc + s.size, 0) / 2;
    console.log(`ESCO index loaded from ${filePath} (skills=${graph.size}, edges=${edgeCount}, labels=${labelToUris.size})`);
    return { graph, labelToUris };
}

async function getEscoIndex() {
    if (escoIndexError) {
        throw escoIndexError;
    }
    if (escoIndexPromise) return escoIndexPromise;
    escoIndexPromise = loadEscoIndex(escoFilePath).catch((err) => {
        escoIndexError = err;
        throw err;
    });
    return escoIndexPromise;
}

function resolveSkillTokensToUris(tokens, labelToUris) {
    const out = new Set();
    for (const t of tokens || []) {
        const parsed = parseAuthorSkillEntry(t);
        if (parsed) {
            if (parsed.uri && parsed.uri.startsWith('http://data.europa.eu/esco/skill/')) {
                out.add(parsed.uri);
            }
            const parsedLabelMapped = labelToUris.get(normalizeStr(parsed.label));
            if (parsedLabelMapped) {
                for (const uri of parsedLabelMapped) out.add(uri);
            }
            continue;
        }

        if (typeof t === 'string') {
            const raw = t.trim();
            if (!raw) continue;
            if (raw.startsWith('http://data.europa.eu/esco/skill/')) {
                out.add(raw);
                continue;
            }
            const mapped = labelToUris.get(normalizeStr(raw));
            if (!mapped) continue;
            for (const uri of mapped) out.add(uri);
            continue;
        }

        if (Array.isArray(t) && t.length > 0) {
            const label = normalizeStr(String(t[0] ?? ""));
            if (!label) continue;
            const mapped = labelToUris.get(label);
            if (!mapped) continue;
            for (const uri of mapped) out.add(uri);
            continue;
        }

        if (t && typeof t === "object") {
            const maybeLabel = normalizeStr(String(t.label ?? ""));
            if (!maybeLabel) continue;
            const mapped = labelToUris.get(maybeLabel);
            if (!mapped) continue;
            for (const uri of mapped) out.add(uri);
        }
    }
    return out;
}

function resolveValidAuthorSkillUris(authorSkills, escoIndex) {
    const out = new Set();
    const graph = escoIndex?.graph;
    if (!graph) return out;

    for (const entry of (Array.isArray(authorSkills) ? authorSkills : [])) {
        const parsed = parseAuthorSkillEntry(entry);
        if (parsed) {
            const uri = parsed.uri;
            if (!uri.startsWith('http://data.europa.eu/esco/skill/') || !graph.has(uri)) {
                continue;
            }

            out.add(uri);
            continue;
        }

        if (typeof entry === 'string') {
            const raw = entry.trim();
            if (raw.startsWith('http://data.europa.eu/esco/skill/') && graph.has(raw)) {
                out.add(raw);
            }
        }
    }

    return out;
}

function shortestDistance(graph, startUri, targetUris, maxHops) {
    if (!startUri || !targetUris || targetUris.size === 0) return Infinity;
    if (targetUris.has(startUri)) return 0;

    const finiteMaxHops = Number.isFinite(maxHops) ? maxHops : null;
    if (finiteMaxHops !== null && finiteMaxHops <= 0) return Infinity;

    const q = [[startUri, 0]];
    const seen = new Set([startUri]);

    for (let i = 0; i < q.length; i++) {
        const [curr, d] = q[i];
        if (finiteMaxHops !== null && d >= finiteMaxHops) continue;
        const neigh = graph.get(curr);
        if (!neigh) continue;
        for (const nxt of neigh) {
            if (seen.has(nxt)) continue;
            const nd = d + 1;
            if (finiteMaxHops !== null && nd > finiteMaxHops) continue;
            if (targetUris.has(nxt)) return nd;
            seen.add(nxt);
            q.push([nxt, nd]);
        }
    }
    return Infinity;
}

function coverageContributionFromDistance(distance) {
    if (!Number.isFinite(distance)) return 0;
    // Distance 0 => 1.0, 1 => 0.5, 2 => 0.33, ...
    return 1 / (1 + distance);
}

function computeCompetenceFromCoverage(coverage, extractedCount) {
    const clampedCoverage = Math.max(0, Math.min(1, coverage));
    const supportThreshold = Number(pipelineConfig?.competence?.support_threshold);
    const normalizedSupportThreshold = Number.isFinite(supportThreshold)
        ? Math.max(0, Math.min(1, supportThreshold))
        : 0;
    if (extractedCount <= 0) {
        return {
            competent: false,
            confidence: 1,
            reason: "No skills extracted",
            coverage: 0,
        };
    }

    return {
        competent: clampedCoverage > normalizedSupportThreshold,
        confidence: Math.abs((2 * clampedCoverage) - 1),
        reason: "",
        coverage: clampedCoverage,
    };
}

function buildDistanceAwareCoverageReason(competent, coveredSkills, extractedCount, exactMatches, hierarchyMatchesByDistance, weightedSupport) {
    if (extractedCount <= 0) {
        return "Not competent: no skills extracted";
    }

    const clampedWeightedSupport = Math.max(0, Math.min(1, Number(weightedSupport) || 0));
    const prefix = competent ? "Competent" : "Not competent";
    if (coveredSkills <= 0) {
        return `${prefix}: author skills cover 0/${extractedCount} extracted skills (weighted=0.000)`;
    }

    const distanceChunks = Array.from(hierarchyMatchesByDistance.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([distance, count]) => `n.hierarchy-distance ${distance} = ${count}`);

    if (distanceChunks.length > 0) {
        return (
            `${prefix}: author skills cover ${coveredSkills}/${extractedCount} extracted skills ` +
            `(exact=${exactMatches}, ${distanceChunks.join(', ')}, weighted=${clampedWeightedSupport.toFixed(3)})`
        );
    }

    return (
        `${prefix}: author skills cover ${coveredSkills}/${extractedCount} extracted skills ` +
        `(exact=${exactMatches}, weighted=${clampedWeightedSupport.toFixed(3)})`
    );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let selectedDidAttemptInFlight = null;
let selectedDidWarmupInFlight = null;

async function ensureSelectedDidOnce() {
    if (selectedDID) return selectedDID;
    if (!selectedDIDPrivKey || !selectedDIDETHAWalletAddr) {
        throw new Error(
            'CAVS DID identity is not configured; set CAVS_DID_PRIVATE_KEY_FILE '
            + '(recommended) or CAVS_DID_PRIVATE_KEY',
        );
    }
    if (selectedDidAttemptInFlight) return await selectedDidAttemptInFlight;

    const attempt = (async () => {
        const response = await axios.post(
            `${veramoAgentEndpoint}/api/v0/setup/`,
            {
                privatekey: selectedDIDWallet.privateKey.slice(2),
                walletaddr: selectedDIDETHAWalletAddr,
            },
            { timeout: didSetupRequestTimeoutMs },
        );
        const did = normalizeOptionalString(response.data?.did);
        if (!did) {
            throw new Error('Veramo DID setup returned no DID');
        }
        selectedDID = did;
        console.log('Our DID:', selectedDID);
        return selectedDID;
    })();
    selectedDidAttemptInFlight = attempt;
    try {
        return await attempt;
    } finally {
        if (selectedDidAttemptInFlight === attempt) {
            selectedDidAttemptInFlight = null;
        }
    }
}

async function fetchDIDWithRetry() {
    if (selectedDID) return selectedDID;
    if (selectedDidWarmupInFlight) return await selectedDidWarmupInFlight;

    const warmup = (async () => {
        while (!selectedDID) {
            try {
                await ensureSelectedDidOnce();
            } catch (error) {
                console.error('Error fetching credentials:', error.message);
                await sleep(startupRetryDelayMs);
            }
        }
        return selectedDID;
    })();
    selectedDidWarmupInFlight = warmup;
    try {
        return await warmup;
    } finally {
        if (selectedDidWarmupInFlight === warmup) {
            selectedDidWarmupInFlight = null;
        }
    }
}

// --- OCR/Veramo identity setup (BLS keys etc) ---
const ocrSignerByOracleId = new Map(); // oracleId -> {did,kid_bls,kid_eth,bls_pub_key}
const ocrSignerSetupInFlight = new Map(); // oracleId -> Promise<identity>
let ocrSignerWarmupStarted = false;
const remoteSignerIdentityCache = new Map();

function setBoundedCacheEntry(cache, key, value, maxEntries) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxEntries) {
        cache.delete(cache.keys().next().value);
    }
}

async function ensureOcrSignerIdentity(oracleId) {
    if (!Number.isInteger(oracleId) || oracleId < 0 || oracleId > 255) {
        throw new Error(`Invalid oracleId ${oracleId}`);
    }
    const existing = ocrSignerByOracleId.get(oracleId);
    if (existing?.did && existing?.kid_bls && existing?.bls_pub_key) {
        return existing;
    }
    const inflight = ocrSignerSetupInFlight.get(oracleId);
    if (inflight) return await inflight;

    const p = (async () => {
        const name = `oracle${oracleId}`;
        const resp = await axios.post(
            `${veramoAgentEndpoint}/setup`,
            { name },
            { timeout: ocrVcLocalRequestTimeoutMs },
        );
        const did = resp.data?.did;
        const kid_bls = resp.data?.kid_bls;
        const kid_eth = resp.data?.kid_eth;
        const bls_pub_key = resp.data?.bls_pub_key;
        if (!did || !kid_bls || !bls_pub_key) {
            throw new Error(`veramo /setup missing fields for ${name}`);
        }
        const identity = { did, kid_bls, kid_eth: kid_eth || '', bls_pub_key };
        ocrSignerByOracleId.set(oracleId, identity);
        if (oracleId === DEFAULT_LOCAL_ORACLE_ID) {
            selectedDID = did;
        }
        console.log(`OCR signer identity ready oracleId=${oracleId} did=${did}`);
        return identity;
    })();

    ocrSignerSetupInFlight.set(oracleId, p);
    try {
        return await p;
    } finally {
        ocrSignerSetupInFlight.delete(oracleId);
    }
}

async function warmupOcrSignerIdentitiesForever() {
    if (ocrSignerWarmupStarted) return;
    ocrSignerWarmupStarted = true;

    while (true) {
        try {
            await ensureOcrSignerIdentity(DEFAULT_LOCAL_ORACLE_ID);
            console.log(`OCR signer warmup complete (oracleId=${DEFAULT_LOCAL_ORACLE_ID})`);
            return;
        } catch (err) {
            console.error('OCR signer warmup failed, retrying:', err?.message || err);
            await sleep(startupRetryDelayMs);
        }
    }
}

const ocrSimulationMode = /^(1|true|yes|on)$/i.test(
    String(process.env.OCR_SIMULATION_MODE || '').trim(),
);

const configureApp = async () => {
    try {
        // Do not block server startup on Veramo; warm up in background.
        void warmupOcrSignerIdentitiesForever();
        if (ocrSimulationMode) {
            // Deterministic OCR observations never call the competence path.
            // The OCR signer warmup above also establishes selectedDID, so the
            // legacy private-key DID warmup would be duplicate startup work.
            // Keep its on-demand path available for endpoints that explicitly
            // request that identity.
            console.log('OCR simulation mode: skipping duplicate DID and unused ESCO warmups');
        } else {
            void fetchDIDWithRetry();
            // Warm up ESCO in the background; competence can still fallback.
            void getEscoIndex().catch((err) => {
                if (!escoUnavailableWarned) {
                    console.warn(`ESCO index unavailable (${escoFilePath}):`, err?.message || err);
                    escoUnavailableWarned = true;
                }
            });
        }
    } catch (error) {
        console.error('Error during startup setup:', error?.message || error);
    }
};

// Normalize signer entries coming from OCR oracles (camelCase / PascalCase tolerance)
const normalizeSigner = (s) => {
    if (!s || typeof s !== 'object') return {};
    const did = s.did || s.DID || s.did_id;
    const kid_bls = s.kid_bls || s.kidBLS || s.KidBLS || s.kid_bls_key;
    const kid_eth = s.kid_eth || s.kidETH || s.KidETH || s.kid_eth_key;
    const bls_pub = s.bls_pub || s.blsPub || s.BLSPub || s.bls_pub_key || s.blsPubKey;
    return { did, kid_bls, kid_eth, bls_pub };
};

function signerPublicIdentity(identity) {
    return {
        did: identity.did,
        kid_bls: identity.kid_bls,
        kid_eth: identity.kid_eth || '',
        bls_pub_key: identity.bls_pub_key,
    };
}

function parseVcThreshold(body, fallbackThreshold) {
    const raw =
        body.threshold ??
        body.attestedThreshold ??
        body.attested_threshold ??
        body.signerThreshold ??
        body.signer_threshold;
    const parsed = parseInt(String(raw ?? ''), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
    }
    return fallbackThreshold;
}

function parseSignerEndpoints(raw) {
    if (!Array.isArray(raw)) return [];
    const endpoints = Array.from(
        new Set(
            raw
                .map((entry) => normalizeOptionalString(
                    typeof entry === 'string'
                        ? entry
                        : entry?.endpoint || entry?.url || entry?.baseUrl,
                ))
                .filter(Boolean)
                .map((endpoint) => endpoint.replace(/\/+$/, '')),
        ),
    );
    if (endpoints.length > ocrMaxRemoteEndpoints) {
        const error = new Error(
            `too many OCR endpoints (${endpoints.length} > ${ocrMaxRemoteEndpoints})`,
        );
        error.statusCode = 400;
        throw error;
    }
    return endpoints;
}

function parseCallbackEndpoints(raw) {
    return parseSignerEndpoints(raw);
}

function axiosErrorDetail(error) {
    const data = error?.response?.data;
    if (typeof data === 'string') return data;
    if (data?.error || data?.detail) return data.error || data.detail;
    return error?.message || String(error);
}

async function fetchRemoteSignerIdentity(endpoint) {
    const now = Date.now();
    const cached = remoteSignerIdentityCache.get(endpoint);
    if (remoteSignerIdentityCacheTtlMs > 0 && cached && cached.expiresAt > now) {
        return cached.value;
    }

    const pending = (async () => {
        const response = await axios.post(
            `${endpoint}/ocr/vc/signer_identity`,
            {},
            { timeout: ocrVcSignerRequestTimeoutMs },
        );
        const identity = response.data || {};
        if (!identity.did || !identity.kid_bls || !identity.bls_pub_key) {
            throw new Error(`signer endpoint ${endpoint} identity response is missing DID/BLS fields`);
        }
        return {
            endpoint,
            did: identity.did,
            kid_bls: identity.kid_bls,
            kid_eth: identity.kid_eth || '',
            bls_pub_key: identity.bls_pub_key,
        };
    })();
    if (remoteSignerIdentityCacheTtlMs > 0) {
        setBoundedCacheEntry(
            remoteSignerIdentityCache,
            endpoint,
            { expiresAt: now + remoteSignerIdentityCacheTtlMs, value: pending },
            remoteSignerIdentityCacheMaxEntries,
        );
    }
    try {
        return await pending;
    } catch (error) {
        if (remoteSignerIdentityCache.get(endpoint)?.value === pending) {
            remoteSignerIdentityCache.delete(endpoint);
        }
        throw error;
    }
}

async function resolveRemoteSignerPool(endpoints, threshold) {
    const settled = await Promise.allSettled(endpoints.map((endpoint) => fetchRemoteSignerIdentity(endpoint)));
    const available = [];
    const unavailable = [];
    settled.forEach((result, index) => {
        const endpoint = endpoints[index];
        if (result.status === 'fulfilled') {
            available.push(result.value);
        } else {
            unavailable.push({
                endpoint,
                error: axiosErrorDetail(result.reason),
            });
        }
    });
    if (available.length < threshold) {
        const error = new Error(
            `not enough live signer endpoints for VC threshold: available=${available.length} threshold=${threshold}`,
        );
        error.statusCode = 503;
        error.available = available;
        error.unavailable = unavailable;
        throw error;
    }
    return { available, unavailable };
}

async function requestRemoteVcSignature(signer, payload, holderDid) {
    const response = await axios.post(
        `${signer.endpoint}/ocr/vc/sign`,
        {
            holderDid,
            payload,
        },
        { timeout: ocrVcSignerRequestTimeoutMs },
    );
    const signature = response.data?.signature;
    const proofOfOwnership = response.data?.proofOfOwnership;
    if (!signature || !proofOfOwnership) {
        throw new Error(`signer endpoint ${signer.endpoint} did not return signature and proof`);
    }
    return {
        endpoint: signer.endpoint,
        signature,
        proofOfOwnership,
    };
}

async function buildAndFinalizeOcrVc({
    holder,
    statementHash,
    competent,
    confidence,
    reason,
    selectedSigners,
}) {
    const keys = selectedSigners.map((s) => s.bls_pub_key);
    const aggResp = await axios.post(
        `${veramoAgentEndpoint}/bls/aggregate`,
        { keys },
        { timeout: ocrVcLocalRequestTimeoutMs },
    );
    const aggregatedKey = aggResp.data?.aggregatedKey;
    if (!aggregatedKey) throw new Error('missing aggregatedKey from veramo');

    const issuerEntries = selectedSigners.map((s) => ({ did: s.did, kid_bls: s.kid_bls }));
    const issuerDIDs = selectedSigners.map((s) => s.did);
    const payload = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'aggregated-bls-multi-signature'],
        multi_issuers: issuerDIDs,
        aggregated_bls_public_key: aggregatedKey,
        credentialSubject: {
            id: holder,
            statementHash,
            competent,
            confidence,
            reason,
        },
        issuanceDate: new Date().toISOString(),
    };

    const signResults = await Promise.allSettled(
        selectedSigners.map((signer) => requestRemoteVcSignature(signer, payload, holder)),
    );
    const failedSigners = [];
    const signatures = [];
    const proofsOfOwnership = [];
    signResults.forEach((result, index) => {
        const signer = selectedSigners[index];
        if (result.status === 'fulfilled') {
            signatures.push(result.value.signature);
            proofsOfOwnership.push(result.value.proofOfOwnership);
        } else {
            failedSigners.push({
                endpoint: signer.endpoint,
                error: axiosErrorDetail(result.reason),
            });
        }
    });
    if (failedSigners.length > 0) {
        const error = new Error(`VC signing failed for ${failedSigners.length} selected signer(s)`);
        error.statusCode = 503;
        error.failedSigners = failedSigners;
        throw error;
    }

    const finalResp = await axios.post(
        `${veramoAgentEndpoint}/mi-vc/finalize`,
        { payload, signatures, aggregatedKey, proofsOfOwnership, store: false },
        { timeout: ocrVcLocalRequestTimeoutMs },
    );
    const vc = finalResp.data?.vc;
    if (!vc) throw new Error('missing vc from veramo');
    return { vc, aggregatedKey, signatures, proofsOfOwnership };
}

async function buildAndFinalizeLocalOcrVc({
    holder,
    statementHash,
    competent,
    confidence,
    reason,
    resolvedSigners,
}) {
    const keys = resolvedSigners.map((s) => s.bls_pub_key);
    const aggResp = await axios.post(
        `${veramoAgentEndpoint}/bls/aggregate`,
        { keys },
        { timeout: ocrVcLocalRequestTimeoutMs },
    );
    const aggregatedKey = aggResp.data?.aggregatedKey;
    if (!aggregatedKey) throw new Error('missing aggregatedKey from veramo');

    const issuerEntries = resolvedSigners.map((s) => ({ did: s.did, kid_bls: s.kid_bls }));
    const issuerDIDs = resolvedSigners.map((s) => s.did);
    const payload = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'aggregated-bls-multi-signature'],
        multi_issuers: issuerDIDs,
        aggregated_bls_public_key: aggregatedKey,
        credentialSubject: {
            id: holder,
            statementHash,
            competent,
            confidence,
            reason,
        },
        issuanceDate: new Date().toISOString(),
    };

    const [signResp, proofResp] = await Promise.all([
        axios.post(
            `${veramoAgentEndpoint}/mi-vc/sign`,
            { issuers: issuerEntries, payload },
            { timeout: ocrVcLocalRequestTimeoutMs },
        ),
        axios.post(
            `${veramoAgentEndpoint}/mi-vc/proofs`,
            { issuers: issuerEntries, holder_did: holder, payload },
            { timeout: ocrVcLocalRequestTimeoutMs },
        ),
    ]);
    const signatures = signResp.data?.signatures;
    if (!signatures) throw new Error('missing signatures from veramo');

    const proofsOfOwnership = proofResp.data?.proofsOfOwnership;
    if (!proofsOfOwnership) throw new Error('missing proofsOfOwnership from veramo');

    const finalResp = await axios.post(
        `${veramoAgentEndpoint}/mi-vc/finalize`,
        { payload, signatures, aggregatedKey, proofsOfOwnership, store: false },
        { timeout: ocrVcLocalRequestTimeoutMs },
    );
    const vc = finalResp.data?.vc;
    if (!vc) throw new Error('missing vc from veramo');
    return { vc, aggregatedKey, signatures, proofsOfOwnership };
}

async function postFinalVcCallback(callbackEndpoint, requesterEndpoint, result, vc) {
    const response = await axios.post(
        `${callbackEndpoint}/ocr/vc/final_callback`,
        {
            requesterEndpoint,
            result,
            vc,
        },
        { timeout: ocrVcCallbackTimeoutMs },
    );
    return response.data || {};
}

async function fanoutFinalVcCallbacks({ callbackEndpoints, requesterEndpoint, result, vc }) {
    if (!Array.isArray(callbackEndpoints) || callbackEndpoints.length === 0 || !requesterEndpoint) {
        return { callbackSuccesses: 0, callbackFailures: 0, callbackFailedEndpoints: [] };
    }
    const settled = await Promise.allSettled(
        callbackEndpoints.map((endpoint) => postFinalVcCallback(endpoint, requesterEndpoint, result, vc)),
    );
    const callbackFailedEndpoints = [];
    let callbackSuccesses = 0;
    settled.forEach((entry, index) => {
        if (entry.status === 'fulfilled') {
            callbackSuccesses += 1;
        } else {
            callbackFailedEndpoints.push({
                endpoint: callbackEndpoints[index],
                error: axiosErrorDetail(entry.reason),
            });
        }
    });
    return {
        callbackSuccesses,
        callbackFailures: callbackFailedEndpoints.length,
        callbackFailedEndpoints,
    };
}

async function resolveDidIdentityViaVeramo(did, verificationMethodId) {
    const normalizedDid = String(did || '').trim();
    if (!normalizedDid) {
        throw new Error('Missing did');
    }
    const resp = await axios.post(
        `${veramoAgentEndpoint}/ocr/identity/resolve`,
        {
            did: normalizedDid,
            verificationMethodId: verificationMethodId ? String(verificationMethodId).trim() : undefined,
        },
        { timeout: ocrVcLocalRequestTimeoutMs },
    );
    const eth_address = String(resp.data?.eth_address || resp.data?.address || '').trim();
    if (!eth_address) {
        throw new Error(`veramo /ocr/identity/resolve missing eth_address for ${normalizedDid}`);
    }
    return {
        did: normalizedDid,
        eth_address,
        verificationMethodId: String(resp.data?.verificationMethodId || '').trim() || undefined,
    };
}

async function ensureLocalSignerIdentity(reqBody = {}) {
    const oracleId =
        parseOracleIdLike(reqBody.oracleId) ??
        parseOracleIdLike(reqBody.oracle_id) ??
        parseOracleIdLike(reqBody.id) ??
        DEFAULT_LOCAL_ORACLE_ID;
    return await ensureOcrSignerIdentity(oracleId);
}

function readDigestHexFromBody(body = {}) {
    const digestHex = body.digestHex ?? body.messageHex ?? body.hashHex ?? body.message_hash ?? body.message;
    const normalized = String(digestHex || '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
        throw new Error('digestHex must be 32 bytes hex');
    }
    return `0x${normalized}`;
}

app.post('/setup', bodyParser.json(), async (req, res) => {
    try {
        const identity = await ensureLocalSignerIdentity(req.body || {});
        const resolved = await resolveDidIdentityViaVeramo(identity.did);
        res.json({
            ok: true,
            oracleId:
                parseOracleIdLike(req.body?.oracleId) ??
                parseOracleIdLike(req.body?.oracle_id) ??
                DEFAULT_LOCAL_ORACLE_ID,
            did: identity.did,
            kid_eth: identity.kid_eth || '',
            kid_bls: identity.kid_bls,
            bls_pub_key: identity.bls_pub_key,
            eth_address: resolved.eth_address,
        });
    } catch (error) {
        console.error('Error in /setup:', error?.response?.data || error?.message || error);
        res.status(500).json({ ok: false, error: String(error?.response?.data?.error || error?.message || error) });
    }
});

app.post('/identity/resolve', bodyParser.json(), async (req, res) => {
    try {
        const did =
            typeof req.body?.did === 'string' && req.body.did.trim()
                ? req.body.did.trim()
                : (await ensureLocalSignerIdentity(req.body || {})).did;
        const verificationMethodId =
            typeof req.body?.verificationMethodId === 'string' && req.body.verificationMethodId.trim()
                ? req.body.verificationMethodId.trim()
                : undefined;
        const resolved = await resolveDidIdentityViaVeramo(did, verificationMethodId);
        res.json({
            ok: true,
            did: resolved.did,
            eth_address: resolved.eth_address,
            verificationMethodId: resolved.verificationMethodId,
        });
    } catch (error) {
        console.error('Error in /identity/resolve:', error?.response?.data || error?.message || error);
        res.status(502).json({ ok: false, error: String(error?.response?.data?.error || error?.message || error) });
    }
});

app.post('/message/sign', bodyParser.json(), async (req, res) => {
    try {
        const identity = await ensureLocalSignerIdentity(req.body || {});
        if (!identity?.kid_eth) {
            return res.status(500).json({ ok: false, error: 'Local signer identity is missing kid_eth' });
        }
        const digestHex = readDigestHexFromBody(req.body || {});
        const signResp = await axios.post(
            `${veramoAgentEndpoint}/ocr/eth/sign`,
            { kid_eth: identity.kid_eth, digestHex },
            { timeout: ocrVcLocalRequestTimeoutMs },
        );
        const signatureHex = signResp.data?.signatureHex;
        if (!signatureHex) {
            return res.status(502).json({ ok: false, error: 'Missing signatureHex from veramo' });
        }
        const resolved = await resolveDidIdentityViaVeramo(identity.did);
        res.json({
            ok: true,
            did: identity.did,
            eth_address: resolved.eth_address,
            signatureHex,
        });
    } catch (error) {
        console.error('Error in /message/sign:', error?.response?.data || error?.message || error);
        res.status(502).json({ ok: false, error: String(error?.response?.data?.error || error?.message || error) });
    }
});

app.post('/message/verify', bodyParser.json(), async (req, res) => {
    try {
        const digestHex = readDigestHexFromBody(req.body || {});
        const signatureHex = String(req.body?.signatureHex || req.body?.signature || '').trim();
        if (!signatureHex) {
            return res.status(400).json({ ok: false, error: 'Missing signatureHex' });
        }

        const did =
            typeof req.body?.did === 'string' && req.body.did.trim()
                ? req.body.did.trim()
                : (await ensureLocalSignerIdentity(req.body || {})).did;
        const verificationMethodId =
            typeof req.body?.verificationMethodId === 'string' && req.body.verificationMethodId.trim()
                ? req.body.verificationMethodId.trim()
                : undefined;

        const verifyResp = await axios.post(
            `${veramoAgentEndpoint}/ocr/eth/verify`,
            {
                digestHex,
                signatureHex,
                did,
                verificationMethodId,
            },
            { timeout: ocrVcLocalRequestTimeoutMs },
        );
        res.json({
            ok: !!verifyResp.data?.ok,
            verified: !!verifyResp.data?.verified,
            did,
            recoveredAddress: verifyResp.data?.recoveredAddress,
            expectedAddress: verifyResp.data?.expectedAddress,
            verificationMethodId: verifyResp.data?.verificationMethodId,
        });
    } catch (error) {
        console.error('Error in /message/verify:', error?.response?.data || error?.message || error);
        res.status(502).json({ ok: false, error: String(error?.response?.data?.error || error?.message || error) });
    }
});

registerOcrOracleRegistryRoutes(app, {
    ensureOcrSignerIdentity,
    normalizeOptionalString,
    parseOracleIdLike,
    resolveDidIdentityViaVeramo,
    veramoAgentEndpoint,
});
registerAuthorOracleRequestRoutes(app, {
    veramoAgentEndpoint,
});

// OCR setup endpoint:
// - lets an orchestrator pre-register signers (optional)
// - otherwise triggers background warmup without returning key material
app.post('/ocr/veramo/setup', bodyParser.json(), async (req, res) => {
    const name = req.body?.name;
    const oracleIdRaw = req.body?.oracleId ?? req.body?.oracle_id;
    let oracleId = Number.isInteger(oracleIdRaw) ? oracleIdRaw : parseInt(String(oracleIdRaw ?? ''), 10);
    if (!Number.isInteger(oracleId) && typeof name === 'string' && /^oracle\\d+$/.test(name)) {
        oracleId = parseInt(name.replace(/^oracle/, ''), 10);
    }
    if (!Number.isInteger(oracleId) || oracleId < 0 || oracleId > 255) {
        return res.status(400).json({ error: 'oracleId must be an integer from 0 to 255 (or name like oracle0)' });
    }

    const provided = {
        did: req.body?.did,
        kid_bls: req.body?.kid_bls,
        kid_eth: req.body?.kid_eth,
        bls_pub_key: req.body?.bls_pub_key,
    };
    if (provided.did && provided.kid_bls && provided.bls_pub_key) {
        ocrSignerByOracleId.set(oracleId, {
            did: provided.did,
            kid_bls: provided.kid_bls,
            kid_eth: provided.kid_eth || '',
            bls_pub_key: provided.bls_pub_key,
        });
        return res.json({ ok: true, source: 'provided', ready: true });
    }

    // Trigger background setup; do not leak key material.
    void warmupOcrSignerIdentitiesForever();
    void ensureOcrSignerIdentity(oracleId).catch((err) => console.error(`ensureOcrSignerIdentity oracleId=${oracleId} failed`, err?.message || err));
    res.json({ ok: true, source: 'warmup', ready: !!ocrSignerByOracleId.get(oracleId) });
});

app.post('/ocr/vc/signer_identity', bodyParser.json(), async (req, res) => {
    try {
        const identity = await ensureLocalSignerIdentity();
        res.json({ ok: true, ...signerPublicIdentity(identity) });
    } catch (error) {
        console.error('Error in /ocr/vc/signer_identity:', error?.response?.data || error?.message || error);
        res.status(502).json({ ok: false, error: String(error?.response?.data?.error || error?.message || error) });
    }
});

app.post('/ocr/vc/sign', bodyParser.json({ limit: HTTP_BODY_LIMIT }), async (req, res) => {
    try {
        const holderDid = normalizeOptionalString(req.body?.holderDid || req.body?.holder_did);
        const payload = req.body?.payload;
        if (!holderDid) return res.status(400).json({ ok: false, error: 'missing holderDid' });
        if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false, error: 'missing payload' });

        const identity = await ensureLocalSignerIdentity();
        const issuer = { did: identity.did, kid_bls: identity.kid_bls };
        const [signResp, proofResp] = await Promise.all([
            axios.post(
                `${veramoAgentEndpoint}/mi-vc/sign`,
                { issuers: [issuer], payload },
                { timeout: ocrVcLocalRequestTimeoutMs },
            ),
            axios.post(
                `${veramoAgentEndpoint}/mi-vc/proofs`,
                { issuers: [issuer], holder_did: holderDid, payload },
                { timeout: ocrVcLocalRequestTimeoutMs },
            ),
        ]);
        const signature = Array.isArray(signResp.data?.signatures)
            ? signResp.data.signatures[0]
            : null;
        const proofOfOwnership = Array.isArray(proofResp.data?.proofsOfOwnership)
            ? proofResp.data.proofsOfOwnership[0]
            : null;
        if (!signature) return res.status(502).json({ ok: false, error: 'missing signature from veramo' });
        if (!proofOfOwnership) return res.status(502).json({ ok: false, error: 'missing proofOfOwnership from veramo' });
        res.json({
            ok: true,
            issuer,
            bls_pub_key: identity.bls_pub_key,
            signature,
            proofOfOwnership,
        });
    } catch (error) {
        console.error('Error in /ocr/vc/sign:', error?.response?.data || error?.message || error);
        res.status(502).json({ ok: false, error: String(error?.response?.data?.error || error?.message || error) });
    }
});

app.post('/ocr/vc/final_callback', bodyParser.json({ limit: HTTP_BODY_LIMIT }), async (req, res) => {
    try {
        const requesterEndpoint = normalizeOptionalString(req.body?.requesterEndpoint);
        const result = req.body?.result && typeof req.body.result === 'object' ? req.body.result : {};
        const vc = req.body?.vc;
        if (!requesterEndpoint) return res.status(400).json({ ok: false, error: 'missing requesterEndpoint' });
        if (!vc) return res.status(400).json({ ok: false, error: 'missing vc' });

        await axios.post(
            requesterEndpoint,
            { ...result, vc },
            { timeout: ocrRequesterCallbackTimeoutMs },
        );
        res.json({ ok: true });
    } catch (error) {
        console.error('Error in /ocr/vc/final_callback:', error?.response?.data || error?.message || error);
        res.status(error?.response?.status || 502).json({
            ok: false,
            error: 'final VC callback failed',
            detail: error?.response?.data || error?.message || error,
        });
    }
});

// Issue a VC for an OCR outcome using Veramo via CAVS service.
app.post('/ocr/vc', bodyParser.json(), async (req, res) => {
    try {
        const vcStartedAtMs = Date.now();
        const body = req.body || {};
        const statementHash = typeof body.statementHash === 'string' ? body.statementHash.trim() : '';
        const holderDid = body.holderDid;
        const competent = parseBooleanLoose(body.competent);
        let confidence = Number(body.confidence);
        if (!Number.isFinite(confidence)) confidence = 0;
        confidence = Math.max(0, Math.min(1, confidence));
        const reason = typeof body.reason === 'string' && body.reason.trim()
            ? body.reason.trim()
            : 'no reason provided';

        if (!holderDid || typeof holderDid !== 'string' || !holderDid.trim()) {
            return res.status(400).json({ error: 'missing holderDid' });
        }
        if (!statementHash) return res.status(400).json({ error: 'missing statementHash' });

        const holder = holderDid.trim();
        const requesterEndpoint = normalizeOptionalString(body.requesterEndpoint);
        const callbackEndpoints = parseCallbackEndpoints(body.callbackEndpoints ?? body.callback_endpoints);
        const callbackResult = body.result && typeof body.result === 'object'
            ? body.result
            : {
                requestId: body.requestId,
                statementHash,
                holderDid: holder,
                competent,
                confidence,
                reason,
            };
        const signerEndpoints = parseSignerEndpoints(body.signerEndpoints ?? body.signer_endpoints);
        if (signerEndpoints.length > 0) {
            const threshold = parseVcThreshold(body, signerEndpoints.length);
            const useRemoteSigners = body.remoteSigners === undefined
                ? ocrVcRemoteSignersDefault
                : parseBooleanLoose(body.remoteSigners);

            if (useRemoteSigners) {
                const { available, unavailable } = await resolveRemoteSignerPool(signerEndpoints, threshold);
                let candidateSigners = available;
                const signingFailures = [];

                while (candidateSigners.length >= threshold) {
                    const selectedSigners = candidateSigners.slice(0, threshold);
                    try {
                        const finalized = await buildAndFinalizeOcrVc({
                            holder,
                            statementHash,
                            competent,
                            confidence,
                            reason,
                            selectedSigners,
                        });
                        const selectedEndpoints = selectedSigners.map((s) => s.endpoint);
                        const selectedSet = new Set(selectedEndpoints);
                        const droppedSignerEndpoints = signerEndpoints.filter((endpoint) => !selectedSet.has(endpoint));
                        console.log(
                            `OCR_VC_MINT requestId=${body.requestId || ''} selectedEndpoints=${selectedEndpoints.join(',')} ` +
                            `threshold=${threshold} droppedEndpoints=${droppedSignerEndpoints.join(',') || '-'} ` +
                            `unavailableEndpoints=${unavailable.map((s) => s.endpoint).join(',') || '-'}`
                        );
                        const callbackFanout = await fanoutFinalVcCallbacks({
                            callbackEndpoints,
                            requesterEndpoint,
                            result: callbackResult,
                            vc: finalized.vc,
                        });
                        return res.json({
                            ok: true,
                            vc: finalized.vc,
                            vcMinted: true,
                            vcMintStatus: 'minted',
                            vcMintDurationMs: Date.now() - vcStartedAtMs,
                            signerEndpoints: selectedEndpoints,
                            droppedSignerEndpoints,
                            unavailableSignerEndpoints: unavailable.map((s) => s.endpoint),
                            threshold,
                            ...callbackFanout,
                        });
                    } catch (error) {
                        const failed = Array.isArray(error.failedSigners) ? error.failedSigners : [];
                        if (failed.length === 0) throw error;
                        signingFailures.push(...failed);
                        const failedEndpoints = new Set(failed.map((s) => s.endpoint));
                        for (const endpoint of failedEndpoints) {
                            remoteSignerIdentityCache.delete(endpoint);
                        }
                        candidateSigners = candidateSigners.filter((s) => !failedEndpoints.has(s.endpoint));
                    }
                }

                const error = new Error(
                    `not enough signer endpoints after VC signing failures: available=${candidateSigners.length} threshold=${threshold}`,
                );
                error.statusCode = 503;
                error.failedSigners = signingFailures;
                throw error;
            }

            return res.status(400).json({ error: 'remoteSigners=false requires explicit signers[] material' });
        } else if (Array.isArray(body.signers) && body.signers.length > 0) {
            // Backwards-compatible: accept explicit signer material (not recommended for OCR).
            if (body.signers.length > ocrMaxVcSigners) {
                return res.status(400).json({
                    error: `too many explicit signers (${body.signers.length} > ${ocrMaxVcSigners})`,
                });
            }
            const normalized = body.signers
                .map(normalizeSigner)
                .filter((s) => s.did && s.kid_bls && s.bls_pub);
            if (normalized.length === 0) return res.status(400).json({ error: 'no valid signers' });
            const resolvedSigners = normalized.map((s) => ({
                did: s.did,
                kid_bls: s.kid_bls,
                kid_eth: s.kid_eth || '',
                bls_pub_key: s.bls_pub,
            }));
            const finalized = await buildAndFinalizeLocalOcrVc({
                holder,
                statementHash,
                competent,
                confidence,
                reason,
                resolvedSigners,
            });
            const callbackFanout = await fanoutFinalVcCallbacks({
                callbackEndpoints,
                requesterEndpoint,
                result: callbackResult,
                vc: finalized.vc,
            });
            return res.json({
                ok: true,
                vc: finalized.vc,
                vcMinted: true,
                vcMintStatus: 'minted',
                vcMintDurationMs: Date.now() - vcStartedAtMs,
                signerEndpoints: [],
                droppedSignerEndpoints: [],
                unavailableSignerEndpoints: [],
                threshold: resolvedSigners.length,
                ...callbackFanout,
            });
        } else {
            return res.status(400).json({ error: 'missing signers (use signerEndpoints[] or explicit signers[])' });
        }
    } catch (error) {
        console.error('Error in /ocr/vc', error?.response?.data || error?.message);
        res.status(error.statusCode || 502).json({
            error: 'vc issuance failed',
            detail: error?.response?.data || error?.message,
            availableSignerEndpoints: Array.isArray(error.available) ? error.available.map((s) => s.endpoint) : undefined,
            unavailableSignerEndpoints: Array.isArray(error.unavailable) ? error.unavailable.map((s) => s.endpoint) : undefined,
            failedSignerEndpoints: Array.isArray(error.failedSigners) ? error.failedSigners.map((s) => s.endpoint) : undefined,
        });
    }
});

// Additional route and function definitions...

app.post('/set_api', async (req, res) => {
    const extractorEngine = req.body.extractorEngine;
    const enricherEngine = req.body.enricherEngine;
    const skillExtractorEngine = req.body.skillExtractorEngine;
    const competenceModeInput = req.body.competenceMode;
    const selectiveDisclosureModeInput = req.body.selectiveDisclosureMode;
    const openAIApiKeyInput = req.body.openAIApiKey;
    const openAIBaseUrlInput = req.body.openAIBaseUrl;
    const openAIModelInput = req.body.openAIModel;

    if (extractorEngine) {
        setSelectedExtractorEngine(extractorEngine);
    }
    if (enricherEngine) {
        selectedEnricherEngine = enricherEngine;
    }
    if (skillExtractorEngine) {
        selectedSkillExtractorEngine = skillExtractorEngine;
    }

    if (competenceModeInput !== undefined) {
        const parsedCompetenceMode = parseCompetenceMode(competenceModeInput);
        if (!parsedCompetenceMode) {
            return res.status(400).json({ error: `Unsupported competenceMode '${String(competenceModeInput)}'` });
        }
        selectedCompetenceMode = parsedCompetenceMode;
    }

    if (selectiveDisclosureModeInput !== undefined) {
        selectedSelectiveDisclosureMode = parseBooleanLoose(selectiveDisclosureModeInput);
    }

    let openAIConfigSync = null;
    if (openAIApiKeyInput !== undefined || openAIBaseUrlInput !== undefined || openAIModelInput !== undefined) {
        if (openAIApiKeyInput !== undefined) {
            runtimeOpenAIConfig.apiKey = normalizeOptionalString(openAIApiKeyInput) || "";
        }
        if (openAIBaseUrlInput !== undefined) {
            runtimeOpenAIConfig.baseUrl = normalizeOptionalString(openAIBaseUrlInput) || "";
        }
        if (openAIModelInput !== undefined) {
            runtimeOpenAIConfig.model = normalizeOptionalString(openAIModelInput) || "";
        }
        openAIConfigSync = await syncKeyLLMOpenAIConfig();
    }

    res.json({
        selectedExtractorEngine,
        selectedEnricherEngine,
        selectedSkillExtractorEngine,
        selectedSelectiveDisclosureMode,
        selectiveDisclosureMode: selectedSelectiveDisclosureMode,
        selectedCompetenceMode: formatCompetenceModeForUi(selectedCompetenceMode),
        ...getOpenAIConfigSummary(),
        openAIConfigSync,
        keyLLMConfigSync: openAIConfigSync,
    });
});

// One-shot pipeline endpoint: document -> keywords -> (optional enrichment) -> ESCO matches
app.post('/api/extract', async (req, res) => {
    const document = req.body?.document;
    if (!document) {
        return res.status(400).json({ error: "Missing 'document' in request body" });
    }

    if (req.body?.extractorEngine) setSelectedExtractorEngine(req.body.extractorEngine);
    if (req.body?.enricherEngine) selectedEnricherEngine = req.body.enricherEngine;
    if (req.body?.skillExtractorEngine) selectedSkillExtractorEngine = req.body.skillExtractorEngine;

    const options = req.body?.options || {};

    const skillMappingMode =
        options?.skillMapping?.mode ??
        pipelineConfig.skillMapping?.mode ??
        "keywords";

    // Optional mode: skip keyword extraction/enrichment and run OJD-DAPS extract directly from text.
    if (skillMappingMode === "extract") {
        const skills = await extractSkillsFromText(document, options.skillMapping);
        if (skills.status !== 200) return res.status(skills.status).send(skills);

        return res.json({
            engines: {
                extractor: selectedExtractorEngine,
                enricher: selectedEnricherEngine,
                skills: selectedSkillExtractorEngine
            },
            keywords: [],
            keywords_model: null,
            similar_concepts_keywords: [],
            similar_concepts_keywords_model: null,
            general_concepts_keywords: [],
            general_concepts_keywords_model: null,
            skills: skills.skills,
            skills_model: skills.model,
            skills_config: skills.config,
        });
    }

    const kw = await extractKeywords(document, options.keywordExtraction);
    if (kw.status !== 200) return res.status(kw.status).send(kw);

    const same = await enrichSameLevel(kw.keywords, options.enrichment);
    if (same.status !== 200) return res.status(same.status).send(same);

    const upper = await enrichUpperLevel(kw.keywords, options.enrichment);
    if (upper.status !== 200) return res.status(upper.status).send(upper);

    const skills = await extractSkills(kw.keywords, options.skillMapping);
    if (skills.status !== 200) return res.status(skills.status).send(skills);

    return res.json({
        engines: {
            extractor: selectedExtractorEngine,
            enricher: selectedEnricherEngine,
            skills: selectedSkillExtractorEngine
        },
        keywords: kw.keywords,
        keywords_model: kw.model,
        similar_concepts_keywords: same.keywords,
        similar_concepts_keywords_model: same.model,
        general_concepts_keywords: upper.keywords,
        general_concepts_keywords_model: upper.model,
        skills: skills.skills,
        skills_model: skills.model,
        skills_config: skills.config,
    });
});

//ROUTE 1 get available extractors
app.get("/api_extractor", (req, res) => {
    console.log(`App listening on port ${outPort}`);
    res.json({ "extractor_engines": keywordExtractorEngines });
});

//ROUTE 2 get available enricher
app.get("/api_enricher", (req, res) => {
    console.log(`App listening on port ${outPort}` + " enrichers " + enricherEngines);
    res.json({ "enricher_engines": enricherEngines });
});

app.get("/api_competence_mode", (req, res) => {
    res.json({
        competence_modes: [
            ROBERTA_TO_NESTA_MODE_LABEL,
            GPT_COMPETENCE_MODE_LABEL,
            AZURE_OPENAI_COMPETENCE_MODE_LABEL,
            QWEN_COMPETENCE_MODE_LABEL,
            DEEPSEEK_COMPETENCE_MODE_LABEL,
        ],
        selectedCompetenceMode: formatCompetenceModeForUi(selectedCompetenceMode),
    });
});

//ROUTE 3 get available skills extractors
app.get("/api_skills", (req, res) => {
    console.log(`App listening on port ${outPort}`);
    res.json({ "skills_engines": skillExtractorEngines });
});

app.get("/api_selective_disclosure_mode", (req, res) => {
    res.json({ selectiveDisclosureMode: selectedSelectiveDisclosureMode });
});

app.get("/api_openai_config", (req, res) => {
    res.json(getOpenAIConfigSummary());
});

app.get("/api/pipeline_config", (req, res) => {
    res.json(pipelineConfig);
});

app.post("/api/pipeline_config", (req, res) => {
    try {
        const updated = structuredClone(pipelineConfig);
        deepMerge(updated, req.body || {});
        savePipelineConfig(updated);
        pipelineConfig = updated;
        res.json(pipelineConfig);
    } catch (error) {
        console.error('Error saving pipeline config:', error?.message || error);
        res.status(500).json({ error: 'failed to save pipeline config' });
    }
});

function parseAuthorSkillPair(label, uri) {
    const normalizedLabel = normalizeOptionalString(label);
    const normalizedUri = normalizeOptionalString(uri);
    if (!normalizedLabel || !normalizedUri) return null;
    return { label: normalizedLabel, uri: normalizedUri };
}

function parseAuthorSkillValue(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
        return parseAuthorSkillPair(value[0], value[1]);
    }
    if (typeof value === "object") {
        return parseAuthorSkillPair(
            value.label || value.name || value.skill || value.match_skill || value[0],
            value.uri || value.id || value.match_id || value.skill_id || value[1],
        );
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        if (trimmed.includes("|")) {
            const [label, ...rest] = trimmed.split("|");
            return parseAuthorSkillPair(label, rest.join("|"));
        }
        const httpIndex = trimmed.search(/https?:\/\//i);
        if (httpIndex > 0) {
            return parseAuthorSkillPair(trimmed.slice(0, httpIndex), trimmed.slice(httpIndex));
        }
    }
    return null;
}

function extractAuthorSkillsFromVerifiedCredentials(credentials) {
    const unique = new Map();
    for (const credential of credentials || []) {
        const subject = credential?.credentialSubject || credential?.vc?.credentialSubject;
        const skills = subject?.skills;
        if (!skills) continue;

        const values = Array.isArray(skills)
            ? skills
            : typeof skills === "object"
                ? Object.values(skills)
                : [skills];
        for (const value of values) {
            const parsed = parseAuthorSkillValue(value);
            if (parsed) {
                unique.set(`${parsed.label}|${parsed.uri}`, parsed);
            }
        }
    }
    return [...unique.values()];
}

function embeddedCredentialsFromPresentation(presentation) {
    const raw =
        presentation?.verifiableCredential ||
        presentation?.vp?.verifiableCredential ||
        presentation?.presentation?.verifiableCredential ||
        [];
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
}

function presentationHolder(presentation) {
    return normalizeOptionalString(
        presentation?.holder ||
        presentation?.vp?.holder ||
        presentation?.presentation?.holder ||
        presentation?.iss,
    ) || "";
}

function credentialSubjectId(credential) {
    const subject = credential?.credentialSubject || credential?.vc?.credentialSubject || {};
    const id = Array.isArray(subject) ? subject[0]?.id : subject.id;
    return normalizeOptionalString(id) || "";
}

function isVerifiedResponse(payload) {
    return Boolean(payload?.verified ?? payload?.res ?? payload?.result?.verified);
}

async function decodeJwtArtifact(jwt) {
    // JWT presentations can exceed common request-line limits by tens of KB.
    // Keep the artifact in the request body, matching the benchmark issuer flow.
    const response = await axios.post(
        `${veramoAgentEndpoint}/decode_jwt`,
        { jwt },
        { timeout: ocrVerificationRequestTimeoutMs },
    );
    return response.data;
}

async function normalizeCredentialForVerification(credential) {
    if (typeof credential === "string") {
        return await decodeJwtArtifact(credential);
    }
    if (credential?.proof?.jwt && !credential.credentialSubject) {
        return await decodeJwtArtifact(credential.proof.jwt);
    }
    if (credential?.verifiableCredential) {
        return await normalizeCredentialForVerification(credential.verifiableCredential);
    }
    return credential;
}

async function verifyPresentationAndExtractAuthorSkills(presentation, holderDid) {
    if (!presentation || typeof presentation !== "object") {
        return { ok: false, reason: "vp verification failed: missing presentation" };
    }
    let decodedPresentation = null;
    if (presentation?.proof?.jwt) {
        try {
            decodedPresentation = await decodeJwtArtifact(presentation.proof.jwt);
        } catch (_error) {
            decodedPresentation = null;
        }
    }
    const presentationForExtraction = decodedPresentation || presentation;
    const expectedHolder = normalizeOptionalString(holderDid) || "";
    if (!expectedHolder) {
        return { ok: false, reason: "vp verification failed: missing holderDid" };
    }

    const holder = presentationHolder(presentation) || presentationHolder(presentationForExtraction);
    if (!holder || holder !== expectedHolder) {
        return { ok: false, reason: "vp verification failed: holder mismatch" };
    }

    try {
        const vpVerification = await axios.post(
            `${veramoAgentEndpoint}/verify/vp`,
            { vp: presentation },
            { timeout: ocrVerificationRequestTimeoutMs, headers: { "Content-Type": "application/json" } },
        );
        if (!isVerifiedResponse(vpVerification.data)) {
            const verifierDetail = JSON.stringify(vpVerification.data || {});
            return { ok: false, reason: `vp verification failed: ${verifierDetail}` };
        }
    } catch (error) {
        const detail = error?.response?.data?.error || error?.response?.data?.message || error?.message || error;
        return { ok: false, reason: `vp verification failed: ${detail}` };
    }

    const rawCredentials = embeddedCredentialsFromPresentation(presentationForExtraction);
    if (!rawCredentials.length) {
        return { ok: false, reason: "embedded vc verification failed: no embedded credentials" };
    }
    if (rawCredentials.length > ocrMaxEmbeddedCredentials) {
        return {
            ok: false,
            reason: `embedded vc verification failed: too many credentials (${rawCredentials.length} > ${ocrMaxEmbeddedCredentials})`,
        };
    }

    const verifiedCredentials = [];
    for (const rawCredential of rawCredentials) {
        let credential;
        try {
            credential = await normalizeCredentialForVerification(rawCredential);
        } catch (error) {
            const detail = error?.response?.data?.error || error?.message || error;
            return { ok: false, reason: `embedded vc verification failed: ${detail}` };
        }

        const subjectId = credentialSubjectId(credential);
        if (!subjectId || subjectId !== expectedHolder) {
            return { ok: false, reason: "embedded vc verification failed: holder mismatch" };
        }

        try {
            const vcVerification = await axios.post(
                `${veramoAgentEndpoint}/verify`,
                { credential },
                { timeout: ocrVerificationRequestTimeoutMs, headers: { "Content-Type": "application/json" } },
            );
            if (!isVerifiedResponse(vcVerification.data)) {
                return { ok: false, reason: "embedded vc verification failed" };
            }
        } catch (error) {
            const detail = error?.response?.data?.error || error?.response?.data?.message || error?.message || error;
            return { ok: false, reason: `embedded vc verification failed: ${detail}` };
        }

        verifiedCredentials.push(credential);
    }

    const authorSkills = extractAuthorSkillsFromVerifiedCredentials(verifiedCredentials);
    if (!authorSkills.length) {
        return { ok: false, reason: "embedded vc verification failed: no ESCO skills found" };
    }

    return {
        ok: true,
        authorSkills,
        credentialCount: verifiedCredentials.length,
    };
}

async function executeOcrExtractRequest(body) {
    const timings = {};
    const elapsedNs = (start) => Number(process.hrtime.bigint() - start);
    try {
        const text = body?.text || body?.document;
        let authorSkills = Array.isArray(body?.authorSkills) ? body.authorSkills : [];
        const presentation = body?.presentation || body?.vp || body?.verifiablePresentation || null;
        const holderDid = body?.holderDid || body?.holderDID;
        const competenceMode = body?.competenceMode;
        const requestId = normalizeOptionalString(body?.requestId || body?.request_id);

        let verification = null;
        if (presentation) {
            const verifyStart = process.hrtime.bigint();
            verification = await verifyPresentationAndExtractAuthorSkills(presentation, holderDid);
            timings.verify_vcs_ns = elapsedNs(verifyStart);
            if (!verification.ok) {
                return {
                    status: 200,
                    body: {
                        competent: false,
                        confidence: 1.0,
                        reason: verification.reason,
                        verification,
                        timings,
                    },
                };
            }
            authorSkills = verification.authorSkills;
        }

        const competenceStart = process.hrtime.bigint();
        const result = await findCompetent(text, authorSkills, competenceMode, requestId);
        timings.ai_competence_ns = elapsedNs(competenceStart);
        return {
            status: result.status,
            body: {
                ...result.body,
                authorSkills,
                verification: verification
                    ? {
                        ok: true,
                        credentialCount: verification.credentialCount,
                    }
                    : undefined,
                timings,
            },
        };
    } catch (error) {
        console.error('Error in POST /extract:', error?.response?.data || error?.message || error);
        return {
            status: error?.response?.status || 500,
            body: {
                error: 'competence request failed',
                detail: error?.response?.data || error?.message || String(error),
                timings,
            },
        };
    }
}

// OCR oracle-facing endpoint: returns only competence/confidence/reason.
app.post("/extract", bodyParser.json(), async (req, res) => {
    try {
        const execution = await extractIdempotencyStore.execute({
            key: req.get('Idempotency-Key'),
            // A canonical SHA-256 fingerprint of this parsed JSON body is
            // retained alongside the key. Reusing a key for another payload is
            // rejected instead of returning an unrelated model result.
            payload: req.body,
            operation: () => executeOcrExtractRequest(req.body),
        });
        if (execution.disposition !== 'bypass') {
            res.set('X-CAVS-Idempotency-Status', execution.disposition);
        }
        return res.status(execution.value.status).json(execution.value.body);
    } catch (error) {
        if (
            error instanceof InvalidIdempotencyKeyError
            || error instanceof IdempotencyConflictError
            || error instanceof IdempotencyCapacityError
        ) {
            if (error instanceof IdempotencyCapacityError) {
                res.set('Retry-After', '1');
            }
            return res.status(error.statusCode).json({
                error: error.code,
                detail: error.message,
            });
        }
        console.error('Error in POST /extract idempotency layer:', error?.message || error);
        return res.status(500).json({
            error: 'competence request failed',
            detail: error?.message || String(error),
        });
    }
});

// Backwards-compatible gateway endpoints for older client flows.
app.get("/extract", async (req, res) => {
    const document = req.query.document;
    const engine = req.query.engine;
    const mode = req.query.mode ?? pipelineConfig.skillMapping?.mode ?? "keywords";

    if (!document) {
        return res.status(400).json({ error: "Missing 'document' parameter" });
    }
    if (engine) {
        setSelectedExtractorEngine(engine);
    }

    // In "extract" mode, bypass keyword extraction entirely and run OJD-DAPS directly on the text.
    if (mode === "extract") {
        const result = await extractSkillsFromText(document, {
            skill_match_thresh: req.query.skill_match_thresh,
        });
        if (result.status !== 200) {
            return res.status(result.status).send(result);
        }
        return res.json({ skills: result.skills, model: result.model, config: result.config });
    }

    const result = await extractKeywords(document, {
        top_n: req.query.top_n,
        score_threshold: req.query.score_threshold,
        diversity: req.query.diversity,
        ngram_max: req.query.ngram_max,
    });
    if (result.status !== 200) {
        return res.status(result.status).send(result);
    }
    return res.json({ keyword: result.keywords, model: result.model });
});

app.get("/enrich_same_level", async (req, res) => {
    const keywords = req.query.keywords;
    const engine = req.query.engine;

    if (engine) {
        selectedEnricherEngine = engine;
    }
    const keywordsParam = keywords ?? req.query['keywords[]'];
    const keywordArray = Array.isArray(keywordsParam) ? keywordsParam : (keywordsParam ? [keywordsParam] : []);
    const result = await enrichSameLevel(keywordArray, {
        max_per_keyword: req.query.max_per_keyword,
    });
    if (result.status !== 200) {
        return res.status(result.status).send(result);
    }
    return res.json({ keyword: result.keywords, model: result.model });
});

app.get("/enrich_upper_level", async (req, res) => {
    const keywords = req.query.keywords;
    const engine = req.query.engine;

    if (engine) {
        selectedEnricherEngine = engine;
    }
    const keywordsParam = keywords ?? req.query['keywords[]'];
    const keywordArray = Array.isArray(keywordsParam) ? keywordsParam : (keywordsParam ? [keywordsParam] : []);
    const result = await enrichUpperLevel(keywordArray, {
        max_per_keyword: req.query.max_per_keyword,
    });
    if (result.status !== 200) {
        return res.status(result.status).send(result);
    }
    return res.json({ keyword: result.keywords, model: result.model });
});

app.get("/keyword_to_skills", async (req, res) => {
    const keywords = req.query.keywords;
    const engine = req.query.engine;

    if (engine) {
        selectedSkillExtractorEngine = engine;
    }
    const keywordsParam = keywords ?? req.query['keywords[]'];
    const keywordArray = Array.isArray(keywordsParam) ? keywordsParam : (keywordsParam ? [keywordsParam] : []);
    const result = await extractSkills(keywordArray, {
        skill_match_thresh: req.query.skill_match_thresh,
    });
    if (result.status !== 200) {
        return res.status(result.status).send(result);
    }
    return res.json({ skills: result.skills, model: result.model, config: result.config });
});


// ROUTE 4 set DID as new Selected DID
app.post("/setup_did", async (req, res) => {
    try {
        if (!selectedDID) {
            // One bounded attempt per HTTP request; the independent startup
            // warmup keeps retrying in the background.
            await ensureSelectedDidOnce();
        }
        if (!selectedDID) {
            throw new Error("No selected DID available");
        }
        console.log("DID: " + selectedDID);
        res.status(200).send({"did": selectedDID});
    } catch (error) {
        console.error("Error creating DID:", error.message);
        res.status(500).send("Failed to create DID");

    }
});

//Keyword extraction method
const extractKeywords = async (document, options = {}) => {
    const extractorEngine = normalizeExtractorEngine(selectedExtractorEngine);
    if (!extractorEngine || !keywordExtractorEngines.includes(extractorEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }

    try {
        const keyllmCfg = { ...(pipelineConfig.keywordExtraction?.keyllm || {}), ...options };

        if (extractorEngine === "RoBERTa") {
            return await extractRoBERTaKeywords(document, options);
        }

        if (extractorEngine === "GPT") {
            const response = await axios.get(`${keyLLMServiceEndpoint}/keywords_only_LMM`, {
                timeout: veramoRequestTimeoutMs,
                params: {
                    doc: document,
                    top_n: keyllmCfg.top_n,
                    temperature: keyllmCfg.temperature,
                    seed: keyllmCfg.seed,
                    model: keyllmCfg.model,
                }
            });
            return { status: 200, keywords: response.data.keywords, model: response.data.model };
        }

        if (extractorEngine === "RoBERTa+GPT") {
            const response = await axios.get(`${keyLLMServiceEndpoint}/keywords_both`, {
                timeout: veramoRequestTimeoutMs,
                params: {
                    doc: document,
                    top_n: keyllmCfg.top_n,
                    temperature: keyllmCfg.temperature,
                    seed: keyllmCfg.seed,
                    model: keyllmCfg.model,
                }
            });
            return { status: 200, keywords: response.data.keywords, model: response.data.model };
        }

        return { status: 500, message: `Response: unsupported engine}` };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint: ${err.message}`
            };
        }
    }
};

const extractRoBERTaKeywords = async (document, options = {}) => {
    try {
        const robertaCfg = {
            ...(pipelineConfig.keywordExtraction?.roberta || pipelineConfig.keywordExtraction?.keybert || {}),
            ...definedOptions(options),
        };

        const params = {
            doc: document,
            engine: nestaKeywordEngine,
            top_n: robertaCfg.top_n,
            nr_candidates: robertaCfg.nr_candidates,
            ngram_max: robertaCfg.ngram_max,
            use_mmr: robertaCfg.use_mmr,
            diversity: robertaCfg.diversity,
            score_threshold: robertaCfg.score_threshold,
        };
        if (options.request_id) {
            params.request_id = options.request_id;
        }
        const response = await axios.get(`${keywordExtractorServiceEndpoint}/keywords`, {
            timeout: timeoutMsFromSeconds(robertaCfg.timeout_s, 60000),
            params,
        });
        return { status: 200, keywords: response.data.keywords, model: response.data.model };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint: ${err.message}`
            };
        }
    }
};


const enrichSameLevel = async (keywords, options = {}) => {
    console.log(selectedEnricherEngine);
    console.log(keywords);

    if (!enricherEngines.includes(selectedEnricherEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }
    if (selectedEnricherEngine === "NONE") {
        // Return empty list of keywords
        return { status: 200, keywords: [], model: { engine: "NONE" } };
    }

    try {
        const maxPerKeyword = Number.isFinite(Number(options.max_per_keyword))
            ? Number(options.max_per_keyword)
            : pipelineConfig.enrichment?.max_per_keyword;

        if (selectedEnricherEngine === "YAGO") {
            const responses = await Promise.all(
                keywords.map((term) =>
                    axios.get(`${yagoServiceEndpoint}/querySameLevelHierarchy`, {
                        timeout: veramoRequestTimeoutMs,
                        params: { element: term }
                    })
                )
            );
            const extrakeywords = responses
                .flatMap((r) => r.data?.results || [])
                .slice(0, Math.max(0, maxPerKeyword || 0) * Math.max(1, keywords.length));
            return { status: 200, keywords: extrakeywords, model: { engine: "YAGO" } };
        }

        if (selectedEnricherEngine === "GPT") {
            const gptCfg = pipelineConfig.enrichment?.gpt || {};
            const responses = await Promise.all(
                keywords.map((term) =>
                    axios.get(`${keyLLMServiceEndpoint}/same_level_keywords`, {
                        timeout: veramoRequestTimeoutMs,
                        params: {
                            keywords: term,
                            temperature: gptCfg.temperature,
                            seed: gptCfg.seed,
                            model: gptCfg.model,
                        }
                    })
                )
            );
            const extrakeywords = responses
                .flatMap((r) => r.data?.Keywords || [])
                .slice(0, Math.max(0, maxPerKeyword || 0) * Math.max(1, keywords.length));
            const model = responses[0]?.data?.model || { engine: "GPT" };
            return { status: 200, keywords: extrakeywords, model };
        }

        return { status: 500, message: `Response: unsupported engine}` };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint`
            };
        }
    }


};


const enrichUpperLevel = async (keywords, options = {}) => {
    if (!enricherEngines.includes(selectedEnricherEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }
    if (selectedEnricherEngine === "NONE") {
        // Return empty list of keywords
        return { status: 200, keywords: [], model: { engine: "NONE" } };
    }

    try {
        const maxPerKeyword = Number.isFinite(Number(options.max_per_keyword))
            ? Number(options.max_per_keyword)
            : pipelineConfig.enrichment?.max_per_keyword;

        if (selectedEnricherEngine === "YAGO") {
            const responses = await Promise.all(
                keywords.map((term) =>
                    axios.get(`${yagoServiceEndpoint}/queryUpperHierarchy`, {
                        timeout: veramoRequestTimeoutMs,
                        params: { element: term }
                    })
                )
            );
            const extrakeywords = responses
                .flatMap((r) => r.data?.results || [])
                .slice(0, Math.max(0, maxPerKeyword || 0) * Math.max(1, keywords.length));
            return { status: 200, keywords: extrakeywords, model: { engine: "YAGO" } };
        }

        if (selectedEnricherEngine === "GPT") {
            const gptCfg = pipelineConfig.enrichment?.gpt || {};
            const responses = await Promise.all(
                keywords.map((term) =>
                    axios.get(`${keyLLMServiceEndpoint}/upper_level_keywords`, {
                        timeout: veramoRequestTimeoutMs,
                        params: {
                            keywords: term,
                            temperature: gptCfg.temperature,
                            seed: gptCfg.seed,
                            model: gptCfg.model,
                        }
                    })
                )
            );
            const extrakeywords = responses
                .flatMap((r) => r.data?.Keywords || [])
                .slice(0, Math.max(0, maxPerKeyword || 0) * Math.max(1, keywords.length));
            const model = responses[0]?.data?.model || { engine: "GPT" };
            return { status: 200, keywords: extrakeywords, model };
        }

        return { status: 500, message: `Response: unsupported engine}` };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint`
            };
        }
    }


};

const extractSkills = async (keywords, options = {}) => {
    if(keywords.length === 0){

        return {
            status: 200,
            skills: []
        };

    }
    if (!skillExtractorEngines.includes(selectedSkillExtractorEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }

    try {
        const skillMatchThresh =
            options.skill_match_thresh !== undefined && options.skill_match_thresh !== null && options.skill_match_thresh !== ""
                ? Number(options.skill_match_thresh)
                : undefined;
        const timeoutMs = timeoutMsFromSeconds(options.timeout_s ?? pipelineConfig.skillMapping?.timeout_s, 30000);

        // ojd_daps_skills expects keywords as a JSON object (dictionary) string.
        const jsonObject = {};
        keywords.forEach((value, index) => {
            jsonObject[index.toString()] = value;
        });
        const params = {
            keywords: JSON.stringify(jsonObject),
        };
        if (skillMatchThresh !== undefined && !Number.isNaN(skillMatchThresh)) {
            params.skill_match_thresh = skillMatchThresh;
        }
        if (options.request_id) {
            params.request_id = options.request_id;
        }
        const response = await axios.get(`${ojdDapsSkillsEndpoint}/keyword_to_skills`, {
            timeout: timeoutMs,
            params
        });
        return { status: 200, skills: response.data.skills, model: response.data.model, config: response.data.config };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint: ${err.message}`
            };
        }
    }
};

const extractSkillsFromText = async (document, options = {}) => {
    if (!document) {
        return { status: 400, message: "Missing document text" };
    }
    if (!skillExtractorEngines.includes(selectedSkillExtractorEngine)) {
        return { status: 500, message: `Response: unsupported engine}` };
    }

    try {
        const skillMatchThresh =
            options.skill_match_thresh !== undefined && options.skill_match_thresh !== null && options.skill_match_thresh !== ""
                ? Number(options.skill_match_thresh)
                : undefined;

        const body = { text: document };
        if (skillMatchThresh !== undefined && !Number.isNaN(skillMatchThresh)) {
            body.skill_match_thresh = skillMatchThresh;
        }
        if (options.request_id) {
            body.request_id = options.request_id;
        }
        const response = await axios.post(
            `${ojdDapsSkillsEndpoint}/extract`,
            body,
            {
                timeout: 25000000,
                headers: { 'Content-Type': 'application/json' },
            }
        );

        // Service may return `skills` at top-level (single input) or inside `results[0].skills`.
        const skills =
            response.data?.skills ??
            response.data?.results?.[0]?.skills ??
            [];

        return { status: 200, skills, model: response.data?.model, config: response.data?.config };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            return { status: 502, message: `Response: service endpoint timed out}` };
        }
        return { status: 500, message: `Unknown error in sending request to service endpoint: ${err.message}` };
    }
};

function extractSkillsListFromServicePayload(payload) {
    if (!payload || typeof payload !== 'object') return [];

    if (Array.isArray(payload.skills)) {
        return payload.skills;
    }

    const firstResult = Array.isArray(payload.results) ? payload.results[0] : null;
    if (firstResult && typeof firstResult === 'object') {
        if (Array.isArray(firstResult.skills)) return firstResult.skills;
        if (Array.isArray(firstResult.mapped_skills)) return firstResult.mapped_skills;
    }

    return [];
}

function mergeSkillLists(...skillLists) {
    const out = [];
    const seen = new Set();

    for (const skillList of skillLists) {
        for (const skill of skillList || []) {
            let key;
            try {
                key = JSON.stringify(skill, Object.keys(skill || {}).sort());
            } catch (_err) {
                key = String(skill);
            }
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(skill);
        }
    }

    return out;
}

function resolveCompetenceSkillMappingMode(rawMode) {
    const mode = normalizeStr(rawMode);
    if (mode === "extract" || mode === "keywords" || mode === "roberta_map" || mode === "extract_union_roberta_map") {
        return mode;
    }
    return DEFAULT_PIPELINE_CONFIG.competence.skill_mapping_mode;
}

const mapPhrasesToSkills = async (phrases, requestId = "") => {
    if (!Array.isArray(phrases) || phrases.length === 0) {
        return { status: 200, skills: [] };
    }

    try {
        const response = await axios.post(
            `${ojdDapsSkillsEndpoint}/map_phrases`,
            requestId ? { phrases, request_id: requestId } : { phrases },
            {
                timeout: 25000000,
                headers: { 'Content-Type': 'application/json' },
            }
        );

        return {
            status: 200,
            skills: extractSkillsListFromServicePayload(response.data),
            model: response.data?.model,
            config: response.data?.config,
        };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            return { status: 502, message: `Response: service endpoint timed out}` };
        }
        return { status: 500, message: `Unknown error in sending request to service endpoint: ${err.message}` };
    }
};

const extractSkillsForNestaCompetence = async (document, requestId = "") => {
    const skillMappingMode = resolveCompetenceSkillMappingMode(
        pipelineConfig.competence?.skill_mapping_mode ??
        pipelineConfig.skillMapping?.mode
    );

    if (skillMappingMode === "extract") {
        return extractSkillsFromText(document, { ...pipelineConfig.skillMapping, request_id: requestId });
    }

    const keywordsResp = await extractRoBERTaKeywords(document, { ...(pipelineConfig.keywordExtraction?.roberta || {}), request_id: requestId });
    if (keywordsResp.status !== 200) {
        return keywordsResp;
    }

    if (skillMappingMode === "keywords") {
        return extractSkills(keywordsResp.keywords, { ...pipelineConfig.skillMapping, request_id: requestId });
    }

    if (skillMappingMode === "roberta_map") {
        return mapPhrasesToSkills(keywordsResp.keywords, requestId);
    }

    if (skillMappingMode === "extract_union_roberta_map") {
        const directSkillsResp = await extractSkillsFromText(document, { ...pipelineConfig.skillMapping, request_id: requestId });
        if (directSkillsResp.status !== 200) {
            return directSkillsResp;
        }

        const mappedSkillsResp = await mapPhrasesToSkills(keywordsResp.keywords, requestId);
        if (mappedSkillsResp.status !== 200) {
            return mappedSkillsResp;
        }

        return {
            status: 200,
            skills: mergeSkillLists(directSkillsResp.skills, mappedSkillsResp.skills),
            model: {
                engine: "extract_union_roberta_map",
                extract: directSkillsResp.model || null,
                roberta: keywordsResp.model || null,
                map: mappedSkillsResp.model || null,
            },
            config: {
                extract: directSkillsResp.config || null,
                map: mappedSkillsResp.config || null,
            },
        };
    }

    return extractSkills(keywordsResp.keywords, { ...pipelineConfig.skillMapping, request_id: requestId });
};


function checkSkillAgainstKeywords(skill, skillsKeywords) {
    for (let k = 0; k < skillsKeywords.length; k++) {
        const [label, uri] = skill || [];
        const [kLabel, kUri] = skillsKeywords[k] || [];

        if (uri && kUri && uri === kUri) return true;
        if (label && kLabel && label === kLabel) return true;
    }
    return false;
}

// Dispatch competence evaluation by selected extractor.
async function findCompetent(text, authorSkills = [], competenceModeInput = undefined, requestId = "") {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return { status: 400, body: { error: "Missing 'text' in request body" } };
    }
    const competenceMode = resolveCompetenceMode(competenceModeInput);
    if (!competenceMode) {
        return {
            status: 400,
            body: { error: `Unsupported competenceMode '${String(competenceModeInput)}'` },
        };
    }

    if (competenceMode === "gpt") {
        return await gpt_skill_extraction_find_competent(text, authorSkills, requestId);
    }
    if (competenceMode === "azure-openai") {
        return await llm_skill_extraction_find_competent(
            "azure-openai",
            azureOpenAICompetenceEndpoint,
            text,
            authorSkills,
            requestId,
        );
    }
    if (competenceMode === "qwen") {
        return await llm_skill_extraction_find_competent("qwen", qwenCompetenceEndpoint, text, authorSkills, requestId);
    }
    if (competenceMode === "deepseek") {
        return await llm_skill_extraction_find_competent("deepseek", deepseekCompetenceEndpoint, text, authorSkills, requestId);
    }
    if (competenceMode === "llama") {
        return await llm_skill_extraction_find_competent("llama", llamaCompetenceEndpoint, text, authorSkills, requestId);
    }
    if (competenceMode === "gemma") {
        return await llm_skill_extraction_find_competent("gemma", gemmaCompetenceEndpoint, text, authorSkills, requestId);
    }

    if (selectedSkillExtractorEngine === "OJD_DAPS") {
        return await nesta_skill_extraction_find_competent(text, authorSkills, requestId);
    }
    return { status: 500, body: { error: `Unsupported skill extractor engine ${selectedSkillExtractorEngine}` } };
}

// Compute competence/confidence/reason using GPT competence checker.
async function gpt_skill_extraction_find_competent(text, authorSkills = [], requestId = "") {
    return await llm_skill_extraction_find_competent(
        "gpt",
        gptCompetenceEndpoint,
        text,
        authorSkills,
        requestId,
        buildOpenAIOverridePayload(),
    );
}

async function llm_skill_extraction_find_competent(backend, endpoint, text, authorSkills = [], requestId = "", overrides = {}) {
    const safeAuthorSkills = normalizeAuthorSkillsForCompetence(authorSkills);
    const label = `${backend} competence checker`;

    try {
        const response = await axios.post(
            `${endpoint}/extract`,
            {
                statement: text,
                skills: safeAuthorSkills,
                ...(requestId ? { request_id: requestId } : {}),
                ...overrides,
            },
            {
                timeout: competenceCheckerRequestTimeoutMs,
                headers: { 'Content-Type': 'application/json' },
            },
        );

        const payload = response.data || {};
        const competent = parseBooleanLoose(payload.competent ?? payload.competent_skill_gpt);
        let confidence = Number(payload.confidence ?? payload.competent_confidence_skill_gpt);
        if (!Number.isFinite(confidence)) confidence = 0;
        confidence = Math.max(0, Math.min(1, confidence));

        const reasonRaw = payload.reason ?? payload.competent_reason_skill_gpt;
        const reason = typeof reasonRaw === 'string' && reasonRaw.trim()
            ? reasonRaw.trim()
            : `No reason provided by ${label}`;

        return {
            status: 200,
            body: {
                competent,
                confidence,
                reason,
                competence_backend: payload.competence_backend || backend,
                competence_model: payload.competence_model || payload.model || "",
            },
        };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            return { status: 502, body: { error: `${label} timed out` } };
        }

        if (err.response) {
            const detail = err.response.data?.detail || err.response.data?.error || err.response.data;
            return {
                status: err.response.status || 502,
                body: {
                    error: `${label} request failed`,
                    detail,
                },
            };
        }

        return {
            status: 500,
            body: {
                error: `Unknown error in ${label} request`,
                detail: err.message,
            },
        };
    }
}

// Compute competence/confidence/reason using OJD-DAPS skill extraction.
async function nesta_skill_extraction_find_competent(text, authorSkills = [], requestId = "") {
    const skillsResp = await extractSkillsForNestaCompetence(text, requestId);
    if (skillsResp.status !== 200) {
        return { status: skillsResp.status, body: skillsResp };
    }

    const canonicalSkills = parseSkills(skillsResp.skills);
    const denom = canonicalSkills.length;

    if (denom === 0) {
        return {
            status: 200,
            body: {
                competent: false,
                confidence: 1,
                reason: "Not competent: no skills extracted",
                competence_backend: "nesta",
                competence_model: skillsResp.model || null,
            },
        };
    }

    let escoIndex = null;
    try {
        escoIndex = await getEscoIndex();
    } catch (err) {
        if (!escoUnavailableWarned) {
            console.warn(`ESCO index unavailable (${escoFilePath}):`, err?.message || err);
            escoUnavailableWarned = true;
        }
    }

    let weightedCoverage = 0;
    let coveredSkills = 0;
    let exactMatches = 0;
    const hierarchyMatchesByDistance = new Map();

    if (escoIndex) {
        const authorUris = resolveValidAuthorSkillUris(authorSkills, escoIndex);
        if (authorUris.size === 0) {
            return {
                status: 200,
                body: {
                    competent: false,
                    confidence: 1,
                    reason: "No valid ESCO (label, uri) skills available for this author.",
                    competence_backend: "nesta",
                    competence_model: skillsResp.model || null,
                },
            };
        }

        for (const [label, uri] of canonicalSkills) {
            const labelNorm = normalizeStr(label);

            // Resolve extracted skill to one or more ESCO URIs.
            const extractedUris = new Set();
            if (typeof uri === 'string' && uri.startsWith('http://data.europa.eu/esco/skill/') && escoIndex.graph.has(uri)) {
                extractedUris.add(uri);
            }
            if (labelNorm) {
                const mapped = escoIndex.labelToUris.get(labelNorm);
                if (mapped) {
                    for (const m of mapped) extractedUris.add(m);
                }
            }

            if (extractedUris.size === 0 || authorUris.size === 0) {
                continue;
            }

            let bestDist = Infinity;
            for (const src of extractedUris) {
                const d = shortestDistance(escoIndex.graph, src, authorUris, ESCO_MAX_HOPS);
                if (d < bestDist) bestDist = d;
                if (bestDist === 0) break;
            }
            const contribution = coverageContributionFromDistance(bestDist);
            if (contribution > 0) {
                weightedCoverage += contribution;
                coveredSkills += 1;
                if (bestDist === 0) {
                    exactMatches += 1;
                } else {
                    hierarchyMatchesByDistance.set(
                        bestDist,
                        (hierarchyMatchesByDistance.get(bestDist) || 0) + 1,
                    );
                }
            }
        }
    } else {
        // Fallback: exact matching only (still with corrected confidence semantics).
        const authorSet = buildAuthorSkillTokenSet(authorSkills);
        for (const [label, uri] of canonicalSkills) {
            const l = normalizeStr(label);
            const u = normalizeStr(uri);
            if ((u && authorSet.has(u)) || (l && authorSet.has(l))) {
                weightedCoverage += 1;
                coveredSkills += 1;
                exactMatches += 1;
            }
        }
    }

    const coverage = Math.max(0, Math.min(1, weightedCoverage / denom));
    const comp = computeCompetenceFromCoverage(coverage, denom);
    const reason = buildDistanceAwareCoverageReason(
        comp.competent,
        coveredSkills,
        denom,
        exactMatches,
        hierarchyMatchesByDistance,
        comp.coverage,
    );

    return {
        status: 200,
        body: {
            competent: comp.competent,
            confidence: comp.confidence,
            reason,
            competence_backend: "nesta",
            competence_model: skillsResp.model || null,
        },
    };
}


app.post('/api/issuer_trust', bodyParser.json(), (req, res) => {
    const { did, rank } = req.body;

    if (typeof did !== 'string' || !did.trim()) {
        return res.status(400).send({ error: 'DID is missing' });
    }
    const normalizedRank = Number(rank);
    if (!Number.isFinite(normalizedRank) || normalizedRank > 5 || normalizedRank < 0) {
        return res.status(400).send({ error: 'rank must be between 0 and 5' });
    }

    try {
        trustedissuers.push({ did: did.trim(), rank: normalizedRank });
        writeJsonFileAtomic(path.resolve('./trustedissuers.json'), trustedissuers);
        res.send("ok");
    } catch (error) {
        trustedissuers.pop();
        console.error('Error saving trusted issuer:', error?.message || error);
        res.status(500).send({ error: 'failed to save trusted issuer' });
    }
});

//route that extracts from statement Keywords, conditionally also synonymous concepts and higher level ones
// then it finds the skills from the keywords
//furthermore it matches the credentials provided by the user with skills found
// IT VERIFIES THEM
// Then it creates a Statement Verifiable credential
app.post('/api/vc', bodyParser.json(), async (req, res) => {
    const document = req.body.document;
    const credentials = req.body.credentials;
    const typeStatement = req.body.typeStatement;
    const category = req.body.category;
    const statementTitle = req.body.statementTitle;
    const holderDID = req.body.holderDID;

    const skillMappingMode =
        req.body?.options?.skillMapping?.mode ??
        pipelineConfig.skillMapping?.mode ??
        "keywords";

    let keywords = [];
    let keywordsModel = null;
    let sameLevelKeywords = [];
    let sameLevelKeywordsModel = null;
    let upperLevelKeywords = [];
    let upperLevelKeywordsModel = null;

    let skillsModel = null;
    let skillsKeywords = [];
    let sameLevelKeywordsSkills = [];
    let upperLevelKeywordsSkills = [];

    // In "extract" mode, bypass keyword extraction/enrichment and extract OJD-DAPS skills directly from text.
    if (skillMappingMode === "extract") {
        const result = await extractSkillsFromText(document, req.body?.options?.skillMapping ?? pipelineConfig.skillMapping);
        if (result.status !== 200) return res.status(result.status).send(result);
        skillsModel = result.model;
        skillsKeywords = parseSkills(result.skills);
    } else {
        // Extract keywords
        let result = await extractKeywords(document);
        if (result.status !== 200) {
            return res.status(result.status).send(result);
        }
        keywords = result.keywords;
        keywordsModel = result.model;

        // Enrich with same-level concepts
        result = await enrichSameLevel(keywords);
        if (result.status !== 200) {
            return res.status(result.status).send(result);
        }
        sameLevelKeywords = result.keywords;
        sameLevelKeywordsModel = result.model;

        // Enrich with upper-level concepts
        result = await enrichUpperLevel(keywords);
        if (result.status !== 200) {
            return res.status(result.status).send(result);
        }
        upperLevelKeywords = result.keywords;
        upperLevelKeywordsModel = result.model;

        // Extract skills for each level
        result = await extractSkills(keywords);
        skillsModel = result.model;
        if (result.status !== 200) {
            return res.status(result.status).send(result);
        }
        skillsKeywords = parseSkills(result.skills);

        result = await extractSkills(sameLevelKeywords);
        if (result.status !== 200) {
            return res.status(result.status).send(result);
        }
        sameLevelKeywordsSkills = parseSkills(result.skills);

        result = await extractSkills(upperLevelKeywords);
        if (result.status !== 200) {
            return res.status(result.status).send(result);
        }
        upperLevelKeywordsSkills = parseSkills(result.skills);
    }

    // Arrays to store credentials and their respective ranks
    let keywordsCredentials = [];
    let sameLevelKeywordsCredentials = [];
    let upperLevelKeywordsCredentials = [];

    let keywordsCredentialsRanks = [];
    let sameLevelKeywordsCredentialsRanks = [];
    let upperLevelKeywordsCredentialsRanks = [];

    // Process each credential
    for (let i = 0; i < credentials.length; i++) {
        let cred = credentials[i];
        let skills = cred.credentialSubject.skills;
        let put = false, put2 = false, put3 = false;
        let j = 0;

        if (cred.credentialSubject.id === holderDID) {
            // Credential will be included only if the holder DID matches the Author DID
            while (j < skills.length && !(put || put2 || put3)) {
                put = checkSkillAgainstKeywords(skills[j], skillsKeywords);
                put2 = checkSkillAgainstKeywords(skills[j], sameLevelKeywordsSkills);
                put3 = checkSkillAgainstKeywords(skills[j], upperLevelKeywordsSkills);
                j++; // Increment j to check the next skill
            }

            if (put) {
                if (verify_VC(cred)) {
                    let rank = 0;
                    for (let k = 0; k < trustedissuers.length && rank === 0; k++) {
                        if (cred.issuer.id === trustedissuers[k].did) {
                            rank = trustedissuers[k].rank;
                        }
                    }
                    keywordsCredentials.push(cred);
                    keywordsCredentialsRanks.push(rank);
                }
            } else if (put2) {
                if (verify_VC(cred)) {
                    let rank = 0;
                    for (let k = 0; k < trustedissuers.length && rank === 0; k++) {
                        if (cred.issuer.id === trustedissuers[k].did) {
                            rank = trustedissuers[k].rank;
                        }
                    }
                    sameLevelKeywordsCredentials.push(cred);
                    sameLevelKeywordsCredentialsRanks.push(rank);
                }
            } else if (put3) {
                if (verify_VC(cred)) {
                    let rank = 0;
                    for (let k = 0; k < trustedissuers.length && rank === 0; k++) {
                        if (cred.issuer.id === trustedissuers[k].did) {
                            rank = trustedissuers[k].rank;
                        }
                    }
                    upperLevelKeywordsCredentials.push(cred);
                    upperLevelKeywordsCredentialsRanks.push(rank);
                }
            }
        }
    }

    console.log("Issuing Statement Verifiable Credential");
    try {
        const response = await axios.post(
            `${veramoAgentEndpoint}/issue_verifiable_credential`,
            {
                issuer: selectedDID,
                holder: holderDID,
                type: "StatementVerifiableCredential",
                attributes: {
                    cavs_config: selectedExtractorEngine + "+" + selectedEnricherEngine + "+" + selectedSkillExtractorEngine,
                    keywords: keywords,
                    keywords_model: keywordsModel, // Include model for keywords
                    skills_model: skillsModel,
                    similar_concepts_keywords: sameLevelKeywords,
                    similar_concepts_keywords_model: sameLevelKeywordsModel, // Include model for same-level keywords
                    general_concepts_keywords: upperLevelKeywords,
                    general_concepts_keywords_model: upperLevelKeywordsModel, // Include model for upper-level keywords
                    statementType: typeStatement,
                    statementCategory: category,
                    statementTitle: statementTitle,
                    credentials_for_skills: keywordsCredentials,
                    credentials_for_similar_concepts_skills: sameLevelKeywordsCredentials,
                    credentials_for_general_concepts_skills: upperLevelKeywordsCredentials,
                    ranks_for_skills: keywordsCredentialsRanks,
                    ranks_for_similar_concepts_skills: sameLevelKeywordsCredentialsRanks,
                    ranks_for_general_concepts_skills: upperLevelKeywordsCredentialsRanks
                },
                store: false
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: veramoRequestTimeoutMs
            }
        );

        let jwt = response.data.jwt;
        res.status(200).send({ jwt: jwt });
    } catch (error) {
        res.status(500).send("Failed to create Verifiable Credential");
    }
});

const parseSkills = (skills) => {
    // Minimal parsing for downstream compatibility:
    // - Keep the raw OJD-DAPS array available via `skills_raw`.
    // - Provide a canonical `[label, id]` list for matching/counting with minimal transformation:
    //   - `label`: ESCO label if present, else `match_skill`
    //   - `id`: ESCO URI if present, else the raw `match_id` as returned by OJD-DAPS
    const uniqueById = new Map();

    (skills || []).forEach((match) => {
        const label = match?.esco?.label ?? match?.match_skill;
        const id = match?.esco?.uri ?? match?.match_id;

        if (typeof label !== 'string' || !label) return;
        if (typeof id !== 'string' || !id) return;

        uniqueById.set(id, [label, id]);
    });

    return Array.from(uniqueById.values());
};

const verify_VC = async (vc) => {

    let response = await axios.post(
        `${veramoAgentEndpoint}/verify`,
        {
            credential: vc,
        },
        {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: veramoRequestTimeoutMs
        }
    );
    return response.data.res
}




// SIMULATION
//CODE TO USE FOR SIMULATION
app.post('/simulation/skillsfromtext',bodyParser.json(), async (req, res) => {
    try {
        let text = req.body.text;
        console.log("text:", text);

        // Direct OJD-DAPS extraction from text (skip KeyBERT entirely)
        let skill_text = await extractSkillsFromText(text, pipelineConfig.skillMapping);
        if (skill_text.status !== 200) return res.status(skill_text.status).send(skill_text);

        console.log("Extracted skills from text:", skill_text.skills);

        // Raw passthrough (maximum detail) + minimal canonical form (for matching/counting).
        const skillsRaw = skill_text.skills;
        const skillsCanonical = parseSkills(skillsRaw);

        res.send({
            skills: skillsRaw,
            skills_raw: skillsRaw,
            skills_canonical: skillsCanonical,
            skills_model: skill_text.model,
            skills_config: skill_text.config
        });

    } catch (error) {
        console.error("Error in /simulation/skillsfromtext:", error);
        res.status(500).send({ error: 'Internal Server Error', details: error.message });
    }
});

app.post('/simulation', bodyParser.json(),async (req, res) => {
    try {
        let { document, bio } = req.body;
        console.log("Bio:", bio);

        // Direct OJD-DAPS extraction from bio (skip KeyBERT)
        let skill_bio = await extractSkillsFromText(bio, pipelineConfig.skillMapping);
        if (skill_bio.status !== 200) return res.status(skill_bio.status).send(skill_bio);

        console.log("Extracted skills from bio:", skill_bio.skills);

        // Parse the skills
        let skills = parseSkills(skill_bio.skills);

        // Direct OJD-DAPS extraction from document (skip KeyBERT)
        let doc_skills = await extractSkillsFromText(document, pipelineConfig.skillMapping);
        if (doc_skills.status !== 200) return res.status(doc_skills.status).send(doc_skills);

        console.log("Extracted skills from document:", doc_skills.skills);

        // Parse the skills from document
        let skillsKeywords = parseSkills(doc_skills.skills);

        console.log("Skills keywords from document:", skillsKeywords);

        // Match skills
        let keywordsMatch = 0;

        for (let skill of skills) {
            let isKeywordMatch = checkSkillAgainstKeywords(skill, skillsKeywords);

            if (isKeywordMatch) {
                keywordsMatch++;
            }
        }

        res.send({
            matches: keywordsMatch
        });

    } catch (error) {
        console.error("Error in /simulation:", error);
        res.status(500).send({ error: 'Internal Server Error', details: error.message });
    }
});

// Call configureApp before app.listen
configureApp().then(() => {
    // Start the server
    loadPipelineConfig();
    console.log("attention Setup completed with selected engines: " + selectedExtractorEngine + " " + selectedEnricherEngine + " " + selectedSkillExtractorEngine + " " + selectedDID);
    const server = app.listen(outPort, () => {
        console.log(`Server is running on port ${outPort}`);
    });
    server.keepAliveTimeout = cavsHttpKeepAliveTimeoutMs;
    server.headersTimeout = cavsHttpHeadersTimeoutMs;
    console.log(
        `HTTP keep-alive policy: keepAliveTimeout=${server.keepAliveTimeout}ms `
        + `headersTimeout=${server.headersTimeout}ms`,
    );
});
