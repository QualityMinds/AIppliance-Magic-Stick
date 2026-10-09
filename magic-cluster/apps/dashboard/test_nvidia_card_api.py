import copy
import json
import unittest
from unittest.mock import patch

from test_dashboard_api import load_server

UUIDS = ["GPU-00000000-0000-0000-0000-" + str(i).zfill(12) for i in range(4)]


class NvidiaCardApiTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.node = {"metadata": {"name": "fixture-node", "uid": "fixture-uid", "labels": {"appliance.magicstick.dev/nvidia-dra-ready": "true"}},
                     "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
        self.state = {"provider": "nvidia", "backend": "dra", "mode": "shared", "phase": "Ready",
            "nodeName": "fixture-node", "nodeUid": "fixture-uid", "maxModels": 4,
            "devices": [{"uuid": u, "name": "gpu-" + str(i), "pool": "fixture-node", "node": "fixture-node",
                         "nodeUid": "fixture-uid", "claimName": "fixture-claim-" + str(i), "totalMi": 49152} for i, u in enumerate(UUIDS)]}
        self.models, self.pods = [], []

    def model(self, card=2, enabled=True):
        return {"metadata": {"name": "fixture-model"}, "spec": {"type": "local", "targetNamespace": "ai", "enabled": enabled,
            "local": {"engine": "VLLM", "computeTarget": "nvidia-gpu", "vramMi": 10000,
                      "gpuDevice": {"uuid": UUIDS[card], "nodeName": "fixture-node", "nodeUid": "fixture-uid"}}}}

    def pod(self, terminating=False):
        return {"metadata": {"namespace": "ai", "labels": {"app.kubernetes.io/managed-by": "kubeai",
            "appliance.magicstick.dev/compute-target": "nvidia-gpu", "appliance.magicstick.dev/modelactivation": "fixture-model"},
            **({"deletionTimestamp": "2026-01-01T00:00:00Z"} if terminating else {})},
            "spec": {"resourceClaims": [{"name": "gpu", "resourceClaimName": "fixture-claim-2"}]}, "status": {"phase": "Running"}}

    def summary(self, exclude=None):
        return self.api["nvidia_card_slots"](self.models, [self.node], self.pods, self.state, exclude)

    def test_one_starting_model_charges_only_its_selected_card(self):
        self.models = [self.model()]
        for pods in ([], [self.pod()]):
            self.pods = pods
            summary = self.summary()
            self.assertEqual((summary["total"], summary["used"], summary["free"]), (16, 1, 15))
            self.assertEqual([d["free"] for d in summary["devices"]], [4, 4, 3, 4])

    def test_stop_retains_terminating_pod_slot_then_restart_reserves_once(self):
        self.models = [self.model(enabled=False)]; self.pods = [self.pod(terminating=True)]
        self.assertEqual(self.summary()["devices"][2]["free"], 3)
        self.pods = []; self.assertEqual(self.summary()["devices"][2]["free"], 4)
        self.models[0]["spec"]["enabled"] = True
        self.assertEqual(self.summary()["devices"][2]["free"], 3)

    def test_exclusive_edit_excludes_only_its_own_slot(self):
        self.state["mode"] = "exclusive"; self.models = [self.model()]; self.pods = [self.pod()]
        self.assertEqual([d["free"] for d in self.summary()["devices"]], [1, 1, 0, 1])
        self.assertEqual([d["free"] for d in self.summary("fixture-model")["devices"]], [1, 1, 1, 1])

    def test_unbound_model_does_not_repeat_pool_reservation_on_all_cards(self):
        self.models = [self.model()]; self.models[0]["spec"]["local"].pop("gpuDevice")
        summary = self.summary()
        self.assertEqual(summary["free"], 15)
        self.assertEqual(summary["unassigned"], 1)
        self.assertEqual([d["used"] for d in summary["devices"]], [0, 0, 0, 0])

    def test_external_diagnostic_retains_only_its_actual_namespace_local_claim(self):
        diagnostic = self.pod(); diagnostic["metadata"]["labels"] = {}
        other = copy.deepcopy(diagnostic); other["metadata"]["namespace"] = "other"
        self.models = [self.model()]; self.pods = [self.pod(), diagnostic, other]
        self.assertEqual([d["used"] for d in self.summary()["devices"]], [0, 0, 2, 0])

    def test_wrong_node_or_starting_backend_has_no_selectable_cards(self):
        self.node["metadata"]["uid"] = "replaced"
        self.assertEqual(self.summary()["total"], 0)
        self.node["metadata"]["uid"] = "fixture-uid"; self.state["phase"] = "Starting"
        self.assertEqual(self.summary()["total"], 0)

