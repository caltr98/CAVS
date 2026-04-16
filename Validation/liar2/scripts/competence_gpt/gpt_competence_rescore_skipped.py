#!/usr/bin/env python3
"""
Rescore only the articles marked `competent_skills_gpt_status == "skipped"`
in the reclass JSON, using the skills-based GPT classifier.

Defaults to the canonical grouped GPT competence JSON:
Validation/liar2/data/final/ablation/liar2_ablation_reference.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from openai import RateLimitError

import gpt_competence_classifier_from_skills as base

def locate_validation_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if parent.name == "Validation" and (parent / "gpt_issue_credentials.py").exists():
            return parent
    raise RuntimeError("Could not locate Validation root from gpt_competence_rescore_skipped.py.")


VALIDATION_ROOT = locate_validation_root()
LIAR2_VALIDATION_ROOT = VALIDATION_ROOT / "liar2"

try:
    # Prefer sibling import if available.
    from gpt_issue_credentials import _build_openai_clients  # type: ignore
except Exception:  # pragma: no cover
    # When run from repo root, add Validation/ to path.
    sys.path.insert(0, str(VALIDATION_ROOT))
    from gpt_issue_credentials import _build_openai_clients  # type: ignore

DEFAULT_INPUT = LIAR2_VALIDATION_ROOT / "data" / "final" / "ablation" / "liar2_ablation_reference.json"
DEFAULT_OUTPUT = LIAR2_VALIDATION_ROOT / "data" / "final" / "ablation" / "liar2_ablation_reference_rescored_skipped.json"
DEFAULT_SKILLS = VALIDATION_ROOT / "skills_output.jsonl"
MAX_SKILL_ENTRIES = 30  # per source

SUMMARY_PROMPT_TEMPLATE = """\
Summarize the claim in <= 40 words.

Return ONLY valid JSON:
{{"summary": "<your concise summary>"}}.

Claim:
{claim}
"""

COMPETENCE_PROMPT_TEMPLATE = """\
Given the claim summary and the skills below, decide if the author is competent to assess the claim.

Return ONLY valid JSON:
{{"competent": <true|false>, "confidence": <0-1>, "reason": "<one sentence>"}}.

Rules:
- Use ONLY the provided skills + claim summary (no external knowledge).
- If the skills list is empty/missing, set competent=false with confidence <=0.2 and reason “No skills available for this author.”
- Identify the primary domain of the claim and judge competence against that domain only.
- Require clear subject-matter alignment: if the claim is technical/specialized and skills lack matching domain skills, respond competent=false with confidence <=0.4 and explicitly note the missing domain.
- Political/government/public-policy/legislative skills count when the claim is about politics/government/elections/legislation/budget procedures. They do NOT qualify someone for strictly technical domains (energy/climate/environment, medical/health/epidemiology, engineering/technology, science, immigration eligibility specifics).
- Do NOT treat generic media/social-media presence as skills.
- Reasons should be concise and cite whether domain skills are present or missing.

Claim summary:
{summary}

