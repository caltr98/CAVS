#!/usr/bin/env python3
"""
Build a combined competence-classification input JSON across LIAR2 test + train + valid.

Behavior:
- Starts from an existing test competence JSON (with or without competent_gpt fields).
- Adds articles from train/valid CSVs.
- Prefers external bios for speakers; falls back to speaker_description.
- Skips obvious non-person speaker names by default.

Run this first, then feed the output to gpt_competence_classifier.py with --resume to avoid
re-asking GPT for already-judged test articles.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from typing import Any, Dict, List, Tuple


def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split()).strip()


def _norm_key(s: str) -> str:
    return _collapse_ws(s).lower()


def is_probable_person(name: str) -> bool:
    """
    Heuristic to avoid orgs/collectives (citizens groups, parties, counties, PACs, etc.).
    """
    n = _norm_key(name)
    if not n:
        return False

    bad_prefixes = (
        "citizens ",
        "citizen ",
        "americans for ",
        "americans against ",
        "people for ",
        "people against ",
        "friends of ",
        "students for ",
        "students of ",
        "committee to ",
        "committee for ",
        "campaign for ",
        "campaign to ",
        "coalition ",
        "county ",
        "city of ",
        "state of ",
        "office of ",
        "department of ",
    )
    if any(n.startswith(p) for p in bad_prefixes):
        return False

    org_keywords = {
        "association",
        "foundation",
        "committee",
        "council",
        "coalition",
        "campaign",
        "party",
        "pac",
        "alliance",
        "federation",
        "union",
        "group",
        "organization",
        "organisation",
        "company",
        "corporation",
        "inc",
        "ltd",
        "llc",
        "corp",
        "press",
        "media",
        "news",
        "network",
        "agency",
        "bureau",
        "department",
        "office",
        "administration",
        "ministry",
        "authority",
        "commission",
        "board",
        "chapter",
        "club",
        "team",
        "school",
        "university",
        "college",
        "hospital",
        "center",
        "centre",
        "institute",
        "society",
        "church",
        "diocese",
        "county",
        "city",
        "district",
        "state",
        "government",
        "senate",
        "house",
        "legislature",
        "parliament",
        "assembly",
        "caucus",
        "democrats",
        "republicans",
        "gop",
        "citizens",
        "voters",
        "residents",
        "people",
        "americans",
    }
    if any(k in n for k in org_keywords):
        return False

    if ((" for " in n) or (" of " in n)) and len(n.split()) >= 4:
        return False

    if re.search(r"[&/]", n):
        return False

    return True


def load_external_bios(path: str) -> Dict[str, str]:
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        return {}
    bios: Dict[str, str] = {}
    for k, v in raw.items():
        nk = _norm_key(k)
        if not nk:
            continue
        bio = v if isinstance(v, str) else ""
        bio = _collapse_ws(bio)
        if bio:
            bios[nk] = bio
    return bios


def load_existing_authors(path: str) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]], int]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("--test-competence-json must be a JSON list")
    author_map: Dict[str, Dict[str, Any]] = {}
    max_author_id = 0
    for person in data:
        if not isinstance(person, dict):
            continue
        key = _norm_key(person.get("liar2_author_key") or person.get("name") or "")
        if not key:
            continue
        author_map[key] = person
        try:
            max_author_id = max(max_author_id, int(person.get("author_id") or 0))
        except Exception:
            pass
    return data, author_map, max_author_id


def row_to_article(row: Dict[str, str]) -> Dict[str, Any]:
    return {
        "title": row.get("statement", "").strip(),
        "liar2_statement": row.get("statement", "").strip(),
        "liar2_context": row.get("context", "").strip(),
        "liar2_justification": row.get("justification", "").strip(),
        "liar2_id": row.get("id", "").strip(),
        "liar2_label": row.get("label", "").strip(),
        "liar2_subject": row.get("subject", "").strip(),
        "liar2_speaker": row.get("speaker", "").strip(),
        "liar2_state_info": row.get("state_info", "").strip(),
        "liar2_true_counts": row.get("true_counts", "").strip(),
        "liar2_mostly_true_counts": row.get("mostly_true_counts", "").strip(),
        "liar2_half_true_counts": row.get("half_true_counts", "").strip(),
        "liar2_mostly_false_counts": row.get("mostly_false_counts", "").strip(),
        "liar2_false_counts": row.get("false_counts", "").strip(),
        "liar2_pants_on_fire_counts": row.get("pants_on_fire_counts", "").strip(),
    }


def add_articles_from_csv(
    path: str,
    *,
    author_map: Dict[str, Dict[str, Any]],
    authors_list: List[Dict[str, Any]],
    max_author_id: int,
    external_bios: Dict[str, str],
    keep_orgs: bool,
) -> Tuple[int, int, int, int]:
    added_articles = 0
    added_authors = 0
    skipped_orgs = 0
    missing_bio = 0

    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            speaker_raw = row.get("speaker", "") or ""
            speaker_desc = row.get("speaker_description", "") or ""
            key = _norm_key(speaker_raw)
            if not key:
                continue
            if not keep_orgs and not is_probable_person(key):
                skipped_orgs += 1
                continue

            article = row_to_article(row)
            if not article.get("liar2_id") and not article.get("title"):
                continue

            person = author_map.get(key)
            if person is None:
                max_author_id += 1
                bio = external_bios.get(key) or _collapse_ws(speaker_desc)
                if not bio:
                    missing_bio += 1
                person = {
                    "name": speaker_raw,
                    "surname": "",
                    "gender": "unknown",
                    "bio": bio,
                    "bio_source": "external" if key in external_bios else "liar2",
                    "author_id": max_author_id,
                    "articles": [],
                    "bio_variants_count": 1,
                    "bio_conflict_resolved": False,
                    "liar2_author_key": speaker_raw,
                }
                authors_list.append(person)
                author_map[key] = person
                added_authors += 1

            # avoid duplicate articles by liar2_id
            existing_ids = {a.get("liar2_id") for a in person.get("articles") or [] if isinstance(a, dict)}
            if article.get("liar2_id") in existing_ids:
                continue

            person.setdefault("articles", []).append(article)
            added_articles += 1

    return added_articles, added_authors, skipped_orgs, missing_bio


def main() -> int:
    ap = argparse.ArgumentParser(description="Combine LIAR2 test competence JSON with train/valid CSVs for competence scoring.")
    ap.add_argument("--test-competence-json", required=True, help="Existing test competence JSON (will seed authors/articles).")
    ap.add_argument("--train-csv", default="Validation/liar2/dataset/train.csv")
    ap.add_argument("--valid-csv", default="Validation/liar2/dataset/valid.csv")
    ap.add_argument(
        "--external-bios",
        required=True,
        help=(
            "JSON mapping speaker name -> bio "
            "(e.g. Validation/liar2/data/final/bios/bios_of_expertise.json "
            "from Validation/liar2/scripts/bios/generate_bios_openai.py)."
        ),
    )
    ap.add_argument("--output-json", required=True, help="Path to write combined competence input JSON.")
    ap.add_argument("--keep-orgs", action="store_true", help="Keep speakers that look like organizations/collectives.")
    args = ap.parse_args()

    authors_list, author_map, max_author_id = load_existing_authors(args.test_competence_json)
    external_bios = load_external_bios(args.external_bios)

    added_articles_total = 0
    added_authors_total = 0
    skipped_orgs_total = 0
    missing_bio_total = 0

    for split_csv in (args.train_csv, args.valid_csv):
        a_art, a_auth, skipped, missing = add_articles_from_csv(
            split_csv,
            author_map=author_map,
            authors_list=authors_list,
            max_author_id=max_author_id,
            external_bios=external_bios,
            keep_orgs=args.keep_orgs,
        )
        added_articles_total += a_art
        added_authors_total += a_auth
        skipped_orgs_total += skipped
        missing_bio_total += missing
        max_author_id += a_auth

    tmp = args.output_json + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(authors_list, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, args.output_json)

    print(
        json.dumps(
            {
                "authors_total": len(authors_list),
                "added_authors": added_authors_total,
                "added_articles": added_articles_total,
                "skipped_non_person": skipped_orgs_total,
                "missing_bio_fallback_to_desc": missing_bio_total,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
