# SPDX-License-Identifier: BUSL-1.1
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse

from tools import product_release as product
from tools import release_delivery as delivery
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


class InstallerDeliveryTests(unittest.TestCase):
    """Owning SEC-03/CHANNEL release-delivery counterexamples, not live installs."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in delivery.installer.INPUTS:
            target = self.root / name; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(product.ROOT / name, target)
        product.git(self.root, "init", "-q", "-b", "main")
        product.git(self.root, "config", "user.name", "Synthetic fixture")
        product.git(self.root, "config", "user.email", "fixture@example.com")
        product.git(self.root, "config", "commit.gpgsign", "false")
        product.git(self.root, "add", ".")
        product.git(self.root, "commit", "-qm", "Synthetic installer delivery fixture")
        self.commit = product.git(self.root, "rev-parse", "HEAD")
        self.proof = {"version": "v1.2.3", "commit": self.commit, "tagObject": TAG,
                      "manifestDigest": "sha256:" + "d" * 64, "license": manifest()["license"]}
        self.value = delivery.plan(self.root, "v1.2.3", self.commit, self.resolve)
        self.info = {**self.value, "releaseStatus": "test-build", "sourceRunId": "123",
                     "acceptance": {"mediaIntegrity": True, "physicalInstallation": False}, "assets": {}}
        self.raw = {name: ("Synthetic non-bootable fixture: " + name).encode()
                    for name in delivery.installer.asset_names(self.value)
                    if not name.endswith(".build.json")}
        self.raw[self.value['imageName'] + '.sha256'] = (hashlib.sha256(self.raw[self.value['imageName']]).hexdigest()
                                                       + '  ' + self.value['imageName'] + '\n').encode()
        self.info["assets"] = {name: {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
                               for name, raw in self.raw.items()}
        self.raw[self.value["stem"] + ".build.json"] = json.dumps(self.info).encode()
        self.release = {"id": 77, "tag_name": self.value["tag"], "html_url": product.catalog.RELEASES + "tag/" + self.value["tag"],
                        "draft": False, "immutable": True, "prerelease": True,
                        "assets": [{"id": index, "name": name, "state": "uploaded", "size": len(raw),
                                    "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
                                    "browser_download_url": product.catalog.RELEASES + "download/" + self.value["tag"] + "/" + name}
                                   for index, (name, raw) in enumerate(self.raw.items(), 1)]}
        self.run = {"id": 123, "run_attempt": 1, "path": delivery.installer.WORKFLOW,
                    "head_branch": "main", "head_sha": self.commit, "event": "workflow_dispatch",
                    "head_repository": {"full_name": product.catalog.REPOSITORY},
                    "status": "completed", "conclusion": "success"}
        self.jobs = {"total_count": 2, "jobs": [{"name": name, "status": "completed", "conclusion": "success"}
                                                for name in ("build", "publish")]}
        self.product = {"id": 88, "tag_name": "v1.2.3", "draft": False, "immutable": True,
                        "html_url": product.catalog.RELEASES + "tag/v1.2.3", "body": "Curated human notes.\n",
                        "assets": [{"name": "LICENSE", "digest": "sha256:" + "a" * 64}]}
        self.runs, self.calls, self.downloads = [], [], []
        self.orphan = None

    def resolve(self, version, expected):
        self.assertEqual((version, expected), ("v1.2.3", self.commit))
        return copy.deepcopy(self.proof)

    def api(self, path, **kwargs):
        self.calls.append((path, kwargs))
        if path.endswith("/dispatches"):
            self.assertEqual(kwargs, {"method": "POST", "payload": {"ref": "v1.2.3", "inputs": {"product_version": "v1.2.3"}}})
            return None
        if "/actions/workflows/" in path:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
            self.assertEqual(query, {"head_sha": [self.commit], "branch": ["v1.2.3"],
                                     "event": ["workflow_dispatch"], "per_page": ["100"]})
            return {"total_count": len(self.runs), "workflow_runs": copy.deepcopy(self.runs)}
        if path.endswith("/jobs?filter=latest&per_page=100"):
            return copy.deepcopy(self.jobs)
        if path.endswith("/actions/runs/123"):
            return copy.deepcopy(self.run)
        if path.endswith("/git/ref/tags/" + self.value["tag"]):
            return self.orphan if self.release is None else {"object": {"type": "commit", "sha": self.commit}}
        if path.endswith("/releases/tags/" + self.value["tag"]):
            return copy.deepcopy(self.release)
        if path.endswith("/releases/tags/v1.2.3"):
            return copy.deepcopy(self.product)
        if path.endswith("/releases/88"):
            self.assertEqual(kwargs["method"], "PATCH")
            self.assertEqual(set(kwargs["payload"]), {"body"})
            self.product.update(kwargs["payload"])
            return copy.deepcopy(self.product)
        self.fail("Unexpected release-delivery operation " + path)

    def fetch(self, url):
        return self.raw[url.rsplit("/", 1)[1]]

    def download(self, url, size):
        raw = self.fetch(url); self.assertEqual(len(raw), size); self.downloads.append(url)
        return "sha256:" + hashlib.sha256(raw).hexdigest()

    def verify(self, value=None, **kwargs):
        return delivery.verify(value or self.value, api=self.api, fetch=self.fetch, download=self.download)

    def complete(self, **kwargs):
        return delivery.complete(self.root, "v1.2.3", self.commit, api=self.api, resolve=self.resolve,
                                 verify_download=self.verify, **kwargs)

    def test_public_bytes_identity_original_jobs_and_all_four_assets_are_required(self):
        receipt = self.verify()
        self.assertEqual(receipt["productRelease"], self.proof)
        self.assertEqual(len(self.downloads), 2)  # Metadata/checksum are separately fetched/hashed.
        self.assertFalse(receipt["physicalInstallation"])
        self.assertFalse(any(options.get("method") for _, options in self.calls))

    def test_dirty_or_wrong_checkout_never_resolves_or_dispatches(self):
        with self.assertRaises(delivery.DeliveryFailure):
            delivery.plan(self.root, 'stable', self.commit, self.resolve)
        with self.assertRaises(delivery.DeliveryFailure):
            delivery.plan(self.root, "v1.2.3", "f" * 40, self.resolve)
        (self.root / "local-change").write_text("Preserve unrelated work")
        with self.assertRaisesRegex(delivery.DeliveryFailure, "clean checkout"):
            self.complete()
        self.assertEqual(self.calls, [])

    def test_missing_modified_duplicate_foreign_or_nonimmutable_assets_never_pass(self):
        original = copy.deepcopy(self.release)
        for change in (lambda r: r.update(immutable=False), lambda r: r.update(draft=True),
                       lambda r: r["assets"].pop(), lambda r: r["assets"].append(r["assets"][0]),
                       lambda r: r["assets"][0].update(digest="sha256:" + "0" * 64),
                       lambda r: r["assets"][0].update(browser_download_url="https://example.com/image.img")):
            self.release = copy.deepcopy(original); change(self.release)
            with self.subTest(change=change), self.assertRaises(ValueError): self.verify()
        self.release = original
        with self.assertRaises(ValueError):
            delivery.verify(self.value, api=self.api, fetch=lambda url: b"{}", download=self.download)
        with self.assertRaises(ValueError):
            delivery.verify(self.value, api=self.api, fetch=self.fetch, download=lambda *args: "sha256:" + "0" * 64)

    def test_original_source_identity_and_latest_attempt_cannot_be_substituted(self):
        original = copy.deepcopy(self.run)
        for fields in ({"head_sha": "f" * 40}, {"head_branch": "develop"}, {"event": "pull_request"},
                       {"path": "other.yml"}, {"head_repository": {"full_name": "other/project"}},
                       {"conclusion": "failure"}, {"conclusion": "cancelled"}, {"conclusion": "timed_out"},
                       {"conclusion": "action_required"}, {"conclusion": "neutral"}):
            self.run = {**original, **fields}
            with self.subTest(fields=fields), self.assertRaises(delivery.DeliveryFailure): self.verify()
        self.run = {**original, "status": "in_progress", "conclusion": None}
        with self.assertRaises(delivery.Pending): self.verify()
        self.run = {**original, "head_branch": "v1.2.3"}
        self.verify()  # Explicit matching product-tag dispatch is accepted too.

    def test_successful_workflow_never_hides_failed_missing_skipped_or_paginated_jobs(self):
        original = copy.deepcopy(self.jobs)
        for change in (lambda j: j.update(total_count=101), lambda j: j["jobs"].pop(),
                       lambda j: j["jobs"][1].update(conclusion="skipped"),
                       lambda j: j["jobs"][0].update(status="in_progress"),
                       lambda j: j["jobs"][0].update(conclusion="failure")):
            self.jobs = copy.deepcopy(original); change(self.jobs)
            with self.subTest(change=change), self.assertRaises(delivery.DeliveryFailure): self.verify()

    def test_existing_media_are_reverified_and_linked_without_new_build_or_asset_changes(self):
        original = copy.deepcopy(self.product)
        receipt = self.complete()
        self.assertIn(receipt["image"], self.product["body"])
        self.assertTrue(self.product["body"].startswith(original["body"].rstrip()))
        self.assertEqual(self.product["assets"], original["assets"])
        self.assertEqual([options["method"] for _, options in self.calls if "method" in options], ["PATCH"])
        self.complete()  # Idempotent completion: no second dispatch or note write.
        self.assertEqual([options["method"] for _, options in self.calls if "method" in options], ["PATCH"])

    def test_newer_failed_or_active_attempt_cannot_fall_back_to_existing_green_media(self):
        for conclusion in ("failure", "cancelled", "timed_out", "action_required", "skipped", "neutral"):
            self.runs = [{**self.run, "head_branch": "v1.2.3", "conclusion": conclusion}]
            with self.subTest(conclusion=conclusion), self.assertRaisesRegex(delivery.DeliveryFailure, "latest"):
                self.complete()
        self.assertEqual(self.downloads, [])
        self.assertFalse(any(options.get("method") for _, options in self.calls))

    def test_planned_reuse_requires_verified_media_and_explicit_reuse_steps(self):
        self.runs = [{**self.run, 'id': 124, 'head_branch': 'v1.2.3'}]
        self.jobs['jobs'][1]['conclusion'] = 'skipped'
        self.jobs['jobs'][0]['steps'] = [{'name': name, 'conclusion': result} for name, result in (
            ('Reuse an identical published installer', 'success'), ('Report reused download', 'success'),
            ('Build reduced media', 'skipped'))]
        original_jobs = {'total_count': 2, 'jobs': [{'name': name, 'status': 'completed', 'conclusion': 'success'}
                                                   for name in ('build', 'publish')]}
        def api(path, **kwargs):
            if '/actions/runs/123/jobs?' in path: return copy.deepcopy(original_jobs)
            return self.api(path, **kwargs)
        receipt = delivery.complete(self.root, 'v1.2.3', self.commit, api=api, resolve=self.resolve,
            verify_download=lambda value, **kwargs: delivery.verify(value, api=api, fetch=self.fetch, download=self.download))
        self.assertEqual(receipt['sourceRunId'], '123')
        self.jobs['jobs'][0]['steps'].pop()
        with self.assertRaisesRegex(delivery.DeliveryFailure, 'skipped without'):
            delivery.complete(self.root, 'v1.2.3', self.commit, api=api, resolve=self.resolve,
                verify_download=lambda value, **kwargs: delivery.verify(value, api=api, fetch=self.fetch, download=self.download))

    def test_legacy_missing_media_requires_manual_review_not_an_unsupported_tag_dispatch(self):
        self.release = None
        workflow = self.root / delivery.installer.WORKFLOW
        workflow.write_text(workflow.read_text().replace(delivery.CONTRACT, '  LEGACY_WORKFLOW: true'))
        product.git(self.root, 'add', '.')
        product.git(self.root, 'commit', '-qm', 'Synthetic legacy workflow')
        self.commit = product.git(self.root, 'rev-parse', 'HEAD')
        self.proof['commit'] = self.commit
        self.value = delivery.plan(self.root, 'v1.2.3', self.commit, self.resolve)
        with self.assertRaisesRegex(delivery.DeliveryFailure, 'older version'):
            self.complete()
        self.assertFalse(any(options.get('method') for _, options in self.calls))

    def test_exact_tag_dispatch_is_once_and_completion_waits_for_public_verified_bytes(self):
        receipt = self.verify()
        self.release = None
        clock = [0]
        def sleep(seconds):
            clock[0] += seconds
            self.runs = [{**self.run, "head_branch": "v1.2.3", "status": "in_progress", "conclusion": None}]
            if clock[0] >= 30:
                self.runs[0].update(status="completed", conclusion="success")
        with patch.object(delivery, "link_download") as announce:
            result = delivery.complete(self.root, "v1.2.3", self.commit, api=self.api, resolve=self.resolve,
                verify_download=unittest.mock.Mock(side_effect=[None, receipt]), announce=announce,
                sleep=sleep, now=lambda: clock[0], timeout=60)
        self.assertEqual(result, receipt)
        self.assertEqual(clock[0], 30)
        self.assertEqual(sum(path.endswith("/dispatches") for path, _ in self.calls), 1)
        announce.assert_called_once_with("v1.2.3", receipt, api=self.api)

    def test_observation_timeout_is_not_termination_or_permission_to_restart(self):
        self.release = None
        clock = [0]
        def sleep(seconds): clock[0] += seconds
        with self.assertRaisesRegex(delivery.DeliveryFailure, "observation timed out, not the build"):
            self.complete(sleep=sleep, now=lambda: clock[0], timeout=30)
        writes = [(path, options) for path, options in self.calls if options.get("method")]
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0][0].endswith("/dispatches"))

    def test_orphan_tag_failed_lookup_and_success_without_assets_never_dispatch_replacements(self):
        self.release, self.orphan = None, {"object": {"sha": self.commit, "type": "commit"}}
        with self.assertRaisesRegex(delivery.DeliveryFailure, "tag exists"): self.complete()
        self.orphan = None
        self.runs = [{**self.run, "head_branch": "v1.2.3"}]
        with self.assertRaisesRegex(delivery.DeliveryFailure, "no verified public media"): self.complete()
        self.assertFalse(any(options.get("method") for _, options in self.calls))
        with patch.object(delivery, "plan", return_value=self.value), self.assertRaises(OSError):
            delivery.complete(self.root, "v1.2.3", self.commit, api=unittest.mock.Mock(side_effect=OSError("offline")))

    def test_incomplete_or_foreign_run_lookup_never_becomes_a_cache_miss(self):
        for payload in ({"total_count": 101, "workflow_runs": []},
                        {"total_count": 1, "workflow_runs": [{**self.run, "head_branch": "develop"}]}):
            with patch.object(delivery, "plan", return_value=self.value), self.assertRaises(delivery.DeliveryFailure):
                delivery.complete(self.root, "v1.2.3", self.commit, api=unittest.mock.Mock(return_value=payload))

    def test_concurrent_notes_or_existing_different_links_are_preserved(self):
        receipt = self.verify()
        old = copy.deepcopy(self.product)
        with patch.object(delivery.product, "github") as api:
            api.side_effect = [old, {**old, "body": "A newer human edit"}]
            with self.assertRaisesRegex(delivery.DeliveryFailure, "concurrently"):
                delivery.link_download("v1.2.3", receipt, api=api)
            self.assertEqual(api.call_count, 2)
        self.product["body"] += "<!-- magicstick-verified-installer -->\nOther reviewed links"
        with self.assertRaisesRegex(delivery.DeliveryFailure, "not overwritten"):
            delivery.link_download("v1.2.3", receipt, api=self.api)

    def test_public_stream_bounds_redirect_destinations_and_transport_errors(self):
        url = product.catalog.RELEASES + "download/installer-fixture/image.img"
        for raw, size, error in ((b"image", 5, None), (b"short", 6, "incomplete"), (b"too long", 3, "exceeds")):
            opener = unittest.mock.Mock(); opener.open.return_value = io.BytesIO(raw)
            with patch.object(delivery.urllib.request, "build_opener", return_value=opener):
                if error:
                    with self.assertRaisesRegex(delivery.DeliveryFailure, error): delivery.public_digest(url, size)
                else:
                    self.assertEqual(delivery.public_digest(url, size), "sha256:" + hashlib.sha256(raw).hexdigest())
        for target in ("http://example.com/asset", "https://example.com/asset", "https://user:password@release-assets.githubusercontent.com/file"):
            opener = unittest.mock.Mock()
            opener.open.side_effect = urllib.error.HTTPError(url, 302, "redirect", {"Location": target}, None)
            with patch.object(delivery.urllib.request, "build_opener", return_value=opener), self.assertRaises(delivery.DeliveryFailure):
                delivery.public_digest(url, 5)
        opener = unittest.mock.Mock()
        opener.open.side_effect = [urllib.error.HTTPError(url, 302, "redirect",
            {"Location": "https://release-assets.githubusercontent.com/file?synthetic-signed-query"}, None), io.BytesIO(b"image")]
        with patch.object(delivery.urllib.request, "build_opener", return_value=opener):
            delivery.public_digest(url, 5)
        self.assertNotIn("Authorization", opener.open.call_args.args[0].headers)
        for invalid in ("https://github.com/other/project/releases/download/a/file", url + "?token=synthetic", "http://github.com/asset"):
            with self.assertRaises(delivery.DeliveryFailure): delivery.public_digest(invalid, 5)
        opener = unittest.mock.Mock(); opener.open.side_effect = OSError("private transport detail")
        with patch.object(delivery.urllib.request, "build_opener", return_value=opener), self.assertRaisesRegex(delivery.DeliveryFailure, "could not be verified"):
            delivery.public_digest(url, 5)


class ReleaseDeliveryOrchestrationTests(unittest.TestCase):
    def test_publish_cli_completes_only_after_verified_delivery_and_never_republishes_on_failure(self):
        with patch.object(product, "publish", return_value={"html_url": "https://example.com/release"}) as publish, \
                patch.object(delivery, "complete", return_value={"url": "https://example.com/installer"}) as complete, \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            product.finish(Path("/synthetic"), manifest(), "notes", Path("/synthetic/assets"))
            complete.assert_called_once_with(Path("/synthetic"), "v1.2.3", COMMIT)
            self.assertIn("Release delivery complete", output.getvalue())
            complete.reset_mock()
            product.finish(Path("/synthetic"), manifest(), "notes", Path("/synthetic/assets"), product_only=True)
            complete.assert_not_called()
            complete.side_effect = delivery.DeliveryFailure("Synthetic installer failure")
            with self.assertRaisesRegex(product.ReleaseFailure, "publication remains intact"):
                product.finish(Path("/synthetic"), manifest(), "notes", Path("/synthetic/assets"))
            self.assertEqual(publish.call_count, 3)  # One per request; no retry after delivery failure.

    def test_product_workflow_always_dispatches_and_verifies_with_scoped_builtin_access(self):
        import yaml
        workflow = yaml.load((product.ROOT / ".github/workflows/product-release.yml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(workflow["permissions"]["actions"], "read")
        job = workflow["jobs"]["publish"]
        self.assertEqual(job["permissions"]["actions"], "write")
        self.assertGreaterEqual(int(job["timeout-minutes"]), 100)
        first, completion = job["steps"][-2:]
        self.assertIn("--product-only", first["run"])
        self.assertEqual(completion["env"]["GH_TOKEN"], "${{ github.token }}")
        self.assertNotIn("if", completion)
        self.assertIn("tools/release_delivery.py complete", completion["run"])
        self.assertIn("--revision", completion["run"])
        self.assertIn("tests.test_product_release", workflow["jobs"]["qualify"]["steps"][3]["run"])


if __name__ == "__main__":
    unittest.main()
