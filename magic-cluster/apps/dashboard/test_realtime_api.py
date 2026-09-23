import copy
import io
import json
import pathlib
import unittest
from unittest.mock import Mock, patch

import yaml
from test_dashboard_api import load_server

ROOT = pathlib.Path(__file__).resolve().parents[2]


def local_model():
    return {"engine": "VLLM", "computeTarget": "nvidia-gpu",
            "url": "hf://Qwen/Qwen3-Omni-30B-A3B-Instruct",
            "realtime": {"profile": "qwen3-omni", "gpuNode": "example-node", "gpuCount": 2}}


def gpu_node():
    return {"metadata": {"name": "example-node", "uid": "example-uid", "labels": {
        "kubernetes.io/os": "linux", "nvidia.com/gpu.count": "2", "nvidia.com/gpu.compute.major": "9"}},
        "status": {"nodeInfo": {"architecture": "amd64"}, "conditions": [{"type": "Ready", "status": "True"}],
                   "allocatable": {"memory": "128Gi", "nvidia.com/gpu": "2"}}}


def omni_config():
    return {"model_type": "qwen3_omni_moe", "architectures": ["Qwen3OmniMoeForConditionalGeneration"],
            "enable_audio_output": True, "thinker_config": {"model_type": "qwen3_omni_moe_thinker"},
            "talker_config": {"model_type": "qwen3_omni_moe_talker"}, "code2wav_config": {"hidden_size": 1024}}


class RealtimeApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()
        cls.catalog = json.loads(yaml.safe_load((ROOT / "platform/magicstick-operator/compute-target-catalog.yaml").read_text())["data"]["targets.json"])

    def setUp(self):
        self.api["HF_DISCOVERY_CACHE"].clear()

    def discovery_query(self, **values):
        return {key: [value] for key, value in {"provider": "huggingface", "engine": "VLLM",
                "computeTarget": "nvidia-gpu", "modelType": "chat", "realtimeProfile": "qwen3-omni", **values}.items()}

    def test_hub_search_uses_omni_context_without_architecture_filter(self):
        upstream = Mock(return_value=[
            {"id": "example/omni", "config": {"architectures": ["Qwen3OmniMoeForConditionalGeneration"]}, "pipeline_tag": "any-to-any"},
            {"id": "example/text-only", "config": {"architectures": ["LlamaForCausalLM"]}},
        ])
        with self.setup_context(), patch.dict(self.api, {"hf_search_models": upstream}):
            response = self.api["model_discovery_search"](self.discovery_query(q="omni"))
        self.assertEqual(upstream.call_args.kwargs["engine"], "vllm-omni")
        items = {item["repo"]: item for item in response["results"]}
        self.assertEqual(items["example/omni"]["compatibility"], "experimental")
        self.assertEqual(items["example/text-only"]["compatibility"], "experimental")
        self.assertNotIn("apps=vllm", self.api["hf_discovery_search_url"](search="omni", engine="vllm-omni"))
        self.assertIn("apps=vllm", self.api["hf_discovery_search_url"](search="omni", engine="vllm"))

    def test_direct_creation_never_fetches_model_config_and_roundtrips(self):
        with self.setup_context(), patch.dict(self.api, {
                "fetch_hf_discovery_json": Mock(side_effect=AssertionError("must not fetch"))}), \
                patch.object(self.api["urllib"].request, "urlopen", side_effect=AssertionError("must not fetch")):
            for reference in ("hf://example/omni-AWQ", "example/omni-AWQ", "https://huggingface.co/example/omni-AWQ/"):
                local = {**local_model(), "url": reference}
                created = self.api["model_activation_payload"]("local", {"name": "omni", "local": local})
                persisted = created["spec"]["local"]
                self.assertEqual(persisted["url"], "hf://example/omni-AWQ")
                self.assertEqual(self.api["validate_realtime_local"](persisted), persisted)

    def test_quantization_architecture_and_completeness_do_not_disable_discovery(self):
        for config in ({"model_type": "qwen3"}, {"architectures": ["LlamaForCausalLM"]},
                       {"talker_config": {}}, {"enable_audio_output": False},
                       {"thinker_config": {"quantization_config": {"quant_method": "fp8"}}}):
            with self.subTest(config=config), self.setup_context(), patch.dict(self.api, {
                    "fetch_hf_discovery_json": lambda *_: {"id": "example/omni", "config": config}}), \
                    patch.object(self.api["urllib"].request, "urlopen", side_effect=AssertionError("must not fetch config")):
                selected = self.api["model_discovery_artifacts"](self.discovery_query(repo="example/omni"))
                self.assertEqual(selected["artifacts"][0]["compatibility"], "experimental")
                self.api["validate_realtime_local"]({**local_model(), "url": "hf://example/omni"})

    def test_missing_or_gated_metadata_does_not_block_direct_deployment(self):
        with self.setup_context(), patch.dict(self.api, {
                "fetch_hf_discovery_json": Mock(side_effect=OSError("offline"))}):
            self.api["validate_realtime_local"]({**local_model(), "url": "hf://example/private-or-unknown"})
            self.api["validate_realtime_local"](local_model())
        with self.setup_context(), patch.dict(self.api, {
                "fetch_hf_discovery_json": lambda *_: {"id": "example/omni", "gated": True}}):
            result = self.api["model_discovery_artifacts"](self.discovery_query(repo="example/omni"))
            self.assertEqual(result["artifacts"][0]["compatibility"], "experimental")

    def test_all_catalog_backends_are_selectable_without_hardware_profile(self):
        node = gpu_node()
        node["metadata"]["labels"] = {"kubernetes.io/os": "linux"}
        node["status"]["allocatable"].update({"amd.com/gpu": "2", "gpu.intel.com/xe": "1"})
        with self.setup_context(), patch.dict(self.api, {"gpu_host_preflight": lambda _: {}}):
            devices = self.api["realtime_device_options"](self.catalog, [node])
        self.assertEqual({item["computeTarget"] for item in devices}, {"cpu", "nvidia-gpu", "amd-gpu", "intel-gpu"})
        self.assertTrue(all(item["supported"] for item in devices))
        self.assertEqual(next(item for item in devices if item["computeTarget"] == "amd-gpu")["maxGpuCount"], 2)

    def test_experimental_slots_ignore_engine_inventory_labels_but_count_other_models(self):
        node = gpu_node()
        node["metadata"]["labels"] = {"kubernetes.io/os": "linux"}
        node["status"]["allocatable"] = {"memory": "128Gi", "amd.com/gpu": "2"}
        local = {**local_model(), "computeTarget": "amd-gpu"}
        local["realtime"].update(profile="qwen3-omni-rocm", gpuCount=1)
        activation = {"metadata": {"name": "test"}, "spec": {"type": "local", "local": local}}
        slots = self.api["gpu_slot_summary"]([activation], nodes=[node], catalog=self.catalog, pods=[], sharing={}, experimental=True)
        self.assertEqual(slots["amd-gpu"]["free"], 1)
        self.assertEqual(slots["amd-gpu"]["used"], 1)
        with patch.dict(self.api, {"model_activations": lambda: [], "gpu_slot_summary": lambda *a, **kw: slots}):
            self.api["require_gpu_slot_available"](activation)
        ordinary = self.api["gpu_slot_summary"]([], nodes=[node], catalog=self.catalog, pods=[], sharing={})
        self.assertEqual(ordinary["amd-gpu"]["free"], 0)  # unchanged ordinary engine policy

    def test_invalid_profiles_and_non_hub_urls_fail_before_fetch(self):
        with self.setup_context(), patch.dict(self.api, {"fetch_hf_discovery_json": Mock(side_effect=AssertionError("must not fetch"))}):
            for values in ({"realtimeProfile": "missing"}, {"engine": "OLlama"}, {"computeTarget": "cpu"}):
                with self.assertRaises(self.api["RequestError"]):
                    self.api["model_discovery_search"](self.discovery_query(q="omni", **values))
            for url in ("https://example.com/omni", "file:///tmp/model", "hf://../private", "hf://example/model?revision=x"):
                with self.assertRaises(ValueError):
                    self.api["validate_realtime_local"]({**local_model(), "url": url})

    def setup_context(self):
        return patch.dict(self.api, {"compute_target_catalog": lambda: self.catalog,
                                    "ready_schedulable_nodes": lambda: [gpu_node()],
                                    "gpu_host_preflight": lambda _: {"displayDevices": [
                                        {"vendorId": "10de", "driverVersion": "580.100"},
                                        {"vendorId": "10de", "driverVersion": "580.100"}]}})

    def test_create_and_reload_keep_typed_defaults_without_legacy_memory(self):
        with self.setup_context():
            resource = self.api["model_activation_payload"]("local", {"name": "qwen-realtime", "local": local_model()})
            reloaded = self.api["model_activation_payload"]("local", {"name": "qwen-realtime", "local": resource["spec"]["local"]})
        self.assertEqual(resource["spec"]["local"], reloaded["spec"]["local"])
        config = reloaded["spec"]["local"]
        self.assertEqual(config["contextWindow"], 8192)
        self.assertEqual(config["realtime"]["systemMemoryMi"], 16384)
        self.assertNotIn("kvCacheType", config)
        self.assertNotIn("cpuOffloading", config)

    def test_time_slicing_is_selectable_without_treating_slots_as_physical_gpus(self):
        node = gpu_node()
        node["metadata"]["labels"]["nvidia.com/gpu.replicas"] = "2"
        node["status"]["allocatable"]["nvidia.com/gpu"] = "4"
        with self.setup_context(), patch.dict(self.api, {"ready_schedulable_nodes": lambda: [node]}):
            devices = self.api["realtime_device_options"](self.catalog, [node])
            self.assertTrue(devices[0]["supported"], devices[0]["reason"])
            self.assertEqual(devices[0]["allocationMode"], "time-slicing")
            self.assertEqual(devices[0]["gpuCount"], 2)
            self.assertEqual(devices[0]["maxGpuCount"], 1)
            self.assertEqual(devices[0]["slotCount"], 4)
            local = local_model()
            with self.assertRaisesRegex(ValueError, "one GPU slot"):
                self.api["validate_realtime_local"](local)
            local["realtime"]["gpuCount"] = 1
            self.api["validate_realtime_local"](local)

    def test_shared_realtime_requires_a_free_slot_for_both_providers(self):
        for target, mode in (("nvidia-gpu", "time-slicing"), ("amd-gpu", "dra-shared")):
            local = local_model()
            local["computeTarget"] = target
            local["realtime"]["gpuCount"] = 1
            resource = {"metadata": {"name": "omni"}, "spec": {"type": "local", "local": local}}
            slot = {"node": "example-node", "mode": mode, "free": 3}
            with self.subTest(target=target), patch.dict(self.api, {"model_activations": lambda: [],
                    "gpu_slot_summary": lambda *args, **kwargs: {target: {"free": 3, "nodes": [slot]}}}):
                self.api["require_gpu_slot_available"](resource)
                local["realtime"]["gpuCount"] = 2
                with self.assertRaisesRegex(self.api["RequestError"], "one GPU slot"):
                    self.api["require_gpu_slot_available"](resource)
                local["realtime"]["gpuCount"] = 1
                slot["free"] = 0
                with self.assertRaisesRegex(self.api["RequestError"], "free GPU slots"):
                    self.api["require_gpu_slot_available"](resource)

    def test_catalogs_without_rocm_do_not_read_amd_runtime_configuration(self):
        node = gpu_node()
        node["metadata"]["labels"]["appliance.magicstick.dev/amd-dra-ready"] = "true"
        cuda_only = copy.deepcopy(self.catalog)
        cuda_only["engines"]["VLLM"]["realtimeProfiles"].pop("qwen3-omni-rocm")
        with self.setup_context(), patch.dict(self.api, {"gpu_sharing_status": Mock(side_effect=AssertionError("must not fetch AMD sharing"))}):
            self.assertEqual(self.api["realtime_device_options"]({}, [node]), [])
            self.assertTrue(self.api["realtime_device_options"](cuda_only, [node])[0]["supported"])

    def test_memory_limits_and_unsupported_engine_cannot_bypass_ui(self):
        for fields in ({"engine": "OLlama"}, {"kvCacheType": "fp8"}, {"vram": "1Gi"}):
            with self.setup_context(), self.assertRaises(ValueError):
                self.api["model_activation_payload"]("local", {"name": "qwen-realtime", "local": {**local_model(), **fields}})
        local = local_model()
        local["realtime"]["systemMemoryMi"] = 999999
        with self.setup_context(), self.assertRaisesRegex(ValueError, "allocatable RAM"):
            self.api["validate_realtime_local"](local)

    def test_two_gpus_reserved_before_pod_exists_and_not_double_counted(self):
        item = {"metadata": {"name": "qwen-realtime"}, "spec": {"type": "local", "targetNamespace": "ai", "local": local_model()}}
        pod = {"metadata": {"namespace": "ai", "labels": {
            "appliance.magicstick.dev/modelactivation": "qwen-realtime",
            "appliance.magicstick.dev/compute-target": "nvidia-gpu",
            "app.kubernetes.io/managed-by": "magicstick-operator", "appliance.magicstick.dev/runtime-backend": "vllm-omni"}},
            "spec": {"nodeName": "example-node", "containers": [{"resources": {"limits": {"nvidia.com/gpu": "2"}}}]}}
        for pods in ([], [pod]):
            with self.setup_context():
                slots = self.api["gpu_slot_summary"]([item], nodes=[gpu_node()], catalog=self.catalog, pods=pods, sharing={})
            self.assertEqual(slots["nvidia-gpu"]["used"], 2)
            self.assertEqual(slots["nvidia-gpu"]["free"], 0)
            self.assertEqual(slots["nvidia-gpu"]["queued"], 0)

    def test_start_stop_restart_keep_configuration_and_use_existing_revision_guard(self):
        item = {"metadata": {"name": "qwen-realtime", "resourceVersion": "7"},
                "spec": {"type": "local", "targetNamespace": "ai", "enabled": False, "local": local_model()}}
        for action in ("start", "stop", "restart"):
            writes = []
            with self.setup_context(), patch.dict(self.api, {
                "model_activation": lambda _: copy.deepcopy(item),
                "require_gpu_slot_available": lambda _: None,
                "request_json": lambda *args: writes.append(args) or args[2],
            }):
                self.api["model_lifecycle_action"]("qwen-realtime", action, {"expectedRevision": "7"})
            patch_body = writes[0][2]
            self.assertEqual(patch_body["spec"]["enabled"], action != "stop")
            if action == "restart":
                self.assertIn("restartNonce", patch_body["spec"]["local"]["realtime"])
                self.assertNotIn("freetoken", patch_body["spec"]["local"])

    def test_logs_accept_owned_realtime_pod_but_not_other_workloads(self):
        labels = {"app": "model", "model": "qwen-realtime", "app.kubernetes.io/managed-by": "magicstick-operator",
                  "appliance.magicstick.dev/modelactivation": "qwen-realtime", "appliance.magicstick.dev/runtime-backend": "vllm-omni"}
        self.assertTrue(self.api["owned_model_runtime_pod"]({"metadata": {"labels": labels}}, "qwen-realtime"))
        self.assertFalse(self.api["owned_model_runtime_pod"]({"metadata": {"labels": labels}}, "another-model"))

    def test_editor_cannot_switch_ordinary_model_to_realtime_or_remove_profile(self):
        for current, changes in (({}, {"realtime": local_model()["realtime"]}), (local_model(), {"realtime": None})):
            with self.assertRaises(self.api["RequestError"]):
                self.api["merged_local_model_settings"]({"spec": {"local": current}}, changes)

    def test_rocm_uses_shared_capacity_and_roundtrips_its_own_profile(self):
        catalog = copy.deepcopy(self.catalog)
        profile = catalog["engines"]["VLLM"]["realtimeProfiles"]["qwen3-omni-rocm"]
        profile["image"] = "example.local/omni-rocm@sha256:" + "a" * 64
        node = gpu_node()
        node["metadata"]["labels"]["appliance.magicstick.dev/amd-gpu-eligible"] = "true"
        node["status"]["allocatable"]["amd.com/gpu"] = "1"
        host = {"profileId": "strix-halo", "detectedArchitecture": "gfx1151", "hostDriverReady": True,
                "memoryArchitecture": "unified", "gpuAllocationMode": "shared-gtt",
                "gpuCapacitySource": "kfd-topology", "gpuCapacityMi": 102400, "gpuAccessibleMi": 102400,
                "firmwareReservedMi": 512,
                "displayDevices": [{"vendorId": "1002", "architecture": "gfx1151", "memoryTotalMi": 512}]}
        local = local_model()
        local["computeTarget"] = "amd-gpu"
        local["realtime"].update(profile="qwen3-omni-rocm", gpuCount=1)
        with patch.dict(self.api, {"compute_target_catalog": lambda: catalog,
                                  "ready_schedulable_nodes": lambda: [node], "gpu_host_preflight": lambda _: host}):
            devices = self.api["realtime_device_options"](catalog, [node])
            amd = next(item for item in devices if item["computeTarget"] == "amd-gpu")
            self.assertTrue(amd["supported"], amd["reason"])
            self.assertEqual(amd["gpuMemoryMi"], 102400)
            self.assertEqual(amd["gpuAllocationMode"], "shared-gtt")
            resource = self.api["model_activation_payload"]("local", {"name": "omni-rocm", "local": local})
            reloaded = self.api["model_activation_payload"]("local", {"name": "omni-rocm", "local": resource["spec"]["local"]})
            self.assertEqual(resource["spec"]["local"], reloaded["spec"]["local"])
            self.assertEqual(reloaded["spec"]["local"]["realtime"]["systemMemoryMi"], 16384)
            local["realtime"]["systemMemoryMi"] = 98304
            self.api["validate_realtime_local"](local)
            profile["image"] = "example.local/omni-rocm:nightly"
            self.assertEqual(self.api["realtime_node_error"](node, profile), "")
            node["metadata"]["labels"]["appliance.magicstick.dev/amd-dra-ready"] = "true"
            self.assertIn("ready AMD DRA claim", self.api["realtime_node_error"](node, profile))
            profile["image"] = "example.local/omni-rocm@sha256:" + "a" * 64
            node["status"]["allocatable"].pop("amd.com/gpu")
            sharing = {"mode": "shared", "phase": "Ready", "nodeName": "example-node", "nodeUid": "example-uid",
                       "maxModels": 4, "namespace": "ai", "claimName": "magicstick-amd-shared-test"}
            local["realtime"]["systemMemoryMi"] = 102400
            with patch.dict(self.api, {"gpu_sharing_status": lambda _: sharing}):
                devices = self.api["realtime_device_options"](catalog, [node])
                amd = next(item for item in devices if item["computeTarget"] == "amd-gpu")
                self.assertTrue(amd["supported"], amd["reason"])
                self.assertEqual((amd["allocationMode"], amd["gpuCount"], amd["slotCount"]), ("dra-shared", 1, 4))
                self.api["validate_realtime_local"](local)
                sharing["nodeUid"] = "previous-node"
                with self.assertRaisesRegex(ValueError, "ready AMD DRA claim"):
                    self.api["validate_realtime_local"](local)

    def test_rocm_reserves_system_ram_once_even_before_controller_status(self):
        local = local_model()
        local["computeTarget"] = "amd-gpu"
        local["realtime"].update(profile="qwen3-omni-rocm", gpuCount=1, systemMemoryMi=102400)
        for status in ({}, {"vramRequiredMi": 92160, "memoryRequiredMi": 102400,
                           "memoryArchitecture": "unified", "gpuAllocationMode": "shared-gtt"}):
            item = {"metadata": {"name": "omni-rocm"}, "spec": {"type": "local", "local": local}, "status": status}
            reservations = self.api["active_model_memory_reservations"]([item])
            self.assertEqual(reservations.get("cpu", []), [])
            self.assertEqual(len(reservations["amd-gpu"]), 1)
            self.assertEqual(reservations["amd-gpu"][0]["hostBaselineMi"], 102400)
            self.assertEqual(reservations["amd-gpu"][0]["memoryArchitecture"], "unified")
            with patch.dict(self.api, {"ready_schedulable_nodes": lambda: [gpu_node()],
                                      "compute_target_catalog": lambda: {}, "node_memory_samples": lambda _: {},
                                      "gpu_resource_placeholders": lambda *_: [], "unified_memory_pools": lambda *_: []}):
                memory = self.api["compute_memory_summary"]([item], {})
            self.assertEqual(memory["devices"][0]["reservedMi"], 102400)


if __name__ == "__main__":
    unittest.main()
