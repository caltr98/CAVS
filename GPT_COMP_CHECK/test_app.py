import os
import unittest
from unittest.mock import patch

import app


AZURE_MODELS = (
    "grok-4.3",
    "DeepSeek-V4-Flash",
    "gpt-5.6-luna",
    "gpt-5.4-mini",
    "Kimi-K2.5",
    "Mistral-Large-3",
)


class CompetenceServiceTests(unittest.TestCase):
    def test_build_client_uses_configured_retry_budget(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_BASE_URL": "https://example.invalid/v1",
                "OPENAI_TIMEOUT_S": "123",
                "OPENAI_MAX_RETRIES": "5",
            },
            clear=False,
        ), patch.object(app, "OpenAI") as openai:
            app._build_client(app.CompetenceRequest(statement="claim"))

        openai.assert_called_once_with(
            api_key="test-key",
            base_url="https://example.invalid/v1",
            timeout=123.0,
            max_retries=5,
        )

    def test_detects_explicit_provider_content_filter(self) -> None:
        class Filtered(Exception):
            message = "finish_reason='content_filter': Response content blocked by label"

        self.assertTrue(app._is_provider_content_filter_error(Filtered()))
        self.assertFalse(app._is_provider_content_filter_error(Exception("HTTP 429 rate limit")))

    def test_health(self) -> None:
        self.assertEqual(app.health(), {"ok": True})

    def test_all_six_azure_services_report_their_model_provenance(self) -> None:
        for model in AZURE_MODELS:
            with self.subTest(model=model), patch.dict(
                os.environ,
                {
                    "COMPETENCE_BACKEND": "azure-openai",
                    "COMPETENCE_MODEL_ID": f"azure:{model}",
                    "OPENAI_MODEL": model,
                },
                clear=False,
            ):
                response = app._normalize_result(
                    {"competent": True, "confidence": 0.75, "reason": "Matching domain skills."}
                )
                self.assertEqual(response.competence_backend, "azure-openai")
                self.assertEqual(response.competence_model, f"azure:{model}")
                self.assertTrue(response.competent_skill_gpt)

    def test_no_valid_esco_skills_skips_paid_model_call(self) -> None:
        with patch.object(app, "_validated_skill_labels", return_value=([], 1)), patch.object(
            app, "_call_model"
        ) as call_model:
            response = app._competence_uncached(app.CompetenceRequest(statement="claim", skills=["invalid"]))
        call_model.assert_not_called()
        self.assertFalse(response.competent_skill_gpt)


if __name__ == "__main__":
    unittest.main()
