#!/usr/bin/env python3
"""
Build canonical GPT and RoBERTa+Nesta LIAR2 ablation assets.

For each family this script writes:
  - flat.csv
  - train_augmented.csv
  - valid_augmented.csv
  - test_augmented.csv
  - metadata.json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, DefaultDict, Dict, Iterable, List, Tuple

import pandas as pd

from flatten_grouped_competence_json_to_csv import (
    CANONICAL_ABLATION_DIR,
    FAMILY_SPECS,
    LIAR2_ROOT,
    collapse_ws,
    discover_article_fields,
    family_json_path,
    family_output_dir,
    flatten_rows,
    load_grouped_data,
    write_csv,
)


RAW_SPLITS_DIR = LIAR2_ROOT / "data" / "raw" / "liar2"
SPLITS = ("train", "valid", "test")


def parse_family_list(raw: str) -> List[str]:
    if raw.strip().lower() == "all":
        return list(FAMILY_SPECS.keys())

    families: List[str] = []
    seen = set()
    for item in raw.split(","):
        family = item.strip()
        if not family:
            continue
        if family not in FAMILY_SPECS:
            raise argparse.ArgumentTypeError(
                f"Unknown family {family!r}. Expected one of: {', '.join(sorted(FAMILY_SPECS))}"
            )
        if family in seen:
            continue
        seen.add(family)
        families.append(family)

    if not families:
        raise argparse.ArgumentTypeError("At least one family is required.")
    return families


def normalize_id(value: Any) -> str:
    text = str(value or "").strip()
    return text


def parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"true", "1", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    if not text or text in {"none", "nan"}:
        return None
    return None


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        text = str(value).strip()
        if not text or text.lower() in {"none", "nan"}:
            return None
        return float(text)
    except (TypeError, ValueError):
        return None


def grouped_article_payloads(data: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    payloads: List[Dict[str, Any]] = []
    key_occurrence: Counter[tuple[str, str]] = Counter()
    for author_idx, author in enumerate(data):
        speaker = collapse_ws(author.get("liar2_author_key"))
        speaker_key = speaker.lower()
        for article_idx, article in enumerate(author.get("articles") or []):
            if not isinstance(article, dict):
                continue
            statement = collapse_ws(article.get("liar2_statement"))
            key = (speaker_key, statement)
            occurrence = key_occurrence[key]
            key_occurrence[key] += 1
            payloads.append(
                {
                    "speaker": speaker,
                    "speaker_key": speaker_key,
                    "statement": statement,
                    "liar2_id": normalize_id(article.get("liar2_id")),
                    "news_status": article.get("news-status"),
                    "competent": parse_bool(article.get("competent_skills_gpt")),
                    "confidence": parse_float(article.get("competent_confidence_skills_gpt")),
                    "reason": article.get("competent_reason_skills_gpt"),
                    "status": article.get("competent_skills_gpt_status"),
                    "source_author_index": author_idx,
                    "source_article_index": article_idx,
                    "key_occurrence": occurrence,
                }
            )
    return payloads


def build_bucket_maps(
    payloads: Iterable[Dict[str, Any]],
) -> tuple[DefaultDict[str, List[Dict[str, Any]]], DefaultDict[Tuple[str, str], List[Dict[str, Any]]]]:
    id_buckets: DefaultDict[str, List[Dict[str, Any]]] = defaultdict(list)
    key_buckets: DefaultDict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for payload in payloads:
        liar2_id = payload["liar2_id"]
        if liar2_id:
            id_buckets[liar2_id].append(payload)
        key_buckets[(payload["speaker_key"], payload["statement"])].append(payload)
    return id_buckets, key_buckets


def build_flat_csv(family: str, grouped_json: Path, output_dir: Path) -> tuple[Path, int]:
    grouped_data = load_grouped_data(grouped_json)
    article_fields = discover_article_fields(grouped_data)
    fieldnames = ["name", "surname", "liar2_author_key"] + article_fields + [
        field
        for field in ("speaker", "statement", "news_status", "article_index", "source_author_index", "source_article_index", "key_occurrence")
        if field not in article_fields
    ]
    rows = flatten_rows(grouped_data, article_fields)
    flat_csv = output_dir / "flat.csv"
    write_csv(flat_csv, fieldnames, rows)
    return flat_csv, len(rows)


def split_row_key(row: pd.Series) -> tuple[str, str]:
    return (
        collapse_ws(row.get("speaker")).lower(),
        collapse_ws(row.get("statement")),
    )


def split_row_id(row: pd.Series) -> str:
    return normalize_id(row.get("id"))


def augment_split(
    split_name: str,
    csv_path: Path,
    family: str,
    id_buckets: DefaultDict[str, List[Dict[str, Any]]],
    key_buckets: DefaultDict[Tuple[str, str], List[Dict[str, Any]]],
    output_dir: Path,
) -> tuple[int, Counter[str], List[Dict[str, Any]], Counter[str], Counter[Tuple[str, str]], Counter[str]]:
    df = pd.read_csv(csv_path)
    id_usage: Counter[str] = Counter()
    key_usage: Counter[Tuple[str, str]] = Counter()
    strategy_counts: Counter[str] = Counter()
    unmatched_split_rows: List[Dict[str, Any]] = []
    output_rows: List[Dict[str, Any]] = []
    null_counts: Counter[str] = Counter()

    for _, row in df.iterrows():
        matched: Dict[str, Any] | None = None
        strategy = ""

        if family == "roberta_nesta":
            liar2_id = split_row_id(row)
            bucket = id_buckets.get(liar2_id, [])
            occurrence = id_usage[liar2_id]
            if bucket and occurrence < len(bucket):
                matched = bucket[occurrence]
                strategy = "liar2_id"
            elif bucket:
                matched = bucket[-1]
                strategy = "liar2_id_reused_last"
            id_usage[liar2_id] += 1
        else:
            key = split_row_key(row)
            bucket = key_buckets.get(key, [])
            occurrence = key_usage[key]
            if bucket and occurrence < len(bucket):
                matched = bucket[occurrence]
                strategy = "speaker_statement_occurrence"
            elif bucket:
                matched = bucket[-1]
                strategy = "speaker_statement_reused_last"
            key_usage[key] += 1

        if matched is None:
            unmatched_split_rows.append(
                {
                    "split": split_name,
                    "id": split_row_id(row),
                    "speaker": collapse_ws(row.get("speaker")),
                    "statement": collapse_ws(row.get("statement")),
                }
            )
            strategy = "unmatched"
            competent = None
            confidence = None
            reason = None
        else:
            competent = matched.get("competent")
            confidence = matched.get("confidence")
            reason = matched.get("reason")

        strategy_counts[strategy] += 1
        if competent is None:
            null_counts["competent"] += 1
        if confidence is None:
            null_counts["confidence"] += 1
        if not reason:
            null_counts["reason"] += 1

        out_row = row.to_dict()
        out_row["skills_gpt_competent"] = competent
        out_row["confidence_gpt"] = confidence
        out_row["gpt_reason"] = reason
        out_row["competence_source_family"] = family
        out_row["competence_match_strategy"] = strategy
        output_rows.append(out_row)

    output_df = pd.DataFrame(output_rows)
    output_path = output_dir / f"{split_name}_augmented.csv"
    output_df.to_csv(output_path, index=False)
    return (
        len(output_df),
        strategy_counts,
        unmatched_split_rows,
        null_counts,
        key_usage,
        id_usage,
    )


def collect_unmatched_grouped(
    family: str,
    id_buckets: DefaultDict[str, List[Dict[str, Any]]],
    key_buckets: DefaultDict[Tuple[str, str], List[Dict[str, Any]]],
    key_usage: Counter[Tuple[str, str]],
    id_usage: Counter[str],
    limit: int = 10,
) -> tuple[int, List[Dict[str, Any]]]:
    unmatched_total = 0
    examples: List[Dict[str, Any]] = []

    if family == "roberta_nesta":
        for liar2_id, bucket in id_buckets.items():
            used = id_usage.get(liar2_id, 0)
            if used >= len(bucket):
                continue
            for payload in bucket[used:]:
                unmatched_total += 1
                if len(examples) < limit:
                    examples.append(payload)
    else:
        for key, bucket in key_buckets.items():
            used = key_usage.get(key, 0)
            if used >= len(bucket):
                continue
            for payload in bucket[used:]:
                unmatched_total += 1
                if len(examples) < limit:
                    examples.append(payload)

    return unmatched_total, examples


def duplicate_bucket_stats(
    family: str,
    id_buckets: DefaultDict[str, List[Dict[str, Any]]],
    key_buckets: DefaultDict[Tuple[str, str], List[Dict[str, Any]]],
    split_key_counts: Counter[Tuple[str, str]],
    split_id_counts: Counter[str],
) -> Dict[str, int]:
    if family == "roberta_nesta":
        duplicate_bucket_count = sum(1 for bucket in id_buckets.values() if len(bucket) > 1)
        mismatched_bucket_count = sum(
            1 for liar2_id, bucket in id_buckets.items() if split_id_counts.get(liar2_id, 0) != len(bucket)
        )
        surplus_total = sum(
            max(len(bucket) - split_id_counts.get(liar2_id, 0), 0) for liar2_id, bucket in id_buckets.items()
        )
        reused_total = sum(
            max(split_id_counts.get(liar2_id, 0) - len(bucket), 0) for liar2_id, bucket in id_buckets.items()
        )
    else:
        duplicate_bucket_count = sum(1 for bucket in key_buckets.values() if len(bucket) > 1)
        mismatched_bucket_count = sum(
            1 for key, bucket in key_buckets.items() if split_key_counts.get(key, 0) != len(bucket)
        )
        surplus_total = sum(max(len(bucket) - split_key_counts.get(key, 0), 0) for key, bucket in key_buckets.items())
        reused_total = sum(max(split_key_counts.get(key, 0) - len(bucket), 0) for key, bucket in key_buckets.items())

    return {
        "duplicate_bucket_count": duplicate_bucket_count,
        "mismatched_bucket_count": mismatched_bucket_count,
        "surplus_grouped_rows_total": surplus_total,
        "reused_grouped_rows_total": reused_total,
        "net_extra_grouped_rows_total": surplus_total - reused_total,
    }


def build_family_assets(family: str, splits_dir: Path, output_root: Path) -> Dict[str, Any]:
    grouped_json = family_json_path(family)
    output_dir = output_root / family
    output_dir.mkdir(parents=True, exist_ok=True)

    grouped_data = load_grouped_data(grouped_json)
    payloads = grouped_article_payloads(grouped_data)
    id_buckets, key_buckets = build_bucket_maps(payloads)

    flat_csv, flat_rows = build_flat_csv(family, grouped_json, output_dir)

    split_key_counts: Counter[Tuple[str, str]] = Counter()
    split_id_counts: Counter[str] = Counter()
    for split_name in SPLITS:
        split_df = pd.read_csv(splits_dir / f"{split_name}.csv")
        for _, row in split_df.iterrows():
            split_key_counts[split_row_key(row)] += 1
            split_id = split_row_id(row)
            if split_id:
                split_id_counts[split_id] += 1

    split_row_counts: Dict[str, int] = {}
    strategy_counts_total: Counter[str] = Counter()
    null_counts_total: Counter[str] = Counter()
    unmatched_split_examples: List[Dict[str, Any]] = []
    key_usage_total: Counter[Tuple[str, str]] = Counter()
    id_usage_total: Counter[str] = Counter()

    for split_name in SPLITS:
        count, strategy_counts, unmatched_split_rows, null_counts, key_usage, id_usage = augment_split(
            split_name=split_name,
            csv_path=splits_dir / f"{split_name}.csv",
            family=family,
            id_buckets=id_buckets,
            key_buckets=key_buckets,
            output_dir=output_dir,
        )
        split_row_counts[split_name] = count
        strategy_counts_total.update(strategy_counts)
        null_counts_total.update(null_counts)
        unmatched_split_examples.extend(unmatched_split_rows)
        key_usage_total.update(key_usage)
        id_usage_total.update(id_usage)

    unmatched_grouped_total, unmatched_grouped_examples = collect_unmatched_grouped(
        family=family,
        id_buckets=id_buckets,
        key_buckets=key_buckets,
        key_usage=key_usage_total,
        id_usage=id_usage_total,
    )

    duplicate_stats = duplicate_bucket_stats(
        family=family,
        id_buckets=id_buckets,
        key_buckets=key_buckets,
        split_key_counts=split_key_counts,
        split_id_counts=split_id_counts,
    )

    metadata: Dict[str, Any] = {
        "family": family,
        "grouped_source_json": str(grouped_json),
        "output_dir": str(output_dir),
        "flat_csv": str(flat_csv),
        "split_outputs": {split: str(output_dir / f"{split}_augmented.csv") for split in SPLITS},
        "grouped_article_count": len(payloads),
        "flat_row_count": flat_rows,
        "split_row_counts": split_row_counts,
        "columns_added": [
            "skills_gpt_competent",
            "confidence_gpt",
            "gpt_reason",
            "competence_source_family",
            "competence_match_strategy",
        ],
        "match_preference": "liar2_id" if family == "roberta_nesta" else "speaker_statement",
        "match_strategy_counts": dict(strategy_counts_total),
        "null_feature_counts": dict(null_counts_total),
        "unmatched_split_rows_total": len(unmatched_split_examples),
        "unmatched_split_rows_examples": unmatched_split_examples[:10],
        "unmatched_grouped_rows_total": unmatched_grouped_total,
        "unmatched_grouped_rows_examples": unmatched_grouped_examples[:10],
        **duplicate_stats,
    }

    metadata_path = output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"[{family}] grouped={len(payloads)} flat={flat_rows} output={output_dir}")
    for split_name in SPLITS:
        print(f"  {split_name}: {split_row_counts[split_name]} rows")
    print(f"  match strategies: {dict(strategy_counts_total)}")
    print(
        "  grouped duplicates:",
        {
            "duplicate_bucket_count": duplicate_stats["duplicate_bucket_count"],
            "mismatched_bucket_count": duplicate_stats["mismatched_bucket_count"],
            "surplus_grouped_rows_total": duplicate_stats["surplus_grouped_rows_total"],
            "reused_grouped_rows_total": duplicate_stats["reused_grouped_rows_total"],
            "net_extra_grouped_rows_total": duplicate_stats["net_extra_grouped_rows_total"],
        },
    )
    print(f"  metadata: {metadata_path}")

    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--families",
        type=parse_family_list,
        default=list(FAMILY_SPECS.keys()),
        help="Comma-separated families or `all` (default: all).",
    )
    parser.add_argument(
        "--splits-dir",
        type=Path,
        default=RAW_SPLITS_DIR,
        help=f"Directory containing train.csv, valid.csv, test.csv (default: {RAW_SPLITS_DIR}).",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=CANONICAL_ABLATION_DIR,
        help=f"Canonical output root (default: {CANONICAL_ABLATION_DIR}).",
    )
    args = parser.parse_args()

    args.output_root.mkdir(parents=True, exist_ok=True)

    for family in args.families:
        build_family_assets(
            family=family,
            splits_dir=args.splits_dir,
            output_root=args.output_root,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
