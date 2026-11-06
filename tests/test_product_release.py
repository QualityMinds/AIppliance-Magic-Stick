# SPDX-License-Identifier: BUSL-1.1
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse

from tools import product_release as product
from tests.test_release_catalog import COMMIT, TAG, manifest


class CiFixture:
    def __init__(self, commit=COMMIT):
        self.commit = commit
        self.runs, self.jobs = {}, {}
        self.calls = []
        for index, (workflow, names) in enumerate(product.REQUIRED_JOBS.items(), 10):
            self.runs[workflow] = [{"id": index, "run_attempt": 2, "head_sha": commit, "head_branch": "main",
                "head_repository": {"full_name": product.catalog.REPOSITORY},
                "event": "workflow_dispatch", "status": "completed", "conclusion": "success"}]
            self.jobs[index] = {"total_count": len(names), "jobs": [{"name": name, "status": "completed", "conclusion": "success"} for name in names]}
        self.runs["release-codeql-gate.yml"] = [{**self.runs["public-release-checks.yml"][0], "id": 20}]
        self.jobs[20] = {"total_count": 1, "jobs": [{"id": 12345, "name": "release-codeql", "status": "completed", "conclusion": "success"}]}
        self.gates = {"check_runs": [{"id": 12345, "name": "release-codeql", "head_sha": commit,
            "status": "completed", "conclusion": "success", "app": {"slug": "github-actions"},
            "details_url": "https://github.com/" + product.catalog.REPOSITORY + "/actions/runs/20/job/12345"}]}

    def api(self, path, **kwargs):
        self.calls.append((path, kwargs))
        self.assert_read(kwargs)
        if "/actions/workflows/" in path:
            workflow = path.split("/actions/workflows/", 1)[1].split("/", 1)[0]
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
            if query.get("head_sha") != [self.commit] or query.get("branch") != ["main"]:
                raise AssertionError("CI lookup must bind the exact main SHA")
            return {"workflow_runs": copy.deepcopy(self.runs[workflow])}
        if "/actions/runs/" in path:
            tail = path.split("/actions/runs/", 1)[1].split("/")
            if tail[1:3] != ["attempts", "2"]:
                raise AssertionError("Latest attempt must be inspected explicitly")
            return copy.deepcopy(self.jobs[int(tail[0])])
        if "/check-runs?" in path:
            return copy.deepcopy(self.gates)
        raise AssertionError("Unexpected read: " + path)

    def assert_read(self, kwargs):
        if kwargs.get("method", "GET") != "GET":
            raise AssertionError("CI qualification cannot write")


class NativeCiFixture(CiFixture):
    def __init__(self, commit=COMMIT):
        super().__init__(commit)
        self.image_runs = {}
        for index, (workflow, job_name, steps) in enumerate(product.IMAGE_BUILDS.values(), 40):
            self.image_runs[workflow] = [{"id": index, "run_attempt": 2, "head_sha": "c" * 40,
                "head_branch": "main", "head_repository": {"full_name": product.catalog.REPOSITORY},
                "event": "push", "status": "completed", "conclusion": "success"}]
            self.jobs[index] = {"total_count": 1, "jobs": [{"name": job_name, "status": "completed", "conclusion": "success",
                "steps": [{"name": name, "status": "completed", "conclusion": "success"} for name in steps]}]}

    def api(self, path, **kwargs):
        if "/actions/workflows/" in path and urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).get("head_sha") == ["c" * 40]:
            self.calls.append((path, kwargs)); self.assert_read(kwargs)
            workflow = path.split("/actions/workflows/", 1)[1].split("/", 1)[0]
            return {"workflow_runs": copy.deepcopy(self.image_runs[workflow])}
        return super().api(path, **kwargs)


