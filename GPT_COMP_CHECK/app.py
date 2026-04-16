import json
import os
import re
import threading
from typing import List, Optional, Set, Tuple

from fastapi import FastAPI, HTTPException
from openai import APIConnectionError, APITimeoutError, OpenAI
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


class CompetenceRequest(BaseModel):
    statement: str = Field(..., description="Claim text")
    skills: List[str] = Field(default_factory=list, description="Skill strings from VC")
    model: Optional[str] = Field(default=None, description="Override model name")
    temperature: Optional[float] = Field(default=None, ge=0, le=1)
    api_key: Optional[str] = Field(default=None, description="Override API key")
    base_url: Optional[str] = Field(default=None, description="OpenAI-compatible base URL")


class CompetenceResponse(BaseModel):
    competent_skill_gpt: bool
    competent_confidence_skill_gpt: float
    competent_reason_skill_gpt: str
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
    return OpenAI(api_key=api_key, base_url=base_url, timeout=timeout_s)


def _render_prompt(req: CompetenceRequest) -> str:
    skills = ", ".join(req.skills) if req.skills else "None."
    return PROMPT_TEMPLATE.format(skills=skills, claim=req.statement)


def _call_model(req: CompetenceRequest) -> dict:
    client = _build_client(req)
    model = req.model or os.getenv("OPENAI_COMPETENCE_MODEL") or os.getenv("OPENAI_MODEL", "gpt-4.1")
    if req.temperature is not None:
        temperature = req.temperature
    else:
        temperature = float(os.getenv("OPENAI_COMPETENCE_TEMPERATURE") or os.getenv("OPENAI_TEMPERATURE", "0"))
    prompt = _render_prompt(req)
    try:
        resp = client.chat.completions.create(
            model=model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": "You output strict JSON only."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
        )
        content = resp.choices[0].message.content if resp.choices else "{}"
    except (APIConnectionError, APITimeoutError) as exc:
        raise HTTPException(status_code=503, detail=f"OpenAI connection error: {exc}") from exc

    try:
        return json.loads(content or "{}")
    except Exception:
        raise HTTPException(status_code=502, detail="Failed to parse model JSON")


def _normalize_result(raw: dict) -> CompetenceResponse:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=502, detail="Model returned non-object")
    competent = bool(raw.get("competent"))
    confidence = float(raw.get("confidence") or 0.0)
    reason = str(raw.get("reason") or "").strip()
    return CompetenceResponse(
        competent_skill_gpt=competent,
        competent_confidence_skill_gpt=confidence,
        competent_reason_skill_gpt=reason or "No reason returned by model.",
        raw=raw,
    )


app = FastAPI(title="GPT Competence Checker", version="0.1.0")


@app.get("/healthz")
def health():
    return {"ok": True}


@app.post("/competence", response_model=CompetenceResponse)
@app.post("/extract", response_model=CompetenceResponse)
def competence(req: CompetenceRequest):
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
