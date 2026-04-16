"""
Add any authors that appear in Validation/skills_output.jsonl but are
missing from Validation/liar2/liar2_all_splits_competence_skills_gpt_reclass.json.

Rules:
- Use liar2/all.csv as the source of articles/bios.
- If an author has no skills in skills_output, mark every article with
  competent_skills_gpt = False, confidence 0.2, reason
  "No skills available for this author."
- If an author has skills, set competent_skills_gpt = True, confidence 0.9,
  and list the skills in the reason.
- Leave competent_gpt untouched (this script only fills the *_skills fields).

Usage:
  python3 scripts/add_missing_authors_from_skills.py
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Dict, Iterable, List, Sequence


SKILLS_PATH = Path("Validation/skills_output.jsonl")
RECLASS_PATH = Path("Validation/liar2/liar2_all_splits_competence_skills_gpt_reclass.json")
ALL_CSV_PATH = Path("Validation/liar2/liar2/all.csv")


def _dedupe(seq: Iterable[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for item in seq:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def load_skills(skills_path: Path) -> Dict[str, List[str]]:
    skills_map: Dict[str, List[str]] = {}
    with skills_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            key = obj.get("liar2_author_key") or obj.get("author_key") or obj.get("author")
            if not key:
                continue
            raw_skills = (obj.get("skills_from_occupations") or []) + (obj.get("skills_from_bio") or [])
            labels: List[str] = []
            for s in raw_skills:
                if isinstance(s, dict):
                    label = s.get("label")
                    if label:
                        labels.append(label)
                elif isinstance(s, str):
                    labels.append(s)
            skills = _dedupe(labels)
            skills_map[key] = skills
    return skills_map


def load_articles_by_speaker(csv_path: Path) -> Dict[str, List[dict]]:
    by_speaker: Dict[str, List[dict]] = {}
    with csv_path.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            speaker = row["speaker"]
            by_speaker.setdefault(speaker, []).append(row)
    return by_speaker


def split_name(author_key: str) -> tuple[str, str]:
    parts = author_key.split()
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def build_articles(rows: Sequence[dict], skills: Sequence[str]) -> List[dict]:
    has_skills = bool(skills)
    reason = (
        f"Skills from skills_output.jsonl: {', '.join(skills)}."
        if has_skills
        else "No skills available for this author."
    )
    confidence = 0.9 if has_skills else 0.2

    articles = []
    for idx, r in enumerate(rows, start=1):
        label = int(r["label"])
        news_status = "true-news" if label >= 3 else "false-news"
        articles.append(
            {
                "title": r["statement"],
                "content": f"{r['context']}\n\n{r['justification']}",
                "news-status": news_status,
                "url": "",
                "liar2_id": r["id"],
                "liar2_label": r["label"],
                "liar2_true_threshold": 3,
                "liar2_subject": r["subject"],
                "liar2_speaker": r["speaker"],
                "liar2_statement": r["statement"],
                "liar2_context": r["context"],
                "liar2_justification": r["justification"],
                "liar2_state_info": r["state_info"],
                "liar2_true_counts": r["true_counts"],
                "liar2_mostly_true_counts": r["mostly_true_counts"],
                "liar2_half_true_counts": r["half_true_counts"],
                "liar2_mostly_false_counts": r["mostly_false_counts"],
                "liar2_false_counts": r["false_counts"],
                "liar2_pants_on_fire_counts": r["pants_on_fire_counts"],
                "article_id": idx,
                "competent_skills_gpt": has_skills,
                "competent_confidence_skills_gpt": confidence,
                "competent_reason_skills_gpt": reason,
            }
        )
    return articles


def main() -> None:
    skills_map = load_skills(SKILLS_PATH)
    articles_by_speaker = load_articles_by_speaker(ALL_CSV_PATH)
    reclass = json.loads(RECLASS_PATH.read_text())
    existing_keys = {a.get("liar2_author_key") or a.get("author_key") for a in reclass}

    missing = [k for k in skills_map if k not in existing_keys]
    if not missing:
        print("No missing authors to add.")
        return

    next_id = max((a.get("author_id", 0) for a in reclass), default=0) + 1
    added = 0

    for author_key in sorted(missing):
        rows = articles_by_speaker.get(author_key)
        if not rows:
            print(f"Skipping {author_key!r}: no articles in liar2/all.csv")
            continue
        skills = skills_map.get(author_key, [])
        name, surname = split_name(author_key)
        author_obj = {
            "name": name,
            "surname": surname,
            "gender": "unknown",
            "bio": rows[0].get("speaker_description", ""),
            "author_id": next_id,
            "articles": build_articles(rows, skills),
            "bio_variants_count": 1,
            "bio_conflict_resolved": False,
            "liar2_author_key": author_key,
            "bio_source": "liar2",
        }
        reclass.append(author_obj)
        next_id += 1
        added += 1

    if not added:
        print("No authors were added.")
        return

    with RECLASS_PATH.open("w") as f:
        f.write("[\n")
        for idx, obj in enumerate(reclass):
            if idx:
                f.write(",\n")
            f.write(json.dumps(obj, ensure_ascii=False))
        f.write("\n]")

    print(f"Added {added} authors. New total: {len(reclass)}")


if __name__ == "__main__":
    main()
