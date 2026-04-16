const DEFAULTS = {
  autoAnalyze: false,
  maxAutoAnalysesPerMinute: 10
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normWs(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pickTextFrom(el, selector) {
  const node = el.querySelector(selector);
  if (!node) return "";
  return normWs(node.textContent || "");
}

function extractPostText(postEl) {
  const title =
    pickTextFrom(postEl, "h1") ||
    pickTextFrom(postEl, "h2") ||
    pickTextFrom(postEl, "h3") ||
    "";

  const bodyCandidates = [
    '[data-testid="post-content"]',
    '[data-click-id="text"]',
    "div.md",
    "div[data-adclicklocation]",
    "p"
  ];
  let body = "";
  for (const sel of bodyCandidates) {
    body = pickTextFrom(postEl, sel);
    if (body) break;
  }

  const text = normWs([title, body].filter(Boolean).join("\n\n"));
  return { title, body, text };
}

function findPostPermalink(postEl) {
  const a =
    postEl.querySelector('a[data-click-id="comments"]') ||
    postEl.querySelector('a[href*="/comments/"]') ||
    null;
  const href = a?.getAttribute("href") || "";
  if (!href) return "";
  try {
    return new URL(href, location.origin).toString();
  } catch {
    return href;
  }
}

function getPostElements() {
  const out = new Set();
  document.querySelectorAll("shreddit-post").forEach((x) => out.add(x));
  document.querySelectorAll('div[data-testid="post-container"]').forEach((x) => out.add(x));
  document.querySelectorAll("article").forEach((x) => {
    if (x.querySelector('a[href*="/comments/"]')) out.add(x);
  });
  return [...out];
}

function formatResult(result) {
  if (!result || typeof result !== "object") return "No result";
  if (result.kind === "oracle") {
    const status = result.raw?.status;
    const skills = result.raw?.result?.skills || [];
    const trust = result.raw?.result?.trust;
    const top = skills
      .slice(0, 3)
      .map((s) => `${s.label || s.uri} (${s.scoreBps})`)
      .join("\n");
    const trustLine = trust?.trusted ? `trusted=${trust.trusted.filter(Boolean).length}/${trust.trusted.length}` : "";
    return [`oracle: ${status}`, `skills=${skills.length}`, trustLine, top].filter(Boolean).join("\n");
  }
  if (result.kind === "cavs") {
    const skills = result.raw?.skills || [];
    const top = skills
      .slice(0, 3)
      .map((s) => s?.esco?.label || s?.label || s?.name || "")
      .filter(Boolean);
    return [`cavs: skills=${skills.length}`, top.join("\n")].filter(Boolean).join("\n");
  }
  return "Unknown result";
}

function createBadge() {
  const badge = document.createElement("div");
  badge.className = "cavs-rdx-badge";
  badge.dataset.state = "idle";
  badge.textContent = "CAVS: Analyze";

  const details = document.createElement("div");
  details.className = "cavs-rdx-details";
  details.hidden = true;
  badge.appendChild(details);

  badge.addEventListener("click", () => {
    details.hidden = !details.hidden;
  });

  return { badge, details };
}

async function analyzeAndRender(postEl, ui, opts) {
  const { text } = extractPostText(postEl);
  if (!text) {
    ui.badge.dataset.state = "error";
    ui.badge.firstChild.textContent = "CAVS: no text";
    return;
  }

  const permalink = findPostPermalink(postEl);
  const keyMaterial = `${location.hostname}|${permalink}|${text}`;
  const cacheKey = await sha256Hex(keyMaterial);

  ui.badge.dataset.state = "loading";
  ui.badge.firstChild.textContent = "CAVS: analyzing…";

  const resp = await chrome.runtime.sendMessage({ type: "CAVS_ANALYZE", text, cacheKey });
  if (!resp?.ok) {
    ui.badge.dataset.state = "error";
    ui.badge.firstChild.textContent = "CAVS: error";
    ui.details.textContent = resp?.error || "Unknown error";
    ui.details.hidden = false;
    return;
  }

  ui.badge.dataset.state = "ok";
  ui.badge.firstChild.textContent = resp.cached ? "CAVS: ok (cached)" : "CAVS: ok";
  ui.details.textContent = formatResult(resp.result);
  if (opts.autoAnalyze) ui.details.hidden = true;
}

function markAnchor(postEl) {
  if (postEl.classList.contains("cavs-rdx-anchor")) return false;
  postEl.classList.add("cavs-rdx-anchor");
  return true;
}

async function getLocalOptions() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

const autoBucket = { windowStartMs: 0, count: 0 };

async function scheduleAutoAnalyze(postEl, ui, opts) {
  const now = Date.now();
  if (now - autoBucket.windowStartMs > 60_000) {
    autoBucket.windowStartMs = now;
    autoBucket.count = 0;
  }
  if (autoBucket.count >= opts.maxAutoAnalysesPerMinute) {
    ui.badge.dataset.state = "idle";
    ui.badge.firstChild.textContent = "CAVS: rate limited (dblclick)";
    return;
  }
  autoBucket.count++;
  await sleep(100);
  analyzeAndRender(postEl, ui, opts);
}

function attachOnce(postEl, opts) {
  if (!markAnchor(postEl)) return;
  const ui = createBadge();
  postEl.appendChild(ui.badge);

  ui.badge.addEventListener(
    "dblclick",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      analyzeAndRender(postEl, ui, opts);
    },
    true
  );

  if (opts.autoAnalyze) scheduleAutoAnalyze(postEl, ui, opts);
}

async function scanAndAttach() {
  const opts = await getLocalOptions();
  for (const p of getPostElements()) attachOnce(p, opts);
}

const observer = new MutationObserver(() => {
  scanAndAttach();
});

scanAndAttach();
observer.observe(document.documentElement, { childList: true, subtree: true });

