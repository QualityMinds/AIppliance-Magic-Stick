import copy
import json
import pathlib
import unittest
import urllib.parse
from unittest.mock import patch

import yaml
from test_controller import load_controller
import test_nvidia_dra

UUIDS = test_nvidia_dra.UUIDS


class ModelReplicationTests(unittest.TestCase):
    def setUp(self):
        self.c = load_controller()
        self.catalog = json.loads(yaml.safe_load((pathlib.Path(__file__).parents[1] / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        self.parent = {"metadata": {"name": "public-model", "namespace": "ai-system", "uid": "parent-uid", "generation": 1},
            "spec": {"type": "local", "targetNamespace": "ai", "enabled": True, "local": {
                "engine": "VLLM", "computeTarget": "nvidia-gpu", "url": "hf://fixture/small", "gpuDeployment": "replicated",
                "gpuDevices": [{"uuid": u, "nodeName": "fixture-node", "nodeUid": "fixture-uid"} for u in UUIDS],
                "vramMi": 12000, "memoryRequiredMi": 16400, "cpuOffloading": False,
                "cpuResources": {"requestMillicores": 700, "limitMillicores": 1400}}}}
        devices = [{"uuid": u, "node": "fixture-node", "nodeUid": "fixture-uid", "claimName": "card-" + str(i), "totalMi": 49152}
                   for i, u in enumerate(UUIDS)]
        self.c["NVIDIA_SHARING_STATE"] = {"phase": "Ready", "mode": "dra-shared", "assignments": {"public-model": {**devices[0], "devices": devices}}}
        self.models, self.pods, self.deletes, self.statuses = {}, [], [], []
        self.store = {"data": {"values.json": "{}"}}
        profiles = {"nvidia-gpu": {}, "nvidia-gpu-ollama": {}}
        for engine in ("VLLM", "OLlama"):
            a = copy.deepcopy(self.parent); a["spec"]["local"].update(engine=engine, url="hf://fixture/small" if engine == "VLLM" else "ollama://fixture:small")
            resource, runtime = self.c["kubeai_model_resource"](a, {}, self.catalog)
            profiles[runtime["baseResourceProfile"].split(":")[0]] = {"requests": {"nvidia.com/gpu": "1"}, "limits": {"nvidia.com/gpu": "1"}}
        self.release = {"spec": {"valuesFrom": [{"kind": "ConfigMap", "name": "magicstick-offloading-profiles", "valuesKey": "values.json"}], "values": {"resourceProfiles": profiles}}}
        self.mocks = {"get_resource": lambda group, version, plural, ns, name: self.release if plural == "helmreleases" else self.models.get(name),
            "get_core_resource": lambda *_: self.store, "list_items": self.list_items, "patch_json": self.patch_json,
            "delete_json": lambda path, options: self.deletes.append((path, options)), "apply_resource": self.apply,
            "ensure_ollama_model_alias": lambda *_: (True, "Alias ready")}

    def list_items(self, path):
        items = list(self.models.values()) if "/models?" in path else self.pods
        selector = urllib.parse.parse_qs(urllib.parse.urlparse(path).query).get("labelSelector", [""])[0]
        return [i for i in items if all(i.get("metadata", {}).get("labels", {}).get(k) == v for k, v in
                                      (part.split("=", 1) for part in selector.split(",") if "=" in part))]

    def patch_json(self, path, payload):
        if "/configmaps/" in path:
            self.store.update(payload)
        else:
            self.statuses.append(payload)

    def apply(self, resource):
        name = resource["metadata"]["name"]
        stored = copy.deepcopy(resource)
        stored["metadata"].update(uid=name + "-uid", resourceVersion="2", generation=1)
        stored["status"] = self.models.get(name, {}).get("status", {"replicas": {"ready": 0, "all": 0}})
        self.models[name] = stored
        return stored

    def reconcile(self):
        runtime = {}
        with patch.dict(self.c, self.mocks):
            state = self.c["reconcile_model_replicas"](self.parent, {}, self.catalog, runtime)
        return state, runtime

    def ready_pods(self):
        self.pods = []
        for model in self.models.values():
            model["status"] = {"replicas": {"ready": 1, "all": 1}}
            meta = model["metadata"]
            self.pods.append({"metadata": {"name": meta["name"] + "-pod", "namespace": "ai", "labels": {**meta["labels"], "app": "model", "model": meta["name"]},
                "ownerReferences": [{"apiVersion": "kubeai.org/v1", "kind": "Model", "name": meta["name"], "uid": meta["uid"], "controller": True}]},
                "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}})

    def test_two_and_four_copies_for_both_engines_have_separate_claims_and_full_budgets(self):
        for engine in ("VLLM", "OLlama"):
            for count in (2, 4):
                with self.subTest(engine=engine, count=count):
                    self.models, self.pods = {}, []
                    self.parent["spec"]["local"].update(engine=engine, url="hf://fixture/small" if engine == "VLLM" else "ollama://fixture:small",
                        gpuDevices=[{"uuid": u, "nodeName": "fixture-node", "nodeUid": "fixture-uid"} for u in UUIDS[:count]])
                    assignment = self.c["NVIDIA_SHARING_STATE"]["assignments"]["public-model"]
                    # Keep all cards available, but admit only the selected group.
                    all_devices = [{"uuid": u, "node": "fixture-node", "nodeUid": "fixture-uid", "claimName": "card-" + str(i), "totalMi": 49152} for i, u in enumerate(UUIDS)]
                    assignment["devices"] = all_devices[:count]
                    state, runtime = self.reconcile()
                    self.assertEqual(state[0], "Starting"); self.assertEqual(len(self.models), count)
                    claims = []
                    for model in self.models.values():
                        spec, meta = model["spec"], model["metadata"]
                        self.assertLessEqual(len(meta["name"]), 40)
                        self.assertEqual(meta["labels"]["appliance.magicstick.dev/activation-uid"], "parent-uid")
                        self.assertEqual((spec["minReplicas"], spec["maxReplicas"], spec["env"]["MAGICSTICK_GPU_COUNT"]), (1, 1, "1"))
                        self.assertNotIn("MAGICSTICK_VLLM_PARALLELISM", spec["env"])
                        if engine == "OLlama": self.assertEqual(spec["env"]["OLLAMA_SCHED_SPREAD"], "false")
                        claims.append(spec["env"]["MAGICSTICK_DRA_CLAIMS"])
                        profile = json.loads(self.store["data"]["values.json"])["resourceProfiles"][spec["resourceProfile"].split(":")[0]]
                        self.assertEqual(profile["requests"]["memory"], "16400Mi")
                        self.assertEqual(profile["limits"]["memory"], "16400Mi")
                        self.assertEqual(profile["requests"]["cpu"], "700m")
                        self.assertEqual(profile["limits"]["cpu"], "1400m")
                    self.assertEqual(sorted(claims), ["card-" + str(i) for i in range(count)])
                    self.ready_pods(); state, runtime = self.reconcile()
                    self.assertEqual(state[0], "Ready"); self.assertEqual(runtime["replication"]["ready"], count)
                    self.assertEqual(len(self.models), count)  # Reconciliation is idempotent.

    def test_partial_failure_keeps_healthy_copies_and_does_not_trust_stale_ready_counts(self):
        self.reconcile(); self.ready_pods()
        self.pods[0]["status"] = {"phase": "Running", "containerStatuses": [{"name": "server", "restartCount": 5,
            "state": {"waiting": {"reason": "CrashLoopBackOff"}}, "lastState": {"terminated": {"exitCode": 1}}}]}
        state, runtime = self.reconcile()
        self.assertEqual(state[:2], ("Degraded", "ModelReplicaFailed"))
        self.assertEqual(runtime["replication"]["ready"], 3)
        self.assertEqual(runtime["replication"]["instances"][0]["reason"], "ModelRuntimeCrashLoop")

    def test_generation_change_drains_all_copies_before_replacement_and_checks_delete_identity(self):
        self.reconcile(); self.ready_pods(); self.parent["metadata"]["generation"] += 1
        state, _ = self.reconcile()
        self.assertEqual(state[1], "ReplacingReplicas"); self.assertEqual(len(self.deletes), 4)
        self.assertTrue(all(p["propagationPolicy"] == "Foreground" and p["preconditions"].get("uid") and p["preconditions"].get("resourceVersion") for _, p in self.deletes))
        self.models.clear(); state, _ = self.reconcile()
        self.assertEqual(state[1], "ReplacingReplicas"); self.assertFalse(self.models)
        self.pods.clear(); self.reconcile(); self.assertEqual(len(self.models), 4)

    def test_removal_waits_for_owned_terminating_pods_and_preserves_foreign_resources(self):
        self.reconcile(); self.ready_pods()
        foreign = copy.deepcopy(next(iter(self.models.values())))
        foreign["metadata"]["name"] = "foreign-copy"; foreign["metadata"]["labels"]["appliance.magicstick.dev/activation-uid"] = "other"
        self.models["foreign-copy"] = foreign
        with patch.dict(self.c, self.mocks):
            self.assertTrue(self.c["retire_model_replicas"](self.parent))
            self.assertEqual(len(self.deletes), 4)
            self.models.clear(); self.pods[0]["metadata"]["deletionTimestamp"] = "now"
            self.assertTrue(self.c["retire_model_replicas"](self.parent))
            self.pods.clear(); self.assertFalse(self.c["retire_model_replicas"](self.parent))

    def test_parent_stop_start_and_delete_wait_for_all_copies_without_losing_saved_intent(self):
        self.c["NVIDIA_SHARING_STATE"]["allocationBackend"] = "dra"
        removed_finalizers = []
        mocks = {**self.mocks, "crd_exists": lambda *_: True, "ensure_model_finalizer": lambda *_: None,
            "remove_model_finalizer": lambda a: removed_finalizers.append(a["metadata"]["uid"]),
            "delete_local_runtime": lambda *_: False, "model_required_modules": lambda *_args, **_kwargs: [],
            "ensure_model_module_activations": lambda *_: None, "compute_target_capacity": lambda *_: 4}
        def reconcile_parent():
            with patch.dict(self.c, mocks):
                phase, payload = self.c["reconcile_model_activation"](self.parent, {}, {}, self.catalog)
            self.parent["status"] = self.statuses[-1]["status"]
            return phase, payload

        saved = copy.deepcopy(self.parent["spec"]["local"])
        self.assertEqual(reconcile_parent()[0], "Starting")
        self.ready_pods(); self.assertEqual(reconcile_parent()[0], "Ready")
        self.parent["spec"]["enabled"] = False; self.parent["metadata"]["generation"] += 1
        self.assertEqual(reconcile_parent()[0], "Removing")
        self.models.clear(); self.pods[0]["metadata"]["deletionTimestamp"] = "now"
        self.assertEqual(reconcile_parent()[0], "Removing")
        self.pods.clear(); self.assertEqual(reconcile_parent()[0], "Disabled")
        self.assertIsNone(self.parent["status"]["replication"])
        self.assertEqual(removed_finalizers, [])
        self.parent["spec"]["enabled"] = True; self.parent["metadata"]["generation"] += 1
        self.assertEqual(reconcile_parent()[0], "Starting")
        self.ready_pods(); self.assertEqual(reconcile_parent()[0], "Ready")
        self.assertEqual(self.parent["spec"]["local"], saved)
        self.parent["metadata"]["deletionTimestamp"] = "now"
        self.assertEqual(reconcile_parent()[0], "Removing"); self.assertEqual(removed_finalizers, [])
        self.models.clear(); self.pods.clear(); self.assertEqual(reconcile_parent()[0], "Disabled")
        self.assertEqual(removed_finalizers, ["parent-uid"])

    def test_returning_to_split_waits_for_children_even_when_parent_status_was_lost(self):
        self.reconcile(); self.ready_pods()
        self.parent["spec"]["local"]["gpuDeployment"] = "split"
        self.parent["metadata"]["generation"] += 1
        self.c["NVIDIA_SHARING_STATE"]["allocationBackend"] = "dra"
        with patch.dict(self.c, {**self.mocks, "crd_exists": lambda *_: True,
                "ensure_model_finalizer": lambda *_: None, "model_required_modules": lambda *_args, **_kwargs: [],
                "ensure_model_module_activations": lambda *_: None}):
            phase, _ = self.c["reconcile_model_activation"](self.parent, {}, {}, self.catalog)
            self.assertEqual(phase, "Starting")
            self.assertEqual(self.statuses[-1]["status"]["conditions"][0]["reason"], "RetiringReplicas")
            self.assertEqual(len(self.deletes), 4)
            self.assertNotIn("public-model", self.models)

    def test_foreign_child_collision_is_not_adopted(self):
        child = self.c["replica_model_resources"](self.parent, {}, self.catalog)[0][0]
        child["metadata"]["labels"]["appliance.magicstick.dev/activation-uid"] = "foreign"
        self.models[child["metadata"]["name"]] = child
        with self.assertRaisesRegex(ValueError, "foreign resource"):
            self.reconcile()

    def test_replication_rejects_split_strategy_and_missing_parent_identity(self):
        self.parent["spec"]["local"]["vllm"] = {"parallelism": "tensor"}
        with self.assertRaises(ValueError): self.c["kubeai_model_resource"](self.parent, {}, self.catalog)
        del self.parent["spec"]["local"]["vllm"]; del self.parent["metadata"]["uid"]
        with self.assertRaises(ValueError): self.c["kubeai_model_resource"](self.parent, {}, self.catalog)

    def test_partial_running_group_reserves_remaining_card_slots(self):
        fixture = test_nvidia_dra.NvidiaDraTests(); fixture.setUp()
        group = fixture.group(range(4)); group["spec"]["local"]["gpuDeployment"] = "replicated"
        running = [fixture.pod(card=1), fixture.pod(card=3)]
        for limit in (1, 4):
            assigned, errors = self.c["nvidia_dra_assignments"]([group], fixture.devices, running, limit)
            self.assertFalse(errors)
            self.assertEqual(list(self.c["nvidia_dra_slot_usage"](assigned, fixture.devices, running).values()), [1, 1, 1, 1])
