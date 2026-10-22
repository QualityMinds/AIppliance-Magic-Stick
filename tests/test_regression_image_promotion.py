import unittest
from pathlib import Path
import yaml
from tools.promote_regression_image import image_reference, replacement, source_advanced


class RegressionImagePromotionTests(unittest.TestCase):
    def test_exact_source_and_digest_are_required(self):
        ref = image_reference("a"*40, "sha256:" + "b"*64)
        self.assertIn("sha-" + "a"*40 + "@sha256:" + "b"*64, ref)
        for source, digest in (("main", "sha256:" + "b"*64), ("a"*40, "latest"), ("a"*7, "sha256:" + "b"*64)):
            with self.assertRaises(ValueError):
                image_reference(source, digest)

    def test_pins_and_qualified_diagnostic_capability_are_idempotent_and_duplicate_layout_is_rejected(self):
        source = 'data:\n  image: ""\n  sourceRevision: ""\n  other: keep\n'
        changed = replacement(source, "a"*40, "sha256:" + "b"*64)
        self.assertIn('  other: keep\n', changed)
        self.assertIn('  sourceRevision: "' + "a"*40 + '"', changed)
        self.assertEqual(changed.count('  diagnosticSelectionVersion: "1"'), 1)
        self.assertEqual(replacement(changed, "a"*40, "sha256:" + "b"*64), changed)
        with self.assertRaises(ValueError):
            replacement(source + '  image: duplicate\n', "a"*40, "sha256:" + "b"*64)

    def test_concurrent_pin_or_handbook_changes_do_not_override_newer_runner_source(self):
        self.assertFalse(source_advanced(["magic-cluster/apps/dashboard/api-deployment.yaml", "licenses/dependency-inventory.json", "docs/user-guide/dashboard.md"]))
        for path in ("docs/development/regression-test-catalog.md", "dashboard/apps/web/regression/reporter.ts", "magic-cluster/apps/dashboard/regression_api.py", "tools/regression_inputs.py"):
            self.assertTrue(source_advanced([path]))

    def test_publication_requires_trusted_push_and_anonymous_pull_before_promotion(self):
        root = Path(__file__).resolve().parents[1]
        job = yaml.safe_load((root / '.github/workflows/regression-runner.yml').read_text())["jobs"]["regression-image"]
        publish = next(step for step in job["steps"] if step.get("id") == "publish")
        promote = next(step for step in job["steps"] if "promote_regression_image.py" in step.get("run", ""))
        self.assertIn("github.event_name == 'push'", promote["if"])
        self.assertIn("refs/heads/main", promote["if"])
        self.assertIn("refs/heads/develop", promote["if"])
        self.assertNotIn("workflow_dispatch", promote["if"])
        self.assertEqual(publish["env"]["GH_TOKEN"], "${{ secrets.GITHUB_TOKEN }}")
        command = publish["run"]
        self.assertLess(command.index("docker logout ghcr.io"), command.index('docker pull "ghcr.io/qualityminds/magicstick-regression@$digest"'))
        self.assertLess(command.index("org.opencontainers.image.revision"), command.index('>> "$GITHUB_OUTPUT"'))
        self.assertLess(job["steps"].index(publish), job["steps"].index(promote))
        self.assertEqual(promote["env"]["DIGEST"], "${{ steps.publish.outputs.digest }}")
        self.assertIn("linux/amd64", command)
        self.assertNotIn("--force", command + promote["run"])
        self.assertFalse(job["steps"][0]["with"]["persist-credentials"])

    def test_manual_candidate_is_explicit_branch_only_and_cannot_promote_a_channel(self):
        root = Path(__file__).resolve().parents[1]
        workflow = yaml.safe_load((root / '.github/workflows/regression-runner.yml').read_text())
        # PyYAML's YAML 1.1 parser interprets the Actions key "on" as True.
        triggers = workflow.get("on", workflow.get(True))
        candidate = triggers["workflow_dispatch"]["inputs"]["publish_candidate"]
        self.assertEqual(candidate["type"], "boolean")
        self.assertIs(candidate["default"], False)
        steps = workflow["jobs"]["regression-image"]["steps"]
        publish = next(step for step in steps if step.get("id") == "publish")
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.publish_candidate && startsWith(github.ref, 'refs/heads/')", publish["if"])
        self.assertNotIn("pull_request", publish["if"])
        self.assertNotIn("always()", publish["if"])
        self.assertNotIn("promote_regression_image.py", publish["run"])
        self.assertIn("SOURCE_REVISION", publish["env"])
        self.assertEqual(publish["env"]["SOURCE_REVISION"], "${{ github.sha }}")
        self.assertNotIn("git push", publish["run"])
        promote = next(step for step in steps if "promote_regression_image.py" in step.get("run", ""))
        self.assertNotIn("always()", promote["if"])
        self.assertNotIn("workflow_dispatch", promote["if"])

    def test_ci_uploads_only_sanitized_archives_and_selects_regression_browser_fixtures(self):
        root = Path(__file__).resolve().parents[1]
        job = yaml.safe_load((root / '.github/workflows/regression-runner.yml').read_text())["jobs"]["regression-image"]
        upload = next(step for step in job["steps"] if step.get("uses") == "actions/upload-artifact@v4")
        self.assertEqual(upload["with"]["path"], ".regression/private/runs/*/report-artifacts.tar.gz")
        self.assertTrue(any("bash tools/regression.sh phase8-fixtures" in step.get("run", "") for step in job["steps"]))
