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

    def test_workflow_uses_ci_token_and_separate_release_development_channels(self):
        workflow = self.workflow
        self.assertIn("pull_request", workflow["on"])
        self.assertEqual(workflow["on"]["push"]["branches"], ["main", "develop"])
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        build = workflow["jobs"]["build"]
        self.assertIn("github.ref == 'refs/heads/main'", build["if"])
        self.assertIn("github.ref == 'refs/heads/develop'", build["if"])
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

    def test_image_checks_real_imports_before_exporting_layers(self):
        patch = self.recipe.index("RUN python3 /tmp/magicstick-patch-rocm-import.py")
        install = self.recipe.index("--no-build-isolation")
        early_import = self.recipe.index("RUN --network=none python3 /usr/local/libexec/magicstick/verify_rocm_imports.py")
        self.assertLess(patch, install)
        self.assertLess(install, early_import)
        script = (Path(__file__).parent / "image/verify_rocm_imports.py").read_text()
        tree = ast.parse(script)
        self.assertTrue(any(isinstance(node, ast.Import) and any(alias.name == "vllm_omni" for alias in node.names)
                            for node in ast.walk(tree)))
        self.assertIn('resolve_pipeline_config("qwen3_omni_moe", Qwen3OmniMoeConfig())', script)
        self.assertNotIn("except", script)
        self.assertNotIn("mock", script)

    def test_only_tested_images_export_small_branch_scoped_registry_cache(self):
        steps = self.workflow["jobs"]["build"]["steps"]
        candidate = next(s for s in steps if s.get("with", {}).get("load") == "true")
        publication = next(s for s in steps if s.get("with", {}).get("push") == "true")
        expected_ref = "type=registry,ref=${{ env.IMAGE_NAME }}:buildcache-${{ github.ref_name }}"
        self.assertEqual(candidate["with"]["cache-from"], expected_ref)
        self.assertNotIn("cache-to", candidate["with"])
        self.assertEqual(publication["with"]["cache-to"],
                         expected_ref + ",mode=min,image-manifest=true,oci-mediatypes=true,ignore-error=true")
        self.assertIn("inputs.publish", publication["if"])
        self.assertNotIn("type=gha", json.dumps(steps))
        self.assertEqual(sum("cache-to" in s.get("with", {}) for s in steps), 1)
        self.assertNotIn("continue-on-error", publication)

    def test_inventory_does_not_export_a_second_large_image_before_publication(self):
        steps = self.workflow["jobs"]["build"]["steps"]
        inventory = next(index for index, step in enumerate(steps)
                         if "inventory_ci_image.py" in step.get("run", ""))
        offline = next(index for index, step in enumerate(steps) if "--network none" in step.get("run", ""))
        push = next(index for index, step in enumerate(steps) if step.get("with", {}).get("push") == "true")
        self.assertLess(offline, inventory)
        self.assertLess(inventory, push)
        self.assertIn('tools/license_ci.py sbom', steps[inventory]["run"])
        self.assertNotIn('syft scan "docker:', steps[inventory]["run"])
        self.assertNotIn("continue-on-error", steps[inventory])
        early = next(step for step in self.workflow["jobs"]["contracts"]["steps"]
                     if step.get("env", {}).get("MAGICSTICK_IMAGE_SCAN_SMOKE") == "1")
        self.assertIn("test_image_inventory.py", early["run"])
        self.assertNotIn("continue-on-error", early)
        self.assertEqual(self.workflow["jobs"]["build"]["needs"], "contracts")


if __name__ == "__main__":
    unittest.main()
