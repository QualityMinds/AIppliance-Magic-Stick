# SPDX-License-Identifier: BUSL-1.1
"""Real TCP admission and HTTP framing for the per-request access guards."""
import concurrent.futures
import copy
import http.client
import io
import json
import socket
import threading
import time
import unittest
from contextlib import redirect_stdout
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

from test_dashboard_api import load_server


class EdgeTransportTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.instance = {"metadata": {"name": "app-fixture", "uid": "fixture-owner"},
                         "spec": {"enabled": True, "access": {"authentication": "sso"}}}
        self.auth = Mock(return_value={"subject": "fixture-user", "roles": ["magicstick-user"]})
        bindings = patch.dict(self.api, {
            "app_instance": lambda name: copy.deepcopy(self.instance),
            "authenticated_principal": self.auth,
        })
        bindings.start()
        self.addCleanup(bindings.stop)
        self.server_type = self.api.get("DashboardHTTPServer", ThreadingHTTPServer)

    def listener(self, server_type=None):
        server = (server_type or self.server_type)(("127.0.0.1", 0), self.api["Handler"])
        self.addCleanup(server.server_close)
        return server

    def connect_wave(self, server, count=32):
        """Hold accept until a bounded TCP wave completes, without scheduling sleeps."""
        start = threading.Barrier(count)

        def connect(_):
            start.wait(timeout=5)
            try:
                connection = socket.create_connection(server.server_address, timeout=0.75)
                return connection
            except OSError:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as workers:
            sockets = list(workers.map(connect, range(count)))
        for connection in sockets:
            if connection is not None:
                self.addCleanup(connection.close)
        return sockets

    def start(self, server):
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)

    def request(self, address, index=0, headers=None):
        connection = http.client.HTTPConnection(*address, timeout=8)
        try:
            request_headers = {"Accept": "*/*", "Cookie": "__Host-MagicStickAccessToken=fixture-private"}
            request_headers.update(headers or {})
            connection.request("GET", "/internal/instance-access/app-fixture/fixture-owner/static/module-" + str(index) + ".js",
                               headers=request_headers)
            response = connection.getresponse()
            return response.status, response.getheader("Content-Length"), response.read(), response.version
        finally:
            connection.close()

    def test_control_reproduces_the_five_slot_admission_bottleneck(self):
        class SmallListener(self.server_type):
            request_queue_size = 5

        server = self.listener(SmallListener)
        sockets = self.connect_wave(server)
        self.assertLess(sum(connection is not None for connection in sockets), len(sockets),
                        "The control did not reproduce the small accept queue; no capacity proof is available")

    def test_listener_admits_a_complete_waiting_wave_before_accept_resumes(self):
        server = self.listener()
        sockets = self.connect_wave(server)
        self.assertEqual(sum(connection is not None for connection in sockets), len(sockets),
                         "A parallel application resource wave overflowed the API listener")
        self.start(server)
        for connection in sockets:
            connection.settimeout(5)
            connection.sendall(b"GET /internal/session-access/static/module.js HTTP/1.0\r\nAccept: */*\r\n\r\n")
        for connection in sockets:
            response = http.client.HTTPResponse(connection)
            response.begin()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Length"), "0")
            self.assertEqual(response.read(), b"")

    def test_authenticated_resource_bursts_keep_per_request_checks_and_framing(self):
        server = self.listener()
        self.start(server)
        for count in (32, 64, 128):
            with self.subTest(parallel=count):
                before = self.auth.call_count
                start = threading.Barrier(count)

                def request(index):
                    start.wait(timeout=8)
                    return self.request(server.server_address, index)

                with concurrent.futures.ThreadPoolExecutor(max_workers=count) as workers:
                    results = list(workers.map(request, range(count)))
                self.assertEqual(results, [(200, "0", b"", 10)] * count)
                self.assertEqual(self.auth.call_count - before, count,
                                 "A resource reused another request's authorization")

    def failure_records(self, output):
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(records)
        for record in records:
            self.assertEqual(set(record), {"event", "check_id", "stage", "reason", "status", "elapsed_ms"})
            self.assertEqual(record["event"], "edge_guard_failure")
            self.assertRegex(record["check_id"], r"^[0-9a-f]{24}$")
            self.assertIs(type(record["elapsed_ms"]), int)
            self.assertGreaterEqual(record["elapsed_ms"], 0)
            self.assertLessEqual(record["elapsed_ms"], 120000)
        for private in ("fixture-private", "fixture-user", "fixture-owner", "app-fixture", "secret-diagnostic", "static/module"):
            self.assertNotIn(private, output.getvalue())
        return records

    def test_dependency_failure_retains_a_safe_stage_and_reason(self):
        import urllib.error
        error = self.api["AuthError"](503, "secret-diagnostic")
        error.__cause__ = urllib.error.URLError(TimeoutError("secret-diagnostic"))
        self.auth.side_effect = error
        server = self.listener()
        self.start(server)
        output = io.StringIO()
        with redirect_stdout(output):
            status, _, body, _ = self.request(server.server_address, headers={"X-Request-ID": "secret-diagnostic"})
        self.assertEqual(status, 503)
        self.assertNotIn(b"secret-diagnostic", body)
        record, = self.failure_records(output)
        self.assertEqual((record["stage"], record["reason"], record["status"]),
                         ("session-check", "dependency_timeout", 503))
        self.auth.side_effect = None
        self.assertEqual(self.request(server.server_address)[0], 200)

    def test_instance_read_failure_is_not_a_session_rejection(self):
        def unavailable(_name):
            raise TimeoutError("secret-diagnostic")
        self.api["app_instance"] = unavailable
        server = self.listener()
        self.start(server)
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(self.request(server.server_address)[0], 503)
        record, = self.failure_records(output)
        self.assertEqual((record["stage"], record["reason"]), ("instance-read", "dependency_timeout"))
        self.auth.assert_not_called()

    def test_disconnected_success_does_not_write_a_second_status(self):
        handler = object.__new__(self.api["Handler"])
        handler.route = lambda: "/internal/instance-access/app-fixture/fixture-owner/static/module.js"
        handler.edge_authorization = lambda: "Bearer fixture-private"
        handler.headers = {}
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock(side_effect=BrokenPipeError("secret-diagnostic"))
        handler.send_edge_auth_error = Mock()
        handler.close_connection = False
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertTrue(handler.handle_instance_guard())
        handler.send_response.assert_called_once_with(200)
        handler.send_edge_auth_error.assert_not_called()
        self.assertTrue(handler.close_connection)
        record, = self.failure_records(output)
        self.assertEqual((record["stage"], record["reason"]), ("response-write", "peer_closed"))
        self.assertIsNone(record["status"], "A lost response must not invent an observed HTTP status")

    def test_disconnected_denial_keeps_one_opaque_failure_id(self):
        handler = object.__new__(self.api["Handler"])
        handler.send_edge_auth_error = Mock(side_effect=ConnectionResetError("secret-diagnostic"))
        handler.close_connection = False
        output = io.StringIO()
        with redirect_stdout(output):
            handler.edge_guard_failure(self.api["AuthError"](403, "secret-diagnostic"),
                                       "access-check", time.monotonic())
        records = self.failure_records(output)
        self.assertEqual([record["reason"] for record in records], ["access_denied", "connection_reset"])
        self.assertEqual(records[0]["check_id"], records[1]["check_id"])
        self.assertEqual(records[0]["status"], 403)
        self.assertIsNone(records[1]["status"])
        handler.send_edge_auth_error.assert_called_once()
        self.assertTrue(handler.close_connection)

    def test_arbitrary_failure_stage_is_not_logged(self):
        handler = object.__new__(self.api["Handler"])
        handler.send_edge_auth_error = Mock()
        output = io.StringIO()
        with redirect_stdout(output):
            handler.edge_guard_failure(RuntimeError("secret-diagnostic"), "secret-diagnostic", time.monotonic())
        record, = self.failure_records(output)
        self.assertEqual((record["stage"], record["reason"]), ("unknown", "verification_unavailable"))


if __name__ == "__main__":
    unittest.main()
