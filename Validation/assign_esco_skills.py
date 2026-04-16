#!/usr/bin/env python3
"""
Assign ESCO skills to authors by:
1) Detecting occupations from bios (regex/keyword heuristic).
2) Attaching essential and optional skills for those occupations.
3) Enriching with degree-based keyword matches against ESCO skills.

Outputs JSONL per author:
{"author": "...", "occupations": [{"uri": "...", "label": "..."}], "skills": [{"uri": "...", "label": "...", "source": "essential|optional|degree-keyword"}]}
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

from tqdm import tqdm


def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split()).strip()


@dataclass
class Occupation:
    uri: str
    label: str


@dataclass
class Skill:
    uri: str
    label: str
    description: str


def load_esco(path: str) -> Tuple[List[Occupation], Dict[str, Skill], Dict[str, List[str]], Dict[str, List[str]]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    graph = data.get("@graph") or []

    def pick_en_label(label_obj: Any) -> Optional[str]:
        if isinstance(label_obj, list):
            for item in label_obj:
                if not isinstance(item, dict):
                    continue
                lf = item.get("literalForm")
                if isinstance(lf, dict) and lf.get("en"):
                    return _collapse_ws(str(lf["en"]))
        elif isinstance(label_obj, dict):
            lf = label_obj.get("literalForm")
            if isinstance(lf, dict) and lf.get("en"):
                return _collapse_ws(str(lf["en"]))
        return None

    def pick_en_description(desc_obj: Any) -> Optional[str]:
        if isinstance(desc_obj, list):
            for item in desc_obj:
                if not isinstance(item, dict):
                    continue
                if item.get("language") == "en" and "nodeLiteral" in item:
                    return _collapse_ws(str(item["nodeLiteral"]))
            for item in desc_obj:
                if isinstance(item, dict) and "nodeLiteral" in item:
                    return _collapse_ws(str(item["nodeLiteral"]))
        return None

    occupations: List[Occupation] = []
    skills: Dict[str, Skill] = {}
    essential: Dict[str, List[str]] = {}
    optional: Dict[str, List[str]] = {}

    # First pass: collect skills and occupations.
    for node in graph:
        if not isinstance(node, dict):
            continue
        t = node.get("type")
        if t == "esco:Skill" or (isinstance(t, list) and "esco:Skill" in t):
            uri = node.get("uri") or ""
            if not uri:
                continue
            label = pick_en_label(node.get("preferredLabel"))
            if not label:
                continue
            desc = pick_en_description(node.get("description")) or ""
            status = (node.get("status") or "").lower()
            if status == "obsolete":
                continue
            skills[uri] = Skill(uri=uri, label=label, description=desc)
        if t == "esco:Occupation" or (isinstance(t, list) and "esco:Occupation" in t):
            uri = node.get("uri") or ""
            label = pick_en_label(node.get("preferredLabel"))
            if uri and label:
                occupations.append(Occupation(uri=uri, label=label))

    # Second pass: collect skill->occupation links.
    for node in graph:
        if not isinstance(node, dict):
            continue
        t = node.get("type")
        if not (t == "esco:Skill" or (isinstance(t, list) and "esco:Skill" in t)):
            continue
        uri = node.get("uri") or ""
        if not uri:
            continue
        for key, bucket in [("isEssentialSkillFor", essential), ("isOptionalSkillFor", optional)]:
            links = node.get(key)
            if not links:
                continue
            if isinstance(links, list):
                for occ_uri in links:
                    if not isinstance(occ_uri, str):
                        continue
                    bucket.setdefault(occ_uri, []).append(uri)
            elif isinstance(links, str):
                bucket.setdefault(links, []).append(uri)

    return occupations, skills, essential, optional


OCCUPATION_KEYWORDS = {
    "law": ["attorney", "lawyer", "juris doctor", "jd", "llm", "prosecutor", "judge", "counsel", "law firm"],
    "finance": ["cpa", "accountant", "accounting", "auditor", "banker", "finance", "financial", "investment", "cfa", "portfolio manager"],
    "healthcare": ["physician", "doctor", "md", "do", "nurse", "rn", "healthcare", "hospital", "clinic", "surgeon", "dentist", "pharmacist", "psychiatrist"],
    "engineering": ["engineer", "engineering", "software developer", "architect", "mechanical", "electrical", "civil", "aerospace", "devops"],
    "education": ["teacher", "professor", "lecturer", "educator", "school principal", "dean", "instructor"],
    "public_service": ["senator", "representative", "mayor", "governor", "congress", "legislator", "public service", "diplomat", "ambassador", "policy maker"],
}

DEGREE_KEYWORDS = {
    "law": ["jd", "juris doctor", "llm", "ll.b", "law degree"],
    "finance": ["mba", "accounting", "finance", "economics"],
    "healthcare": ["md", "do", "medical degree", "nursing", "bsn", "msn", "pharmd", "dmd", "dds"],
    "engineering": ["beng", "meng", "engineering", "computer science", "software engineering", "electrical engineering", "mechanical engineering"],
    "education": ["m.ed", "master of education", "b.ed"],
    "public_service": ["public policy", "public administration", "mpa", "mpp", "international relations"],
}


def detect_domains(text: str) -> Set[str]:
    low = text.lower()
    found: Set[str] = set()
    for domain, kws in OCCUPATION_KEYWORDS.items():
        if any(k in low for k in kws):
            found.add(domain)
    for domain, kws in DEGREE_KEYWORDS.items():
        if any(k in low for k in kws):
            found.add(domain)
    return found


def match_occupations(bio: str, occupations: List[Occupation]) -> List[Occupation]:
    domains = detect_domains(bio)
    if not domains:
        return []
    hits: List[Occupation] = []
    for occ in occupations:
        l = occ.label.lower()
        if any(domain in l for domain in domains):
            hits.append(occ)
    return hits


def degree_skill_hits(skills: Dict[str, Skill], domains: Set[str], limit_per_domain: int = 50) -> List[Skill]:
    out: List[Skill] = []
    for domain in domains:
        kws = DEGREE_KEYWORDS.get(domain) or []
        for kw in kws:
            kw_low = kw.lower()
            for skill in skills.values():
                if kw_low in skill.label.lower() or kw_low in skill.description.lower():
                    out.append(skill)
                    if limit_per_domain > 0 and len(out) >= limit_per_domain:
                        break
            if limit_per_domain > 0 and len(out) >= limit_per_domain:
                break
    return out


def load_bios_csv(path: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            author = _collapse_ws(row.get("author") or row.get("Author") or "")
            bio = _collapse_ws(row.get("bio") or row.get("Bio") or "")
            if author and bio:
                out.append((author, bio))
    return out


def parse_args(argv: List[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Assign ESCO skills based on occupations and degree keywords.")
    ap.add_argument("--bios-csv", required=True, help="CSV with columns author,bio.")
    ap.add_argument("--esco-path", required=True, help="ESCO JSON-LD path.")
    ap.add_argument("--output", required=True, help="Output JSONL path.")
    ap.add_argument("--max-occupations", type=int, default=3, help="Limit occupations per author (0=all).")
    ap.add_argument("--resume", action="store_true", help="Resume from existing output JSONL.")
    return ap.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    occupations, skills, essential, optional = load_esco(args.esco_path)
    bios = load_bios_csv(args.bios_csv)
    if not bios:
        raise SystemExit("No bios loaded.")

    processed: Set[str] = set()
    out_mode = "w"
    if args.resume and os.path.exists(args.output):
        with open(args.output, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    author = obj.get("author")
                    if isinstance(author, str):
                        processed.add(author)
                except Exception:
                    continue
        out_mode = "a"

    pending = [(a, b) for a, b in bios if a not in processed]

    with open(args.output, out_mode, encoding="utf-8") as out_f, tqdm(total=len(pending), desc="Authors", unit="author") as pbar:
        for author, bio in pending:
            occs = match_occupations(bio, occupations)
            if args.max_occupations > 0:
                occs = occs[: args.max_occupations]
            occ_uris = {o.uri for o in occs}

            skills_out: Dict[str, Dict[str, str]] = {}

            # Add essential/optional by occupation
            for occ in occs:
                for uri in essential.get(occ.uri, []):
                    if uri in skills:
                        skills_out[uri] = {"uri": uri, "label": skills[uri].label, "source": "essential"}

            # Degree/domain keyword matches
            domains = detect_domains(bio)
            for sk in degree_skill_hits(skills, domains, limit_per_domain=50):
                if sk.uri not in skills_out:
                    skills_out[sk.uri] = {"uri": sk.uri, "label": sk.label, "source": "degree-keyword"}

            out_obj = {
                "author": author,
                "occupations": [{"uri": o.uri, "label": o.label} for o in occs],
                "skills": list(skills_out.values()),
            }
            out_f.write(json.dumps(out_obj, ensure_ascii=False) + "\n")
            pbar.update(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
