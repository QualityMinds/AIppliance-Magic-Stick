import pathlib
import shutil
import subprocess
import unittest

import yaml


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
MODEL_CATALOG_BOOTSTRAP = (
    REPO_ROOT
    / "magic-cluster"
    / "apps"
    / "ai"
    / "model-catalog"
    / "catalog-configmap.yaml"
)


class OpenClawLiteLLMChartTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is required for the ownership helper")
    def test_data_owner_helper_fails_closed_and_never_traverses_data(self):
        test_file = REPO_ROOT / "magic-cluster/apps/ai/tests/openclaw_data_owner.test.cjs"
        subprocess.run(["node", "--test", str(test_file)], check=True, capture_output=True, text=True)

    @unittest.skipUnless(shutil.which("helm"), "Helm is required for instance rendering")
    def test_instance_chart_scopes_owner_repair_to_its_data_volume(self):
        values = {"instance": {"name": "openclaw-example", "namespace": "ai", "application": "openclaw",
                              "localHost": "example.local", "localName": "openclaw-example", "values": {}}}
        chart = OPENCLAW_TEMPLATE.parents[1]
        rendered = subprocess.run(["helm", "template", "fixture", str(chart), "-f", "-"],
                                  input=yaml.safe_dump(values), text=True, capture_output=True, check=True)
        instance = yaml.safe_load(rendered.stdout)
        self.assertEqual(instance["kind"], "OpenClawInstance")
        spec = instance["spec"]
        self.assertEqual(spec["security"]["podSecurityContext"],
                         {"runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000, "runAsNonRoot": True})
        self.assertEqual(len(spec["initContainers"]), 1)
        init = spec["initContainers"][0]
        image = spec["image"]
        self.assertEqual(init["image"], image["repository"] + ":" + image["tag"] + "@" + image["digest"])
        self.assertEqual(init["command"], ["node", "-e"])
        self.assertEqual(init["volumeMounts"], [{"name": "data", "mountPath": "/data"}])
        self.assertEqual(init["securityContext"], {"runAsUser": 0, "runAsGroup": 0, "runAsNonRoot": False,
                         "allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                         "capabilities": {"drop": ["ALL"], "add": ["CHOWN"]},
                         "seccompProfile": {"type": "RuntimeDefault"}})
        helper = (OPENCLAW_TEMPLATE.parents[1] / "files/ensure-data-owner.cjs").read_text(encoding="utf-8")
        self.assertIn(helper.rstrip(), init["args"][0])
        self.assertTrue(init["args"][0].endswith("ensureDataOwner(require('node:fs'));\n"))
        if shutil.which("node"):
            wrapper = """
const vm = require('node:vm');
let checked = false;
const fs = {lstatSync(path, options) {
  if (path !== '/data' || options.bigint !== true) throw Error('unexpected target');
  checked = true;
  return {uid: 1000n, gid: 1000n, isDirectory: () => true, isSymbolicLink: () => false};
}};
vm.runInNewContext(process.argv[1], {module: {exports: {}}, require: () => fs});
if (!checked) throw Error('embedded helper did not run');
"""
            subprocess.run(["node", "-e", wrapper, init["args"][0]], check=True, capture_output=True, text=True)

    def test_chart_uses_the_generated_litellm_catalog(self):
        template = OPENCLAW_TEMPLATE.read_text(encoding="utf-8")

        self.assertIn(
            'configMapRef:\n      name: {{ printf "%s-model-catalog" $instance.name }}\n      key: openclaw.json',
            template,
        )
        self.assertIn(
            "forcePaths:\n      - models.providers\n      - agents.defaults.compaction\n      - agents.defaults.model\n      - tools.profile",
            template,
        )
        self.assertIn("- name: LITELLM_API_KEY", template)
        self.assertIn('name: {{ $key.name | quote }}', template)
        self.assertIn('key: {{ $key.key | quote }}', template)
        self.assertIn('ai-appliance.io/preferred-model: {{ $model | quote }}', template)

    def test_chart_does_not_rely_on_unsupported_openai_environment_overrides(self):
        template = OPENCLAW_TEMPLATE.read_text(encoding="utf-8")

        self.assertNotIn("OPENAI_BASE_URL", template)
        self.assertNotIn("OPENCLAW_DEFAULT_MODEL", template)
        self.assertNotIn("- name: OPENAI_API_KEY", template)

    def test_bootstrap_credential_reference_is_escaped_for_flux_post_build(self):
        bootstrap = MODEL_CATALOG_BOOTSTRAP.read_text(encoding="utf-8")

        self.assertIn('"apiKey": "$${LITELLM_API_KEY}"', bootstrap)
        self.assertNotIn('"apiKey": "${LITELLM_API_KEY}"', bootstrap)

    def test_bootstrap_uses_safe_openclaw_runtime_defaults(self):
        bootstrap = MODEL_CATALOG_BOOTSTRAP.read_text(encoding="utf-8")

        self.assertIn('"keepRecentTokens": 20000', bootstrap)
        self.assertNotIn('"reserveTokensFloor"', bootstrap)
        self.assertNotIn('"reserveTokens"', bootstrap)
        self.assertIn('"profile": "coding"', bootstrap)


if __name__ == "__main__":
    unittest.main()
