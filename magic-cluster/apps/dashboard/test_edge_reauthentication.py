# SPDX-License-Identifier: BUSL-1.1
"""Real HTTP-handler counterexamples for bounded browser reauthentication."""
import copy
import http.client
from pathlib import Path
import threading
import unittest
from unittest.mock import Mock, patch

import yaml

from test_dashboard_api import load_server


class EdgeReauthenticationTests(unittest.TestCase):
    def setUp(self):
        self.server = load_server()
        self.instance = {"metadata": {"name": "hermes-fixture", "uid": "fixture-owner"},
                         "spec": {"enabled": True, "access": {"authentication": "sso"}}}
        self.auth = Mock(return_value={"subject": "fixture-user", "roles": ["magicstick-user"]})
        self.usage = Mock()
        bindings = patch.dict(self.server, {
            "app_instance": lambda name: copy.deepcopy(self.instance) if name == "hermes-fixture" else None,
            "authenticated_principal": self.auth, "require_instance_usage": self.usage,
        })
        bindings.start()
        self.addCleanup(bindings.stop)
        http = self.server["ThreadingHTTPServer"](("127.0.0.1", 0), self.server["Handler"])
        self.port = http.server_port
        threading.Thread(target=http.serve_forever, daemon=True).start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)

    def request(self, method="GET", path="/internal/instance-access/hermes-fixture/fixture-owner/chat",
                headers=None):
        defaults = {"Cookie": "__Host-MagicStickAccessToken=fixture-private; app-preference=keep",
                    "Accept": "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        defaults.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(connection.close)
        connection.request(method, path, headers=defaults)
        response = connection.getresponse()
        return response.status, response.headers, response.read().decode()

    def unauthenticated(self, status=401):
        self.auth.side_effect = self.server["AuthError"](status, "private diagnostic must not leave the guard")

    def assert_no_redirect_or_cookie_change(self, headers):
        self.assertIsNone(headers.get("Location"))
        self.assertIsNone(headers.get("Set-Cookie"))

    def test_expired_browser_navigation_restarts_only_the_current_host(self):
        self.unauthenticated()
        status, headers, body = self.request()
        self.assertEqual(status, 303)
        self.assertEqual(headers.get("Location"), "/")
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        cookies = headers.get_all("Set-Cookie")
        self.assertEqual(len(cookies), 3)
        self.assertEqual({cookie.split("=", 1)[0] for cookie in cookies}, {
            "__Host-MagicStickAccessToken", "__Host-MagicStickIDToken", "__Host-MagicStickReauth"})
        for cookie in cookies:
            self.assertIn("Path=/", cookie)
            self.assertIn("Secure", cookie)
            self.assertIn("HttpOnly", cookie)
            self.assertNotIn("Domain=", cookie)
            self.assertNotIn("fixture-private", cookie)
            self.assertNotIn("app-preference", cookie)
        self.assertEqual(sum("Max-Age=0" in cookie for cookie in cookies), 2)
        self.assertIn("__Host-MagicStickReauth=1;", cookies[-1])
        self.assertIn("Max-Age=60", cookies[-1])
        self.assertEqual(body, "")
        # No untrusted request header may select a different redirect origin.
        self.assertEqual(self.request(headers={"Host": "outside.invalid", "Referer": "https://outside.invalid/"})[1].get("Location"), "/")

    def test_head_can_reauthenticate_but_no_mutation_is_replayed(self):
        self.unauthenticated()
        self.assertEqual(self.request(method="HEAD")[0], 303)
        for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            with self.subTest(method=method):
                status, headers, body = self.request(method=method)
                self.assertEqual(status, 401)
                self.assert_no_redirect_or_cookie_change(headers)
                self.assertNotIn("private diagnostic", body)

    def test_fetch_api_and_non_document_requests_do_not_redirect(self):
        self.unauthenticated()
        for overrides in ({"Accept": "application/json"}, {"Accept": "*/*"},
                          {"Sec-Fetch-Mode": "cors"}, {"Sec-Fetch-Mode": ""},
                          {"Sec-Fetch-Dest": "empty"}, {"Sec-Fetch-Dest": "iframe"}):
            with self.subTest(overrides=overrides):
                status, headers, _ = self.request(headers=overrides)
                self.assertEqual(status, 401)
                self.assert_no_redirect_or_cookie_change(headers)
                self.assertEqual(headers.get("WWW-Authenticate"), 'Bearer realm="magicstick"')

    def test_bearer_without_our_host_cookie_does_not_change_browser_state(self):
        self.unauthenticated()
        for cookie in ("", "app-preference=keep", "MagicStickAccessToken=legacy"):
            with self.subTest(cookie=cookie):
                status, headers, _ = self.request(headers={"Cookie": cookie, "Authorization": "Bearer fixture-native"})
                self.assertEqual(status, 401)
                self.assert_no_redirect_or_cookie_change(headers)

    def test_short_lived_marker_bounds_reauthentication_loops(self):
        self.unauthenticated()
        status, headers, body = self.request(headers={
            "Cookie": "__Host-MagicStickAccessToken=fixture-private; __Host-MagicStickReauth=1"})
        self.assertEqual(status, 401)
        self.assert_no_redirect_or_cookie_change(headers)
        self.assertNotIn("private diagnostic", body)

    def test_missing_roles_and_grants_remain_forbidden(self):
        self.auth.return_value = {"subject": "fixture-user", "roles": []}
        status, headers, _ = self.request()
        self.assertEqual(status, 403)
        self.assert_no_redirect_or_cookie_change(headers)
        self.auth.return_value["roles"] = ["magicstick-user"]
        self.instance["spec"]["access"]["sharing"] = {"mode": "grants", "users": [], "groups": []}
        self.usage.side_effect = self.server["AuthError"](403, "private denied grant")
        status, headers, body = self.request()
        self.assertEqual(status, 403)
        self.assert_no_redirect_or_cookie_change(headers)
        self.assertNotIn("private denied grant", body)

    def test_changed_owner_disabled_or_malformed_access_never_reauthenticate(self):
        self.unauthenticated()
        for change in ("owner", "disabled", "authentication", "deleting"):
            with self.subTest(change=change):
                original = copy.deepcopy(self.instance)
                if change == "owner":
                    self.instance["metadata"]["uid"] = "replacement-owner"
                elif change == "disabled":
                    self.instance["spec"]["enabled"] = False
                elif change == "authentication":
                    self.instance["spec"]["access"]["authentication"] = "unknown"
                else:
                    self.instance["metadata"]["deletionTimestamp"] = "2026-01-01T00:00:00Z"
                status, headers, _ = self.request()
                self.assertEqual(status, 403)
                self.assert_no_redirect_or_cookie_change(headers)
                self.instance = original
        self.auth.assert_not_called()

    def test_unavailable_identity_or_unknown_error_stays_closed_without_erasing_cookies(self):
        for error in (self.server["AuthError"](503, "private IdP response"),
                      TimeoutError("private transport"), RuntimeError("private unknown")):
            with self.subTest(error=type(error).__name__):
                self.auth.side_effect = error
                status, headers, body = self.request()
                self.assertEqual(status, 503)
                self.assert_no_redirect_or_cookie_change(headers)
                self.assertNotIn("private", body)

    def test_valid_session_keeps_native_authorization_and_existing_access_checks(self):
        status, headers, _ = self.request(headers={"Authorization": "Bearer fixture-native"})
        self.assertEqual(status, 200)
        self.assert_no_redirect_or_cookie_change(headers)
        self.auth.assert_called_once_with("Bearer fixture-private")

    def test_session_guard_uses_the_same_safe_browser_and_error_contract(self):
        self.unauthenticated()
        path = "/internal/session-access/protected"
        self.assertEqual(self.request(path=path)[0], 303)
        status, headers, _ = self.request(path=path, headers={"Accept": "application/json"})
        self.assertEqual(status, 401)
        self.assert_no_redirect_or_cookie_change(headers)
        self.unauthenticated(403)
        status, headers, _ = self.request(path=path)
        self.assertEqual(status, 403)
        self.assert_no_redirect_or_cookie_change(headers)


class EdgeNavigationPolicyTests(unittest.TestCase):
    def test_all_static_session_guards_forward_only_the_bounded_navigation_hints(self):
        root = Path(__file__).resolve().parents[3]
        paths = ["magic-cluster/platform/identity/security-policy.yaml", "magic-cluster/apps/dashboard/gateway.yaml"]
        paths += ["magic-cluster/apps/ai/" + app + "/base/gateway.yaml" for app in ("anything-llm", "kubeopencode", "litellm")]
        checked = 0
        for path in paths:
            for item in yaml.safe_load_all((root / path).read_text()):
                guard = (item or {}).get("spec", {}).get("extAuth", {})
                if guard.get("http", {}).get("path") != "/internal/session-access":
                    continue
                with self.subTest(path=path, policy=item["metadata"]["name"]):
                    self.assertIs(guard.get("failOpen"), False)
                    self.assertEqual(guard["headersToExtAuth"], ["Cookie", "Authorization", "Accept", "Sec-Fetch-Mode", "Sec-Fetch-Dest"])
                    checked += 1
        self.assertEqual(checked, 9)


if __name__ == "__main__":
    unittest.main()
