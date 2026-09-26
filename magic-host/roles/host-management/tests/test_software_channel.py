# SPDX-License-Identifier: BUSL-1.1
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "files"))
import software_contract as contract
import software_channel as channel
import host_plan
import host_worker
from test_host_management import node, operation, report


class ContractTests(unittest.TestCase):
    def test_custom_branches_and_literal_tags_are_supported(self):
        for kind, value in (("branch", "feature/my-change"), ("branch", "main"), ("tag", "v1.2.3"), ("commit", "a" * 40)):
            self.assertEqual(contract.selection({"kind": kind, "value": value}), {"kind": kind, "value": value})

    def test_revision_expressions_and_unknown_fields_are_rejected(self):
        for value in ("main~1", "main;reboot", "$(id)", "main\n", "../x", "-f", "refs/heads/main", "a//b", "x.lock", "a/.b", "HEAD^{commit}"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                contract.selection({"kind": "branch", "value": value})
        for value in ({"kind": "commit", "value": "abc123"}, {"kind": "semver", "value": "*"}, {"kind": "branch", "value": "main", "repository": "https://example.com"}):
            with self.assertRaises(ValueError): contract.selection(value)

    def test_apply_is_bound_to_fresh_preview_and_configuration(self):
        selected = {"kind": "branch", "value": "feature/gpu"}
        capability = {"supported": True, "id": "a" * 64, "channel": {"kind": "branch", "value": "main"}, "hostCommit": "b" * 40,
                      "preview": {"id": "c" * 64, "configurationId": "a" * 64, "ready": True, "channel": selected, "commit": "d" * 40, "checkedAtEpoch": time.time()}}
        payload = {"planId": capability["id"], "softwareChannel": selected, "softwarePreviewId": "c" * 64}
        self.assertEqual(contract.validate_request("apply-software-channel", payload, capability), selected)
        for changes in ({"planId": "d" * 64}, {"softwarePreviewId": "e" * 64}, {"softwareChannel": {"kind": "branch", "value": "other"}}, {"allowExperimental": True}):
            with self.assertRaises(ValueError): contract.validate_request("apply-software-channel", {**payload, **changes}, capability)
        capability["preview"]["checkedAtEpoch"] -= 901
        with self.assertRaises(ValueError): contract.validate_request("apply-software-channel", payload, capability)


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, value in (("STATE", self.root), ("METADATA", self.root / "metadata.env")):
            patcher = patch.object(channel, name, value); patcher.start(); self.addCleanup(patcher.stop)
        channel.METADATA.write_text("# retained\nFLUX_BOOTSTRAP_MODE=readonly-public\nMAGICSTICK_PUBLIC_REF=main\nMAGICSTICK_PUBLIC_REF_KIND=branch\nPRIVATE_VALUE='keep this'\n")

    def test_metadata_change_preserves_unrelated_values_and_is_literal(self):
        channel.save_selection({"kind": "branch", "value": "feature/test"})
        self.assertIn("PRIVATE_VALUE='keep this'", channel.METADATA.read_text())
        self.assertIn("# retained", channel.METADATA.read_text())
        self.assertEqual(channel.metadata()["MAGICSTICK_PUBLIC_REF"], "feature/test")
        self.assertEqual(channel.METADATA.stat().st_mode & 0o777, 0o600)
        channel.METADATA.write_text("X='$(touch /tmp/never)'\n")
        self.assertEqual(channel.metadata()["X"], "$(touch /tmp/never)")

    def test_resolve_distinguishes_same_name_tag_and_branch_and_tracks_new_commits(self):
        remote = self.root / "remote"; remote.mkdir()
        env = {**os.environ, "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.com", "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.com"}
        def git(*args): return subprocess.check_output(["git", "-C", str(remote), *args], env=env, text=True).strip()
        git("init", "--quiet", "--initial-branch=main"); git("commit", "--quiet", "--allow-empty", "-m", "first")
        first = git("rev-parse", "HEAD"); git("tag", "feature/test"); git("checkout", "-qb", "feature/test")
        git("commit", "--quiet", "--allow-empty", "-m", "second"); second = git("rev-parse", "HEAD")
        bare = self.root / "bare"
        self.assertEqual(channel.resolve(str(remote), {"kind": "tag", "value": "feature/test"}, bare), first)
        self.assertEqual(channel.resolve(str(remote), {"kind": "branch", "value": "feature/test"}, bare), second)
        self.assertEqual(channel.resolve(str(remote), {"kind": "commit", "value": first}, bare), first)
        git("commit", "--quiet", "--allow-empty", "-m", "third")
        self.assertEqual(channel.resolve(str(remote), {"kind": "branch", "value": "feature/test"}, bare), git("rev-parse", "HEAD"))
        with self.assertRaises(ValueError): channel.resolve(str(remote), {"kind": "branch", "value": "missing"}, bare)

    def test_preflight_failure_never_changes_metadata(self):
        before = channel.METADATA.read_bytes()
        with patch.object(channel, "resolve", return_value="a" * 40), patch.object(channel, "inspect", side_effect=ValueError("image missing")):
            with self.assertRaisesRegex(ValueError, "image missing"): channel.preview({"kind": "branch", "value": "develop"})
        self.assertEqual(before, channel.METADATA.read_bytes())
        self.assertFalse((self.root / "software-previous.json").exists())

    def test_interrupted_service_is_not_reported_busy_forever(self):
        channel.write_json(self.root / "software-operation.json", {"requestId": "a" * 32, "phase": "Applying", "pid": 99999999, "processStart": "0"})
        self.assertEqual(channel.operation_status()["phase"], "Interrupted")

    def request(self, selected):
        checked = channel.preview(selected)
        return {"action": "apply-software-channel", "requestId": "a" * 32,
                "planId": channel.config()["id"], "softwareChannel": selected, "softwarePreviewId": checked["id"]}

    def test_apply_waits_for_host_flux_and_images_before_clearing_pause(self):
        selected = {"kind": "branch", "value": "feature/test"}
        images = [{"name": "Dashboard", "image": "example.com/web@sha256:" + "1" * 64}]
        with patch.object(channel, "git_commit", return_value="a" * 40), patch.object(channel, "resolve", return_value="b" * 40), patch.object(channel, "inspect", return_value=images), patch.object(channel, "backup") as backup, patch.object(channel, "converge") as converge, patch.object(channel, "verify") as verify:
            request = self.request(selected)
            lock = object(); kube = object()
            result = channel.execute(request, lock, kube)
            backup.assert_called_once()
            converge.assert_called_once_with("b" * 40, lock)
            verify.assert_called_once_with("b" * 40, kube, expected_images=[images[0]["image"]])
            self.assertIn("ready", result)
        self.assertEqual(channel.config()["channel"], selected)
        self.assertFalse((self.root / "software-blocked.json").exists())

    def test_branch_moved_after_review_does_not_change_host(self):
        with patch.object(channel, "git_commit", return_value="a" * 40), patch.object(channel, "resolve", side_effect=["b" * 40, "c" * 40]), patch.object(channel, "inspect", return_value=[]), patch.object(channel, "converge") as converge:
            request = self.request({"kind": "branch", "value": "develop"})
            before = channel.METADATA.read_bytes()
            with self.assertRaisesRegex(ValueError, "changed after review"):
                channel.execute(request, object(), object())
            converge.assert_not_called()
            self.assertEqual(channel.METADATA.read_bytes(), before)

    def test_failed_apply_pauses_convergence_and_retry_preserves_recovery(self):
        selected = {"kind": "branch", "value": "feature/test"}
        def backup(_): channel.write_json(self.root / "software-previous.json", {"commit": "a" * 40})
        with patch.object(channel, "git_commit", return_value="a" * 40), patch.object(channel, "resolve", return_value="b" * 40), patch.object(channel, "inspect", return_value=[]), patch.object(channel, "backup", side_effect=backup) as saved, patch.object(channel, "converge", side_effect=RuntimeError("interrupted")):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                channel.execute(self.request(selected), object(), object())
            self.assertTrue((self.root / "software-blocked.json").is_file())
            with self.assertRaises(RuntimeError):
                channel.execute(self.request(selected), object(), object())
            self.assertEqual(saved.call_count, 1)
            self.assertEqual(channel.read_json(self.root / "software-previous.json")["commit"], "a" * 40)

    def test_verify_requires_applied_revision_ready_children_and_exact_images(self):
        revision = "a" * 40
        evidence = {"sourceRevision": "sha1:" + revision, "appliedRevision": "sha1:" + revision,
                    "images": [{"image": "new", "imageId": "sha256:resolved", "ready": True}]}
        resources = {"items": [{"spec": {"sourceRef": {"name": "flux-system"}}, "status": {
            "lastAppliedRevision": "sha1:" + revision, "conditions": [{"type": "Ready", "status": "True"}]}}]}
        with patch.object(channel, "observe", return_value=evidence):
            self.assertEqual(channel.verify(revision, lambda _: resources, expected_images=["new"]), evidence)
            with patch.object(channel.time, "monotonic", side_effect=[0, 0, 2]), patch.object(channel.time, "sleep"):
                with self.assertRaisesRegex(ValueError, "did not converge"):
                    channel.verify(revision, lambda _: resources, timeout=1, expected_images=["different"])

    def test_missing_service_ack_is_not_hidden_by_a_previous_result(self):
        cap = {"supported": True, "id": "f" * 64, "operation": {"requestId": "b" * 32, "phase": "Succeeded"}}
        plan = {"id": "e" * 64}
        request = operation(plan, action="check-software-channel", planId=cap["id"], softwareChannel={"kind": "branch", "value": "develop"})
        worker = host_worker.Worker(node(), report(), plan, self.root, software=cap)
        with patch.object(channel, "status", return_value=cap), patch.object(host_worker, "kube"), patch.object(host_worker, "run"):
            worker.reconcile(request)
            worker.state["current"]["softwareStartedAt"] -= 301
            worker.reconcile(request)
        self.assertEqual(worker.state["current"]["phase"], "Interrupted")

    def test_worker_queues_once_and_does_not_run_git_in_api_request(self):
        cap = {"supported": True, "id": "f" * 64}
        plan = {"id": "e" * 64}
        request = operation(plan, action="check-software-channel", planId=cap["id"], softwareChannel={"kind": "branch", "value": "feature/gpu"})
        worker = host_worker.Worker(node(), report(), plan, self.root, software=cap)
        with patch.object(channel, "status", return_value=cap), patch.object(host_worker, "kube"), patch.object(host_worker, "run") as run:
            worker.reconcile(request)
            self.assertEqual(worker.state["current"]["phase"], "Applying")
            run.assert_called_once_with(["/usr/bin/systemctl", "start", "--no-block", "magicstick-software-channel.service"])
            worker.reconcile(request)
            self.assertEqual(run.call_count, 1)
        self.assertEqual(json.loads((self.root / "approved-software.json").read_text())["softwareChannel"]["value"], "feature/gpu")

    def test_registry_checks_platform_and_digest_without_downloading_layers(self):
        raw = json.dumps({"manifests": [{"platform": {"os": "linux", "architecture": "amd64"}}]}).encode()
        image = "python:3.13-alpine@sha256:" + channel.hashlib.sha256(raw).hexdigest()
        with patch.object(channel.urllib.request, "urlopen", side_effect=lambda request, **_: io.BytesIO(raw)) as fetch:
            channel.registry_image(image, "amd64")
            self.assertIn("registry-1.docker.io/v2/library/python/manifests/", fetch.call_args.args[0].full_url)
            with self.assertRaisesRegex(ValueError, "Linux/arm64"): channel.registry_image(image, "arm64")
            with self.assertRaisesRegex(ValueError, "unexpected image digest"): channel.registry_image("python:3.13-alpine@sha256:" + "f" * 64, "amd64")
