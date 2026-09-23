# SPDX-License-Identifier: BUSL-1.1
import ast
import copy
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from prepare_ci_fixture import CONTROLLER, ROOT, prepare, source_metadata


class ImageCiTests(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads(yaml.safe_load((CONTROLLER / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        self.recipe = (Path(__file__).parent / "image/Dockerfile.rocm").read_text()
        # BaseLoader preserves GitHub's `on` key rather than YAML 1.1 booleans.
        self.workflow = yaml.load((ROOT / ".github/workflows/build-omni-rocm-image.yml").read_text(), Loader=yaml.BaseLoader)

    def test_fixture_comes_from_controller_for_both_device_plans(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            metadata = prepare(output)
            self.assertEqual(metadata["platform"], "linux/amd64")
            ast.parse((output / "bootstrap.py").read_text())
            self.assertTrue((output / "verify_realtime_image.py").is_file())
            self.assertEqual(json.loads((output / "source.json").read_text()), metadata)
            for count in (1, 2):
                profile = json.loads((output / f"profile-{count}.json").read_text())
                self.assertEqual(profile["base_config"], "qwen3_omni_duplex.yaml")
                self.assertEqual(len({stage["devices"] for stage in profile["stages"]}), count)
                self.assertTrue(all(stage["enforce_eager"] for stage in profile["stages"]))
                self.assertEqual(profile["stages"][0]["engine_extras"]["attention_backend"], "TRITON_ATTN")

    def test_revision_drift_and_mutable_base_fail_before_build(self):
        self.assertEqual(source_metadata(self.catalog, self.recipe)["omni_revision"],
                         self.catalog["engines"]["VLLM"]["realtimeProfiles"]["qwen3-omni-rocm"]["sourceRevision"])
        for profile in ("qwen3-omni", "qwen3-omni-rocm"):
            changed = copy.deepcopy(self.catalog)
            changed["engines"]["VLLM"]["realtimeProfiles"][profile]["sourceRevision"] = "0" * 40
            with self.assertRaises(ValueError):
                source_metadata(changed, self.recipe)
        with self.assertRaises(ValueError):
            source_metadata(self.catalog, self.recipe.replace("@sha256:", "@invalid:"))

    def test_workflow_uses_ci_token_and_main_only_publication(self):
        workflow = self.workflow
        self.assertIn("pull_request", workflow["on"])
        self.assertEqual(workflow["on"]["push"]["branches"], ["main"])
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        build = workflow["jobs"]["build"]
        self.assertIn("github.ref == 'refs/heads/main'", build["if"])
        self.assertIn("github.event_name != 'pull_request'", build["if"])
        self.assertEqual(build["permissions"]["packages"], "write")
        self.assertNotIn("contents: write", json.dumps(build))
        login = next(step for step in build["steps"] if step.get("uses", "").startswith("docker/login-action@"))
        self.assertEqual(login["with"]["password"], "${{ secrets.GITHUB_TOKEN }}")
        self.assertIn("inputs.publish", login["if"])

    def test_runtime_checks_and_advisory_license_review_precede_any_push(self):
        steps = self.workflow["jobs"]["build"]["steps"]
        gate = next(index for index, step in enumerate(steps)
                    if "python3 tools/license_audit.py --review" in step.get("run", ""))
        self.assertNotIn("--release", steps[gate]["run"])
        offline = next(index for index, step in enumerate(steps) if "--network none" in step.get("run", ""))
        build = next(index for index, step in enumerate(steps) if step.get("with", {}).get("load") == "true")
        push = next(index for index, step in enumerate(steps) if step.get("with", {}).get("push") == "true")
        login = next(index for index, step in enumerate(steps) if step.get("uses", "").startswith("docker/login-action@"))
        self.assertLess(build, offline)
        self.assertLess(offline, gate)
        self.assertLess(gate, login)
        self.assertLess(login, push)
        self.assertNotIn("continue-on-error", steps[gate])
        self.assertEqual(steps[gate]["if"], steps[push]["if"])
        self.assertEqual(steps[push]["with"]["platforms"], "linux/amd64")
        self.assertEqual(steps[push]["with"]["sbom"], "true")
        for key in ("context", "file", "platforms", "labels", "build-args"):
            self.assertEqual(steps[build]["with"][key], steps[push]["with"][key])
        text = json.dumps(steps)
        self.assertNotIn("kubectl", text)
        self.assertNotIn("git push", text)
        self.assertNotIn("--privileged", text)
        self.assertNotIn("/dev/dri", text)


if __name__ == "__main__":
    unittest.main()
