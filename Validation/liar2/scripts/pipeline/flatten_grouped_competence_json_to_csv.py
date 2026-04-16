#!/usr/bin/env python3
"""
Flatten grouped LIAR2 competence JSON into a row-per-article CSV.

This script now understands the canonical ablation families stored under
Validation/liar2/data/final/ablation and is also imported by the family-aware
asset builder.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List

try:
    from tqdm import tqdm
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency `tqdm`. Install it with `python -m pip install tqdm`.") from exc


def locate_liar2_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "data" / "final" / "ablation").exists() and (parent / "data" / "raw" / "liar2").exists():
            return parent
    raise RuntimeError("Could not locate Validation/liar2 root from flatten_grouped_competence_json_to_csv.py.")


LIAR2_ROOT = locate_liar2_root()
CANONICAL_ABLATION_DIR = LIAR2_ROOT / "data" / "final" / "ablation"

FAMILY_SPECS: Dict[str, Dict[str, str]] = {
    "gpt_competent_classifier": {
        "grouped_json": "liar2_ablation_reference.json",
    },
    "roberta_nesta": {
        "grouped_json": "liar2_roberta_nesta_ablation.json",
    },
}

AUTHOR_FIELDS = ["name", "surname", "liar2_author_key"]
EXTRA_FIELDS = [
    "speaker",
    "statement",
    "news_status",
    "article_index",
    "source_author_index",
    "source_article_index",
    "key_occurrence",
]


def collapse_ws(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def family_json_path(family: str) -> Path:
    if family not in FAMILY_SPECS:
        raise KeyError(f"Unknown family {family!r}")
    return CANONICAL_ABLATION_DIR / FAMILY_SPECS[family]["grouped_json"]


def family_output_dir(family: str) -> Path:
    if family not in FAMILY_SPECS:
        raise KeyError(f"Unknown family {family!r}")
    return CANONICAL_ABLATION_DIR / family


def load_grouped_data(path: Path) -> List[Dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise SystemExit(f"Expected a JSON list in {path}")
    return data


def discover_article_fields(data: List[Dict[str, Any]]) -> List[str]:
    ordered: List[str] = []
    seen = set()
    for author in data:
        for article in author.get("articles") or []:
            if not isinstance(article, dict):
                continue
            for key in article.keys():
                if key in seen:
                    continue
                seen.add(key)
                ordered.append(key)
    return ordered


def flatten_rows(data: List[Dict[str, Any]], article_fields: List[str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    key_counter: Counter[tuple[str, str]] = Counter()
    total_articles = sum(len(author.get("articles") or []) for author in data if isinstance(author, dict))
    pbar = tqdm(total=total_articles, desc="flatten grouped json", unit="article")
    try:
        for author_idx, author in enumerate(data):
            if not isinstance(author, dict):
                continue
            author_base = {field: author.get(field, "") for field in AUTHOR_FIELDS}
            speaker = collapse_ws(author.get("liar2_author_key"))
            speaker_key = speaker.lower()
            for article_idx, article in enumerate(author.get("articles") or []):
                if not isinstance(article, dict):
                    pbar.update(1)
                    continue

                statement = collapse_ws(article.get("liar2_statement"))
                key = (speaker_key, statement)
                key_occurrence = key_counter[key]
                key_counter[key] += 1

                row = dict(author_base)
                for field in article_fields:
                    row[field] = article.get(field, "")

                row["speaker"] = speaker
                row["statement"] = statement
                row["news_status"] = article.get("news-status", "")
                row["article_index"] = article_idx
                row["source_author_index"] = author_idx
                row["source_article_index"] = article_idx
                row["key_occurrence"] = key_occurrence
                rows.append(row)
                pbar.update(1)
    finally:
        pbar.close()
    return rows


def write_csv(output_csv: Path, fieldnames: Iterable[str], rows: List[Dict[str, Any]]) -> None:
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(fieldnames))
        writer.writeheader()
        writer.writerows(rows)


def infer_family(input_json: Path) -> str | None:
    resolved = input_json.resolve()
    for family in FAMILY_SPECS:
        if resolved == family_json_path(family).resolve():
            return family
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--family",
        choices=sorted(FAMILY_SPECS),
        default="gpt_competent_classifier",
        help="Canonical ablation family to flatten (default: %(default)s).",
    )
    parser.add_argument(
        "--input-json",
        type=Path,
        default=None,
        help="Grouped competence JSON to flatten. Defaults to the canonical JSON for --family.",
    )
    parser.add_argument(
        "--output-csv",
        type=Path,
        default=None,
        help="Destination CSV path. Defaults to data/final/ablation/<family>/flat.csv.",
    )
    args = parser.parse_args()

    input_json = args.input_json or family_json_path(args.family)
    family = infer_family(input_json) or args.family
    output_csv = args.output_csv or (family_output_dir(family) / "flat.csv")

    data = load_grouped_data(input_json)
    article_fields = discover_article_fields(data)
    fieldnames = AUTHOR_FIELDS + article_fields + [
        field for field in EXTRA_FIELDS if field not in AUTHOR_FIELDS and field not in article_fields
    ]
    rows = flatten_rows(data, article_fields)
    write_csv(output_csv, fieldnames, rows)

    print(f"Family: {family}")
    print(f"Input JSON: {input_json}")
    print(f"Rows written: {len(rows)}")
    print(f"Output CSV: {output_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
