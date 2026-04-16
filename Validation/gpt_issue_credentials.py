#!/usr/bin/env python3
"""
Generate ESCO skill verifiable-credential payloads from author bios using GPT.

Pipeline:
1) Stream bios (name -> bio text) and load ESCO skills/occupations (label/description/uri).
2) GPT first chooses relevant top-level ESCO categories (labels only), then receives the descendant skill labels for those categories.
3) GPT picks the most relevant skill labels for each author and justifies each (no descriptions sent).
4) Write JSONL entries per author:
   - {"author": ..., "skills": [...]}
   - {"author": ..., "skills_from_occupations": [...], "skills_from_bio": [...]}
Supports resume and prints GPT errors instead of hiding them.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from openai import APITimeoutError, AzureOpenAI, OpenAI
from tqdm import tqdm

# Azure OpenAI defaults for the GPT endpoint and key.
# Using the full chat completions endpoint as requested.
AZURE_ENDPOINT_DEFAULT = "https://calog-mldz9rbt-swedencentral.cognitiveservices.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2025-01-01-preview"
AZURE_API_VERSION_DEFAULT = "2025-01-01-preview"
AZURE_API_KEY_DEFAULT = ""
OPENAI_API_KEY_FILE_DEFAULT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "GPT_COMP_CHECK", "openai_api_key.txt")
)

# -------------------
# Data loading helpers


def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split()).strip()


def _clean_bio(bio: str) -> str:
    """
    Remove placeholder sentences like 'not publicly available' while preserving real content.
    """
    if not bio:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", bio)
    kept: List[str] = []
    for sent in sentences:
        s = sent.strip()
        if not s:
            continue
        low = s.lower()
        if any(pat in low for pat in REMOVE_SENTENCE_PATTERNS):
            continue
        kept.append(s)
    if kept:
        return " ".join(kept)
    return bio


def _read_api_key_from_file(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
            return key or None
    except OSError:
        return None


def _resolve_api_key_with_file_fallback() -> Optional[str]:
    env_key = os.getenv("AZURE_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if env_key:
        return env_key

    key_file = (
        os.getenv("AZURE_OPENAI_API_KEY_FILE")
        or os.getenv("OPENAI_API_KEY_FILE")
        or OPENAI_API_KEY_FILE_DEFAULT
    )
    file_key = _read_api_key_from_file(key_file)
    if file_key:
        return file_key

    return AZURE_API_KEY_DEFAULT


def _domains_from_bio(bio: str) -> List[str]:
    low = bio.lower()
    hits = []
    for domain, kws in DOMAIN_KEYWORDS.items():
        if any(k in low for k in kws):
            hits.append(domain)
    return hits


SKIP_PATTERNS = [
    "no publicly available information",
    "insufficient publicly available information",
    "cannot be determined",
    "not possible to provide a specific biographical summary",
    "multiple individuals named",
]

# Some authors cause repeated GPT failures or known bad data and must be skipped.
SKIP_AUTHORS = {
    "lenar whitney",
}

REMOVE_SENTENCE_PATTERNS = [
    "not publicly available",
    "insufficient publicly available information",
    "not possible to provide a specific biographical summary",
]

DOMAIN_KEYWORDS = {
    "law": ["law", "legal", "attorney", "lawyer", "juris", "jd", "llm", "ll.b", "prosecutor", "judge", "bar exam"],
}

STATE_NAMES = {
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "new hampshire",
    "new jersey",
    "new mexico",
    "new york",
    "north carolina",
    "north dakota",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "rhode island",
    "south carolina",
    "south dakota",
    "tennessee",
    "texas",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "west virginia",
    "wisconsin",
    "wyoming",
}
DEMONYMS = {"americans", "texans", "floridians", "ohioans", "arizonans", "oregonians", "wisconsinites", "illinoisans"}
STATE_ORG_HINT_TOKENS = {
    "party",
    "project",
    "initiative",
    "news",
    "report",
    "voice",
    "department",
    "association",
    "coalition",
    "council",
    "committee",
    "fund",
    "funds",
    "pac",
    "future",
    "progress",
    "right",
    "life",
    "owners",
    "network",
    "action",
    "justice",
    "jobs",
    "job",
    "tax",
    "taxes",
    "policy",
    "partnership",
    "alliance",
    "bureau",
    "office",
    "state",
    "senate",
    "senator",
    "house",
    "legislators",
    "assembly",
    "candidates",
    "manufacturers",
    "commerce",
    "lottery",
    "bank",
    "union",
    "federation",
    "institute",
    "foundation",
    "college",
    "university",
    "school",
    "students",
    "teachers",
    "sheriff",
    "board",
    "voters",
    "residents",
    "citizens",
    "for",
    "against",
    "gun",
    "rights",
    "industries",
    "fact",
    "check",
    "better",
    "ideas",
    "opportunity",
    "one",
    "our",
    "think",
    "onward",
    "stop",
    "forward",
    "integrity",
    "family",
    "families",
    "growth",
    "development",
}
NON_PERSON_TOKENS = {
    "association",
    "associations",
    "alliance",
    "committee",
    "party",
    "pac",
    "fund",
    "foundation",
    "council",
    "institute",
    "union",
    "coalition",
    "league",
    "department",
    "ministry",
    "office",
    "agency",
    "bureau",
    "authority",
    "university",
    "college",
    "school",
    "district",
    "campaign",
    "project",
    "initiative",
    "center",
    "centre",
    "hospital",
    "network",
    "news",
    "press",
    "tribune",
    "gazette",
    "times",
    "daily",
    "voice",
    "report",
    "pundit",
    "feed",
    "tv",
    "radio",
    "television",
    "company",
    "co",
    "inc",
    "post",
    "posts",
    "video",
    "videos",
    "tiktok",
    "instagram",
    "facebook",
    "twitter",
    "youtube",
    "corp",
    "corporation",
    "llc",
    "ltd",
    "group",
    "chapter",
    "caucus",
    "bank",
    "federation",
    "conference",
}
NON_PERSON_PHRASES = [
    " for ",
    "americans for",
    "americans against",
    "people for",
    "campaign for",
    "campaign to",
    "friends of",
    "committee to",
    "on behalf of",
]
DOMAIN_RE = re.compile(r"(?:https?://)?[a-z0-9.-]+\\.(?:com|net|org|info|biz|tv|press|news|co|us|io|me|ca|uk|edu|gov)(?:/|$)")
SINGLE_TOKEN_NON_PERSON = {
    "aarp",
    "americanpoliticnews",
    "bloggers",
    "breitbart",
    "buzzfeed",
    "freedomworks",
    "future45",
    "infowars",
    "msnbc",
    "nowthis",
    "tiktok",
    "reaganwasright",
}
SINGLE_TOKEN_ALLOW = {"lizzo"}
NON_PERSON_EXPLICIT = {
    "tiktok posts",
    "tiktok",
    "american commitment",
    "john birch society",
    "federal transit administration",
    "texans for economic development",
    "texans are",
    "themiamigazette.com",
    "theseattletribune.com",
    "the associated press",
    "the gateway pundit",
    "the other 98%",
}


def _is_non_person_author(author: str) -> bool:
    low = (author or "").lower()
    if not low:
        return False
    # Drop anything with digits or percent signs (e.g., "18% of the American public").
    if any(ch.isdigit() for ch in low) or "%" in low:
        return True
    if low in NON_PERSON_EXPLICIT:
        return True
    if low.startswith("the ") or low.startswith("@"):
        return True
    if DOMAIN_RE.search(low):
        return True
    if "http://" in low or "https://" in low:
        return True
    tokens = re.findall(r"[a-zA-Z']+", low)
    token_set = set(tokens)
    if any(t in NON_PERSON_TOKENS for t in token_set):
        return True
    if any(t in DEMONYMS for t in token_set):
        return True
    state_tokens = [t for t in tokens if t in STATE_NAMES]
    if state_tokens:
        if len(tokens) == 1:
            return True
        if any(t in STATE_ORG_HINT_TOKENS for t in token_set):
            return True
    if any(phrase in low for phrase in NON_PERSON_PHRASES):
        return True
    if len(tokens) == 1:
        tok = token_set.pop() if token_set else ""
        if tok in SINGLE_TOKEN_NON_PERSON:
            return True
        return tok not in SINGLE_TOKEN_ALLOW
    if not any(len(w) >= 2 for w in tokens):
        return True
    return False


def _build_openai_clients(provider: str) -> List[Any]:
    """
    Build OpenAI clients.
    - azure: one or two Azure clients from AZURE_* env vars (with single fallback).
    - openai: single OpenAI client from OPENAI_API_KEY (and optional OPENAI_BASE_URL).
    - all: combine Azure clients (if any) and a single OpenAI client (if configured), round-robin.
    """

    clients: List[Any] = []

    def build_azure_clients() -> List[Any]:
        api_version = (
            os.getenv("AZURE_OPENAI_API_VERSION")
            or os.getenv("OPENAI_API_VERSION")
            or AZURE_API_VERSION_DEFAULT
        )

        def make_client(endpoint: str, key: str) -> AzureOpenAI:
            return AzureOpenAI(azure_endpoint=endpoint, api_key=key, api_version=api_version)

        out: List[Any] = []
        endpoint_a = os.getenv("AZURE_OPENAI_ENDPOINT_A")
        key_a = os.getenv("AZURE_OPENAI_API_KEY_A")
        if endpoint_a and key_a:
            out.append(make_client(endpoint_a, key_a))

        endpoint_b = os.getenv("AZURE_OPENAI_ENDPOINT_B")
        key_b = os.getenv("AZURE_OPENAI_API_KEY_B")
        if endpoint_b and key_b:
            out.append(make_client(endpoint_b, key_b))

        if not out:
            api_key = _resolve_api_key_with_file_fallback()
            if api_key:
                endpoint = (
                    os.getenv("AZURE_OPENAI_ENDPOINT")
                    or os.getenv("OPENAI_BASE_URL")
                    or AZURE_ENDPOINT_DEFAULT
                )
                out.append(make_client(endpoint, api_key))
        return out

    def build_openai_client() -> List[Any]:
        key = os.getenv("OPENAI_API_KEY") or _read_api_key_from_file(
            os.getenv("OPENAI_API_KEY_FILE") or OPENAI_API_KEY_FILE_DEFAULT
        )
        if not key:
            return []
        base_url = os.getenv("OPENAI_BASE_URL")
        return [OpenAI(api_key=key, base_url=base_url) if base_url else OpenAI(api_key=key)]

    if provider in ("azure", "all"):
        clients.extend(build_azure_clients())
    if provider in ("openai", "all"):
        clients.extend(build_openai_client())

    return clients


class AuthorTimeout(Exception):
    """Raised when an author processing request times out twice."""
    pass


def _call_model(
    client: Any,
    *,
    model: str,
    messages: List[Dict[str, str]],
    temperature: float,
    response_format: Dict[str, Any],
    timeout_s: float = 180.0,
) -> str:
    """
    Wrapper to call chat completions (Azure/OpenAI). Returns raw text content.
    """
    def _attempt_chat() -> str:
        resp = client.chat.completions.create(
            model=model,
            temperature=temperature,
            response_format=response_format,
            messages=messages,
            timeout=timeout_s,
        )
        return (resp.choices[0].message.content or "").strip()

    try:
        return _attempt_chat()
    except APITimeoutError:
        time.sleep(10)
        try:
            return _attempt_chat()
        except APITimeoutError:
            raise AuthorTimeout("model call timed out twice")
    except Exception:
        raise


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
        broader = node.get("broader")
        broader_list: List[str] = []
        if isinstance(broader, list):
            broader_list = [str(b) for b in broader if isinstance(b, str)]
        elif isinstance(broader, str):
            broader_list = [broader]
        skills.append({"uri": node.get("uri"), "label": label, "description": desc, "broader": broader_list})
    if not skills:
        raise SystemExit("No ESCO skills parsed from JSON-LD.")
    return skills


def iter_bios(path: str):
    """Stream bios without holding the entire file in memory."""
    def maybe_yield(author_raw: str, bio_raw: str):
        author = _collapse_ws(author_raw)
        bio = _collapse_ws(_clean_bio(bio_raw))
        if not author or not bio:
            return
        if author.lower() in SKIP_AUTHORS:
            return
        if any(pat in bio.lower() for pat in SKIP_PATTERNS):
            return
        yield author, bio

    if path.lower().endswith(".csv"):
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if not isinstance(row, dict):
                    continue
                bio = _collapse_ws(str(row.get("bio") or row.get("Bio") or ""))
                if not bio:
                    continue
                author = row.get("author") or row.get("Author") or row.get("name") or ""
                surname = row.get("surname") or row.get("Surname") or ""
                if author and surname and surname not in str(author):
                    author = f"{author} {surname}".strip()
                elif not author and surname:
                    author = str(surname)
                for item in maybe_yield(str(author), bio):
                    yield item
        return

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        for name, bio in data.items():
            if isinstance(name, str) and isinstance(bio, str):
                for item in maybe_yield(name, bio):
                    yield item
        return
    if isinstance(data, list):
        for row in data:
            if not isinstance(row, dict):
                continue
            bio = _collapse_ws(str(row.get("bio") or ""))
            if not bio:
                continue
            author = row.get("liar2_author_key") or row.get("author") or row.get("name") or ""
            surname = row.get("surname")
            if author and surname and isinstance(surname, str) and surname not in str(author):
                author = f"{author} {surname}".strip()
            elif not author and surname:
                author = str(surname)
            for item in maybe_yield(str(author), bio):
                yield item
        return
    raise ValueError("Unsupported bios format; must be CSV or JSON (dict/list).")


# -------------------
@dataclass
class SkillEntry:
    uri: str
    label: str
    description: str
    broader: List[str]


def build_skill_index(skills: List[Dict[str, Any]]) -> List[SkillEntry]:
    indexed: List[SkillEntry] = []
    for s in skills:
        label = s["label"]
        desc = s.get("description") or ""
        broader = s.get("broader") or []
        indexed.append(SkillEntry(uri=s.get("uri") or "", label=label, description=desc, broader=broader))
    return indexed


def build_hierarchy(skill_index: List[SkillEntry]) -> Tuple[Dict[str, SkillEntry], Dict[str, List[str]], List[SkillEntry]]:
    skill_by_uri = {s.uri: s for s in skill_index if s.uri}
    children: Dict[str, List[str]] = defaultdict(list)
    for entry in skill_index:
        for parent in entry.broader:
            children[parent].append(entry.uri)
    roots = [s for s in skill_index if not s.broader]
    return skill_by_uri, children, roots


def filter_skills_by_keyword(skill_index: List[SkillEntry], keywords: List[str], limit: int = 500) -> List[SkillEntry]:
    kw_low = [k.lower() for k in keywords]
    out: List[SkillEntry] = []
    for s in skill_index:
        l = s.label.lower()
        if any(k in l for k in kw_low):
            out.append(s)
            if limit > 0 and len(out) >= limit:
                break
    return out


def _dedupe_skills_by_uri(skills: List[Dict[str, str]]) -> List[Dict[str, str]]:
    seen: set[str] = set()
    deduped: List[Dict[str, str]] = []
    for s in skills:
        uri = s.get("uri") if isinstance(s, dict) else None
        if not uri or not isinstance(uri, str):
            continue
        if uri in seen:
            continue
        seen.add(uri)
        deduped.append(s)
    return deduped


@dataclass
class OccupationEntry:
    uri: str
    label: str


def load_occupations_and_skill_links(path: str) -> Tuple[List[OccupationEntry], Dict[str, List[str]], Dict[str, List[str]]]:
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

    occupations: List[OccupationEntry] = []
    essential: Dict[str, List[str]] = defaultdict(list)
    optional: Dict[str, List[str]] = defaultdict(list)

    # Occupations
    for node in graph:
        if not isinstance(node, dict):
            continue
        t = node.get("type")
        if t == "esco:Occupation" or (isinstance(t, list) and "esco:Occupation" in t):
            uri = node.get("uri") or ""
            label = pick_en_label(node.get("preferredLabel"))
            if uri and label:
                occupations.append(OccupationEntry(uri=uri, label=label))

    # Skill links
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
                    if isinstance(occ_uri, str):
                        bucket[occ_uri].append(uri)
            elif isinstance(links, str):
                bucket[links].append(uri)

    return occupations, essential, optional


def gpt_choose_occupations(
    client: AzureOpenAI,
    *,
    model: str,
    author: str,
    bio: str,
    occupations: List[OccupationEntry],
    max_choices: int,
    include_uri_in_prompt: bool,
) -> List[str]:
    if not occupations:
        return []

    def _parse_indices(raw: str) -> Optional[List[str]]:
        try:
            data = json.loads(raw)
        except Exception:
            return None
        indices = data.get("indices") if isinstance(data, dict) else None
        if isinstance(indices, str) and indices.strip().upper() == "NONE":
            return []
        out: List[str] = []
        if isinstance(indices, list):
            if any(isinstance(item, str) and item.strip().upper() == "NONE" for item in indices):
                return []
            for idx_raw in indices:
                if isinstance(idx_raw, int):
                    idx = idx_raw
                elif isinstance(idx_raw, str) and idx_raw.isdigit():
                    idx = int(idx_raw)
                else:
                    continue
                if 1 <= idx <= len(occupations):
                    out.append(occupations[idx - 1].uri)
            return out
        return None

    def _ask(prompt_text: str) -> Tuple[Optional[List[str]], str]:
        raw = _call_model(
            client,
            model=model,
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are an ESCO occupation selector."},
                {"role": "user", "content": prompt_text},
            ],
        )
        return _parse_indices(raw), raw

    choice_text = str(max_choices) if max_choices and max_choices > 0 else "all relevant"
    if include_uri_in_prompt:
        occ_snippet = "\n".join(f"- [{idx+1}] {o.label} (URI: {o.uri})" for idx, o in enumerate(occupations))
    else:
        occ_snippet = "\n".join(f"- [{idx+1}] {o.label}" for idx, o in enumerate(occupations))
    prompt = (
        "You pick the most relevant ESCO occupations for an author bio.\n"
        f"- Select up to {choice_text} indices that match the bio.\n"
        "- Return JSON: {\"indices\": [<numbers>]}.\n"
        "- Base choices strictly on the bio evidence.\n"
        f"Author: {author}\n"
        f"Bio: {bio}\n"
        "Occupation candidates:\n"
        f"{occ_snippet}\n"
    )
    out, raw = _ask(prompt)
    if out is None:
        retry_prompt = (
            prompt
            + "\nYour previous response did not include valid numeric indices. "
            "Respond again with JSON {\"indices\": [numbers from the list]}. "
            f"Use numbers between 1 and {len(occupations)}. "
            'If none apply, respond with {"indices": ["NONE"]}.'
        )
        out, raw_retry = _ask(retry_prompt)
        if out is None:
            print(f"[warn] Could not parse occupations for '{author}'. Raw: {raw_retry}")
            return []
    if max_choices and max_choices > 0:
        out = out[:max_choices]
    return out or []




def collect_descendants(root_uri: str, children: Dict[str, List[str]], skill_by_uri: Dict[str, SkillEntry]) -> List[SkillEntry]:
    out: List[SkillEntry] = []
    stack = [root_uri]
    seen: set[str] = set()
    while stack:
        uri = stack.pop()
        if uri in seen:
            continue
        seen.add(uri)
        entry = skill_by_uri.get(uri)
        if entry:
            out.append(entry)
        for child in children.get(uri, []):
            stack.append(child)
    return out


def gpt_select_skills(
    client: AzureOpenAI,
    *,
    model: str,
    author: str,
    bio: str,
    skills_batch: List[SkillEntry],
    max_output_skills: int,
    include_uri_in_prompt: bool,
) -> List[Dict[str, str]]:
    if not skills_batch:
        raise RuntimeError(f"No skills provided for author '{author}'")

    def _parse_skills(raw: str) -> Optional[List[Dict[str, str]]]:
        try:
            data = json.loads(raw)
        except Exception:
            return None
        skills = data.get("skills") if isinstance(data, dict) else None
        if isinstance(skills, str) and skills.strip().upper() == "NONE":
            return []
        cleaned: List[Dict[str, str]] = []
        if isinstance(skills, list):
            if any(isinstance(item, str) and item.strip().upper() == "NONE" for item in skills):
                return []
            had_items = False
            for item in skills:
                if not isinstance(item, dict):
                    continue
                had_items = True
                idx_raw = item.get("index")
                idx = None
                if isinstance(idx_raw, int):
                    idx = idx_raw
                elif isinstance(idx_raw, str) and idx_raw.isdigit():
                    idx = int(idx_raw)
                reason = _collapse_ws(str(item.get("reason") or ""))
                if idx is None or idx < 1 or idx > len(skills_batch):
                    continue
                entry = skills_batch[idx - 1]
                label = entry.label
                if label and reason:
                    cleaned.append({"uri": entry.uri, "label": label, "reason": reason})
            if cleaned:
                return cleaned
            if not had_items and len(skills) == 0:
                return []
            return None
        return None

    def _ask(prompt_text: str) -> Tuple[Optional[List[Dict[str, str]]], str]:
        raw = _call_model(
            client,
            model=model,
            temperature=0.2,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are an ESCO credentialing assistant."},
                {"role": "user", "content": prompt_text},
            ],
        )
        return _parse_skills(raw), raw

    max_out_text = str(max_output_skills) if max_output_skills and max_output_skills > 0 else "all relevant"
    if include_uri_in_prompt:
        skills_snippet = "\n".join(
            f"- [{idx+1}] {c.label} (URI: {c.uri})"
            for idx, c in enumerate(skills_batch)
        )
    else:
        skills_snippet = "\n".join(
            f"- [{idx+1}] {c.label}"
            for idx, c in enumerate(skills_batch)
        )
    prompt = (
        "You map author bios to ESCO skills to issue verifiable credentials.\n"
        "Instructions:\n"
        f"- Read the bio and pick up to {max_out_text} skills from the provided ESCO labels that best match demonstrated competencies.\n"
        "- If the bio names a profession/domain (e.g., lawyer/attorney, finance, healthcare, engineering), prioritize skills aligned to that domain even if other details are sparse.\n"
        "- Include both actionable/practical skills and knowledge skills when supported by the bio.\n"
        "- Skills from the bio may be based on degrees, courses, certificates, job experience, or other evidence of competence.\n"
        "- Return JSON: {\"skills\": [{\"index\": <number from the list>, \"reason\": \"short evidence-based note\"}, ...]}.\n"
        "- Reasons must cite evidence from the bio.\n"
        "- Do not invent degrees or roles absent from the bio.\n"
        "- Output skills only from the ESCO ontology.\n"
        "\n"
        f"Author: {author}\n"
        f"Bio: {bio}\n"
        "Candidate ESCO skills:\n"
        f"{skills_snippet}\n"
    )
    cleaned, raw = _ask(prompt)
    if cleaned is None:
        retry_prompt = (
            prompt
            + "\nYour previous response did not include valid numeric indices. "
            "Respond again with JSON {\"skills\": [{\"index\": <number>, \"reason\": \"bio-based evidence\"}]} using numbers from the provided list. "
            f"Use indices between 1 and {len(skills_batch)}. "
            'If none apply, respond with {"skills": ["NONE"]}.'
        )
        cleaned, raw_retry = _ask(retry_prompt)
        if cleaned is None:
            print(
                f"[warn] Could not parse skills for '{author}' (batch size {len(skills_batch)}). Raw: {raw_retry}"
            )
            return []
    if max_output_skills and max_output_skills > 0:
        return cleaned[:max_output_skills]
    return cleaned or []


def gpt_choose_root_categories(
    client: AzureOpenAI,
    *,
    model: str,
    author: str,
    bio: str,
    roots: List[SkillEntry],
    max_choices: int,
    include_uri_in_prompt: bool,
) -> List[str]:
    if not roots:
        return []

    def _parse_indices(raw: str) -> Optional[List[str]]:
        try:
            data = json.loads(raw)
        except Exception:
            return None
        indices = data.get("indices") if isinstance(data, dict) else None
        if isinstance(indices, str) and indices.strip().upper() == "NONE":
            return []
        out: List[str] = []
        if isinstance(indices, list):
            if any(isinstance(item, str) and item.strip().upper() == "NONE" for item in indices):
                return []
            for idx_raw in indices:
                if isinstance(idx_raw, int):
                    idx = idx_raw
                elif isinstance(idx_raw, str) and idx_raw.isdigit():
                    idx = int(idx_raw)
                else:
                    continue
                if 1 <= idx <= len(roots):
                    out.append(roots[idx - 1].uri)
            return out
        return None

    def _ask(prompt_text: str) -> Tuple[Optional[List[str]], str]:
        raw = _call_model(
            client,
            model=model,
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are an ESCO credentialing assistant."},
                {"role": "user", "content": prompt_text},
            ],
        )
        return _parse_indices(raw), raw

    choice_text = str(max_choices) if max_choices and max_choices > 0 else "all relevant"
    if include_uri_in_prompt:
        roots_snippet = "\n".join(
            f"- [{idx+1}] {r.label} (URI: {r.uri}) :: {r.description[:200]}"
            for idx, r in enumerate(roots)
        )
    else:
        roots_snippet = "\n".join(f"- [{idx+1}] {r.label} :: {r.description[:200]}" for idx, r in enumerate(roots))
    prompt = (
        "You map author bios to ESCO skills to issue verifiable credentials.\n"
        "Step 1: choose the most relevant top-level ESCO categories from the list provided.\n"
        f"- Pick up to {choice_text} indices.\n"
        "- Return JSON: {\"indices\": [<numbers>]}.\n"
        "- Base choices strictly on evidence in the bio.\n"
        f"Author: {author}\n"
        f"Bio: {bio}\n"
        "Top ESCO categories:\n"
        f"{roots_snippet}\n"
    )
    out, raw = _ask(prompt)
    if not out:
        retry_prompt = (
            prompt
            + "\nYour previous response did not include valid numeric indices. "
            "Respond again with JSON {\"indices\": [numbers from the list]}. "
            f"Use numbers between 1 and {len(roots)}. "
            'If none apply, respond with {"indices": ["NONE"]}.'
        )
        out, raw_retry = _ask(retry_prompt)
        if out is None:
            print(f"[warn] Could not parse root categories for '{author}'. Raw: {raw_retry}")
            return []
    if max_choices and max_choices > 0:
        out = out[:max_choices]
    return out or []


def gpt_choose_occ_and_roots(
    client: AzureOpenAI,
    *,
    model: str,
    author: str,
    bio: str,
    occupations: List[SkillEntry],
    roots: List[SkillEntry],
    max_occ: int,
    max_roots: int,
    include_uri_in_prompt: bool,
) -> Tuple[List[str], List[str]]:
    """Combined occupations + root category selection to reduce API calls."""
    if not occupations and not roots:
        return [], []

    def _parse(raw: str) -> Tuple[Optional[List[str]], Optional[List[str]]]:
        try:
            data = json.loads(raw)
        except Exception:
            return None, None
        occ_idx = data.get("occupations") if isinstance(data, dict) else None
        root_idx = data.get("roots") if isinstance(data, dict) else None

        def parse_indices(indices, pool):
            if isinstance(indices, str) and indices.strip().upper() == "NONE":
                return []
            out: List[str] = []
            if isinstance(indices, list):
                if any(isinstance(item, str) and item.strip().upper() == "NONE" for item in indices):
                    return []
                for idx_raw in indices:
                    if isinstance(idx_raw, int):
                        idx = idx_raw
                    elif isinstance(idx_raw, str) and idx_raw.isdigit():
                        idx = int(idx_raw)
                    else:
                        continue
                    if 1 <= idx <= len(pool):
                        out.append(pool[idx - 1].uri)
                return out
            return None

        return parse_indices(occ_idx, occupations), parse_indices(root_idx, roots)

    def _ask(prompt_text: str) -> Tuple[Optional[List[str]], Optional[List[str]], str]:
        raw = _call_model(
            client,
            model=model,
            temperature=0.1,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are an ESCO occupation/root selector."},
                {"role": "user", "content": prompt_text},
            ],
        )
        occ_out, root_out = _parse(raw)
        return occ_out, root_out, raw

    occ_choice = str(max_occ) if max_occ and max_occ > 0 else "all relevant"
    root_choice = str(max_roots) if max_roots and max_roots > 0 else "all relevant"

    def fmt_list(items: List[SkillEntry], with_desc: bool) -> str:
        if include_uri_in_prompt:
            return "\n".join(
                f"- [{idx+1}] {itm.label} (URI: {itm.uri})" + (f" :: {itm.description[:200]}" if with_desc else "")
                for idx, itm in enumerate(items)
            )
        return "\n".join(
            f"- [{idx+1}] {itm.label}" + (f" :: {itm.description[:200]}" if with_desc else "")
            for idx, itm in enumerate(items)
        )

    occ_snippet = fmt_list(occupations, False)
    roots_snippet = fmt_list(roots, True)
    prompt = (
        "You map author bios to ESCO occupations and top-level ESCO categories.\n"
        f"- Select up to {occ_choice} occupation indices.\n"
        f"- Select up to {root_choice} root category indices.\n"
        '- Return JSON: {"occupations": [<numbers>], "roots": [<numbers>]}. Use "NONE" for an empty list.\n'
        "- Base choices strictly on evidence in the bio.\n"
        f"Author: {author}\n"
        f"Bio: {bio}\n"
        "Occupation candidates:\n"
        f"{occ_snippet}\n"
        "Top ESCO categories:\n"
        f"{roots_snippet}\n"
    )
    occ_out, root_out, raw = _ask(prompt)
    if occ_out is None or root_out is None:
        retry_prompt = (
            prompt
            + "\nYour previous response did not include valid numeric indices. "
            'Respond again with JSON {"occupations": [numbers], "roots": [numbers]}. '
            f"Use numbers between 1 and {len(occupations)} for occupations and 1 and {len(roots)} for roots. "
            'If none apply, use "NONE".'
        )
        occ_out, root_out, raw_retry = _ask(retry_prompt)
        if occ_out is None:
            print(f"[warn] Could not parse occupations for '{author}'. Raw: {raw_retry}")
            occ_out = []
        if root_out is None:
            print(f"[warn] Could not parse root categories for '{author}'. Raw: {raw_retry}")
            root_out = []

    if max_occ and max_occ > 0:
        occ_out = occ_out[:max_occ]
    if max_roots and max_roots > 0:
        root_out = root_out[:max_roots]
    return occ_out or [], root_out or []


# -------------------
# Main workflow


def parse_args(argv: List[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Issue ESCO skill credential payloads from bios.")
    ap.add_argument("--bios-path", default="Validation/liar2/bios_of_expertise.json", help="Input bios JSON/CSV.")
    ap.add_argument("--esco-path", default="Validation/esco-v1.2.1.json-ld", help="ESCO JSON-LD path.")
    ap.add_argument("--output", required=True, help="Output JSONL path for credentials.")
    ap.add_argument("--gpt-model", default="gpt-4.1-mini", help="Azure OpenAI deployment name.")
    ap.add_argument("--seed", type=int, default=13, help="Deterministic shuffle seed.")
    ap.add_argument(
        "--max-skills",
        type=int,
        default=0,
        help="Max skills to emit per author (<=0 means no limit; default: no limit).",
    )
    ap.add_argument(
        "--skills-per-call",
        type=int,
        default=0,
        help="How many ESCO skills to send to GPT per call (<=0 sends all skills at once; default: all).",
    )
    ap.add_argument(
        "--include-uri-in-prompt",
        action="store_true",
        help="If set, include ESCO URIs in the prompt (defaults to labels+descriptions only).",
    )
    ap.add_argument(
        "--max-root-categories",
        type=int,
        default=0,
        help="How many top-level ESCO categories to show GPT (<=0 means all; default: all).",
    )
    ap.add_argument(
        "--max-root-choices",
        type=int,
        default=0,
        help="How many top categories GPT may pick before drilling down (<=0 means no limit; default: no limit).",
    )
    ap.add_argument(
        "--max-occupations",
        type=int,
        default=0,
        help="Max occupations for GPT to pick per author (<=0 means no limit).",
    )
    ap.add_argument(
        "--checkpoint-skills",
        type=int,
        default=0,
        help="Flush output after this many skills are written (<=0 disables).",
    )
    ap.add_argument(
        "--resume",
        action="store_true",
        help="Resume from existing output JSONL (skip authors already written).",
    )
    ap.add_argument(
        "--api-provider",
        choices=["azure", "openai", "all"],
        default="azure",
        help="Which OpenAI provider to use: azure, openai, or all (round-robin across both).",
    )
    ap.add_argument(
        "--client-assignment",
        choices=["roundrobin", "hash"],
        help="How to assign authors to clients when multiple clients are available.",
    )
    return ap.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    esco_raw = load_esco_skills(args.esco_path)
    occupations, essential_links, optional_links = load_occupations_and_skill_links(args.esco_path)
    skill_index = build_skill_index(esco_raw)
    skill_by_uri, children, roots = build_hierarchy(skill_index)
    roots = sorted(roots, key=lambda r: r.label.lower())
    if args.max_root_categories > 0:
        roots = roots[: args.max_root_categories]

    clients = _build_openai_clients(args.api_provider)
    if not clients:
        raise SystemExit("No OpenAI clients configured.")

    def load_processed(path: str) -> set[str]:
        seen: set[str] = set()
        if not os.path.exists(path):
            return seen
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                author_name = obj.get("author")
                if isinstance(author_name, str):
                    seen.add(author_name)
        return seen

    processed_authors: set[str] = load_processed(args.output) if args.resume else set()

    # First pass: count totals without loading all bios.
    total_pending = sum(
        1
        for author, _bio in iter_bios(args.bios_path)
        if author not in processed_authors and not _is_non_person_author(author)
    )

    print(
        f"[info] Loaded skills: {len(skill_index)}, occupations: {len(occupations)}, roots: {len(roots)}, pending bios: {total_pending}"
    )

    # Determine client assignment strategy.
    if args.client_assignment:
        assignment = args.client_assignment
    else:
        assignment = "hash" if args.api_provider == "all" and len(clients) > 1 else "roundrobin"

    with open(args.output, "a" if args.resume else "w", encoding="utf-8") as out_f:
        skills_since_checkpoint = 0
        with tqdm(total=total_pending, desc="Authors", unit="author") as pbar:
            client_idx = 0
            for author, bio in iter_bios(args.bios_path):
                if _is_non_person_author(author):
                    # Skip organizations, PACs, media outlets, etc. (not counted in total_pending)
                    continue
                if author in processed_authors:
                    continue
                if not bio:
                    print(f"[warn] Skipping '{author}' due to empty bio.")
                    pbar.update(1)
                    continue
                if len(clients) == 1:
                    client = clients[0]
                elif assignment == "hash":
                    client = clients[abs(hash(author)) % len(clients)]
                else:
                    client = clients[client_idx % len(clients)]
                    client_idx += 1
                try:
                    domains = _domains_from_bio(bio)
                    domain_batches: List[List[SkillEntry]] = []
                    for d in domains:
                        kws = DOMAIN_KEYWORDS.get(d) or []
                        subset = filter_skills_by_keyword(skill_index, kws, limit=500)
                        if subset:
                            domain_batches.append(subset)
                    occ_candidates = occupations  # send all occupations to GPT
                    selected_occ_uris, selected_root_uris = gpt_choose_occ_and_roots(
                        client,
                        model=args.gpt_model,
                        author=author,
                        bio=bio,
                        occupations=occ_candidates,
                        roots=roots,
                        max_occ=args.max_occupations,
                        max_roots=args.max_root_choices,
                        include_uri_in_prompt=args.include_uri_in_prompt,
                    )
                    if not selected_root_uris and not selected_occ_uris:
                        record = {
                            "author": author,
                            "skills_from_occupations": [],
                            "skills_from_bio": []
                        }
                        out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
                        continue
                    occ_skills: List[Dict[str, str]] = []
                    bio_skills: List[Dict[str, str]] = []
                    seen_uris: set[str] = set()
                    # Add occupation-linked skills
                    for occ_uri in selected_occ_uris:
                        for uri in essential_links.get(occ_uri, []):
                            if uri in seen_uris:
                                continue
                            if uri in skill_by_uri:
                                seen_uris.add(uri)
                                occ_skills.append(
                                    {"uri": uri, "label": skill_by_uri[uri].label, "reason": "Occupation essential skill"}
                                )
                    for batch in domain_batches:
                        selected = gpt_select_skills(
                            client,
                            model=args.gpt_model,
                            author=author,
                            bio=bio,
                            skills_batch=batch,
                            max_output_skills=args.max_skills,
                            include_uri_in_prompt=args.include_uri_in_prompt,
                        )
                        for item in selected:
                            if item["uri"] in seen_uris:
                                continue
                            seen_uris.add(item["uri"])
                            bio_skills.append(item)
                    for root_uri in selected_root_uris:
                        subset = collect_descendants(root_uri, children, skill_by_uri)
                        if not subset:
                            continue
                        skills_batches = (
                            [subset]
                            if args.skills_per_call <= 0
                            else [subset[i : i + args.skills_per_call] for i in range(0, len(subset), args.skills_per_call)]
                        )
                        for batch in skills_batches:
                            selected = gpt_select_skills(
                                client,
                                model=args.gpt_model,
                                author=author,
                                bio=bio,
                                skills_batch=batch,
                                max_output_skills=args.max_skills,
                                include_uri_in_prompt=args.include_uri_in_prompt,
                            )
                            for item in selected:
                                if item["uri"] in seen_uris:
                                    continue
                                seen_uris.add(item["uri"])
                                bio_skills.append(item)
                    if args.max_skills > 0:
                        bio_skills = bio_skills[: args.max_skills]
                        occ_skills = occ_skills[: args.max_skills]
                    # Ensure we emit a single JSON line per author with deduped skills.
                    occ_skills = _dedupe_skills_by_uri(occ_skills)
                    bio_skills = _dedupe_skills_by_uri(bio_skills)
                    merged_unique = _dedupe_skills_by_uri(occ_skills + bio_skills)
                    record = {
                        "author": author,
                        "skills_from_occupations": occ_skills,
                        "skills_from_bio": bio_skills,
                    }
                    out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
                    skills_since_checkpoint += len(merged_unique) + len(occ_skills) + len(bio_skills)
                    if args.checkpoint_skills > 0 and skills_since_checkpoint >= args.checkpoint_skills:
                        out_f.flush()
                        os.fsync(out_f.fileno())
                        skills_since_checkpoint = 0
                except AuthorTimeout:
                    print(f"[warn] Timeout; skipping author '{author}'")
                finally:
                    pbar.update(1)
        out_f.flush()
        os.fsync(out_f.fileno())

    print(f"Wrote credentials to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
