# SPDX-License-Identifier: BUSL-1.1
"""Actual identity readiness with real Keycloak and synthetic Kubernetes.

Opt in with MAGICSTICK_RUN_KEYCLOAK_CONTAINER_TESTS=1. No appliance, secrets or
runtime status are used. No token, header, client representation or response
body is printed, even on failure.
"""
from concurrent.futures import Future, ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from test_setup_server import setup

IMAGE = "quay.io/keycloak/keycloak:26.6.3@sha256:9b0330756022422149aa6502eb2def8cd47c6e1b000c7c65cdb13e7c0133e992"


@unittest.skipUnless(os.environ.get("MAGICSTICK_RUN_KEYCLOAK_CONTAINER_TESTS") == "1", "isolated Keycloak load gate not requested")
class KeycloakReadinessLoadTests(unittest.TestCase):
    def test_live_keycloak_singleflight_capacity_and_recovery(self):
        name = "magicstick-readiness-load-" + uuid.uuid4().hex[:12]
        admin_password, client_secret, setup_secret = [secrets.token_urlsafe(24) for _ in range(3)]
        realm = {"realm": "magicstick", "enabled": True, "sslRequired": "none", "clients": [
            {"clientId": "magicstick-human-gateway-local", "enabled": True, "publicClient": False,
             "secret": client_secret, "standardFlowEnabled": True,
             "redirectUris": ["https://old.example.local/oauth2/callback"], "webOrigins": ["https://old.example.local"]},
            {"clientId": "magicstick-setup", "enabled": True, "publicClient": False,
             "secret": setup_secret, "serviceAccountsEnabled": True, "standardFlowEnabled": False}],
            "users": [{"username": "service-account-magicstick-setup", "enabled": True,
                       "serviceAccountClientId": "magicstick-setup",
                       "clientRoles": {"realm-management": ["manage-clients", "view-clients"]}}]}
        with tempfile.TemporaryDirectory(prefix="magicstick-readiness-load-") as directory:
            environment = {**os.environ, 'KC_BOOTSTRAP_ADMIN_USERNAME': 'fixture-admin', 'KC_BOOTSTRAP_ADMIN_PASSWORD': admin_password}
            http = None
            try:
                subprocess.run(["docker", "run", "-d", "--name", name, "--publish", "127.0.0.1::8080",
                    '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD',
                    IMAGE, "start-dev"], env=environment, check=True, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=180)
                port = subprocess.check_output(["docker", "port", name, "8080/tcp"], text=True).strip().rsplit(":", 1)[1]
                base = "http://127.0.0.1:" + port
                def request(method, path, token=None, body=None, form=None):
                    headers, data = {"Accept": "application/json"}, None
                    if token:
                        headers["Authorization"] = "Bearer " + token
                    if body is not None:
                        headers["Content-Type"] = "application/json"
                        data = json.dumps(body).encode()
                    if form is not None:
                        headers["Content-Type"] = "application/x-www-form-urlencoded"
                        data = urllib.parse.urlencode(form).encode()
                    req = urllib.request.Request(base + path, method=method, headers=headers, data=data)
                    with urllib.request.urlopen(req, timeout=12) as response:
                        raw = response.read()
                        return (json.loads(raw) if raw else {}), response.headers
                for _ in range(150):
                    try:
                        admin, _ = request("POST", "/realms/master/protocol/openid-connect/token", form={
                            "grant_type": "password", "client_id": "admin-cli", "username": "fixture-admin", "password": admin_password})
                        break
                    except (OSError, ValueError):
                        time.sleep(1)
                else:
                    self.fail("Isolated Keycloak did not become ready")
                request('POST', '/admin/realms', token=admin['access_token'], body=realm)

                entries, owners = [], {}
                for number in range(65):
                    short = f"x{number:02d}"
                    owner_name = "a-" + short
                    uid = str(uuid.uuid5(uuid.NAMESPACE_DNS, owner_name))
                    owners[owner_name] = {"metadata": {"name": owner_name, "uid": uid},
                                          "spec": {"application": "a", "values": {"name": short},
                                                   "access": {"authentication": "sso", "exposure": "local"}}}
                    entries.append({"uid": uid, "name": owner_name, "application": "a",
                                    "local": f"https://{short}.a.fixture.local/oauth2/callback/{owner_name}-local", "public": ""})
                raw = json.dumps({"version": 1, "entries": entries}, sort_keys=True, separators=(",", ":"))
                routes, policies = [], []
                for entry in entries:
                    route_name = entry['name'] + '-local'
                    routes.append({'metadata': {'name': route_name, 'uid': str(uuid.uuid5(uuid.NAMESPACE_DNS, route_name)), 'generation': 1},
                                   'spec': {'parentRefs': [{'name': 'identity-pilot'}],
                                            'hostnames': [urllib.parse.urlsplit(entry['local']).netloc]}})
                    policies.append({'metadata': {'name': route_name + '-sso', 'uid': str(uuid.uuid5(uuid.NAMESPACE_DNS, route_name + '-sso')), 'generation': 1},
                                     'spec': {'targetRefs': [{'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute', 'name': route_name}],
                                              'oidc': {'redirectURL': entry['local']}}})
                status = {}
                endpoint_uid = str(uuid.uuid4())
                def resource(path):
                    if path.endswith('/httproutes'):
                        return {'items': routes}
                    if path.endswith('/securitypolicies'):
                        return {'items': policies}
                    if path == setup.SETTINGS_PATH:
                        return {"data": {"AI_APPLIANCE_MDNS_DOMAIN": "fixture.local", "AI_APPLIANCE_DOMAIN": "example.com", "AI_APPLIANCE_DASHBOARD_HOST": "dashboard.example.com"}}
                    if path == setup.CALLBACKS_PATH:
                        return {"data": {"callbacks.json": raw}}
                    if path == setup.CALLBACKS_STATUS_PATH:
                        return {"data": dict(status)}
                    if path == setup.KEYCLOAK_ENDPOINTS_PATH:
                        return {"subsets": [{"addresses": [{"targetRef": {"kind": "Pod", "uid": endpoint_uid}}]}]}
                    if "/appinstances/" in path:
                        return owners.get(path.rsplit("/", 1)[1])
                    return None
                def patch_status(_method, _path, body, *_):
                    status.update(body.get("data") or {})
                def scoped_token():
                    token, _ = request("POST", "/realms/magicstick/protocol/openid-connect/token", form={
                        "grant_type": "client_credentials", "client_id": "magicstick-setup", "client_secret": setup_secret})
                    return token["access_token"]

                class QuietHandler(setup.Handler):
                    def log_message(self, *_args):
                        pass
                class LocalServer(ThreadingHTTPServer):
                    request_queue_size = 256
                    daemon_threads = True
                http = LocalServer(("127.0.0.1", 0), QuietHandler)
                threading.Thread(target=http.serve_forever, daemon=True).start()
                def probe(host):
                    url = f"http://127.0.0.1:{http.server_port}/internal/callback-readiness?" + urllib.parse.urlencode({"host": host, 'gateway': '1'})
                    try:
                        with urllib.request.urlopen(url, timeout=45) as response:
                            return response.status
                    except urllib.error.HTTPError as error:
                        return error.code

                with (patch.object(setup, "get_resource", side_effect=resource),
                      patch.object(setup, "keycloak_token", side_effect=scoped_token),
                      patch.object(setup, "keycloak_request", side_effect=request),
                      patch.object(setup, "kube_request", side_effect=patch_status)):
                    setup.sync_oidc_callbacks()
                    self.assertEqual(probe("x00.a.fixture.local"), 204)

                    # Exercise the whole production gRPC -> HTTP -> Gateway
                    # observation -> real Keycloak path. The older lower-layer
                    # singleflight still performs route/policy reads for every
                    # asset; the new ingress flight must share the entire check.
                    import grpc
                    from envoy.config.core.v3 import base_pb2
                    from envoy.service.ext_proc.v3 import external_processor_pb2 as ext_proc
                    from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as ext_service
                    gate_path = Path(__file__).resolve().parents[4] / 'dashboard/apps/api/callback_gate.py'
                    gate_spec = importlib.util.spec_from_file_location('callback_gate_load_fixture', gate_path)
                    gate_module = importlib.util.module_from_spec(gate_spec)
                    gate_spec.loader.exec_module(gate_module)
                    entered, release, joined = threading.Event(), threading.Event(), threading.Event()
                    arrivals, observations, keycloak_checks = [], [], []
                    guard_lock = threading.Lock()

                    class GateFuture(Future):
                        def result(self, timeout=None):
                            with guard_lock:
                                arrivals.append(1)
                                if len(arrivals) == 39:
                                    joined.set()
                            return super().result(timeout=timeout)

                    def observed_resource(path):
                        if path.endswith(('/httproutes', '/securitypolicies')):
                            with guard_lock:
                                observations.append(path)
                        return resource(path)

                    def held_gateway_request(method, path, **kwargs):
                        if method == 'GET' and '?clientId=' in path:
                            keycloak_checks.append(1)
                            entered.set()
                            if not release.wait(6):
                                raise TimeoutError('synthetic gateway release timeout')
                        return request(method, path, **kwargs)

                    gate_server = grpc.server(ThreadPoolExecutor(max_workers=64))
                    gate = gate_module.Gate()
                    ext_service.add_ExternalProcessorServicer_to_server(gate, gate_server)
                    gate_port = gate_server.add_insecure_port('127.0.0.1:0')
                    gate_server.start()
                    try:
                        with (patch.object(gate_module, 'STATUS_URL', f'http://127.0.0.1:{http.server_port}/internal/callback-readiness'),
                              patch.object(gate_module, 'Future', GateFuture),
                              patch.object(setup, 'get_resource', side_effect=observed_resource),
                              patch.object(setup, 'keycloak_request', side_effect=held_gateway_request),
                              grpc.insecure_channel(f'127.0.0.1:{gate_port}') as channel):
                            stub = ext_service.ExternalProcessorStub(channel)

                            def asset(index):
                                message = ext_proc.ProcessingRequest(request_headers=ext_proc.HttpHeaders(
                                    headers=base_pb2.HeaderMap(headers=[
                                        base_pb2.HeaderValue(key=':authority', value='x00.a.fixture.local'),
                                        base_pb2.HeaderValue(key=':method', value='GET'),
                                        base_pb2.HeaderValue(key=':path', value=f'/static/module-{index}.js') ])))
                                result = list(stub.Process(iter([message]), timeout=10))
                                self.assertEqual(len(result), 1)
                                return 204 if result[0].HasField('request_headers') else result[0].immediate_response.status.code

                            with ThreadPoolExecutor(max_workers=40) as pool:
                                pending = [pool.submit(asset, 0)]
                                try:
                                    self.assertTrue(entered.wait(5), 'whole-gate check did not reach real Keycloak')
                                    pending.extend(pool.submit(asset, index) for index in range(1, 40))
                                    self.assertTrue(joined.wait(3), '39 assets did not join the complete check')
                                finally:
                                    release.set()
                                self.assertEqual([future.result() for future in pending], [204] * 40)
                            self.assertEqual(len(observations), 4, 'complete route/policy observation was repeated per asset')
                            self.assertEqual(len(keycloak_checks), 1)
                            # A completed allow cannot mask a new owner or an
                            # unavailable identity dependency on the next asset.
                            old_uid = owners['a-x00']['metadata']['uid']
                            try:
                                owners['a-x00']['metadata']['uid'] = str(uuid.uuid4())
                                self.assertEqual(asset(40), 503)
                            finally:
                                owners['a-x00']['metadata']['uid'] = old_uid
                            with patch.object(setup, 'keycloak_request', side_effect=urllib.error.URLError('synthetic unavailable')):
                                self.assertEqual(asset(41), 503)
                            self.assertEqual(asset(42), 204)
                    finally:
                        release.set()
                        gate_server.stop(0).wait()
                    print('Complete callback gate: 40 asset requests, one real Keycloak check, four route/policy reads; new owner/outage denied, recovery verified')

                    # Same-host fanout: hold the actual Keycloak read so that
                    # all 64 requests overlap and must share one in-flight check.
                    entered, release, all_arrived, counts, followers, lock = threading.Event(), threading.Event(), threading.Event(), [], [], threading.Lock()
                    class TrackedFuture(Future):
                        def result(self, timeout=None):
                            with lock:
                                followers.append(1)
                                if len(followers) == 63:
                                    all_arrived.set()
                            return super().result(timeout=timeout)
                    def held_request(method, path, **kwargs):
                        if method == "GET" and "?clientId=" in path:
                            with lock:
                                counts.append(1)
                            entered.set()
                            if not release.wait(20):
                                raise TimeoutError("synthetic release timeout")
                        return request(method, path, **kwargs)
                    with (patch.object(setup, "keycloak_request", side_effect=held_request),
                          patch.object(setup, "Future", TrackedFuture)):
                        with ThreadPoolExecutor(max_workers=64) as pool:
                            futures = [pool.submit(probe, "x00.a.fixture.local") for _ in range(64)]
                            try:
                                self.assertTrue(entered.wait(10), "real Keycloak check was not reached")
                                self.assertTrue(all_arrived.wait(5), "63 followers did not join the same in-flight check")
                            finally:
                                release.set()
                            self.assertEqual([f.result() for f in futures], [204] * 64)
                        self.assertEqual(len(counts), 1, "same-host fanout was not coalesced")

                    # Hold 64 distinct live Keycloak checks concurrently; the
                    # 65th distinct host must receive 503 and recover later.
                    setup.sync_oidc_callbacks()
                    release, ready64, entered_count = threading.Event(), threading.Event(), [0]
                    def held_distinct(method, path, **kwargs):
                        if method == "GET" and "?clientId=" in path:
                            with lock:
                                entered_count[0] += 1
                                if entered_count[0] == 64:
                                    ready64.set()
                            if not release.wait(25):
                                raise TimeoutError("synthetic release timeout")
                        return request(method, path, **kwargs)
                    with patch.object(setup, "keycloak_request", side_effect=held_distinct):
                        with ThreadPoolExecutor(max_workers=64) as pool:
                            futures = [pool.submit(probe, f"x{i:02d}.a.fixture.local") for i in range(64)]
                            try:
                                self.assertTrue(ready64.wait(25), "64 distinct live Keycloak checks did not overlap")
                                self.assertEqual(probe("x64.a.fixture.local"), 503)
                            finally:
                                release.set()
                            results = [f.result() for f in futures]
                        self.assertEqual(results, [204] * 64)
                    self.assertEqual(probe("x64.a.fixture.local"), 204)
                    print("Real Keycloak readiness: 64 same-host coalesced; 64 distinct allowed; 65th 503 then 204")
            finally:
                if http:
                    http.shutdown()
                    http.server_close()
                subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=30)
                if subprocess.check_output(["docker", "ps", "-aq", "--filter", f"name=^/{name}$"], text=True, timeout=30).strip():
                    raise RuntimeError("isolated Keycloak load cleanup not verified")


if __name__ == "__main__":
    unittest.main()
