import unittest
import urllib.parse
from unittest.mock import patch

import yaml

from test_dashboard_api import ROOT, load_server


def activation(name="qwen", model_type="local", namespace="ai"):
    return {
        "metadata": {"name": name},
        "spec": {"type": model_type, "targetNamespace": namespace, "local": {"engine": "VLLM"}},
    }


def pod(name="qwen-pod", model="qwen", owned=True):
    return {
        "metadata": {
            "name": name,
            "namespace": "ai",
            "creationTimestamp": "2026-09-19T10:00:00Z",
            "labels": {"app": "model", "model": model},
            "ownerReferences": ([{
                "apiVersion": "kubeai.org/v1", "kind": "Model", "name": model, "controller": True,
            }] if owned else []),
        },
        "spec": {
            "nodeName": "worker-1",
            "initContainers": [{"name": "download"}],
            "containers": [{"name": "server"}],
        },
        "status": {
            "phase": "Running",
            "initContainerStatuses": [{
                "name": "download", "ready": True, "restartCount": 0,
                "state": {"terminated": {"reason": "Completed"}},
            }],
            "containerStatuses": [{
                "name": "server", "ready": True, "restartCount": 1,
                "state": {"running": {}},
            }],
        },
    }


class ModelLogsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()

    def test_logs_are_resolved_from_the_local_activation_and_owned_pods(self):
        paths = []
        accepts = []

        def request_text(_method, path, accept="text/plain"):
            paths.append(path)
            accepts.append(accept)
            return "\x1b[31mready\x1b[0m\rnext\x00"

        with patch.dict(self.api, {
            "model_activation": lambda name: activation(name),
            "list_resource": lambda _path: [pod(), pod("foreign", owned=False), pod("other", model="other")],
            "request_text": request_text,
        }):
            result = self.api["model_runtime_logs"]("qwen", {"tailLines": ["250"]})

        self.assertEqual(result["model"], "qwen")
        self.assertEqual(result["namespace"], "ai")
        self.assertEqual(result["tailLines"], 250)
        self.assertEqual([item["name"] for item in result["pods"]], ["qwen-pod"])
        self.assertEqual([item["name"] for item in result["pods"][0]["containers"]], ["download", "server"])
        self.assertEqual(len(result["pods"][0]["containers"][1]["logs"]), 2)
        self.assertEqual(result["pods"][0]["containers"][1]["logs"][0]["text"], "ready\nnext")
        self.assertEqual(set(accepts), {"*/*"})
        self.assertTrue(any("previous=true" in path for path in paths))
        parsed = urllib.parse.urlparse(paths[0])
        self.assertEqual(parsed.path.split("/")[4:7], ["ai", "pods", "qwen-pod"])
        self.assertEqual(urllib.parse.parse_qs(parsed.query)["tailLines"], ["250"])

    def test_tail_is_bounded_and_missing_output_does_not_fail_the_dialog(self):
        error = urllib.error.HTTPError("https://kubernetes.test", 400, "Bad Request", {}, None)
        with patch.dict(self.api, {
            "model_activation": lambda _name: activation(),
            "list_resource": lambda _path: [pod()],
            "request_text": lambda *_args: (_ for _ in ()).throw(error),
        }):
            result = self.api["model_runtime_logs"]("qwen", {"tailLines": ["999999"]})
        self.assertEqual(result["tailLines"], self.api["MODEL_LOG_MAX_TAIL_LINES"])
        self.assertEqual(result["pods"][0]["containers"][0]["logs"][0]["error"], "Container output is not available yet.")
        self.assertEqual(result["pods"][0]["containers"][1]["logs"][1]["error"], "Previous container output is no longer available.")

    def test_arbitrary_pods_and_external_models_cannot_be_requested(self):
        with patch.dict(self.api, {"model_activation": lambda _name: None}):
            with self.assertRaisesRegex(self.api["RequestError"], "not found") as missing:
                self.api["model_runtime_logs"]("qwen")
        self.assertEqual(missing.exception.status, 404)
        with patch.dict(self.api, {"model_activation": lambda _name: activation(model_type="external")}):
            with self.assertRaisesRegex(self.api["RequestError"], "External models") as external:
                self.api["model_runtime_logs"]("qwen")
        self.assertEqual(external.exception.status, 409)
        with self.assertRaisesRegex(self.api["RequestError"], "DNS-1123"):
            self.api["model_runtime_logs"]("../../secrets")

    def test_endpoint_is_admin_only_and_rbac_only_adds_log_reading(self):
        self.assertEqual(self.api["required_get_access"](["api", "models", "qwen", "logs"]), "admin")
        role = yaml.safe_load((ROOT / "clusterrole.yaml").read_text(encoding="utf-8"))
        rules = [rule for rule in role["rules"] if "pods/log" in rule.get("resources", [])]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["apiGroups"], [""])
        self.assertEqual(rules[0]["verbs"], ["get"])


if __name__ == "__main__":
    unittest.main()
