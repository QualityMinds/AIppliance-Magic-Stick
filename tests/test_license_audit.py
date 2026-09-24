# SPDX-License-Identifier: BUSL-1.1
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from license_audit import (REQUIRED_GATES, REQUIRED_NOTICES, main, notice_checks,
                          publication_checks, source_checks, deployment_references,
                          refresh_references, references_checksum, checksum)


class LicenseAuditTests(unittest.TestCase):
    def test_runtime_lock_is_included_in_deployment_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'magic-cluster/apps/instances/odysseus/files/runtime-images.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'images': {'app': {'repository': 'example/app', 'digest': 'sha256:' + 'a' * 64}}}))
            with patch('license_audit.files', return_value=[path]):
                refs = deployment_references(root)
            self.assertEqual(len(refs), 1)
            self.assertEqual(refs[0]['reference'], 'image: example/app@sha256:' + 'a' * 64)

    def test_refresh_preserves_package_metadata_and_rejects_lock_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = root / 'dashboard/pnpm-lock.yaml'
            lock.parent.mkdir()
            lock.write_text('fixture')
            inventory = root / 'licenses/dependency-inventory.json'
            inventory.parent.mkdir()
            inventory.write_text(json.dumps({'pnpmLockSha256': checksum(lock), 'npm': ['fixture'],
                                             'python': ['existing-environment'], 'status': 'not-approval'}))
            refs = [{'file': 'example', 'line': 1, 'reference': 'image: fixture@sha256:abc'}]
            with patch('license_audit.deployment_references', return_value=refs):
                refresh_references(root)
                saved = json.loads(inventory.read_text())
                self.assertEqual(saved['npm'], ['fixture'])
                self.assertEqual(saved['python'], ['existing-environment'])
                self.assertEqual(saved['status'], 'not-approval')
                self.assertEqual(saved['deploymentReferencesSha256'], references_checksum(refs))
                before = inventory.read_bytes()
                refresh_references(root)
                self.assertEqual(inventory.read_bytes(), before)
                lock.write_text('changed')
                with self.assertRaises(ValueError):
                    refresh_references(root)
                self.assertEqual(inventory.read_bytes(), before)

    def test_current_source_consistency(self):
        self.assertEqual(source_checks(), [])

    def test_publication_workflows_check_source_and_report_reviews_without_global_veto(self):
        import yaml
        root = Path(__file__).resolve().parents[1]
        for name in ['build-dashboard-image', 'build-freetoken-image', 'build-mesh-image',
                     'build-mesh-companion', 'build-kdns-image', 'build-amd-dra-image',
                     'build-paperclip-operator-image', 'build-omni-rocm-image']:
            with self.subTest(workflow=name):
                workflow = (root / '.github/workflows' / (name + '.yml')).read_text()
                self.assertIn('tools/license_audit.py --review', workflow)
                self.assertNotIn('tools/license_audit.py --release', workflow)
                publication = min((workflow.index(marker) for marker in
                    ['uses: docker/login-action', 'uses: actions/upload-artifact'] if marker in workflow))
                self.assertLess(workflow.index('tools/license_audit.py --review'), publication)
                self.assertIn('tee -a "$GITHUB_STEP_SUMMARY"', workflow)
                definition = yaml.load(workflow, Loader=yaml.BaseLoader)
                for job in definition["jobs"].values():
                    for step in job.get("steps", []):
                        if "tools/license_audit.py --review" in step.get("run", ""):
                            # Explicit Bash enables pipefail in Actions; tee must not hide real errors.
                            self.assertEqual(step.get("shell"), "bash")
                            self.assertNotIn("continue-on-error", step)

    def test_missing_or_empty_required_notices_remain_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(len(notice_checks(root)), len(REQUIRED_NOTICES))
            for name in REQUIRED_NOTICES:
                (root / name).write_text("Fixture notice")
            self.assertEqual(notice_checks(root), [])
            (root / "LICENSE").write_text(" \n")
            self.assertEqual(len(notice_checks(root)), 1)

    def run_cli(self, args, errors=(), reviews=()):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("license_audit.source_checks", return_value=list(errors)), \
             patch("license_audit.publication_checks", return_value=list(reviews)), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(args)
        return code, stdout.getvalue() + stderr.getvalue()

    def test_advisory_review_reports_every_item_without_blocking(self):
        pending = ["unreleased publication date", "Unresolved review: kdns", "Unresolved review: marketing-assets"]
        code, output = self.run_cli(["--review"], reviews=pending)
        self.assertEqual(code, 0)
        self.assertIn("3 open item(s), advisory only", output)
        self.assertIn("not publication approval", output)
        for item in pending:
            self.assertIn(item, output)

    def test_advisory_mode_does_not_suppress_real_source_errors(self):
        code, output = self.run_cli(["--review"], errors=["LICENSE: missing"], reviews=["pending review"])
        self.assertEqual(code, 1)
        self.assertIn("LICENSE: missing", output)
        self.assertIn("pending review", output)

    def test_explicit_strict_mode_still_blocks_unresolved_reviews(self):
        code, output = self.run_cli(["--release"], reviews=["pending review"])
        self.assertEqual(code, 1)
        self.assertIn("pending review", output)
        self.assertEqual(self.run_cli(["--release"])[0], 0)

    def test_source_only_mode_does_not_require_manual_approvals(self):
        code, output = self.run_cli(["--check"], reviews=["pending review"])
        self.assertEqual(code, 0)
        self.assertNotIn("pending review", output)

    def test_review_does_not_fabricate_or_modify_approval_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            review = self.prepare(root)
            review["gates"][0]["status"] = "pending"
            path = root / "licenses/release-review.json"
            path.write_text(json.dumps(review))
            before = path.read_bytes()
            self.assertEqual(self.run_cli(["--review"], reviews=publication_checks(root))[0], 0)
            self.assertEqual(path.read_bytes(), before)

    def prepare(self, root):
        (root / "licenses").mkdir()
        (root / "approval.md").write_text("Example fixture approval evidence; not a product approval.")
        (root / "LICENSE-RELEASE.json").write_text(json.dumps({
            "schemaVersion": 1, "version": "example-v1", "firstPublicDistribution": "2020-01-01",
            "changeDate": "2023-01-01", "changeLicense": "MIT"}))
        review = {"schemaVersion": 1, "version": "example-v1", "gates": [
            {"id": gate, "status": "approved", "evidence": "approval.md",
             "approvedBy": "example-reviewer", "approvedAt": "2020-01-01"} for gate in sorted(REQUIRED_GATES)]}
        return review

    def test_publication_requires_every_approval_and_matching_version(self):
        mutations = [lambda r: r["gates"].pop(), lambda r: r.update(version="other"),
                     lambda r: r["gates"][0].update(status="blocked"),
                     lambda r: r["gates"][0].pop("approvedBy"),
                     lambda r: r["gates"][0].update(evidence="missing.md")]
        for mutate in mutations:
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                review = self.prepare(root)
                mutate(review)
                (root / "licenses/release-review.json").write_text(json.dumps(review))
                self.assertTrue(publication_checks(root))

    def test_explicit_review_record_passes_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            review = self.prepare(root)
            (root / "licenses/release-review.json").write_text(json.dumps(review))
            self.assertEqual(publication_checks(root), [])

    def test_missing_or_malformed_record_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertTrue(publication_checks(root))
            self.prepare(root)
            (root / "licenses/release-review.json").write_text('{"gates":[null]}')
            self.assertTrue(publication_checks(root))


if __name__ == "__main__":
    unittest.main()
