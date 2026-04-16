#!/usr/bin/env python3
import argparse
import json
import os
import time
import re
from typing import Any

from openai import OpenAI
from tqdm import tqdm


MODEL_DEFAULT = "gpt-4.1-mini"
TEMPERATURE_DEFAULT = 0

PROMPT_TEMPLATE = """\
Write a concise, factual bio describing the education, work history,
and main area(s) of expertise of the following person.

Rules:
- Focus on professional background and expertise.
- Be neutral and non-promotional.
- If education or work history is unknown, state this explicitly.
- Do NOT speculate or invent facts.
- Output ONE paragraph only.

Person: {name}
"""


def _collapse_ws(s: str) -> str:
    return " ".join((s or "").split()).strip()


def is_probable_person(name: str) -> bool:
    """
    Heuristic to avoid generating bios for organizations.

    Reject obvious org markers (citizens/county/party/committee/etc.), long
    prepositional phrases (\"for\"/\"of\" with 4+ tokens), and common org keywords.
    """
    n = _collapse_ws(name).lower()
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

    # Phrases with " for " or " of " plus 4+ tokens are usually orgs (e.g., "Citizens for the Republic").
    if ((" for " in n) or (" of " in n)) and len(n.split()) >= 4:
        return False

    # Names with obvious org punctuation (e.g., '&', '/', '#') are likely non-persons.
    if re.search(r"[&/]", n):
        return False

    return True


def load_names(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def atomic_write_json(path: str, data: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def generate_bio(client: OpenAI, *, name: str, model: str, temperature: float) -> str:
    response = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": "You write concise, factual biographical summaries."},
            {"role": "user", "content": PROMPT_TEMPLATE.format(name=name)},
        ],
    )
    return (response.choices[0].message.content or "").strip()


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate one-paragraph bios via OpenAI Chat Completions.")
    ap.add_argument("--input", required=True, help="Text file with one name per line.")
    ap.add_argument("--output", required=True, help="Output JSON mapping name -> bio/error.")
    ap.add_argument("--model", default=MODEL_DEFAULT)
    ap.add_argument("--temperature", type=float, default=TEMPERATURE_DEFAULT)
    ap.add_argument("--sleep-s", type=float, default=0.5, help="Seconds to sleep between requests.")
    ap.add_argument("--resume", action="store_true", help="Resume from existing output JSON.")
    ap.add_argument(
        "--save-every",
        type=int,
        default=25,
        help="Persist results every N new bios to reduce frequent disk writes (0 to only save at end).",
    )
    args = ap.parse_args()

    endpoint = os.getenv("OPENAI_BASE_URL") or os.getenv("AZURE_OPENAI_ENDPOINT") or "https://cavs.openai.azure.com/openai/v1"
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AZURE_OPENAI_API_KEY")
    client = OpenAI(base_url=endpoint, api_key=api_key)
    names = load_names(args.input)

    results: dict[str, str] = {}
    if args.resume and os.path.exists(args.output):
        try:
            with open(args.output, "r", encoding="utf-8") as f:
                results = json.load(f) or {}
        except Exception:
            results = {}

    last_save_count = len(results)
    for name in tqdm(names, desc="Generating bios"):
        if args.resume and name in results and results[name] and not str(results[name]).startswith("ERROR:"):
            continue
        if not is_probable_person(name):
            # Record a skip marker so we don't retry on resume.
            results[name] = "SKIPPED: non-person candidate (heuristic)"
            if args.save_every > 0 and (len(results) - last_save_count) >= args.save_every:
                atomic_write_json(args.output, results)
                last_save_count = len(results)
            continue
        try:
            bio = generate_bio(client, name=name, model=args.model, temperature=args.temperature)
            results[name] = bio
        except Exception as e:
            results[name] = f"ERROR: {e}"
        if args.save_every > 0 and (len(results) - last_save_count) >= args.save_every:
            atomic_write_json(args.output, results)
            last_save_count = len(results)
        time.sleep(args.sleep_s)

    # Always persist final state.
    if len(results) != last_save_count:
        atomic_write_json(args.output, results)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
