#!/usr/bin/env python3
import argparse
import json
import os
import time
from typing import Any

from openai import OpenAI
from tqdm import tqdm


MODEL_DEFAULT = "gpt-4.1-mini"
TEMPERATURE_DEFAULT = 0

PROMPT_TEMPLATE = """\
Convert the following short bio into a semicolon-separated list of phrases suitable
for a skills extractor.

Rules:
- Output ONLY the phrase list (no extra text).
- Separate items with '; '.
- Include ONLY phrases explicitly supported by the bio (do not invent).
- Prefer:
  * degrees (e.g. 'Bachelor of Arts', 'Juris Doctor')
  * institutions (e.g. 'Brown University')
  * job titles/roles (e.g. 'Mayor of Cranston, Rhode Island')
  * domains/expertise phrases (e.g. 'public administration', 'legal practice')
- Keep wording close to the bio; basic whitespace cleanup is ok.
- If the bio contains no useful items, output 'Not available'.

Bio:
{bio}
"""


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def atomic_write_json(path: str, data: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def normalize_phrase_list(s: str) -> str:
    s = (s or "").strip()
    s = " ".join(s.split())
    # Strip wrapping quotes if present.
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    return s


def generate_phrases(client: OpenAI, *, bio: str, model: str, temperature: float) -> str:
    response = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": "You extract factual phrase lists from provided text."},
            {"role": "user", "content": PROMPT_TEMPLATE.format(bio=bio)},
        ],
    )
    return normalize_phrase_list((response.choices[0].message.content or "").strip())


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Convert bios JSON into semicolon-separated phrase lists via OpenAI."
    )
    ap.add_argument(
        "--bios",
        default="Validation/liar2/data/final/bios/bios_of_expertise.json",
        help="Input JSON mapping name -> bio text (default: Validation/liar2/data/final/bios/bios_of_expertise.json).",
    )
    ap.add_argument(
        "--output",
        default="Validation/liar2/data/final/skills/bios_skill_phrases.json",
        help="Output JSON mapping name -> semicolon phrase list.",
    )
    ap.add_argument("--model", default=MODEL_DEFAULT)
    ap.add_argument("--temperature", type=float, default=TEMPERATURE_DEFAULT)
    ap.add_argument("--sleep-s", type=float, default=0.5)
    ap.add_argument("--resume", action="store_true", help="Resume from existing output JSON.")
    args = ap.parse_args()

    bios = load_json(args.bios)
    if not isinstance(bios, dict):
        raise SystemExit(f"--bios must be a JSON object (dict), got {type(bios)}")

    results: dict[str, str] = {}
    if args.resume and os.path.exists(args.output):
        try:
            results = load_json(args.output) or {}
        except Exception:
            results = {}

    endpoint = os.getenv("OPENAI_BASE_URL") or os.getenv("AZURE_OPENAI_ENDPOINT") or "https://cavs.openai.azure.com/openai/v1"
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AZURE_OPENAI_API_KEY")
    client = OpenAI(base_url=endpoint, api_key=api_key)

    items = list(bios.items())
    for name, bio in tqdm(items, desc="Generating phrase lists"):
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(bio, str) or not bio.strip():
            continue
        if args.resume and name in results and results[name] and not str(results[name]).startswith("ERROR:"):
            continue

        try:
            out = generate_phrases(client, bio=bio, model=args.model, temperature=args.temperature)
            results[name] = out if out else "Not available"
        except Exception as e:
            results[name] = f"ERROR: {e}"

        atomic_write_json(args.output, results)
        time.sleep(args.sleep_s)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
