#!/usr/bin/env python3
"""
Builds a GPT fine-tuning dataset from ESCO skills, enriched with degree/major
phrasing and optional bio snippets. Outputs JSONL with OpenAI chat format:

{
  "messages": [
    {"role": "system", "content": "You are an expert on ESCO skills."},
    {"role": "user", "content": "<question>"},
    {"role": "assistant", "content": "<grounded answer>"}
  ]
}

Use cases covered:
- Direct "What is skill X?" lookups.
- "Degree/major" flavored prompts (e.g., Bachelor of Science in Biology).
- Action/description paraphrases drawn from the ESCO skill description.
- (Optional) Bio-context prompts to increase robustness to CV/resume phrasing.
Defaults target the repo copies of ESCO and majors list; pass --output to write
JSONL. Deterministic ordering with --seed.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Tuple

from openai import AzureOpenAI
from tqdm import tqdm

ESCO_DEFAULT = "Validation/esco-v1.2.1.json-ld"
MAJORS_DEFAULT = "Validation/majors-list.csv"
WIKI_BIOS_DEFAULT = "Validation/liar2/wiki_bios_all.json"


def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split()).strip()


_STOPWORDS = {
    "and",
    "the",
    "of",
    "to",
    "for",
    "a",
    "an",
    "in",
    "on",
    "with",
    "by",
    "at",
    "from",
    "as",
    "or",
    "is",
    "are",
    "be",
    "this",
    "that",
    "these",
    "those",
}


def _extract_keywords(text: str, limit: int = 5) -> List[str]:
    """Pull a few descriptive tokens from the skill description to guide GPT."""
    if not text:
        return []
    tokens = re.split(r"[^A-Za-z0-9+]+", text.lower())
    out: List[str] = []
    seen: set[str] = set()
    for tok in tokens:
        if len(tok) < 4 or tok in _STOPWORDS:
            continue
        if tok in seen:
            continue
        seen.add(tok)
        out.append(tok)
        if len(out) >= limit:
            break
    return out


def _build_openai_client() -> Optional[AzureOpenAI]:
    api_key = os.getenv("AZURE_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None
    endpoint = (
        os.getenv("AZURE_OPENAI_ENDPOINT")
        or os.getenv("OPENAI_BASE_URL")
        or "https://cavs.openai.azure.com/"
    )
    return AzureOpenAI(azure_endpoint=endpoint, api_key=api_key, api_version="2024-12-01-preview")


def load_esco_skills(path: str) -> List[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    graph = data.get("@graph")
    if not isinstance(graph, list):
        raise SystemExit("Invalid ESCO JSON-LD: missing @graph list")

    def has_type(node: Dict[str, Any], wanted: str) -> bool:
        t = node.get("type")
        if t == wanted:
            return True
        return isinstance(t, list) and wanted in t

    def pick_en_label(label_obj: Any) -> Optional[str]:
        # label_obj is usually a list of {literalForm: {en: "..."}, ...}
        if isinstance(label_obj, list):
            for item in label_obj:
                if not isinstance(item, dict):
                    continue
                lf = item.get("literalForm")
                if isinstance(lf, dict):
                    if lf.get("en"):
                        return _collapse_ws(str(lf["en"]))
        elif isinstance(label_obj, dict):
            lf = label_obj.get("literalForm")
            if isinstance(lf, dict) and lf.get("en"):
                return _collapse_ws(str(lf["en"]))
        return None

    def pick_en_description(desc_obj: Any) -> Optional[str]:
        # description is usually a list of {nodeLiteral: "...", language: "en"}
        if isinstance(desc_obj, list):
            for item in desc_obj:
                if not isinstance(item, dict):
                    continue
                if item.get("language") == "en" and "nodeLiteral" in item:
                    return _collapse_ws(str(item["nodeLiteral"]))
            # fall back to first nodeLiteral if no explicit language match
            for item in desc_obj:
                if isinstance(item, dict) and "nodeLiteral" in item:
                    return _collapse_ws(str(item["nodeLiteral"]))
        return None

    skills: List[Dict[str, Any]] = []
    for node in graph:
        if not isinstance(node, dict):
            continue
        if not has_type(node, "esco:Skill"):
            continue
        label = pick_en_label(node.get("preferredLabel"))
        if not label:
            continue
        desc = pick_en_description(node.get("description")) or ""
        skill_type = node.get("skillType")  # URI string
        skills.append(
            {
                "uri": node.get("uri"),
                "label": label,
                "description": desc,
                "skill_type": skill_type,
            }
        )
    return skills


def load_majors(path: str) -> List[Tuple[str, str]]:
    majors: List[Tuple[str, str]] = []
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            major = _collapse_ws(row.get("Major") or "")
            cat = _collapse_ws(row.get("Major_Category") or "")
            if major:
                majors.append((major, cat))
    return majors


def load_bio_snippets(path: str, limit: int = 500) -> List[str]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    bios: List[str] = []
    if isinstance(data, dict):
        for entry in data.values():
            if not isinstance(entry, dict):
                continue
            if entry.get("status") != "ok":
                continue
            bio = _collapse_ws(entry.get("bio") or "")
            if bio:
                bios.append(bio[:600])
    random.shuffle(bios)
    return bios[:limit]


def collect_bio_terms(bios: List[str], *, per_bio_limit: int = 10, max_terms: int = 2000) -> List[Tuple[str, int]]:
    """Aggregate common keywords across bios to use as supplemental degree/experience hints."""
    counts: Counter[str] = Counter()
    for bio in bios:
        for term in _extract_keywords(bio, limit=per_bio_limit):
            counts[term] += 1
    return counts.most_common(max_terms)


def write_bio_terms_csv(terms: List[Tuple[str, int]], path: str) -> None:
    """Persist extracted bio terms and their counts as a CSV support file."""
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["term", "count"])
        writer.writerows(terms)


def gpt_generate_user_question(
    client: AzureOpenAI,
    *,
    model: str,
    skill_label: str,
    skill_desc: str,
    majors: List[Tuple[str, str]],
    rng: random.Random,
) -> Optional[str]:
    """
    Use GPT to synthesize ONE user question that ties degrees (BA/BS/MS/PhD),
    majors, job titles, and related experiences to the target ESCO skill.
    """
    sampled = rng.sample(majors, k=min(5, len(majors))) if majors else []
    majors_text = "; ".join(f"{m} ({c})" for m, c in sampled) if sampled else "various fields"
    keywords = _extract_keywords(skill_desc, limit=5)
    keywords_text = ", ".join(keywords) if keywords else "core skill terminology"

    prompt = (
        "Craft ONE inventive yet concise user question asking about an ESCO skill. Requirements:\n"
        "- at least three distinct degree/major phrases (BA, BS, Master's, PhD, Ph.D.)\n"
        f"- at least three representative majors (include some from this list): {majors_text}\n"
        "- at least three relevant job titles or work experiences (mix individual contributor and leadership)\n"
        f"- weave in 4+ key duties/tools/concepts drawn from (or synonymous with) this skill: {keywords_text}\n"
        "- avoid explicitly naming the target skill; rely on the keywords/context instead\n"
        "- make it feel like a real candidate/manager asking how their background maps to the skill\n"
        f"Target skill label: '{skill_label}'\n"
        f"Skill description: '{skill_desc or 'No description provided'}'\n"
        "Return JSON: {\"question\": \"<text>\"}. Keep it natural, specific, and self-contained."
    )

    resp = client.chat.completions.create(
        model=model,
        temperature=0.7,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "You generate varied user questions about ESCO skills."},
            {"role": "user", "content": prompt},
        ],
    )
    raw = resp.choices[0].message.content or ""
    data = json.loads(raw)
    q = data.get("question") if isinstance(data, dict) else None
    if isinstance(q, str) and q.strip():
        return _collapse_ws(q)
    raise ValueError("GPT response missing 'question'")


def degree_variants(major: str) -> List[str]:
    return [
        f"Bachelor of Science in {major}",
        f"Bachelor of Arts in {major}",
        f"PhD in {major}",
        f"Master of Science in {major}",
        f"Undergraduate major in {major}",
    ]


def format_assistant(skill: Dict[str, Any]) -> str:
    label = skill["label"]
    uri = skill.get("uri") or ""
    desc = skill.get("description") or ""
    stype = ""
    if skill.get("skill_type"):
        if "knowledge" in str(skill["skill_type"]).lower():
            stype = " (knowledge skill)"
        elif "skill-type/skill" in str(skill["skill_type"]).lower():
            stype = " (practical skill)"
    bits = [f"{label}{stype}".strip()]
    if uri:
        bits.append(f"ESCO ID: {uri}")
    if desc:
        bits.append(desc)
    return " - ".join(bits)


def parse_skill_uri_from_record(obj: Dict[str, Any]) -> Optional[str]:
    msgs = obj.get("messages")
    if not isinstance(msgs, list):
        return None
    for m in msgs:
        if not isinstance(m, dict):
            continue
        if m.get("role") != "assistant":
            continue
        content = m.get("content")
        if not isinstance(content, str):
            continue
        marker = "ESCO ID:"
        if marker in content:
            after = content.split(marker, 1)[1].strip()
            uri = after.split()[0]
            if uri:
                return uri
    return None


def build_examples(
    skills: List[Dict[str, Any]],
    majors: List[Tuple[str, str]],
    max_examples: int,
    seed: int,
    gpt_client: AzureOpenAI,
    gpt_model: str,
    existing_uris: set[str],
) -> Iterable[Dict[str, Any]]:
    rng = random.Random(seed)
    rng.shuffle(skills)

    for idx, skill in enumerate(skills[:max_examples]):
        uri = skill.get("uri")
        if uri and uri in existing_uris:
            continue
        label = skill["label"]
        desc = skill.get("description") or ""

        user_question = gpt_generate_user_question(
            gpt_client,
            model=gpt_model,
            skill_label=label,
            skill_desc=desc,
            majors=majors,
            rng=rng,
        )
        if not user_question:
            raise RuntimeError(f"GPT returned empty question for skill '{label}'")

        yield {
            "messages": [
                {"role": "system", "content": "You are an expert on ESCO skills."},
                {"role": "user", "content": user_question},
                {"role": "assistant", "content": format_assistant(skill)},
            ]
        }


def parse_args(argv: List[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Generate GPT fine-tune JSONL from ESCO skills, majors, and optional bios."
    )
    ap.add_argument("--esco-path", default=ESCO_DEFAULT, help=f"ESCO JSON-LD path (default: {ESCO_DEFAULT})")
    ap.add_argument("--majors-path", default=MAJORS_DEFAULT, help=f"Majors CSV path (default: {MAJORS_DEFAULT})")
    ap.add_argument(
        "--bios-path",
        default=WIKI_BIOS_DEFAULT,
        help="Optional wiki bios JSON for extracting supplemental degree/experience terms (not used in prompts).",
    )
    ap.add_argument(
        "--bio-terms-output",
        help="Optional CSV path; when set, extract keyword counts from bios and write as a support file.",
    )
    ap.add_argument("--output", required=True, help="Output JSONL path.")
    ap.add_argument(
        "--max-examples",
        type=int,
        default=0,
        help="Limit number of skills to process (0 or negative means all).",
    )
    ap.add_argument("--seed", type=int, default=13, help="Deterministic seed.")
    ap.add_argument(
        "--gpt-model",
        default="gpt-4.1",
        help="Model/deployment name for GPT question synthesis (required).",
    )
    ap.add_argument("--resume", action="store_true", help="Resume from existing output JSONL (skip skills already written).")
    return ap.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    skills = load_esco_skills(args.esco_path)
    if not skills:
        raise SystemExit("No ESCO skills loaded.")
    majors = load_majors(args.majors_path)
    bios = load_bio_snippets(args.bios_path)
    bio_terms: List[Tuple[str, int]] = []
    if args.bio_terms_output and bios:
        bio_terms = collect_bio_terms(bios, per_bio_limit=10, max_terms=2000)
        write_bio_terms_csv(bio_terms, args.bio_terms_output)

    gpt_client = _build_openai_client()
    if gpt_client is None:
        raise SystemExit("OPENAI_API_KEY (or AZURE_OPENAI_API_KEY) is required.")

    existing_uris: set[str] = set()
    if args.resume and os.path.exists(args.output):
        with open(args.output, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    uri = parse_skill_uri_from_record(obj)
                    if uri:
                        existing_uris.add(uri)
                except Exception:
                    continue
        out_mode = "a"
    else:
        out_mode = "w"

    limit = len(skills) if args.max_examples <= 0 else min(args.max_examples, len(skills))
    with open(args.output, out_mode, encoding="utf-8") as out_f, tqdm(total=limit, desc="Skills", unit="skill") as pbar:
        for ex in build_examples(
            skills,
            majors,
            limit,
            args.seed,
            gpt_client,
            args.gpt_model,
            existing_uris,
        ):
            out_f.write(json.dumps(ex, ensure_ascii=False) + "\n")
            pbar.update(1)

    print(
        f"Wrote fine-tune JSONL to {args.output} "
        f"(skills sampled: {limit}, majors: {len(majors)})"
    )
    if args.bio_terms_output:
        print(
            f"Wrote bio terms support CSV to {args.bio_terms_output} "
            f"(bios processed: {len(bios)}, terms_written: {len(bio_terms)})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
