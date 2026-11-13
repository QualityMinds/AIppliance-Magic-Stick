# SPDX-License-Identifier: BUSL-1.1
"""Exact-host callback reconciliation must reject stale and foreign owners."""
import hashlib
import json
import threading
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from test_setup_server import setup


class CallbackRegistryTests(unittest.TestCase):
    def gateway_resources(self, policy=None):
        host = 'service.example.local'
        route = {'metadata': {'name': 'service', 'uid': 'route-uid', 'generation': 1},
                 'spec': {'parentRefs': [{'name': 'identity-pilot'}], 'hostnames': [host]}}
        target = {'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute', 'name': 'service'}
        policy = policy or {'oidc': {'redirectURL': 'https://' + host + '/oauth2/callback/exact'}}
        item = {'metadata': {'name': 'service-auth', 'uid': 'policy-uid', 'generation': 1},
                'spec': {**policy, 'targetRefs': [target]}}
        def read(path):
            if path.endswith('/httproutes'):
                return {'items': [route]}
            if path.endswith('/securitypolicies'):
                return {'items': [item]}
            if path == setup.CALLBACKS_STATUS_PATH:
                return {'data': {'redirects.json': json.dumps(['https://' + host + '/oauth2/callback/exact'])}}
            return None
        return read, route, item

    def test_gateway_fallback_requires_real_callback_check_for_oidc_hosts(self):
        read, _, _ = self.gateway_resources()
        with (patch.object(setup, 'get_resource', side_effect=read),
              patch.object(setup, 'callback_readiness_singleflight', return_value=False) as check):
            self.assertFalse(setup.gateway_callback_readiness('service.example.local'))
            check.assert_called_once_with('service.example.local')
            check.return_value = True
            self.assertTrue(setup.gateway_callback_readiness('service.example.local'))

    def test_gateway_fallback_never_treats_failed_policy_read_as_public(self):
        for result in (None, {}, {'items': None}, {'items': [], 'metadata': {'continue': 'next-page'}}):
            with patch.object(setup, 'get_resource', return_value=result):
                self.assertFalse(setup.gateway_callback_readiness('api.example.local'))
        read, _, _ = self.gateway_resources({'authorization': {'defaultAction': 'Allow'}})
        with patch.object(setup, 'get_resource', side_effect=read):
            # Independent native default-deny still requires the route's own
            # JWT, service-proof or instance-guard SecurityPolicy.
            self.assertTrue(setup.gateway_callback_readiness('service.example.local'))

    def test_renamed_route_wrong_callback_path_and_midflight_drift_fail_closed(self):
        read, route, policy = self.gateway_resources()
        with (patch.object(setup, 'get_resource', side_effect=read),
              patch.object(setup, 'callback_readiness_singleflight', return_value=True)):
            route['spec']['hostnames'] = ['renamed.example.local']
            self.assertFalse(setup.gateway_callback_readiness('renamed.example.local'))
            route['spec']['hostnames'] = ['service.example.local']
            policy['spec']['oidc']['redirectURL'] = 'https://service.example.local/oauth2/callback/wrong'
            self.assertFalse(setup.gateway_callback_readiness('service.example.local'))
            policy['spec']['oidc']['redirectURL'] = 'https://service.example.local/oauth2/callback/exact'
            def changed(_):
                route['metadata']['generation'] += 1
                return True
            with patch.object(setup, 'callback_readiness_singleflight', side_effect=changed):
                self.assertFalse(setup.gateway_callback_readiness('service.example.local'))

    def test_callback_gate_ca_sync_copies_only_valid_public_ca_with_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ca.crt"
            path.write_text("public-synthetic-ca")
            with (patch.object(setup, "CALLBACK_GATE_CA_FILE", str(path)),
                  patch.object(setup.ssl, "create_default_context") as validate,
                  patch.object(setup, "get_resource", return_value={"metadata": {"resourceVersion": "42"}, "data": {}}),
                  patch.object(setup, "kube_request") as request):
                setup.sync_callback_gate_ca()
                validate.assert_called_once_with(cadata="public-synthetic-ca")
                self.assertEqual(request.call_args.args[2], {"metadata": {"resourceVersion": "42"}, "data": {"ca.crt": "public-synthetic-ca"}})
                validate.side_effect = ValueError("invalid CA")
                request.reset_mock()
                with self.assertRaises(ValueError):
                    setup.sync_callback_gate_ca()
                request.assert_not_called()

    def test_callback_gate_ca_rotation_and_missing_secret_fail_closed_without_blocking_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ca.crt"
            current = {"metadata": {"resourceVersion": "10"}, "data": {"ca.crt": "old-ca"}}
            with (patch.object(setup, "CALLBACK_GATE_CA_FILE", str(path)),
                  patch.object(setup.ssl, "create_default_context"),
                  patch.object(setup, "get_resource", return_value=current),
                  patch.object(setup, "kube_request") as request):
                with self.assertRaises(FileNotFoundError):
                    setup.sync_callback_gate_ca()
                request.assert_not_called()
                path.write_text("new-ca")
                setup.sync_callback_gate_ca()
                self.assertEqual(request.call_args.args[2]["data"], {"ca.crt": "new-ca"})
                current["data"]["ca.crt"] = "new-ca"
                request.reset_mock()
                setup.sync_callback_gate_ca()
                request.assert_not_called()

    def setUp(self):
        self.uid = "12345678-1234-1234-1234-123456789abc"
        self.owner = {"metadata": {"name": "openclaw-demo", "uid": self.uid},
                      "spec": {"application": "openclaw", "access": {"authentication": "sso", "exposure": "localAndPublic"}}}
        self.settings = {"data": {"AI_APPLIANCE_MDNS_DOMAIN": "example.local", "AI_APPLIANCE_DOMAIN": "example.com", "AI_APPLIANCE_DASHBOARD_HOST": "dashboard.example.com"}}
        self.entry = {"name": "openclaw-demo", "uid": self.uid, "application": "openclaw",
                      "local": "https://demo.openclaw.example.local/oauth2/callback/openclaw-demo-local",
                      "public": "https://demo.openclaw.example.com/oauth2/callback/openclaw-demo-public"}
        self.raw = json.dumps({"version": 1, "entries": [self.entry]}, sort_keys=True, separators=(",", ":"))
        self.status = {}

    def resource(self, path):
        if path == setup.SETTINGS_PATH:
            return self.settings
        if path.endswith("/appinstances/openclaw-demo"):
            return self.owner
        if path == setup.CALLBACKS_PATH:
            return {"data": {"callbacks.json": self.raw}}
        if path == setup.CALLBACKS_STATUS_PATH:
            return {"data": self.status}
        if path == setup.KEYCLOAK_ENDPOINTS_PATH:
            return {"subsets": [{"addresses": [{"targetRef": {"kind": "Pod", "uid": self.uid}}]}]}
        return None

    def patch_status(self, method, path, body, *_):
        self.assertEqual(path, setup.CALLBACKS_STATUS_PATH)
        self.status.update(body.get("data") or {})
        return {"data": self.status}

    def test_exact_host_urls_and_static_services(self):
        with patch.object(setup, "get_resource", side_effect=self.resource):
            redirects, origins, _ = setup.callback_registration(self.raw)
        self.assertIn(self.entry["local"], redirects)
        self.assertIn(self.entry["public"], redirects)
        self.assertIn("https://anythingllm.example.local/oauth2/callback/static-anything-llm-local", redirects)
        self.assertIn("https://demo.openclaw.example.local", origins)
        self.assertFalse(any("*" in item for item in redirects))

    def test_changed_owner_or_callback_fails_closed(self):
        with patch.object(setup, "get_resource", side_effect=self.resource):
            for field, value in (("uid", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
                                 ("local", "https://evil.example.com/oauth2/callback/openclaw-demo-local"),
                                 ("public", "https://*.example.com/oauth2/callback/x")):
                with self.subTest(field=field):
                    entry = dict(self.entry, **{field: value})
                    with self.assertRaises(ValueError):
                        setup.callback_registration(json.dumps({"version": 1, "entries": [entry]}))
            self.owner["metadata"]["deletionTimestamp"] = "2026-01-01T00:00:00Z"
            with self.assertRaises(ValueError):
                setup.callback_registration(self.raw)

    def test_long_instance_name_uses_same_bounded_route_name_as_operator(self):
        name = "openclaw-" + "a" * 54
        self.owner["metadata"]["name"] = name
        short = "a" * 54
        local_route = name[:57].rstrip("-") + "-local"
        public_route = name[:56].rstrip("-") + "-public"
        entry = dict(self.entry, name=name,
                     local=f"https://{short}.openclaw.example.local/oauth2/callback/{local_route}",
                     public=f"https://{short}.openclaw.example.com/oauth2/callback/{public_route}")
        old_resource = self.resource
        def resource(path):
            if path.endswith("/appinstances/" + name):
                return self.owner
            return old_resource(path)
        with patch.object(setup, "get_resource", side_effect=resource):
            redirects, _, _ = setup.callback_registration(json.dumps({"version": 1, "entries": [entry]}))
        self.assertIn(entry["local"], redirects)

    def test_only_matching_verified_readback_publishes_ack(self):
        state = {"id": "fixture-id", "clientId": "magicstick-human-gateway-local", "secret": "synthetic-private", "attributes": {"unrelated": "keep"}}
        def keycloak(method, path, token=None, body=None, **_):
            if method == "PUT":
                self.assertNotIn("secret", body)
                self.assertEqual(set(body["attributes"]), {"post.logout.redirect.uris"})
                state["attributes"].update(body.pop("attributes"))
                state.update(body)
                return {}, {}
            if "?" in path:
                return [dict(state)], {}
            return dict(state), {}
        with (patch.object(setup, "get_resource", side_effect=self.resource),
              patch.object(setup, "keycloak_token", return_value="synthetic"),
              patch.object(setup, "keycloak_request", side_effect=keycloak),
              patch.object(setup, "kube_request", side_effect=self.patch_status) as request):
            setup.sync_oidc_callbacks()
        data = request.call_args.args[2]["data"]
        self.assertEqual(data["desired-sha256"], hashlib.sha256(self.raw.encode()).hexdigest())
        self.assertEqual(data["desired-sha256"], data["verified-sha256"])
        self.assertEqual(data["verified-registry"], self.raw)
        self.assertEqual(state["attributes"]["unrelated"], "keep")
        self.assertEqual(state["secret"], "synthetic-private")

    def test_active_secret_rotation_prevents_put_and_ack(self):
        client = {"id": "fixture-id", "clientId": "magicstick-human-gateway-local",
                  "attributes": {"client.secret.rotated": "synthetic-private"}}
        def keycloak(method, path, **_):
            self.assertEqual(method, "GET")
            return ([dict(client)] if "?" in path else dict(client)), {}
        with (patch.object(setup, "get_resource", side_effect=self.resource),
              patch.object(setup, "keycloak_token", return_value="synthetic"),
              patch.object(setup, "keycloak_request", side_effect=keycloak),
              patch.object(setup, "kube_request", side_effect=self.patch_status) as request):
            with self.assertRaises(ValueError):
                setup.sync_oidc_callbacks()
            request.assert_not_called()

    def test_stale_keycloak_readback_never_publishes_ack(self):
        client = {"id": "fixture-id", "clientId": "magicstick-human-gateway-local", "attributes": {}}
        def keycloak(method, path, **_):
            return ([dict(client)] if "?" in path else dict(client)), {}
        with (patch.object(setup, "get_resource", side_effect=self.resource),
              patch.object(setup, "keycloak_token", return_value="synthetic"),
              patch.object(setup, "keycloak_request", side_effect=keycloak),
              patch.object(setup, "kube_request", side_effect=self.patch_status) as request):
            with self.assertRaises(ValueError):
                setup.sync_oidc_callbacks()
            self.assertNotEqual(self.status.get("pending-sha256", ""), "")
            self.assertNotIn("verified-sha256", self.status)

    def test_static_and_dynamic_hosts_detect_real_client_drift(self):
        client = {"id": "fixture-id", "clientId": "magicstick-human-gateway-local", "attributes": {}}
        def keycloak(method, path, token=None, body=None, **_):
            if method == "PUT":
                client["attributes"].update(body["attributes"])
                client.update({k: v for k, v in body.items() if k != "attributes"})
                return {}, {}
            return ([dict(client)] if "?" in path else dict(client)), {}
        with (patch.object(setup, "get_resource", side_effect=self.resource),
              patch.object(setup, "keycloak_token", return_value="synthetic"),
              patch.object(setup, "keycloak_request", side_effect=keycloak),
              patch.object(setup, "kube_request", side_effect=self.patch_status)):
            setup.sync_oidc_callbacks()
            self.assertTrue(setup.callback_static_readiness("example.local"))
            self.assertTrue(setup.callback_static_readiness("demo.openclaw.example.local"))
            self.assertFalse(setup.callback_static_readiness("foreign.example.local"))
            client["redirectUris"].append("https://foreign.example.local/oauth2/callback")
            self.assertFalse(setup.callback_static_readiness("example.local"))
            self.assertFalse(setup.callback_static_readiness("demo.openclaw.example.local"))

    def test_parallel_asset_fanout_coalesces_only_inflight_checks(self):
        count = []
        def slow(host):
            count.append(host)
            time.sleep(0.2)
            return True
        start = threading.Barrier(32)
        def request(_):
            start.wait(timeout=3)
            return setup.callback_readiness_singleflight("example.local")
        with patch.object(setup, "callback_static_readiness", side_effect=slow):
            with ThreadPoolExecutor(max_workers=32) as pool:
                self.assertTrue(all(pool.map(request, range(32))))
            self.assertEqual(len(count), 1)
            self.assertTrue(setup.callback_readiness_singleflight("example.local"))
            self.assertEqual(len(count), 2, "completed allow decisions must never be cached")

    def test_pending_addition_preserves_old_host_but_never_admits_new_host_early(self):
        client = {"id": "fixture-id", "clientId": "magicstick-human-gateway-local", "attributes": {}}
        def keycloak(method, path, token=None, body=None, **_):
            if method == "PUT":
                client["attributes"].update(body["attributes"])
                client.update({key: value for key, value in body.items() if key != "attributes"})
                return {}, {}
            return ([dict(client)] if "?" in path else dict(client)), {}
        with (patch.object(setup, "get_resource", side_effect=self.resource),
              patch.object(setup, "keycloak_token", return_value="synthetic"),
              patch.object(setup, "keycloak_request", side_effect=keycloak),
              patch.object(setup, "kube_request", side_effect=self.patch_status)):
            setup.sync_oidc_callbacks()
            extra = {"uid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "openclaw-next", "application": "openclaw",
                     "local": "https://next.openclaw.example.local/oauth2/callback/openclaw-next-local",
                     "public": "https://next.openclaw.example.com/oauth2/callback/openclaw-next-public"}
            pending = json.dumps({"version": 1, "entries": [self.entry, extra]}, sort_keys=True, separators=(",", ":"))
            self.status.update({"pending-registry": pending, "pending-sha256": hashlib.sha256(pending.encode()).hexdigest()})
            self.raw = pending
            client["redirectUris"] += [extra["local"], extra["public"]]
            client["webOrigins"] += ["https://next.openclaw.example.local", "https://next.openclaw.example.com"]
            client["attributes"]["post.logout.redirect.uris"] = "##".join(origin + "/" for origin in sorted(client["webOrigins"]))
            self.assertTrue(setup.callback_static_readiness("example.local"))
            self.assertTrue(setup.callback_static_readiness("demo.openclaw.example.local"))
            self.assertFalse(setup.callback_static_readiness("next.openclaw.example.local"))
            # An unrelated, unapproved callback is never accepted as pending.
            client["redirectUris"].append("https://foreign.example.com/oauth2/callback")
            self.assertFalse(setup.callback_static_readiness("example.local"))

    def test_singleflight_recovers_after_failed_identity_check(self):
        with patch.object(setup, "callback_static_readiness", side_effect=[False, True]):
            self.assertFalse(setup.callback_readiness_singleflight("example.local"))
            self.assertTrue(setup.callback_readiness_singleflight("example.local"))
