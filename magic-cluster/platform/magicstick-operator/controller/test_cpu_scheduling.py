import ast
import copy
import json
import unittest
from unittest.mock import patch

import yaml
from test_controller import load_controller, ROOT, CLUSTER_ROOT


class CpuSchedulingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = load_controller()
        cls.catalog = json.loads(yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        cls.release = yaml.safe_load((CLUSTER_ROOT / "platform/ai/kubeai/base/helmrelease.yaml").read_text())

    def setUp(self):
        self.values = {"resourceProfiles": {}}
        self.writes = []

    def apply_profile(self, name, policy):
        resource = {"spec": {"resourceProfile": name, "env": {"MAGICSTICK_DRA_CLAIM": "example-claim"}}}
        runtime = {"cpuResources": policy}
        def write(_path, body):
            self.writes.append(body)
            self.values = json.loads(body["data"]["values.json"])
        with patch.dict(self.c, {
            "get_resource": lambda *_: self.release,
            "get_core_resource": lambda *_: {"data": {"values.json": json.dumps(self.values)}},
            "patch_json": write,
        }):
            self.c["apply_cpu_resource_profile"](resource, runtime)
        self.assertEqual(resource["spec"]["resourceProfile"], runtime["resourceProfile"])
        key, count = runtime["resourceProfile"].split(":")
        self.assertEqual(count, "1")
        self.assertEqual(resource["spec"]["env"]["MAGICSTICK_DRA_CLAIM"], "example-claim")
        return self.values["resourceProfiles"][key]

    def test_catalog_defaults_and_legacy_fallback_agree(self):
        for engine, kinds in self.catalog["engines"].items():
            for kind, expected in kinds["cpuDefaults"].items():
                target = "cpu" if kind == "cpu" else "amd-gpu"
                with self.subTest(engine=engine, target=target):
                    for catalog in (self.catalog, None):
                        self.assertEqual(self.c["model_cpu_resources"]({}, engine, target, catalog), expected)

    def test_cpu_reservation_does_not_grow_with_memory_for_either_engine(self):
        for engine, memory_limit_factor in (("vllm", 24), ("ollama", 48)):
            for units in (128, 385, 2044, 8192):
                with self.subTest(engine=engine, units=units):
                    policy = self.c["model_cpu_resources"]({}, engine, "cpu", self.catalog)
                    profile = self.apply_profile("magicstick-" + engine + "-cpu-memory:" + str(units), policy)
                    self.assertEqual(profile["requests"], {"cpu": "2000m", "memory": str(units * 16) + "Mi"})
                    self.assertEqual(profile["limits"], {"cpu": "8000m", "memory": str(units * memory_limit_factor) + "Mi"})

    def test_gpu_defaults_keep_devices_and_memory_without_cpu_quota(self):
        for base_name, engine, cpu in (("magicstick-nvidia-gpu", "VLLM", "1000m"),
                                      ("magicstick-amd-gpu", "VLLM", "1000m"),
                                      ("magicstick-intel-xe-gpu", "VLLM", "1000m"),
                                      ("magicstick-ollama-amd-gpu", "OLlama", "500m")):
            with self.subTest(profile=base_name):
                base = self.release["spec"]["values"]["resourceProfiles"][base_name]
                actual = self.apply_profile(base_name + ":1", self.c["model_cpu_resources"]({}, engine, "amd-gpu", self.catalog))
                self.assertEqual(actual["requests"]["cpu"], cpu)
                self.assertNotIn("cpu", actual["limits"])
                for section in ("requests", "limits"):
                    self.assertEqual({k: v for k, v in actual[section].items() if k != "cpu"},
                                     {k: v for k, v in base[section].items() if k != "cpu"})

    def test_final_dra_and_offloading_profile_are_preserved_and_update_is_idempotent(self):
        for device in (None, "nvidia.com/gpu"):
            base = {"imageName": "example-runtime", "nodeSelector": {"kubernetes.io/hostname": "example-node"},
                    "requests": {"cpu": "6", "memory": "34900Mi"}, "limits": {}}
            if device:
                base["requests"][device] = base["limits"][device] = "1"
                base["limits"]["memory"] = "34900Mi"
            self.values["resourceProfiles"]["derived-profile"] = copy.deepcopy(base)
            policy = {"requestMillicores": 750, "limitMillicores": 0}
            actual = self.apply_profile("derived-profile:1", policy)
            expected = copy.deepcopy(base)
            expected["requests"]["cpu"] = "750m"
            self.assertEqual(actual, expected)
            writes = len(self.writes)
            self.apply_profile("derived-profile:1", policy)
            self.assertEqual(len(self.writes), writes)

    def test_override_validation_and_zero_limit(self):
        resolve = self.c["model_cpu_resources"]
        self.assertEqual(resolve({"cpuResources": {"limitMillicores": 0}}, "OLlama", "cpu", self.catalog),
                         {"requestMillicores": 2000, "limitMillicores": 0})
        for value in (False, [], {"threads": 4}, {"requestMillicores": 0}, {"requestMillicores": True},
                      {"limitMillicores": -1}, {"limitMillicores": 0.5}, {"requestMillicores": 5000, "limitMillicores": 4000},
                      {"limitMillicores": 1000}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                resolve({"cpuResources": value}, "OLlama", "cpu", self.catalog)

    def test_api_and_controller_share_identical_validation_contract(self):
        source = yaml.safe_load((CLUSTER_ROOT / "apps/dashboard/dashboard-api.yaml").read_text())["data"]["server.py"]
        controller = yaml.safe_load((ROOT / "controller-configmap.yaml").read_text())["data"]["controller.py"]
        def function(text):
            return next(node for node in ast.parse(text).body if isinstance(node, ast.FunctionDef) and node.name == "model_cpu_resources")
        self.assertEqual(ast.dump(function(source)), ast.dump(function(controller)))

    def test_unschedulable_cpu_detail_is_visible_in_model_status(self):
        pods = [{"metadata": {"name": "example-model"}, "status": {"phase": "Pending", "conditions": [
            {"type": "PodScheduled", "status": "False", "reason": "Unschedulable", "message": "0/1 nodes are available: 1 Insufficient cpu."}]}}]
        with patch.dict(self.c, {"list_items": lambda *_: pods}):
            tracker, state = self.c["model_pod_creation_status"]({}, {}, "ai", "example-model")
        self.assertIsNone(tracker)
        self.assertEqual(state[:2], ("Starting", "Unschedulable"))
        self.assertIn("Insufficient cpu", state[2])
