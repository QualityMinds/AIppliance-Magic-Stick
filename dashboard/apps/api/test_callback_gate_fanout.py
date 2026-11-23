# SPDX-License-Identifier: BUSL-1.1
"""Concurrent page-resource checks through the actual pre-OIDC gate."""
import copy
import importlib.util
import threading
import unittest
import urllib.error
import urllib.parse
from concurrent import futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import grpc
from envoy.config.core.v3 import base_pb2
from envoy.service.ext_proc.v3 import external_processor_pb2 as messages
from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as service

import callback_gate


class CallbackGateFanoutTests(unittest.TestCase):
    HOST = "app.example.local"

    def request(self, index=0, host=None):
        return messages.ProcessingRequest(request_headers=messages.HttpHeaders(
            headers=base_pb2.HeaderMap(headers=[
                base_pb2.HeaderValue(key=":authority", value=host or self.HOST),
                base_pb2.HeaderValue(key=":method", value="GET"),
                base_pb2.HeaderValue(key=":path", value=f"/static/module-{index}.js"),
                base_pb2.HeaderValue(key="cookie", value=f"synthetic-cookie-{index}"),
                base_pb2.HeaderValue(key="authorization", value=f"synthetic-authorization-{index}"),
            ])))

    def response(self, gate, index=0, host=None):
        return next(gate.Process(iter([self.request(index, host)]), None))

    def burst(self, gate, entered, release, send=None, mutate=None, size=40):
        """Observe all followers joining before releasing the owner, without sleeps.

        create=True also runs against the old implementation: it simply ignores
        the observation seam and performs forty separate dependency checks.
        """
        condition = threading.Condition()
        joined = 0

        class ObservedFuture(futures.Future):
            def result(self, timeout=None):
                nonlocal joined
                with condition:
                    joined += 1
                    condition.notify_all()
                return super().result(timeout)

        send = send or (lambda index: self.response(gate, index))
        with mock.patch.object(callback_gate, "Future", ObservedFuture, create=True):
            with futures.ThreadPoolExecutor(max_workers=size) as pool:
                pending = [pool.submit(send, 0)]
                try:
                    self.assertTrue(entered.wait(4), "readiness owner did not start")
                    pending.extend(pool.submit(send, index) for index in range(1, size))
                    with condition:
                        coalesced = condition.wait_for(lambda: joined == size - 1, timeout=3)
                    if mutate:
                        mutate()
                finally:
                    release.set()
                results = [future.result(timeout=10) for future in pending]
        return results, coalesced

    def assert_allowed(self, results):
        for result in results:
            self.assertTrue(result.HasField("request_headers"))
            self.assertEqual(result.request_headers.response.status, messages.CommonResponse.CONTINUE)
            self.assertFalse(result.request_headers.response.HasField("header_mutation"))
            self.assertNotIn("synthetic-cookie", str(result))
            self.assertNotIn("synthetic-authorization", str(result))

    def assert_denied(self, results):
        for result in results:
            self.assertTrue(result.HasField("immediate_response"))
            self.assertEqual(result.immediate_response.status.code, 503)
            self.assertNotIn("synthetic-cookie", str(result))
            self.assertNotIn("synthetic-authorization", str(result))

    def test_forty_overlapping_assets_share_one_complete_check(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def check(host):
            calls.append(host)
            entered.set()
            return release.wait(8)

        gate = callback_gate.Gate(check)
        results, coalesced = self.burst(gate, entered, release)
        self.assertEqual(calls, [self.HOST], "one complete readiness check per overlapping asset burst")
        self.assertTrue(coalesced)
        self.assert_allowed(results)

    def test_completed_positive_and_negative_decisions_are_not_cached(self):
        state, calls = [True], []
        gate = callback_gate.Gate(lambda host: calls.append(host) or state[0])
        self.assert_allowed([self.response(gate)])
        state[0] = False
        self.assert_denied([self.response(gate)])
        state[0] = True
        self.assert_allowed([self.response(gate)])
        self.assertEqual(calls, [self.HOST] * 3)
        self.assertEqual(gate._inflight, {})

    def test_negative_fanout_recovers_on_a_fresh_check(self):
        entered, release = threading.Event(), threading.Event()
        healthy, calls = [False], []

        def check(host):
            calls.append(host)
            entered.set()
            return release.wait(8) and healthy[0]

        gate = callback_gate.Gate(check)
        results, coalesced = self.burst(gate, entered, release)
        self.assertTrue(coalesced)
        self.assertEqual(calls, [self.HOST])
        self.assert_denied(results)
        healthy[0] = True
        self.assert_allowed([self.response(gate)])
        self.assertEqual(calls, [self.HOST] * 2)

    def test_another_host_is_checked_independently(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def check(host):
            calls.append(host)
            if host != self.HOST:
                return False
            entered.set()
            return release.wait(8)

        gate = callback_gate.Gate(check)
        with futures.ThreadPoolExecutor(max_workers=2) as pool:
            owner = pool.submit(self.response, gate)
            try:
                self.assertTrue(entered.wait(4))
                other = pool.submit(self.response, gate, 1, "other.example.local")
                self.assert_denied([other.result(timeout=3)])
                self.assertFalse(owner.done())
            finally:
                release.set()
            self.assert_allowed([owner.result(timeout=4)])
        self.assertCountEqual(calls, [self.HOST, "other.example.local"])

    def test_equivalent_authorities_share_only_the_canonical_host(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def check(host):
            calls.append(host)
            entered.set()
            return release.wait(8)

        gate = callback_gate.Gate(check)
        results, coalesced = self.burst(
            gate, entered, release,
            send=lambda index: self.response(gate, index, self.HOST.upper() + ":443" if index % 2 else self.HOST))
        self.assertTrue(coalesced)
        self.assertEqual(calls, [self.HOST])
        self.assert_allowed(results)

    def test_duplicate_authority_cannot_join_a_valid_pending_check(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def check(host):
            calls.append(host)
            entered.set()
            return release.wait(8)

        gate = callback_gate.Gate(check)
        with futures.ThreadPoolExecutor(max_workers=2) as pool:
            owner = pool.submit(self.response, gate)
            try:
                self.assertTrue(entered.wait(4))
                request = self.request(1)
                request.request_headers.headers.headers.add(key=":authority", value=self.HOST)
                invalid = pool.submit(lambda: next(gate.Process(iter([request]), None)))
                self.assert_denied([invalid.result(timeout=3)])
                self.assertFalse(owner.done())
            finally:
                release.set()
            self.assert_allowed([owner.result(timeout=4)])
        self.assertEqual(calls, [self.HOST])

    def test_check_exception_denies_the_group_and_does_not_poison_later_checks(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def check(host):
            calls.append(host)
            entered.set()
            release.wait(8)
            raise ValueError("synthetic-private-cookie-and-authorization")

        gate = callback_gate.Gate(check)
        with self.assertLogs(callback_gate.LOGGER, level="WARNING") as logs:
            results, coalesced = self.burst(gate, entered, release)
        self.assertTrue(coalesced)
        self.assertEqual(calls, [self.HOST])
        self.assert_denied(results)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("reason=check_error", logs.output[0])
        self.assertRegex(logs.output[0], r"elapsed_ms=\d+")
        self.assertNotIn("synthetic-private", logs.output[0])
        self.assertNotIn(self.HOST, logs.output[0])
        self.assertEqual(gate._inflight, {})
        gate.check = lambda _: True
        self.assert_allowed([self.response(gate)])

    def test_follower_timeout_fails_closed_without_cancelling_the_owner(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def check(host):
            calls.append(host)
            entered.set()
            return release.wait(8)

        gate = callback_gate.Gate(check)
        with futures.ThreadPoolExecutor(max_workers=1) as pool:
            owner = pool.submit(self.response, gate)
            try:
                self.assertTrue(entered.wait(4))
                with mock.patch.object(callback_gate, "READINESS_TIMEOUT_SECONDS", 0.03):
                    with self.assertLogs(callback_gate.LOGGER, level="WARNING") as logs:
                        self.assert_denied([self.response(gate, 1)])
                self.assertIn("reason=overlap_timeout", logs.output[0])
                self.assertFalse(owner.done())
                self.assertEqual(calls, [self.HOST])
            finally:
                release.set()
            self.assert_allowed([owner.result(timeout=4)])
        self.assertEqual(gate._inflight, {})
        gate.check = lambda _: False
        self.assert_denied([self.response(gate)])

    def test_real_gateway_observer_rejects_midflight_identity_policy_and_readiness_changes(self):
        # Execute the actual owning Setup loader/checker, not a second copy of
        # its revision validation. Kubernetes and the identity dependency are
        # synthetic here; native API and real Keycloak gates remain separate.
        path = Path(__file__).resolve().parents[3] / "magic-cluster/platform/identity/tests/test_setup_server.py"
        spec = importlib.util.spec_from_file_location("callback_setup_fanout_fixture", path)
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        for change in ("route_uid", "route_generation", "missing_route", "missing_policy",
                       "failed_policy_read", "identity_unavailable"):
            with self.subTest(change=change):
                setup = fixture.load_setup_module()
                entered, release = threading.Event(), threading.Event()
                route = {"metadata": {"name": "app", "uid": "route-before", "generation": 1},
                         "spec": {"parentRefs": [{"name": "identity-pilot"}], "hostnames": [self.HOST]}}
                policy = {"metadata": {"name": "app-sso", "uid": "policy-before", "generation": 1},
                          "spec": {"targetRefs": [{"group": "gateway.networking.k8s.io",
                                                    "kind": "HTTPRoute", "name": "app"}],
                                   "oidc": {"redirectURL": f"https://{self.HOST}/oauth2/callback/exact"}}}
                state = {"routes": [route], "policies": [policy], "read_failed": False, "identity_ready": True}
                calls = []

                def read(resource):
                    if resource.endswith("/httproutes"):
                        return {"items": copy.deepcopy(state["routes"])}
                    if resource.endswith("/securitypolicies"):
                        return None if state["read_failed"] else {"items": copy.deepcopy(state["policies"])}
                    if resource == setup.CALLBACKS_STATUS_PATH:
                        return {"data": {"redirects.json": '["https://' + self.HOST + '/oauth2/callback/exact"]'}}
                    self.fail("unexpected synthetic resource read")

                def identity(host):
                    calls.append(host)
                    entered.set()
                    return release.wait(8) and state["identity_ready"]

                def mutate():
                    if change == "route_uid":
                        route["metadata"]["uid"] = "route-after"
                    elif change == "route_generation":
                        route["metadata"]["generation"] += 1
                    elif change == "missing_route":
                        state["routes"] = []
                    elif change == "missing_policy":
                        state["policies"] = []
                    elif change == "failed_policy_read":
                        state["read_failed"] = True
                    else:
                        state["identity_ready"] = False

                with (mock.patch.object(setup, "get_resource", side_effect=read),
                      mock.patch.object(setup, "callback_readiness_singleflight", side_effect=identity)):
                    gate = callback_gate.Gate(setup.gateway_callback_readiness)
                    results, coalesced = self.burst(gate, entered, release, mutate=mutate)
                    self.assertTrue(coalesced)
                    self.assertEqual(calls, [self.HOST])
                    self.assert_denied(results)
                    state.update(routes=[route], policies=[policy], read_failed=False, identity_ready=True)
                    self.assert_allowed([self.response(gate)])
                    self.assertEqual(calls, [self.HOST] * 2)

    def test_http_and_transport_failure_diagnostics_remain_fixed_and_credential_free(self):
        private = "https://private.example.invalid/?token=synthetic-private-credential"
        cases = [(urllib.error.HTTPError(private, 503, "synthetic-private-credential", {}, None), "http_status", "503"),
                 (TimeoutError("synthetic-private-credential"), "timeout", "unknown"),
                 (urllib.error.URLError(TimeoutError("synthetic-private-credential")), "timeout", "unknown"),
                 (urllib.error.URLError(private), "transport_error", "unknown")]
        for error, reason, status in cases:
            with self.subTest(reason=reason, status=status):
                with mock.patch.object(callback_gate.urllib.request, "urlopen", side_effect=error):
                    with self.assertLogs(callback_gate.LOGGER, level="WARNING") as logs:
                        self.assertFalse(callback_gate.ready(self.HOST))
                self.assertEqual(len(logs.output), 1)
                self.assertIn("reason=" + reason, logs.output[0])
                self.assertIn("status=" + status, logs.output[0])
                self.assertNotIn("synthetic-private", logs.output[0])
                self.assertNotIn("private.example", logs.output[0])
                self.assertNotIn(self.HOST, logs.output[0])

    def test_real_grpc_asset_burst_makes_one_real_http_readiness_request(self):
        entered, release = threading.Event(), threading.Event()
        observed = []

        class Readiness(BaseHTTPRequestHandler):
            def do_GET(self):
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                observed.append({"host": query.get("host"), "gateway": query.get("gateway"),
                                 "cookiePresent": bool(self.headers.get("Cookie")),
                                 "authorizationPresent": bool(self.headers.get("Authorization"))})
                entered.set()
                available = release.wait(8)
                self.send_response(204 if available else 503)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        class ReadinessServer(ThreadingHTTPServer):
            request_queue_size = 128

        http = ReadinessServer(("127.0.0.1", 0), Readiness)
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        threading.Thread(target=http.serve_forever, daemon=True).start()
        server = grpc.server(futures.ThreadPoolExecutor(max_workers=64))
        gate = callback_gate.Gate()
        service.add_ExternalProcessorServicer_to_server(gate, server)
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        self.addCleanup(lambda: server.stop(0).wait())
        self.addCleanup(release.set)
        with mock.patch.object(callback_gate, "STATUS_URL",
                               f"http://127.0.0.1:{http.server_port}/internal/callback-readiness"):
            with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
                stub = service.ExternalProcessorStub(channel)

                def send(index):
                    responses = list(stub.Process(iter([self.request(index)]), timeout=10))
                    self.assertEqual(len(responses), 1)
                    return responses[0]

                results, coalesced = self.burst(gate, entered, release, send=send)
        self.assertEqual(observed, [{"host": [self.HOST], "gateway": ["1"],
                                    "cookiePresent": False, "authorizationPresent": False}])
        self.assertTrue(coalesced)
        self.assert_allowed(results)


if __name__ == "__main__":
    unittest.main()
