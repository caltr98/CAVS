#!/usr/bin/env python3
"""
GPT-based competence labeling that uses ESCO skills instead of bios.

For each (author, article) pair, asks the model whether the author's listed
skills (bio-derived + occupation-derived) suggest they are competent to make
or assess the claim.

Output format is minimal per author:
- name, surname, liar2_author_key
- articles: title, liar2_statement, news-status, competent_skills_gpt, competent_confidence_skills_gpt, competent_reason_skills_gpt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from openai import AzureOpenAI, RateLimitError
from tqdm import tqdm


def locate_repo_root() -> str:
    here = os.path.abspath(__file__)
    current = os.path.dirname(here)
    while True:
        if os.path.isdir(os.path.join(current, "Validation")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            raise RuntimeError("Could not locate repository root from gpt_competence_classifier_from_skills.py.")
        current = parent


REPO_ROOT = locate_repo_root()

# Azure OpenAI defaults for the GPT endpoint and key.
# Using the full chat completions endpoint as requested.
AZURE_ENDPOINT_DEFAULT = "https://calog-mldz9rbt-swedencentral.cognitiveservices.azure.com/openai/deployments/gpt-4.1-mini-2/chat/completions?api-version=2025-01-01-preview"
AZURE_API_VERSION_DEFAULT = "2025-01-01-preview"
AZURE_API_KEY_DEFAULT = ""
OPENAI_API_KEY_FILE_DEFAULT = os.path.join(REPO_ROOT, "GPT_COMP_CHECK", "openai_api_key.txt")

MODEL_DEFAULT = "gpt-4.1-mini"
TEMPERATURE_DEFAULT = 0

STATE_NAMES = {
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "new hampshire",
    "new jersey",
    "new mexico",
    "new york",
    "north carolina",
    "north dakota",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "rhode island",
    "south carolina",
    "south dakota",
    "tennessee",
    "texas",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "west virginia",
    "wisconsin",
    "wyoming",
}
DEMONYMS = {"americans", "texans", "floridians", "ohioans", "arizonans", "oregonians", "wisconsinites", "illinoisans"}
STATE_ORG_HINT_TOKENS = {
    "party",
    "project",
    "initiative",
    "news",
    "report",
    "voice",
    "department",
    "association",
    "coalition",
    "council",
    "committee",
    "fund",
    "funds",
    "pac",
    "future",
    "progress",
    "right",
    "life",
    "owners",
    "network",
    "action",
    "justice",
    "jobs",
    "job",
    "tax",
    "taxes",
    "policy",
    "partnership",
    "alliance",
    "bureau",
    "office",
    "state",
    "senate",
    "senator",
    "house",
    "legislators",
    "assembly",
    "candidates",
    "manufacturers",
    "commerce",
    "lottery",
    "bank",
    "union",
    "federation",
    "institute",
    "foundation",
    "college",
    "university",
    "school",
    "students",
    "teachers",
    "sheriff",
    "board",
    "voters",
    "residents",
    "citizens",
    "for",
    "against",
    "gun",
    "rights",
    "industries",
    "fact",
    "check",
    "better",
    "ideas",
    "opportunity",
    "one",
    "our",
    "think",
    "onward",
    "stop",
    "forward",
    "integrity",
    "family",
    "families",
    "growth",
    "development",
}
NON_PERSON_TOKENS = {
    "association",
    "associations",
    "alliance",
    "committee",
    "party",
    "pac",
    "fund",
    "foundation",
    "council",
    "institute",
    "union",
    "coalition",
    "league",
    "department",
    "ministry",
    "office",
    "agency",
    "bureau",
    "authority",
    "university",
    "college",
    "school",
    "district",
    "campaign",
    "project",
    "initiative",
    "center",
    "centre",
    "hospital",
    "network",
    "news",
    "press",
    "tribune",
    "gazette",
    "times",
    "daily",
    "voice",
    "report",
    "pundit",
    "feed",
    "tv",
    "radio",
    "television",
    "company",
    "co",
    "inc",
    "post",
    "posts",
    "video",
    "videos",
    "tiktok",
    "instagram",
    "facebook",
    "twitter",
    "youtube",
    "corp",
    "corporation",
    "llc",
    "ltd",
    "group",
    "chapter",
    "caucus",
    "bank",
    "federation",
    "conference",
}
NON_PERSON_PHRASES = [
    " for ",
    "americans for",
    "americans against",
    "people for",
    "campaign for",
    "campaign to",
    "friends of",
    "committee to",
    "on behalf of",
]
DOMAIN_RE = re.compile(r"(?:https?://)?[a-z0-9.-]+\\.(?:com|net|org|info|biz|tv|press|news|co|us|io|me|ca|uk|edu|gov)(?:/|$)")
SINGLE_TOKEN_NON_PERSON = {
    "aarp",
    "americanpoliticnews",
    "bloggers",
    "breitbart",
    "buzzfeed",
    "freedomworks",
    "future45",
    "infowars",
    "msnbc",
    "nowthis",
    "tiktok",
    "reaganwasright",
}
SINGLE_TOKEN_ALLOW = {"lizzo"}
NON_PERSON_EXPLICIT = {
    "tiktok posts",
    "tiktok",
    "american commitment",
    "john birch society",
    "federal transit administration",
    "texans for economic development",
    "texans are",
    "themiamigazette.com",
    "theseattletribune.com",
    "the associated press",
    "the gateway pundit",
    "the other 98%",
}

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
- If BOTH skill lists are empty/missing (or only placeholders like “None.”), set competent=false with confidence <=0.2 and reason “No skills available for this author.”
- Identify the primary domain of the claim (health/medicine, economics/finance/budget/tax, environment/energy/climate, science/tech/engineering, immigration eligibility/specifics, law/policy/government process, elections/campaigning, crime/justice, etc.) and judge competence against that domain only.
- Require clear subject-matter alignment: if the claim is technical/specialized and skills lack matching domain skills, respond competent=false with confidence <=0.4 and explicitly note the missing domain.
- Political/government/public-policy/legislative skills DO count as aligned when the claim is about politics, government process, elections/campaigns, or legislation/budget procedures. For economics/finance/labor/budget claims, treat public policy + budgeting/finance/labor/econ-related skills as a moderate partial match (competent=true allowed with confidence 0.4–0.7) even if they are not technical trade skills. They do NOT qualify someone for strictly technical domains (energy/climate/environment, medical/health/epidemiology, engineering/technology, science, immigration eligibility specifics).
- Do NOT treat generic media/social-media presence (e.g., “Facebook posts”, “viral image”, “blogger”) as skills; treat that as missing skills.
- If skills partially match the domain (e.g., broad “biology” for a medical claim, “economics” for a specific tax policy claim), you may set competent=true with moderate confidence (0.4–0.7) only if the partial fit is credible; otherwise keep competent=false and explain the gap.
- If the skills list DOES include clear domain matches for the main topic, set competent=true and reflect the strength of that evidence in confidence.
- Focus on the core domain of the claim; ignore secondary/contextual tags (e.g., “religion” alongside “coronavirus” should still be judged by the health domain if health skills are present).
- If skills are clearly in a different domain than the claim, set competent=false with low confidence and explain the gap.
- Reasons should be concise and cite whether domain skills are present or missing; do not reference external knowledge.

Author skills (bio-derived):
{bio_skills}

Author skills (occupation-derived):
{occ_skills}

CLAIM / STATEMENT (may include context):
{claim}
"""


