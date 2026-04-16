#!/usr/bin/env python3
from _cavs_fdhn_common import ExperimentConfig, run_named_experiment


if __name__ == "__main__":
    raise SystemExit(
        run_named_experiment(
            ExperimentConfig(
                model_name='5.3.statement_confidence_binary',
                family='gpt_competent_classifier',
                task='binary',
                use_skills=False,
                use_confidence=True,
                use_reason=False,
            )
        )
    )
