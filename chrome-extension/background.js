const DEFAULTS = {
  cavsBaseUrl: "http://127.0.0.1:4200",
  cavsMode: "cavs", // "cavs" | "oracle"
  cavsSkillMappingMode: "extract", // passed to /api/extract options.skillMapping.mode
  oracleQueueBaseUrl: "http://127.0.0.1:20000",
  oraclePollIntervalMs: 1000,
  oracleMaxWaitMs: 120000,
  cacheTtlMs: 6 * 60 * 60 * 1000 // 6 hours
};

function nowMs() {
  return Date.now();
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function cacheGet(key) {
  const { cache = {} } = await chrome.storage.local.get({ cache: {} });
  const entry = cache[key];
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.expiresAtMs !== "number" || entry.expiresAtMs <= nowMs()) return null;
  return entry.value ?? null;
}

async function cacheSet(key, value, ttlMs) {
  const { cache = {} } = await chrome.storage.local.get({ cache: {} });
  cache[key] = { expiresAtMs: nowMs() + ttlMs, value };
  await chrome.storage.local.set({ cache });
}

function toUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  return `${b}${p.startsWith("/") ? "" : "/"}${p}`;
}

async function cavsAnalyze(documentText, settings) {
  const url = toUrl(settings.cavsBaseUrl, "/api/extract");
  const body = {
    document: documentText,
    options: {
      skillMapping: { mode: settings.cavsSkillMappingMode }
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = (json && (json.error || json.message)) || `CAVS HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return { kind: "cavs", raw: json };
}

async function oracleSubmit(statementText, settings) {
  const url = toUrl(settings.oracleQueueBaseUrl, "/requests");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ statement: statementText })
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.requestId) {
    throw new Error(`Oracle queue submit failed (HTTP ${resp.status})`);
  }
  return String(json.requestId);
}

async function oraclePoll(requestId, settings) {
  const url = toUrl(settings.oracleQueueBaseUrl, `/requests/${encodeURIComponent(requestId)}`);
  const deadline = nowMs() + settings.oracleMaxWaitMs;
  while (nowMs() < deadline) {
    const resp = await fetch(url, { method: "GET" });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(`Oracle queue poll failed (HTTP ${resp.status})`);
    if (json?.status === "done") return { kind: "oracle", raw: json, requestId: String(requestId) };
    await new Promise((r) => setTimeout(r, settings.oraclePollIntervalMs));
  }
  throw new Error("Oracle consensus timed out");
}

async function oracleAnalyze(statementText, settings) {
  const requestId = await oracleSubmit(statementText, settings);
  return oraclePoll(requestId, settings);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || msg.type !== "CAVS_ANALYZE") return;
    const settings = await getSettings();
    const inputText = String(msg.text || "").trim();
    const cacheKey = String(msg.cacheKey || "");
    if (!inputText) throw new Error("Missing text");
    if (!cacheKey) throw new Error("Missing cacheKey");

    const cached = await cacheGet(cacheKey);
    if (cached) {
      sendResponse({ ok: true, cached: true, result: cached });
      return;
    }

    const result =
      settings.cavsMode === "oracle"
        ? await oracleAnalyze(inputText, settings)
        : await cavsAnalyze(inputText, settings);

    await cacheSet(cacheKey, result, settings.cacheTtlMs);
    sendResponse({ ok: true, cached: false, result });
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });
  return true;
});

