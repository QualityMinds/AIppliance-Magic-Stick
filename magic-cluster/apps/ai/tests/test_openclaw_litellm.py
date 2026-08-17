import pathlib
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
OPENCLAW_TEMPLATE = (
    REPO_ROOT
    / "magic-cluster"
    / "apps"
    / "instances"
    / "openclaw"
    / "templates"
    / "instance.yaml"
)


class OpenClawLiteLLMChartTests(unittest.TestCase):
    def test_chart_uses_the_generated_litellm_catalog(self):
        template = OPENCLAW_TEMPLATE.read_text(encoding="utf-8")

        self.assertIn(
            "configMapRef:\n      name: ai-model-catalog\n      key: openclaw.json",
            template,
        )
        self.assertIn(
            "forcePaths:\n      - models.providers\n      - agents.defaults.model",
            template,
        )
        self.assertIn("- name: LITELLM_API_KEY", template)
        self.assertIn("name: litellm-masterkey-secret", template)
        self.assertIn("key: LITELLM_MASTER_KEY", template)

    def test_chart_does_not_rely_on_unsupported_openai_environment_overrides(self):
        template = OPENCLAW_TEMPLATE.read_text(encoding="utf-8")

        self.assertNotIn("OPENAI_BASE_URL", template)
        self.assertNotIn("OPENCLAW_DEFAULT_MODEL", template)
        self.assertNotIn("- name: OPENAI_API_KEY", template)


if __name__ == "__main__":
    unittest.main()
