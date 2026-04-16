#!/usr/bin/env python3
"""
GPT-assisted skill extraction + OJD-DAPS ESCO mapping.

Pipeline per input text:
1) GPT "skillify": rewrite the bio/text as a semicolon-separated list of skill-like phrases.
   - No new facts; infer skills from roles/education explicitly in the text.
2) Map those phrases to ESCO via OJD-DAPS `/extract`.
3) (Optional) GPT audit: given the original text and the extracted ESCO skills,
   keep only skills supported by the text and optionally suggest missing skill
   phrases (as plain text, no IDs).

Input: one text per line, or JSONL lines with {"id": ..., "text": "..."}.
Output: JSONL with original text, gpt_skill_phrases, esco_skills_raw, esco_skills_validated, gpt_suggested.

Requirements:
 - OPENAI_API_KEY env var set
 - OJD-DAPS service running (default http://localhost:5005)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Tuple

import requests
from tqdm import tqdm

from openai import OpenAI


# ------------- GPT helpers -------------
SYSTEM_SKILLIFY = (
    "You rewrite bios into concise semicolon-separated skill phrases. "
    "Use only information implied by the bio (roles, education, domains). "
    "Convert degrees and roles into implied competencies (e.g., law degree -> legal research; legal drafting; policy analysis). "
    "Do not invent new employers or dates; stay within what the bio implies. "
    "Output: a single line of skill phrases separated by semicolons, nothing else."
)

SYSTEM_AUDIT = (
    "You validate ESCO skills against the bio. "
    "Mark only skills clearly supported or implied by the bio. "
    "Do not invent new facts. "
    "If something is unsupported, drop it. "
    "If obvious skills are missing, suggest up to 5 short skill phrases (plain text). "
    "Output JSON with keys: validated (list of strings), suggested (list of strings)."
)


def gpt_skillify(client: OpenAI, text: str, model: str) -> str:
    resp = client.chat.completions.create(
        model=model,
        temperature=0,
        messages=[
            {"role": "system", "content": SYSTEM_SKILLIFY},
            {"role": "user", "content": text},
        ],
    )
    return resp.choices[0].message.content.strip()


def gpt_audit(client: OpenAI, bio: str, skills: List[Dict[str, Any]], model: str) -> Tuple[List[str], List[str]]:
    skill_strs = [s.get("match_skill") or s.get("skillname") or s.get("match_id") or "" for s in skills]
    payload = {
        "bio": bio,
        "skills": skill_strs,
    }
    resp = client.chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_AUDIT},
            {"role": "user", "content": json.dumps(payload)},
        ],
    )
    try:
        data = json.loads(resp.choices[0].message.content)
        return data.get("validated", []), data.get("suggested", [])
    except Exception:
        return [], []


# ------------- OJD-DAPS helpers -------------
def call_ojd_extract(text: str, base_url: str) -> List[Dict[str, Any]]:
    payload = {"text": text}
    resp = requests.post(f"{base_url.rstrip('/')}/extract", json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    if "skills" in data and data["skills"] is not None:
        return data["skills"]
    if "results" in data and data["results"]:
        return data["results"][0].get("mapped_skills", []) or []
    return []


def dedupe_skills(skills: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for s in skills:
        key = (
            s.get("match_id") or s.get("skillURI") or s.get("skill_id") or s.get("name"),
            s.get("match_skill") or s.get("skillname"),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


# ------------- IO helpers -------------
def iter_inputs(path: str):
    fh = sys.stdin if path == "-" else open(path, "r", encoding="utf-8")
    with fh:
        for idx, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            if line.startswith("{"):
                obj = json.loads(line)
                yield obj.get("id", idx), obj.get("text", "")
            else:
                yield idx, line


def main():
    ap = argparse.ArgumentParser(description="GPT skillify + OJD ESCO mapping")
    ap.add_argument("--input", required=True, help="Input file (one text per line, or JSONL with {text}). Use '-' for stdin.")
    ap.add_argument("--output", required=True, help="Output JSONL path.")
    ap.add_argument("--ojd-url", default="http://localhost:5005", help="Base URL for OJD-DAPS service.")
    ap.add_argument("--gpt-model", default="gpt-4o-mini", help="OpenAI chat model for skillify/audit.")
    ap.add_argument("--no-audit", action="store_true", help="Skip GPT auditing of ESCO skills.")
    ap.add_argument("--include-suggested", action="store_true", help="After audit, append suggested skill phrases and remap to ESCO.")
    args = ap.parse_args()

    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AZURE_OPENAI_API_KEY")
    if not api_key:
        sys.stderr.write("OPENAI_API_KEY not set\n")
        sys.exit(1)

    endpoint = os.getenv("OPENAI_BASE_URL") or os.getenv("AZURE_OPENAI_ENDPOINT") or "https://cavs.openai.azure.com/openai/v1"
    client = OpenAI(base_url=endpoint, api_key=api_key)

    with open(args.output, "w", encoding="utf-8") as out_f:
        for idx, text in tqdm(list(iter_inputs(args.input)), desc="Texts"):
            try:
                # 1) GPT skillify
                skill_phrases = gpt_skillify(client, text, args.gpt_model)
                # 2) ESCO mapping (initial)
                esco_skills = dedupe_skills(call_ojd_extract(skill_phrases, args.ojd_url))
                validated, suggested = [], []
                esco_with_suggested = []
                if not args.no_audit:
                    validated, suggested = gpt_audit(client, text, esco_skills, args.gpt_model)
                    if args.include_suggested and suggested:
                        # Remap with suggested phrases appended
                        combined_phrases = skill_phrases
                        if not combined_phrases.endswith(";"):
                            combined_phrases += "; "
                        combined_phrases += "; ".join(suggested)
                        esco_with_suggested = dedupe_skills(call_ojd_extract(combined_phrases, args.ojd_url))
                record = {
                    "id": idx,
                    "text": text,
                    "gpt_skill_phrases": skill_phrases,
                    "esco_skills_raw": esco_skills,
                    "esco_skills_validated": validated,
                    "gpt_suggested_skills": suggested,
                    "esco_skills_with_suggested": esco_with_suggested,
                }
                out_f.write(json.dumps(record) + "\n")
            except Exception as e:
                sys.stderr.write(f"Error on id={idx}: {e}\n")
                out_f.write(json.dumps({"id": idx, "text": text, "error": str(e)}) + "\n")


if __name__ == "__main__":
    main()
