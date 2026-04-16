# LIAR2 Scripts

This directory contains the executable pipeline used to build and rerun the
LIAR2 Validation package.

## Folders

- `bios/`
  Biography generation and enrichment.
- `skills/`
  Skill phrase extraction and skill mapping.
- `competence_gpt/`
  GPT-based competence scoring.
- `competence_roberta_nesta/`
  RoBERTa+Nesta competence scoring.
- `pipeline/`
  Canonical dataset assembly and summary generation.

## Main Entry Points

- `bios/build_wiki_bios.py`
  Build Wikipedia-based bios.
- `bios/generate_bios_openai.py`
  Generate bios through the OpenAI path.
- `skills/generate_skill_phrases_openai.py`
  Convert bios into skill phrases.
- `competence_gpt/build_competence_input_all_splits.py`
  Build grouped GPT competence input.
- `competence_gpt/gpt_competence_classifier_from_skills.py`
  Score grouped GPT competence from mapped skills.
- `competence_gpt/gpt_competence_rescore_skipped.py`
  Re-run skipped GPT competence records.
- `competence_roberta_nesta/tokenize_and_call_nesta.py`
  Run the RoBERTa+Nesta competence path.
- `pipeline/augment_with_skills.py`
  Build the final family-specific augmented split CSVs.
- `pipeline/flatten_grouped_competence_json_to_csv.py`
  Flatten grouped competence JSON into article-level CSV.
- `pipeline/compute_competence_probabilities.py`
  Print grouped competence summaries.

## Typical Order

1. `bios/build_wiki_bios.py` or `bios/generate_bios_openai.py`
2. `skills/generate_skill_phrases_openai.py`
3. `competence_gpt/gpt_competence_classifier_from_skills.py` or
   `competence_roberta_nesta/tokenize_and_call_nesta.py`
4. `pipeline/augment_with_skills.py`
5. Direct execution of the numbered scripts in `../ablation_experiments/`.

## Suggested Commands

Build both final family bundles:

```bash
python3 -m pip install -r Validation/liar2/requirements.txt
python3 Validation/liar2/scripts/pipeline/augment_with_skills.py --families all
```

The numbered CAVS scripts (`4.x` and `5.x`) run five seeds by default
(`42,43,44,45,46`) and print mean `±` standard deviation for validation and
test metrics from the post-training saved-model evaluation. To force a single
run, pass `--seed <n>`.

Binary CAVS scripts report `F1`. Multiclass CAVS scripts report `F1 Macro` and
`F1 Micro`.

## Outputs To Inspect

- `../data/final/bios/`
- `../data/final/skills/`
- `../data/final/ablation/`
- `../ablation_experiments/`

The detailed experiment numbering is documented in `../ablation_experiments/README.md`.
