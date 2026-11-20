from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml


FILES = Path(__file__).resolve().parents[1] / "files"
with patch.object(sys, "path", [str(FILES), *sys.path]):
    import control_plane_maintenance as maintenance
    import control_plane_release as release
    from control_plane_migration import MigrationError


KDNS_IMAGE = "ghcr.io/qualityminds/magicstick-kdns@sha256:" + "a" * 64
API_IMAGE = "ghcr.io/qualityminds/magicstick-dashboard:api-sha-" + "b" * 40 + "@sha256:" + "c" * 64


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.marker = self.root / release.MARKER
        self.marker.parent.mkdir(parents=True)
        api = self.root / release.API
        api.parent.mkdir(parents=True)
        api.write_text(yaml.safe_dump({"spec": {"template": {"spec": {"containers": [
            {"name": "api", "image": API_IMAGE},
        ]}}}}))
        (self.root / release.KDNS / "helmrelease.yaml").write_text(yaml.safe_dump({
            "spec": {"postRenderers": [{"kustomize": {"patches": [{
                "target": {"kind": "Deployment", "name": "kdns-kdns"},
                "patch": yaml.safe_dump([{"op": "replace", "path": "/spec/template/spec/containers/0/image",
                                           "value": KDNS_IMAGE}]),
            }]}}]},
        }))
        self.pins = {"version": 1, "kdns": KDNS_IMAGE, "dashboardApi": API_IMAGE}

    def test_absent_promotion_is_inactive(self):
        self.assertIsNone(release.qualified_pins(self.root))

    def test_matching_immutable_promotion_activates_managed_candidate(self):
        self.marker.write_text(json.dumps(self.pins))
        self.assertEqual(release.qualified_pins(self.root), self.pins)

    def test_floating_or_different_artifact_is_not_an_activation_marker(self):
        for image in ("ghcr.io/qualityminds/magicstick-kdns:latest", KDNS_IMAGE[:-1] + "d"):
            with self.subTest(image=image), self.assertRaises(ValueError):
                self.marker.write_text(json.dumps(self.pins | {"kdns": image}))
                release.qualified_pins(self.root)

    def test_update_checks_the_selected_git_revision_not_the_worktree(self):
        def git(*args):
            return subprocess.run(["git", *args], cwd=self.root, capture_output=True, text=True, check=True).stdout.strip()

        git("init", "-q")
        git("config", "user.name", "Synthetic Fixture")
        git("config", "user.email", "fixture@example.com")
        git("add", ".")
        git("commit", "-qm", "Legacy network profile")
        legacy = git("rev-parse", "HEAD")
        self.marker.write_text(json.dumps(self.pins))
        git("add", ".")
        git("commit", "-qm", "Matching managed network profile")
        approved = git("rev-parse", "HEAD")
        self.marker.write_text(json.dumps(self.pins | {"dashboardApi": API_IMAGE[:-1] + "d"}))
        git("add", ".")
        git("commit", "-qm", "Mismatched managed network profile")
        self.assertEqual(release.qualified_pins(self.root, approved), self.pins)
        for rejected in (legacy, git("rev-parse", "HEAD"), "HEAD"):
            with self.subTest(rejected=rejected), self.assertRaises(ValueError):
                release.qualified_pins(self.root, rejected)


class RuntimeGateTests(unittest.TestCase):
    def setUp(self):
        self.deploy = {
            "metadata": {"uid": "deployment", "generation": 4},
            "spec": {"replicas": 1, "selector": {"matchLabels": {"app": "fixture"}},
                     "template": {"spec": {"containers": [{"name": "api", "image": API_IMAGE}]}}},
            "status": {"observedGeneration": 4, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1},
        }
        self.replica = {"metadata": {"uid": "replica", "ownerReferences": [
            {"kind": "Deployment", "uid": "deployment", "controller": True},
        ]}}
        self.pod = {
            "metadata": {"ownerReferences": [{"kind": "ReplicaSet", "uid": "replica", "controller": True}]},
            "spec": {"containers": [{"name": "api", "image": API_IMAGE}]},
            "status": {"conditions": [{"type": "Ready", "status": "True"}], "containerStatuses": [
                {"name": "api", "ready": True, "imageID": API_IMAGE},
            ]},
        }

    def kube(self, args):
        return deepcopy({"deployment": self.deploy, "replicasets": {"items": [self.replica]},
                         "pods": {"items": [self.pod]}}[args[1]])

    def test_only_owned_ready_pod_with_exact_executing_digest_passes(self):
        maintenance.verify_ready_image(self.kube, "identity-system", "fixture", API_IMAGE)
        self.pod["status"]["containerStatuses"][0]["imageID"] = API_IMAGE[:-1] + "d"
        with self.assertRaisesRegex(MigrationError, "ready running container"):
            maintenance.verify_ready_image(self.kube, "identity-system", "fixture", API_IMAGE)

    def test_a_ready_pod_with_the_correct_label_but_wrong_owner_is_not_evidence(self):
        self.replica["metadata"]["ownerReferences"][0]["uid"] = "other"
        with self.assertRaisesRegex(MigrationError, "ready running container"):
            maintenance.verify_ready_image(self.kube, "identity-system", "fixture", API_IMAGE)

    def test_a_stop_intent_needs_authoritative_disabled_status(self):
        activation = {"spec": {"type": "local", "enabled": False}, "status": {"phase": "Stopping"}}
        reader = lambda _args: {"items": [activation]}
        with self.assertRaisesRegex(MigrationError, "Stop the local models"):
            maintenance.assert_models_idle(reader)
        activation["status"]["phase"] = "Disabled"
        maintenance.assert_models_idle(reader)

    def test_a_restart_needs_a_fresh_invocation_and_running_network_policy(self):
        with patch.object(maintenance, "local", side_effect=[
            "", "old\n", "", "InvocationID=old\nActiveState=active\n",
            "InvocationID=new\nActiveState=active\n", "InvocationID=new\nActiveState=active\n",
        ]) as system, patch.object(maintenance.time, "sleep") as delay, patch.object(
            maintenance.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, "", ""),
                subprocess.CompletedProcess([], 0, "Starting network policy controller version v2\n", ""),
            ],
        ) as journal:
            maintenance.restart()
        self.assertEqual(delay.call_count, 2)
        self.assertEqual(journal.call_count, 2)
        self.assertIn("_SYSTEMD_INVOCATION_ID=new", journal.call_args.args[0])
        self.assertEqual(system.call_count, 6)
