# SPDX-License-Identifier: BUSL-1.1
"""Offline acceptance for coordinated CI image promotion; no GitHub writes."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import promote_dashboard_images as promotion

SOURCE = "a" * 40
OLD_SOURCE = "b" * 40
DIGESTS = {component: "sha256:" + char * 64 for component, char in zip(promotion.FILES, "cde")}


def run_record(**overrides):
    value = {"id": 1, "run_attempt": 1, "head_sha": SOURCE, "head_branch": "develop",
             "head_repository": {"full_name": promotion.REPOSITORY}, "event": "push",
             "status": "completed", "conclusion": "success"}
    value.update(overrides)
    return value


class RegistryFixture:
    """Hash-addressed, layer-free OCI metadata for all three components."""
    def __init__(self, mutate=None, architectures=("amd64", "arm64")):
        self.values = {}
        self.digests = {}
        self.requests = []
        for component in promotion.FILES:
            manifests = []
            for architecture in architectures:
                config = {"os": "linux", "architecture": architecture, "config": {"Labels": {
                    "org.opencontainers.image.revision": SOURCE,
                    "org.opencontainers.image.source": "https://github.com/" + promotion.REPOSITORY,
                    "org.opencontainers.image.title": promotion.TITLES[component]}}}
                if mutate:
                    mutate("config", config, component, architecture)
                digest = self.save("blobs", config)
                manifest = {"schemaVersion": 2, "config": {"digest": digest}, "layers": []}
                if mutate:
                    mutate("manifest", manifest, component, architecture)
                manifests.append({"digest": self.save("manifests", manifest),
                                  "platform": {"os": "linux", "architecture": architecture}})
            manifests.append({"digest": "sha256:" + "f" * 64,
                              "platform": {"os": "unknown", "architecture": "unknown"}})
            index = {"schemaVersion": 2, "manifests": manifests}
            if mutate:
                mutate("index", index, component, None)
            self.digests[component] = self.save("manifests", index)

    def save(self, kind, value):
        raw = json.dumps(value, sort_keys=True).encode()
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        self.values[promotion.REGISTRY + "/" + kind + "/" + digest] = raw
        return digest

    def fetch(self, url, headers=None):
        self.requests.append(url)
        if url.startswith("https://ghcr.io/token?"):
            return b'{"token":"synthetic-public-pull"}'
        if not headers or headers.get("Authorization") != "Bearer synthetic-public-pull":
            raise AssertionError("Registry metadata requires the scoped pull authorization")
        return self.values[url]


class PromotionValidationTests(unittest.TestCase):
    def test_only_full_commit_and_own_main_or_develop_channel(self):
        for branch in ("main", "develop"):
            promotion.validate(branch, SOURCE, DIGESTS)
        for branch, source in (("feature/work", SOURCE), ("v0.1.2", SOURCE),
                               ("main", "a" * 12), ("develop", SOURCE.upper()), ([], SOURCE)):
            with self.subTest(branch=branch, source=source), self.assertRaises(promotion.PromotionError):
                promotion.validate(branch, source, DIGESTS)

    def test_all_three_index_digests_are_required(self):
        for invalid in ({"web": DIGESTS["web"]}, {**DIGESTS, "api": "latest"},
                        {**DIGESTS, "cli": None}, {**DIGESTS, "extra": DIGESTS["web"]}, []):
            with self.subTest(digests=invalid), self.assertRaises(promotion.PromotionError):
                promotion.validate("develop", SOURCE, invalid)

    def test_invalid_arguments_never_read_remote_or_edit(self):
        with patch.object(promotion, "wait_for_checks") as checks, patch.object(promotion, "publish") as publish:
            with contextlib.redirect_stderr(io.StringIO()):
                result = promotion.main(["--branch", "feature/work", "--source", SOURCE,
                                         "--web-digest", DIGESTS["web"], "--api-digest", DIGESTS["api"],
                                         "--cli-digest", DIGESTS["cli"], "--push"])
            self.assertEqual(result, 1)
            checks.assert_not_called()
            publish.assert_not_called()


class RequiredCiTests(unittest.TestCase):
    def state(self, *runs):
        return promotion.check_state({"workflow_runs": list(runs)}, "develop", SOURCE)

    def test_exact_source_branch_event_and_repository_are_required(self):
        self.assertEqual(self.state(run_record()), "success")
        for overrides in ({"head_sha": OLD_SOURCE}, {"head_branch": "main"},
                          {"event": "workflow_dispatch"}, {"event": "pull_request"},
                          {"head_repository": {"full_name": "example/fork"}}):
            with self.subTest(overrides=overrides):
                self.assertEqual(self.state(run_record(**overrides)), "pending")

    def test_missing_checks_and_queued_checks_are_pending(self):
        self.assertEqual(self.state(), "pending")
        self.assertEqual(self.state(run_record(status="in_progress", conclusion=None)), "pending")

    def test_latest_attempt_cannot_fall_back_to_an_older_success(self):
        for conclusion in ("failure", "cancelled", "skipped", "timed_out", None):
            with self.subTest(conclusion=conclusion), self.assertRaises(promotion.PromotionError):
                self.state(run_record(), run_record(run_attempt=2, conclusion=conclusion))
        with self.assertRaises(promotion.PromotionError):
            self.state(run_record(), run_record(id=2, conclusion="failure"))
        self.assertEqual(self.state(run_record(), run_record(id=2, status="queued")), "pending")

    def test_malformed_run_metadata_fails_closed(self):
        for payload in ({}, [], {"workflow_runs": {}}, {"workflow_runs": [None]},
                        {"workflow_runs": [run_record(head_repository=None)]},
                        {"workflow_runs": [run_record(id="invalid")]},
                        {"workflow_runs": [run_record(run_attempt=0)]}):
            with self.subTest(payload=payload), self.assertRaises(promotion.PromotionError):
                promotion.check_state(payload, "develop", SOURCE)

    def test_wait_checks_query_exact_revision_and_branch(self):
        requests = []
        counts = {}
        now = [0]

        def fetch(path):
            requests.append(path)
            counts[path] = counts.get(path, 0) + 1
            return {"workflow_runs": [run_record(status="queued" if counts[path] == 1 else "completed")]}

        def sleep(seconds):
            now[0] += seconds

        promotion.wait_for_checks("develop", SOURCE, fetch=fetch, clock=lambda: now[0], sleep=sleep)
        self.assertEqual(now[0], 15)
        self.assertEqual(len(requests), 4)
        for workflow in promotion.CHECKS:
            self.assertTrue(any("/" + workflow + "/runs?" in path for path in requests))
        self.assertTrue(all("head_sha=" + SOURCE in path and "branch=develop" in path and
                            "event=push" in path for path in requests))

    def test_missing_ci_has_a_bounded_deadline(self):
        now = [0]

        def sleep(seconds):
            now[0] += seconds

        with self.assertRaises(promotion.PromotionError):
            promotion.wait_for_checks("develop", SOURCE, fetch=lambda _: {"workflow_runs": []},
                                      clock=lambda: now[0], sleep=sleep, timeout=31)
        self.assertEqual(now[0], 31)

    def test_ci_api_failure_does_not_publish(self):
        with patch.object(promotion, "wait_for_checks", side_effect=promotion.PromotionError("CI unavailable")), \
                patch.object(promotion, "publish") as publish, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(promotion.main(cli_arguments()), 1)
            publish.assert_not_called()


def cli_arguments(mode="--check-only"):
    return ["--branch", "develop", "--source", SOURCE, "--web-digest", DIGESTS["web"],
            "--api-digest", DIGESTS["api"], "--cli-digest", DIGESTS["cli"], mode]


class RegistryProvenanceTests(unittest.TestCase):
    def test_checks_each_component_on_both_architectures_without_downloading_layers(self):
        registry = RegistryFixture()
        promotion.verify_images(SOURCE, registry.digests, fetch=registry.fetch)
        self.assertEqual(len(registry.requests), 16)
        self.assertTrue(all("/token?" in url or "/manifests/" in url or "/blobs/" in url
                            for url in registry.requests))

    def test_missing_or_duplicated_required_architecture_is_rejected(self):
        for architectures in (("amd64",), ("arm64",), ("amd64", "amd64", "arm64")):
            with self.subTest(architectures=architectures), self.assertRaises(promotion.PromotionError):
                registry = RegistryFixture(architectures=architectures)
                promotion.verify_images(SOURCE, registry.digests, fetch=registry.fetch)

    def test_wrong_runtime_source_architecture_or_component_is_rejected(self):
        for key, value in (("org.opencontainers.image.revision", OLD_SOURCE),
                           ("org.opencontainers.image.source", "https://github.com/example/fork"),
                           ("org.opencontainers.image.title", promotion.TITLES["api"])):
            def mutate(kind, data, component, architecture):
                if kind == "config" and component == "web" and architecture == "arm64":
                    data["config"]["Labels"][key] = value

            with self.subTest(key=key), self.assertRaises(promotion.PromotionError):
                registry = RegistryFixture(mutate)
                promotion.verify_images(SOURCE, registry.digests, fetch=registry.fetch)

    def test_swapping_component_digests_is_rejected(self):
        registry = RegistryFixture()
        digests = {**registry.digests, "web": registry.digests["api"]}
        with self.assertRaises(promotion.PromotionError):
            promotion.verify_images(SOURCE, digests, fetch=registry.fetch)

    def test_index_manifest_and_config_integrity_are_independently_checked(self):
        for part in ("index", "manifest", "config"):
            registry = RegistryFixture()
            index_url = promotion.REGISTRY + "/manifests/" + registry.digests["web"]
            index = json.loads(registry.values[index_url])
            manifest_url = promotion.REGISTRY + "/manifests/" + index["manifests"][0]["digest"]
            manifest = json.loads(registry.values[manifest_url])
            config_url = promotion.REGISTRY + "/blobs/" + manifest["config"]["digest"]
            registry.values[{"index": index_url, "manifest": manifest_url, "config": config_url}[part]] += b" "
            with self.subTest(part=part), self.assertRaises(promotion.PromotionError):
                promotion.verify_images(SOURCE, registry.digests, fetch=registry.fetch)

    def test_malformed_verified_registry_objects_fail_closed(self):
        for part in ("index", "manifest", "config"):
            def mutate(kind, data, component, architecture):
                if kind == part:
                    if part == "index":
                        data["manifests"] = [None]
                    elif part == "manifest":
                        data["config"] = None
                    else:
                        data["config"]["Labels"] = None

            with self.subTest(part=part), self.assertRaises(promotion.PromotionError):
                registry = RegistryFixture(mutate)
                promotion.verify_images(SOURCE, registry.digests, fetch=registry.fetch)
        for raw in (b"invalid", b"[]", b"null"):
            digest = "sha256:" + hashlib.sha256(raw).hexdigest()
            with self.subTest(raw=raw), self.assertRaises(promotion.PromotionError):
                promotion.verified_json(raw, digest)

    def test_invalid_public_pull_authorization_is_rejected(self):
        for raw in (b"invalid", b"[]", b"null", b'{}', b'{"token":"bad\\nheader"}'):
            with self.subTest(raw=raw), self.assertRaises(promotion.PromotionError):
                promotion.verify_images(SOURCE, DIGESTS, fetch=lambda *_: raw)

    def test_network_access_uses_only_verified_https_registry_without_arbitrary_redirects(self):
        for url in ("http://ghcr.io/token", "https://example.com/token", "https://ghcr.io:444/token",
                    "https://user:secret@ghcr.io/token", "https://ghcr.io/token#fragment"):
            with self.subTest(url=url), patch("urllib.request.build_opener") as opener, \
                    self.assertRaises(promotion.PromotionError):
                promotion.registry_fetch(url)
            opener.assert_not_called()
        self.assertIsNone(promotion.NoRedirect().redirect_request(None, None, None, None, None, None))
        response = unittest.mock.MagicMock()
        response.read.return_value = b"x" * (promotion.LIMIT + 1)
        with patch("urllib.request.build_opener") as opener, self.assertRaises(promotion.PromotionError):
            opener.return_value.open.return_value = response
            promotion.registry_fetch("https://ghcr.io/token")
        request = opener.return_value.open.call_args[0][0]
        self.assertEqual(request.full_url, "https://ghcr.io/token")
        self.assertNotIn("context", opener.return_value.open.call_args[1])

    def test_ghcr_blob_cdn_redirect_drops_registry_authorization(self):
        source = promotion.REGISTRY + "/blobs/" + DIGESTS["web"]
        location = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/fixture?signature=synthetic"
        redirect = urllib.error.HTTPError(source, 307, "Temporary redirect", {"Location": location}, None)
        response = unittest.mock.MagicMock()
        response.read.return_value = b"configuration-fixture"
        with patch("urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = [redirect, response]
            self.assertEqual(promotion.registry_fetch(source, {"Authorization": "Bearer synthetic"}),
                             b"configuration-fixture")
        requests = [call.args[0] for call in opener.return_value.open.call_args_list]
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer synthetic")
        self.assertEqual(requests[1].full_url, location)
        self.assertEqual(requests[1].header_items(), [])

    def test_unapproved_or_second_redirect_never_receives_registry_authorization(self):
        blob = promotion.REGISTRY + "/blobs/" + DIGESTS["web"]
        for source, location in ((blob, "https://example.com/blob"),
                                 (blob, "http://pkg-containers.githubusercontent.com/blob"),
                                 (blob, "https://user:secret@pkg-containers.githubusercontent.com/blob"),
                                 (promotion.REGISTRY + "/manifests/" + DIGESTS["web"],
                                  "https://pkg-containers.githubusercontent.com/blob")):
            redirect = urllib.error.HTTPError(source, 307, "Redirect", {"Location": location}, None)
            with self.subTest(source=source, location=location), patch("urllib.request.build_opener") as opener, \
                    self.assertRaises(promotion.PromotionError):
                opener.return_value.open.side_effect = redirect
                promotion.registry_fetch(source, {"Authorization": "Bearer synthetic"})
            self.assertEqual(opener.return_value.open.call_count, 1)
        location = "https://pkg-containers.githubusercontent.com/blob"
        first = urllib.error.HTTPError(blob, 307, "Redirect", {"Location": location}, None)
        second = urllib.error.HTTPError(location, 307, "Redirect", {"Location": "https://example.com"}, None)
        with patch("urllib.request.build_opener") as opener, self.assertRaises(promotion.PromotionError):
            opener.return_value.open.side_effect = [first, second]
            promotion.registry_fetch(blob, {"Authorization": "Bearer synthetic"})
        self.assertEqual(opener.return_value.open.call_count, 2)
        self.assertEqual(opener.return_value.open.call_args_list[1].args[0].header_items(), [])


class LocalGitPromotionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.root = self.directory / "checkout"
        self.root.mkdir()
        self.remote = self.directory / "origin.git"
        self.raw_git(self.directory, "init", "--bare", "-q", str(self.remote))
        self.raw_git(self.root, "init", "-q", "-b", "develop")
        self.raw_git(self.root, "config", "user.name", "Synthetic fixture")
        self.raw_git(self.root, "config", "user.email", "fixture@example.com")
        self.raw_git(self.root, "config", "commit.gpgsign", "false")
        self.raw_git(self.root, "config", "core.autocrlf", "false")
        self.write("dashboard/pnpm-lock.yaml", "frozen-fixture\n")
        for component, (path, key, prefix) in promotion.FILES.items():
            reference = promotion.IMAGE + ":" + prefix + OLD_SOURCE + "@" + DIGESTS[component]
            self.write(path, "# Previous reference: " + reference + "\n  " + key + ": " + reference + "\n")
        self.write(promotion.INVENTORY, json.dumps({
            "pnpmLockSha256": promotion.license_audit.checksum(self.root / "dashboard/pnpm-lock.yaml"),
            "npm": ["unchanged-package-metadata"], "python": ["unchanged-environment"],
            "status": "inventory-not-legal-clearance", "review": "not-approval"}))
        self.commit("Initial synthetic source")
        self.source = self.git("rev-parse", "HEAD")
        self.git("branch", "main")
        self.git("remote", "add", "origin", str(self.remote))
        self.git("push", "-u", "origin", "main", "develop")

    @staticmethod
    def raw_git(root, *args):
        return subprocess.run(["git", *args], cwd=root, check=True, text=True,
                              capture_output=True, timeout=20).stdout.strip()

    def git(self, *args):
        return self.raw_git(self.root, *args)

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-q", "-m", message)

    def advance(self, path, text="Later channel content\n"):
        self.write(path, text)
        self.commit("Advance own branch")
        self.git("push", "origin", "develop")
        return self.git("rev-parse", "HEAD")

    def publish(self, head=None, branch="develop"):
        # Source licensing has separate real-repository tests. Registry/CI are
        # tested independently above; this fixture exercises real scoped Git.
        with patch.object(promotion.license_audit, "source_checks", return_value=[]):
            return promotion.publish(self.root, branch, self.source, DIGESTS, head or self.source)

    def test_coordinated_promotion_changes_only_four_owned_files_and_own_branch(self):
        old_main = self.raw_git(self.remote, "rev-parse", "refs/heads/main")
        commit = self.publish()
        self.assertNotEqual(commit, self.source)
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "refs/heads/develop"), commit)
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "refs/heads/main"), old_main)
        self.assertEqual(set(self.git("diff", "--name-only", self.source, commit).splitlines()), promotion.ALLOWED)
        self.assertEqual(promotion.read_pins(self.root), promotion.replacements(self.source, DIGESTS))
        inventory = json.loads((self.root / promotion.INVENTORY).read_text())
        self.assertEqual(inventory["npm"], ["unchanged-package-metadata"])
        self.assertEqual(inventory["python"], ["unchanged-environment"])
        self.assertEqual(inventory["review"], "not-approval")
        self.assertEqual(inventory["status"], "inventory-not-legal-clearance")
        self.assertEqual(inventory["deploymentReferencesSha256"], promotion.license_audit.references_checksum(
            promotion.license_audit.deployment_references(self.root)))
        for component, (path, _, prefix) in promotion.FILES.items():
            self.assertIn("# Previous reference: " + promotion.IMAGE + ":" + prefix + OLD_SOURCE,
                          (self.root / path).read_text())
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_main_promotion_does_not_advance_develop(self):
        commit = self.publish(branch="main")
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "refs/heads/main"), commit)
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "refs/heads/develop"), self.source)

    def test_same_build_is_idempotent_without_an_empty_commit(self):
        first = self.publish()
        with contextlib.redirect_stdout(io.StringIO()):
            second = self.publish(head=first)
        self.assertIsNone(second)
        self.assertEqual(self.git("rev-parse", "HEAD"), first)

    def test_dirty_checkout_is_never_staged_or_published(self):
        self.write("human-work.txt", "Preserve unrelated user work\n")
        with self.assertRaises(promotion.PromotionError):
            self.publish()
        self.assertEqual((self.root / "human-work.txt").read_text(), "Preserve unrelated user work\n")
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "refs/heads/develop"), self.source)

    def test_invalid_one_of_three_pins_prevents_all_edits(self):
        self.write(promotion.FILES["cli"][0], "dashboard_console_image: mutable:latest\n")
        before = {path: (self.root / path).read_bytes() for path, _, _ in promotion.FILES.values()}
        with self.assertRaises(promotion.PromotionError):
            promotion.rewrite_pins(self.root, self.source, DIGESTS)
        self.assertEqual(before, {path: (self.root / path).read_bytes() for path in before})

    def test_source_or_inventory_error_prevents_publication(self):
        with patch.object(promotion.license_audit, "source_checks", return_value=["invalid source"]), \
                self.assertRaises(promotion.PromotionError):
            promotion.publish(self.root, "develop", self.source, DIGESTS, self.source)
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "refs/heads/develop"), self.source)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")

    def test_frozen_lock_drift_cannot_invent_new_dependency_metadata(self):
        self.advance("dashboard/pnpm-lock.yaml", "changed-lock\n")
        head = self.git("rev-parse", "HEAD")
        inventory = (self.root / promotion.INVENTORY).read_bytes()
        with self.assertRaises(ValueError):
            self.publish(head=head)
        self.assertEqual((self.root / promotion.INVENTORY).read_bytes(), inventory)
        self.assertEqual(self.raw_git(self.remote, "rev-parse", "refs/heads/develop"), head)

    def test_source_descendant_preserves_docs_and_host_only_changes(self):
        for path in ("docs/development/note.md", "magic-host/roles/example/tasks/main.yml",
                     "magic-cluster/apps/dashboard/configmap.yaml"):
            self.advance(path)
        head = promotion.candidate_head(self.root, "develop", self.source)
        commit = self.publish(head=head)
        self.assertEqual(self.git("rev-parse", commit + "^"), head)
        self.assertEqual((self.root / "docs/development/note.md").read_text(), "Later channel content\n")
        self.assertEqual(set(self.git("diff", "--name-only", head, commit).splitlines()), promotion.ALLOWED)

    def test_new_runtime_or_automation_or_pin_changes_supersede_old_build(self):
        for path in ("dashboard/apps/web/src/runtime.ts", "core/magicstick_core/changed.py",
                     ".dockerignore", "LICENSE", "tools/promote_dashboard_images.py",
                     ".github/workflows/build-dashboard-image.yml", promotion.FILES["web"][0]):
            with self.subTest(path=path):
                self.advance(path)
                # Compare against the immediately preceding revision for each case.
                source = self.git("rev-parse", "HEAD^")
                before = self.git("status", "--porcelain")
                with self.assertRaises(promotion.Superseded):
                    promotion.candidate_head(self.root, "develop", source)
                self.assertEqual(self.git("status", "--porcelain"), before)

    def test_unrelated_source_commit_cannot_be_promoted(self):
        self.git("checkout", "--orphan", "unrelated")
        self.write("unrelated.txt", "another history\n")
        self.commit("Unrelated source")
        unrelated = self.git("rev-parse", "HEAD")
        with self.assertRaises(promotion.PromotionError):
            promotion.candidate_head(self.root, "develop", unrelated)

    def test_branch_move_during_publication_is_rejected_without_force_or_overwrite(self):
        original_git = promotion.git
        concurrent = self.directory / "concurrent"
        self.raw_git(self.directory, "clone", "-q", "-b", "develop", str(self.remote), str(concurrent))

        def git(root, *args):
            if args[0] == "push":
                self.assertNotIn("--force", args)
                (concurrent / "human-edit.txt").write_text("Concurrent branch change\n")
                self.raw_git(concurrent, "add", ".")
                self.raw_git(concurrent, "-c", "user.name=Synthetic fixture", "-c",
                             "user.email=fixture@example.com", "-c", "commit.gpgsign=false",
                             "commit", "-q", "-m", "Concurrent edit")
                self.raw_git(concurrent, "push", "origin", "develop")
            return original_git(root, *args)

        with patch.object(promotion, "git", side_effect=git), self.assertRaises(promotion.PromotionError):
            self.publish()
        self.assertEqual(self.raw_git(self.remote, "show", "develop:human-edit.txt"), "Concurrent branch change")
        self.assertNotEqual(self.raw_git(self.remote, "rev-parse", "develop"), self.git("rev-parse", "HEAD"))


class PromotionOrchestrationTests(unittest.TestCase):
    def test_check_only_verifies_but_never_writes_or_pushes(self):
        with patch.object(promotion, "wait_for_checks") as checks, \
                patch.object(promotion, "verify_images") as verify, \
                patch.object(promotion, "candidate_head", return_value=SOURCE), \
                patch.object(promotion, "publish") as publish, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(promotion.main(cli_arguments()), 0)
        checks.assert_called_once_with("develop", SOURCE)
        verify.assert_called_once_with(SOURCE, DIGESTS)
        publish.assert_not_called()

    def test_allowed_branch_advance_requires_its_own_public_source_checks(self):
        with patch.object(promotion, "wait_for_checks") as checks, \
                patch.object(promotion, "verify_images"), \
                patch.object(promotion, "candidate_head", return_value=OLD_SOURCE), \
                patch.object(promotion, "publish", return_value="c" * 40) as publish, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(promotion.main(cli_arguments("--push")), 0)
        self.assertEqual(checks.call_count, 2)
        checks.assert_any_call("develop", OLD_SOURCE, checks=(promotion.CHECKS[0],))
        publish.assert_called_once_with(promotion.ROOT, "develop", SOURCE, DIGESTS, OLD_SOURCE)

    def test_superseded_build_exits_without_editing_or_pushing(self):
        with patch.object(promotion, "wait_for_checks"), patch.object(promotion, "verify_images"), \
                patch.object(promotion, "candidate_head", side_effect=promotion.Superseded("newer runtime")), \
                patch.object(promotion, "publish") as publish, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(promotion.main(cli_arguments("--push")), 0)
        publish.assert_not_called()


class PromotionWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build_path = ROOT / ".github/workflows/build-dashboard-image.yml"
        cls.build = yaml.load(cls.build_path.read_text(), Loader=yaml.BaseLoader)
        cls.browser = yaml.load((ROOT / ".github/workflows/dashboard-browser-smoke.yml").read_text(),
                                Loader=yaml.BaseLoader)

    def test_automatic_promotion_is_push_only_on_main_and_develop(self):
        job = self.build["jobs"]["promote"]
        self.assertEqual(job["needs"], "build")
        self.assertEqual(job["if"], "github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop')")
        self.assertEqual(job["permissions"], {"contents": "write", "actions": "read"})
        self.assertEqual(self.build["permissions"]["contents"], "read")
        self.assertEqual(self.build["concurrency"]["cancel-in-progress"], "true")

    def test_outputs_are_the_three_actual_build_index_digests(self):
        steps = self.build["jobs"]["build"]["steps"]
        outputs = self.build["jobs"]["build"]["outputs"]
        for component in promotion.FILES:
            step = next(item for item in steps if item.get("id") == component + "-image")
            self.assertEqual(step["uses"], "docker/build-push-action@v6")
            self.assertEqual(step["with"]["platforms"], "linux/amd64,linux/arm64")
            self.assertEqual(step["with"]["push"], "true")
            self.assertEqual(outputs[component + "_digest"], "${{ steps." + component + "-image.outputs.digest }}")

    def test_no_recursive_push_token_or_force_push_or_skip_ci(self):
        job = self.build["jobs"]["promote"]
        checkout = job["steps"][0]
        self.assertEqual(checkout["with"], {"ref": "${{ github.sha }}", "fetch-depth": "0"})
        step = job["steps"][1]
        self.assertEqual(step["env"]["GH_TOKEN"], "${{ secrets.GITHUB_TOKEN }}")
        self.assertEqual(step["env"]["SOURCE_REVISION"], "${{ github.sha }}")
        self.assertEqual(step["env"]["CHANNEL"], "${{ github.ref_name }}")
        self.assertIn("--push", step["run"])
        self.assertNotIn("--force", step["run"])
        self.assertNotIn("[skip ci]", step["run"])
        self.assertNotIn("PAT", str(step["env"]))

    def test_browser_checks_cover_every_automatic_build_input(self):
        self.assertEqual(set(self.browser["on"]["push"]["paths"]), set(self.build["on"]["push"]["paths"]))
        self.assertEqual(set(self.browser["on"]["pull_request"]["paths"]), set(self.build["on"]["push"]["paths"]))
        self.assertEqual(self.browser["on"]["push"]["branches"], self.build["on"]["push"]["branches"])

    def test_promotion_unit_checks_run_before_image_publication_and_in_public_ci(self):
        steps = self.build["jobs"]["build"]["steps"]
        test = next(index for index, item in enumerate(steps) if "tests.test_dashboard_image_promotion" in item.get("run", ""))
        first_build = next(index for index, item in enumerate(steps) if item.get("uses") == "docker/build-push-action@v6")
        self.assertLess(test, first_build)
        self.assertNotIn("if", steps[test])
        self.assertIn("tests.test_dashboard_image_promotion",
                      (ROOT / ".github/workflows/public-release-checks.yml").read_text())


if __name__ == "__main__":
    unittest.main()
