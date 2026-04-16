#!/usr/bin/env python3
from _cavs_fdhn_common import ExperimentConfig, run_named_experiment


if __name__ == "__main__":
    raise SystemExit(
        run_named_experiment(
            ExperimentConfig(
                model_name='4.14.statement_iscompetent_confidence_reason_roberta_nesta',
                family='roberta_nesta',
                task='multiclass',
                use_skills=True,
                use_confidence=True,
                use_reason=True,
            )
        )
    )
