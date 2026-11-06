# SPDX-License-Identifier: BUSL-1.1
"""Offline proofs: no trunk write, no promotion loop, no legal-data rewrite."""
import copy
import json
import unittest
from unittest.mock import patch
import urllib.parse

from tools import trunk_promotion as trunk
from tests import test_dashboard_image_promotion as fixtures
DIGESTS = fixtures.DIGESTS


class TrunkPromotionTests(unittest.TestCase):
    raw_git = staticmethod(fixtures.LocalGitPromotionTests.raw_git)
    git = fixtures.LocalGitPromotionTests.git
    write = fixtures.LocalGitPromotionTests.write
    commit = fixtures.LocalGitPromotionTests.commit

    def setUp(self):
        fixtures.LocalGitPromotionTests.setUp(self)
        self.git("checkout", "main")
        self.calls = []
        self.runs = {}
        self.jobs = {}
        self.refs, self.prs = [], []
        for index, workflow in enumerate(("public-release-checks.yml", "dashboard-browser-smoke.yml",
                                           "build-dashboard-image.yml", "regression-runner.yml"), 1):
            self.runs[workflow] = [{"id": index, "run_attempt": 1, "head_sha": self.source, "head_branch": "main",
                "head_repository": {"full_name": trunk.dashboard.REPOSITORY}, "event": "push",
                "status": "completed", "conclusion": "success"}]
            names = ({"Verify dashboard clients", "Test license foundation", "Build and push dashboard API runtime"}
                if workflow == "build-dashboard-image.yml" else
                {"Verify isolated contracts and native recovery tests in the built image", "Publish tested Linux AMD64 runner"})
            self.jobs[index] = {"total_count": 1, "jobs": [{"name": "build" if workflow == "build-dashboard-image.yml" else "regression-image",
                "status": "completed", "conclusion": "success", "steps": [{"name": name, "status": "completed", "conclusion": "success"} for name in names]}]}

    def api(self, path, **kwargs):
        self.calls.append((path, kwargs))
        if "/actions/workflows/" in path:
            workflow = path.split("/actions/workflows/")[1].split("/")[0]
            return {"workflow_runs": copy.deepcopy(self.runs[workflow])}
        if "/actions/runs/" in path:
            return copy.deepcopy(self.jobs[int(path.split("/actions/runs/")[1].split("/")[0])])
        if "/git/matching-refs/heads/" in path:
            return copy.deepcopy(self.refs)
        if "/pulls?" in path:
            return copy.deepcopy(self.prs)
        if path.endswith("/pulls") and kwargs.get("method") == "POST":
            return {"html_url": "https://github.com/QualityMinds/AIppliance-Magic-Stick/pull/123"}
        raise AssertionError("Unexpected request " + path)

    def pin_commit(self):
        trunk.dashboard.rewrite_pins(self.root, self.source, DIGESTS)
        pin = self.root / trunk.regression.PIN
        pin.write_text(trunk.regression.replacement(pin.read_text(), self.source, "sha256:" + "d" * 64))
        trunk.license_audit.refresh_references(self.root)
        self.commit("Synthetic pin promotion")
        return self.git("rev-parse", "HEAD")

    def test_content_proof_preserves_legal_data_and_does_not_trust_commit_message(self):
        head = self.pin_commit()
        with patch.object(trunk.license_audit, "source_checks", return_value=[]):
            self.assertTrue(trunk.pin_only(self.root, self.source, head))
        self.write("docs/not-a-pin.md", "Not a pure image promotion")
        self.commit("chore(images): falsely labelled promotion")
        with patch.object(trunk.license_audit, "source_checks", return_value=[]):
            self.assertFalse(trunk.pin_only(self.root, self.source, self.git("rev-parse", "HEAD")))

    def test_legal_metadata_or_unregenerated_references_never_count_as_pin_only(self):
        for mutation in (lambda data: data.update(review="invented approval"),
                         lambda data: data.update(deploymentReferencesSha256="0" * 64)):
            self.git("checkout", "--detach", self.source)
            self.pin_commit()
            path = self.root / trunk.dashboard.INVENTORY
            data = json.loads(path.read_text()); mutation(data); path.write_text(json.dumps(data))
            self.commit("Synthetic counterexample")
            with patch.object(trunk.license_audit, "source_checks", return_value=[]):
                self.assertFalse(trunk.pin_only(self.root, self.source, self.git("rev-parse", "HEAD")))

    def test_an_actual_pin_merge_never_becomes_a_new_build_source_or_pr(self):
        head = self.pin_commit(); self.git("push", "origin", "HEAD:main")
        with patch.object(trunk.license_audit, "source_checks", return_value=[]), \
                patch.object(trunk, "candidates") as candidates:
            self.assertIsNone(trunk.propose(self.root, head, api=self.api, read_candidates=candidates))
        candidates.assert_not_called(); self.assertEqual(self.calls, [])

    def test_current_pending_failure_or_foreign_source_cannot_inherit_old_green(self):
        old = self.runs["public-release-checks.yml"][0]
        for status, conclusion in (("in_progress", None), ("completed", "failure"), ("completed", "cancelled")):
            self.runs["public-release-checks.yml"] = [old, {**old, "id": 99, "status": status, "conclusion": conclusion}]
            with self.subTest(conclusion=conclusion), self.assertRaises(trunk.dashboard.PromotionError):
                trunk.propose(self.root, self.source, api=self.api)
            self.assertEqual(self.raw_git(self.remote, "rev-parse", "main"), self.source)
        self.runs["public-release-checks.yml"] = [{**old, "head_repository": {"full_name": "other/project"}}]
        with self.assertRaises(trunk.Pending): trunk.propose(self.root, self.source, api=self.api)
        self.assertFalse(any(kw.get("method") == "POST" for _, kw in self.calls))

    def test_native_step_missing_or_unexpected_job_skip_rejects_candidate(self):
        for mutation in (lambda job: job.update(conclusion="skipped"), lambda job: job["steps"].pop()):
            self.jobs[3] = copy.deepcopy(self.jobs[4]); self.jobs[3]["jobs"][0]["name"] = "build"
            mutation(self.jobs[3]["jobs"][0])
            with self.assertRaises(trunk.dashboard.PromotionError):
                trunk.native_build("build-dashboard-image.yml", self.source, "build", {"Verify dashboard clients"}, api=self.api)

    def test_qualified_candidate_only_pushes_a_new_scoped_pr_branch(self):
        inventory = json.loads((self.root / trunk.dashboard.INVENTORY).read_text())
        with patch.object(trunk.license_audit, "source_checks", return_value=[]), \
                patch.object(trunk, "verify_pins") as verify:
            result = trunk.propose(self.root, self.source, api=self.api,
                read_candidates=lambda *args, **kw: (DIGESTS, "sha256:" + "d" * 64))
        self.assertTrue(result.endswith("/pull/123")); verify.assert_called_once()
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "main"), self.source)
        branch = "codex/promote-images-" + self.source[:12]
        proposed = self.raw_git(self.remote, "rev-parse", branch)
        self.assertEqual(proposed, self.git("rev-parse", "HEAD"))
        self.assertEqual(set(self.git("diff", "--name-only", self.source, proposed).splitlines()), trunk.ALLOWED)
        after = json.loads((self.root / trunk.dashboard.INVENTORY).read_text())
        for key in inventory:
            if key not in {"deploymentReferences", "deploymentReferencesSha256"}:
                self.assertEqual(after[key], inventory[key])
        writes = [kw for _, kw in self.calls if kw.get("method") == "POST"]
        self.assertEqual(len(writes), 1); self.assertEqual(writes[0]["payload"]["base"], "main")

    def test_existing_branch_without_exact_same_repo_pr_is_never_overwritten(self):
        branch = "codex/promote-images-" + self.source[:12]
        self.refs = [{"ref": "refs/heads/" + branch}]
        for prs in ([], [{"base": {"ref": "main"}, "head": {"ref": branch, "repo": {"full_name": "other/project"}},
                         "html_url": "https://example.com/123"}]):
            self.prs = prs
            with self.assertRaises(trunk.dashboard.PromotionError):
                trunk.propose(self.root, self.source, api=self.api, read_candidates=lambda *a, **k: (DIGESTS, None))
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "main"), self.source)
        self.assertFalse(any(kw.get("method") == "POST" for _, kw in self.calls))

    def test_direct_main_legacy_helper_is_disabled_before_any_write(self):
        with self.assertRaisesRegex(trunk.dashboard.PromotionError, "Direct main"):
            trunk.dashboard.publish(self.root, "main", self.source, DIGESTS, self.source)
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "main"), self.source)


if __name__ == "__main__":
    unittest.main()
