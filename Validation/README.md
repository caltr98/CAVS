# Validation

This directory holds validation data, shared lookup files, and experiment code.
Most LIAR2 work starts in `liar2/`.

## Start Here

- `liar2/`
  Complete LIAR2 package with raw inputs, precomputed outputs, and pipeline
  scripts.
- `liar2/ablation_experiments/`
  Full LIAR2 and CAVS ablation catalog (`1.x` through `5.x`).
- `liar2/data/final/ablation/`
  Grouped competence outputs and family-specific augmented datasets.
- `liar2/scripts/`
  LIAR2 pipeline scripts grouped by stage.

## Shared Files In This Folder

- `esco-v1.2.1.json-ld`
  ESCO reference data.
- `majors-list.csv`
  Degree and major lookup data.
- `bio_terms_support.csv`
  Support table for biography term handling.
- `skills_output.jsonl`
  Shared skill inventory output.
- `assign_esco_skills.py`
  ESCO assignment helper.
- `gpt_issue_credentials.py`
  Helper script for GPT credential checks.
- `fake-news-detection/`
  Related model and experiment code.

## Main Path

If you are working on the LIAR2 package, go to `liar2/README.md`.