    def test_card_pinned_queue_does_not_consume_free_sibling_capacity(self):
        self.models = [self.model() for _ in range(20)]
        for i, model in enumerate(self.models):
            model["metadata"]["name"] = "fixture-model-" + str(i)
        summary = self.summary()
        self.assertEqual((summary["used"], summary["free"], summary["queued"]), (4, 12, 16))
        self.assertEqual([d["free"] for d in summary["devices"]], [4, 4, 0, 4])

    def test_replaced_node_cannot_charge_old_selected_gpu_identity(self):
        model = self.model(); model["spec"]["local"]["gpuDevice"]["nodeUid"] = "previous-installation"
        self.models = [model]
        summary = self.summary()
        self.assertEqual((summary["used"], summary["free"], summary["unassigned"], summary["queued"]), (0, 16, 0, 1))
        self.assertEqual([d["used"] for d in summary["devices"]], [0, 0, 0, 0])
        devices = [{"computeTarget": "nvidia-gpu", "nodes": ["fixture-node"], "totalMi": 49152,
                    "gpuDevice": {"uuid": u, "nodeName": "fixture-node", "nodeUid": "fixture-uid"}} for u in UUIDS]
        reservations = self.api["active_model_memory_reservations"]([model])
        self.assertEqual([d["reservedMi"] for d in self.api["assign_gpu_reservations"](devices, reservations)], [0] * 4)

    def test_missing_card_and_wrong_namespace_queue_without_occupying_siblings(self):
        for change in ("uuid", "namespace"):
            model = self.model()
            if change == "uuid":
                model["spec"]["local"]["gpuDevice"]["uuid"] = "GPU-ffffffff-ffff-ffff-ffff-ffffffffffff"
            else:
                model["spec"]["targetNamespace"] = "other"
            self.models = [model]
            summary = self.summary()
            self.assertEqual((summary["used"], summary["free"], summary["queued"]), (0, 16, 1))
            self.assertEqual([d["used"] for d in summary["devices"]], [0] * 4)

    def test_exact_card_memory_is_not_reassigned_to_siblings(self):
        devices = [{"id": "nvidia-" + u, "computeTarget": "nvidia-gpu", "nodes": ["fixture-node"], "totalMi": 49152,
                    "gpuDevice": {"uuid": u, "nodeName": "fixture-node", "nodeUid": "fixture-uid"}} for u in UUIDS]
        reservations = self.api["active_model_memory_reservations"]([self.model()])
        memory = self.api["assign_gpu_reservations"](devices, reservations)
        self.assertEqual([d["reservedMi"] for d in memory], [0, 0, 10000, 0])
        self.assertEqual([d["unreservedMi"] for d in memory], [49152, 49152, 39152, 49152])

