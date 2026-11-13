# SPDX-License-Identifier: BUSL-1.1
"""Execute the actual Envoy Lua with synthetic headers, without credentials.

The native Envoy/Keycloak browser fixture is the separate protocol gate. Lupa
is optional on developer hosts; missing Lua is an explicit skipped check.
"""
import unittest
from pathlib import Path

try:
    from lupa import LuaRuntime
except ImportError:
    LuaRuntime = None

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(LuaRuntime, "Lua runtime unavailable; execute real Envoy protocol gate")
class CookieMigrationTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        script = (ROOT / "cookie-migration.lua").read_text()
        script = script.replace("${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}", "demo.example.local")
        script = script.replace("${AI_APPLIANCE_DOMAIN:=magicstick.example.com}", "example.com")
        script = script.replace("${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}", "demo.example.com")
        self.lua.execute(script)
        self.run_filter = self.lua.eval('''function(method, host, path, cookie)
            local input = {[":method"] = method, [":authority"] = host,
                           [":path"] = path, ["cookie"] = cookie}
            local h = {get = function(_, key) return input[key] end}
            local result = nil
            local request = {
                headers = function(_) return h end,
                respond = function(_, headers, body) result = {headers=headers, body=body} end,
            }
            envoy_on_request(request)
            return result
        end''')

    def request(self, cookie, method="GET", host="demo.example.local", path="/services"):
        return self.run_filter(method, host, path, cookie)

    def test_only_owned_names_are_expired_and_action_is_not_replayed(self):
        result = self.request("app_pref=keep; MagicStickAccessToken=secret; OauthHMAC-deadbeef=keep")
        self.assertEqual(result.headers[":status"], "303")
        self.assertEqual(result.headers["location"], "/services")
        expires = list(result.headers["set-cookie"].values())
        self.assertEqual(len(expires), 5)
        self.assertTrue(all("secret" not in value and "app_pref" not in value and "OauthHMAC" not in value for value in expires))
        self.assertEqual(sum("Domain=demo.example.local" in value for value in expires), 2)
        self.assertIn("__Host-MagicStickCookieMigration=2", expires[-1])
        write = self.request("MagicStickAccessToken=secret", method="POST")
        self.assertEqual(write.headers[":status"], "409")
        self.assertIsNone(write.headers["location"])

    def test_marker_prevents_loops_and_keycloak_is_never_intercepted(self):
        self.assertIsNone(self.request("MagicStickIDToken=x; __Host-MagicStickCookieMigration=2"))
        self.assertIsNone(self.request("MagicStickIDToken=x", host="id.demo.example.local"))
        self.assertIsNone(self.request("MagicStickIDToken=x", host="evil-example.local"))

    def test_safe_relative_redirect_and_public_parent(self):
        result = self.request("MagicStickIDToken=x", host="demo.example.com", path="//evil.invalid/")
        self.assertEqual(result.headers["location"], "/")
        self.assertIn("Domain=example.com", result.headers["set-cookie"][1])
        result = self.request("MagicStickIDToken=x", path="/\\evil.invalid/")
        self.assertEqual(result.headers["location"], "/")

    def test_oversized_unattributed_data_has_visible_manual_recovery(self):
        result = self.request("app=" + "x" * 15360)
        self.assertEqual(result.headers[":status"], "431")
        self.assertIn("private window", result.body)
        self.assertNotIn("x" * 100, result.body)
        self.assertIsNone(self.request("app=" + "x" * 1000))


if __name__ == "__main__":
    unittest.main()
