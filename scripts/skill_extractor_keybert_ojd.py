#!/usr/bin/env python3
"""
Pipeline per input text:
1) Call KeyBERT service to get candidate keywords/phrases.
2) Map those keywords to ESCO using OJD-DAPS `/keyword_to_skills`.
3) Run OJD-DAPS `/extract` on the full text.
4) Merge/dedupe skills and emit JSONL with keywords and both skill sources.

Defaults assume local docker-compose:
 - KeyBertService on http://localhost:5003/keywords
 - Ojd_service1 on http://localhost:5005 (endpoints: /extract, /keyword_to_skills)
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Tuple

import requests
from tqdm import tqdm


def call_keybert(text: str, url: str, top_n: int, nr_candidates: int, ngram_max: int, diversity: float,
                 score_threshold: float, use_mmr: bool) -> List[str]:
    params = {
        "doc": text,
        "top_n": top_n,
        "nr_candidates": nr_candidates,
        "ngram_max": ngram_max,
        "diversity": diversity,
        "score_threshold": score_threshold,
        "use_mmr": "true" if use_mmr else "false",
    }
    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("keywords", [])


def call_keyword_to_skills(keywords: List[str], base_url: str) -> List[Dict[str, Any]]:
    if not keywords:
        return []
    # The service accepts keywords as a JSON array string in the 'keywords' query param.
    params = {"keywords": json.dumps(keywords)}
    resp = requests.get(f"{base_url.rstrip('/')}/keyword_to_skills", params=params, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data.get("skills", []) or []


def call_text_extract(text: str, base_url: str) -> List[Dict[str, Any]]:
    payload = {"text": text}
    resp = requests.post(f"{base_url.rstrip('/')}/extract", json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data.get("skills", []) or data.get("results", [])[0].get("mapped_skills", []) if data.get("results") else []


def dedupe_skills(skills: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for s in skills:
        key = (s.get("match_id") or s.get("skillURI") or s.get("skill_id") or s.get("name"),
               s.get("match_skill") or s.get("skillname"))
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def iter_inputs(path: str):
    fh = sys.stdin if path == "-" else open(path, "r", encoding="utf-8")
    with fh:
        for idx, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            # allow JSON line with {"id":..., "text":...}
            if line.startswith("{"):
                obj = json.loads(line)
                yield obj.get("id", idx), obj.get("text", "")
            else:
                yield idx, line


def main():
    ap = argparse.ArgumentParser(description="Extract ESCO skills using KeyBERT + OJD-DAPS.")
    ap.add_argument("--input", required=True, help="Input file (one text per line, or JSONL with {text}).")
    ap.add_argument("--output", required=True, help="Output JSONL path.")
    ap.add_argument("--keybert-url", default="http://localhost:5003/keywords")
    ap.add_argument("--skills-url", default="http://localhost:5005")
    ap.add_argument("--top-n", type=int, default=50)
    ap.add_argument("--nr-candidates", type=int, default=200)
    ap.add_argument("--ngram-max", type=int, default=3)
    ap.add_argument("--diversity", type=float, default=0.7)
    ap.add_argument("--score-threshold", type=float, default=0.2)
    ap.add_argument("--no-mmr", action="store_true", help="Disable MMR in KeyBERT.")
    args = ap.parse_args()

    use_mmr = not args.no_mmr

    with open(args.output, "w", encoding="utf-8") as out_f:
        for idx, text in tqdm(list(iter_inputs(args.input)), desc="Texts"):
            try:
                keywords = call_keybert(
                    text=text,
                    url=args.keybert_url,
                    top_n=args.top_n,
                    nr_candidates=args.nr_candidates,
                    ngram_max=args.ngram_max,
                    diversity=args.diversity,
                    score_threshold=args.score_threshold,
                    use_mmr=use_mmr,
                )
                skills_kw = call_keyword_to_skills(keywords, args.skills_url)
                skills_text = call_text_extract(text, args.skills_url)
                merged = dedupe_skills((skills_kw or []) + (skills_text or []))
                out = {
                    "id": idx,
                    "text": text,
                    "keywords": keywords,
                    "skills_from_keywords": skills_kw,
                    "skills_from_text": skills_text,
                    "skills_merged": merged,
                }
                out_f.write(json.dumps(out) + "\n")
            except Exception as e:
                sys.stderr.write(f"Error on id={idx}: {e}\n")
                out_f.write(json.dumps({"id": idx, "text": text, "error": str(e)}) + "\n")


if __name__ == "__main__":
    main()
