#!/usr/bin/env python3
import argparse
import json
import re
import sys
import time
from typing import Any, Dict, List

import requests


DEFAULT_TEXT = (
    "Gina Raimondo holds a Bachelor of Arts degree from Harvard University and a Juris Doctor from Yale Law School. "
    "She co-founded and served as CEO of the venture capital firm Point Judith Capital. "
    "Raimondo was the 75th Governor of Rhode Island from 2015 to 2021, focusing on economic development and fiscal "
    "policy. In 2021, she was appointed as the 40th United States Secretary of Commerce. Her main areas of expertise "
    "include public administration, economic policy, and investment management."
)

# Multi-word tokens we want to keep intact before falling back to word tokenization.
PHRASE_TOKENS = [
    "Bachelor of Arts",
    "Juris Doctor",
]

TOKEN_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")


def tokenize(text: str) -> List[str]:
    text = text or ""
    out: List[str] = []
    i = 0
    # Precompile phrase regexes (case-insensitive, word-boundary-ish).
    phrase_res = [
        re.compile(r"\b" + re.escape(p) + r"\b", flags=re.IGNORECASE) for p in PHRASE_TOKENS
    ]
    while i < len(text):
        best = None
        best_end = None
        for rx, phrase in zip(phrase_res, PHRASE_TOKENS):
            m = rx.search(text, i)
            if not m:
                continue
            if best is None or m.start() < best.start() or (m.start() == best.start() and m.end() > best_end):
                best = m
                best_end = m.end()
                best_phrase = phrase
        if best is None:
            break
        # Tokenize any gap before the phrase.
        gap = text[i : best.start()]
        out.extend(TOKEN_RE.findall(gap))
        out.append(best_phrase)
        i = best.end()

    # Remainder
    out.extend(TOKEN_RE.findall(text[i:]))
    return out


def _get_keybert_keywords(
    session: requests.Session,
    *,
    url: str,
    doc: str,
    top_n: int,
    ngram_max: int,
    score_threshold: float,
) -> List[str]:
    r = session.get(
        url,
        params={
            "doc": doc,
            "top_n": str(top_n),
            "ngram_max": str(ngram_max),
            "score_threshold": str(score_threshold),
        },
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    kws = data.get("keywords") if isinstance(data, dict) else None
    if not isinstance(kws, list):
        return []
    out: List[str] = []
    for k in kws:
        if isinstance(k, str) and k.strip():
            out.append(k.strip())
    return out


def _call_keyword_to_skills(session: requests.Session, *, url: str, keywords: List[str], timeout_s: float) -> Dict[str, Any]:
    # Service expects keywords as a JSON string in the query param.
    params = {"keywords": json.dumps(keywords, ensure_ascii=False)}
    r = session.get(url, params=params, timeout=timeout_s)
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, dict) else {"raw": data}

def _call_extract(session: requests.Session, *, url: str, text: str, timeout_s: float) -> Dict[str, Any]:
    r = session.post(url, json={"text": text}, timeout=timeout_s)
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, dict) else {"raw": data}