    def test_missing_metrics_still_yield_distinct_verified_cards_without_fake_free_ram(self):
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: self.state}):
            devices = self.api["attach_nvidia_dra_memory"]([], [self.node])
        self.assertEqual(len(devices), 4)
        self.assertTrue(all(d["freeMi"] is None and d["metricsAvailable"] is False for d in devices))
        self.assertEqual(len({d["gpuDevice"]["uuid"] for d in devices}), 4)
        catalog = {"targets": {"nvidia-gpu": {"kind": "gpu", "resourceNames": ["nvidia.com/gpu"]}}}
        self.assertEqual(self.api["gpu_resource_placeholders"]([self.node], catalog, devices), [])
        memory = {"devices": devices}; targets = {"targets": [{"id": "nvidia-gpu"}]}
        self.api["attach_gpu_slots"](memory, targets, {"nvidia-gpu": self.summary()})
        self.assertTrue(all(d["slots"]["scope"] == "device" for d in devices))

    def test_selection_validation_and_persistence_never_become_cuda_environment_overrides(self):
        local = {**self.model()["spec"]["local"], "url": "hf://fixture/small"}
        catalog = {"targets": {"nvidia-gpu": {"kind": "gpu"}}}
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: self.state, "compute_target_catalog": lambda: catalog}):
            resource = self.api["model_activation_payload"]("local", {"name": "fixture-model", "local": local})
            self.assertEqual(resource["spec"]["local"]["gpuDevice"], local["gpuDevice"])
            self.assertNotIn("env", resource["spec"]["local"])
            _current, merged = self.api["merged_local_model_settings"](resource, {"gpuDevice": {**local["gpuDevice"], "uuid": UUIDS[1]}})
            self.assertEqual(merged["gpuDevice"]["uuid"], UUIDS[1])
            for invalid in (None, {"uuid": UUIDS[2]}, {**local["gpuDevice"], "uuid": "GPU-invalid"},
                            {**local["gpuDevice"], "uuid": "GPU-" + "-" * 36},
                            {**local["gpuDevice"], "nodeUid": "replacement"}):
                with self.subTest(invalid=invalid), self.assertRaises((ValueError, self.api["RequestError"])):
                    self.api["validate_nvidia_gpu_selection"]({**local, "gpuDevice": invalid})
            with self.assertRaises(ValueError):
                self.api["validate_nvidia_gpu_selection"]({**local, "computeTarget": "cpu"})

    def test_card_full_is_rejected_even_with_memory_risk_permission(self):
        local = self.model()["spec"]["local"]; local["allowMemoryRisk"] = True
        summary = self.summary(); summary["devices"][2]["free"] = 0
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: self.state, "model_activations": lambda: [],
                                  "gpu_slot_summary": lambda *_a, **_kw: {"nvidia-gpu": summary}}):
            with self.assertRaises(self.api["RequestError"]) as error:
                self.api["require_gpu_slot_available"](self.model())
        self.assertEqual(error.exception.status, 409)

    def test_backend_switch_is_revision_bound_and_keeps_other_settings(self):
        state = {**self.state, "expectedRevision": "9", "draAvailable": True, "available": True, "reason": ""}
        writes = []
        payload = {"provider": "nvidia", "allocationBackend": "dra", "mode": "shared", "maxModels": 4,
            "nodeName": "fixture-node", "nodeUid": "fixture-uid", "expectedRevision": "9",
            "acknowledgeSharing": True, "acknowledgeRestart": True}
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: state, "request_json": lambda *a: writes.append(a)}):
            self.api["configure_gpu_sharing"](payload)
            config = json.loads(writes[0][2]["spec"]["parameters"]["gpuSharing"])
            self.assertEqual((config["mode"], config["allocationBackend"]), ("dra-shared", "dra"))
            self.assertEqual(set(writes[0][2]["spec"]["parameters"]), {"gpuSharing"})
            for change in ({"expectedRevision": "old"}, {"nodeUid": "other"}, {"allocationBackend": "mps"}):
                with self.assertRaises((ValueError, self.api["RequestError"])):
                    self.api["configure_gpu_sharing"]({**payload, **change})
        self.assertEqual(len(writes), 1)

    def test_disabled_module_is_not_overridden_by_old_dra_readiness(self):
        self.node["metadata"]["labels"]["appliance.magicstick.dev/nvidia-dra-config"] = "fixture-config"
        catalog = {"targets": {"nvidia-gpu": {"kind": "gpu", "engines": ["VLLM", "OLlama"],
                    "resourceNames": ["nvidia.com/gpu"], "requiredCapabilities": ["gpu-nvidia"]}}}
        modules = {"modules": {"gpu": {"enabled": False, "catalog": {"providesCapabilities": ["gpu-nvidia"]}}}}
        with patch.dict(self.api, {"ready_schedulable_nodes": lambda: [self.node], "compute_target_catalog": lambda: catalog,
                "freetoken_ui_capabilities": lambda *_: {}, "gpu_sharing_status": lambda *_: self.state,
                "kv_cache_options": lambda *_: []}):
            target = self.api["compute_target_availability"](modules)["targets"][0]
        self.assertFalse(target["available"])
        self.assertEqual(target["reason"], "capability-module-disabled")

    def test_device_plugin_write_retains_the_legacy_saved_configuration_shape(self):
        writes = []
        state = {**self.state, "backend": "time-slicing", "expectedRevision": "9", "available": True, "reason": ""}
        request = {"provider": "nvidia", "allocationBackend": "device-plugin", "mode": "shared", "maxModels": 4,
                   "nodeName": "fixture-node", "nodeUid": "fixture-uid", "expectedRevision": "9",
                   "acknowledgeSharing": True, "acknowledgeRestart": True}
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: state, "request_json": lambda *a: writes.append(a)}):
            self.api["configure_gpu_sharing"](request)
        config = json.loads(writes[0][2]["spec"]["parameters"]["gpuSharing"])
        self.assertEqual(config, {"allowExperimental": False, "maxModels": 4, "mode": "time-slicing",
                                 "namespace": "ai", "nodeName": "fixture-node", "nodeUid": "fixture-uid"})
