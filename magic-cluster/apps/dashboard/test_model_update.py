import unittest
import urllib.error
from unittest.mock import patch

from test_dashboard_api import load_server


def local_activation():
    return {
        "metadata": {"name": "qwen", "resourceVersion": "17"},
        "spec": {
            "type": "local",
            "enabled": True,
            "targetNamespace": "ai",
            "local": {
                "url": "hf://Qwen/Qwen3.5-27B",
                "engine": "VLLM",
                "computeTarget": "nvidia-gpu",
                "modelType": "chat",
                "contextWindow": 4096,
                "maxNumSeqs": 1,
                "kvCacheType": "auto",
                "vram": "8Gi",
                "features": ["custom-feature"],
            },
        },
    }


class ModelUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = load_server()

    def test_local_update_is_revision_bound_and_preserves_identity(self):
        calls = []

        def request_json(method, path, body=None, content_type=None):
            calls.append((method, path, body, content_type))
            return body

        with patch.dict(self.api, {
            "model_activation": lambda _name: local_activation(),
            "model_activations": lambda: [],
            "compute_target_catalog": lambda: {"targets": {"nvidia-gpu": {"kind": "gpu"}}},
            "gpu_slot_summary": lambda *_args, **_kwargs: {},
            "request_json": request_json,
        }):
            result = self.api["update_model_activation"]("qwen", {
                "expectedRevision": "17",
                "local": {"contextWindow": 8192, "vramMi": 12288},
            })

        self.assertEqual(calls[-1][0], "PATCH")
        self.assertTrue(calls[-1][1].endswith("/modelactivations/qwen"))
        self.assertEqual(calls[-1][3], "application/merge-patch+json")
        self.assertEqual(result["metadata"]["resourceVersion"], "17")
        updated = result["spec"]["local"]
        self.assertEqual(updated["url"], "hf://Qwen/Qwen3.5-27B")
        self.assertEqual(updated["engine"], "VLLM")
        self.assertEqual(updated["computeTarget"], "nvidia-gpu")
        self.assertEqual(updated["features"], ["custom-feature"])
        self.assertEqual(updated["contextWindow"], 8192)
        self.assertEqual(updated["vramMi"], 12288)
        self.assertNotIn("vram", updated)

    def test_cpu_edit_preserves_memory_and_can_restore_automatic_defaults(self):
        current = local_activation()
        with patch.dict(self.api, {
            "model_activation": lambda _: current,
            "model_activations": lambda: [],
            "compute_target_catalog": lambda: {"targets": {"nvidia-gpu": {"kind": "gpu"}}},
            "gpu_slot_summary": lambda *_args, **_kwargs: {},
            "request_json": lambda _method, _path, body, *_args, **_kwargs: body,
        }):
            updated = self.api["update_model_activation"]("qwen", {
                "expectedRevision": "17", "local": {"cpuResources": {"requestMillicores": 750, "limitMillicores": 0}}})
            self.assertEqual(updated["spec"]["local"]["vram"], "8Gi")
            self.assertEqual(updated["spec"]["local"]["cpuResources"], {"requestMillicores": 750, "limitMillicores": 0})
            current["spec"]["local"]["cpuResources"] = updated["spec"]["local"]["cpuResources"]
            reset = self.api["update_model_activation"]("qwen", {"expectedRevision": "17", "local": {"cpuResources": None}})
            self.assertIsNone(reset["spec"]["local"].get("cpuResources"))

    def test_invalid_cpu_policy_is_rejected_before_creating_a_runtime(self):
        with patch.dict(self.api, {"compute_target_catalog": lambda: {}}):
            with self.assertRaisesRegex(ValueError, "CPU limit"):
                self.api["model_activation_payload"]("local", {"name": "example", "local": {
                    "cpuResources": {"requestMillicores": 1000, "limitMillicores": 500}}})

    def test_stale_revision_and_identity_changes_are_rejected(self):
        with patch.dict(self.api, {"model_activation": lambda _name: local_activation()}):
            with self.assertRaisesRegex(self.api["RequestError"], "changed after") as stale:
                self.api["update_model_activation"]("qwen", {"expectedRevision": "16", "local": {"contextWindow": 8192}})
            self.assertEqual(stale.exception.status, 409)
            with self.assertRaisesRegex(self.api["RequestError"], "unsupported field: engine") as immutable:
                self.api["update_model_activation"]("qwen", {"expectedRevision": "17", "local": {"engine": "OLlama"}})
            self.assertEqual(immutable.exception.status, 400)

    def test_generation_revision_accepts_status_updates_but_rejects_spec_or_identity_changes(self):
        current = local_activation()
        current["metadata"].update(uid="example-model-uid", generation=3, resourceVersion="29")
        with patch.dict(self.api, {
            "model_activation": lambda _: current,
            "model_activations": lambda: [],
            "compute_target_catalog": lambda: {"targets": {"nvidia-gpu": {"kind": "gpu"}}},
            "gpu_slot_summary": lambda *_args, **_kwargs: {},
            "request_json": lambda _method, _path, body, *_args: body,
        }):
            result = self.api["update_model_activation"]("qwen", {
                "expectedRevision": "generation:example-model-uid:3", "local": {"contextWindow": 8192},
            })
            self.assertEqual(result["metadata"]["resourceVersion"], "29")
            for stale in ("generation:example-model-uid:2", "generation:old-model-uid:3"):
                with self.subTest(stale=stale), self.assertRaisesRegex(self.api["RequestError"], "changed after"):
                    self.api["update_model_activation"]("qwen", {"expectedRevision": stale, "local": {}})

    def test_status_only_patch_conflict_retries_once_with_fresh_atomic_revision(self):
        original = local_activation()
        original["metadata"].update(uid="example-model-uid", generation=3)
        latest = {**original, "metadata": {**original["metadata"], "resourceVersion": "29"}}
        patch_body = {"metadata": {"resourceVersion": "17"}, "spec": {"enabled": False}}
        calls = []

        def request_json(_method, _path, body, _content_type):
            calls.append(body)
            if len(calls) == 1:
                raise urllib.error.HTTPError("https://example.com", 409, "Conflict", {}, None)
            return body

        with patch.dict(self.api, {"model_activation": lambda _: latest, "request_json": request_json}):
            result = self.api["patch_model_configuration"]("qwen", "/models/qwen", patch_body, original)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result, {"metadata": {"resourceVersion": "29"}, "spec": {"enabled": False}})
        self.assertEqual(patch_body["metadata"]["resourceVersion"], "17")

    def test_patch_conflict_never_retries_a_concurrent_spec_edit(self):
        original = local_activation()
        original["metadata"].update(uid="example-model-uid", generation=3)
        latest = {**original, "metadata": {**original["metadata"], "generation": 4, "resourceVersion": "29"}}
        with patch.dict(self.api, {"model_activation": lambda _: latest}), patch.dict(self.api, {
            "request_json": lambda *_args: (_ for _ in ()).throw(
                urllib.error.HTTPError("https://example.com", 409, "Conflict", {}, None)),
        }):
            with self.assertRaisesRegex(self.api["RequestError"], "changed after"):
                self.api["patch_model_configuration"]("qwen", "/models/qwen", {
                    "metadata": {"resourceVersion": "17"}, "spec": {"enabled": False},
                }, original)

    def test_edit_estimate_excludes_the_current_reservation(self):
        seen = {}

        def estimate(payload, exclude_model=""):
            seen.update({"payload": payload, "exclude": exclude_model})
            return {"minimumMi": 1000, "recommendedMi": 1200}

        with patch.dict(self.api, {
            "model_activation": lambda _name: local_activation(),
            "estimate_model_memory": estimate,
        }):
            result = self.api["estimate_model_update"]("qwen", {"contextWindow": 16384})

        self.assertEqual(result["minimumMi"], 1000)
        self.assertEqual(seen["exclude"], "qwen")
        self.assertEqual(seen["payload"]["contextWindow"], 16384)
        self.assertEqual(seen["payload"]["url"], "hf://Qwen/Qwen3.5-27B")

    def test_external_update_keeps_the_existing_secret(self):
        existing = {
            "metadata": {"name": "provider", "resourceVersion": "8"},
            "spec": {
                "type": "external", "enabled": True, "targetNamespace": "ai",
                "external": {
                    "model": "provider/old", "apiBase": "https://provider.test/v1",
                    "modelType": "chat", "apiKeySecretRef": {"name": "provider-key", "key": "api-key"},
                },
            },
        }
        calls = []
        with patch.dict(self.api, {
            "model_activation": lambda _name: existing,
            "request_json": lambda method, path, body=None, content_type=None: calls.append((method, body)) or body,
        }):
            result = self.api["update_model_activation"]("provider", {
                "expectedRevision": "8", "external": {"model": "provider/new", "contextWindow": 32000},
            })

        self.assertEqual(calls[-1][0], "PATCH")
        updated = result["spec"]["external"]
        self.assertEqual(updated["model"], "provider/new")
        self.assertEqual(updated["contextWindow"], 32000)
        self.assertEqual(updated["apiKeySecretRef"], {"name": "provider-key", "key": "api-key"})

    def test_external_key_replacement_switches_revision_bound_secret(self):
        existing = {
            "metadata": {"name": "provider", "resourceVersion": "8"},
            "spec": {"type": "external", "targetNamespace": "ai", "external": {
                "model": "provider/model", "apiBase": "https://provider.test/v1",
                "apiKeySecretRef": {"name": "ai-model-provider-provider", "key": "api-key"},
            }},
        }
        created, deleted = [], []
        old_secret = {"metadata": {"labels": {
            "app.kubernetes.io/managed-by": "ai-appliance-dashboard",
            "appliance.magicstick.dev/modelactivation": "provider",
        }}}
        with patch.object(self.api["secrets"], "token_hex", return_value="abcd1234"), patch.dict(self.api, {
            "model_activation": lambda _name: existing,
            "create_provider_secret": lambda model, key, secret="": created.append((model, key, secret)) or {"name": secret, "key": "api-key"},
            "request_json": lambda _method, _path, body=None, _content_type=None: body,
            "get_resource": lambda _path: old_secret,
            "delete_json": lambda path: deleted.append(path) or {},
        }):
            result = self.api["update_model_activation"]("provider", {
                "expectedRevision": "8", "external": {}, "apiKey": "replacement-key",
            })

        replacement = "ai-model-provider-provider-abcd1234"
        self.assertEqual(created, [("provider", "replacement-key", replacement)])
        self.assertEqual(result["spec"]["external"]["apiKeySecretRef"]["name"], replacement)
        self.assertTrue(deleted[-1].endswith("/secrets/ai-model-provider-provider"))

    def test_update_route_requires_operator_and_csrf(self):
        roles, checks, responses = [], [], []
        handler = self.api["Handler"].__new__(self.api["Handler"])
        handler.path = "/api/models/qwen"
        handler.headers = {}
        handler.handle_instance_guard = lambda: False
        handler.require_access = lambda role: roles.append(role) or {}
        handler.send_json = lambda payload, status=200: responses.append((payload, status))
        handler.send_auth_error = self.fail
        handler.send_error_json = lambda status, message: self.fail(f"{status}: {message}")
        with patch.dict(self.api, {
            "validate_dashboard_mutation_request": lambda _handler: checks.append("csrf"),
            "read_body": lambda _handler: {"expectedRevision": "17", "local": {"contextWindow": 8192}},
            "update_model_activation": lambda name, payload: {"name": name, "payload": payload},
        }):
            handler.do_PUT()

        self.assertEqual(roles, ["operator"])
        self.assertEqual(checks, ["csrf"])
        self.assertEqual(responses[0][0]["name"], "qwen")


if __name__ == "__main__":
    unittest.main()