Skills:
{skills}
"""


def _ensure_news_status(article: Dict[str, Any]) -> None:
    if article.get("news-status") in ("true-news", "false-news"):
        return
    label = article.get("liar2_label") or article.get("label")
    try:
        label_int = int(label)
    except (TypeError, ValueError):
        label_int = None
    cutoff = article.get("_tmp_true_cutoff")
    try:
        cutoff_int = int(cutoff) if cutoff is not None else 3
    except Exception:
        cutoff_int = 3
    article["news-status"] = "true-news" if label_int is not None and label_int >= cutoff_int else "false-news"


def _choose_client(clients: List[Any], counter: List[int]) -> Optional[Any]:
    if not clients:
        return None
    idx = counter[0] % len(clients)
    counter[0] += 1
    return clients[idx]


def _format_skills_for_prompt(skills: List[Dict[str, Any]]) -> str:
    if not skills:
        return "None."
    lines: List[str] = []
    for s in skills[:MAX_SKILL_ENTRIES]:
        if not isinstance(s, dict):
            continue
        label = base._collapse_ws(str(s.get("label") or "")) or "<missing label>"
        uri = base._collapse_ws(str(s.get("uri") or ""))
        if uri:
            lines.append(f"- {label} ({uri})")
        else:
            lines.append(f"- {label}")
    text = "\n".join(lines) if lines else "None."
    return text[:1500]  # tighter cap to keep prompt small


def _call_chat_json(client: Any, *, model: str, temperature: float, prompt: str) -> Dict[str, Any]:
    try:
        resp = client.chat.completions.create(
            model=model,
            temperature=temperature,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You output strict JSON only."},
                {"role": "user", "content": prompt},
            ],
        )
    except RateLimitError as e:
        return {"error": f"rate-limit: {e}"}
    except Exception as e:
        return {"error": f"api-error: {e}"}
    raw = (resp.choices[0].message.content or "").strip()
    try:
        return json.loads(raw)
    except Exception:
        return {"error": f"invalid-json: {raw[:200]}"}


def _summarize_claim(client: Any, *, claim: str, model: str, temperature: float) -> Dict[str, Any]:
    """
    Summarize long claims by chunking to avoid token overflow.
    """
    max_chunk = 500  # characters, crude guard
    claim_clean = base._collapse_ws(claim)
    if not claim_clean:
        return {"error": "missing-claim"}

    def summarize_text(text: str) -> Dict[str, Any]:
        prompt = SUMMARY_PROMPT_TEMPLATE.format(claim=text)
        return _call_chat_json(client, model=model, temperature=temperature, prompt=prompt)

    if len(claim_clean) <= max_chunk:
        return summarize_text(claim_clean)

    # Chunk and summarize each part, then summarize the concatenated mini-summaries.
    chunks = []
    s = claim_clean
    while s:
        chunks.append(s[:max_chunk])
        s = s[max_chunk:]

    partial_summaries: List[str] = []
    for chunk in chunks:
        out = summarize_text(chunk)
        if "error" in out:
            return out
        partial_summaries.append(base._collapse_ws(out.get("summary") or ""))

    combined = " ".join(partial_summaries)
    return summarize_text(combined[:max_chunk])


def _judge_competence_dual(
    client: Any,
    *,
    skills_bio: List[Dict[str, Any]],
    skills_occ: List[Dict[str, Any]],
    claim: str,
    model: str,
    temperature: float,
) -> Dict[str, Any]:
    claim_clean = base._collapse_ws(claim)
    if not claim_clean:
        return {
            "competent": False,
            "confidence": 0.2,
            "reason": "Claim text is missing.",
            "summary": "",
            "competent_occ": False,
            "competent_confidence_occ": 0.2,
            "competent_reason_occ": "Claim text is missing.",
            "competent_bio": False,
            "competent_confidence_bio": 0.2,
            "competent_reason_bio": "Claim text is missing.",
        }

    bio_text = _format_skills_for_prompt(skills_bio)
    occ_text = _format_skills_for_prompt(skills_occ)

    # Step 1: summarize (chunked if needed)
    summary_out = _summarize_claim(client, claim=claim_clean, model=model, temperature=temperature)
    if "error" in summary_out:
        return {"competent": None, "confidence": 0.0, "reason": summary_out["error"]}
    summary = base._collapse_ws(summary_out.get("summary") or "")
    summary = summary[:200]  # keep competence prompt compact

    # Step 2: single competence call using summary as the statement.
    # Trim skills lists before sending to base to avoid huge prompts.
    verdict_base = base.judge_competence_from_skills(
        client,
        skills_bio=skills_bio[:MAX_SKILL_ENTRIES],
        skills_occ=skills_occ[:MAX_SKILL_ENTRIES],
        claim=summary,
        model=model,
        temperature=temperature,
    )
    if verdict_base.get("competent") is None:
        return verdict_base | {"summary": summary}

    overall_comp = bool(verdict_base.get("competent"))
    try:
        overall_conf = float(verdict_base.get("confidence"))
    except Exception:
        overall_conf = 0.0
    overall_conf = max(0.0, min(1.0, overall_conf))
    overall_reason = base._collapse_ws(verdict_base.get("reason") or "")

    return {
        "competent": overall_comp,
        "confidence": overall_conf,
        "reason": overall_reason,
        "summary": summary,
        # Mirror fields for compatibility.
        "competent_occ": overall_comp,
        "competent_confidence_occ": overall_conf,
        "competent_reason_occ": overall_reason,
        "competent_bio": overall_comp,
        "competent_confidence_bio": overall_conf,
        "competent_reason_bio": overall_reason,
    }


def parse_args(argv: List[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Rescore only skipped competence labels using skills-based GPT.")
    ap.add_argument("--input-json", type=Path, default=DEFAULT_INPUT, help="Reclass JSON to read.")
    ap.add_argument("--output-json", type=Path, default=DEFAULT_OUTPUT, help="Where to write updated JSON.")
    ap.add_argument(
        "--skills-jsonl",
        type=Path,
        default=DEFAULT_SKILLS,
        help="Skills JSONL (author -> skills_from_bio, skills_from_occupations).",
    )
    ap.add_argument("--model", default=base.MODEL_DEFAULT)
    ap.add_argument("--temperature", type=float, default=base.TEMPERATURE_DEFAULT)
    ap.add_argument("--sleep-s", type=float, default=0.5, help="Sleep between API calls to avoid rate limits.")
    ap.add_argument(
        "--cache-jsonl",
        type=Path,
        help="Optional cache file (JSONL) storing judged articles. Defaults to <output-json>.cache.jsonl",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional cap on the number of skipped articles to rescore (for testing).",
    )
    ap.add_argument("--no-api", action="store_true", help="Skip API calls; just report counts.")
    ap.add_argument(
        "--provider",
        choices=["azure", "openai", "all"],
        default="azure",
        help="Which OpenAI provider setup to use (matches gpt_issue_credentials.py).",
    )
    ap.add_argument(
        "--resume",
        action="store_true",
        help="If output exists, load it and skip already-scored articles.",
    )
    ap.add_argument(
        "--progress-every",
        type=int,
        default=20,
        help="Print progress every N skipped articles processed.",
    )
    ap.add_argument(
        "--true-cutoff",
        type=int,
        default=3,
        help="liar2_label cutoff for true-news (label >= cutoff => true-news). Default 3.",
    )
    return ap.parse_args(argv)


def load_cache_jsonl(path: Path) -> Dict[str, Dict[str, Any]]:
    cache: Dict[str, Dict[str, Any]] = {}
    if not path or not path.exists():
        return cache
    try:
        with path.open("r", encoding="utf-8") as fh:
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
                    "competent_skills_gpt_summary": obj.get("competent_skills_gpt_summary"),
                    "competent_skills_gpt_occ_only": obj.get("competent_skills_gpt_occ_only"),
                    "competent_confidence_skills_gpt_occ_only": obj.get("competent_confidence_skills_gpt_occ_only"),
                    "competent_reason_skills_gpt_occ_only": obj.get("competent_reason_skills_gpt_occ_only"),
                    "competent_skills_gpt_bio_only": obj.get("competent_skills_gpt_bio_only"),
                    "competent_confidence_skills_gpt_bio_only": obj.get("competent_confidence_skills_gpt_bio_only"),
                    "competent_reason_skills_gpt_bio_only": obj.get("competent_reason_skills_gpt_bio_only"),
                }
    except Exception:
        pass
    return cache


def write_cache_line(fh, key: str, art: Dict[str, Any]) -> None:
    json.dump(
        {
            "key": key,
            "competent_skills_gpt": art.get("competent_skills_gpt"),
            "competent_confidence_skills_gpt": art.get("competent_confidence_skills_gpt"),
            "competent_reason_skills_gpt": art.get("competent_reason_skills_gpt"),
            "competent_skills_gpt_status": art.get("competent_skills_gpt_status"),
            "competent_skills_gpt_summary": art.get("competent_skills_gpt_summary"),
            "competent_skills_gpt_occ_only": art.get("competent_skills_gpt_occ_only"),
            "competent_confidence_skills_gpt_occ_only": art.get("competent_confidence_skills_gpt_occ_only"),
            "competent_reason_skills_gpt_occ_only": art.get("competent_reason_skills_gpt_occ_only"),
            "competent_skills_gpt_bio_only": art.get("competent_skills_gpt_bio_only"),
            "competent_confidence_skills_gpt_bio_only": art.get("competent_confidence_skills_gpt_bio_only"),
            "competent_reason_skills_gpt_bio_only": art.get("competent_reason_skills_gpt_bio_only"),
        },
        fh,
        ensure_ascii=False,
    )
    fh.write("\n")
    fh.flush()


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    cache_path = args.cache_jsonl or Path(f"{args.output_json}.cache.jsonl")

    source_path = args.output_json if args.resume and args.output_json.exists() else args.input_json
    people = json.loads(source_path.read_text())
    if not isinstance(people, list):
        raise SystemExit(f"{source_path} must be a JSON list.")

    skills_map = base.load_skills_map(str(args.skills_jsonl))

    cache_by_key = load_cache_jsonl(cache_path)
    cache_fh = cache_path.open("a", encoding="utf-8") if cache_path else None

    # When resuming, also preload judged entries from existing output so we skip them.
    if args.resume and args.output_json.exists():
        try:
            existing = json.loads(args.output_json.read_text())
            if isinstance(existing, list):
                for author in existing:
                    if not isinstance(author, dict):
                        continue
                    akey_raw = str(author.get("liar2_author_key") or author.get("author") or "")
                    akey = base._normalize_author(akey_raw)
                    for art in author.get("articles") or []:
                        if not isinstance(art, dict):
                            continue
                        liar2_id = (art.get("liar2_id") or art.get("article_id") or "").strip()
                        title = (art.get("title") or art.get("liar2_statement") or "").strip()
                        cache_key = base._sha256(akey + "\n" + liar2_id + "\n" + title)
                        cache_by_key[cache_key] = {
                            "competent_skills_gpt": art.get("competent_skills_gpt"),
                            "competent_confidence_skills_gpt": art.get("competent_confidence_skills_gpt"),
                            "competent_reason_skills_gpt": art.get("competent_reason_skills_gpt"),
                            "competent_skills_gpt_status": art.get("competent_skills_gpt_status"),
                            "competent_skills_gpt_summary": art.get("competent_skills_gpt_summary"),
                            "competent_skills_gpt_occ_only": art.get("competent_skills_gpt_occ_only"),
                            "competent_confidence_skills_gpt_occ_only": art.get("competent_confidence_skills_gpt_occ_only"),
                            "competent_reason_skills_gpt_occ_only": art.get("competent_reason_skills_gpt_occ_only"),
                            "competent_skills_gpt_bio_only": art.get("competent_skills_gpt_bio_only"),
                            "competent_confidence_skills_gpt_bio_only": art.get("competent_confidence_skills_gpt_bio_only"),
                            "competent_reason_skills_gpt_bio_only": art.get("competent_reason_skills_gpt_bio_only"),
                        }
        except Exception:
            pass

    clients: List[Any] = [] if args.no_api else _build_openai_clients(args.provider)
    client_counter = [0]

    rescored = 0
    already_scored = 0
    missing_skills = 0
    rate_limited = 0
    skipped_total = 0

    # Collect targets first to enable accurate progress over skipped items.
    targets: List[tuple] = []
    for author_idx, author in enumerate(people):
        if not isinstance(author, dict):
            continue
        akey_raw = str(author.get("liar2_author_key") or author.get("author") or "")
        akey = base._normalize_author(akey_raw)
        for art_idx, art in enumerate(author.get("articles") or []):
            if not isinstance(art, dict):
                continue
            if art.get("competent_skills_gpt_status") == "skipped" or art.get("competent_skills_gpt") is None:
                targets.append((author_idx, art_idx, akey, akey_raw))

    total_targets = len(targets)
    if total_targets == 0:
        print("No skipped/None articles found; nothing to do.")
        return 0

    processed_targets = 0
    start = time.time()

    for author_idx, art_idx, akey, akey_raw in targets:
        author = people[author_idx]
        art = author.get("articles", [])[art_idx]
        skills_entry = skills_map.get(akey)

        art["_tmp_true_cutoff"] = args.true_cutoff
        _ensure_news_status(art)
        art.pop("_tmp_true_cutoff", None)

        skipped_total += 1

        liar2_id = (art.get("liar2_id") or art.get("article_id") or "").strip()
        title = (art.get("title") or art.get("liar2_statement") or "").strip()
        cache_key = base._sha256(akey + "\n" + liar2_id + "\n" + title)

        if cache_key in cache_by_key:
            cached = cache_by_key[cache_key]
            art["competent_skills_gpt"] = cached.get("competent_skills_gpt")
            art["competent_confidence_skills_gpt"] = cached.get("competent_confidence_skills_gpt")
            art["competent_reason_skills_gpt"] = cached.get("competent_reason_skills_gpt")
            art["competent_skills_gpt_status"] = cached.get("competent_skills_gpt_status")
            art["competent_skills_gpt_summary"] = cached.get("competent_skills_gpt_summary")
            art["competent_skills_gpt_occ_only"] = cached.get("competent_skills_gpt_occ_only")
            art["competent_confidence_skills_gpt_occ_only"] = cached.get("competent_confidence_skills_gpt_occ_only")
            art["competent_reason_skills_gpt_occ_only"] = cached.get("competent_reason_skills_gpt_occ_only")
            art["competent_skills_gpt_bio_only"] = cached.get("competent_skills_gpt_bio_only")
            art["competent_confidence_skills_gpt_bio_only"] = cached.get("competent_confidence_skills_gpt_bio_only")
            art["competent_reason_skills_gpt_bio_only"] = cached.get("competent_reason_skills_gpt_bio_only")
            already_scored += 1
        elif skills_entry is None:
            art["competent_skills_gpt"] = None
            art["competent_confidence_skills_gpt"] = 0.0
            art["competent_reason_skills_gpt"] = "No skills entry found for this author."
            art["competent_skills_gpt_status"] = "skipped"
            art["competent_skills_gpt_summary"] = art.get("competent_skills_gpt_summary") or ""
            art["competent_skills_gpt_occ_only"] = False
            art["competent_confidence_skills_gpt_occ_only"] = 0.0
            art["competent_reason_skills_gpt_occ_only"] = "No skills entry found for this author."
            art["competent_skills_gpt_bio_only"] = False
            art["competent_confidence_skills_gpt_bio_only"] = 0.0
            art["competent_reason_skills_gpt_bio_only"] = "No skills entry found for this author."
            missing_skills += 1
            print(f"[skip] Missing skills for author '{akey_raw}' (article {liar2_id or title[:40]})", file=sys.stderr)
        else:
            client = _choose_client(clients, client_counter)
            if client is None:
                art["competent_skills_gpt"] = None
                art["competent_confidence_skills_gpt"] = 0.0
                art["competent_reason_skills_gpt"] = "API disabled (--no-api)."
                art["competent_skills_gpt_status"] = "skipped"
                art["competent_skills_gpt_summary"] = art.get("competent_skills_gpt_summary") or ""
                art["competent_skills_gpt_occ_only"] = False
                art["competent_confidence_skills_gpt_occ_only"] = 0.0
                art["competent_reason_skills_gpt_occ_only"] = "API disabled (--no-api)."
                art["competent_skills_gpt_bio_only"] = False
                art["competent_confidence_skills_gpt_bio_only"] = 0.0
                art["competent_reason_skills_gpt_bio_only"] = "API disabled (--no-api)."
            else:
                claim = base._article_text(art)
                verdict = _judge_competence_dual(
                    client,
                    skills_bio=skills_entry.get("skills_from_bio", []),
                    skills_occ=skills_entry.get("skills_from_occupations", []),
                    claim=claim,
                    model=args.model,
                    temperature=args.temperature,
                )
                if verdict.get("competent") is None:
                    art["competent_skills_gpt"] = None
                    art["competent_confidence_skills_gpt"] = 0.0
                    art["competent_reason_skills_gpt"] = verdict.get("reason")
                    art["competent_skills_gpt_status"] = "skipped"
                    art["competent_skills_gpt_summary"] = verdict.get("summary", "") if isinstance(verdict, dict) else ""
                    art["competent_skills_gpt_occ_only"] = verdict.get("competent_occ")
                    art["competent_confidence_skills_gpt_occ_only"] = verdict.get("competent_confidence_occ")
                    art["competent_reason_skills_gpt_occ_only"] = verdict.get("competent_reason_occ")
                    art["competent_skills_gpt_bio_only"] = verdict.get("competent_bio")
                    art["competent_confidence_skills_gpt_bio_only"] = verdict.get("competent_confidence_bio")
                    art["competent_reason_skills_gpt_bio_only"] = verdict.get("competent_reason_bio")
                    rate_limited += 1
                    print(
                        f"[skip] Rate-limited/skipped for author '{akey_raw}' article {liar2_id or title[:40]} "
                        f"reason: {verdict.get('reason')}",
                        file=sys.stderr,
                    )
                else:
                    art["competent_skills_gpt"] = bool(verdict["competent"])
                    art["competent_confidence_skills_gpt"] = verdict["confidence"]
                    art["competent_reason_skills_gpt"] = verdict["reason"]
                    art["competent_skills_gpt_status"] = "scored"
                    art["competent_skills_gpt_summary"] = verdict.get("summary", "")
                    art["competent_skills_gpt_occ_only"] = verdict.get("competent_occ")
                    art["competent_confidence_skills_gpt_occ_only"] = verdict.get("competent_confidence_occ")
                    art["competent_reason_skills_gpt_occ_only"] = verdict.get("competent_reason_occ")
                    art["competent_skills_gpt_bio_only"] = verdict.get("competent_bio")
                    art["competent_confidence_skills_gpt_bio_only"] = verdict.get("competent_confidence_bio")
                    art["competent_reason_skills_gpt_bio_only"] = verdict.get("competent_reason_bio")
                    rescored += 1
                    if cache_fh:
                        write_cache_line(cache_fh, cache_key, art)
                    if args.sleep_s and args.sleep_s > 0:
                        time.sleep(args.sleep_s)

        processed_targets += 1
        if args.limit and rescored >= args.limit:
            print(f"[info] Limit of {args.limit} reached; stopping early.", file=sys.stderr)
            break
        if args.progress_every and processed_targets % args.progress_every == 0:
            elapsed = time.time() - start
            print(
                f"[progress] {processed_targets}/{total_targets} skipped articles processed in {elapsed:.1f}s",
                file=sys.stderr,
            )

    if cache_fh:
        cache_fh.close()

    args.output_json.write_text(json.dumps(people, ensure_ascii=False, indent=2))

    print("Rescore summary:")
    print(f"  Articles examined with status skipped/None: {skipped_total}")
    print(f"  Rescored via API: {rescored}")
    print(f"  Restored from cache: {already_scored}")
    print(f"  Missing skills entry: {missing_skills}")
    print(f"  Rate-limited/left skipped: {rate_limited}")
    print(f"  Output written to: {args.output_json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
