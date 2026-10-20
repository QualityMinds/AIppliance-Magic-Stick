"""APP-09 / ROUTE-08: catalog render and runtime credential boundaries.

Requires kubectl, the Flux CLI and PyYAML; Public release checks installs them
and discovers this suite. No cluster, credentials or network are used.
"""

import json
import os
import pathlib
import shutil
import subprocess
import unittest
from unittest.mock import patch

import yaml

from test_controller import load_controller


ROOT = pathlib.Path(__file__).resolve().parent


class CatalogFluxRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for tool in ("kubectl", "flux"):
            if not shutil.which(tool):
                raise RuntimeError(f"Catalog Flux render tests require {tool} on PATH")
        cls.rendered = subprocess.run(
            ["kubectl", "kustomize", str(ROOT)],
            check=True, capture_output=True, text=True, timeout=60,
        ).stdout

    def substitute(self, variables):
        result = subprocess.run(
            ["flux", "envsubst", "--strict"],
            input=self.rendered, capture_output=True, text=True, timeout=30,
            env={"PATH": os.environ["PATH"], **variables},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return list(yaml.safe_load_all(result.stdout))

    @staticmethod
    def resource(resources, kind, name):
        return next(item for item in resources
                    if item["kind"] == kind and item["metadata"]["name"] == name)

    def test_runtime_key_placeholder_survives_strict_flux_without_or_with_a_key(self):
        for variables in ({}, {"LITELLM_API_KEY": "synthetic-do-not-substitute"}):
            with self.subTest(variables_present=bool(variables)):
                resources = self.substitute(variables)
                deployment = self.resource(resources, "Deployment", "ai-model-catalog-controller")
                volume = next(item for item in deployment["spec"]["template"]["spec"]["volumes"]
                              if item["name"] == "controller")
                source = self.resource(resources, "ConfigMap", volume["configMap"]["name"])["data"]["controller.py"]
                self.assertEqual(source, (ROOT / "controller.py").read_text(encoding="utf-8"))
                with patch.dict(os.environ, {}, clear=True):
                    controller = load_controller(source)
                    generated, _ = controller["build_catalog"]([{
                        "model_name": "example-chat",
                        "litellm_params": {"model": "openai/example-chat"},
                        "model_info": {"ai_appliance_type": "chat"},
                    }])
                bootstrap = self.resource(resources, "ConfigMap", "ai-model-catalog")["data"]
                for data in (bootstrap, generated):
                    openclaw = json.loads(data["openclaw.json"])["models"]["providers"]["litellm"]
                    pi = json.loads(data["pi-models.json"])["providers"]["litellm"]
                    for provider in (openclaw, pi):
                        self.assertEqual(provider["apiKey"], "${LITELLM_API_KEY}")
                    self.assertNotIn("synthetic-do-not-substitute", json.dumps(data))
                self.assertEqual(
                    json.loads(generated["pi-models.json"])["providers"]["litellm"]["models"][0]["id"],
                    "example-chat",
                )

    def test_flux_still_resolves_model_defaults_and_preserves_secret_reference(self):
        for variables in ({}, {
            "AI_APPLIANCE_DEFAULT_CHAT_MODEL": "example-chat",
            "AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL": "example-embedding",
        }):
            with self.subTest(explicit_defaults=bool(variables)):
                resources = self.substitute(variables)
                deployment = self.resource(resources, "Deployment", "ai-model-catalog-controller")
                env = {item["name"]: item for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
                for name in ("AI_APPLIANCE_DEFAULT_CHAT_MODEL", "AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL"):
                    self.assertEqual(env[name]["value"], variables.get(name, "auto"))
                self.assertEqual(env["LITELLM_MASTER_KEY"]["valueFrom"], {
                    "secretKeyRef": {"name": "litellm-masterkey-secret", "key": "LITELLM_MASTER_KEY"},
                })


if __name__ == "__main__":
    unittest.main()
