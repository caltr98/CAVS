#!/usr/bin/env python3
from _cavs_fdhn_common import ExperimentConfig, run_named_experiment


if __name__ == "__main__":
    raise SystemExit(
        run_named_experiment(
            ExperimentConfig(
                model_name='5.13.statement_iscompetent_reason_binary_roberta_nesta',
                family='roberta_nesta',
                task='binary',
                use_skills=True,
                use_confidence=False,
                use_reason=True,
            )
        )
    )
