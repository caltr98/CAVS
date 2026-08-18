import json
import os
import re
import hashlib
import threading
from typing import List, Optional, Set, Tuple

from fastapi import FastAPI, HTTPException, Request
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI, OpenAIError, RateLimitError
from pydantic import BaseModel, Field


PROMPT_TEMPLATE = """\
Decide whether the author's listed skills suggest they are competent to make or assess the claim below.

Return ONLY valid JSON with this exact schema:
{{
  "competent": <true|false>,
  "confidence": <0-1>,
  "reason": "<one sentence>"
}}

Rules:
- Use ONLY the skills + claim text below (no external knowledge).
- If the skills list is empty/missing (or only placeholders like “None.”), set competent=false with confidence <=0.2 and reason “No skills available for this author.”
- Identify the primary domain of the claim (health/medicine, economics/finance/budget/tax, environment/energy/climate, science/tech/engineering, immigration eligibility/specifics, law/policy/government process, elections/campaigning, crime/justice, etc.) and judge competence against that domain only.
- Require clear subject-matter alignment: if the claim is technical/specialized and skills lack matching domain skills, respond competent=false with confidence <=0.4 and explicitly note the missing domain.
- Political/government/public-policy/legislative skills DO count as aligned when the claim is about politics, government process, elections/campaigns, or legislation/budget procedures. For economics/finance/labor/budget claims, treat public policy + budgeting/finance/labor/econ-related skills as a moderate partial match (competent=true allowed with confidence 0.4–0.7) even if they are not technical trade skills. They do NOT qualify someone for strictly technical domains (energy/climate/environment, medical/health/epidemiology, engineering/technology, science, immigration eligibility specifics).
- Do NOT treat generic media/social-media presence (e.g., “Facebook posts”, “viral image”, “blogger”) as skills; treat that as missing skills.
- If skills partially match the domain (e.g., broad “biology” for a medical claim, “economics” for a specific tax policy claim), you may set competent=true with moderate confidence (0.4–0.7) only if the partial fit is credible; otherwise keep competent=false and explain the gap.
- If the skills list DOES include clear domain matches for the main topic, set competent=true and reflect the strength of that evidence in confidence.
- Focus on the core domain of the claim; ignore secondary/contextual tags (e.g., “religion” alongside “coronavirus” should still be judged by the health domain if health skills are present).
- If skills are clearly in a different domain than the claim, set competent=false with low confidence and explain the gap.
- Reasons should be concise and cite whether domain skills are present or missing; do not reference external knowledge.

Author skills:
{skills}

CLAIM / STATEMENT (may include context):
{claim}
"""

ESCO_SKILL_URI_RE = re.compile(r"http://data\.europa\.eu/esco/skill/[A-Za-z0-9-]+")
SKILL_PAIR_RE = re.compile(
    r"^\s*\(\s*(?P<label>.*?)\s*,\s*(?P<uri>http://data\.europa\.eu/esco/skill/[A-Za-z0-9-]+)\s*\)\s*$"
)
ESCO_ONTOLOGY_PATH_DEFAULT = "/app/esco-v1.2.1.jsonl"
_esco_uri_index_lock = threading.Lock()
_esco_skill_uri_index: Optional[Set[str]] = None
_response_cache_lock = threading.Lock()
_response_cache: dict[str, "CompetenceResponse"] = {}
_response_inflight: dict[str, dict] = {}


class CompetenceRequest(BaseModel):
    statement: str = Field(..., description="Claim text")
    skills: List[str] = Field(default_factory=list, description="Skill strings from VC")
    request_id: Optional[str] = Field(default=None, description="OCR request id used to scope cache entries")
    model: Optional[str] = Field(default=None, description="Override model name")
    temperature: Optional[float] = Field(default=None, ge=0, le=1)
    api_key: Optional[str] = Field(default=None, description="Override API key")
    base_url: Optional[str] = Field(default=None, description="OpenAI-compatible base URL")


class CompetenceResponse(BaseModel):
    competent_skill_gpt: bool
    competent_confidence_skill_gpt: float
    competent_reason_skill_gpt: str
    competence_backend: str
    competence_model: str
    raw: dict