def _augment_keywords_with_phrases(keywords: List[str], *, text: str) -> List[str]:
    """
    Ensure our known multi-word phrase tokens are included when present in the text,
    even if KeyBERT doesn't surface them.
    """
    out = list(keywords)
    seen = {k.lower() for k in out if isinstance(k, str)}
    t_low = (text or "").lower()
    for phrase in PHRASE_TOKENS:
        if phrase.lower() in t_low and phrase.lower() not in seen:
            out.append(phrase)
            seen.add(phrase.lower())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Extract keywords and call Nesta/OJD-DAPS skill mapping.\n\n"
            "Modes:\n"
            "  - keybert (default): call KeyBERT service, then call Nesta /keyword_to_skills\n"
            "  - tokens: tokenize locally and call Nesta /extract per token (legacy)\n"
        )
    )
    ap.add_argument(
        "--text",
        help="Input text to tokenize (default: built-in Gina Raimondo sample).",
        default=None,
    )
    ap.add_argument("--text-file", help="Read input text from a file.")
    ap.add_argument("--mode", choices=["keybert", "tokens"], default="keybert")
    ap.add_argument("--skills-url", default="http://localhost:5005/extract", help="Nesta /extract URL (tokens mode).")
    ap.add_argument(
        "--keyword-to-skills-url",
        default="http://localhost:5005/keyword_to_skills",
        help="Nesta keyword->skills URL (keybert mode).",
    )
    ap.add_argument(
        "--keybert-url",
        default="http://localhost:5003/keywords",
        help="KeyBERT service URL (keybert mode).",
    )
    ap.add_argument("--top-n", type=int, default=30, help="KeyBERT top_n (default: 30).")
    ap.add_argument("--ngram-max", type=int, default=2, help="KeyBERT ngram_max (default: 2).")
    ap.add_argument("--score-threshold", type=float, default=0.30, help="KeyBERT score_threshold (default: 0.30).")
    ap.add_argument(
        "--per-keyword",
        action="store_true",
        help="In keybert mode, call Nesta once per keyword (default calls once with all keywords).",
    )
    ap.add_argument(
        "--fallback-extract",
        action="store_true",
        help="If keyword_to_skills returns no skills for a keyword, also call /extract for that keyword.",
    )
    ap.add_argument(
        "--print-full",
        action="store_true",
        help="Print full JSON response(s) instead of only `.skills`.",
    )
    ap.add_argument("--sleep-s", type=float, default=0.0, help="Sleep between requests.")
    ap.add_argument("--timeout-s", type=float, default=30.0, help="HTTP timeout.")
    ap.add_argument("--limit", type=int, default=None, help="Only process first N tokens.")
    args = ap.parse_args()

    if args.text_file:
        with open(args.text_file, "r", encoding="utf-8") as f:
            text = f.read()
    else:
        text = args.text if args.text is not None else DEFAULT_TEXT

    session = requests.Session()

    if args.mode == "keybert":
        keywords = _get_keybert_keywords(
            session,
            url=args.keybert_url,
            doc=text,
            top_n=args.top_n,
            ngram_max=args.ngram_max,
            score_threshold=args.score_threshold,
        )
        keywords = _augment_keywords_with_phrases(keywords, text=text)
        if args.limit is not None:
            keywords = keywords[: args.limit]

        if not keywords:
            print("No keywords returned by KeyBERT.", file=sys.stderr)
            return 2

        if args.per_keyword:
            for i, kw in enumerate(keywords, start=1):
                try:
                    data = _call_keyword_to_skills(
                        session,
                        url=args.keyword_to_skills_url,
                        keywords=[kw],
                        timeout_s=args.timeout_s,
                    )
                except Exception as e:
                    print(f"== {i}/{len(keywords)} {kw} ==\nERROR: {e}\n", file=sys.stderr)
                    continue
                print(f"== {i}/{len(keywords)} {kw} ==")
                skills = data.get("skills", [])
                if args.print_full:
                    print(json.dumps(data, ensure_ascii=False, indent=2))
                else:
                    print(json.dumps(skills, ensure_ascii=False, indent=2))
                if args.fallback_extract and (not isinstance(skills, list) or len(skills) == 0):
                    try:
                        extra = _call_extract(session, url=args.skills_url, text=kw, timeout_s=args.timeout_s)
                        print("-- fallback /extract --")
                        if args.print_full:
                            print(json.dumps(extra, ensure_ascii=False, indent=2))
                        else:
                            print(json.dumps(extra.get("skills", []), ensure_ascii=False, indent=2))
                    except Exception as e:
                        print(f"-- fallback /extract ERROR: {e}", file=sys.stderr)
                print()
                if args.sleep_s and args.sleep_s > 0:
                    time.sleep(args.sleep_s)
        else:
            data = _call_keyword_to_skills(
                session,
                url=args.keyword_to_skills_url,
                keywords=keywords,
                timeout_s=args.timeout_s,
            )
            print(json.dumps(data, ensure_ascii=False, indent=2))
            print()
        return 0

    # tokens mode (legacy)
    tokens = tokenize(text)
    if args.limit is not None:
        tokens = tokens[: args.limit]
    for i, tok in enumerate(tokens, start=1):
        payload = {"text": tok}
        try:
            r = session.post(args.skills_url, json=payload, timeout=args.timeout_s)
            r.raise_for_status()
            data = r.json() if r.content else {}
        except Exception as e:
            print(f"== {i}/{len(tokens)} {tok} ==\nERROR: {e}\n", file=sys.stderr)
            continue

        skills = data.get("skills", [])
        print(f"== {i}/{len(tokens)} {tok} ==")
        print(json.dumps(skills, ensure_ascii=False, indent=2))
        print()
        if args.sleep_s and args.sleep_s > 0:
            time.sleep(args.sleep_s)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
