import copy
import hashlib
import json
import unittest
from unittest.mock import patch

from test_controller import load_controller

UUIDS = ["GPU-00000000-0000-0000-0000-" + str(i).zfill(12) for i in range(4)]


class NvidiaDraTests(unittest.TestCase):
    def group(self, cards=(0, 1), name="fixture-model", engine="VLLM"):
        model = self.model(name=name)
        local = model["spec"]["local"]
        local.pop("gpuDevice")
        local.update(engine=engine, gpuDevices=[{"uuid": UUIDS[i], "nodeName": "fixture-node", "nodeUid": "fixture-uid"} for i in cards])
        return model

    def test_group_reservation_is_atomic_and_charges_only_selected_cards(self):
        for count in (2, 4):
            with self.subTest(count=count):
                group = self.group(range(count))
                assigned, errors = self.c["nvidia_dra_assignments"]([group], self.devices, [], 4)
                self.assertFalse(errors)
                self.assertEqual(len(assigned["fixture-model"]["devices"]), count)
                used = self.c["nvidia_dra_slot_usage"](assigned, self.devices, [])
                self.assertEqual([used[u] for u in UUIDS], [1] * count + [0] * (4-count))
        busy = self.pod(card=1, name="other")
        group = self.group()
        assigned, errors = self.c["nvidia_dra_assignments"]([group], self.devices, [busy], 1)
        self.assertFalse(assigned)
        self.assertIn("fixture-model", errors)
        used = self.c["nvidia_dra_slot_usage"](assigned, self.devices, [busy])
        self.assertEqual([used[u] for u in UUIDS], [0, 1, 0, 0])

    def test_groups_compete_without_partial_reservations_or_live_double_counting(self):
        groups = [self.group(name="a"), self.group(name="b"), self.group((2, 3), name="c")]
        assigned, errors = self.c["nvidia_dra_assignments"](groups, self.devices, [], 1)
        self.assertEqual(set(assigned), {"a", "c"}); self.assertEqual(set(errors), {"b"})
        pod = self.pod(0, "a")
        pod["spec"]["resourceClaims"].append({"name": "second", "resourceClaimName": self.devices[1]["claimName"]})
        assigned, errors = self.c["nvidia_dra_assignments"](groups, self.devices, [pod], 1)
        self.assertEqual(set(assigned), {"a", "c"})
        self.assertEqual(list(self.c["nvidia_dra_slot_usage"](assigned, self.devices, [pod]).values()), [1, 1, 1, 1])
        groups[0] = self.group((2, 3), name="a")
        assigned, errors = self.c["nvidia_dra_assignments"](groups, self.devices, [pod], 1)
        self.assertNotIn("a", assigned); self.assertIn("previous NVIDIA GPU Pod", errors["a"])

    def test_group_rejects_duplicate_replaced_or_missing_cards_and_unknown_capacity(self):
        for change in ("duplicate", "node", "missing", "unknown-memory", "zero-memory", "negative-memory"):
            group = self.group(); devices = copy.deepcopy(self.devices)
            if change == "duplicate": group["spec"]["local"]["gpuDevices"][1] = group["spec"]["local"]["gpuDevices"][0]
            if change == "node": group["spec"]["local"]["gpuDevices"][1]["nodeUid"] = "replaced"
            if change == "missing": devices.pop(1)
            if change == "unknown-memory":
                for device in devices: device["totalMi"] = None
            if change == "zero-memory": devices[1]["totalMi"] = 0
            if change == "negative-memory": devices[1]["totalMi"] = -1
            assigned, errors = self.c["nvidia_dra_assignments"]([group], devices, [], 4)
            self.assertFalse(assigned, change); self.assertIn("fixture-model", errors)

    def test_different_nvidia_models_and_capacities_preserve_atomic_exact_groups(self):
        devices = copy.deepcopy(self.devices)
        devices[1].update(productName="NVIDIA RTX A5000", totalMi=24576)
        devices[3].update(productName="NVIDIA RTX A4000", totalMi=16384)
        for engine in ("VLLM", "OLlama"):
            for mode in ("split", "replicated"):
                group = self.group(range(4), engine=engine); group["spec"]["local"]["gpuDeployment"] = mode
                assigned, errors = self.c["nvidia_dra_assignments"]([group], devices, [], 4)
                self.assertFalse(errors)
                self.assertEqual([d["uuid"] for d in assigned["fixture-model"]["devices"]], UUIDS)
                self.assertEqual(list(self.c["nvidia_dra_slot_usage"](assigned, devices, []).values()), [1] * 4)
                self.c["NVIDIA_SHARING_STATE"] = {"phase": "Ready", "assignments": assigned}
                with self.assertRaisesRegex(ValueError, "physical memory"):
                    self.c["apply_nvidia_dra_profile"]({"metadata": {"name": "fixture-model"}}, {"vramMi": 17000})

    def test_group_runtime_keeps_one_profile_replica_and_one_host_ram_budget(self):
        import pathlib
        import yaml
        catalog = json.loads(yaml.safe_load((pathlib.Path(__file__).parents[1] / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        for engine in ("VLLM", "OLlama"):
            group = self.group(range(4), engine=engine)
            group["spec"]["local"].update(url="hf://fixture/small" if engine == "VLLM" else "ollama://fixture:small",
                vramMi=12000, memoryRequiredMi=16400, cpuOffloading=False,
                cpuResources={"requestMillicores": 700, "limitMillicores": 0})
            if engine == "VLLM": group["spec"]["local"]["vllm"] = {"parallelism": "pipeline"}
            self.models = [group]; self.c["NVIDIA_SHARING_STATE"] = self.reconcile()
            resource, runtime = self.c["kubeai_model_resource"](group, {}, catalog)
            base_name = runtime["baseResourceProfile"].split(":")[0]
            base = {"requests": {"nvidia.com/gpu": "1", "cpu": "1"}, "limits": {"nvidia.com/gpu": "1"}}
            with patch.dict(self.c, {"get_resource": lambda *_: {"spec": {"values": {"resourceProfiles": {base_name: base}}}},
                    "get_core_resource": lambda *_: {"data": {"values.json": "{}"}}, "patch_json": lambda *a: self.patches.append(a)}):
                self.c["apply_nvidia_sharing_profile"](resource, runtime)
            profile = next(iter(json.loads(self.patches[-1][1]["data"]["values.json"])["resourceProfiles"].values()))
            self.assertEqual(profile["requests"]["memory"], "16400Mi")
            self.assertTrue(resource["spec"]["resourceProfile"].endswith(":1"))
            self.assertEqual(resource["spec"]["env"]["MAGICSTICK_GPU_COUNT"], "4")
            self.assertEqual(len(resource["spec"]["env"]["MAGICSTICK_DRA_CLAIMS"].split(",")), 4)
            self.assertEqual(runtime["gpuSharing"]["slotCount"], 4)
            if engine == "VLLM": self.assertEqual(resource["spec"]["env"]["MAGICSTICK_VLLM_PARALLELISM"], "pipeline")
            else: self.assertEqual(resource["spec"]["env"]["OLLAMA_SCHED_SPREAD"], "true")

    def setUp(self):
        self.c = load_controller()
        self.config = {"allocationBackend": "dra", "mode": "dra-shared", "nodeName": "fixture-node",
                       "nodeUid": "fixture-uid", "namespace": "ai", "maxModels": 4, "allowExperimental": False}
        digest = hashlib.sha256(json.dumps(self.config, sort_keys=True).encode()).hexdigest()[:20]
        self.node = {"metadata": {"name": "fixture-node", "uid": "fixture-uid", "labels": {
            "nvidia.com/gpu.count": "4", "nvidia.com/mig.strategy": "none", "nvidia.com/gpu.deploy.driver": "false",
            "nvidia.com/gpu.deploy.device-plugin": "false", "nvidia.com/dra-kubelet-plugin": "true",
            "appliance.magicstick.dev/nvidia-dra-config": digest, "appliance.magicstick.dev/nvidia-dra-ready": "true"}},
            "status": {"allocatable": {}, "conditions": [{"type": "Ready", "status": "True"}],
                       "nodeInfo": {"kubeletVersion": "v1.36.4", "bootID": "fixture-boot"}}}
        self.activation = {"metadata": {"generation": 2}, "spec": {"enabled": True, "parameters": {"gpuSharing": json.dumps(self.config)}}}
        self.slice = {"spec": {"driver": "gpu.nvidia.com", "nodeName": "fixture-node",
            "pool": {"name": "fixture-node", "generation": 3, "resourceSliceCount": 1}, "devices": [
                {"name": "gpu-" + str(i), "attributes": {"uuid": {"string": uuid}, "type": {"string": "gpu"},
                    "productName": {"string": "NVIDIA RTX A6000"}, "resource.kubernetes.io/pciBusID": {"string": "0000:0" + str(i+1) + ":00.0"}},
                 "capacity": {"memory": {"value": "48Gi"}}} for i, uuid in enumerate(UUIDS)]}}
        self.devices = self.c["nvidia_dra_inventory"]([self.slice], self.node)
        for d in self.devices:
            d["claimName"] = self.c["nvidia_dra_claim"](self.config, d)["metadata"]["name"]
        self.pods = [{"metadata": {"namespace": "nvidia-dra-driver", "ownerReferences": [{"kind": "DaemonSet", "name": "dra-driver-nvidia-gpu-kubelet-plugin"}]}, "spec": {"nodeName": "fixture-node", "containers": [
            {"name": "gpus", "image": "registry.k8s.io/dra-driver-nvidia/dra-driver-nvidia-gpu:v0.5.0", "env": [{"name": "NVIDIA_DRIVER_ROOT", "value": "/"}]}]},
            "status": {"conditions": [{"type": "Ready", "status": "True"}]}}]
        self.models = [self.model()]
        self.claims = []
        self.applied, self.patches, self.deleted, self.retired = [], [], [], []
        self.release = {"metadata": {"generation": 1}, "status": {"observedGeneration": 1, "conditions": [{"type": "Ready", "status": "True"}]}}
        self.mocks = {"model_activations": lambda: self.models,
            "get_json": lambda _: {"spec": {"devicePlugin": {"config": {"name": "time-slicing-config"}}}},
            "get_core_resource": lambda *_: {"data": {"values.json": json.dumps({"nvidiaDriverRoot": "/", "resources": {"gpus": {"enabled": True}}}, sort_keys=True)}},
            "get_resource": lambda *_: self.release,
            "get_applied_resource": lambda obj: next((c for c in self.claims if c["metadata"]["name"] == obj["metadata"]["name"]), None),
            "list_items": lambda path: [self.slice] if path.endswith("/resourceslices") else self.claims if "resourceclaims" in path else self.pods,
            "apply_resource": self.applied.append, "patch_json": lambda *a: self.patches.append(a),
            "delete_json": lambda *a: self.deleted.append(a), "delete_kubeai_model": lambda *a: self.retired.append(a)}
        self.c["NVIDIA_SHARING_STATE"] = {}

    def model(self, uuid=UUIDS[2], name="fixture-model", enabled=True):
        return {"metadata": {"name": name, "creationTimestamp": name}, "spec": {"type": "local", "targetNamespace": "ai", "enabled": enabled,
            "local": {"computeTarget": "nvidia-gpu", "engine": "VLLM",
                      "gpuDevice": {"uuid": uuid, "nodeName": "fixture-node", "nodeUid": "fixture-uid"}}}}

    def pod(self, card=2, name="fixture-model", terminating=False):
        return {"metadata": {"namespace": "ai", "labels": {"app.kubernetes.io/managed-by": "kubeai",
            "appliance.magicstick.dev/compute-target": "nvidia-gpu", "appliance.magicstick.dev/modelactivation": name},
            **({"deletionTimestamp": "2026-01-01T00:00:00Z"} if terminating else {})},
            "spec": {"nodeName": "fixture-node", "resourceClaims": [{"name": "gpu", "resourceClaimName": self.devices[card]["claimName"]}]},
            "status": {"phase": "Running"}}

    def reconcile(self):
        self.activation["spec"]["parameters"]["gpuSharing"] = json.dumps(self.config)
        with patch.dict(self.c, self.mocks):
            return self.c["reconcile_nvidia_sharing"]([self.node], self.activation)

    def test_four_real_cards_have_uuid_selected_claims_and_sixteen_slots(self):
        state = self.reconcile()
        self.assertEqual(state["phase"], "Ready")
        self.assertEqual(state["slotLimit"], 16)
        self.assertEqual(state["assignments"]["fixture-model"]["uuid"], UUIDS[2])
        claims = [r for r in self.applied if r["kind"] == "ResourceClaim"]
        self.assertEqual(len(claims), 4)
        selector = claims[2]["spec"]["devices"]["requests"][0]["exactly"]
        self.assertEqual(selector["count"], 1)
        self.assertIn(json.dumps(UUIDS[2]), selector["selectors"][0]["cel"]["expression"])
        self.assertNotIn("config", claims[2]["spec"]["devices"])
        self.assertFalse(state["memoryIsolation"])

    def test_inventory_rejects_incomplete_generation_duplicates_and_mig(self):
        incomplete = copy.deepcopy(self.slice); incomplete["spec"]["pool"]["resourceSliceCount"] = 2
        with self.assertRaises(ValueError):
            self.c["nvidia_dra_inventory"]([incomplete], self.node)
        duplicate = copy.deepcopy(self.slice); duplicate["spec"]["devices"][1]["attributes"]["uuid"]["string"] = UUIDS[0]
        with self.assertRaises(ValueError):
            self.c["nvidia_dra_inventory"]([duplicate], self.node)
        mig = copy.deepcopy(self.slice); mig["spec"]["devices"][0]["attributes"]["type"]["string"] = "mig"
        self.assertEqual(len(self.c["nvidia_dra_inventory"]([mig], self.node)), 3)
        old = copy.deepcopy(self.slice); old["spec"]["pool"]["generation"] = 2
        self.assertEqual(len(self.c["nvidia_dra_inventory"]([old, self.slice], self.node)), 4)

    def test_exact_full_card_never_falls_back_to_free_siblings(self):
        pods = [self.pod(name="other-" + str(i)) for i in range(4)]
        assigned, errors = self.c["nvidia_dra_assignments"](self.models, self.devices, pods, 4)
        self.assertEqual(assigned, {})
        self.assertIn("selected NVIDIA", errors["fixture-model"])
        own = [self.pod()]
        assigned, errors = self.c["nvidia_dra_assignments"](self.models, self.devices, own, 1)
        self.assertEqual(assigned["fixture-model"]["uuid"], UUIDS[2])
        self.assertEqual(errors, {})

    def test_stopping_pod_retains_slot_and_legacy_unbound_models_get_distinct_cards(self):
        other = self.model(name="other-model")
        self.models[0]["spec"]["enabled"] = False
        assigned, errors = self.c["nvidia_dra_assignments"]([other], self.devices, [self.pod(terminating=True)], 1)
        self.assertEqual(assigned, {})
        assigned, _ = self.c["nvidia_dra_assignments"]([other], self.devices, [], 1)
        self.assertIn("other-model", assigned)
        legacy = [self.model(name="legacy-" + str(i)) for i in range(4)]
        for m in legacy: m["spec"]["local"].pop("gpuDevice")
        assigned, _ = self.c["nvidia_dra_assignments"](legacy, self.devices, [], 1)
        self.assertEqual(len({d["uuid"] for d in assigned.values()}), 4)

    def test_claim_accounting_includes_diagnostics_and_is_namespace_local(self):
        diagnostic = self.pod(name="other")
        diagnostic["metadata"]["labels"] = {"app.kubernetes.io/managed-by": "magicstick-operator"}
        other_namespace = self.pod(); other_namespace["metadata"]["namespace"] = "other"
        assigned, _ = self.c["nvidia_dra_assignments"](self.models, self.devices, [self.pod(), diagnostic, other_namespace], 4)
        usage = self.c["nvidia_dra_slot_usage"](assigned, self.devices, [self.pod(), diagnostic, other_namespace])
        self.assertEqual(usage[UUIDS[2]], 2)
        self.assertEqual(sum(usage.values()), 2)

    def test_invalid_identity_and_previous_card_change_fail_closed(self):
        self.models[0]["spec"]["local"]["gpuDevice"]["nodeUid"] = "replacement"
        assigned, errors = self.c["nvidia_dra_assignments"](self.models, self.devices, [], 4)
        self.assertFalse(assigned)
        self.assertIn("identity changed", errors["fixture-model"])
        self.models = [self.model(UUIDS[3])]
        self.pods.append(self.pod())
        self.assertEqual(self.reconcile()["assignmentErrors"]["fixture-model"],
                         "Waiting for the previous NVIDIA GPU Pod to stop before changing cards.")
        self.assertEqual(self.retired, [("fixture-model", "ai")])

    def test_handoff_drains_models_before_disabling_device_plugin(self):
        labels = self.node["metadata"]["labels"]; labels.pop("appliance.magicstick.dev/nvidia-dra-config")
        labels["nvidia.com/gpu.deploy.device-plugin"] = "true"
        self.pods.append(self.pod())
        self.assertEqual(self.reconcile()["phase"], "Switching")
        self.assertFalse(self.patches)
        self.pods.pop()
        self.assertEqual(self.reconcile()["phase"], "Switching")
        self.assertEqual(self.patches[-1][1]["metadata"]["labels"]["nvidia.com/gpu.deploy.device-plugin"], "false")
        self.assertNotIn("nvidia.com/dra-kubelet-plugin", self.patches[-1][1]["metadata"]["labels"])

    def test_handoff_does_not_start_dra_until_device_plugin_is_gone(self):
        self.node["status"]["allocatable"]["nvidia.com/gpu"] = "16"
        self.assertEqual(self.reconcile()["phase"], "Switching")
        self.assertFalse(self.applied)
        self.assertFalse(self.patches)

    def test_external_workload_and_unsupported_runtime_block_handoff(self):
        self.node["metadata"]["labels"].pop("appliance.magicstick.dev/nvidia-dra-config")
        self.pods.append({"metadata": {}, "spec": {"initContainers": [{"resources": {"requests": {"nvidia.com/gpu": "1"}}}]},
                          "status": {"phase": "Running"}})
        self.assertIn("unmanaged", self.reconcile()["message"])
        self.assertFalse(self.retired)
        self.pods.pop(); self.models[0]["spec"]["local"]["engine"] = "FreeToken"
        self.assertIn("Stop FreeToken", self.reconcile()["message"])
        self.assertFalse(self.retired)

    def test_existing_claim_allocation_mismatch_is_never_overwritten(self):
        claim = self.c["nvidia_dra_claim"](self.config, self.devices[2])
        claim["status"] = {"allocation": {"devices": {"results": [{"driver": "gpu.nvidia.com", "pool": "fixture-node", "device": "gpu-0"}]}}}
        self.claims = [claim]
        self.assertEqual(self.reconcile()["phase"], "Blocked")
        self.assertIn("does not match", self.reconcile()["message"])

    def test_external_dra_claim_blocks_handoff_even_before_a_pod_exists(self):
        self.node["metadata"]["labels"].pop("appliance.magicstick.dev/nvidia-dra-config")
        self.claims = [{"metadata": {"name": "external-claim", "namespace": "other"},
                        "status": {"allocation": {"devices": {"results": [{"driver": "gpu.nvidia.com", "pool": "fixture-node"}]}}}}]
        self.assertEqual(self.reconcile()["phase"], "Blocked")
        self.assertFalse(self.patches); self.assertFalse(self.retired)

    def test_driver_root_and_current_pinned_gpu_container_are_required(self):
        self.pods[0]["spec"]["containers"][0]["env"][0]["value"] = "/run/nvidia/driver"
        self.assertEqual(self.reconcile()["phase"], "Starting")
        self.assertFalse(self.applied)
        self.pods[0]["spec"]["containers"][0]["env"][0]["value"] = "/"
        self.mocks["get_core_resource"] = lambda *_: {"data": {"values.json": '{"nvidiaDriverRoot":"/","resources":{"gpus":{"enabled":false}}}'}}
        self.assertEqual(self.reconcile()["phase"], "Starting")
        self.assertEqual(self.patches[-1][0], "/api/v1/namespaces/flux-system/configmaps/magicstick-nvidia-dra-values")

    def test_custom_plugin_and_wrong_namespace_are_not_silently_adopted(self):
        self.node["metadata"]["labels"]["nvidia.com/device-plugin.config"] = "external"
        self.assertEqual(self.reconcile()["phase"], "Blocked")
        self.assertFalse(self.patches)
        self.models[0]["spec"]["targetNamespace"] = "other"
        assigned, errors = self.c["nvidia_dra_assignments"](self.models, self.devices, [], 4)
        self.assertFalse(assigned); self.assertIn("ai namespace", errors["fixture-model"])

    def test_direct_crd_binding_and_unsupported_engine_fail_before_start(self):
        saved = copy.deepcopy(self.models[0])
        cleanup, statuses = [], []
        for backend, engine, reason in (("device-plugin", "VLLM", "GpuSelectionRequiresDra"),
                                       ("dra", "FreeToken", "UnsupportedEngine")):
            cleanup.clear()
            model = copy.deepcopy(saved); model["spec"]["local"]["engine"] = engine
            with patch.dict(self.c, {"NVIDIA_SHARING_STATE": {"allocationBackend": backend, "phase": "Ready", "managed": True},
                    "ensure_model_finalizer": lambda *_: None, "patch_model_status": lambda *a, **_k: statuses.append(a),
                    "delete_local_runtime": lambda *a: cleanup.append(a)}):
                phase, _ = self.c["reconcile_model_activation"](model, {}, {})
            self.assertEqual(phase, "Degraded")
            self.assertEqual(statuses[-1][2], reason)
            if engine == "FreeToken":
                self.assertEqual(cleanup, [])
            else:
                self.assertEqual(cleanup[-1], ("fixture-model", "ai", engine))

    def test_reverse_handoff_keeps_driver_until_kubelet_releases_claim(self):
        self.config.update(allocationBackend="device-plugin", mode="exclusive")
        claim = self.c["nvidia_dra_claim"](self.config, self.devices[2])
        claim["metadata"].update(uid="claim-uid", resourceVersion="9")
        claim["status"] = {"reservedFor": [{"uid": "pod-uid"}]}; self.claims = [claim]
        self.assertEqual(self.reconcile()["phase"], "Switching")
        self.assertFalse(self.deleted); self.assertFalse(self.patches)
        claim["status"] = {}
        self.assertEqual(self.reconcile()["phase"], "Switching")
        self.assertEqual(self.deleted[0][1]["preconditions"], {"uid": "claim-uid", "resourceVersion": "9"})
        self.assertFalse(self.patches)

    def test_native_adapter_is_narrow_and_fail_closed(self):
        policy, binding = self.c["nvidia_dra_policies"]()
        self.assertEqual(binding["spec"]["policyName"], "magicstick-nvidia-dra")
        self.assertEqual(policy["spec"]["failurePolicy"], "Fail")
        self.assertEqual(policy["spec"]["matchConstraints"]["objectSelector"]["matchLabels"]["appliance.magicstick.dev/compute-target"], "nvidia-gpu")
        text = json.dumps(policy)
        self.assertIn("magicstick-nvidia-", text)
        self.assertIn("~1nvidia-dra", text)
        self.assertNotIn("amd-dra", text)

    def test_profile_preserves_cpu_offloading_and_replaces_legacy_gpu_request(self):
        self.c["NVIDIA_SHARING_STATE"] = self.reconcile()
        resource = {"metadata": {"name": "fixture-model"}, "spec": {}}
        runtime = {"baseResourceProfile": "nvidia:1", "computeTarget": "nvidia-gpu", "offloading": {"enabled": True}, "memoryMi": 16384}
        base = {"requests": {"nvidia.com/gpu": "1", "cpu": "1"}, "limits": {"nvidia.com/gpu": "1"}, "tolerations": [{"key": "nvidia.com/gpu"}]}
        with patch.dict(self.c, {"get_resource": lambda *_: {"spec": {"values": {"resourceProfiles": {"nvidia": base}}}},
            "get_core_resource": lambda *_: {"data": {"values.json": "{}"}}, "patch_json": lambda *a: self.patches.append(a)}):
            self.c["apply_nvidia_sharing_profile"](resource, runtime)
        profile = next(iter(json.loads(self.patches[-1][1]["data"]["values.json"])["resourceProfiles"].values()))
        self.assertNotIn("nvidia.com/gpu", profile["requests"])
        self.assertEqual(profile["requests"]["appliance.magicstick.dev/nvidia-dra"], "1")
        self.assertEqual(profile["limits"]["memory"], "16384Mi")
        self.assertEqual(runtime["gpuSharing"]["device"], UUIDS[2])
        self.assertEqual(resource["spec"]["env"]["MAGICSTICK_DRA_CLAIM"], self.devices[2]["claimName"])
