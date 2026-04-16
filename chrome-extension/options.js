const DEFAULTS = {
  cavsBaseUrl: "http://127.0.0.1:4200",
  cavsMode: "cavs",
  cavsSkillMappingMode: "extract",
  oracleQueueBaseUrl: "http://127.0.0.1:20000",
  oraclePollIntervalMs: 1000,
  oracleMaxWaitMs: 120000,
  autoAnalyze: false,
  maxAutoAnalysesPerMinute: 10
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  $("status").textContent = msg;
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  $("cavsMode").value = stored.cavsMode;
  $("cavsBaseUrl").value = stored.cavsBaseUrl;
  $("cavsSkillMappingMode").value = stored.cavsSkillMappingMode;
  $("oracleQueueBaseUrl").value = stored.oracleQueueBaseUrl;
  $("oraclePollIntervalMs").value = stored.oraclePollIntervalMs;
  $("oracleMaxWaitMs").value = stored.oracleMaxWaitMs;
  $("autoAnalyze").value = String(Boolean(stored.autoAnalyze));
}

async function save() {
  const v = {
    cavsMode: $("cavsMode").value,
    cavsBaseUrl: $("cavsBaseUrl").value.trim(),
    cavsSkillMappingMode: $("cavsSkillMappingMode").value,
    oracleQueueBaseUrl: $("oracleQueueBaseUrl").value.trim(),
    oraclePollIntervalMs: Number($("oraclePollIntervalMs").value),
    oracleMaxWaitMs: Number($("oracleMaxWaitMs").value),
    autoAnalyze: $("autoAnalyze").value === "true"
  };
  await chrome.storage.sync.set(v);
  setStatus("Saved.");
}

async function reset() {
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  setStatus("Reset to defaults.");
}

document.addEventListener("DOMContentLoaded", () => {
  load().catch((e) => setStatus(`Load error: ${e?.message || e}`));
  $("save").addEventListener("click", () => save().catch((e) => setStatus(`Save error: ${e?.message || e}`)));
  $("reset").addEventListener("click", () => reset().catch((e) => setStatus(`Reset error: ${e?.message || e}`)));
});

