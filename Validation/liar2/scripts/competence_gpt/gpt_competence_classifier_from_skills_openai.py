#!/usr/bin/env python3
"""
GPT-based competence labeling that uses ESCO skills instead of bios.

This variant targets the public OpenAI API (https://api.openai.com/v1) instead
of Azure; set OPENAI_API_KEY (and optionally OPENAI_BASE_URL).
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

from openai import OpenAI
from tqdm import tqdm

MODEL_DEFAULT = "gpt-4.1"
TEMPERATURE_DEFAULT = 0

NON_PERSON_KEYWORDS = [
    "association",
    "alliance",
    "committee",
    "party",
    "pac",
    "fund",
    "foundation",
    "council",
    "institute",
    "action fund",
    "action pac",
    "chapter",
    "union",
    "coalition",
    "board of",
    "school district",
    "executive committee",
    "policy institute",
    "policy center",
    "policy centre",
    "caucus",
    "citizens",
    "voters",
    "residents",
    "people for",
    "americans for",
    "americans against",
    "friends of",
    "committee to",
    "campaign to",
    "campaign for",
    "journalreview.com",
    "news.com",
    "news.net",
    "news.in",
    "tribune.com",
    "gazette.com",
    ".com",
    ".net",
    ".org",
]

NON_PERSON_EXPLICIT = {
    "anonymous gop critics",
    "americans united for change",
    "americans against food taxes",
    "bling news",
    "afscme",
    "austin for a better future",
    "austinites for geographic representation",
    "bluedot daily",
    "bipartisan report",
    "black lives matter",
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
    if any(ch.isdigit() for ch in low) or "%" in low:
        return True
    if any(kw in low for kw in NON_PERSON_KEYWORDS):
        return True
    if low.startswith(("americans for", "campaign for", "campaign to", "american ")):
        return True
    if " for " in f" {low} ":
        return True
    if " of " in f" {low} ":
        return True
    if any(term in low for term in ("conservative", "conservatives", "democrat", "democrats")):
        return True
    if "news" in low:
        return True
    if "." in low and ("news" in low or low.endswith((".com", ".net", ".org", ".in"))):
        return True
    if any(sub in low for sub in NON_PERSON_EXPLICIT):
        return True
    if len(low.split()) == 1:
        return True
    words = [w for w in re.findall(r"[a-zA-Z]+", author) if w]
    if len(words) < 2:
        return True
    if not any(len(w) >= 2 for w in words):
        return True
    return False


def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split()).strip()


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _atomic_write_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


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
    """Stream JSON list entries to file to avoid rewriting the whole file."""

    def __init__(self, path: str, *, flush_every: int = 0):
        self.path = path
        self.flush_every = max(0, int(flush_every))
        self._fh: Optional[Any] = None
        self._count = 0

    def __enter__(self) -> "StreamingJSONListWriter":
        dirpath = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(dirpath, exist_ok=True)
        self._fh = open(self.path, "w", encoding="utf-8")
        self._fh.write("[\n")
        return self

    def write(self, obj: Any) -> None:
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
        if self._fh:
            self._fh.write("\n]\n")
            self._fh.close()
            self._fh = None

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


def _article_text(article: Dict[str, Any]) -> str:
    # Only fields available at submission time may be used. The fact-checker's
    # gold explanation (liar2_justification) is the target rationale and must
    # NOT be fed to the competence model, as it leaks the label.
    parts: List[str] = []
    for k in ("title", "liar2_statement", "liar2_context", "content"):
        v = article.get(k)
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    return _collapse_ws("\n\n".join(parts))


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
    Return author -> {"skills_from_bio": [...], "skills_from_occupations": [...]} using normalized author keys.
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
    client: OpenAI,
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

    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": "You output strict JSON only."},
            {"role": "user", "content": prompt_text},
        ],
    )
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
        description="GPT competence classifier using ESCO skills (bio + occupation) instead of bios, targeting OpenAI API."
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
    ap.add_argument("--progress-every", type=int, default=50)
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

    with open(args.input_json, "r", encoding="utf-8") as f:
        people = json.load(f)
    if not isinstance(people, list):
        raise SystemExit("--input-json must be a JSON list.")

    for person in people:
        if not isinstance(person, dict):
            continue
        for art in person.get("articles", []) or []:
            if not isinstance(art, dict):
                continue
            label = art.get("liar2_label")
            try:
                label_int = int(label)
            except (TypeError, ValueError):
                label_int = None
            if "news-status" not in art or art.get("news-status") is None:
                art["news-status"] = "true-news" if label_int is not None and label_int >= 3 else "false-news"

    skills_map = load_skills_map(args.skills_jsonl)

    judged_by_key: Dict[str, Dict[str, Any]] = {}
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
                            }
        except Exception:
            judged_by_key = {}

    base_url = os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    # Allow a dedicated key for this script (OPENAI_COMPETENCE_API_KEY) to coexist with other keys.
    api_key = os.getenv("OPENAI_COMPETENCE_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_COMPETENCE_API_KEY (or OPENAI_API_KEY) is required for the OpenAI API.")
    client = OpenAI(base_url=base_url, api_key=api_key)

    total_articles = sum(
        len((p.get("articles") or []))
        for p in people
        if isinstance(p, dict)
        and not _is_non_person_author(str(p.get("liar2_author_key") or p.get("author") or ""))
    )
    processed = 0
    start = time.time()
    pbar = (
        tqdm(total=total_articles, desc="Articles", disable=bool(args.no_progress is True and not args.use_tqdm))
        if args.use_tqdm
        else None
    )

    flush_every = args.save_every if args.save_every and args.save_every > 0 else 0
    with StreamingJSONListWriter(args.output_json, flush_every=flush_every) as writer:
        for person in people:
            if not isinstance(person, dict):
                continue
            akey_raw = str(person.get("liar2_author_key") or person.get("author") or "")
            if _is_non_person_author(akey_raw):
                # For non-person authors, force competence=false with minimal confidence and reason.
                for art in person.get("articles") or []:
                    if not isinstance(art, dict):
                        continue
                    art["competent_skills_gpt"] = False
                    art["competent_confidence_skills_gpt"] = 0.0
                    art["competent_reason_skills_gpt"] = "Non-person author; competence set to false."
                    art["competent_skills_gpt_status"] = "non-person"
                writer.write(person)
                continue
            akey_raw = str(person.get("liar2_author_key") or "")
            akey = _normalize_author(akey_raw)
            skills_entry = skills_map.get(akey, {"skills_from_bio": [], "skills_from_occupations": []})
            for art in person.get("articles") or []:
                processed += 1
                if not isinstance(art, dict):
                    continue

                if not art.get("news-status"):
                    try:
                        label_int = int(art.get("liar2_label"))
                    except (TypeError, ValueError):
                        label_int = None
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

                if should_rejudge_false_news:
                    claim = _article_text(art)
                    verdict = judge_competence_from_skills(
                        client,
                        skills_bio=skills_entry.get("skills_from_bio", []),
                        skills_occ=skills_entry.get("skills_from_occupations", []),
                        claim=claim,
                        model=args.model,
                        temperature=args.temperature,
                    )
                    art["competent_skills_gpt"] = bool(verdict["competent"])
                    art["competent_confidence_skills_gpt"] = verdict["confidence"]
                    art["competent_reason_skills_gpt"] = verdict["reason"]
                    time.sleep(args.sleep_s)
                elif has_cache:
                    cached = judged_by_key[k]
                    art["competent_skills_gpt"] = cached.get("competent_skills_gpt")
                    art["competent_confidence_skills_gpt"] = cached.get("competent_confidence_skills_gpt")
                    art["competent_reason_skills_gpt"] = cached.get("competent_reason_skills_gpt")
                elif args.only_rejudge_false_news_skilled:
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
                        art["competent_skills_gpt"] = bool(verdict["competent"])
                        art["competent_confidence_skills_gpt"] = verdict["confidence"]
                        art["competent_reason_skills_gpt"] = verdict["reason"]
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
                    art["competent_skills_gpt"] = bool(verdict["competent"])
                    art["competent_confidence_skills_gpt"] = verdict["confidence"]
                    art["competent_reason_skills_gpt"] = verdict["reason"]
                    time.sleep(args.sleep_s)

                if pbar:
                    pbar.update(1)
                elif not args.no_progress and args.progress_every > 0 and (
                    processed % args.progress_every == 0 or processed == total_articles
                ):
                    print(_render_progress_bar(processed, total_articles, start_time_s=start), file=sys.stderr)

            writer.write(person)

        if pbar:
            pbar.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
