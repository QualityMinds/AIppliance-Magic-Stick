"""Realtime profile contracts, without downloading a model or requiring a GPU."""
import ast
import copy
import hashlib
import json
import pathlib
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import Mock, patch

import yaml

from test_controller import CLUSTER_ROOT, ROOT, load_controller
from test_freetoken_runtime import nvidia_node


def activation():
    return {"metadata": {"name": "qwen-realtime", "namespace": "ai-system", "generation": 1},
            "spec": {"type": "local", "enabled": True, "targetNamespace": "ai", "local": {
                "engine": "VLLM", "computeTarget": "nvidia-gpu", "modelType": "chat",
                "url": "hf://Qwen/Qwen3-Omni-30B-A3B-Instruct", "contextWindow": 8192, "maxNumSeqs": 1,
                "realtime": {"profile": "qwen3-omni", "gpuNode": "nvidia-node", "gpuCount": 1,
                             "systemMemoryMi": 16384, "gpuMemoryFraction": 0.9, "thinkerCpuOffloadGiB": 0}}}}


def amd_node():
    return {"metadata": {"name": "amd-node", "uid": "amd-node-uid", "labels": {
        "kubernetes.io/os": "linux", "appliance.magicstick.dev/amd-gpu-eligible": "true"}},
        "status": {"nodeInfo": {"architecture": "amd64"}, "conditions": [{"type": "Ready", "status": "True"}],
                   "allocatable": {"memory": "120Gi", "amd.com/gpu": "1"}},
        "_freetoken_host": {"profileId": "strix-halo", "detectedArchitecture": "gfx1151", "hostDriverReady": True,
                            "memoryArchitecture": "unified", "gpuAllocationMode": "shared-gtt",
                            "gpuCapacitySource": "kfd-topology", "gpuCapacityMi": 102400,
                            "gpuAccessibleMi": 102400, "firmwareReservedMi": 512,
                            "displayDevices": [{"vendorId": "1002", "architecture": "gfx1151", "memoryTotalMi": 512}]}}


def amd_activation():
    item = activation()
    item["spec"]["local"]["computeTarget"] = "amd-gpu"
    item["spec"]["local"]["realtime"].update(profile="qwen3-omni-rocm", gpuNode="amd-node", systemMemoryMi=102400)
    return item


class RealtimeRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = load_controller()
        cls.catalog = json.loads(yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        cls.modules = json.loads(yaml.safe_load((ROOT / "module-catalog.yaml").read_text())["data"]["modules.json"])

    def resource(self, item=None, node=None, catalog=None):
        node = node or nvidia_node(gpu_count="2")
        with patch.dict(self.c, {"compute_target_nodes": lambda *_: [node],
                                "gpu_host_preflight": lambda value: value["_freetoken_host"]}):
            return self.c["realtime_runtime_resources"](item or activation(), catalog or self.catalog)

    def test_immutable_image_and_explicit_cuda_device_binding(self):
        deployment, service, runtime = self.resource()
        pod = deployment["spec"]["template"]["spec"]
        container = pod["containers"][0]
        self.assertIn("@sha256:", container["image"])
        self.assertEqual(pod["runtimeClassName"], "nvidia")
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(container["resources"]["limits"]["nvidia.com/gpu"], "1")
        self.assertEqual(pod["nodeSelector"]["kubernetes.io/hostname"], "nvidia-node")
        self.assertEqual(deployment["spec"]["strategy"]["type"], "Recreate")
        self.assertGreater(deployment["spec"]["progressDeadlineSeconds"], 10800)
        self.assertEqual(service["spec"]["selector"], deployment["spec"]["selector"]["matchLabels"])
        self.assertTrue(runtime["runtimeEndpoint"].endswith(".ai.svc.cluster.local:8000/v1"))
        self.assertEqual(container["command"], ["python3", "/etc/magicstick-realtime/bootstrap.py"])
        bootstrap = runtime["configuration"]["data"]["bootstrap.py"]
        ast.parse(bootstrap)
        self.assertIn('"--omni"', bootstrap)
        self.assertNotIn("vllm.entrypoints.openai.api_server", bootstrap)
        self.assertNotIn("MAGICSTICK_VLLM_WRAPPER_ENABLED", json.dumps(container))

    def test_stage_budgets_do_not_overreserve_a_single_gpu(self):
        for count in (1, 2):
            item = activation()
            item["spec"]["local"]["realtime"]["gpuCount"] = count
            deployment, _, runtime = self.resource(item)
            config = json.loads(runtime["configuration"]["data"]["profile.json"])
            self.assertEqual(config["session_mode"], "duplex")
            self.assertEqual(config["base_config"], "qwen3_omni_duplex.yaml")
            totals = {}
            for stage in config["stages"]:
                totals[stage["devices"]] = totals.get(stage["devices"], 0) + stage["gpu_memory_utilization"]
            self.assertEqual(len(totals), count)
            for amount in totals.values():
                self.assertLessEqual(amount, .900001)
            self.assertEqual(deployment["spec"]["template"]["spec"]["containers"][0]["resources"]["requests"]["nvidia.com/gpu"], str(count))

    def test_arbitrary_checkpoint_reaches_runtime_without_model_policy(self):
        for repo in ("example/omni-AWQ-4bit", "example/text-only", "example/unknown-architecture"):
            item = activation()
            item["spec"]["local"]["url"] = "hf://" + repo
            deployment, _, runtime = self.resource(item)
            env = {entry["name"]: entry["value"] for entry in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
            self.assertEqual(env["MODEL_ID"], repo)
            self.assertNotIn("model-policy.json", runtime["configuration"]["data"])

    def test_bootstrap_does_not_download_or_validate_model_metadata(self):
        source = self.c["realtime_bootstrap_source"]()
        ast.parse(source)
        for removed in ("validate_model_reference", "realtime_model_config_error", "hf_hub_download", "model-policy.json"):
            self.assertNotIn(removed, source)

    def test_catalog_contains_backends_without_hardware_or_model_allowlists(self):
        profiles = self.catalog["engines"]["VLLM"]["realtimeProfiles"]
        self.assertEqual({p["backend"] for p in profiles.values()}, {"cuda", "rocm", "xpu", "cpu"})
        for profile in profiles.values():
            for removed in ("modelCompatibility", "gpuArchitectures", "hardwareProfile", "minimumComputeMajor", "minimumDriverMajor"):
                self.assertNotIn(removed, profile)

    def test_valid_offloading_maps_only_to_thinker_and_reserves_host_ram(self):
        item = activation()
        item["spec"]["local"]["realtime"].update(thinkerCpuOffloadGiB=12, systemMemoryMi=24576)
        deployment, _, runtime = self.resource(item)
        config = json.loads(runtime["configuration"]["data"]["profile.json"])
        self.assertEqual(config["stages"][0]["engine_extras"], {"cpu_offload_gb": 12})
        self.assertNotIn("engine_extras", config["stages"][1])
        self.assertEqual(deployment["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["memory"], "24576Mi")

    def test_zero_offloading_leaves_upstream_source_and_config_unchanged(self):
        _, _, runtime = self.resource()
        config = json.loads(runtime["configuration"]["data"]["profile.json"])
        self.assertTrue(all("engine_extras" not in stage for stage in config["stages"]))
        source = runtime["configuration"]["data"]["bootstrap.py"]
        ns = {"__name__": "bootstrap_test"}
        exec(compile(source, "bootstrap.py", "exec"), ns)
        patcher = Mock()
        with patch.dict(ns, {"ensure_cpu_offload_projection": patcher, "validate_model_reference": Mock()}), \
                patch.object(ns["importlib"].util, "find_spec", return_value=Mock(origin="/pkg/vllm_omni/__init__.py")), \
                patch.object(pathlib.Path, "read_text", return_value=json.dumps(config)), \
                patch.object(pathlib.Path, "write_text"), patch.object(ns["os"], "execvp") as launch, \
                patch.dict(ns["os"].environ, {"MODEL_ID": "example/model", "SERVED_MODEL_NAME": "example"}):
            ns["main"]()
        patcher.assert_not_called()
        self.assertIn("--omni", launch.call_args[0][1])

    def test_offload_shim_checks_source_hash_and_is_idempotent(self):
        ns = {"__name__": "bootstrap_test"}
        exec(compile(self.c["realtime_bootstrap_source"](), "bootstrap.py", "exec"), ns)
        self.assertEqual(ns["ORIGINAL_CONFIG_SHA256"], "cfc1ab70e1405979f5346b1adf1e27eb1cc1fcf9d34bc6f139971391e54188c7")
        # Small syntactically valid source fixture. The real image/parser is a
        # separate runtime smoke test, not simulated by this guard unit test.
        fixture = ns["REPLACEMENTS"][0][0] + "    pass\n\nclass OmniStageLoadConfig:\n" + ns["REPLACEMENTS"][1][0] + "    pass\n"
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "config" / "omni_config.py"
            path.parent.mkdir()
            path.write_text(fixture)
            with self.assertRaisesRegex(RuntimeError, "reviewed, pinned"):
                ns["ensure_cpu_offload_projection"](root)
            self.assertEqual(path.read_text(), fixture)
            ns["ORIGINAL_CONFIG_SHA256"] = hashlib.sha256(fixture.encode()).hexdigest()
            ns["ensure_cpu_offload_projection"](root)
            updated = path.read_text()
            self.assertIn("cpu_offload_gb: float = Field(default=0.0, ge=0.0, allow_inf_nan=False)", updated)
            ns["ensure_cpu_offload_projection"](root)
            self.assertEqual(path.read_text(), updated)
            path.write_text(updated + "# unexpected upstream change\n")
            with self.assertRaisesRegex(RuntimeError, "source has changed"):
                ns["ensure_cpu_offload_projection"](root)

    def test_offload_shim_rejects_ambiguous_anchors_without_writing(self):
        ns = {"__name__": "bootstrap_test"}
        exec(compile(self.c["realtime_bootstrap_source"](), "bootstrap.py", "exec"), ns)
        fixture = ns["REPLACEMENTS"][0][0] * 2
        ns["ORIGINAL_CONFIG_SHA256"] = hashlib.sha256(fixture.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "config" / "omni_config.py"
            path.parent.mkdir()
            path.write_text(fixture)
            with self.assertRaisesRegex(RuntimeError, "ambiguous"):
                ns["ensure_cpu_offload_projection"](root)
            self.assertEqual(path.read_text(), fixture)

    def test_strict_validation_rejects_legacy_knobs_and_unsupported_combinations(self):
        for change in ({"engine": "OLlama"}, {"engine": "FreeToken"}, {"computeTarget": "amd-gpu"},
                       {"url": "file:///tmp/model"}, {"kvCacheType": "auto"}, {"vllm": {"visionAttention": "triton"}},
                       {"cpuOffloading": True}, {"maxNumSeqs": 0}, {"contextWindow": 0}, {"maxReplicas": 2},
                       {"maxOutputTokens": 1024}):
            item = activation()
            item["spec"]["local"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.resource(item)
        for change in ({"gpuCount": True}, {"gpuCount": 3}, {"gpuNode": "missing"}, {"systemMemoryMi": 999999},
                       {"gpuMemoryFraction": 1.01}, {"gpuMemoryFraction": float("nan")}, {"thinkerCpuOffloadGiB": -1},
                       {"unexpected": "argument"}):
            item = activation()
            item["spec"]["local"]["realtime"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.resource(item)

    def test_runtime_not_magicstick_decides_chip_driver_and_inventory_compatibility(self):
        for node in (nvidia_node(driver="570.0"), nvidia_node(compute_major="7"),
                     nvidia_node(extra_labels={"nvidia.com/gpu.product": "NVIDIA-MIG-1g"}), nvidia_node()):
            node["_freetoken_host"] = {}
            deployment, _, _ = self.resource(node=node)
            self.assertEqual(deployment["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["nvidia.com/gpu"], "1")
        node = nvidia_node()
        node["metadata"]["labels"] = {"kubernetes.io/os": "linux"}
        self.resource(node=node)  # no NFD GPU inventory required
        for change in ({"nvidia.com/gpu": "0"}, {"nvidia.com/gpu": None}):
            node["status"]["allocatable"].update(change)
            with self.assertRaisesRegex(ValueError, "No allocatable"):
                self.resource(node=node)

    def test_time_slicing_uses_one_slot_not_multiple_physical_gpus(self):
        node = nvidia_node(replicas="4")
        node["status"]["allocatable"]["nvidia.com/gpu"] = "4"
        deployment, _, runtime = self.resource(node=node)
        pod = deployment["spec"]["template"]["spec"]
        self.assertEqual(pod["runtimeClassName"], "nvidia")
        self.assertEqual(pod["containers"][0]["resources"]["limits"]["nvidia.com/gpu"], "1")
        self.assertNotIn("resourceClaims", pod)
        self.assertEqual(runtime["gpuSharing"], {"mode": "time-slicing", "node": "nvidia-node",
                                               "slotCount": 1, "memoryIsolation": False})
        item = activation()
        item["spec"]["local"]["realtime"]["gpuCount"] = 2
        with self.assertRaisesRegex(ValueError, "one GPU slot"):
            self.resource(item, node)

    def sharing_state(self, provider="amd"):
        return {"managed": True, "phase": "Ready", "namespace": "ai", "maxModels": 4,
                "nodeName": provider + "-node", "nodeUid": provider + "-node-uid",
                "mode": "dra-shared" if provider == "amd" else "time-slicing",
                "claimName": "magicstick-amd-shared-test", "device": {"pciAddress": "0000:66:00.0"},
                "admittedModels": ["qwen-realtime"]}

    def test_managed_nvidia_sharing_requires_current_node_and_available_slot(self):
        node = nvidia_node(replicas="4")
        node["status"]["allocatable"]["nvidia.com/gpu"] = "4"
        state = self.sharing_state("nvidia")
        with patch.dict(self.c, {"NVIDIA_SHARING_STATE": state}):
            self.resource(node=node)
            for change in ({"nodeUid": "replaced-node"}, {"admittedModels": []},
                           {"phase": "Switching"}, {"namespace": "different"}):
                with self.subTest(change=change), patch.dict(state, change), self.assertRaises(ValueError):
                    self.resource(node=node)

    def test_tag_only_image_is_never_deployed(self):
        catalog = copy.deepcopy(self.catalog)
        catalog["engines"]["VLLM"]["realtimeProfiles"]["qwen3-omni"]["image"] = "vllm/vllm-omni:nightly"
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.resource(catalog=catalog)

    def test_realtime_does_not_provision_kubeai_or_change_ordinary_dependencies(self):
        required = self.c["model_required_modules"]
        self.assertEqual(required("local", "nvidia-gpu", "VLLM", realtime=True), ["gpu", "litellm", "model-catalog"])
        self.assertEqual(required("local", "amd-gpu", "VLLM", realtime=True), ["amd-gpu", "litellm", "model-catalog"])
        self.assertIn("kubeai", required("local", "nvidia-gpu", "VLLM"))
        self.assertIn("kubeai", required("local", "nvidia-gpu", "OLlama"))
        self.assertIn("freetoken", required("local", "nvidia-gpu", "FreeToken"))

    def rocm_catalog(self):
        catalog = copy.deepcopy(self.catalog)
        catalog["engines"]["VLLM"]["realtimeProfiles"]["qwen3-omni-rocm"]["image"] = "example.local/omni-rocm@sha256:" + "a" * 64
        return catalog

    def test_rocm_binds_only_amd_and_accounts_for_unified_memory(self):
        deployment, _, runtime = self.resource(amd_activation(), amd_node(), self.rocm_catalog())
        pod = deployment["spec"]["template"]["spec"]
        container = pod["containers"][0]
        self.assertNotIn("runtimeClassName", pod)
        self.assertEqual(container["resources"]["limits"]["amd.com/gpu"], "1")
        self.assertNotIn("nvidia.com/gpu", container["resources"]["limits"])
        self.assertIn({"name": "NVIDIA_VISIBLE_DEVICES", "value": "void"}, container["env"])
        self.assertFalse(any(mount["mountPath"].startswith("/dev/dri") for mount in container["volumeMounts"]))
        self.assertEqual(runtime["computeTarget"], "amd-gpu")
        self.assertEqual(runtime["vramMi"], 92160)
        self.assertEqual(runtime["memoryMi"], 102400)
        self.assertEqual(runtime["memoryArchitecture"], "unified")
        self.assertEqual(runtime["gpuAllocationMode"], "shared-gtt")
        self.assertEqual(runtime["sharedPoolId"], "amd-node-uid")
        stages = json.loads(runtime["configuration"]["data"]["profile.json"])["stages"]
        self.assertTrue(all(stage["enforce_eager"] for stage in stages))
        for stage in stages[:2]:
            self.assertEqual(stage["engine_extras"], {"attention_backend": "TRITON_ATTN"})
            self.assertEqual(stage["max_num_batched_tokens"], 8192)

    def test_generic_rocm_resources_do_not_require_strix_halo_inventory(self):
        node = amd_node()
        node["_freetoken_host"] = {}
        node["metadata"]["labels"] = {"kubernetes.io/os": "linux"}
        node["status"]["allocatable"]["amd.com/gpu"] = "2"
        item = amd_activation()
        item["spec"]["local"]["realtime"].update(gpuCount=2, systemMemoryMi=16384)
        deployment, _, _ = self.resource(item, node, self.rocm_catalog())
        self.assertEqual(deployment["spec"]["template"]["spec"]["containers"][0]["resources"]["limits"]["amd.com/gpu"], "2")
        node["status"]["allocatable"]["amd.com/gpu"] = "0"
        with self.assertRaisesRegex(ValueError, "No allocatable"):
            self.resource(item, node, self.rocm_catalog())

    def test_rocm_dra_binds_shared_claim_without_extended_resource_or_admission_shim(self):
        node = amd_node()
        node["metadata"]["labels"]["appliance.magicstick.dev/amd-dra-ready"] = "true"
        node["status"]["allocatable"].pop("amd.com/gpu")
        state = self.sharing_state()
        with patch.dict(self.c, {"GPU_SHARING_STATE": state}):
            deployment, _, runtime = self.resource(amd_activation(), node, self.rocm_catalog())
            for change in ({"nodeUid": "replaced-node"}, {"admittedModels": []}, {"claimName": ""},
                           {"phase": "Switching"}, {"namespace": "different"}):
                with self.subTest(change=change), patch.dict(state, change), self.assertRaises(ValueError):
                    self.resource(amd_activation(), node, self.rocm_catalog())
        pod = deployment["spec"]["template"]["spec"]
        self.assertEqual(pod["resourceClaims"], [{"name": "gpu", "resourceClaimName": state["claimName"]}])
        resources = pod["containers"][0]["resources"]
        self.assertEqual(resources["claims"], [{"name": "gpu"}])
        self.assertEqual(resources["requests"]["memory"], "102400Mi")
        for key in ("requests", "limits"):
            self.assertNotIn("amd.com/gpu", resources[key])
            self.assertNotIn("nvidia.com/gpu", resources[key])
            self.assertNotIn(self.c["DRA_SENTINEL_RESOURCE"], resources[key])
        self.assertNotIn("runtimeClassName", pod)
        self.assertEqual(runtime["gpuSharing"], {"mode": "dra-shared", "node": "amd-node", "slotCount": 1,
                                               "memoryIsolation": False, "claimName": state["claimName"],
                                               "device": "0000:66:00.0"})

    def test_memory_estimates_are_not_experiment_admission_gates(self):
        for change in ({"thinkerCpuOffloadGiB": 32}, {"systemMemoryMi": 4096}, {"gpuMemoryFraction": 1}):
            item = amd_activation()
            item["spec"]["local"]["realtime"].update(change)
            self.resource(item, amd_node(), self.rocm_catalog())
        item = activation()
        item["spec"]["local"].update(contextWindow=262144, maxNumSeqs=16)
        self.resource(item)

    def test_cpu_and_intel_use_backend_image_and_resources_without_nvidia_runtime(self):
        for backend, target, resource in (("cpu", "cpu", ""), ("xpu", "intel-gpu", "gpu.intel.com/xe"),
                                          ("xpu", "intel-gpu", "gpu.intel.com/i915")):
            node = amd_node()
            node["status"]["allocatable"] = {"memory": "120Gi", **({resource: "1"} if resource else {})}
            item = activation()
            item["spec"]["local"]["computeTarget"] = target
            item["spec"]["local"]["realtime"].update(profile="qwen3-omni-" + backend,
                gpuNode="amd-node", runtimeImage="example.local/omni-" + backend + ":test")
            deployment, _, runtime = self.resource(item, node)
            pod = deployment["spec"]["template"]["spec"]
            container = pod["containers"][0]
            self.assertNotIn("runtimeClassName", pod)
            self.assertNotIn("nvidia.com/gpu", container["resources"]["limits"])
            if resource:
                self.assertEqual(container["resources"]["limits"][resource], "1")
            else:
                self.assertEqual(set(container["resources"]["requests"]), {"cpu", "memory"})
                self.assertEqual(runtime["vramMi"], 0)
            self.assertEqual(container["image"], "example.local/omni-" + backend + ":test")
            self.assertIn({"name": "MAGICSTICK_PINNED_OFFLOAD_PATCH", "value": "false"}, container["env"])

    def test_runtime_image_override_roundtrips_and_rejects_commands(self):
        item = activation()
        item["spec"]["local"]["realtime"]["runtimeImage"] = "example.local/omni:custom"
        deployment, _, _ = self.resource(item)
        self.assertEqual(deployment["spec"]["template"]["spec"]["containers"][0]["image"], "example.local/omni:custom")
        for invalid in ("image; echo unsafe", "https://example.local/image", 12, "x" * 1025):
            item["spec"]["local"]["realtime"]["runtimeImage"] = invalid
            with self.assertRaises(ValueError):
                self.resource(item)

    def test_rocm_batch_budget_covers_all_concurrent_sessions(self):
        item = amd_activation()
        item["spec"]["local"].update(contextWindow=1, maxNumSeqs=8)
        _, _, runtime = self.resource(item, amd_node(), self.rocm_catalog())
        stages = json.loads(runtime["configuration"]["data"]["profile.json"])["stages"]
        self.assertEqual([stage["max_num_batched_tokens"] for stage in stages[:2]], [8, 8])

    def test_rocm_oom_reports_shared_memory_instead_of_cpu_offloading(self):
        item = amd_activation()
        deployment, service, runtime = self.resource(item, amd_node(), self.rocm_catalog())
        pod = {"status": {"containerStatuses": [{"lastState": {"terminated": {"reason": "OOMKilled"}}}]}}
        with patch.dict(self.c, {"apply_resource": lambda value: value, "list_items": lambda _: [pod],
                                "get_resource": lambda *_: {"metadata": {"generation": 1}, "status": {}}}):
            phase, _, message = self.c["reconcile_realtime_runtime"](item, deployment, service, runtime)
        self.assertEqual(phase, "Degraded")
        self.assertIn("shared system/GPU RAM", message)
        self.assertNotIn("CPU offloading", message)

    def test_restart_and_configuration_changes_roll_the_pod_template(self):
        before, _, _ = self.resource()
        item = activation()
        item["spec"]["local"]["realtime"]["restartNonce"] = "restart-1"
        after, _, _ = self.resource(item)
        self.assertNotEqual(before["spec"]["template"]["metadata"]["annotations"], after["spec"]["template"]["metadata"]["annotations"])
        item["spec"]["local"]["contextWindow"] = 4096
        changed, _, _ = self.resource(item)
        self.assertNotEqual(after["metadata"]["annotations"]["appliance.magicstick.dev/realtime-config-hash"],
                            changed["metadata"]["annotations"]["appliance.magicstick.dev/realtime-config-hash"])
        with patch.dict(self.c, {"realtime_bootstrap_source": lambda: "# updated runtime bootstrap\n"}):
            bootstrap_changed, _, _ = self.resource(item)
        self.assertNotEqual(changed["spec"]["template"]["metadata"]["annotations"]["appliance.magicstick.dev/realtime-config-hash"],
                            bootstrap_changed["spec"]["template"]["metadata"]["annotations"]["appliance.magicstick.dev/realtime-config-hash"])

    def test_health_waits_for_current_rollout_and_reports_failure(self):
        deployment, service, runtime = self.resource()
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        for status, expected in (({}, "Starting"), ({"observedGeneration": 1, "updatedReplicas": 1, "availableReplicas": 1}, "Ready"),
                                 ({"conditions": [{"type": "Progressing", "status": "False", "message": "deadline exceeded"}]}, "Degraded")):
            with patch.dict(self.c, {"apply_resource": lambda value: value, "list_items": lambda _: [],
                                    "get_resource": lambda *_: {"metadata": {"generation": 1}, "status": status}}), patch.object(self.c["urllib"].request, "urlopen", return_value=response):
                self.assertEqual(self.c["reconcile_realtime_runtime"](activation(), deployment, service, runtime)[0], expected)

    def test_runtime_configmap_permissions_are_namespaced_and_complete(self):
        documents = list(yaml.safe_load_all((ROOT / "rbac.yaml").read_text()))
        role = next((item for item in documents if item and item["kind"] == "Role"
                     and item["metadata"]["name"] == "magicstick-realtime-runtime"), None)
        self.assertIsNotNone(role, "Realtime needs namespaced ConfigMap lifecycle permissions")
        self.assertEqual(role["metadata"]["namespace"], "ai")
        self.assertEqual(role["rules"], [{"apiGroups": [""], "resources": ["configmaps"],
                                        "verbs": ["get", "create", "patch", "delete"]}])
        binding = next(item for item in documents if item and item["kind"] == "RoleBinding"
                       and item["metadata"]["name"] == role["metadata"]["name"])
        self.assertEqual(binding["metadata"]["namespace"], "ai")
        self.assertEqual(binding["roleRef"], {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role",
                                             "name": role["metadata"]["name"]})
        self.assertEqual(binding["subjects"], [{"kind": "ServiceAccount", "name": "magicstick-operator",
                                              "namespace": "ai-system"}])
        # The repair must not permit mutation of arbitrary platform ConfigMaps.
        cluster_role = next(item for item in documents if item and item["kind"] == "ClusterRole"
                            and item["metadata"]["name"] == "magicstick-operator")
        for rule in cluster_role["rules"]:
            if "configmaps" in rule["resources"]:
                self.assertFalse(set(rule["verbs"]) & {"create", "update", "patch", "delete", "*"})

    def test_kubernetes_apply_errors_are_reported_on_the_activation(self):
        deployment, service, runtime = self.resource()
        for failed_kind in ("ConfigMap", "Service", "Deployment"):
            applied, statuses = [], []

            def apply(value):
                applied.append(value["kind"])
                if value["kind"] == failed_kind:
                    raise urllib.error.HTTPError("https://kubernetes.example.local/api", 403,
                                                 "private server response", {}, None)
                return value

            with self.subTest(kind=failed_kind), patch.dict(self.c, {
                "ensure_model_finalizer": lambda *_: None,
                "realtime_runtime_resources": lambda *_: (deployment, service, copy.deepcopy(runtime)),
                "ensure_model_module_activations": lambda *_: None,
                "module_ready": lambda *_: True,
                "compute_target_capacity": lambda *_: 1,
                "apply_resource": apply,
                "patch_model_status": lambda *args, **kwargs: statuses.append((args, kwargs)),
            }):
                phase, status = self.c["reconcile_model_activation"](activation(), self.modules, {}, self.catalog)
            self.assertEqual(phase, "Degraded")
            self.assertEqual(statuses[-1][0][2], "RealtimePermissionDenied")
            self.assertEqual(statuses[-1][0][7], 1)
            self.assertEqual(status["modelRef"], "vllm-omni/qwen-realtime")
            self.assertIn("403", status["message"])
            self.assertIn("magicstick-operator", status["message"])
            self.assertNotIn("private server response", status["message"])
            self.assertEqual(applied[-1], failed_kind)
            self.assertEqual(status["effectiveKvCacheType"], "")

    def test_transient_api_failures_retry_and_recover(self):
        deployment, service, runtime = self.resource()
        for error, phase, reason in (
            (urllib.error.HTTPError("https://example.local/api", 500, "private", {}, None), "Starting", "RealtimeApiUnavailable"),
            (urllib.error.HTTPError("https://example.local/api", 429, "private", {}, None), "Starting", "RealtimeApiUnavailable"),
            (urllib.error.HTTPError("https://example.local/api", 422, "private", {}, None), "Degraded", "RealtimeApiRejected"),
            (urllib.error.URLError("private connection details"), "Starting", "RealtimeApiUnavailable"),
            (TimeoutError("private connection details"), "Starting", "RealtimeApiUnavailable"),
        ):
            with self.subTest(error=error), patch.dict(self.c, {"apply_resource": Mock(side_effect=error)}):
                result = self.c["reconcile_realtime_runtime"](activation(), deployment, service, runtime)
            self.assertEqual(result[:2], (phase, reason))
            self.assertNotIn("private", result[2])
        with patch.dict(self.c, {"apply_resource": lambda value: value, "get_resource": lambda *_: {},
                                "list_items": lambda _: []}):
            self.assertEqual(self.c["reconcile_realtime_runtime"](activation(), deployment, service, runtime)[:2],
                             ("Starting", "WaitingForRealtimePod"))

    def test_api_read_failure_is_not_lost_after_resources_are_created(self):
        deployment, service, runtime = self.resource()
        with patch.dict(self.c, {"apply_resource": lambda value: value,
                                "get_resource": Mock(side_effect=urllib.error.HTTPError(
                                    "https://example.local/api", 403, "Forbidden", {}, None))}):
            result = self.c["reconcile_realtime_runtime"](activation(), deployment, service, runtime)
        self.assertEqual(result[:2], ("Degraded", "RealtimePermissionDenied"))

    def test_stop_cleans_only_own_realtime_resources_and_keeps_activation(self):
        item = activation()
        item["spec"]["enabled"] = False
        cleanup = Mock(return_value=False)
        with patch.dict(self.c, {"delete_realtime_runtime": cleanup, "ensure_model_finalizer": lambda *_: None,
                                "patch_model_status": lambda *_args, **_kwargs: None}):
            phase, _ = self.c["reconcile_model_activation"](item, {}, {}, self.catalog)
        self.assertEqual(phase, "Disabled")
        cleanup.assert_called_once_with("qwen-realtime", "ai")
        self.assertIn("realtime", item["spec"]["local"])

    def test_api_and_controller_share_validation_and_eligibility(self):
        api = yaml.safe_load((CLUSTER_ROOT / "apps/dashboard/dashboard-api.yaml").read_text())["data"]["server.py"]
        controller = yaml.safe_load((ROOT / "controller-configmap.yaml").read_text())["data"]["controller.py"]
        for name in ("realtime_configuration", "realtime_gpu_allocation", "realtime_node_error"):
            extract = lambda text: next(item for item in ast.parse(text).body if isinstance(item, ast.FunctionDef) and item.name == name)
            self.assertEqual(ast.dump(extract(api)), ast.dump(extract(controller)))

    def test_shared_allocation_status_is_preserved_by_the_crd(self):
        crd = yaml.safe_load((ROOT / "crds/modelactivations.appliance.magicstick.dev.yaml").read_text())
        schema = crd["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["status"]["properties"]["gpuSharing"]["properties"]
        self.assertEqual(schema["slotCount"]["type"], "integer")
        self.assertEqual(schema["memoryIsolation"]["type"], "boolean")
        self.assertIn("dra-shared", schema["mode"]["enum"])
        self.assertIn("time-slicing", schema["mode"]["enum"])


if __name__ == "__main__":
    unittest.main()