def _read_api_key_from_file(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
            return key or None
    except OSError:
        return None


def _load_esco_skill_uri_index(ontology_path: str) -> Set[str]:
    uris: Set[str] = set()
    try:
        with open(ontology_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                for uri in ESCO_SKILL_URI_RE.findall(line):
                    uris.add(uri)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unable to load ESCO ontology file: {ontology_path} ({exc})",
        )

    if not uris:
        raise HTTPException(
            status_code=500,
            detail=f"ESCO ontology file does not contain any skill URIs: {ontology_path}",
        )
    return uris


def _get_esco_skill_uri_index() -> Set[str]:
    global _esco_skill_uri_index
    if _esco_skill_uri_index is not None:
        return _esco_skill_uri_index
    with _esco_uri_index_lock:
        if _esco_skill_uri_index is None:
            ontology_path = os.getenv("ESCO_ONTOLOGY_PATH", ESCO_ONTOLOGY_PATH_DEFAULT)
            _esco_skill_uri_index = _load_esco_skill_uri_index(ontology_path)
    return _esco_skill_uri_index


def _request_body_for_cache(req: BaseModel) -> dict:
    if hasattr(req, "model_dump"):
        return req.model_dump(mode="json")
    return req.dict()


def _copy_response(resp: "CompetenceResponse") -> "CompetenceResponse":
    if hasattr(resp, "model_copy"):
        return resp.model_copy(deep=True)
    return resp.copy(deep=True)


def _cache_key(endpoint: str, query: tuple, req: BaseModel) -> str:
    payload = {
        "method": "POST",
        "endpoint": endpoint,
        "query": list(query),
        "body": _request_body_for_cache(req),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _cached_competence(endpoint: str, query: tuple, req: "CompetenceRequest", compute) -> "CompetenceResponse":
    key = _cache_key(endpoint, query, req)
    while True:
        with _response_cache_lock:
            cached = _response_cache.get(key)
            if cached is not None:
                return _copy_response(cached)
            entry = _response_inflight.get(key)
            if entry is None:
                entry = {"event": threading.Event(), "result": None, "error": None}
                _response_inflight[key] = entry
                break
        entry["event"].wait()
        if entry.get("error") is not None:
            raise entry["error"]
        result = entry.get("result")
        if result is not None:
            return _copy_response(result)

    try:
        result = compute()
        entry["result"] = _copy_response(result)
        with _response_cache_lock:
            _response_cache[key] = _copy_response(result)
        return result
    except Exception as exc:
        entry["error"] = exc
        raise
    finally:
        with _response_cache_lock:
            _response_inflight.pop(key, None)
            entry["event"].set()


def _cleanup_label(value: str) -> str:
    label = (value or "").strip()
    label = re.sub(r"^[\(\[\{\"'\s,;:|]+", "", label)
    label = re.sub(r"[\)\]\}\"'\s,;:|]+$", "", label)
    return label.strip()


def _parse_skill_label_uri(raw_skill: str) -> Tuple[Optional[str], Optional[str]]:
    s = (raw_skill or "").strip()
    if not s:
        return None, None

    pair_match = SKILL_PAIR_RE.match(s)
    if pair_match:
        label = _cleanup_label(pair_match.group("label"))
        uri = pair_match.group("uri")
        if label and uri:
            return label, uri
        return None, None

    uri_match = ESCO_SKILL_URI_RE.search(s)
    if not uri_match:
        return None, None

    uri = uri_match.group(0)
    before = s[: uri_match.start()].strip()
    after = s[uri_match.end() :].strip()
    label = _cleanup_label(before or after)
    if not label:
        return None, None
    return label, uri


def _validated_skill_labels(skills: List[str]) -> Tuple[List[str], int]:
    esco_uri_index = _get_esco_skill_uri_index()
    valid_labels: List[str] = []
    seen_uris: Set[str] = set()
    invalid_count = 0

    for raw_skill in skills or []:
        if not isinstance(raw_skill, str):
            invalid_count += 1
            continue
        label, uri = _parse_skill_label_uri(raw_skill)
        if not label or not uri:
            invalid_count += 1
            continue
        if uri in esco_uri_index:
            if uri in seen_uris:
                continue
            seen_uris.add(uri)
            valid_labels.append(label)
        else:
            invalid_count += 1
    return valid_labels, invalid_count


def _safe_float_env(name: str, default_value: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default_value
    try:
        return float(raw)
    except ValueError:
        return default_value


def _safe_int_env(name: str, default_value: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default_value
    try:
        return int(raw)
    except ValueError:
        return default_value


def _build_client(req: CompetenceRequest) -> OpenAI:
    key_file = os.getenv("OPENAI_API_KEY_FILE")
    api_key = (
        req.api_key
        or os.getenv("OPENAI_COMPETENCE_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or _read_api_key_from_file(key_file)
    )
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="Missing OPENAI_COMPETENCE_API_KEY/OPENAI_API_KEY (or OPENAI_API_KEY_FILE)",
        )

    base_url = (
        req.base_url
        or os.getenv("OPENAI_COMPETENCE_BASE_URL")
        or os.getenv("OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    )
    timeout_s = max(5.0, _safe_float_env("OPENAI_TIMEOUT_S", 60.0))
    # Keep retries inside this service so that a transient provider response is
    # measured as latency instead of being converted into an oracle vote.  The
    # enclosing CAVS request timeout remains the hard campaign-level bound.
    max_retries = max(0, _safe_int_env("OPENAI_MAX_RETRIES", 2))
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout_s,
        max_retries=max_retries,
    )


def _render_prompt(req: CompetenceRequest) -> str:
    skills = ", ".join(req.skills) if req.skills else "None."
    return PROMPT_TEMPLATE.format(skills=skills, claim=req.statement)


def _is_provider_content_filter_error(exc: Exception) -> bool:
    """Recognize explicit provider safety-filter rejections only.

    Do not turn authentication, quota, transport, timeout, or arbitrary HTTP
    failures into competence decisions. Azure Foundry currently exposes this
    condition as HTTP 400 with ``finish_reason=content_filter`` and/or an
    error code named ``content_filter``.
    """
    text = str(getattr(exc, "message", "") or exc).lower()
    return any(
        marker in text
        for marker in (
            "content_filter",
            "content filter",
            "content blocked by label",
        )
    )


def _call_model(req: CompetenceRequest) -> dict:
    client = _build_client(req)
    model = req.model or os.getenv("OPENAI_COMPETENCE_MODEL") or os.getenv("OPENAI_MODEL", "gpt-4.1")
    if req.temperature is not None:
        temperature = req.temperature
    else:
        temperature = float(os.getenv("OPENAI_COMPETENCE_TEMPERATURE") or os.getenv("OPENAI_TEMPERATURE", "0"))
    prompt = _render_prompt(req)
    request_kwargs = {
        "model": model,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": "You output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
    }
    try:
        try:
            resp = client.chat.completions.create(**request_kwargs)
        except APIStatusError as exc:
            # Foundry's OpenAI-compatible endpoint hosts several publishers.
            # A few deployments reject one of these optional OpenAI knobs even
            # though they support chat completions. Retry only the rejected
            # optional fields; the prompt and model remain exactly unchanged.
            message = str(exc.message or "").lower()
            retry_kwargs = dict(request_kwargs)
            changed = False
            if "temperature" in message and any(word in message for word in ("unsupported", "not support", "invalid")):
                retry_kwargs.pop("temperature", None)
                changed = True
            if any(word in message for word in ("response_format", "json_object")) and any(
                word in message for word in ("unsupported", "not support", "invalid")
            ):
                retry_kwargs.pop("response_format", None)
                changed = True
            if not changed:
                raise
            resp = client.chat.completions.create(**retry_kwargs)
        content = resp.choices[0].message.content if resp.choices else "{}"
    except (APIConnectionError, APITimeoutError, RateLimitError) as exc:
        raise HTTPException(status_code=503, detail=f"OpenAI connection error: {exc}") from exc
    except APIStatusError as exc:
        if _is_provider_content_filter_error(exc):
            return {
                "competent": False,
                "confidence": 0.0,
                "reason": "cannot process",
                "provider_finish_reason": "content_filter",
            }
        # Preserve the upstream class without leaking credentials or a traceback.
        status = 503 if exc.status_code in (408, 409, 429) or exc.status_code >= 500 else 502
        raise HTTPException(status_code=status, detail=f"OpenAI API HTTP {exc.status_code}: {exc.message}") from exc
    except OpenAIError as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI API error: {exc}") from exc

    try:
        return json.loads(content or "{}")
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to parse model JSON")


def _normalize_result(raw: dict) -> CompetenceResponse:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=502, detail="Model returned non-object")
    competent_raw = raw.get("competent")
    competent = competent_raw if isinstance(competent_raw, bool) else str(competent_raw).strip().lower() in {"true", "1", "yes"}
    try:
        confidence = float(raw.get("confidence") or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    reason = str(raw.get("reason") or "").strip()
    return CompetenceResponse(
        competent_skill_gpt=competent,
        competent_confidence_skill_gpt=confidence,
        competent_reason_skill_gpt=reason or "No reason returned by model.",
        competence_backend=os.getenv("COMPETENCE_BACKEND", "gpt").strip() or "gpt",
        competence_model=(
            os.getenv("COMPETENCE_MODEL_ID")
            or os.getenv("OPENAI_COMPETENCE_MODEL")
            or os.getenv("OPENAI_MODEL")
            or "gpt-4.1"
        ).strip(),
        raw=raw,
    )


app = FastAPI(title=os.getenv("COMPETENCE_SERVICE_TITLE", "GPT Competence Checker"), version="0.2.0")


@app.get("/healthz")
def health():
    return {"ok": True}


@app.post("/competence", response_model=CompetenceResponse)
@app.post("/extract", response_model=CompetenceResponse)
def competence(req: CompetenceRequest, request: Request):
    query = tuple(sorted(request.query_params.multi_items()))
    return _cached_competence(request.url.path, query, req, lambda: _competence_uncached(req))


def _competence_uncached(req: CompetenceRequest):
    valid_skill_labels, invalid_skill_count = _validated_skill_labels(req.skills)
    if not valid_skill_labels:
        raw = {
            "competent": False,
            "confidence": 0.1,
            "reason": "No valid ESCO (label, uri) skills available for this author.",
            "invalid_skill_count": invalid_skill_count,
        }
        return _normalize_result(raw)

    checked_req = req.copy(update={"skills": valid_skill_labels})
    raw = _call_model(checked_req)
    return _normalize_result(raw)
