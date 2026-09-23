import copy
import hashlib
import json
import threading
import unittest
from unittest.mock import patch
import test_support  # noqa: F401

from mesh_service import Identity, MeshError, MeshService, Store, b64, canonical, unb64
from integration import ExportBridge, ModelSync
from server import handler


class Clock:
    def __init__(self):
        self.now = 2000000000
    def __call__(self):
        return self.now


class FakeLiteLLM:
    def __init__(self):
        self.models, self.calls, self.keys = [], [], {}
        self.down = False
    def deployments(self):
        if self.down:
            raise MeshError("LiteLLM unavailable", 503)
        return copy.deepcopy(self.models)
    def admin(self, method, path, body):
        self.calls.append((path, copy.deepcopy(body)))
        if path in {"/model/new", "/model/update"}:
            self.models = [m for m in self.models if m["model_info"]["id"] != body["model_info"]["id"]]
            self.models.append(copy.deepcopy(body))
        elif path == "/model/delete":
            self.models = [m for m in self.models if m["model_info"]["id"] != body["id"]]
        elif path == "/key/delete":
            for key in body["keys"]:
                self.keys.pop(key, None)
        return {}
    def new_key(self, model, config):
        key = "test-only-service-key-" + str(len(self.calls))
        self.keys[key] = [model]
        self.calls.append(("/key/generate", {"models": [model]}))
        return key


class MeshTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.inventory = {"qwen": {"uid": "fixture-uid", "source": "kubeai", "engine": "VLLM", "ready": True}}
        self.a = MeshService(Store(":memory:"), lambda: copy.deepcopy(self.inventory), self.clock)
        self.b = MeshService(Store(":memory:"), lambda: {}, self.clock)
        self.c = MeshService(Store(":memory:"), lambda: {}, self.clock)
        self.a.createMesh("private-test", "stick-a", "https://mesh.example.com", "0" * 64)
        self.a.shareModel("qwen", {"enabled": True})
        self.a.refreshMembership(None)

    def tearDown(self):
        for service in (self.a, self.b, self.c):
            service.store.db.close()

    def join(self, service, role="magic-stick", name="stick-b"):
        invite = self.a.createInvite(role, "test administrator")
        service.joinMesh(invite["token"], name, lambda _mesh, _path, payload: self.a.enroll(payload))
        self.a.refreshMembership(None)
        return invite

    def test_one_time_invite_and_role(self):
        invite = self.join(self.c, "client", "laptop-c")
        self.assertEqual(self.c.getStatus()["node"]["type"], "client")
        with self.assertRaises(MeshError):
            self.b.joinMesh(invite["token"], "stick-b", lambda _m, _p, body: self.a.enroll(body))
        with self.assertRaises(MeshError):
            self.c.createInvite("magic-stick", "client")

    def test_rejoin_requires_fresh_invite_and_preserves_identity(self):
        old = self.join(self.b)
        endpoint = self.b.identity.endpoint
        self.a.revokeNode(endpoint)
        self.b.leaveMesh()
        with self.assertRaises(MeshError):
            self.b.joinMesh(old['token'], 'stick-b', lambda _m, _p, body: self.a.enroll(body))
        self.join(self.b, 'client', 'stick-b')
        self.assertEqual(self.b.identity.endpoint, endpoint)
        self.assertEqual(self.b.getStatus()['node']['type'], 'client')
        self.assertFalse(self.a.store.read()['members'][endpoint]['revoked'])

    def test_join_never_replaces_existing_membership_or_shares(self):
        before = self.a.store.read()
        with self.assertRaises(MeshError) as error:
            self.a.joinMesh('unused-fixture', 'another-stick', lambda *_: self.fail('Must not contact another mesh before leaving'))
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.a.store.read(), before)

    def test_invalid_invitation_does_not_configure_the_appliance(self):
        before = self.b.store.read()
        with self.assertRaises(MeshError):
            self.b.joinMesh('invalid-fixture', 'stick-b', lambda *_: self.fail('Invalid token must not enroll'))
        self.assertEqual(self.b.store.read(), before)
        self.assertFalse(self.b.getStatus()['configured'])

    def test_new_identity_cannot_take_another_nodes_name(self):
        self.join(self.b)
        with self.assertRaises(MeshError):
            self.join(self.c, 'client', 'stick-b')

    def test_laptop_cannot_publish_even_with_valid_signature(self):
        self.join(self.c, "client", "laptop-c")
        body = self.c.memberRequest("/mesh/heartbeat", {"exports": {"share/laptop-c/model": {"enabled": True}}})
        with self.assertRaises(MeshError) as error:
            self.a.heartbeat(body)
        self.assertEqual(error.exception.status, 403)
        with self.assertRaises(MeshError):
            self.c.shareModel("qwen", {"enabled": True})

    def test_invite_tamper_expired_revoked(self):
        invite = self.a.createInvite("client", "admin", 60)
        parsed = json.loads(unb64(invite["token"][8:]))
        parsed["type"] = "magic-stick"
        with self.assertRaises(MeshError):
            self.b.decodeInvite("msmesh1." + b64(canonical(parsed)))
        self.a.revokeInvite(invite["id"])
        with self.assertRaises(MeshError):
            self.b.joinMesh(invite["token"], "client-b", lambda _m, _p, body: self.a.enroll(body))
        self.clock.now += 61
        with self.assertRaises(MeshError):
            self.b.decodeInvite(invite["token"])

    def test_role_not_chosen_by_joining_node(self):
        invite = self.a.createInvite("client", "admin")
        decoded = self.b.decodeInvite(invite["token"])
        body = {"invite": decoded["id"], "secret": decoded["secret"], "endpoint": self.b.identity.endpoint, "name": "client-b"}
        payload = {**body, "signature": self.b.identity.sign("magicstick-enroll-v1", body), "type": "magic-stick"}
        roster = self.a.enroll(payload)["payload"]
        self.assertEqual(roster["members"][self.b.identity.endpoint]["type"], "client")

    def test_ownership_proof_cannot_be_forged(self):
        self.join(self.b)
        body = self.b.memberRequest("/mesh/heartbeat", {"exports": {}})
        body["claim"]["endpoint"] = self.a.identity.endpoint
        with self.assertRaises(MeshError):
            self.a.heartbeat(body)

    def test_heartbeat_replay(self):
        self.join(self.b)
        payload = self.b.memberRequest("/mesh/heartbeat", {"exports": {}})
        self.a.heartbeat(payload)
        with self.assertRaises(MeshError):
            self.a.heartbeat(payload)

    def test_revocation_and_stale_roster_fail_closed(self):
        self.join(self.c, "client", "laptop-c")
        self.a.revokeNode(self.c.identity.endpoint)
        with self.assertRaises(MeshError):
            self.c.refreshMembership(lambda _m, _p, body: self.a.heartbeat(body))
        self.clock.now += 121
        self.assertEqual(self.c.policy()["members"], {})

    def test_model_provenance_not_only_prefix(self):
        self.inventory["external"] = {"uid": "fixture", "ready": True, "source": "external"}
        for name in ("external", "mesh/stick-b/qwen", "share/stick-a/qwen", "local/qwen"):
            with self.subTest(name=name), self.assertRaises(MeshError):
                self.a.shareModel(name, {"enabled": True})
        self.inventory["qwen"]["ready"] = False
        self.assertEqual(self.a.exportModels(), {})

    def test_share_and_unshare(self):
        self.assertEqual(list(self.a.exportModels()), ["share/stick-a/qwen"])
        self.a.unshareModel("qwen")
        self.assertEqual(self.a.exportModels(), {})

    def test_every_engine_shares_existing_backend_with_engine_specific_priority(self):
        for engine, source in [('VLLM', 'kubeai'), ('OLLAMA', 'kubeai'), ('FREETOKEN', 'freetoken')]:
            with self.subTest(engine=engine):
                backend = {'uid': 'fixture-' + engine, 'source': source, 'engine': engine, 'ready': True}
                if source == 'freetoken':
                    backend['apiBase'] = 'http://freetoken.ai.svc.cluster.local:8000/v1'
                self.inventory['qwen'] = backend
                self.a.shareModel('qwen', {'enabled': True})
                sync, provider = self.synchronizer(self.a, [])
                sync.reconcile()
                self.assertEqual(self.a.getStatus()['models'], ['qwen'])
                self.assertEqual({m['model_name'] for m in provider.models}, {'local/qwen', 'share/stick-a/qwen'})
                expected_base = backend.get('apiBase', 'http://local-backend.example.com/v1')
                for deployment in provider.models:
                    self.assertEqual(deployment['litellm_params']['api_base'], expected_base)
                    self.assertEqual(deployment['litellm_params']['model'], 'openai/qwen')
                    self.assertEqual(deployment['model_info']['magicstick_vllm_priority'], engine == 'VLLM')
                bridge = ExportBridge(self.a, 'http://litellm.example.com', 'fixture-bridge')
                self.assertEqual(bridge.models()['data'][0]['id'], 'share/stick-a/qwen')
                _, _, clean, _, _ = bridge.prepare({'model': 'share/stick-a/qwen',
                                                    'messages': [{'role': 'user', 'content': 'hello'}], 'priority': -100})
                self.assertNotIn('priority', clean)
                self.inventory['qwen']['ready'] = False
                sync.reconcile()
                self.assertEqual(self.a.exportModels(), {})
                self.assertEqual(provider.models, [])

    def test_engine_change_updates_owned_aliases_and_priority_without_duplicate_routes(self):
        sync, provider = self.synchronizer(self.a, [])
        sync.reconcile()
        self.inventory['qwen']['engine'] = 'OLLAMA'
        sync.reconcile()
        self.assertEqual(len(provider.models), 2)
        self.assertTrue(all(not item['model_info']['magicstick_vllm_priority'] for item in provider.models))

    def test_status_does_not_expose_private_keys_or_invite_digest(self):
        invite = self.a.createInvite("client", "admin")
        status = json.dumps(self.a.getStatus())
        self.assertNotIn(self.a.identity.seed, status)
        self.assertNotIn(invite["token"], status)
        self.assertNotIn("digest", status)

    def test_concurrent_enrollment_exactly_once(self):
        invite = self.a.createInvite("client", "admin")
        clients = [MeshService(Store(":memory:"), lambda: {}, self.clock, consume_only=True) for _ in range(2)]
        results = []
        def join(index):
            try:
                clients[index].joinMesh(invite["token"], "laptop-" + str(index), lambda _m, _p, body: self.a.enroll(body))
                results.append(True)
            except MeshError:
                results.append(False)
        threads = [threading.Thread(target=join, args=(index,)) for index in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        for client in clients:
            client.store.db.close()
        self.assertEqual(sorted(results), [False, True])

    def test_infra_can_publish_only_own_namespace(self):
        self.join(self.b)
        payload = self.b.memberRequest("/mesh/heartbeat", {"exports": {"share/stick-a/qwen": {"enabled": True}}})
        with self.assertRaises(MeshError):
            self.a.heartbeat(payload)

    def synchronizer(self, service, discovered):
        litellm = FakeLiteLLM()
        sync = ModelSync(service, litellm, lambda: {"data": [{"id": model} for model in discovered]},
                         "http://local-backend.example.com/v1", "http://imports.example.com/v1", "fixture-import-key", grace=30)
        return sync, litellm

    def test_sync_idempotence_duplicates_and_namespaces(self):
        self.join(self.b)
        sync, provider = self.synchronizer(self.b, ["share/stick-a/qwen", "share/stick-a/qwen", "mesh/stick-a/qwen", "local/qwen", "share/unknown/model"])
        sync.reconcile()
        self.assertEqual({m["model_name"] for m in provider.models}, {"mesh/stick-a/qwen", "qwen"})
        count = len(provider.calls)
        sync.reconcile()
        self.assertEqual(count, len(provider.calls))

    def test_sync_does_not_import_own_exports(self):
        sync, provider = self.synchronizer(self.a, ["share/stick-a/qwen"])
        sync.reconcile()
        self.assertEqual({m["model_name"] for m in provider.models}, {"local/qwen", "share/stick-a/qwen"})
        self.assertEqual({m["litellm_params"]["api_base"] for m in provider.models}, {"http://local-backend.example.com/v1"})

    def test_node_loss_grace_reconnect(self):
        self.join(self.b)
        discovered = ["share/stick-a/qwen"]
        sync, provider = self.synchronizer(self.b, discovered)
        sync.reconcile()
        discovered.clear()
        sync.reconcile()
        self.clock.now += 29
        sync.reconcile()
        self.assertEqual(len(provider.models), 2)
        self.clock.now += 2
        sync.reconcile()
        self.assertEqual(provider.models, [])
        discovered.append("share/stick-a/qwen")
        sync.reconcile()
        self.assertEqual(len(provider.models), 2)

    def test_mesh_outage_has_grace_litellm_outage_reported(self):
        self.join(self.b)
        sync, provider = self.synchronizer(self.b, ["share/stick-a/qwen"])
        sync.reconcile()
        def unavailable():
            raise MeshError("unavailable", 503)
        sync.mesh_models = unavailable
        sync.reconcile()
        self.assertEqual(sync.last_error, "mesh_unavailable")
        self.assertEqual(len(provider.models), 2)
        provider.down = True
        with self.assertRaises(MeshError):
            sync.reconcile()
        self.assertEqual(sync.last_error, "litellm_unavailable")

    def test_share_key_is_restricted_and_rotated_on_limits_change(self):
        sync, provider = self.synchronizer(self.a, [])
        sync.reconcile()
        self.assertEqual(list(provider.keys.values()), [["share/stick-a/qwen"]])
        before = len(provider.calls)
        self.a.shareModel("qwen", {"enabled": True, "rpm": 1})
        sync.reconcile()
        self.assertIn("/key/delete", [path for path, _ in provider.calls[before:]])
        self.a.unshareModel("qwen")
        sync.reconcile()
        self.assertEqual(provider.keys, {})

    def bridge(self):
        sync, _ = self.synchronizer(self.a, [])
        sync.reconcile()
        return ExportBridge(self.a, "http://litellm.example.com", "fixture-bridge-token", self.clock)

    def test_export_authentication(self):
        self.join(self.c, "client", "laptop-c")
        bridge = self.bridge()
        bridge.authorize("fixture-bridge-token", self.c.identity.endpoint)
        for token, endpoint in [("wrong", self.c.identity.endpoint), ("fixture-bridge-token", Identity().endpoint)]:
            with self.assertRaises(MeshError):
                bridge.authorize(token, endpoint)

    def test_bridge_rejects_unauthorized_models(self):
        bridge = self.bridge()
        for name in ["local/qwen", "mesh/stick-b/qwen", "share/stick-b/qwen", "qwen"]:
            with self.subTest(name=name), self.assertRaises(MeshError):
                bridge.prepare({"model": name, "messages": [{"role": "user", "content": "hello"}]})

    def test_bridge_overwrites_credentials_and_priority(self):
        bridge = self.bridge()
        result = bridge.prepare({"model": "share/stick-a/qwen", "messages": [{"role": "user", "content": "hello"}],
                                 "api_key": "attacker-key", "api_base": "http://attacker.example.com", "priority": -100,
                                 "extra_body": {"priority": -100}, "metadata": {"magicstick_traffic_class": "LOCAL"}})
        self.assertNotIn("priority", result[2])
        self.assertNotIn("extra_body", result[2])
        self.assertNotIn("api_base", result[2])
        self.assertNotEqual(result[3], "attacker-key")

    def test_remote_concurrency_and_rate_limits(self):
        self.a.shareModel("qwen", {"enabled": True, "maxConcurrent": 1, "rpm": 2})
        bridge = self.bridge()
        model, config, _, _, tokens = bridge.prepare({"model": "share/stick-a/qwen", "messages": [{"role": "user", "content": "hello"}]})
        with bridge.reserve(model, config, tokens):
            with self.assertRaises(MeshError):
                with bridge.reserve(model, config, tokens):
                    pass
        with bridge.reserve(model, config, tokens):
            pass
        with self.assertRaises(MeshError):
            with bridge.reserve(model, config, tokens):
                pass
        self.clock.now += 61
        with bridge.reserve(model, config, tokens):
            pass
        self.assertEqual(bridge.metrics["active"], 0)

    def test_token_and_context_limits(self):
        bridge = self.bridge()
        for extra in [{"max_tokens": 999999}, {"messages": [{"role": "user", "content": "x" * 40000}]},
                      {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "http://example.com"}}]}]}]:
            with self.subTest(extra=list(extra)), self.assertRaises(MeshError):
                bridge.prepare({"model": "share/stick-a/qwen", "messages": [{"role": "user", "content": "hello"}], **extra})

    def test_backend_error_releases_capacity(self):
        bridge = self.bridge()
        model, settings, _, _, tokens = bridge.prepare({"model": "share/stick-a/qwen", "messages": [{"role": "user", "content": "hello"}]})
        with self.assertRaises(MeshError):
            with bridge.reserve(model, settings, tokens):
                raise MeshError("vLLM unavailable", 503)
        self.assertEqual(bridge.metrics["active"], 0)
        self.assertEqual(bridge.metrics["errors"], 1)

    def test_models_are_not_duplicated_physically(self):
        sync, provider = self.synchronizer(self.a, [])
        sync.reconcile()
        self.assertEqual({m["litellm_params"]["model"] for m in provider.models}, {"openai/qwen"})

    def test_logical_fallback_preserves_catalog_ownership(self):
        self.join(self.b)
        sync, provider = self.synchronizer(self.b, ["share/stick-a/qwen"])
        local = {"model_name": "qwen", "litellm_params": {"model": "openai/qwen", "order": 0},
                 "model_info": {"id": "catalog-local", "ai_appliance_managed": True, "ai_appliance_source": "kubeai", "magicstick_vllm_priority": True, "order": 0}}
        provider.models = [copy.deepcopy(local)]
        sync.reconcile()
        group = [m for m in provider.models if m["model_name"] == "qwen"]
        self.assertEqual(sorted(m["model_info"]["order"] for m in group), [0, 1])
        self.assertEqual(next(m for m in group if m["model_info"]["id"] == "catalog-local"), local)
        self.assertFalse(any(path == "/model/update" and body["model_info"]["id"] == "catalog-local" for path, body in provider.calls))

    def test_logical_fallback_does_not_replace_external_provider(self):
        self.join(self.b)
        sync, provider = self.synchronizer(self.b, ["share/stick-a/qwen"])
        provider.models = [{"model_name": "qwen", "model_info": {"id": "external", "source": "external"}}]
        sync.reconcile()
        self.assertEqual(len([m for m in provider.models if m["model_name"] == "qwen"]), 1)
        self.assertTrue(any(m["model_name"] == "mesh/stick-a/qwen" for m in provider.models))

    def test_logical_fallback_also_supports_ollama_and_freetoken_catalog_routes(self):
        self.join(self.b)
        for source in ['kubeai', 'freetoken']:
            with self.subTest(source=source):
                sync, provider = self.synchronizer(self.b, ['share/stick-a/qwen'])
                local = {'model_name': 'qwen', 'model_info': {'id': 'catalog-local', 'ai_appliance_managed': True,
                         'ai_appliance_source': source, 'magicstick_vllm_priority': False, 'order': 0}}
                provider.models = [copy.deepcopy(local)]
                sync.reconcile()
                self.assertEqual(sorted(m['model_info']['order'] for m in provider.models if m['model_name'] == 'qwen'), [0, 1])
                self.assertEqual(next(m for m in provider.models if m['model_info']['id'] == 'catalog-local'), local)

    def test_unmanaged_local_looking_route_does_not_gain_a_logical_fallback(self):
        self.join(self.b)
        sync, provider = self.synchronizer(self.b, ['share/stick-a/qwen'])
        provider.models = [{'model_name': 'qwen', 'model_info': {'id': 'unmanaged', 'ai_appliance_source': 'kubeai', 'order': 0}}]
        sync.reconcile()
        self.assertEqual(len([m for m in provider.models if m['model_name'] == 'qwen']), 1)

    def test_setup_lists_only_proven_ready_local_models(self):
        self.inventory["unready"] = {"source": "kubeai", "uid": "u", "ready": False}
        self.inventory["imported"] = {"source": "mesh", "uid": "u", "ready": True}
        self.assertEqual(self.a.getStatus()["models"], ["qwen"])


if __name__ == "__main__":
    unittest.main()
