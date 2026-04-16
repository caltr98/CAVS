#!/usr/bin/env python3
"""
Filter occupation-derived ESCO skills per author by checking relevance against the bio using GPT.

Inputs:
- Bios file (same formats supported by gpt_issue_credentials.py).
- A skills JSONL file produced by gpt_issue_credentials.py (expects skills_from_occupations).

Output:
- JSONL with kept occupation skills per author and counts.

Example:
python3 Validation/gpt_issue_credential_polishing.py \
    --bios-path Validation/liar2/bios_of_expertise.json \
    --input Validation/skills_output.jsonl \
    --output Validation/skills_polished.jsonl \
    --gpt-model gpt_issue_credential_polishing
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from openai import AzureOpenAI
from tqdm import tqdm

# Prefer package-relative import; fall back to local path when executed as a script.
try:
    from .gpt_issue_credentials import _build_openai_client, _collapse_ws, iter_bios  # type: ignore
except ImportError:  # pragma: no cover
    HERE = Path(__file__).resolve().parent
    sys.path.insert(0, str(HERE))
    from gpt_issue_credentials import _build_openai_client, _collapse_ws, iter_bios  # type: ignore


def load_bios_map(path: str) -> Dict[str, str]:
    """Return author -> cleaned bio."""
    bios: Dict[str, str] = {}
    for author, bio in iter_bios(path):
        bios[author] = bio
    return bios


def load_processed(path: str) -> set[str]:
    seen: set[str] = set()
    if not os.path.exists(path):
        return seen
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            name = obj.get("author")
            if isinstance(name, str):
                seen.add(name)
    return seen


def chunked(seq: List[Any], size: int) -> Iterable[List[Any]]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def gpt_issue_credential_polishing(
    client: AzureOpenAI,
    *,
    model: str,
    author: str,
    bio: str,
    skills_batch: List[Dict[str, Any]],
) -> List[Dict[str, str]]:
    """
    Ask GPT to keep only occupation-derived skills that are relevant to the bio.
    Returns a subset of the input batch with refreshed reasons citing the bio.
    """
    if not skills_batch:
        return []

    def _parse(raw: str) -> Optional[List[Tuple[int, str]]]:
        try:
            data = json.loads(raw)
        except Exception:
            return None
        keep = data.get("keep") if isinstance(data, dict) else None
        if isinstance(keep, str) and keep.strip().upper() == "NONE":
            return []
        out: List[Tuple[int, str]] = []
        if isinstance(keep, list):
            for item in keep:
                if not isinstance(item, dict):
                    continue
                idx_raw = item.get("index")
                idx = None
                if isinstance(idx_raw, int):
                    idx = idx_raw
                elif isinstance(idx_raw, str) and idx_raw.isdigit():
                    idx = int(idx_raw)
                reason = _collapse_ws(str(item.get("reason") or ""))
                if idx is None or idx < 1 or idx > len(skills_batch):
                    continue
                out.append((idx - 1, reason))
            return out
        return None

    def _ask(prompt_text: str) -> Tuple[Optional[List[Tuple[int, str]]], str]:
        resp = client.chat.completions.create(
            model=model,
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are an ESCO credentialing auditor. Only keep skills clearly supported by the bio."},
                {"role": "user", "content": prompt_text},
            ],
        )
        raw = resp.choices[0].message.content or ""
        return _parse(raw), raw

    skills_snippet = "\n".join(
        f"- [{idx+1}] {s.get('label') or '<missing label>'}"
        for idx, s in enumerate(skills_batch)
    )
    prompt = (
        "Check which occupation-derived ESCO skills are truly relevant to this author's bio.\n"
        "- Keep only skills with clear support from the bio (roles, domain, evidence).\n"
        '- Respond JSON only: {"keep": [{"index": <number>, "reason": "bio-based justification"}, ...]}.\n'
        "- Indices must come from the list. If none apply, return {\"keep\": []}.\n"
        f"Author: {author}\n"
        f"Bio: {bio}\n"
        "Occupation-derived skills:\n"
        f"{skills_snippet}\n"
    )
    parsed, raw = _ask(prompt)
    if parsed is None:
        retry_prompt = (
            prompt
            + "\nYour previous response was invalid. Reply again with JSON using indices from the list. "
            "If none are relevant, return {\"keep\": []}."
        )
        parsed, raw_retry = _ask(retry_prompt)
        if parsed is None:
            print(f"[warn] Could not parse polishing response for '{author}'. Raw: {raw_retry}")
            return []

    kept: List[Dict[str, str]] = []
    for idx, reason in parsed:
        entry = skills_batch[idx]
        kept.append(
            {
                "uri": entry.get("uri"),
                "label": entry.get("label"),
                "reason": reason or entry.get("reason") or "",
            }
        )
    return kept


def parse_args(argv: List[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Polish occupation-derived skills for relevance using GPT.")
    ap.add_argument("--bios-path", default="Validation/liar2/bios_of_expertise.json", help="Input bios JSON/CSV.")
    ap.add_argument("--input", default="Validation/skills_output.jsonl", help="JSONL produced by gpt_issue_credentials.py.")
    ap.add_argument("--output", required=True, help="Output JSONL path for polished occupation skills.")
    ap.add_argument("--gpt-model", default="gpt-4.1", help="Azure OpenAI deployment to use.")
    ap.add_argument("--batch-size", type=int, default=50, help="How many skills to send per GPT call.")
    ap.add_argument("--max-keep", type=int, default=0, help="Max kept occupation skills per author (<=0 means no cap).")
    ap.add_argument("--resume", action="store_true", help="Resume from existing output JSONL.")
    return ap.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    bios = load_bios_map(args.bios_path)
    client = _build_openai_client()
    processed = load_processed(args.output) if args.resume else set()

    def iter_input(path: str) -> Iterable[Dict[str, Any]]:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                yield obj

    input_records = list(iter_input(args.input))
    with open(args.output, "a" if args.resume else "w", encoding="utf-8") as out_f:
        with tqdm(total=len(input_records), desc="Authors", unit="author") as pbar:
            for rec in input_records:
                author = rec.get("author")
                if not isinstance(author, str):
                    pbar.update(1)
                    continue
                if author in processed:
                    pbar.update(1)
                    continue
                bio = bios.get(author, "")
                if not bio:
                    pbar.update(1)
                    continue
                occ_skills = rec.get("skills_from_occupations") or []
                # Pass through bio-derived skills unchanged.
                raw_bio_skills = rec.get("skills_from_bio")
                if not isinstance(raw_bio_skills, list):
                    raw_bio_skills = rec.get("skills") if isinstance(rec.get("skills"), list) else []
                if not isinstance(occ_skills, list) or not occ_skills:
                    out_f.write(
                        json.dumps(
                            {
                                "author": author,
                                "bio": bio,
                                "kept_occupation_skills": [],
                                "skills_from_bio": raw_bio_skills,
                                "input_occupation_skills_count": 0,
                                "kept_count": 0,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    pbar.update(1)
                    continue

                kept: List[Dict[str, str]] = []
                for batch in chunked(occ_skills, max(1, args.batch_size)):
                    selected = gpt_issue_credential_polishing(
                        client,
                        model=args.gpt_model,
                        author=author,
                        bio=bio,
                        skills_batch=batch,
                    )
                    kept.extend(selected)
                    if args.max_keep > 0 and len(kept) >= args.max_keep:
                        kept = kept[: args.max_keep]
                        break

                out_f.write(
                    json.dumps(
                        {
                            "author": author,
                            "bio": bio,
                            "kept_occupation_skills": kept,
                            "skills_from_bio": raw_bio_skills,
                            "input_occupation_skills_count": len(occ_skills),
                            "kept_count": len(kept),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                pbar.update(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(os.sys.argv[1:]))
