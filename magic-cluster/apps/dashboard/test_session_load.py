# SPDX-License-Identifier: BUSL-1.1
"""Isolated authorization concurrency checks, not live performance acceptance."""
import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch

from test_dashboard_api import load_server


def synthetic_token(server, client):
    claims = {"iss": server["OIDC_EXPECTED_ISSUER"], "azp": client,
              "sub": "fixture-subject", "exp": time.time() + 300,
              "realm_access": {"roles": ["magicstick-user", "magicstick-admin"]}}
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "Bearer synthetic." + encoded + ".synthetic"


class SessionConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.server = load_server()
        self.lock = threading.Lock()
        self.calls = 0

    def userinfo(self, *_args, **_kwargs):
        # Deterministic synthetic network delay; this is not Keycloak latency.
        time.sleep(0.01)
        with self.lock:
            self.calls += 1
        return io.BytesIO(b'{"sub":"fixture-subject","preferred_username":"fixture"}')

    def test_concurrent_requests_consult_idp_each_time_then_fail_closed(self):
        token = synthetic_token(self.server, "magicstick-human-gateway-local")
        def request(_):
            start = time.perf_counter()
            self.server["authorize"](token, "user", {})
            return time.perf_counter() - start
        with patch("urllib.request.urlopen", side_effect=self.userinfo):
            with ThreadPoolExecutor(max_workers=16) as pool:
                samples = sorted(pool.map(request, range(64)))
        self.assertEqual(self.calls, 64, "each decision must consult the live session")
        print("Synthetic session probe: 64 requests, 16 workers, simulated IdP 10 ms; "
              f"median {samples[32] * 1000:.1f} ms, p95 {samples[60] * 1000:.1f} ms")

        # The preceding successful calls cannot create a cached allow during
        # an outage, including when requests arrive concurrently.
        def unavailable(*_args, **_kwargs):
            raise urllib.error.URLError("synthetic outage")
        def denied(_):
            try:
                self.server["authorize"](token, "user", {})
            except self.server["AuthError"] as error:
                return error.status
            return 200
        with patch("urllib.request.urlopen", side_effect=unavailable):
            with ThreadPoolExecutor(max_workers=16) as pool:
                statuses = list(pool.map(denied, range(64)))
        self.assertEqual(statuses, [503] * 64)

    def test_cli_and_local_console_remain_distinct(self):
        cli = synthetic_token(self.server, "magicstick-cli")
        console = synthetic_token(self.server, "magicstick-console")
        with patch("urllib.request.urlopen", side_effect=self.userinfo), patch.dict(
            self.server, {"console_live_roles": lambda _subject, roles: roles}
        ):
            self.assertEqual(self.server["authorize"](cli, "user", {})["subject"], "fixture-subject")
            self.assertTrue(self.server["authorize"](console, "user", {})["localConsole"])
            with self.assertRaises(self.server["AuthError"]) as denied:
                self.server["authorize"](console, "user", {"X-Forwarded-For": "192.0.2.1"})
            self.assertEqual(denied.exception.status, 403)


if __name__ == "__main__":
    unittest.main()
