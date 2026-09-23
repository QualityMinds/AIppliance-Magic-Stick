import unittest
from unittest.mock import patch

from test_dashboard_api import load_server


def node(name="example-node", amd=1, nvidia=2, labels=None):
    return {"metadata": {"name": name, "uid": name + "-uid", "labels": {
        "nvidia.com/gpu.count": "1", "nvidia.com/gpu.replicas": "2", **(labels or {})}},
        "status": {"nodeInfo": {"architecture": "amd64"}, "allocatable": {"amd.com/gpu": str(amd), "nvidia.com/gpu": str(nvidia)}}}


def model(name="example-model", target="amd-gpu", **spec):
    return {"metadata": {"name": name}, "spec": {"type": "local", "targetNamespace": "ai", "local": {"computeTarget": target}, **spec}}


def pod(name="example-model", target="amd-gpu", node_name="example-node", phase="Running", managed=True):
    labels = {"appliance.magicstick.dev/modelactivation": name, "appliance.magicstick.dev/compute-target": target,
              "app.kubernetes.io/managed-by": "kubeai"} if managed else {}
    resource = {"amd-gpu": "amd.com/gpu", "nvidia-gpu": "nvidia.com/gpu"}[target]
    return {"metadata": {"name": name + "-pod", "namespace": "ai", "labels": labels},
            "spec": {"nodeName": node_name, "containers": [{"resources": {"limits": {resource: "1"}}}]}, "status": {"phase": phase}}


class GpuSlotsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()

    def setUp(self):
        self.catalog = {"targets": {target: {"kind": "gpu", "resourceNames": [resource], "engines": ["OLlama", "VLLM"]}
                                   for target, resource in (("amd-gpu", "amd.com/gpu"), ("nvidia-gpu", "nvidia.com/gpu"))}}

    def summary(self, models=(), pods=(), nodes=None, sharing=None, **kwargs):
        return self.api["gpu_slot_summary"](models, nodes=nodes if nodes is not None else [node()],
                                            catalog=self.catalog, pods=pods, sharing=sharing or {}, **kwargs)

    def test_mixed_host_models_and_pods_are_not_double_counted(self):
        summary = self.summary([model()], [pod()])
        self.assertEqual((summary["amd-gpu"]["total"], summary["amd-gpu"]["used"], summary["amd-gpu"]["free"]), (1, 1, 0))
        self.assertEqual((summary["nvidia-gpu"]["total"], summary["nvidia-gpu"]["free"]), (2, 2))
        self.assertEqual(summary["nvidia-gpu"]["nodes"][0]["mode"], "time-slicing")

    def test_pending_model_reserves_slot_before_pod_exists(self):
        for pods in ([], [pod(phase="Pending", node_name="")]):
            with self.subTest(pods=pods):
                result = self.summary([model()], pods)["amd-gpu"]
                self.assertEqual((result["used"], result["free"], result["queued"]), (1, 0, 0))
                self.assertEqual(result["nodes"][0]["free"], 0)

    def test_unmanaged_workload_and_starting_model_fill_nvidia_slots(self):
        result = self.summary([model(target="nvidia-gpu")], [pod("other", target="nvidia-gpu", managed=False)])["nvidia-gpu"]
        self.assertEqual((result["used"], result["free"]), (2, 0))

    def test_completed_pods_and_disabled_or_deleted_intent_do_not_reserve(self):
        deleted = model(); deleted["metadata"]["deletionTimestamp"] = "2026-01-01T00:00:00Z"
        self.assertEqual(self.summary([model(enabled=False), deleted], [pod(phase="Succeeded"), pod(phase="Failed")])["amd-gpu"]["free"], 1)
        # A terminating but not yet stopped pod still occupies its slot.
        stopping = pod(); stopping["metadata"]["deletionTimestamp"] = "2026-01-01T00:00:00Z"
        self.assertEqual(self.summary([deleted], [stopping])["amd-gpu"]["free"], 0)

    def test_retrying_failed_enabled_model_keeps_its_reservation(self):
        result = self.summary([model()], [pod(phase="Failed")])["amd-gpu"]
        self.assertEqual((result["free"], result["used"]), (0, 1))

    def test_multiple_replicas_and_rollout_overlap_are_not_underreported(self):
        resource = model(target="nvidia-gpu", local={"computeTarget": "nvidia-gpu", "maxReplicas": 2})
        self.assertEqual(self.summary([resource], [pod(target="nvidia-gpu")])["nvidia-gpu"]["free"], 0)
        self.assertEqual(self.summary([model(target="nvidia-gpu")], [pod(target="nvidia-gpu"), pod(target="nvidia-gpu")])["nvidia-gpu"]["used"], 2)

    def test_dra_uses_ready_identity_bound_limit_not_extended_resource(self):
        dra_node = node(amd=0, labels={"appliance.magicstick.dev/amd-dra-ready": "true"})
        sharing = {"mode": "shared", "phase": "Ready", "nodeUid": "example-node-uid", "nodeName": "example-node", "maxModels": 3, "claimName": "example-claim"}
        dra_pod = pod(); dra_pod["spec"]["containers"] = []
        dra_pod["spec"]["resourceClaims"] = [{"name": "gpu", "resourceClaimName": "example-claim"}]
        result = self.summary([model()], [dra_pod], [dra_node], sharing)["amd-gpu"]
        self.assertEqual((result["total"], result["used"], result["free"]), (3, 1, 2))
        for change in ({"phase": "Switching"}, {"nodeUid": "old-uid"}, {"claimName": ""}):
            with self.subTest(change=change):
                self.assertEqual(self.summary(nodes=[dra_node], sharing={**sharing, **change})["amd-gpu"]["total"], 0)

    def test_omni_dra_intent_and_direct_pod_share_one_slot_with_other_engines(self):
        dra_node = node(amd=0, labels={"appliance.magicstick.dev/amd-dra-ready": "true"})
        sharing = {"mode": "shared", "phase": "Ready", "nodeUid": "example-node-uid", "nodeName": "example-node",
                   "maxModels": 3, "claimName": "example-claim"}
        omni = model("omni", local={"computeTarget": "amd-gpu", "engine": "VLLM",
                                   "realtime": {"gpuNode": "example-node", "gpuCount": 1}})
        omni_pod = pod("omni")
        omni_pod["metadata"]["labels"].update({"app.kubernetes.io/managed-by": "magicstick-operator",
                                            "appliance.magicstick.dev/runtime-backend": "vllm-omni"})
        omni_pod["spec"]["containers"] = [{"resources": {"claims": [{"name": "gpu"}]}}]
        omni_pod["spec"]["resourceClaims"] = [{"name": "gpu", "resourceClaimName": "example-claim"}]
        other = model("ollama", local={"computeTarget": "amd-gpu", "engine": "OLlama"})
        for pods in ([], [omni_pod]):
            with self.subTest(pods=pods):
                result = self.summary([omni, other], pods, [dra_node], sharing)["amd-gpu"]
                self.assertEqual((result["total"], result["used"], result["free"]), (3, 2, 1))
                edited = self.summary([omni, other], pods, [dra_node], sharing, exclude_model=("ai", "omni"))["amd-gpu"]
                self.assertEqual(edited["free"], 2)

    def test_requests_and_sidecar_init_containers_follow_scheduler_peak(self):
        workload = pod(target="nvidia-gpu")
        workload["spec"]["initContainers"] = [
            {"restartPolicy": "Always", "resources": {"requests": {"nvidia.com/gpu": "1"}}},
            {"resources": {"limits": {"nvidia.com/gpu": "2"}}},
        ]
        self.assertEqual(self.api["pod_gpu_slots"](workload, ["nvidia.com/gpu"]), 3)

    def test_engine_counts_respect_node_eligibility(self):
        self.catalog["targets"]["amd-gpu"]["engineProfiles"] = {"VLLM": {"nodeSelector": {"vllm-eligible": "true"}}}
        nodes = [node(labels={"vllm-eligible": "true"}), node("example-second")]
        result = self.summary([model()], [pod()], nodes)["amd-gpu"]
        self.assertEqual(result["free"], 1)
        self.assertEqual(result["engines"]["VLLM"]["free"], 0)
        self.assertEqual(result["engines"]["OLlama"]["free"], 1)

    def test_unknown_placement_is_reserved_once_at_target_and_conservatively_per_node(self):
        result = self.summary([model()], nodes=[node(), node("example-second")])["amd-gpu"]
        self.assertEqual((result["total"], result["used"], result["free"]), (2, 1, 1))
        self.assertEqual([pool["free"] for pool in result["nodes"]], [0, 0])

    def test_attach_does_not_invent_which_identical_gpu_received_a_pod(self):
        memory = {"devices": [{"kind": "gpu", "computeTarget": "nvidia-gpu", "nodes": ["example-node"]} for _ in range(2)]}
        targets = {"targets": [{"id": "nvidia-gpu", "engineAvailability": {"VLLM": {"available": True}}}]}
        self.api["attach_gpu_slots"](memory, targets, self.summary())
        self.assertTrue(all(item["slots"]["scope"] == "node" for item in memory["devices"]))
        self.assertEqual(targets["targets"][0]["engineAvailability"]["VLLM"]["slots"]["free"], 2)
        memory["devices"].pop()
        self.api["attach_gpu_slots"](memory, targets, self.summary())
        self.assertEqual(memory["devices"][0]["slots"]["scope"], "device")

    def test_existing_model_update_can_reuse_its_own_slot(self):
        self.assertEqual(self.summary([model()], [pod()], exclude_model=("ai", "example-model"))["amd-gpu"]["free"], 1)
        self.assertEqual(self.summary([model()], [pod()], exclude_model=("other-namespace", "example-model"))["amd-gpu"]["free"], 0)

    def test_server_guard_blocks_full_gpu_even_with_memory_risk_accepted(self):
        resource = model("new-model", local={"computeTarget": "amd-gpu", "allowMemoryRisk": True})
        with patch.dict(self.api, {"model_activations": lambda: [model()], "ready_schedulable_nodes": lambda: [node()],
                                  "compute_target_catalog": lambda: self.catalog, "list_resource": lambda _: [pod()]}):
            with self.assertRaisesRegex(self.api["RequestError"], "No free GPU model slots"):
                self.api["require_gpu_slot_available"](resource)
            self.api["require_gpu_slot_available"](model())
            self.api["require_gpu_slot_available"](model(target="cpu"))
            self.api["require_gpu_slot_available"](model(enabled=False))


if __name__ == "__main__":
    unittest.main()
