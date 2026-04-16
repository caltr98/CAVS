#!/usr/bin/env python3
"""
LLM-based competence labeling for LIAR2-style data.

For each (author, article) pair, asks the model whether the author's bio indicates
they are competent to speak on the article's claim/topic.

This is subjective by design; treat outputs as model judgments, not ground truth.
"""

import argparse
import hashlib
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

from openai import OpenAI
from tqdm import tqdm


MODEL_DEFAULT = "gpt-4.1-mini"
TEMPERATURE_DEFAULT = 0


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


PROMPT = """\
Decide whether the author's background suggests they are competent to make or assess the claim below.

Return ONLY valid JSON with this exact schema:
{{
  "competent": <true|false>,
  "confidence": <0-1>,
  "reason": "<one sentence>"
}}

Rules:
- Use ONLY the bio + claim text below (no external knowledge).
- Competent=true if the bio indicates directly relevant education/work/domain experience.
- Competent=false if the bio is unrelated, too generic, or missing.
- If bio is missing/unknown, competent=false.

AUTHOR BIO:
{bio}

CLAIM / STATEMENT (may include context):
{claim}
"""


def _article_text(article: Dict[str, Any]) -> str:
    parts: List[str] = []
    for k in ("title", "liar2_statement", "liar2_context", "liar2_justification", "content"):
        v = article.get(k)
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    return _collapse_ws("\n\n".join(parts))


def judge_competence(
    client: OpenAI,
    *,
    bio: str,
    claim: str,
    model: str,
    temperature: float,
) -> Dict[str, Any]:
    bio = _collapse_ws(bio)
    claim = _collapse_ws(claim)
    if not bio or bio.lower() in {"not available", "unknown"}:
        return {"competent": False, "confidence": 0.2, "reason": "Bio is missing or uninformative."}
    if not claim:
        return {"competent": False, "confidence": 0.2, "reason": "Claim text is missing."}

    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": "You output strict JSON only."},
            {"role": "user", "content": PROMPT.format(bio=bio, claim=claim)},
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


def main() -> int:
    ap = argparse.ArgumentParser(description="GPT competence classifier for LIAR2 skillified JSON.")
    ap.add_argument("--input-json", required=True)
    ap.add_argument("--output-json", required=True)
    ap.add_argument("--model", default=MODEL_DEFAULT)
    ap.add_argument("--temperature", type=float, default=TEMPERATURE_DEFAULT)
    ap.add_argument("--sleep-s", type=float, default=0.5)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--progress-every", type=int, default=50)
    ap.add_argument("--save-every", type=int, default=50)
    ap.add_argument("--no-progress", action="store_true")
    ap.add_argument("--use-tqdm", action="store_true", help="Show a tqdm progress bar for articles (overrides --no-progress).")
    args = ap.parse_args()

    with open(args.input_json, "r", encoding="utf-8") as f:
        people = json.load(f)
    if not isinstance(people, list):
        raise SystemExit("--input-json must be a JSON list.")

    # Resume: reuse already-judged items from existing output.
    judged_by_key: Dict[str, Dict[str, Any]] = {}
    if args.resume and os.path.exists(args.output_json):
        try:
            existing = json.load(open(args.output_json, "r", encoding="utf-8"))
            if isinstance(existing, list):
                for person in existing:
                    if not isinstance(person, dict):
                        continue
                    akey = _collapse_ws(str(person.get("liar2_author_key") or "")).lower()
                    for art in person.get("articles") or []:
                        if not isinstance(art, dict):
                            continue
                        liar2_id = _collapse_ws(art.get("liar2_id", "") or "")
                        title = _collapse_ws(art.get("title", "") or "")
                        k = _sha256(akey + "\n" + liar2_id + "\n" + title)
                        if "competent_gpt" in art:
                            judged_by_key[k] = {
                                "competent_gpt": art.get("competent_gpt"),
                                "competent_confidence_gpt": art.get("competent_confidence_gpt"),
                                "competent_reason_gpt": art.get("competent_reason_gpt"),
                            }
        except Exception:
            judged_by_key = {}

    endpoint = os.getenv("OPENAI_BASE_URL") or os.getenv("AZURE_OPENAI_ENDPOINT") or "https://cavs.openai.azure.com/openai/v1"
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AZURE_OPENAI_API_KEY")
    client = OpenAI(base_url=endpoint, api_key=api_key)
    total_articles = sum(len((p.get("articles") or [])) for p in people if isinstance(p, dict))
    processed = 0
    judged_new = 0
    start = time.time()
    pbar = tqdm(total=total_articles, desc="Articles", disable=bool(args.no_progress is True and not args.use_tqdm)) if args.use_tqdm else None

    for person in people:
        if not isinstance(person, dict):
            continue
        bio = person.get("bio") if isinstance(person.get("bio"), str) else ""
        akey = _collapse_ws(str(person.get("liar2_author_key") or "")).lower()
        for art in person.get("articles") or []:
            processed += 1
            if not isinstance(art, dict):
                continue
            liar2_id = _collapse_ws(art.get("liar2_id", "") or "")
            title = _collapse_ws(art.get("title", "") or "")
            k = _sha256(akey + "\n" + liar2_id + "\n" + title)

            if k in judged_by_key:
                cached = judged_by_key[k]
                art["competent_gpt"] = cached.get("competent_gpt")
                art["competent_confidence_gpt"] = cached.get("competent_confidence_gpt")
                art["competent_reason_gpt"] = cached.get("competent_reason_gpt")
            else:
                claim = _article_text(art)
                verdict = judge_competence(
                    client,
                    bio=bio,
                    claim=claim,
                    model=args.model,
                    temperature=args.temperature,
                )
                art["competent_gpt"] = bool(verdict["competent"])
                art["competent_confidence_gpt"] = verdict["confidence"]
                art["competent_reason_gpt"] = verdict["reason"]
                judged_new += 1
                time.sleep(args.sleep_s)

            if args.save_every > 0 and judged_new > 0 and (judged_new % args.save_every == 0):
                _atomic_write_json(args.output_json, people)

            if pbar:
                pbar.update(1)
            elif not args.no_progress and args.progress_every > 0 and (
                processed % args.progress_every == 0 or processed == total_articles
            ):
                print(_render_progress_bar(processed, total_articles, start_time_s=start), file=sys.stderr)

    _atomic_write_json(args.output_json, people)
    if pbar:
        pbar.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
