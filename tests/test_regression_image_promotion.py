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

    def test_only_two_pin_fields_change_and_duplicate_layout_is_rejected(self):
        source = 'data:\n  image: ""\n  sourceRevision: ""\n  other: keep\n'
        changed = replacement(source, "a"*40, "sha256:" + "b"*64)
        self.assertIn('  other: keep\n', changed)
        self.assertIn('  sourceRevision: "' + "a"*40 + '"', changed)
        with self.assertRaises(ValueError):
            replacement(source + '  image: duplicate\n', "a"*40, "sha256:" + "b"*64)

    def test_concurrent_pin_or_handbook_changes_do_not_override_newer_runner_source(self):
        self.assertFalse(source_advanced(["magic-cluster/apps/dashboard/api-deployment.yaml", "licenses/dependency-inventory.json", "docs/user-guide/dashboard.md"]))
        for path in ("docs/development/regression-test-catalog.md", "dashboard/apps/web/regression/reporter.ts", "magic-cluster/apps/dashboard/regression_api.py", "tools/regression_inputs.py"):
            self.assertTrue(source_advanced([path]))

    def test_publication_requires_trusted_push_and_anonymous_pull_before_promotion(self):
        root = Path(__file__).resolve().parents[1]
        job = yaml.safe_load((root / '.github/workflows/regression-runner.yml').read_text())["jobs"]["regression-image"]
        publish = next(step for step in job["steps"] if "promote_regression_image.py" in step.get("run", ""))
        self.assertIn("github.event_name == 'push'", publish["if"])
        self.assertIn("refs/heads/main", publish["if"])
        self.assertIn("refs/heads/develop", publish["if"])
        self.assertNotIn("workflow_dispatch", publish["if"])
        self.assertEqual(publish["env"]["GH_TOKEN"], "${{ secrets.GITHUB_TOKEN }}")
        command = publish["run"]
        self.assertLess(command.index("docker logout ghcr.io"), command.index('docker pull "ghcr.io/qualityminds/magicstick-regression@$digest"'))
        self.assertLess(command.index("org.opencontainers.image.revision"), command.index("python3 tools/promote_regression_image.py"))
        self.assertIn("linux/amd64", command)
        self.assertNotIn("--force", command)
        self.assertFalse(job["steps"][0]["with"]["persist-credentials"])

    def test_ci_uploads_only_sanitized_archives_and_selects_regression_browser_fixtures(self):
        root = Path(__file__).resolve().parents[1]
        job = yaml.safe_load((root / '.github/workflows/regression-runner.yml').read_text())["jobs"]["regression-image"]
        upload = next(step for step in job["steps"] if step.get("uses") == "actions/upload-artifact@v4")
        self.assertEqual(upload["with"]["path"], ".regression/private/runs/*/report-artifacts.tar.gz")
        self.assertTrue(any("bash tools/regression.sh phase8-fixtures" in step.get("run", "") for step in job["steps"]))
