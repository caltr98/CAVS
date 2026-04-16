#!/usr/bin/env python3
from _cavs_fdhn_common import ExperimentConfig, run_named_experiment


if __name__ == "__main__":
    raise SystemExit(
        run_named_experiment(
            ExperimentConfig(
                model_name='4.2.statement_confidence',
                family='gpt_competent_classifier',
                task='multiclass',
                use_skills=False,
                use_confidence=True,
                use_reason=False,
            )
        )
    )
