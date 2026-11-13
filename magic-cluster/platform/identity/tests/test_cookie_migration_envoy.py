# SPDX-License-Identifier: BUSL-1.1
"""Run migration Lua inside the pinned Envoy; no appliance is contacted.

The downstream authorization filter is a deterministic test double: the
separate Keycloak/browser suite is still required for real OIDC acceptance.
"""
import http.client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "docker.io/envoyproxy/envoy:distroless-v1.38.7@sha256:3d79fb37be70734406e0d3b36189f662a2fd0d202813af492880aa3646426fda"


@unittest.skipUnless(os.environ.get("MAGICSTICK_RUN_ENVOY_CONTAINER_TESTS") == "1", "pinned Envoy container gate not requested")
class PinnedEnvoyCookieMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="magicstick-envoy-cookie-")
        cls.name = "magicstick-cookie-test-" + uuid.uuid4().hex[:12]
        lua = (ROOT / "cookie-migration.lua").read_text()
        lua = lua.replace("${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}", "demo.example.local")
        lua = lua.replace("${AI_APPLIANCE_DOMAIN:=magicstick.example.com}", "example.com")
        lua = lua.replace("${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}", "demo.example.com")
        migration = {"name": "envoy.filters.http.lua/migration", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua",
            "default_source_code": {"inline_string": lua}}}
        downstream = {"name": "envoy.filters.http.lua/downstream", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua",
            "default_source_code": {"inline_string": '''function envoy_on_request(h)
                local c = h:headers():get("cookie") or ""
                if string.find(c, "MagicStickAccessToken=", 1, true) then
                  h:respond({[":status"]="401"}, "downstream reached")
                end
              end'''}}}
        config = {"static_resources": {"listeners": [{"name": "listener", "address": {"socket_address": {
            "address": "0.0.0.0", "port_value": 10000}}, "filter_chains": [{"filters": [{
            "name": "envoy.filters.network.http_connection_manager", "typed_config": {
                "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
                "stat_prefix": "cookie_test", "route_config": {"name": "test", "virtual_hosts": [{
                    "name": "test", "domains": ["*"], "routes": [{"match": {"prefix": "/"},
                        "direct_response": {"status": 200, "body": {"inline_string": "ok"}}}]}]},
                "http_filters": [migration, downstream, {"name": "envoy.filters.http.router", "typed_config": {
                    "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router"}}]}}]}]}]}}
        path = Path(cls.tmp.name) / "envoy.json"
        path.write_text(json.dumps(config))
        os.chmod(path, 0o644)
        try:
            subprocess.run(["docker", "run", "--detach", "--name", cls.name, "--publish", "127.0.0.1::10000",
                            "--volume", f"{path}:/tmp/envoy.json:ro", IMAGE, "-c", "/tmp/envoy.json"],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=180)
            endpoint = subprocess.check_output(["docker", "port", cls.name, "10000/tcp"], text=True).strip()
            cls.port = int(endpoint.rsplit(":", 1)[1])
            for _ in range(60):
                try:
                    if cls.request("GET", "")[0] == 200:
                        return
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(0.25)
            raise RuntimeError("pinned Envoy test listener did not become ready")
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rm", "-f", cls.name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        cls.tmp.cleanup()

    @classmethod
    def request(cls, method, cookie):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=5)
        try:
            connection.request(method, "/services", headers={"Host": "demo.example.local", "Cookie": cookie})
            response = connection.getresponse()
            return response.status, response.getheaders(), response.read().decode()
        finally:
            connection.close()

    def test_migration_precedes_auth_and_preserves_other_cookies(self):
        status, headers, _ = self.request("GET", "MagicStickAccessToken=synthetic; app=keep")
        self.assertEqual(status, 303)
        cookies = [value for key, value in headers if key.lower() == "set-cookie"]
        self.assertEqual(len(cookies), 5)
        self.assertTrue(all("synthetic" not in value and "app=" not in value for value in cookies))
        self.assertTrue(any(value.startswith("__Host-MagicStickCookieMigration=") for value in cookies))
        self.assertEqual(self.request("GET", "app=keep")[0], 200)

    def test_writes_are_not_replayed_and_oversized_cookie_is_explained(self):
        self.assertEqual(self.request("POST", "MagicStickAccessToken=synthetic")[0], 409)
        status, _, body = self.request("GET", "app=" + "x" * 15360)
        self.assertEqual(status, 431)
        self.assertIn("private window", body)


if __name__ == "__main__":
    unittest.main()
