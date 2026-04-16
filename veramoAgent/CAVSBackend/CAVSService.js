import express from 'express';
import cors from 'cors';
import axios from 'axios';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import config from './config.json' with { type: 'json' };
import trustedissuers from './trustedissuers.json' with { type: 'json' };

const app = express();
const outPort = 4200;
const PORT = 17005;

const PIPELINE_CONFIG_PATH = path.resolve('./pipeline.config.json');

const DEFAULT_PIPELINE_CONFIG = {
    keywordExtraction: {
        roberta: {
            top_n: 120,
            nr_candidates: 300,
            ngram_max: 3,
            use_mmr: true,
            diversity: 0.7,
            score_threshold: 0.10,
        },
        keybert: {
            top_n: 120,
            nr_candidates: 300,
            ngram_max: 3,
            use_mmr: true,
            diversity: 0.7,
            score_threshold: 0.10,
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
        // Match Validation/nest-experimentation article_skill_mode=extract_union_roberta_map.
        skill_mapping_mode: "extract_union_roberta_map",
    },
    skillMapping: {
        // "keywords": map provided keywords to skills (default pipeline behaviour)
        // "extract": run OJD-DAPS extract directly on the original document text
        mode: "keywords",
        skill_match_thresh: null,
    },
};

let pipelineConfig = structuredClone(DEFAULT_PIPELINE_CONFIG);

function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const [key, value] of Object.entries(source)) {
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

function savePipelineConfig() {
    fs.writeFileSync(PIPELINE_CONFIG_PATH, JSON.stringify(pipelineConfig, null, 2));
}

let keywordExtractorEngines = ["RoBERTa"];
let enricherEngines = ["NONE", "YAGO"];
let skillExtractorEngines = ["OJD_DAPS"];

let selectedExtractorEngine = keywordExtractorEngines[0];
let selectedEnricherEngine = enricherEngines[0];
let selectedSkillExtractorEngine = skillExtractorEngines[0];
let selectedSelectiveDisclosureMode = false;
const selectedDIDETHAWalletAddr = '0x877545E3910550Ce27c2c51Bd2FF14837acB6566';
const selectedDIDPrivKey = 'f55a62b189423bf293d3e9b8bbd114d98bd28b29fc45d07d4876ce2f2dc51440';
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
const gptCompetenceEndpoint = process.env.GPT_COMP_ENDPOINT || config.gptCompServiceEndpoint || 'http://gptcomp:3030';
const GPT_COMPETENCE_MODE_LABEL = "GPT competence service";
const ROBERTA_TO_NESTA_MODE_LABEL = "RoBERTa to Nesta mode";
const DEFAULT_COMPETENCE_MODE = parseCompetenceMode(
    process.env.CAVS_COMPETENCE_MODE || config.competenceMode || "nesta"
) || "ojd_daps";
let selectedCompetenceMode = DEFAULT_COMPETENCE_MODE;
const runtimeOpenAIConfig = {
    apiKey: process.env.OPENAI_COMPETENCE_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_COMPETENCE_BASE_URL || process.env.OPENAI_BASE_URL || "",
    model: process.env.OPENAI_COMPETENCE_MODEL || process.env.OPENAI_MODEL || "",
};
const DEFAULT_ESCO_FILE_PATH = '/home/cal/componentsCAVS/esco-v1.2.1.jsonl';
const escoFilePath =
    process.env.ESCO_JSONL_PATH ||
    config?.escoFilePath ||
    DEFAULT_ESCO_FILE_PATH;
app.use(cors(), express.json());

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

function parseCompetenceMode(mode) {
    const m = normalizeStr(mode);
    if (!m) return null;

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
        m === "ojd" ||
        m === "ojd_daps" ||
        m === "nesta" ||
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
    return mode === "ojd_daps" ? ROBERTA_TO_NESTA_MODE_LABEL : GPT_COMPETENCE_MODE_LABEL;
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
                timeout: 65000,
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

async function fetchDIDWithRetry() {
    while (!selectedDID) {
        try {
            const response = await axios.get(
                `${veramoAgentEndpoint}/api/v0/setup/?privatekey=${selectedDIDPrivKey}&walletaddr=${selectedDIDETHAWalletAddr}`,
                {
                    timeout: 65000,
                }
            );
            selectedDID = response.data.did;
            console.log('Our DID:', selectedDID);
        } catch (error) {
            console.error('Error fetching credentials:', error.message);
            await new Promise((resolve) => setTimeout(resolve, 5000)); // wait for 5 seconds before retrying
        }
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- OCR/Veramo identity setup (BLS keys etc) ---
const ocrSignerByOracleId = new Map(); // oracleId -> {did,kid_bls,kid_eth,bls_pub_key}
const ocrSignerSetupInFlight = new Map(); // oracleId -> Promise<identity>
let ocrSignerWarmupStarted = false;

async function ensureOcrSignerIdentity(oracleId) {
    if (!Number.isInteger(oracleId) || oracleId < 0) {
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
            { timeout: 65000 },
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
            await sleep(5000);
        }
    }
}

const configureApp = async () => {
    try {
        // Do not block server startup on Veramo; warm up in background.
        void fetchDIDWithRetry();
        void warmupOcrSignerIdentitiesForever();
        // Warm up ESCO index in background; competence endpoint can still fallback.
        void getEscoIndex().catch((err) => {
            if (!escoUnavailableWarned) {
                console.warn(`ESCO index unavailable (${escoFilePath}):`, err?.message || err);
                escoUnavailableWarned = true;
            }
        });
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
        { timeout: 65000 },
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
            { timeout: 65000 },
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
            { timeout: 65000 },
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
    if (!Number.isInteger(oracleId) || oracleId < 0) {
        return res.status(400).json({ error: 'missing oracleId (or name like oracle0)' });
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

// Issue a VC for an OCR outcome using Veramo via CAVS service.
app.post('/ocr/vc', bodyParser.json(), async (req, res) => {
    try {
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

        let resolvedSigners = [];
        const signerOracleIDsRaw = body.signerOracleIDs ?? body.signerOracleIds ?? body.signer_oracle_ids;
        if (Array.isArray(signerOracleIDsRaw) && signerOracleIDsRaw.length > 0) {
            void warmupOcrSignerIdentitiesForever();
            const ids = Array.from(
                new Set(
                    signerOracleIDsRaw
                        .map((x) => parseInt(String(x), 10))
                        .filter((x) => Number.isInteger(x) && x >= 0),
                ),
            ).sort((a, b) => a - b);
            if (ids.length === 0) return res.status(400).json({ error: 'no valid signerOracleIDs' });

            for (const id of ids) {
                resolvedSigners.push(await ensureOcrSignerIdentity(id));
            }
        } else if (Array.isArray(body.signers) && body.signers.length > 0) {
            // Backwards-compatible: accept explicit signer material (not recommended for OCR).
            const normalized = body.signers
                .map(normalizeSigner)
                .filter((s) => s.did && s.kid_bls && s.bls_pub);
            if (normalized.length === 0) return res.status(400).json({ error: 'no valid signers' });
            resolvedSigners = normalized.map((s) => ({
                did: s.did,
                kid_bls: s.kid_bls,
                kid_eth: s.kid_eth || '',
                bls_pub_key: s.bls_pub,
            }));
        } else {
            return res.status(400).json({ error: 'missing signers (use signerOracleIDs[])' });
        }

        const keys = resolvedSigners.map((s) => s.bls_pub_key);
        const aggResp = await axios.post(
            `${veramoAgentEndpoint}/bls/aggregate`,
            { keys },
            { timeout: 65000 },
        );
        const aggregatedKey = aggResp.data?.aggregatedKey;
        if (!aggregatedKey) return res.status(502).json({ error: 'missing aggregatedKey from veramo' });

        const issuerEntries = resolvedSigners.map((s) => ({ did: s.did, kid_bls: s.kid_bls }));
        const issuerDIDs = resolvedSigners.map((s) => s.did);
        const holder = holderDid.trim();

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

        const signResp = await axios.post(
            `${veramoAgentEndpoint}/mi-vc/sign`,
            { issuers: issuerEntries, payload },
            { timeout: 65000 },
        );
        const signatures = signResp.data?.signatures;
        if (!signatures) return res.status(502).json({ error: 'missing signatures from veramo' });

        const proofResp = await axios.post(
            `${veramoAgentEndpoint}/mi-vc/proofs`,
            { issuers: issuerEntries, holder_did: holder, payload },
            { timeout: 65000 },
        );
        const proofsOfOwnership = proofResp.data?.proofsOfOwnership;
        if (!proofsOfOwnership) return res.status(502).json({ error: 'missing proofsOfOwnership from veramo' });

        const finalResp = await axios.post(
            `${veramoAgentEndpoint}/mi-vc/finalize`,
            { payload, signatures, aggregatedKey, proofsOfOwnership, store: true },
            { timeout: 65000 },
        );
        const vc = finalResp.data?.vc;
        if (!vc) return res.status(502).json({ error: 'missing vc from veramo' });

        res.json({ vc });
    } catch (error) {
        console.error('Error in /ocr/vc', error?.response?.data || error?.message);
        res.status(502).json({ error: 'vc issuance failed', detail: error?.response?.data || error?.message });
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
        competence_modes: [ROBERTA_TO_NESTA_MODE_LABEL, GPT_COMPETENCE_MODE_LABEL],
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
    deepMerge(pipelineConfig, req.body || {});
    savePipelineConfig();
    res.json(pipelineConfig);
});

// OCR oracle-facing endpoint: returns only competence/confidence/reason.
app.post("/extract", bodyParser.json(), async (req, res) => {
    const text = req.body?.text || req.body?.document;
    const authorSkills = Array.isArray(req.body?.authorSkills) ? req.body.authorSkills : [];
    const competenceMode = req.body?.competenceMode;

    const result = await findCompetent(text, authorSkills, competenceMode);
    return res.status(result.status).json(result.body);
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
        const response = await axios.get(`${veramoAgentEndpoint}/create_did`, {
            timeout: 65000,
        });
        selectedDID = response.data.did;
        console.log("DID: " + response.data.did);
        res.status(200).send({"did":response.data.did});
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
                timeout: 65000,
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
                timeout: 65000,
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
            ...options,
        };

        const response = await axios.get(`${keywordExtractorServiceEndpoint}/keywords`, {
            timeout: 65000,
            params: {
                doc: document,
                top_n: robertaCfg.top_n,
                nr_candidates: robertaCfg.nr_candidates,
                ngram_max: robertaCfg.ngram_max,
                use_mmr: robertaCfg.use_mmr,
                diversity: robertaCfg.diversity,
                score_threshold: robertaCfg.score_threshold,
            }
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
                        timeout: 65000,
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
                        timeout: 65000,
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
                        timeout: 65000,
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
                        timeout: 65000,
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
        const response = await axios.get(`${ojdDapsSkillsEndpoint}/keyword_to_skills`, {
            timeout: 25000000,
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

const mapPhrasesToSkills = async (phrases) => {
    if (!Array.isArray(phrases) || phrases.length === 0) {
        return { status: 200, skills: [] };
    }

    try {
        const response = await axios.post(
            `${ojdDapsSkillsEndpoint}/map_phrases`,
            { phrases },
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

const extractSkillsForNestaCompetence = async (document) => {
    const skillMappingMode = resolveCompetenceSkillMappingMode(
        pipelineConfig.competence?.skill_mapping_mode ??
        pipelineConfig.skillMapping?.mode
    );

    if (skillMappingMode === "extract") {
        return extractSkillsFromText(document, pipelineConfig.skillMapping);
    }

    const keywordsResp = await extractRoBERTaKeywords(document, pipelineConfig.keywordExtraction?.roberta);
    if (keywordsResp.status !== 200) {
        return keywordsResp;
    }

    if (skillMappingMode === "keywords") {
        return extractSkills(keywordsResp.keywords, pipelineConfig.skillMapping);
    }

    if (skillMappingMode === "roberta_map") {
        return mapPhrasesToSkills(keywordsResp.keywords);
    }

    if (skillMappingMode === "extract_union_roberta_map") {
        const directSkillsResp = await extractSkillsFromText(document, pipelineConfig.skillMapping);
        if (directSkillsResp.status !== 200) {
            return directSkillsResp;
        }

        const mappedSkillsResp = await mapPhrasesToSkills(keywordsResp.keywords);
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

    return extractSkills(keywordsResp.keywords, pipelineConfig.skillMapping);
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
async function findCompetent(text, authorSkills = [], competenceModeInput = undefined) {
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
        return await gpt_skill_extraction_find_competent(text, authorSkills);
    }

    if (selectedSkillExtractorEngine === "OJD_DAPS") {
        return await nesta_skill_extraction_find_competent(text, authorSkills);
    }
    return { status: 500, body: { error: `Unsupported skill extractor engine ${selectedSkillExtractorEngine}` } };
}

// Compute competence/confidence/reason using GPT competence checker.
async function gpt_skill_extraction_find_competent(text, authorSkills = []) {
    const safeAuthorSkills = normalizeAuthorSkillsForCompetence(authorSkills);

    try {
        const response = await axios.post(
            `${gptCompetenceEndpoint}/extract`,
            {
                statement: text,
                skills: safeAuthorSkills,
                ...buildOpenAIOverridePayload(),
            },
            {
                timeout: 120000,
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
            : "No reason provided by GPT competence checker";

        return {
            status: 200,
            body: {
                competent,
                confidence,
                reason,
            },
        };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            return { status: 502, body: { error: 'GPT competence checker timed out' } };
        }

        if (err.response) {
            const detail = err.response.data?.detail || err.response.data?.error || err.response.data;
            return {
                status: err.response.status || 502,
                body: {
                    error: 'GPT competence checker request failed',
                    detail,
                },
            };
        }

        return {
            status: 500,
            body: {
                error: 'Unknown error in GPT competence checker request',
                detail: err.message,
            },
        };
    }
}

// Compute competence/confidence/reason using OJD-DAPS skill extraction.
async function nesta_skill_extraction_find_competent(text, authorSkills = []) {
    const skillsResp = await extractSkillsForNestaCompetence(text);
    if (skillsResp.status !== 200) {
        return { status: skillsResp.status, body: skillsResp };
    }

    const canonicalSkills = parseSkills(skillsResp.skills);
    const denom = canonicalSkills.length;
    const authorSet = buildAuthorSkillTokenSet(authorSkills);

    if (denom === 0) {
        return { status: 200, body: { competent: false, confidence: 1, reason: "Not competent: no skills extracted" } };
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
        const authorUris = resolveSkillTokensToUris(authorSkills, escoIndex.labelToUris);

        for (const [label, uri] of canonicalSkills) {
            const labelNorm = normalizeStr(label);
            const uriNorm = normalizeStr(uri);

            // Exact name/URI match remains a full match.
            if ((labelNorm && authorSet.has(labelNorm)) || (uriNorm && authorSet.has(uriNorm))) {
                weightedCoverage += 1;
                coveredSkills += 1;
                exactMatches += 1;
                continue;
            }

            // Resolve extracted skill to one or more ESCO URIs.
            const extractedUris = new Set();
            if (typeof uri === 'string' && uri.startsWith('http://data.europa.eu/esco/skill/')) {
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

    return { status: 200, body: { competent: comp.competent, confidence: comp.confidence, reason } };
}


app.post('/api/issuer_trust', bodyParser.json(), async (req, res) => {
    const { did, rank } = req.body;

    if(!did){
        res.status(500).send({ error: 'DID is missing' });

    }
    if(!rank || rank >5 || rank <0){
        res.status(500).send({ error: 'rank must be between 0 and 5' });
    }

    // Append the new object to the array
    trustedissuers.push({ did:did, rank:rank });

    // Save the updated array back to the JSON file
    const filePath = path.resolve('./trustedissuers.json');
    fs.writeFileSync(filePath, JSON.stringify(trustedissuers, null, 2));

    res.send("ok");
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
                timeout: 65000
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
            timeout: 65000
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
    app.listen(outPort, () => {
        console.log(`Server is running on port ${outPort}`);
    });
});
