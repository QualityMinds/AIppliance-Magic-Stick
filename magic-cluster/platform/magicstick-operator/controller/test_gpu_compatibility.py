import copy
import hashlib
import json
import io
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import yaml

from test_controller import ROOT, load_controller


class GpuCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.controller = load_controller()
        document = yaml.safe_load((ROOT / "gpu-compatibility-catalog.yaml").read_text())
        self.catalog = json.loads(document["data"]["profiles.json"])
        self.profile = self.catalog["profiles"][0]
        self.host = {
            "nodeUid": "node-uid", "profileId": "strix-halo", "fingerprint": "a" * 64,
            "kernelVersion": "6.18.4-test", "bootId": "boot-one", "driverVersion": "amdgpu-test",
            "generatedAt": datetime.now(timezone.utc).isoformat(), "detectedArchitecture": "gfx1151",
            "hostDriverReady": True, "memoryArchitecture": "unified", "physicalMemoryMi": 60000,
            "gpuAccessibleMi": 45000, "memoryAccountingVerified": False,
        }
        self.node = {
            "metadata": {"name": "gpu-node", "uid": "node-uid", "labels": {
                "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64",
                "kubernetes.io/hostname": "gpu-node", "feature.node.kubernetes.io/pci-1002.present": "true",
            }, "annotations": {self.controller["GPU_PREFLIGHT_ANNOTATION"]: json.dumps(self.host)}},
            "status": {"nodeInfo": {"kernelVersion": "6.18.4-test", "bootID": "boot-one", "architecture": "amd64"},
                       "conditions": [{"type": "Ready", "status": "True"}], "allocatable": {"amd.com/gpu": "1"}},
        }
        self.features = [{"metadata": {"name": "gpu-node"}, "spec": {"features": {"instances": {
            "pci.device": {"elements": [{"attributes": {"vendor": "1002", "device": "1586", "class": "0380"}},
                                         {"attributes": {"vendor": "1002", "device": "1640", "class": "0403"}}]}
        }}}}]
        self.activation = {"metadata": {"name": "amd-gpu", "uid": "activation-uid"}, "spec": {"module": "amd-gpu", "enabled": True,
            "parameters": {"compatibilityProfile": "strix-halo", "allowExperimental": "true", "validationRequest": "test-1"}}}

    def status(self, jobs=None, pods=None):
        return self.controller["gpu_compatibility_status"](
            [self.node], self.features, self.catalog, self.activation, jobs, pods
        )["nodes"][0]

    def scoped_request(self, engine="OLlama"):
        self.activation["spec"]["parameters"]["validationRequest"] = ""
        key = "appliance.magicstick.dev/gpu-validation-" + hashlib.sha256(("node-uid:" + engine).encode()).hexdigest()[:32]
        self.activation["metadata"].setdefault("annotations", {})[key] = json.dumps({
            "requestId": "dashboard-scoped-1", "baseRequest": "", "profileId": self.profile["id"],
            "profileVersion": self.profile["version"], "activationGeneration": None})

    def test_scoped_request_does_not_request_other_nodes_or_engines(self):
        self.scoped_request()
        helper = self.controller["gpu_engine_validation_request"]
        self.assertEqual(helper(self.activation, self.node, self.profile, "OLlama"), "dashboard-scoped-1")
        self.assertEqual(helper(self.activation, self.node, self.profile, "VLLM"), "")
        other = copy.deepcopy(self.node)
        other["metadata"]["uid"] = "other-node-uid"
        self.assertEqual(helper(self.activation, other, self.profile, "OLlama"), "")
        applied = []
        with patch.dict(self.controller, {
            "list_items": lambda _: [], "get_core_resource": lambda *_: {"data": {}},
            "get_resource": lambda *_: None, "apply_resource": applied.append, "patch_json": lambda *_: {},
        }):
            self.controller["reconcile_gpu_compatibility"]([self.node], self.features, self.catalog, self.activation, set())
        jobs = [resource for resource in applied if resource["kind"] == "Job"]
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["metadata"]["annotations"]["appliance.magicstick.dev/validation-engine"], "OLlama")

    def test_profile_generation_invalidates_scoped_request_and_explicit_global_request_supersedes_it(self):
        self.scoped_request()
        helper = self.controller["gpu_engine_validation_request"]
        self.activation["metadata"]["generation"] = 3
        self.assertEqual(helper(self.activation, self.node, self.profile, "OLlama"), "")
        self.activation["spec"]["parameters"]["validationRequest"] = "manual-all-2"
        for engine in ("OLlama", "VLLM"):
            self.assertEqual(helper(self.activation, self.node, self.profile, engine), "manual-all-2")

    def change_host(self, **values):
        self.host.update(values)
        self.node["metadata"]["annotations"][self.controller["GPU_PREFLIGHT_ANNOTATION"]] = json.dumps(self.host)

    def job(self, engine="OLlama"):
        return self.controller["gpu_validation_job"](self.node, self.profile, engine, "test-1", self.host, self.activation)

    def completed_job(self, engine="OLlama"):
        job = self.job(engine)
        job["metadata"]["uid"] = "job-uid"
        job["status"] = {"conditions": [{"type": "Complete", "status": "True"}], "completionTime": "2026-01-01T00:00:00Z"}
        pod = {"metadata": {"ownerReferences": [{"uid": "job-uid"}]}, "status": {
            "initContainerStatuses": [{"name": "engine", "imageID": "docker-pullable://ollama/ollama@sha256:" + "b" * 64}]
        }}
        return job, pod

    def test_catalog_is_experimental_and_has_no_amd_architecture_override(self):
        self.assertTrue(self.profile["experimental"])
        self.assertEqual(self.profile["pciDevices"], ["1002:1586"])
        self.assertEqual(self.profile["expectedArchitecture"], "gfx1151")
        self.assertNotIn("HSA_OVERRIDE", json.dumps(self.profile))

    def test_pci_match_is_not_engine_validation(self):
        result = self.status()
        self.assertTrue(result["eligible"])
        self.assertFalse(result["upstreamSupported"])
        self.assertEqual(result["validation"]["OLlama"]["state"], "unverified")
        self.assertEqual(result["validation"]["VLLM"]["state"], "unverified")
        self.assertFalse(result["memoryAccountingVerified"])

    def test_host_driver_status_is_unknown_without_host_evidence(self):
        self.node["metadata"]["annotations"] = {}
        self.assertIsNone(self.status()["hostDriverReady"])
        self.assertFalse(self.status()["eligible"])

    def test_hardware_status_preserves_inventory_separate_from_shared_capacity(self):
        self.change_host(installedMemoryMi=131072, firmwareReservedMi=65536)
        result = self.status()
        self.assertEqual(result["installedMemoryMi"], 131072)
        self.assertEqual(result["firmwareReservedMi"], 65536)
        self.assertEqual(result["physicalMemoryMi"], 60000)
        self.assertEqual(result["gpuAccessibleMi"], 45000)
        self.assertFalse(result["memoryAccountingVerified"])

    def hardware_status(self, compatibility):
        catalog = json.loads(yaml.safe_load((ROOT / "module-catalog.yaml").read_text())["data"]["modules.json"])
        self.node["status"]["nodeInfo"].update({"operatingSystem": "linux", "kubeletVersion": "v1.36.4"})
        return self.controller["hardware_operator_statuses"](
            catalog, {"amd-gpu": self.activation}, {"amd-gpu": {"phase": "Ready"}},
            [self.node], {"deviceconfigs.amd.com"}, compatibility=compatibility,
        )["amd-gpu"]

    def test_experimental_registered_gpu_is_ready_during_optional_validation(self):
        compatibility = self.controller["gpu_compatibility_status"]([self.node], self.features, self.catalog, self.activation)
        compatibility["nodes"][0]["validation"]["OLlama"]["state"] = "running"
        result = self.hardware_status(compatibility)
        self.assertEqual(result["phase"], "Ready")
        self.assertEqual(result["allocatableResources"], 1)
        self.assertIn("1 running", result["message"])
        self.assertFalse(result["checks"][-1]["required"])
        self.assertNotIn("support rule", result["message"])
        self.assertFalse(result["compatibility"]["nodes"][0]["upstreamSupported"])

    def test_partial_experimental_engine_success_is_ready_with_independent_counts(self):
        compatibility = self.controller["gpu_compatibility_status"]([self.node], self.features, self.catalog, self.activation)
        compatibility["nodes"][0]["validation"]["OLlama"]["state"] = "passed"
        compatibility["nodes"][0]["validation"]["VLLM"]["state"] = "failed"
        result = self.hardware_status(compatibility)
        self.assertEqual(result["phase"], "Ready")
        self.assertIn("Experimental", result["message"])
        self.assertIn("1/2", result["message"])
        self.assertFalse(result["compatibility"]["nodes"][0]["upstreamSupported"])

    def test_all_engine_failures_remain_diagnostic_without_disabling_hardware(self):
        compatibility = self.controller["gpu_compatibility_status"]([self.node], self.features, self.catalog, self.activation)
        for report in compatibility["nodes"][0]["validation"].values():
            report["state"] = "failed"
        result = self.hardware_status(compatibility)
        self.assertEqual(result["phase"], "Ready")
        self.assertIn("2 failed", result["message"])
        self.assertEqual(result["allocatableResources"], 1)

    def test_explicit_opt_in_is_required(self):
        for parameters in ({}, {"compatibilityProfile": "strix-halo"}, {"allowExperimental": "true"},
                           {"compatibilityProfile": "unknown", "allowExperimental": "true"}):
            with self.subTest(parameters=parameters):
                self.activation["spec"]["parameters"] = parameters
                self.assertFalse(self.status()["eligible"])

    def test_disabled_activation_cannot_leave_eligibility(self):
        self.activation["spec"]["enabled"] = False
        self.assertFalse(self.status()["eligible"])

    def test_mixed_gpu_node_is_not_unlocked_by_strix_profile(self):
        self.features[0]["spec"]["features"]["instances"]["pci.device"]["elements"].append(
            {"attributes": {"vendor": "1002", "device": "ffff", "class": "0300"}})
        self.assertFalse(self.status()["eligible"])
        self.assertEqual(self.status()["profileId"], "")

    def test_wrong_measured_architecture_is_not_eligible(self):
        self.change_host(detectedArchitecture="gfx1100")
        self.assertFalse(self.status()["eligible"])

    def test_missing_or_stale_host_report_is_not_eligible(self):
        for values in ({"nodeUid": "other"}, {"kernelVersion": "old"}, {"bootId": "old-boot"},
                       {"fingerprint": "missing"}, {"generatedAt": "invalid"},
                       {"generatedAt": (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()}):
            with self.subTest(values=values):
                before = copy.deepcopy(self.host)
                self.change_host(**values)
                self.assertFalse(self.status()["eligible"])
                self.change_host(**before)

    def test_upstream_rule_requires_all_display_devices_to_match(self):
        self.node["metadata"]["labels"]["feature.node.kubernetes.io/amd-gpu"] = "true"
        self.catalog["upstreamPciDevices"] = ["1002:1586"]
        self.activation["spec"]["parameters"] = {}
        result = self.status()
        self.assertTrue(result["upstreamSupported"])
        self.assertTrue(result["eligible"])
        self.assertEqual(result["validation"]["OLlama"]["state"], "upstream")
        self.features[0]["spec"]["features"]["instances"]["pci.device"]["elements"].append(
            {"attributes": {"vendor": "1002", "device": "ffff", "class": "0380"}})
        self.assertFalse(self.status()["eligible"])

    def test_independent_engine_pass_requires_job_and_runtime_digest(self):
        job, pod = self.completed_job()
        result = self.status([job], [pod])
        self.assertEqual(result["validation"]["OLlama"]["state"], "passed")
        self.assertEqual(result["validation"]["VLLM"]["state"], "unverified")
        result = self.status([job], [])
        self.assertEqual(result["validation"]["OLlama"]["state"], "stale")

    def test_firmware_fingerprint_or_profile_revision_invalidates_pass(self):
        job, pod = self.completed_job()
        self.change_host(fingerprint="c" * 64)
        self.assertEqual(self.status([job], [pod])["validation"]["OLlama"]["state"], "stale")
        self.change_host(fingerprint="a" * 64)
        self.profile["version"] = "2"
        self.assertEqual(self.status([job], [pod])["validation"]["OLlama"]["state"], "stale")

    def test_probe_job_is_bounded_unprivileged_and_resource_scheduled(self):
        for engine in ("OLlama", "VLLM"):
            with self.subTest(engine=engine):
                job = self.job(engine)
                spec = job["spec"]["template"]["spec"]
                self.assertEqual(job["spec"]["activeDeadlineSeconds"], 1200)
                self.assertEqual(job["spec"]["backoffLimit"], 0)
                self.assertFalse(spec["automountServiceAccountToken"])
                self.assertNotIn("hostPath", json.dumps(spec))
                self.assertNotIn("privileged", json.dumps(spec))
                self.assertEqual(spec["initContainers"][0]["resources"]["limits"]["amd.com/gpu"], "1")
                self.assertEqual(spec["initContainers"][0]["resources"]["limits"]["memory"], "8Gi")
                self.assertEqual(spec["nodeSelector"][self.controller["AMD_ELIGIBILITY_LABEL"]], "true")
                env = {item["name"]: item["value"] for item in spec["initContainers"][0]["env"]}
                self.assertEqual(env["OLLAMA_VULKAN"], "false")

    def test_engine_selectors_are_catalog_driven(self):
        catalog = json.loads(yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        definition = catalog["targets"]["amd-gpu"]
        self.node["metadata"]["labels"].update({self.controller["AMD_ELIGIBILITY_LABEL"]: "true",
            self.controller["AMD_ENGINE_LABELS"]["OLlama"]: "true"})
        with patch.dict(self.controller, {"list_items": lambda _: [self.node]}):
            self.assertEqual(len(self.controller["compute_target_nodes"](definition, "OLlama")), 1)
            self.assertEqual(len(self.controller["compute_target_nodes"](definition, "VLLM")), 0)

    def test_unified_memory_reserves_one_pool_at_least_gpu_budget(self):
        runtime = {"computeTarget": "amd-gpu", "engine": "OLlama", "vramMi": 12000, "memoryMi": 0,
                   "baseResourceProfile": "magicstick-ollama-amd-gpu:1"}
        resource = {"metadata": {}, "spec": {}}
        with patch.dict(self.controller, {"compute_target_nodes": lambda *_: [self.node]}):
            self.controller["unified_memory_runtime"](resource, runtime, {})
        self.assertEqual(runtime["memoryMi"], 12000)
        self.assertEqual(runtime["memoryArchitecture"], "unified")
        self.assertEqual(runtime["sharedPoolId"], "node-uid")
        self.assertTrue(resource["spec"]["resourceProfile"].endswith("uma-ram-12000:1"))
        self.assertEqual(resource["spec"]["env"]["OLLAMA_VULKAN"], "false")

    def test_fixed_gpu_budget_is_not_reserved_again_in_linux_ram(self):
        self.change_host(firmwareReservedMi=65536, gpuAccessibleMi=47104,
                         gpuCapacityMi=65536, gpuAllocationMode="firmware-reserved", gpuCapacitySource="kfd-topology")
        for engine, requested, expected in (("OLlama", 0, 4096), ("VLLM", 0, 8192), ("OLlama", 10000, 10000)):
            runtime = {"computeTarget": "amd-gpu", "engine": engine, "vramMi": 50000, "memoryMi": requested,
                       "baseResourceProfile": "magicstick-amd-gpu:1"}
            resource = {"metadata": {}, "spec": {}}
            with patch.dict(self.controller, {"compute_target_nodes": lambda *_: [self.node]}):
                self.controller["unified_memory_runtime"](resource, runtime, {})
            self.assertEqual(runtime["memoryMi"], expected)
            self.assertEqual(runtime["vramMi"], 50000)
            self.assertEqual(runtime["gpuAllocationMode"], "firmware-reserved")
            self.assertEqual(resource["metadata"]["annotations"]["appliance.magicstick.dev/gpu-allocation-mode"], "firmware-reserved")

    def test_inconsistent_capacity_retains_conservative_host_request(self):
        self.change_host(firmwareReservedMi=65536, gpuAccessibleMi=47104,
                         gpuCapacityMi=110 * 1024, gpuAllocationMode="firmware-reserved", gpuCapacitySource="kfd-topology")
        runtime = {"computeTarget": "amd-gpu", "engine": "OLlama", "vramMi": 50000, "memoryMi": 0,
                   "baseResourceProfile": "magicstick-amd-gpu:1"}
        with patch.dict(self.controller, {"compute_target_nodes": lambda *_: [self.node]}):
            self.controller["unified_memory_runtime"]({"metadata": {}, "spec": {}}, runtime, {})
        self.assertEqual(runtime["memoryMi"], 50000)
        self.assertEqual(runtime["gpuAllocationMode"], "unknown")

    def test_unified_ollama_overrides_requested_vulkan_to_match_rocm_validation(self):
        runtime = {"computeTarget": "amd-gpu", "engine": "OLlama", "vramMi": 12000, "memoryMi": 0,
                   "baseResourceProfile": "magicstick-ollama-amd-gpu:1"}
        resource = {"metadata": {}, "spec": {"env": {"OLLAMA_VULKAN": "true"}}}
        with patch.dict(self.controller, {"compute_target_nodes": lambda *_: [self.node]}):
            self.controller["unified_memory_runtime"](resource, runtime, {})
        self.assertEqual(resource["spec"]["env"]["OLLAMA_VULKAN"], "false")

    def test_unified_vllm_does_not_receive_ollama_backend_settings(self):
        runtime = {"computeTarget": "amd-gpu", "engine": "VLLM", "vramMi": 12000, "memoryMi": 0,
                   "baseResourceProfile": "magicstick-amd-gpu:1"}
        resource = {"metadata": {}, "spec": {}}
        with patch.dict(self.controller, {"compute_target_nodes": lambda *_: [self.node]}):
            self.controller["unified_memory_runtime"](resource, runtime, {})
        self.assertNotIn("OLLAMA_VULKAN", resource["spec"]["env"])

    def test_unified_memory_rejects_implicit_mixed_node_placement(self):
        runtime = {"computeTarget": "amd-gpu", "engine": "OLlama"}
        with patch.dict(self.controller, {"compute_target_nodes": lambda *_: [self.node, {"metadata": {"name": "other"}}]}):
            with self.assertRaisesRegex(ValueError, "requires one eligible node"):
                self.controller["unified_memory_runtime"]({}, runtime, {})

    def test_validated_digest_normalizes_container_runtime_format(self):
        normalize = self.controller["validated_image_digest"]
        expected = "ollama/ollama@sha256:" + "b" * 64
        self.assertEqual(normalize("ollama/ollama:0.33.2-rocm", "docker-pullable://" + expected), expected)
        self.assertEqual(normalize("ollama/ollama:0.33.2-rocm", "sha256:" + "b" * 64), expected)
        self.assertEqual(normalize("ollama/ollama:0.33.2-rocm", "missing"), "")

    def test_helm_install_does_not_wait_for_deviceconfig(self):
        release = yaml.safe_load((ROOT.parent / "gpu/amd-gpu-operator/helmrelease.yaml").read_text())
        self.assertEqual(release["spec"]["values"]["crds"]["defaultCR"], {"install": False, "upgrade": False})

    def test_ssa_create_permissions_are_scoped_to_runtime_namespaces(self):
        resources = list(yaml.safe_load_all((ROOT.parent / "gpu/amd-gpu-operator/magicstick-rbac.yaml").read_text()))
        role = next(resource for resource in resources if resource["kind"] == "Role")
        self.assertEqual(role["metadata"]["namespace"], "amd-gpu-operator")
        create = next(rule for rule in role["rules"] if "create" in rule["verbs"])
        self.assertEqual(create["resources"], ["deviceconfigs"])
        self.assertEqual(create["verbs"], ["create"])
        self.assertNotIn("resourceNames", create)
        mutate = next(rule for rule in role["rules"] if "patch" in rule["verbs"])
        self.assertEqual(mutate["resourceNames"], ["default"])
        operator_resources = list(yaml.safe_load_all((ROOT / "rbac.yaml").read_text()))
        probe_role = next(resource for resource in operator_resources if resource["kind"] == "Role"
                          and resource["metadata"]["name"] == "magicstick-gpu-validation")
        self.assertEqual(probe_role["metadata"]["namespace"], "ai-system")
        self.assertEqual(probe_role["rules"][0]["resources"], ["jobs"])
        self.assertIn("create", probe_role["rules"][0]["verbs"])

    def test_validation_programs_compile_and_separate_gpu_from_memory_proof(self):
        config = yaml.safe_load((ROOT / "gpu-validation-configmap.yaml").read_text())
        for name, source in config["data"].items():
            compile(source, name, "exec")
        self.assertIn("size_vram", config["data"]["validate.py"])
        self.assertIn("torch.equal", config["data"]["vllm-start.py"])
        self.assertIn('"memoryAccountingVerified": False', config["data"]["validate.py"])

    def run_validation_program(self, answer, engine="OLlama", gpu_bytes=1024):
        config = yaml.safe_load((ROOT / "gpu-validation-configmap.yaml").read_text())
        requests = []
        def urlopen(request, **_kwargs):
            path = request.full_url.split("127.0.0.1:", 1)[1].split("/", 1)[1]
            requests.append(path)
            if path in ("api/generate", "v1/completions"):
                payload = json.loads(request.data)
                self.assertEqual(payload["prompt"], "2 + 2 =")
                if engine == "OLlama":
                    self.assertTrue(payload["raw"])
                    self.assertEqual(payload["options"]["num_predict"], 2)
                else:
                    self.assertEqual(payload["max_tokens"], 2)
            payloads = {
                "api/tags": {"models": []}, "api/pull": {"status": "success"},
                "api/generate": {"response": answer, "done": True, "done_reason": "stop", "eval_count": 2},
                "api/ps": {"models": [{"name": "qwen3:0.6b", "size_vram": gpu_bytes}]},
                "v1/models": {"data": []},
                "v1/completions": {"choices": [{"text": answer, "finish_reason": "length"}],
                                        "usage": {"completion_tokens": 2}},
            }
            return io.StringIO(json.dumps(payloads[path]))
        output = io.StringIO()
        with patch.dict(os.environ, {"ENGINE": engine, "TEST_MODEL": "qwen3:0.6b"}), \
                patch("urllib.request.urlopen", side_effect=urlopen), patch("sys.stdout", output):
            try:
                exec(compile(config["data"]["validate.py"], "validate.py", "exec"), {})
                error = None
            except RuntimeError as failure:
                error = str(failure)
        return error, [json.loads(line) for line in output.getvalue().splitlines()], requests

    def test_executed_validation_accepts_only_four_or_digit_four(self):
        for engine in ("OLlama", "VLLM"):
            for answer in ("4", "4.\n", "four", "Four!"):
                with self.subTest(engine=engine, answer=answer):
                    error, output, _ = self.run_validation_program(answer, engine)
                    self.assertIsNone(error)
                    self.assertEqual(output[0]["answer"], answer)
                    self.assertEqual(output[0]["completion"]["outputTokens"], 2)
                    self.assertEqual(output[-1]["state"], "passed")

    def test_executed_validation_rejects_incorrect_and_ambiguous_answers(self):
        for answer in ("2", "5", "14", "fourteen", "4 or 5", "", "4 5"):
            with self.subTest(answer=answer):
                error, output, _ = self.run_validation_program(answer)
                self.assertIn("arithmetic response failed", error)
                self.assertEqual(len(output), 1)
                self.assertEqual(output[0]["answer"], answer)

    def test_executed_validation_rejects_cpu_fallback_even_for_correct_answer(self):
        error, output, _ = self.run_validation_program("4", gpu_bytes=0)
        self.assertIn("CPU fallback is not validation", error)
        self.assertFalse(output[0]["gpuExecution"])
        self.assertFalse(any(item.get("state") == "passed" for item in output))

    def test_executed_validation_bounds_diagnostic_answer(self):
        error, output, _ = self.run_validation_program("x" * 1000)
        self.assertIsNotNone(error)
        self.assertEqual(len(output[0]["answer"]), 160)
        self.assertTrue(output[0]["answerTruncated"])

    def test_changed_probe_version_invalidates_prior_evidence(self):
        old = self.controller["gpu_validation_key"](self.node, self.profile, "OLlama", "test-1", self.host)
        document = yaml.safe_load((ROOT / "controller-configmap.yaml").read_text())
        self.assertIn('"probeVersion": "3"', document["data"]["controller.py"])
        prior_source = document["data"]["controller.py"].replace('"probeVersion": "3"', '"probeVersion": "2"').replace(
            "SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)", "SSL_CONTEXT = None")
        prior = {"__name__": "test_previous_probe"}
        exec(compile(prior_source, "previous.py", "exec"), prior)
        self.assertNotEqual(old, prior["gpu_validation_key"](self.node, self.profile, "OLlama", "test-1", self.host))

    def test_runtime_image_values_are_seeded_and_match_tested_catalog_tags(self):
        config = yaml.safe_load((ROOT / "gpu-runtime-images.yaml").read_text())
        kubeai = yaml.safe_load((ROOT.parent / "ai/kubeai/base/helmrelease.yaml").read_text())
        self.assertEqual(config["metadata"]["annotations"]["kustomize.toolkit.fluxcd.io/ssa"], "IfNotPresent")
        self.assertEqual(config["data"]["runtime-config-checksum"], self.controller["gpu_runtime_checksum"](config["data"]))
        for engine, key in (("OLlama", "ollama-amd"), ("VLLM", "vllm-amd")):
            self.assertEqual(config["data"][key], self.profile["engines"][engine]["image"])
            self.assertEqual(config["data"][key + "-source"], config["data"][key])
            # The seed ConfigMap is the only AMD image source. Inline tags must
            # not replace validated digests when generic values are merged.
            self.assertNotIn("magicstick-" + key, kubeai["spec"]["values"]["modelServers"][engine]["images"])
            reference = next(item for item in kubeai["spec"]["valuesFrom"] if item.get("valuesKey") == key)
            self.assertEqual(reference["name"], config["metadata"]["name"])
            self.assertEqual(reference["targetPath"], "modelServers." + engine + ".images.magicstick-" + key)
        references = kubeai["spec"]["valuesFrom"]
        generic_index = next(i for i, item in enumerate(references) if item["name"] == "magicstick-offloading-profiles")
        self.assertTrue(all(i > generic_index for i, item in enumerate(references) if item["name"] == config["metadata"]["name"]))

    def test_failed_validation_does_not_fabricate_a_success(self):
        job = self.job()
        job["status"] = {"conditions": [{"type": "Failed", "status": "True"}]}
        self.assertEqual(self.status([job])["validation"]["OLlama"]["state"], "failed")

    def test_reconciliation_uses_only_owned_labels_and_starts_one_probe(self):
        applied, patched = [], []
        def list_items(path):
            return []
        with patch.dict(self.controller, {
            "list_items": list_items, "get_core_resource": lambda *_: {"data": {}},
            "get_resource": lambda *_: None, "apply_resource": applied.append,
            "patch_json": lambda path, body: patched.append((path, body)),
        }):
            result = self.controller["reconcile_gpu_compatibility"](
                [self.node], self.features, self.catalog, self.activation, {"deviceconfigs.amd.com"})
        jobs = [resource for resource in applied if resource["kind"] == "Job"]
        configs = [resource for resource in applied if resource["kind"] == "DeviceConfig"]
        self.assertEqual(len(jobs), 1)
        self.assertEqual(len(configs), 1)
        self.assertEqual(configs[0]["spec"]["selector"], {self.controller["AMD_ELIGIBILITY_LABEL"]: "true"})
        for path, body in patched:
            if path.startswith("/api/v1/nodes/"):
                self.assertTrue(all(key.startswith("appliance.magicstick.dev/") for key in body["metadata"]["labels"]))
                self.assertEqual(body["metadata"]["labels"][self.controller["AMD_ENGINE_LABELS"]["OLlama"]], "true")
        self.assertEqual(result["nodes"][0]["validation"]["OLlama"]["state"], "running")

    def test_external_deviceconfig_is_not_taken_over(self):
        applied = []
        foreign = {"metadata": {"name": "default", "annotations": {"meta.helm.sh/release-name": "another-release"}}}
        with patch.dict(self.controller, {
            "list_items": lambda _: [], "get_core_resource": lambda *_: {"data": {}},
            "get_resource": lambda *_: foreign, "apply_resource": applied.append, "patch_json": lambda *_: {},
        }):
            result = self.controller["reconcile_gpu_compatibility"](
                [self.node], self.features, self.catalog, self.activation, {"deviceconfigs.amd.com"})
        self.assertIn("not Magic Stick owned", result["message"])
        self.assertFalse(any(resource["kind"] == "DeviceConfig" for resource in applied))

    def test_revoking_opt_in_removes_labels_and_managed_deviceconfig(self):
        self.node["metadata"]["labels"].update({self.controller["AMD_ELIGIBILITY_LABEL"]: "true",
            self.controller["AMD_ENGINE_LABELS"]["OLlama"]: "true"})
        self.activation["spec"]["parameters"] = {}
        patched, deleted = [], []
        current = {"metadata": {"annotations": {"appliance.magicstick.dev/managed-device-config": "true"}}}
        with patch.dict(self.controller, {
            "list_items": lambda _: [], "get_core_resource": lambda *_: {"data": {}},
            "get_resource": lambda *_: current, "apply_resource": lambda _: self.fail("Do not recreate resources after opt-out"),
            "patch_json": lambda path, body: patched.append((path, body)), "delete_resource": lambda *args: deleted.append(args),
        }):
            self.controller["reconcile_gpu_compatibility"](
                [self.node], self.features, self.catalog, self.activation, {"deviceconfigs.amd.com"})
        self.assertIn(("amd.com", "v1alpha1", "deviceconfigs", "amd-gpu-operator", "default"), deleted)
        self.assertTrue(any(body.get("metadata", {}).get("labels", {}).get(self.controller["AMD_ENGINE_LABELS"]["OLlama"], "missing") is None
                            for _, body in patched))

    def test_obsolete_validation_jobs_explicitly_cascade_their_engine_pods(self):
        old_job = self.job()
        self.activation["spec"]["parameters"]["validationRequest"] = "test-2"
        deleted = []
        with patch.dict(self.controller, {
            "list_items": lambda path: [old_job] if "/jobs?" in path else [],
            "get_core_resource": lambda *_: {"data": {}}, "get_resource": lambda *_: None,
            "apply_resource": lambda _: {}, "patch_json": lambda *_: {},
            "delete_json": lambda path, body: deleted.append((path, body)),
            "delete_resource": lambda *_: self.fail("Validation cleanup must not use orphaning default deletion"),
        }):
            self.controller["reconcile_gpu_compatibility"](
                [self.node], self.features, self.catalog, self.activation, {"deviceconfigs.amd.com"})
        self.assertEqual(deleted, [(
            "/apis/batch/v1/namespaces/ai-system/jobs/" + old_job["metadata"]["name"],
            {"apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": "Background"},
        )])

    def test_gpu_image_pin_restores_catalog_tag_on_opt_out(self):
        result = self.controller["gpu_compatibility_status"]([self.node], self.features, self.catalog, self.activation)
        result["selectedProfile"] = ""
        patched = []
        with patch.dict(self.controller, {
            "get_core_resource": lambda *_: {"data": {"ollama-amd": "ollama/ollama@sha256:" + "b" * 64}},
            "patch_json": lambda path, body: patched.append(body),
        }):
            self.controller["pin_validated_gpu_images"](result)
        self.assertEqual(patched[0]["data"]["ollama-amd"], self.profile["engines"]["OLlama"]["image"])

    def test_unified_profile_requests_shared_budget_without_fake_gpu_memory_limit(self):
        runtime = {"baseResourceProfile": "magicstick-ollama-amd-gpu:1",
                   "resourceProfile": "magicstick-ollama-amd-gpu-uma-ram-12000:1", "memoryMi": 12000}
        release = {"spec": {"values": {"resourceProfiles": {"magicstick-ollama-amd-gpu": {
            "imageName": "magicstick-ollama-amd", "requests": {"memory": "4Gi", "amd.com/gpu": "1"},
            "limits": {"amd.com/gpu": "1"}, "nodeSelector": {"appliance.magicstick.dev/amd-ollama-eligible": "true"},
        }}}}}
        patched = []
        with patch.dict(self.controller, {"get_resource": lambda *_: release,
                "get_core_resource": lambda *_: {"data": {"values.json": "{}"}},
                "patch_json": lambda path, body: patched.append(body)}):
            self.controller["ensure_unified_memory_profile"](runtime)
        values = json.loads(patched[0]["data"]["values.json"])
        profile = values["resourceProfiles"]["magicstick-ollama-amd-gpu-uma-ram-12000"]
        self.assertEqual(profile["requests"]["memory"], "12000Mi")
        self.assertNotIn("memory", profile["limits"])
        self.assertEqual(profile["nodeSelector"]["appliance.magicstick.dev/gpu-memory-architecture"], "unified")

    def runtime_fixtures(self):
        self.pinned_image = "ollama/ollama@sha256:" + "b" * 64
        self.pins = {"ollama-amd": self.pinned_image, "vllm-amd": "vllm/vllm-openai-rocm:v0.26.0"}
        checksum = self.controller["gpu_runtime_checksum"](self.pins)
        self.pins["runtime-config-checksum"] = checksum
        annotations = {self.controller["GPU_RUNTIME_CHECKSUM"]: checksum, "checksum/config": "chart-checksum"}
        self.kubeai_deployment = {"metadata": {"name": "ai-kubeai", "generation": 7}, "spec": {
            "replicas": 1, "selector": {"matchLabels": {"app.kubernetes.io/name": "kubeai"}},
            "template": {"metadata": {"annotations": annotations},
                         "spec": {"volumes": [{"name": "config", "configMap": {"name": "ai-kubeai-config"}}]}},
        }, "status": {"observedGeneration": 7, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1, "availableReplicas": 1}}
        self.kubeai_pods = [{"metadata": {"annotations": copy.deepcopy(annotations)},
                            "status": {"conditions": [{"type": "Ready", "status": "True"}]}}]
        self.effective_config = {"data": {"system.yaml": "modelServers:\n  OLlama:\n    images:\n      magicstick-ollama-amd: " + self.pinned_image + "\nmodelRollouts:\n  surge: 0\n"}}
        def core_resource(_version, _resource, _namespace, name):
            return {"data": self.pins} if name == "magicstick-gpu-runtime-images" else self.effective_config
        return {
            "get_core_resource": core_resource,
            "get_resource": lambda *_: {"spec": {"targetNamespace": "ai"}},
            "list_items": lambda path: [self.kubeai_deployment] if "/deployments?" in path else self.kubeai_pods,
        }

    def test_runtime_gate_requires_effective_config_and_current_ready_consumers(self):
        mocks = self.runtime_fixtures()
        with patch.dict(self.controller, mocks):
            ready, _ = self.controller["kubeai_gpu_runtime_ready"]("OLlama", self.pinned_image)
        self.assertTrue(ready)

    def test_runtime_gate_rejects_stale_config_rollout_and_old_controller_pods(self):
        mutations = {
            "stale pin checksum": lambda: self.pins.update({"runtime-config-checksum": "old"}),
            "old deployment annotation": lambda: self.kubeai_deployment["spec"]["template"]["metadata"]["annotations"].update({self.controller["GPU_RUNTIME_CHECKSUM"]: "old"}),
            "old loaded config": lambda: self.effective_config["data"].update({"system.yaml": self.effective_config["data"]["system.yaml"].replace(self.pinned_image, "ollama/ollama:old")}),
            "rollout unobserved": lambda: self.kubeai_deployment["status"].update({"observedGeneration": 6}),
            "old replica": lambda: self.kubeai_deployment["status"].update({"updatedReplicas": 0}),
            "old pod checksum": lambda: self.kubeai_pods[0]["metadata"]["annotations"].update({"checksum/config": "old"}),
            "terminating old pod": lambda: self.kubeai_pods.append({"metadata": {"deletionTimestamp": "now"}}),
            "not ready pod": lambda: self.kubeai_pods[0].update({"status": {}}),
        }
        for name, mutate in mutations.items():
            with self.subTest(case=name):
                mocks = self.runtime_fixtures()
                mutate()
                with patch.dict(self.controller, mocks):
                    ready, _ = self.controller["kubeai_gpu_runtime_ready"]("OLlama", self.pinned_image)
                self.assertFalse(ready)

    def test_successful_smoke_keeps_selection_available_while_kubeai_is_absent(self):
        job, pod = self.completed_job()
        patched = []
        with patch.dict(self.controller, {
            "list_items": lambda path: [job] if "/jobs?" in path else [pod] if "/pods?" in path else [],
            "get_core_resource": lambda *_: {"data": {}}, "get_resource": lambda *_: None,
            "apply_resource": lambda _: {}, "patch_json": lambda path, body: patched.append((path, body)),
        }):
            result = self.controller["reconcile_gpu_compatibility"]([self.node], self.features, self.catalog, self.activation, set())
        report = result["nodes"][0]["validation"]["OLlama"]
        self.assertEqual(report["state"], "passed")
        self.assertFalse(report["runtimeReady"])
        labels = next(body["metadata"]["labels"] for path, body in patched if path.startswith("/api/v1/nodes/"))
        self.assertEqual(labels[self.controller["AMD_ENGINE_LABELS"]["OLlama"]], "true")
        self.assertNotEqual(labels.get(self.controller["AMD_RUNTIME_LABELS"]["OLlama"]), "true")

    def test_model_generation_waits_for_exact_image_rollout(self):
        mocks = self.runtime_fixtures()
        runtime = {"memoryArchitecture": "unified", "engine": "OLlama"}
        resource = {"metadata": {}}
        self.kubeai_pods[0]["metadata"]["annotations"]["checksum/config"] = "old"
        with patch.dict(self.controller, mocks):
            with self.assertRaisesRegex(ValueError, "configured GPU runtime"):
                self.controller["require_gpu_runtime"](resource, runtime)
        self.assertNotIn("annotations", resource["metadata"])
        mocks = self.runtime_fixtures()
        with patch.dict(self.controller, mocks):
            self.controller["require_gpu_runtime"](resource, runtime)
        self.assertEqual(resource["metadata"]["annotations"]["appliance.magicstick.dev/runtime-image"], self.pinned_image)

    def test_default_profile_enables_both_engines_without_running_probes(self):
        for request in ("", "host-" + "a" * 32):
            with self.subTest(request=request):
                self.activation["spec"]["parameters"]["validationRequest"] = request
                applied = []
                with patch.dict(self.controller, {
                    "list_items": lambda _: [], "get_core_resource": lambda *_: {"data": {}},
                    "get_resource": lambda *_: None, "apply_resource": applied.append,
                    "patch_json": lambda *_: {}, "kubeai_gpu_runtime_ready": lambda *_: (True, "Configured image adopted."),
                }):
                    result = self.controller["reconcile_gpu_compatibility"](
                        [self.node], self.features, self.catalog, self.activation, {"deviceconfigs.amd.com"})
                self.assertFalse(result["validationRequired"])
                self.assertFalse(any(resource["kind"] == "Job" for resource in applied))
                self.assertEqual(self.hardware_status(result)["phase"], "Ready")
                for engine in ("OLlama", "VLLM"):
                    report = result["nodes"][0]["validation"][engine]
                    self.assertEqual(report["state"], "unverified")
                    self.assertTrue(report["runtimeReady"])
                    self.assertEqual(self.node["metadata"]["labels"][self.controller["AMD_ENGINE_LABELS"][engine]], "true")
                    self.assertEqual(self.node["metadata"]["labels"][self.controller["AMD_RUNTIME_LABELS"][engine]], "true")

    def test_host_operation_schema_accepts_registration_and_legacy_validation_phase(self):
        crd = yaml.safe_load((ROOT / "crds/hostoperations.appliance.magicstick.dev.yaml").read_text())
        phases = crd["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["status"]["properties"]["phase"]["enum"]
        self.assertIn("Registering", phases)
        self.assertIn("Validating", phases)

    def test_failed_manual_tests_keep_both_engines_eligible(self):
        jobs = [self.job(engine) for engine in ("OLlama", "VLLM")]
        for job in jobs:
            job["status"] = {"conditions": [{"type": "Failed", "status": "True"}]}
        with patch.dict(self.controller, {
            "list_items": lambda path: jobs if "/jobs?" in path else [],
            "get_core_resource": lambda *_: {"data": {}}, "get_resource": lambda *_: None,
            "apply_resource": lambda resource: self.assertNotEqual(resource["kind"], "Job"),
            "patch_json": lambda *_: {}, "kubeai_gpu_runtime_ready": lambda *_: (True, "Configured image adopted."),
        }):
            result = self.controller["reconcile_gpu_compatibility"]([self.node], self.features, self.catalog, self.activation, set())
        for engine in ("OLlama", "VLLM"):
            self.assertEqual(result["nodes"][0]["validation"][engine]["state"], "failed")
            self.assertEqual(self.node["metadata"]["labels"][self.controller["AMD_ENGINE_LABELS"][engine]], "true")
        self.assertEqual(self.hardware_status(result)["phase"], "Ready")

    def test_catalog_tag_can_start_models_without_a_validated_digest(self):
        mocks = self.runtime_fixtures()
        tag = self.profile["engines"]["OLlama"]["image"]
        self.pins["ollama-amd"] = tag
        checksum = self.controller["gpu_runtime_checksum"](self.pins)
        self.pins["runtime-config-checksum"] = checksum
        self.kubeai_deployment["spec"]["template"]["metadata"]["annotations"][self.controller["GPU_RUNTIME_CHECKSUM"]] = checksum
        self.kubeai_pods[0]["metadata"]["annotations"][self.controller["GPU_RUNTIME_CHECKSUM"]] = checksum
        self.effective_config["data"]["system.yaml"] = self.effective_config["data"]["system.yaml"].replace(self.pinned_image, tag)
        resource = {"metadata": {}}
        with patch.dict(self.controller, mocks):
            self.controller["require_gpu_runtime"](resource, {"memoryArchitecture": "unified", "engine": "OLlama"})
        self.assertEqual(resource["metadata"]["annotations"], {"appliance.magicstick.dev/runtime-image": tag})

    def test_host_or_image_changes_require_a_new_manual_request_not_automatic_probes(self):
        for change in ("boot", "fingerprint", "image"):
            with self.subTest(change=change):
                self.setUp()
                job, pod = self.completed_job()
                if change == "boot":
                    self.node["status"]["nodeInfo"]["bootID"] = "boot-two"
                    self.change_host(bootId="boot-two")
                elif change == "fingerprint":
                    self.change_host(fingerprint="c" * 64)
                else:
                    self.profile["engines"]["VLLM"]["image"] = "example/vllm:new"
                applied = []
                with patch.dict(self.controller, {
                    "list_items": lambda path: [job] if "/jobs?" in path else [pod] if "/pods?" in path else [],
                    "get_core_resource": lambda *_: {"data": {}}, "get_resource": lambda *_: None,
                    "apply_resource": applied.append, "patch_json": lambda *_: {},
                    "delete_json": lambda *_: self.fail("Keep the manual request evidence until a new request"),
                }):
                    result = self.controller["reconcile_gpu_compatibility"]([self.node], self.features, self.catalog, self.activation, set())
                self.assertFalse(applied)
                for engine in ("OLlama", "VLLM"):
                    self.assertEqual(result["nodes"][0]["validation"][engine]["state"], "stale")
                    self.assertEqual(self.node["metadata"]["labels"][self.controller["AMD_ENGINE_LABELS"][engine]], "true")

    def test_kubeai_scheduling_uses_runtime_gate_but_dashboard_selection_does_not(self):
        kubeai = yaml.safe_load((ROOT.parent / "ai/kubeai/base/helmrelease.yaml").read_text())
        targets = json.loads(yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        for engine, profile in (("OLlama", "magicstick-ollama-amd-gpu"), ("VLLM", "magicstick-amd-gpu")):
            label = self.controller["AMD_RUNTIME_LABELS"][engine]
            self.assertEqual(kubeai["spec"]["values"]["resourceProfiles"][profile]["nodeSelector"][label], "true")
            self.assertNotIn(label, targets["targets"]["amd-gpu"]["engineProfiles"][engine]["nodeSelector"])
        self.assertTrue(any(item.get("valuesKey") == "runtime-config-checksum" and item.get("targetPath") == "podAnnotations.magicstick-gpu-runtime-images"
                            for item in kubeai["spec"]["valuesFrom"]))


if __name__ == "__main__":
    unittest.main()