class QualificationTests(unittest.TestCase):
    def test_all_current_exact_attempts_jobs_and_separate_codeql_gate_are_required(self):
        fixture = CiFixture()
        checks, gate = product.qualify_checks(COMMIT, fixture.api)
        self.assertEqual(len(checks), 5)
        self.assertEqual({c["attempt"] for c in checks}, {2})
        self.assertEqual(gate, {"commit": COMMIT, "checkId": 12345})
        self.assertEqual(len(fixture.calls), 13)

    def test_a_newer_failed_cancelled_pending_or_neutral_run_cannot_inherit_old_green(self):
        for status, conclusion in (("completed", "failure"), ("completed", "cancelled"), ("in_progress", None),
                                   ("completed", "timed_out"), ("completed", "action_required"), ("completed", "neutral")):
            fixture = CiFixture()
            old = fixture.runs["public-release-checks.yml"][0]
            fixture.runs["public-release-checks.yml"].append({**old, "id": 999, "status": status, "conclusion": conclusion})
            with self.subTest(status=status, conclusion=conclusion), self.assertRaisesRegex(product.ReleaseFailure, "latest"):
                product.qualify_checks(COMMIT, fixture.api)

    def test_foreign_branch_sha_pr_and_missing_runs_are_not_qualification(self):
        for change in ({"head_branch": "develop"}, {"head_sha": "d" * 40}, {"event": "pull_request"}, {"head_repository": {"full_name": "other/project"}}):
            fixture = CiFixture(); fixture.runs["public-release-checks.yml"][0].update(change)
            with self.subTest(change=change), self.assertRaisesRegex(product.ReleaseFailure, "Missing"):
                product.qualify_checks(COMMIT, fixture.api)

    def test_successful_workflow_does_not_hide_failed_skipped_missing_or_paginated_jobs(self):
        for change in (lambda v: v["jobs"][0].update(conclusion="failure"),
                       lambda v: v["jobs"][0].update(conclusion="skipped"),
                       lambda v: v["jobs"][0].update(status="in_progress"),
                       lambda v: v["jobs"].pop(), lambda v: v.update(total_count=101)):
            fixture = CiFixture(); change(fixture.jobs[10])
            with self.subTest(change=change), self.assertRaisesRegex(product.ReleaseFailure, "Required jobs"):
                product.qualify_checks(COMMIT, fixture.api)

    def test_codeql_analyses_alone_or_a_neutral_gate_do_not_pass(self):
        for change in (lambda v: v["check_runs"].clear(), lambda v: v["check_runs"][0].update(conclusion="neutral"),
                       lambda v: v["check_runs"][0].update(name="Analyze (python)"),
                       lambda v: v["check_runs"][0].update(app={"slug": "unrelated-app"}),
                       lambda v: v["check_runs"][0].update(head_sha="f" * 40)):
            fixture = CiFixture(); change(fixture.gates)
            with self.subTest(change=change), self.assertRaisesRegex(product.ReleaseFailure, "CodeQL"):
                product.qualify_checks(COMMIT, fixture.api)

    def test_final_ci_or_image_labels_cannot_substitute_original_native_tests(self):
        fixture = NativeCiFixture()
        product.qualify_image_builds(manifest()["images"], fixture.api)
        for change in (lambda f: f.image_runs["build-dashboard-image.yml"][0].update(conclusion="failure"),
                       lambda f: f.image_runs["regression-runner.yml"][0].update(head_branch="develop"),
                       lambda f: f.jobs[40]["jobs"][0]["steps"][0].update(conclusion="skipped"),
                       lambda f: f.jobs[41]["jobs"][0]["steps"].clear()):
            fixture = NativeCiFixture(); change(fixture)
            with self.subTest(change=change), self.assertRaises(product.ReleaseFailure):
                product.qualify_image_builds(manifest()["images"], fixture.api)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        product.git(self.root, "init", "-q", "-b", "main")
        product.git(self.root, "config", "user.name", "Synthetic fixture")
        product.git(self.root, "config", "user.email", "fixture@example.com")
        product.git(self.root, "config", "commit.gpgsign", "false")
        (self.root / "LICENSE-RELEASE.json").write_text(json.dumps(manifest()["license"]))
        product.git(self.root, "add", ".")
        product.git(self.root, "commit", "-q", "-m", "Synthetic release fixture")
        self.commit = product.git(self.root, "rev-parse", "HEAD")
        product.git(self.root, "update-ref", "refs/remotes/origin/main", self.commit)

    def test_prepare_checks_real_clean_main_ancestry_and_all_evidence_without_remote_writes(self):
        fixture = NativeCiFixture(self.commit)
        with patch.object(product.release_metadata, "check", return_value="Synthetic notes") as notes, \
                patch.object(product.license_audit, "source_checks", return_value=[]):
            value, text = product.prepare(self.root, "v1.2.3", self.commit, api=fixture.api,
                inspect_images=lambda root, commit: manifest()["images"])
        self.assertEqual(value["commit"], self.commit)
        self.assertEqual(text, "Synthetic notes")
        self.assertEqual(value["license"], manifest()["license"])
        self.assertEqual({c["commit"] for c in value["checks"]}, {self.commit})
        notes.assert_called_once_with(self.root, "v1.2.3")
        self.assertEqual(product.git(self.root, "status", "--porcelain"), "")

    def test_dirty_wrong_revision_or_unmerged_source_stops_before_ci_or_registry_reads(self):
        fixture = CiFixture(self.commit)
        with self.assertRaises(product.ReleaseFailure):
            product.prepare(self.root, "v1.2.3", "b" * 40, api=fixture.api)
        dirty = self.root / "local-change"; dirty.write_text("Synthetic local edit")
        with self.assertRaisesRegex(product.ReleaseFailure, "clean"):
            product.prepare(self.root, "v1.2.3", self.commit, api=fixture.api)
        dirty.unlink()
        product.git(self.root, "commit", "--allow-empty", "-q", "-m", "Unmerged feature fixture")
        with self.assertRaisesRegex(product.ReleaseFailure, "ancestry"):
            product.prepare(self.root, "v1.2.3", product.git(self.root, "rev-parse", "HEAD"), api=fixture.api)
        self.assertEqual(fixture.calls, [])

    def test_image_inspection_uses_resolved_git_dir_for_isolated_worktrees(self):
        images = manifest()["images"]
        for item in images:
            if item["sourceRevision"]:
                item["image"] = "registry.example.com/" + item["component"] + ":sha-" + item["sourceRevision"] + "@sha256:" + "1" * 64
        runtime = self.root / "magic-cluster/apps/regression/runtime.yaml"
        runtime.parent.mkdir(parents=True)
        runtime.write_text('data:\n  image: "' + images[-1]["image"] + '"\n  sourceRevision: "' + images[-1]["sourceRevision"] + '"\n')
        directory = Path("/synthetic/main.git/worktrees/release")
        with patch.object(product, "git", return_value=str(directory)), \
                patch.object(product.software_channel, "image_inventory", return_value=[{"name": "Operator runtime", "image": images[3]["image"]}]) as inventory, \
                patch.object(product.software_channel, "verify_image_sources") as sources, \
                patch.object(product.dashboard, "read_pins", return_value={i["component"]: i["image"] for i in images[:3]}), \
                patch.object(product.dashboard, "verify_images"), \
                patch.object(product.software_channel, "registry_image"), patch.object(product, "verify_runner"):
            result = product.image_inventory(self.root, self.commit)
        self.assertEqual(len(result), 5)
        inventory.assert_called_once_with(directory, self.commit)
        self.assertEqual(sources.call_args.args[:2], (directory, self.commit))


class PublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.assets = self.root / "assets"; self.assets.mkdir()
        self.manifest = manifest()
        self.manifest["checks"], self.manifest["codeql"] = product.qualify_checks(COMMIT, CiFixture().api)
        self.notes = "### Fixed\n\n- Synthetic fixture; not a real product release."
        (self.assets / "magicstick-release.json").write_text(json.dumps(self.manifest))
        (self.assets / "release-notes.md").write_text(self.notes)
        for name in ("LICENSE", "LICENSING.md", "THIRD_PARTY_NOTICES.md", "LICENSE-RELEASE.json"):
            raw = json.dumps(self.manifest["license"]) if name == "LICENSE-RELEASE.json" else "Synthetic fixture " + name
            (self.root / name).write_text(raw); (self.assets / name).write_text(raw)
        self.ci = NativeCiFixture()
        self.writes = []
        self.uploads = []
        self.immutable = True
        self.existing = None
        self.existing_ref = False
        self.bad_digest = False
        self.changed_tag = False
        self.extra_asset = False

    def api(self, path, *, method="GET", payload=None, **kwargs):
        if method != "GET":
            self.writes.append((method, path, payload))
        if "/actions/" in path or "/check-runs?" in path:
            return self.ci.api(path, method=method)
        if path.endswith("/immutable-releases"):
            return {"enabled": self.immutable}
        if "/git/matching-refs/tags/" in path:
            return [{"ref": "refs/tags/v1.2.3"}] if self.existing_ref else []
        if path.endswith("/releases/tags/v1.2.3"):
            return self.existing
        if path.endswith("/git/tags"):
            return {"sha": TAG}
        if path.endswith("/git/refs"):
            return {"ref": "refs/tags/v1.2.3"}
        if path.endswith("/git/ref/tags/v1.2.3"):
            return {"ref": "refs/tags/v1.2.3", "object": {"sha": "f" * 40 if self.changed_tag else TAG, "type": "tag",
                "url": "https://api.github.com/" + product.REPO + "/git/tags/" + TAG}}
        if path.endswith("/releases") and method == "POST":
            return {"id": 9, "draft": True}
        if path.endswith("/releases/9") and method == "GET":
            assets = [{"name": path.name, "size": path.stat().st_size,
                       "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()} for path in self.assets.iterdir()]
            if self.bad_digest: assets[0]["digest"] = "sha256:" + "f" * 64
            if self.extra_asset: assets.append(copy.deepcopy(assets[0]))
            return {"assets": assets}
        if path.endswith("/releases/9") and method == "PATCH":
            return {"draft": False, "immutable": True, "html_url": product.catalog.RELEASES + "tag/v1.2.3"}
        raise AssertionError("Unexpected API operation " + path)

    def run_publish(self):
        return product.publish(self.root, self.manifest, self.notes, self.assets, api=self.api,
                               command=lambda *args: self.uploads.append(args))

    def test_annotated_tag_draft_upload_hash_verification_then_immutable_publication(self):
        result = self.run_publish()
        self.assertTrue(result["immutable"])
        self.assertEqual([method for method, _, _ in self.writes], ["POST", "POST", "POST", "PATCH"])
        self.assertEqual(self.writes[0][2]["object"], COMMIT)
        self.assertTrue(self.writes[2][2]["draft"])
        self.assertEqual(self.writes[-1][2], {"draft": False, "make_latest": "true"})
        self.assertEqual(len(self.uploads), 1)
        self.assertNotIn("--clobber", self.uploads[0])
        self.assertIn(str(self.assets / "LICENSE-RELEASE.json"), self.uploads[0])

    def test_disabled_immutability_and_existing_version_never_write(self):
        self.immutable = False
        with self.assertRaisesRegex(product.ReleaseFailure, "immutable"):
            self.run_publish()
        self.assertEqual(self.writes, [])
        self.immutable = True
        for kind in ("tag", "release"):
            self.existing_ref = kind == "tag"
            self.existing = {"draft": True} if kind == "release" else None
            with self.subTest(kind=kind), self.assertRaisesRegex(product.ReleaseFailure, "already exists"):
                self.run_publish()
            self.assertEqual(self.writes, [])

    def test_changed_latest_attempt_or_codeql_gate_prevents_any_tag_creation(self):
        self.ci.runs["regression-runner.yml"][0].update(conclusion="failure")
        with self.assertRaises(product.ReleaseFailure): self.run_publish()
        self.assertEqual(self.writes, [])

    def test_newly_skipped_original_image_tests_prevent_any_tag_creation(self):
        self.ci.jobs[40]["jobs"][0]["steps"][0]["conclusion"] = "skipped"
        with self.assertRaises(product.ReleaseFailure): self.run_publish()
        self.assertEqual(self.writes, [])

    def test_changed_license_notes_or_manifest_prevents_any_remote_write(self):
        for name in ("LICENSE", "release-notes.md", "magicstick-release.json"):
            path = self.assets / name; original = path.read_bytes(); path.write_text("{}")
            with self.subTest(name=name), self.assertRaises(product.ReleaseFailure): self.run_publish()
            self.assertEqual(self.writes, []); path.write_bytes(original)

    def test_wrong_upload_hash_duplicate_asset_or_changed_tag_never_publishes(self):
        for flag in ("bad_digest", "extra_asset", "changed_tag"):
            setattr(self, flag, True)
            with self.subTest(flag=flag), self.assertRaises(product.ReleaseFailure): self.run_publish()
            self.assertFalse(any(method == "PATCH" for method, _, _ in self.writes))
            setattr(self, flag, False); self.writes.clear()

    def test_no_unreviewed_shell_command_ci_rerun_force_push_delete_or_appliance_action(self):
        self.run_publish()
        serialized = json.dumps(self.writes) + json.dumps(self.uploads)
        for prohibited in ("--force", "rerun", "DELETE", "kubeconfig", "kubectl", "reboot", "--clobber"):
            self.assertNotIn(prohibited, serialized)


if __name__ == "__main__":
    unittest.main()
