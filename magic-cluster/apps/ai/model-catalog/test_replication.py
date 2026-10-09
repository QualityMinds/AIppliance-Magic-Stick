import copy
import json
import unittest
from unittest.mock import patch

from test_controller import load_controller


class ReplicatedRoutingTests(unittest.TestCase):
    def setUp(self):
        self.c = load_controller()
        self.parent = {"metadata": {"name": "public-model", "uid": "parent-uid", "generation": 3},
            "spec": {"type": "local", "enabled": True, "local": {"gpuDeployment": "replicated", "gpuDevices": [{"uuid": "card-0"}, {"uuid": "card-1"}]}},
            "status": {"phase": "Ready", "observedGeneration": 3, "replication": {"instances": [
                {"name": "msr-" + str(i), "modelUid": "child-uid-" + str(i), "phase": "Ready"} for i in range(2)]}}}
        self.models = [{"metadata": {"name": "msr-" + str(i), "uid": "child-uid-" + str(i), "namespace": "ai", "labels": {
            "app.kubernetes.io/managed-by": "magicstick-operator", "appliance.magicstick.dev/modelactivation": "public-model",
            "appliance.magicstick.dev/activation-uid": "parent-uid", "appliance.magicstick.dev/model-replica": "true"}, "annotations": {
                "appliance.magicstick.dev/activation-generation": "3", "appliance.magicstick.dev/replica-gpu": "card-" + str(i)}},
            "spec": {"engine": "VLLM", "features": ["TextGeneration"]}, "status": {"replicas": {"ready": 1}}} for i in range(2)]
        self.calls = []
        self.mocks = {"read_model_activations": lambda: [self.parent], "list_kubeai_models": lambda: self.models,
            "read_external_models": lambda: [], "litellm_request": lambda *args: self.calls.append(args)}

    def desired(self):
        with patch.dict(self.c, self.mocks): return list(self.c["desired_deployments"]().values())

    def test_two_distinct_deployments_share_one_public_model_name(self):
        deployed = self.desired()
        self.assertEqual([d["model_name"] for d in deployed], ["public-model", "public-model"])
        self.assertEqual([d["litellm_params"]["model"] for d in deployed], ["openai/msr-0", "openai/msr-1"])
        self.assertEqual(len({d["model_info"]["id"] for d in deployed}), 2)
        catalog, _ = self.c["build_catalog"](deployed)
        self.assertEqual([m["id"] for m in json.loads(catalog["catalog.json"])["models"]], ["public-model"])

    def test_degraded_or_starting_pool_routes_only_healthy_copies(self):
        self.parent["status"]["phase"] = "Degraded"
        self.parent["status"]["replication"]["instances"][0]["phase"] = "Degraded"
        self.assertEqual([d["litellm_params"]["model"] for d in self.desired()], ["openai/msr-1"])
        self.parent["status"]["phase"] = "Starting"
        self.assertEqual(len(self.desired()), 1)
        self.models[1]["status"]["replicas"]["ready"] = 0
        self.assertFalse(self.desired())

    def test_stopped_removed_reconfigured_or_replaced_parent_never_leaks_internal_names(self):
        original = copy.deepcopy(self.parent)
        for mutation in (lambda p: p["spec"].update(enabled=False), lambda p: p["metadata"].update(deletionTimestamp="now"),
                         lambda p: p["metadata"].update(uid="recreated"), lambda p: p["metadata"].update(generation=4),
                         lambda p: p["spec"]["local"].update(gpuDeployment="split"),
                         lambda p: p["status"].update(observedGeneration=2)):
            self.parent = copy.deepcopy(original); mutation(self.parent)
            self.assertFalse(self.desired())
        self.parent = {}; self.assertFalse(self.desired())

    def test_sync_updates_by_deployment_id_and_removes_failed_copy_only(self):
        existing = self.desired()
        self.parent["status"]["replication"]["instances"][0]["phase"] = "Degraded"
        unmanaged = {"model_name": "public-model", "model_info": {"id": "unmanaged"}}
        mesh = {"model_name": "public-model", "model_info": {"id": "mesh", "ai_appliance_managed": True, "magicstick_mesh_owner": "peer"}}
        with patch.dict(self.c, {**self.mocks, "fetch_litellm_models": lambda: existing + [unmanaged, mesh]}):
            self.c["sync_litellm"]()
        surviving_id = existing[1]["model_info"]["id"]
        updated = [body for method, route, body in self.calls
                   if method == "PATCH" and route == f"/model/{surviving_id}/update"]
        deleted = [body for method, route, body in self.calls
                   if method == "POST" and route == "/model/delete"]
        self.assertEqual(len(self.calls), 2)
        self.assertEqual([d["model_info"]["id"] for d in updated], [existing[1]["model_info"]["id"]])
        self.assertEqual(deleted, [{"id": existing[0]["model_info"]["id"]}])

    def test_create_keeps_ids_independent_and_never_adopts_foreign_same_id(self):
        with patch.dict(self.c, {**self.mocks, "fetch_litellm_models": lambda: []}): self.c["sync_litellm"]()
        self.assertEqual([route for _, route, _ in self.calls], ["/model/new", "/model/new"])
        existing = self.desired(); existing[0]["model_info"]["ai_appliance_managed"] = False
        self.calls.clear()
        with patch.dict(self.c, {**self.mocks, "fetch_litellm_models": lambda: existing}), self.assertRaises(ValueError):
            self.c["sync_litellm"]()
        self.assertFalse(self.calls)
