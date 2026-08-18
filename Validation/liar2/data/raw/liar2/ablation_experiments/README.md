# LIAR2 Ablation Experiments

This directory contains the full LIAR2 ablation catalog shipped with the
Validation package.

## Numbering

- `1.x`
  Original LIAR2 single-feature multiclass ablations copied from
  `/home/cal/componentsCAVS/liar2/ablation_experiments`.
- `2.x`
  Original LIAR2 "all features except one" multiclass ablations.
- `3.x`
  Original LIAR2 "statement + one feature" multiclass ablations.
- `4.x`
  CAVS multiclass ablations on the Validation competence datasets.
- `5.x`
  CAVS binary ablations on the Validation competence datasets.

## CAVS Families

- `gpt_competent_classifier`
  Uses `Validation/liar2/data/final/ablation/gpt_competent_classifier/`.
- `roberta_nesta`
  Uses `Validation/liar2/data/final/ablation/roberta_nesta/`.

## CAVS Feature Blocks

The CAVS scripts use the competence columns already stored in the augmented
split CSVs:

- `skills_gpt_competent`
- `confidence_gpt`
- `gpt_reason`

The numbering is organized as follows.

### Multiclass CAVS (`4.x`)

- `4.1` to `4.7`
  GPT competence family.
- `4.8` to `4.14`
  RoBERTa+Nesta competence family.

Feature combinations:

- `statement + iscompetent`
- `statement + confidence`
- `statement + reason`
- `statement + iscompetent + confidence`
- `statement + iscompetent + reason`
- `statement + confidence + reason`
- `statement + iscompetent + confidence + reason`

### Binary CAVS (`5.x`)

- `5.1`
  Statement-only binary baseline.
- `5.8`
  GPT competence family, used for the full `statement + iscompetent + confidence + reason` binary ablation.
- `5.15`
  RoBERTa+Nesta competence family, used for the full `statement + iscompetent + confidence + reason` binary ablation.

The packaged binary sweep is intentionally reduced to three cases:

- `5.1` statement-only baseline
- `5.8` GPT `statement + iscompetent + confidence + reason`
- `5.15` RoBERTa+Nesta `statement + iscompetent + confidence + reason`

The binary target matches the paper's true-news/false-news definition
(barely-true grouped with false-news):

- `label >= 3` -> `1`
- `label < 3` -> `0`

Results produced before 2026-07-08 used the older `label >= 2` convention and
must be regenerated before being compared with new runs.

By default, the CAVS scripts run five seeds (`42,43,44,45,46`) and print mean
`±` standard deviation for validation and test metrics from the post-training
saved-model evaluation. This follows the original LIAR2 pattern: train, save
the model during training, reload the saved model, and print the final
evaluation. You can force a single run with `--seed`.

Metric reporting:

- binary scripts: `Loss`, `Acc`, `F1`, `RMSE`
- multiclass scripts: `Loss`, `Acc`, `F1 Macro`, `F1 Micro`, `RMSE`

## Running

All scripts resolve their dataset paths relative to this Validation package, so
they can be launched from the repository root.

Examples:

```bash
python3 Validation/liar2/ablation_experiments/1.1.statement.py
python3 Validation/liar2/ablation_experiments/4.7.statement_iscompetent_confidence_reason.py
python3 Validation/liar2/ablation_experiments/5.15.statement_iscompetent_confidence_reason_binary_roberta_nesta.py
```

To force a single CAVS run with an explicit seed:

```bash
python3 Validation/liar2/ablation_experiments/5.15.statement_iscompetent_confidence_reason_binary_roberta_nesta.py --seed 42
```

## Notes

- The original `1.x`, `2.x`, and `3.x` `.out` files are preserved as reference
  logs from the LIAR2 benchmark package.
- The new `4.x` and `5.x` CAVS scripts share `_cavs_fdhn_common.py` to keep the
  experiment logic consistent across GPT and RoBERTa+Nesta runs.
