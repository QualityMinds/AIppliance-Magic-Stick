import copy
import json
import unittest
from unittest.mock import patch

from test_dashboard_api import load_server

UUIDS = ["GPU-00000000-0000-0000-0000-" + str(i).zfill(12) for i in range(4)]


class NvidiaCardApiTests(unittest.TestCase):
    def test_replication_keeps_full_weights_and_charges_host_ram_per_copy(self):
        capability = {"computeTargets": ["nvidia-gpu"], "maxDevices": 16, "deploymentModes": ["single", "split", "replicated"]}
        for engine in ("VLLM", "OLlama"):
            model = self.group(range(4))
            model["spec"]["local"].update(gpuDeployment="replicated", engine=engine)
            with patch.dict(self.api, {"compute_target_catalog": lambda: {"engines": {engine: {"multiGpu": capability}}}}):
                result = self.api["multi_gpu_estimate"](model["spec"]["local"], {"weightsMi": 10000, "kvCacheMi": 1000, "reserveMi": 512})
            self.assertEqual((result["weightsMi"], result["kvCacheMi"], result["reserveMi"]), (10000, 1000, 512))
            self.assertEqual((result["replicaCount"], result["totalWeightsMi"]), (4, 40000))
            reservations = self.api["active_model_memory_reservations"]([model])
            self.assertEqual(reservations["cpu"][0]["reservedMi"], 4 * 16400)

    def test_partial_replica_start_charges_each_selected_card_once(self):
        model = self.group(range(4)); model["spec"]["local"]["gpuDeployment"] = "replicated"
        self.models = [model]; self.pods = [self.pod()]  # card 2 running, others still starting
        self.assertEqual([d["used"] for d in self.summary()["devices"]], [1, 1, 1, 1])
        self.assertEqual([d["used"] for d in self.summary("fixture-model")["devices"]], [0, 0, 0, 0])
        model["spec"]["enabled"] = False
        self.assertEqual([d["used"] for d in self.summary()["devices"]], [0, 0, 1, 0])

    def test_replication_validates_mode_and_total_ram_and_roundtrips_edit(self):
        capability = {"computeTargets": ["nvidia-gpu"], "maxDevices": 16, "deploymentModes": ["single", "split", "replicated"]}
        catalog = {"targets": {"nvidia-gpu": {"kind": "gpu"}}, "engines": {e: {"multiGpu": capability} for e in ("VLLM", "OLlama")}}
        estimate = {"minimumMi": 9000, "maximumMi": 40000, "devices": [{"totalMi": 49152}]*2}
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: self.state, "compute_target_catalog": lambda: catalog,
                "estimate_model_memory": lambda *_: estimate, "offloading_host_memory_available": lambda *_: 40000}):
            for engine in ("VLLM", "OLlama"):
                local = {**self.group()["spec"]["local"], "engine": engine, "gpuDeployment": "replicated",
                         "url": "hf://fixture/small" if engine == "VLLM" else "ollama://fixture:small"}
                resource = self.api["model_activation_payload"]("local", {"name": "fixture-model", "local": local})
                self.assertEqual(resource["spec"]["local"]["gpuDeployment"], "replicated")
                for bad in ({"gpuDeployment": "unknown"}, {"gpuDeployment": "single"}, {"gpuDevices": local["gpuDevices"][:1]},
                            {"memoryRequiredMi": 20100, "allowMemoryRisk": True}, {"vramMi": 49200, "allowMemoryRisk": True},
                            {"vllm": {"parallelism": "tensor"}}):
                    with self.subTest(engine=engine, bad=bad), self.assertRaises(ValueError):
                        self.api["model_activation_payload"]("local", {"name": "fixture-model", "local": {**local, **bad}})
                _, saved = self.api["merged_local_model_settings"](resource, {"gpuDeployment": "split"})
                self.assertEqual(saved["gpuDeployment"], "split")

    def group(self, cards=(0, 1), enabled=True):
        model = self.model(enabled=enabled)
        local = model["spec"]["local"]
        local.pop("gpuDevice")
        local.update(gpuDevices=[{"uuid": UUIDS[i], "nodeName": "fixture-node", "nodeUid": "fixture-uid"} for i in cards], memoryRequiredMi=16400)
        return model

    def test_group_slots_memory_stop_restart_and_edit_credit_are_per_card(self):
        for count in (2, 4):
            self.models = [self.group(range(count))]; self.pods = []
            self.assertEqual([d["used"] for d in self.summary()["devices"]], [1]*count + [0]*(4-count))
            pod = self.pod(); pod["spec"]["resourceClaims"] = [{"name": f"gpu-{i}", "resourceClaimName": f"fixture-claim-{i}"} for i in range(count)]
            self.pods = [pod]
            self.assertEqual([d["used"] for d in self.summary()["devices"]], [1]*count + [0]*(4-count))
            self.assertEqual([d["used"] for d in self.summary("fixture-model")["devices"]], [0]*4)
            memory = self.api["active_model_memory_reservations"](self.models)
            self.assertEqual(len(memory["cpu"]), 1)
            self.assertEqual(memory["cpu"][0]["reservedMi"], 16400)
            self.assertEqual(memory["cpu"][0]["node"], "fixture-node")
            devices = [{"computeTarget": "nvidia-gpu", "nodes": ["fixture-node"], "totalMi": 49152,
                "gpuDevice": {"uuid": u, "nodeName": "fixture-node", "nodeUid": "fixture-uid"}} for u in UUIDS]
            self.assertEqual([d["reservedMi"] for d in self.api["assign_gpu_reservations"](devices, memory)], [10000]*count + [0]*(4-count))
            self.models[0]["spec"]["enabled"] = False
            self.assertEqual(self.summary()["used"], count)
            self.pods = []; self.assertEqual(self.summary()["used"], 0)
            self.models[0]["spec"]["enabled"] = True; self.assertEqual(self.summary()["used"], count)

    def test_full_group_waits_without_reserving_free_sibling_cards(self):
        self.state["mode"] = "exclusive"
        self.models = [self.group()]; pod = self.pod(); pod["spec"]["resourceClaims"][0]["resourceClaimName"] = "fixture-claim-1"
        pod["metadata"]["labels"] = {}; self.pods = [pod]
        self.assertEqual([d["used"] for d in self.summary()["devices"]], [0, 1, 0, 0])
        self.assertEqual(self.summary()["queued"], 1)
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: self.state, "model_activations": lambda: self.models,
                "gpu_slot_summary": lambda *_a, **_kw: {"nvidia-gpu": self.summary()}}):
            with self.assertRaises(self.api["RequestError"]): self.api["require_gpu_slot_available"](self.group())

    def test_group_shape_fail_closed_and_single_group_edits_remain_compatible(self):
        local = self.group()["spec"]["local"]
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: self.state}):
            self.assertEqual(len(self.api["validate_nvidia_gpu_selection"](local)), 2)
            for selections in ([], [local["gpuDevices"][0]]*2, [*local["gpuDevices"], {"uuid": UUIDS[3], "nodeName": "other", "nodeUid": "other"}]):
                with self.assertRaises(ValueError): self.api["validate_nvidia_gpu_selection"]({**local, "gpuDevices": selections})
        original = self.model()
        _, edited = self.api["merged_local_model_settings"](original, {"gpuDevices": local["gpuDevices"]})
        self.assertNotIn("gpuDevice", edited)
        original["spec"]["local"] = edited
        _, reverted = self.api["merged_local_model_settings"](original, {"gpuDevice": local["gpuDevices"][0]})
        self.assertNotIn("gpuDevices", reverted)

    def test_multi_gpu_estimator_preserves_full_kv_cache_per_card_and_checks_dimensions(self):
        capability = {"computeTargets": ["nvidia-gpu"], "maxDevices": 16, "strategies": ["auto", "tensor", "pipeline"]}
        local = {**self.group()["spec"]["local"], "url": "hf://fixture/small"}
        config = {"num_attention_heads": 8, "hidden_size": 1024, "num_hidden_layers": 9}
        with patch.dict(self.api, {"compute_target_catalog": lambda: {"engines": {"VLLM": {"multiGpu": capability}}},
                "hf_metadata": lambda *_: {"config": config}}):
            estimate = self.api["multi_gpu_estimate"](local, {"weightsMi": 10000, "kvCacheMi": 1000, "runtimeReserveMi": 512})
            self.assertEqual(estimate["weightsMi"], 5500)
            self.assertEqual(estimate["kvCacheMi"], 1000)
            self.assertEqual(estimate["gpuParallelism"], "tensor")
            config["num_attention_heads"] = 7
            estimate = self.api["multi_gpu_estimate"](local, {"weightsMi": 10000})
            self.assertEqual(estimate["gpuParallelism"], "pipeline")
            self.assertGreater(estimate["weightsMi"], 5500)
            with self.assertRaises(ValueError): self.api["multi_gpu_estimate"]({**local, "vllm": {"parallelism": "tensor"}}, {})

    def test_group_creation_persists_budgets_and_never_overrides_physical_limits(self):
        catalog = {"targets": {"nvidia-gpu": {"kind": "gpu"}}}
        estimate = {"minimumMi": 2000, "maximumMi": 20000, "devices": [{"totalMi": 49152}]*2}
        with patch.dict(self.api, {"gpu_sharing_status": lambda _: self.state, "compute_target_catalog": lambda: catalog,
                "estimate_model_memory": lambda *_: estimate, "offloading_host_memory_available": lambda *_: 24000}):
            for engine in ("VLLM", "OLlama"):
                local = {**self.group()["spec"]["local"], "engine": engine,
                    "url": "hf://fixture/small" if engine == "VLLM" else "ollama://fixture:small"}
                resource = self.api["model_activation_payload"]("local", {"name": "fixture-model", "local": local})
                self.assertEqual(resource["spec"]["local"]["gpuDevices"], local["gpuDevices"])
                self.assertEqual(resource["spec"]["local"]["memoryRequiredMi"], 16400)
                self.assertEqual(resource["spec"]["local"]["vramMi"], 10000)
                for bad in ({"vramMi": 49200, "allowMemoryRisk": True}, {"memoryRequiredMi": 24100, "allowMemoryRisk": True},
                            {"memoryRequiredMi": 0}, {"vramMi": 21000}, {"vramMi": 100}):
                    with self.subTest(engine=engine, bad=bad), self.assertRaises(ValueError):
                        self.api["model_activation_payload"]("local", {"name": "fixture-model", "local": {**local, **bad}})

    def test_group_requires_verified_matching_product_and_memory(self):
        for field, value in (("productName", None), ("productName", "NVIDIA GPU"), ("productName", "Other GPU"), ("totalMi", None), ("totalMi", 24000)):
            state = copy.deepcopy(self.state); state["devices"][1][field] = value
            with patch.dict(self.api, {"gpu_sharing_status": lambda _: state}), self.assertRaises(ValueError):
                self.api["validate_nvidia_gpu_selection"](self.group()["spec"]["local"])

    def setUp(self):
        self.api = load_server()
        self.node = {"metadata": {"name": "fixture-node", "uid": "fixture-uid", "labels": {"appliance.magicstick.dev/nvidia-dra-ready": "true"}},
                     "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
        self.state = {"provider": "nvidia", "backend": "dra", "mode": "shared", "phase": "Ready",
            "nodeName": "fixture-node", "nodeUid": "fixture-uid", "maxModels": 4,
            "devices": [{"uuid": u, "name": "gpu-" + str(i), "pool": "fixture-node", "node": "fixture-node",
                         "nodeUid": "fixture-uid", "claimName": "fixture-claim-" + str(i), "productName": "NVIDIA RTX A6000", "totalMi": 49152} for i, u in enumerate(UUIDS)]}
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
