import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "files"))
import model_cache as cache
import host_plan
import host_worker
from test_host_management import node, operation, report


class ModelCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # Resolve the macOS /var alias: production deliberately refuses symlinks.
        self.root = Path(self.tmp.name).resolve()
        self.hf, self.ollama = self.root / "hf", self.root / "ollama/models"
        self.hf.mkdir()
        self.ollama.mkdir(parents=True)
        self.contents = {"modelactivations.appliance.magicstick.dev": [], "models.kubeai.org": [], "pods": []}
        self.addCleanup(patch.stopall)
        patch.object(cache, "CACHES", (("huggingface", "Hugging Face / vLLM", str(self.hf)),
                                      ("ollama", "Ollama", str(self.ollama)))).start()
        self.weights = self.hf / "models--example--model"
        self.weights.mkdir()
        (self.weights / "weights").write_bytes(b"x" * 8192)
        (self.ollama / "blobs").mkdir()
        (self.ollama / "blobs/weights").write_bytes(b"x" * 8192)
        self.capability = cache.collect(node(), self.kube)
        self.payload = {"planId": self.capability["id"], "allowExperimental": False, "experimentMode": False}

    def kube(self, args, data=None):
        return {"items": copy.deepcopy(self.contents[args[1]])}

    def test_inventory_sizes_and_zero_cache(self):
        self.assertTrue(self.capability["supported"])
        self.assertFalse(self.capability["blocked"])
        self.assertGreater(self.capability["reclaimableBytes"], 0)
        self.assertEqual(len(self.capability["caches"]), 3)
        after = cache.clear(node(), self.kube, self.payload)
        self.assertEqual(after["reclaimableBytes"], 0)
        self.assertGreater(after["freeBytes"], 0)

    def test_only_models_are_deleted_credentials_datasets_and_symlink_targets_survive(self):
        secret = self.root / "token"
        secret.write_text("test-fixture")
        (self.hf / "datasets--example").mkdir()
        (self.ollama.parent / "id_ed25519").write_text("test-fixture")
        (self.weights / "outside").symlink_to(secret)
        (self.hf / "models--example--symlink").symlink_to(self.root / "outside-dir", target_is_directory=True)
        (self.root / "outside-dir").mkdir()
        (self.root / "outside-dir/keep").write_text("keep")
        cache.clear(node(), self.kube, self.payload)
        self.assertTrue(secret.exists())
        self.assertTrue((self.root / "outside-dir/keep").exists())
        self.assertTrue((self.hf / "datasets--example").exists())
        self.assertTrue((self.ollama.parent / "id_ed25519").exists())
        self.assertFalse(self.weights.exists())

    def test_cache_parent_symlink_is_rejected(self):
        link = self.root / "link"
        link.symlink_to(self.hf, target_is_directory=True)
        with patch.object(cache, "CACHES", (("huggingface", "HF", str(link)),)):
            self.assertFalse(cache.collect(node(), self.kube)["supported"])
            with self.assertRaises(ValueError): cache.clear(node(), self.kube, self.payload)
        self.assertTrue(self.weights.exists())

    def test_active_pending_terminating_and_unpinned_workloads_block(self):
        cases = [
            ("modelactivations.appliance.magicstick.dev", {"spec": {"enabled": True, "type": "local"}}),
            ("models.kubeai.org", {"spec": {"minReplicas": 0}}),
            ("pods", {"metadata": {"labels": {"app": "model"}}, "status": {"phase": "Pending"}}),
            ("pods", {"metadata": {"deletionTimestamp": "now", "labels": {"app": "model"}}, "spec": {"nodeName": "example-node"}}),
            ("pods", {"spec": {"volumes": [{"hostPath": {"path": str(self.hf.parent)}}]}}),
            ("pods", {"spec": {"volumes": [{"hostPath": {"path": str(self.weights)}}]}}),
            ("pods", {"spec": {"volumes": [{"hostPath": {"path": str(self.ollama / "blobs")}}]}}),
        ]
        for resource, workload in cases:
            with self.subTest(resource=resource, workload=workload):
                self.contents[resource] = [workload]
                self.assertTrue(cache.collect(node(), self.kube)["blocked"])
                with self.assertRaises(ValueError): cache.clear(node(), self.kube, self.payload)
                self.assertTrue(self.weights.exists())
                self.contents[resource] = []

    def test_hostpath_overlap_does_not_match_unrelated_prefixes(self):
        self.contents["pods"] = [{"spec": {"volumes": [{"hostPath": {"path": str(self.hf) + "-other"}}]}}]
        self.assertFalse(cache.collect(node(), self.kube)["blocked"])
        self.assertTrue(cache.cache_path_overlap(str(self.hf / ".." / self.hf.name / "models--example")))
        self.assertTrue(cache.cache_path_overlap("/"))

    def test_disabled_external_and_other_pinned_node_do_not_block(self):
        self.contents["modelactivations.appliance.magicstick.dev"] = [
            {"spec": {"enabled": False}}, {"spec": {"type": "external"}},
            {"spec": {"local": {"freetoken": {"gpuDevice": "node:other-node"}}}},
        ]
        self.assertFalse(cache.collect(node(), self.kube)["blocked"])

    def test_unavailable_inventory_fails_closed(self):
        self.assertFalse(cache.collect(node(), lambda _: None)["supported"])
        with self.assertRaises(ValueError): cache.clear(node(), lambda _: None, self.payload)

    def test_nested_mounts_are_not_deleted(self):
        with patch.object(cache, "check_mounts", side_effect=ValueError("Nested mount")):
            self.assertFalse(cache.collect(node(), self.kube)["supported"])
            with self.assertRaises(ValueError): cache.clear(node(), self.kube, self.payload)
        self.assertTrue(self.weights.exists())

    def test_host_service_keeps_home_readonly_except_fixed_cache_paths(self):
        service = (Path(__file__).resolve().parents[1] / "templates/magicstick-host-management.service.j2").read_text()
        self.assertIn("ProtectHome=read-only", service)
        self.assertIn("ReadWritePaths=-/root/.cache/huggingface/hub -/root/.ollama/models", service)

    def test_stale_plan_other_settings_and_empty_cache_rejected(self):
        for changes in ({"planId": "b" * 64}, {"gpuMemory": {}}, {"allowExperimental": True}, {"updatePolicy": {}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                cache.validate_cleanup(self.payload | changes, self.capability)
        cache.clear(node(), self.kube, self.payload)
        with self.assertRaisesRegex(ValueError, "empty"):
            cache.validate_cleanup(self.payload, cache.collect(node(), self.kube))

    def test_workload_appearing_after_inventory_stops_deletion(self):
        with patch.object(cache, "blockers", side_effect=[(False, []), (True, [])]):
            with self.assertRaisesRegex(ValueError, "started"):
                cache.clear(node(), self.kube, self.payload)
        self.assertTrue(self.weights.exists())

    def test_worker_contract_and_one_time_execution(self):
        op = operation({}, "clear-model-cache", **self.payload)
        host_plan.validate_request(op, node(), report(), {}, __import__('time').time(), model_cache=self.capability)
        worker = host_worker.Worker(node(), report(), {}, state_dir=self.root, cache=self.capability)
        with patch.object(host_worker, "kube", return_value={}), patch.object(cache, "clear", return_value={"reclaimableBytes": 0}) as clear:
            worker.reconcile(op)
            self.assertEqual(worker.state["current"]["phase"], "Succeeded")
            worker.reconcile(op)
            self.assertEqual(clear.call_count, 1)

    def test_interrupted_deletion_is_not_automatically_replayed(self):
        op = operation({}, "clear-model-cache", **self.payload)
        worker = host_worker.Worker(node(), report(), {}, state_dir=self.root, cache=self.capability)
        worker.state["current"] = {"operationUid": op["metadata"]["uid"], "requestId": op["spec"]["requestId"],
            "action": "clear-model-cache", "nodeUid": "node-uid", "phase": "Preparing", "startedAt": host_worker.stamp()}
        with patch.object(host_worker, "kube", return_value={}), patch.object(cache, "clear") as clear:
            worker.reconcile(op)
            self.assertEqual(worker.state["current"]["phase"], "Interrupted")
            clear.assert_not_called()


if __name__ == "__main__": unittest.main()
