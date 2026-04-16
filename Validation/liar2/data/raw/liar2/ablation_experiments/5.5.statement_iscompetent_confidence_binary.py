#!/usr/bin/env python3
from _cavs_fdhn_common import ExperimentConfig, run_named_experiment


if __name__ == "__main__":
    raise SystemExit(
        run_named_experiment(
            ExperimentConfig(
                model_name='5.5.statement_iscompetent_confidence_binary',
                family='gpt_competent_classifier',
                task='binary',
                use_skills=True,
                use_confidence=True,
                use_reason=False,
            )
        )
    )
