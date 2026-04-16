#!/usr/bin/env python3
from _cavs_fdhn_common import ExperimentConfig, run_named_experiment


if __name__ == "__main__":
    raise SystemExit(
        run_named_experiment(
            ExperimentConfig(
                model_name='4.5.statement_iscompetent_reason',
                family='gpt_competent_classifier',
                task='multiclass',
                use_skills=True,
                use_confidence=False,
                use_reason=True,
            )
        )
    )