def _is_non_person_author(author: str) -> bool:
    low = (author or "").lower().strip()
    if not low:
        return False
    if low in NON_PERSON_EXPLICIT:
        return True
    if low.startswith("the ") or low.startswith("@"):
        return True
    if DOMAIN_RE.search(low):
        return True
    if any(ch.isdigit() for ch in low) or "%" in low:
        return True
    if "http://" in low or "https://" in low:
        return True

    tokens = re.findall(r"[a-zA-Z']+", low)
    token_set = set(tokens)
    if any(t in NON_PERSON_TOKENS for t in token_set):
        return True
    if any(t in DEMONYMS for t in token_set):
        return True
    state_tokens = [t for t in tokens if t in STATE_NAMES]
    if state_tokens:
        if len(tokens) == 1:
            return True
        if any(t in STATE_ORG_HINT_TOKENS for t in token_set):
            return True
    if any(phrase in low for phrase in NON_PERSON_PHRASES):
        return True
    if len(tokens) == 1:
        tok = token_set.pop() if token_set else ""
        if tok in SINGLE_TOKEN_NON_PERSON:
            return True
        return tok not in SINGLE_TOKEN_ALLOW
    if not any(len(w) >= 2 for w in tokens):
        return True
    return False

def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split()).strip()


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _read_api_key_from_file(path: str) -> Optional[str]:
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
            return key or None
    except OSError:
        return None


