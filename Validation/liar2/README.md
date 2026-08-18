# LIAR2 Validation Package

This directory is the reviewer-facing LIAR2 package used in CAVS. It contains:

- the raw LIAR2 splits,
- the already-computed bio, skill, and competence artifacts,
- family-specific augmented CSV bundles for ablation,
- and the executable scripts needed to rebuild or rerun the pipeline.

## Start Here

- `data/final/ablation/gpt_competent_classifier/`
  Ready-to-run GPT competence dataset bundle.
- `data/final/ablation/roberta_nesta/`
  Ready-to-run RoBERTa+Nesta competence dataset bundle.
- `ablation_experiments/`
  Full numbered LIAR2 ablation catalog, including the new CAVS scripts.
- `scripts/`
  Pipeline scripts grouped by stage.

## Directory Layout

- `data/raw/liar2/`
  Canonical LIAR2 split files: `train.csv`, `valid.csv`, `test.csv`, `all.csv`.
- `ablation_experiments/`
  Shortcut to `data/raw/liar2/ablation_experiments/`.
- `data/final/bios/`
  Precomputed biography artifacts.
- `data/final/skills/`
  Precomputed skill mapping artifacts.
- `data/final/ablation/`
  Canonical grouped competence JSON files and family-specific ablation bundles.
- `scripts/`
  Pipeline code for bios, skills, competence scoring, dataset assembly, and
  dataset materialization.

## Canonical Data Artifacts

- `data/final/bios/bios_of_expertise.json`
  Author biography lookup.
- `data/final/bios/liar2_all_splits_bios.csv`
  Flat LIAR2 biography table.
- `data/final/skills/skills_output.jsonl`
  Author-skill mappings used by competence scoring.
- `data/final/skills/liar2_all_splits_competence_skills_gpt_with_skills.json`
  Grouped LIAR2 records enriched with mapped skills.
- `data/final/ablation/liar2_ablation_reference.json`
  Canonical grouped GPT competence dataset.
- `data/final/ablation/liar2_ablation_reference_dedup.json`
  Deduplicated grouped GPT competence dataset.
- `data/final/ablation/liar2_roberta_nesta_ablation.json`
  Canonical grouped RoBERTa+Nesta competence dataset.

Each family directory under `data/final/ablation/` contains:

- `grouped_source.json`
- `flat.csv`
- `train_augmented.csv`
- `valid_augmented.csv`
- `test_augmented.csv`
- `metadata.json`

## Ablation Layout

The ablation catalog follows the original LIAR2 numbering and adds CAVS blocks:

- `1.x`
  Original LIAR2 single-feature multiclass ablations.
- `2.x`
  Original LIAR2 "all features except one" multiclass ablations.
- `3.x`
  Original LIAR2 "statement + one feature" multiclass ablations.
- `4.x`
  CAVS multiclass competence ablations for GPT and RoBERTa+Nesta.
- `5.x`
  CAVS binary competence ablations, including the statement-only binary
  baseline.

For the CAVS `4.x` and `5.x` scripts, direct execution runs five seeds by
default (`42,43,44,45,46`) and reports mean `±` standard deviation for the
post-training saved-model validation and test metrics. This matches the
original LIAR2 pattern of training, saving the model, reloading it, and then
printing the final evaluation. Pass `--seed <n>` to force a single run. The
binary target is defined as `label >= 3` for true-news and `label < 3` for
false-news (barely-true is grouped with false-news, matching the paper's
Table 1 base rates; results produced before 2026-07-08 used `label >= 2`).
Binary scripts report `F1`; multiclass scripts report `F1 Macro` and `F1 Micro`.

See `ablation_experiments/README.md` for the detailed numbering map.

## Workflow

1. Build or refresh bios with `scripts/bios/`.
2. Build or refresh skill mappings with `scripts/skills/`.
3. Produce grouped competence labels with `scripts/competence_gpt/` or
   `scripts/competence_roberta_nesta/`.
4. Materialize the family-specific augmented split CSVs with
   `scripts/pipeline/augment_with_skills.py`.
5. Run either the original LIAR2 ablations or the CAVS extensions from
   `ablation_experiments/`.

## Common Commands

```bash
python3 -m pip install -r Validation/liar2/requirements.txt
python3 Validation/liar2/scripts/pipeline/augment_with_skills.py --families all
python3 Validation/liar2/ablation_experiments/1.1.statement.py
python3 Validation/liar2/ablation_experiments/4.2.statement_confidence.py
python3 Validation/liar2/ablation_experiments/4.7.statement_iscompetent_confidence_reason.py
python3 Validation/liar2/ablation_experiments/5.15.statement_iscompetent_confidence_reason_binary_roberta_nesta.py
```

For dependency installation, use `requirements.txt`. For pipeline details, see
`scripts/README.md`. For experiment numbering, see
`ablation_experiments/README.md`.
