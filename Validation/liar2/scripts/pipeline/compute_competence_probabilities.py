#!/usr/bin/env python3
"""
Print comparable competence/news-status summaries for the canonical LIAR2
ablation families.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List

from flatten_grouped_competence_json_to_csv import FAMILY_SPECS, family_json_path


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


def load_json(path: Path) -> List[Dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise SystemExit(f"Expected a JSON list in {path}")
    return data


def pct(num: float, den: float) -> float:
    return 0.0 if den == 0 else num / den


def safe_float(value: Any) -> float | None:
    try:
        text = str(value).strip()
        if not text or text.lower() in {"none", "nan"}:
            return None
        return float(text)
    except (TypeError, ValueError):
        return None


def summarize(data: Iterable[Dict[str, Any]], competence_field: str, confidence_field: str) -> Dict[str, Any]:
    total_articles = 0
    total_authors = 0
    status_counts = Counter()
    competence_counts = Counter()
    cross_counts = Counter()
    confidence_true: List[float] = []
    confidence_false: List[float] = []
    authors_with_true = 0
    authors_with_false = 0

    for author in data:
        if not isinstance(author, dict):
            continue
        total_authors += 1
        author_statuses = set()
        for article in author.get("articles", []):
            if not isinstance(article, dict):
                continue
            total_articles += 1
            status = article.get("news-status")
            if status in {"true-news", "false-news"}:
                status_counts[status] += 1
                author_statuses.add(status)

            competent = article.get(competence_field)
            if competent is True:
                competence_counts["true"] += 1
                cross_counts[(status, True)] += 1
                conf = safe_float(article.get(confidence_field))
                if conf is not None:
                    confidence_true.append(conf)
            elif competent is False:
                competence_counts["false"] += 1
                cross_counts[(status, False)] += 1
                conf = safe_float(article.get(confidence_field))
                if conf is not None:
                    confidence_false.append(conf)
            else:
                competence_counts["none"] += 1

        if "true-news" in author_statuses:
            authors_with_true += 1
        if "false-news" in author_statuses:
            authors_with_false += 1

    considered = competence_counts["true"] + competence_counts["false"]
    accuracy = pct(
        cross_counts[("true-news", True)] + cross_counts[("false-news", False)],
        considered,
    )

    return {
        "total_articles": total_articles,
        "total_authors": total_authors,
        "status_counts": dict(status_counts),
        "competence_counts": dict(competence_counts),
        "cross_counts": {
            "true_news_and_competent": cross_counts[("true-news", True)],
            "true_news_and_not_competent": cross_counts[("true-news", False)],
            "false_news_and_competent": cross_counts[("false-news", True)],
            "false_news_and_not_competent": cross_counts[("false-news", False)],
        },
        "authors_with_true_news": authors_with_true,
        "authors_with_false_news": authors_with_false,
        "accuracy_vs_news_status": accuracy,
        "confidence_true": confidence_true,
        "confidence_false": confidence_false,
    }


def describe_confidence(values: List[float]) -> Dict[str, float] | None:
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)

    def q(frac: float) -> float:
        idx = (n - 1) * frac
        lower = int(idx)
        upper = min(lower + 1, n - 1)
        weight = idx - lower
        return ordered[lower] * (1 - weight) + ordered[upper] * weight

    return {
        "count": float(n),
        "mean": sum(ordered) / n,
        "min": ordered[0],
        "q25": q(0.25),
        "median": q(0.50),
        "q75": q(0.75),
        "max": ordered[-1],
    }


def print_family_summary(family: str, path: Path, summary: Dict[str, Any]) -> None:
    status_counts = summary["status_counts"]
    competence_counts = summary["competence_counts"]
    cross_counts = summary["cross_counts"]

    print(f"=== {family} ===")
    print(f"source_json={path}")
    print(f"total_articles={summary['total_articles']}")
    print(f"total_authors={summary['total_authors']}")
    print(f"true_news_articles={status_counts.get('true-news', 0)}")
    print(f"false_news_articles={status_counts.get('false-news', 0)}")
    print(f"competent_true_articles={competence_counts.get('true', 0)}")
    print(f"competent_false_articles={competence_counts.get('false', 0)}")
    print(f"competent_none_articles={competence_counts.get('none', 0)}")
    print(f"P(true-news)={pct(status_counts.get('true-news', 0), summary['total_articles']):.4f}")
    print(f"P(false-news)={pct(status_counts.get('false-news', 0), summary['total_articles']):.4f}")
    print(f"authors_with_true_news={summary['authors_with_true_news']}")
    print(f"authors_with_false_news={summary['authors_with_false_news']}")
    print(
        "cross_tab="
        f"true_and_competent:{cross_counts['true_news_and_competent']} "
        f"true_and_not:{cross_counts['true_news_and_not_competent']} "
        f"false_and_competent:{cross_counts['false_news_and_competent']} "
        f"false_and_not:{cross_counts['false_news_and_not_competent']}"
    )
    print(f"accuracy_vs_news_status={summary['accuracy_vs_news_status']:.4f}")

    true_desc = describe_confidence(summary["confidence_true"])
    false_desc = describe_confidence(summary["confidence_false"])
    if true_desc:
        print(
            "confidence_true="
            + " ".join(f"{key}:{value:.4f}" for key, value in true_desc.items())
        )
    else:
        print("confidence_true=none")
    if false_desc:
        print(
            "confidence_false="
            + " ".join(f"{key}:{value:.4f}" for key, value in false_desc.items())
        )
    else:
        print("confidence_false=none")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--families",
        type=parse_family_list,
        default=list(FAMILY_SPECS.keys()),
        help="Comma-separated families or `all` (default: all).",
    )
    parser.add_argument(
        "--data",
        type=Path,
        default=None,
        help="Optional explicit grouped JSON path. If set, only one family summary is printed.",
    )
    parser.add_argument(
        "--competence-field",
        default="competent_skills_gpt",
        help="Grouped JSON competence field name (default: %(default)s).",
    )
    parser.add_argument(
        "--confidence-field",
        default="competent_confidence_skills_gpt",
        help="Grouped JSON confidence field name (default: %(default)s).",
    )
    args = parser.parse_args()

    if args.data is not None:
        data = load_json(args.data)
        summary = summarize(data, args.competence_field, args.confidence_field)
        print_family_summary("custom", args.data, summary)
        return 0

    for family in args.families:
        path = family_json_path(family)
        data = load_json(path)
        summary = summarize(data, args.competence_field, args.confidence_field)
        print_family_summary(family, path, summary)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