def _resolve_api_key() -> Optional[str]:
    env_key = os.getenv("AZURE_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if env_key:
        return env_key

    key_file = (
        os.getenv("AZURE_OPENAI_API_KEY_FILE")
        or os.getenv("OPENAI_API_KEY_FILE")
        or OPENAI_API_KEY_FILE_DEFAULT
    )
    file_key = _read_api_key_from_file(key_file)
    if file_key:
        return file_key

    return AZURE_API_KEY_DEFAULT


def _atomic_write_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def _derive_label_from_counts(art: Dict[str, Any]) -> Optional[int]:
    """
    Pick a liar2_label using weighted liar2_*_counts; higher truthiness gets higher weight.
    Returns None if no counts are present.
    """
    label_fields = [
        (5, "liar2_true_counts"),
        (4, "liar2_mostly_true_counts"),
        (3, "liar2_half_true_counts"),
        (2, "liar2_mostly_false_counts"),
        (1, "liar2_false_counts"),
        (0, "liar2_pants_on_fire_counts"),
    ]
    best_label: Optional[int] = None
    best_score = -1
    has_any = False
    for label_value, field in label_fields:
        try:
            count = int(art.get(field) or 0)
        except (TypeError, ValueError):
            count = 0
        if count:
            has_any = True
        score = count * label_value
        # Break ties toward the higher label_value.
        if score > best_score or (score == best_score and best_label is not None and label_value > best_label):
            best_score = score
            best_label = label_value
    return best_label if has_any else None


def _render_progress_bar(
    current: int, total: int, *, start_time_s: float, width: int = 30, prefix: str = "Articles"
) -> str:
    total = max(total, 1)
    current = max(0, min(current, total))
    frac = current / total
    filled = int(frac * width)
    bar = "=" * filled + "-" * (width - filled)
    elapsed = max(0.0, time.time() - start_time_s)
    rate = (current / elapsed) if elapsed > 0 else 0.0
    eta_s = int((total - current) / rate) if rate > 0 else 0
    return f"{prefix}: [{bar}] {current}/{total} ({frac:.0%}) elapsed={int(elapsed)}s eta={eta_s}s"


class StreamingJSONListWriter:
    """Stream JSON list entries to file, with optional append preserving existing content."""

    def __init__(self, path: str, *, flush_every: int = 0, append: bool = False):
        self.path = path
        self.flush_every = max(0, int(flush_every))
        self.append = append
        self._fh: Optional[Any] = None
        self._count = 0
        self._buffer: Optional[List[Any]] = None

    def __enter__(self) -> "StreamingJSONListWriter":
        dirpath = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(dirpath, exist_ok=True)
        if self.append and os.path.exists(self.path):
            try:
                existing = json.load(open(self.path, "r", encoding="utf-8"))
                if isinstance(existing, list):
                    self._buffer = list(existing)
                else:
                    self._buffer = []
            except Exception:
                self._buffer = []
        if self._buffer is not None:
            # Append mode: collect new items and write once on close.
            self._count = len(self._buffer)
            return self
        # Streaming mode: overwrite and stream as JSON array.
        self._fh = open(self.path, "w", encoding="utf-8")
        self._fh.write("[\n")
        self._count = 0
        return self

    def write(self, obj: Any) -> None:
        if self._buffer is not None:
            self._buffer.append(obj)
            self._count += 1
            return
        if self._fh is None:
            raise RuntimeError("StreamingJSONListWriter not opened.")
        if self._count > 0:
            self._fh.write(",\n")
        json.dump(obj, self._fh, ensure_ascii=False)
        self._count += 1
        if self.flush_every and (self._count % self.flush_every == 0):
            self._fh.flush()
            os.fsync(self._fh.fileno())

    def close(self) -> None:
        if self._buffer is not None:
            with open(self.path, "w", encoding="utf-8") as fh:
                json.dump(self._buffer, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            self._buffer = None
            return
        if self._fh:
            self._fh.write("\n]\n")
            self._fh.close()
            self._fh = None

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


def _article_text(article: Dict[str, Any]) -> str:
    parts: List[str] = []
    for k in ("title", "liar2_statement", "liar2_context", "liar2_justification", "content"):
        v = article.get(k)
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    return _collapse_ws("\n\n".join(parts))


def _minimal_author(author: Dict[str, Any]) -> Dict[str, Any]:
    """Return a stripped-down author payload with only the requested fields."""
    out = {
        "name": author.get("name"),
        "surname": author.get("surname"),
        "liar2_author_key": author.get("liar2_author_key"),
        "articles": [],
    }
    for art in author.get("articles", []):
        out["articles"].append(
            {
                "title": art.get("title"),
                "liar2_statement": art.get("liar2_statement"),
                "news-status": art.get("news-status"),
                "competent_skills_gpt": art.get("competent_skills_gpt"),
                "competent_confidence_skills_gpt": art.get("competent_confidence_skills_gpt"),
                "competent_reason_skills_gpt": art.get("competent_reason_skills_gpt"),
                "competent_skills_gpt_status": art.get("competent_skills_gpt_status"),
            }
        )
    return out


def _format_skills(skills: List[Dict[str, Any]]) -> str:
    if not skills:
        return "None."
    lines: List[str] = []
    for s in skills:
        if not isinstance(s, dict):
            continue
        label = _collapse_ws(str(s.get("label") or "")) or "<missing label>"
        uri = _collapse_ws(str(s.get("uri") or ""))
        if uri:
            lines.append(f"- {label} ({uri})")
        else:
            lines.append(f"- {label}")
    if not lines:
        return "None."
    return "\n".join(lines)


def _normalize_author(s: str) -> str:
    return " ".join((s or "").replace("_", " ").replace("@", "").lower().split()).strip()


def load_skills_map(path: str) -> Dict[str, Dict[str, List[Dict[str, Any]]]]:
    """
    Return author -> {"skills_from_bio": [...], "skills_from_occupations": [...]}
    using normalized author keys for lookups.
    """
    out: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            author = obj.get("author")
            if not isinstance(author, str):
                continue
            key = _normalize_author(author)
            bio_skills = obj.get("skills_from_bio")
            if not isinstance(bio_skills, list):
                bio_skills = []
            occ_skills = obj.get("kept_occupation_skills") or obj.get("skills_from_occupations")
            # Some skill files only expose a single "skills" list; use it if occupation skills are missing.
            if not occ_skills:
                occ_skills = obj.get("skills")
            if not isinstance(occ_skills, list):
                occ_skills = []
            out[key] = {
                "skills_from_bio": bio_skills,
                "skills_from_occupations": occ_skills,
            }
    return out


def judge_competence_from_skills(
    client: AzureOpenAI,
    *,
    skills_bio: List[Dict[str, Any]],
    skills_occ: List[Dict[str, Any]],
    claim: str,
    model: str,
    temperature: float,
) -> Dict[str, Any]:
    claim = _collapse_ws(claim)
    if not claim:
        return {"competent": False, "confidence": 0.2, "reason": "Claim text is missing."}
    bio_text = _format_skills(skills_bio)
    occ_text = _format_skills(skills_occ)
    if bio_text == "None." and occ_text == "None.":
        return {"competent": False, "confidence": 0.2, "reason": "No skills available for this author."}

    prompt_text = PROMPT_TEMPLATE.format(
        bio_skills=bio_text,
        occ_skills=occ_text,
        claim=claim,
    )

    try:
        resp = client.chat.completions.create(
            model=model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": "You output strict JSON only."},
                {
                    "role": "user",
                    "content": prompt_text,
                },
            ],
        )
    except RateLimitError as e:
        return {"competent": None, "confidence": 0.0, "reason": f"rate-limit: {e}"}
    raw = (resp.choices[0].message.content or "").strip()
    try:
        out = json.loads(raw)
    except Exception:
        return {"competent": False, "confidence": 0.0, "reason": f"Invalid JSON from model: {raw[:160]}"}

    if not isinstance(out, dict):
        return {"competent": False, "confidence": 0.0, "reason": "Model output was not a JSON object."}

    competent = bool(out.get("competent"))
    conf = out.get("confidence")
    try:
        conf_f = float(conf)
    except Exception:
        conf_f = 0.0
    conf_f = max(0.0, min(1.0, conf_f))
    reason = out.get("reason")
    if not isinstance(reason, str):
        reason = ""
    return {"competent": competent, "confidence": conf_f, "reason": _collapse_ws(reason)}


def parse_args(argv: List[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="GPT competence classifier using ESCO skills (bio + occupation) instead of bios."
    )
    ap.add_argument("--input-json", required=True, help="Same input as gpt_competence_classifier.py.")
    ap.add_argument(
        "--skills-jsonl",
        default="Validation/skills_polished.jsonl",
        help="JSONL with skills_from_bio and kept_occupation_skills per author.",
    )
    ap.add_argument("--output-json", required=True)
    ap.add_argument("--model", default=MODEL_DEFAULT)
    ap.add_argument("--temperature", type=float, default=TEMPERATURE_DEFAULT)
    ap.add_argument("--sleep-s", type=float, default=0.5)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument(
        "--restore-cache-only",
        action="store_true",
        help="Skip API calls and only restore competence labels from the cache/output files.",
    )
    ap.add_argument("--progress-every", type=int, default=50)
    ap.add_argument(
        "--cache-jsonl",
        help="Path to a JSONL cache of judged articles (one per line). Defaults to <output-json>.cache.jsonl when not set.",
    )
    ap.add_argument(
        "--only-rejudge-false-news-skilled",
        action="store_true",
        help="Re-run GPT only for articles with news-status='false-news' AND existing competent_skills_gpt=true; "
        "all other articles are passed through unchanged (or reused from cache).",
    )
    ap.add_argument(
        "--save-every",
        type=int,
        default=50,
        help="Flush to disk every N authors; 0 disables periodic flushes.",
    )
    ap.add_argument(
        "--in-place",
        action="store_true",
        help="Write output back to the input JSON (overwrites input).",
    )
    ap.add_argument("--no-progress", action="store_true")
    ap.add_argument("--use-tqdm", action="store_true", help="Show a tqdm progress bar (overrides --no-progress).")
    return ap.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    if args.in_place:
        args.output_json = args.input_json
    cache_jsonl_path = args.cache_jsonl or f"{args.output_json}.cache.jsonl"

    with open(args.input_json, "r", encoding="utf-8") as f:
        people = json.load(f)
    if not isinstance(people, list):
        raise SystemExit("--input-json must be a JSON list.")

    def load_cache_jsonl(path: str) -> Dict[str, Dict[str, Any]]:
        cache: Dict[str, Dict[str, Any]] = {}
        if not path or not os.path.exists(path):
            return cache
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    k = obj.get("key")
                    if not k:
                        continue
                    cache[k] = {
                        "competent_skills_gpt": obj.get("competent_skills_gpt"),
                        "competent_confidence_skills_gpt": obj.get("competent_confidence_skills_gpt"),
                        "competent_reason_skills_gpt": obj.get("competent_reason_skills_gpt"),
                        "competent_skills_gpt_status": obj.get("competent_skills_gpt_status"),
                    }
        except Exception:
            pass
        return cache

    cache_by_key = load_cache_jsonl(cache_jsonl_path)

    # Normalize news-status from liar2_label if present and not already set.
    for person in people:
        if not isinstance(person, dict):
            continue
        for art in person.get("articles", []) or []:
            if not isinstance(art, dict):
                continue
            derived_label = _derive_label_from_counts(art)
            label = derived_label if derived_label is not None else art.get("liar2_label")
            try:
                label_int = int(label)
            except (TypeError, ValueError):
                label_int = None
            if "news-status" not in art or art.get("news-status") is None:
                # Treat liar2_label >= 2 as true-news; everything else becomes false-news.
                art["news-status"] = "true-news" if label_int is not None and label_int >= 3 else "false-news"

    skills_map = load_skills_map(args.skills_jsonl)

    # Resume: reuse already-judged items from existing output.
    judged_by_key: Dict[str, Dict[str, Any]] = dict(cache_by_key)
    if args.resume and os.path.exists(args.output_json):
        try:
            existing = json.load(open(args.output_json, "r", encoding="utf-8"))
            if isinstance(existing, list):
                for person in existing:
                    if not isinstance(person, dict):
                        continue
                    akey_raw = str(person.get("liar2_author_key") or person.get("author") or "")
                    akey = _normalize_author(akey_raw)
                    for art in person.get("articles") or []:
                        if not isinstance(art, dict):
                            continue
                        liar2_id = _collapse_ws(art.get("liar2_id", "") or "")
                        title = _collapse_ws(art.get("title", "") or "")
                        k = _sha256(akey + "\n" + liar2_id + "\n" + title)
                        if "competent_skills_gpt" in art:
                            judged_by_key[k] = {
                            "competent_skills_gpt": art.get("competent_skills_gpt"),
                            "competent_confidence_skills_gpt": art.get("competent_confidence_skills_gpt"),
                            "competent_reason_skills_gpt": art.get("competent_reason_skills_gpt"),
                            "competent_skills_gpt_status": art.get("competent_skills_gpt_status"),
                        }
        except Exception:
            pass

    cache_fh = None
    if cache_jsonl_path and not args.restore_cache_only:
        os.makedirs(os.path.dirname(os.path.abspath(cache_jsonl_path)), exist_ok=True)
        cache_fh = open(cache_jsonl_path, "a", encoding="utf-8")

    client: Optional[AzureOpenAI] = None
    if not args.restore_cache_only:
        api_key = _resolve_api_key()
        if not api_key:
            raise SystemExit(
                "AZURE_OPENAI_API_KEY (or OPENAI_API_KEY / OPENAI_API_KEY_FILE) is required."
            )
        endpoint = (
            os.getenv("AZURE_OPENAI_ENDPOINT")
            or os.getenv("OPENAI_BASE_URL")
            or AZURE_ENDPOINT_DEFAULT
        )
        api_version = (
            os.getenv("AZURE_OPENAI_API_VERSION")
            or os.getenv("OPENAI_API_VERSION")
            or AZURE_API_VERSION_DEFAULT
        )
        client = AzureOpenAI(azure_endpoint=endpoint, api_key=api_key, api_version=api_version)

    total_articles = sum(
        len((p.get("articles") or []))
        for p in people
        if isinstance(p, dict)
        and not _is_non_person_author(str(p.get("liar2_author_key") or p.get("author") or ""))
        and str(p.get("liar2_author_key") or p.get("author") or "").strip() in skills_map
    )
    processed = 0
    start = time.time()
    pbar = (
        tqdm(total=total_articles, desc="Articles", disable=bool(args.no_progress is True and not args.use_tqdm))
        if args.use_tqdm
        else None
    )

    flush_every = args.save_every if args.save_every and args.save_every > 0 else 0
    with StreamingJSONListWriter(args.output_json, flush_every=flush_every, append=args.resume) as writer:
        for person in people:
            if not isinstance(person, dict):
                continue
            akey_raw = str(person.get("liar2_author_key") or person.get("author") or "")
            akey = _normalize_author(akey_raw)
            if _is_non_person_author(akey_raw):
                continue
            skills_entry = skills_map.get(akey, {"skills_from_bio": [], "skills_from_occupations": []})
            missing_skills_entry = akey not in skills_map
            if missing_skills_entry:
                continue
            for art in person.get("articles") or []:
                processed += 1
                if not isinstance(art, dict):
                    continue

                # Ensure news-status is populated from liar2_label if missing.
                if not art.get("news-status"):
                    derived_label = _derive_label_from_counts(art)
                    label_raw = derived_label if derived_label is not None else art.get("liar2_label")
                    try:
                        label_int = int(label_raw)
                    except (TypeError, ValueError):
                        label_int = None
                    # Treat liar2_label >= 2 as true-news; everything else becomes false-news.
                    art["news-status"] = "true-news" if label_int is not None and label_int >= 3 else "false-news"

                liar2_id = _collapse_ws(art.get("liar2_id", "") or "")
                title = _collapse_ws(art.get("title", "") or "")
                k = _sha256(akey + "\n" + liar2_id + "\n" + title)

                should_rejudge_false_news = (
                    args.only_rejudge_false_news_skilled
                    and art.get("news-status") == "false-news"
                    and art.get("competent_skills_gpt") is True
                )
                has_cache = k in judged_by_key

                if args.restore_cache_only:
                    if has_cache:
                        cached = judged_by_key[k]
                        art["competent_skills_gpt"] = cached.get("competent_skills_gpt")
                        art["competent_confidence_skills_gpt"] = cached.get("competent_confidence_skills_gpt")
                        art["competent_reason_skills_gpt"] = cached.get("competent_reason_skills_gpt")
                        art["competent_skills_gpt_status"] = cached.get("competent_skills_gpt_status")
                    if pbar:
                        pbar.update(1)
                    elif not args.no_progress and args.progress_every > 0 and (
                        processed % args.progress_every == 0 or processed == total_articles
                    ):
                        print(_render_progress_bar(processed, total_articles, start_time_s=start), file=sys.stderr)
                    continue

                if should_rejudge_false_news:
                    # Always rejudge targeted cases (ignore cache).
                    claim = _article_text(art)
                    verdict = judge_competence_from_skills(
                        client,
                        skills_bio=skills_entry.get("skills_from_bio", []),
                        skills_occ=skills_entry.get("skills_from_occupations", []),
                        claim=claim,
                        model=args.model,
                        temperature=args.temperature,
                    )
                    if verdict.get("competent") is None:
                        print(f"[warn] Rate limit; skipping article {liar2_id} / {title}", file=sys.stderr)
                        art["competent_skills_gpt"] = None
                        art["competent_confidence_skills_gpt"] = 0.0
                        art["competent_reason_skills_gpt"] = verdict["reason"]
                        art["competent_skills_gpt_status"] = "skipped"
                    else:
                        art["competent_skills_gpt"] = bool(verdict["competent"])
                        art["competent_confidence_skills_gpt"] = verdict["confidence"]
                        art["competent_reason_skills_gpt"] = verdict["reason"]
                        art["competent_skills_gpt_status"] = "scored"
                        time.sleep(args.sleep_s)
                elif has_cache:
                    cached = judged_by_key[k]
                    art["competent_skills_gpt"] = cached.get("competent_skills_gpt")
                    art["competent_confidence_skills_gpt"] = cached.get("competent_confidence_skills_gpt")
                    art["competent_reason_skills_gpt"] = cached.get("competent_reason_skills_gpt")
                    art["competent_skills_gpt_status"] = cached.get("competent_skills_gpt_status")
                elif args.only_rejudge_false_news_skilled:
                    # Pass through existing labels; only rejudge the targeted false-news + skilled cases.
                    if "competent_skills_gpt" not in art:
                        claim = _article_text(art)
                        verdict = judge_competence_from_skills(
                            client,
                            skills_bio=skills_entry.get("skills_from_bio", []),
                            skills_occ=skills_entry.get("skills_from_occupations", []),
                            claim=claim,
                            model=args.model,
                            temperature=args.temperature,
                        )
                        if verdict.get("competent") is None:
                            print(f"[warn] Rate limit; skipping article {liar2_id} / {title}", file=sys.stderr)
                            art["competent_skills_gpt"] = None
                            art["competent_confidence_skills_gpt"] = 0.0
                            art["competent_reason_skills_gpt"] = verdict["reason"]
                            art["competent_skills_gpt_status"] = "skipped"
                        else:
                            art["competent_skills_gpt"] = bool(verdict["competent"])
                            art["competent_confidence_skills_gpt"] = verdict["confidence"]
                            art["competent_reason_skills_gpt"] = verdict["reason"]
                            art["competent_skills_gpt_status"] = "scored"
                            time.sleep(args.sleep_s)
                else:
                    claim = _article_text(art)
                    verdict = judge_competence_from_skills(
                        client,
                        skills_bio=skills_entry.get("skills_from_bio", []),
                        skills_occ=skills_entry.get("skills_from_occupations", []),
                        claim=claim,
                        model=args.model,
                        temperature=args.temperature,
                    )
                    if verdict.get("competent") is None:
                        print(f"[warn] Rate limit; skipping article {liar2_id} / {title}", file=sys.stderr)
                        art["competent_skills_gpt"] = None
                        art["competent_confidence_skills_gpt"] = 0.0
                        art["competent_reason_skills_gpt"] = verdict["reason"]
                        art["competent_skills_gpt_status"] = "skipped"
                    else:
                        art["competent_skills_gpt"] = bool(verdict["competent"])
                        art["competent_confidence_skills_gpt"] = verdict["confidence"]
                        art["competent_reason_skills_gpt"] = verdict["reason"]
                        art["competent_skills_gpt_status"] = "scored"
                        time.sleep(args.sleep_s)

                if cache_fh and k not in cache_by_key:
                    cache_by_key[k] = {
                        "competent_skills_gpt": art.get("competent_skills_gpt"),
                        "competent_confidence_skills_gpt": art.get("competent_confidence_skills_gpt"),
                        "competent_reason_skills_gpt": art.get("competent_reason_skills_gpt"),
                        "competent_skills_gpt_status": art.get("competent_skills_gpt_status"),
                    }
                    json.dump(
                        {
                            "key": k,
                            "competent_skills_gpt": art.get("competent_skills_gpt"),
                            "competent_confidence_skills_gpt": art.get("competent_confidence_skills_gpt"),
                            "competent_reason_skills_gpt": art.get("competent_reason_skills_gpt"),
                            "competent_skills_gpt_status": art.get("competent_skills_gpt_status"),
                        },
                        cache_fh,
                        ensure_ascii=False,
                    )
                    cache_fh.write("\n")
                    cache_fh.flush()
                    os.fsync(cache_fh.fileno())

                if pbar:
                    pbar.update(1)
                elif not args.no_progress and args.progress_every > 0 and (
                    processed % args.progress_every == 0 or processed == total_articles
                ):
                    print(_render_progress_bar(processed, total_articles, start_time_s=start), file=sys.stderr)

            # Emit only the minimal fields requested.
            writer.write(_minimal_author(person))

        if pbar:
            pbar.close()
    if cache_fh:
        cache_fh.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
