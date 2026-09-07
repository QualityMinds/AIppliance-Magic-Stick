# SPDX-License-Identifier: MIT
"""Contract/security regression tests with ephemeral licenses and identities."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import threading
import types
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import yaml

from instance_access import InstanceAccess, restricted, redact_hidden
from licensing import LicenseError, installed_capabilities
import test_licensing

ROOT = Path(__file__).resolve().parents[3]
source = importlib.util.spec_from_file_location("sharing_test", ROOT / "enterprise/magicstick_enterprise/sharing.py")
enterprise = importlib.util.module_from_spec(source)
source.loader.exec_module(enterprise)


def instance(name="hermes-private", sharing=None):
    return {"apiVersion": "appliance.magicstick.dev/v1alpha1", "kind": "AppInstance",
            "metadata": {"name": name, "uid": "test-uid", "resourceVersion": "4"},
            "spec": {"application": "hermes", "values": {"name": name.removeprefix("hermes-")},
                     "access": {"authentication": "sso", "role": "user", "sharing": sharing or {"mode": "selected", "users": ["alice"], "groups": ["team"]}}},
            "status": {"phase": "Ready", "accessGuardReady": True, "localURL": "https://" + name.removeprefix("hermes-") + ".hermes.example.local/"}}


class SharingTests(unittest.TestCase):
    def setUp(self):
        self.modules = patch.dict(sys.modules, {
            "magicstick_enterprise": types.SimpleNamespace(CAPABILITIES={"resource-sharing"}),
            "magicstick_enterprise.sharing": enterprise,
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.fixture = test_licensing.LicenseTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.service.activate(self.fixture.document(), self.fixture.service.status()["revision"])
        self.users = {name: {"id": name, "username": name, "enabled": True} for name in ("alice", "bob", "carol", "admin")}
        self.groups = {"team": {"id": "team", "name": "Team"}, "child": {"id": "child", "name": "Subteam", "parentId": "team"}}
        self.membership = {"bob": [{"id": "child"}]}
        self.roles = {name: ["magicstick-viewer"] for name in self.users}
        self.roles["admin"] = ["magicstick-admin"]
        self.writes = []

        def identity(method, path):
            kind, _, identifier = path.strip("/").partition("/")
            if "?" in kind:
                kind = kind.split("?")[0]
                return list((self.users if kind == "users" else self.groups).values())
            return copy.deepcopy((self.users if kind == "users" else self.groups)[identifier])

        def admin(principal):
            if principal["subject"] != "admin" or not self.users["admin"]["enabled"]:
                raise LicenseError("forbidden", "Live administrator required.", 403)

        def write(method, path, body):
            self.writes.append((method, path, body))
            result = copy.deepcopy(body)
            result["metadata"]["resourceVersion"] = "5"
            result["status"] = {"accessGuardReady": True}
            return result

        self.service = InstanceAccess(license_service=self.fixture.service, user=lambda name: copy.deepcopy(self.users[name]),
            groups=lambda name: copy.deepcopy(self.membership.get(name, [])), roles=lambda name: self.roles[name],
            identity=identity, admin=admin, request=write, namespace="test")
        self.private = instance()
        self.public = instance("hermes-public", {"mode": "all"})

    def principal(self, name):
        return {"subject": name, "username": name, "roles": self.roles[name]}

    def test_installed_entitlement_is_live_and_only_sharing_is_implemented(self):
        self.assertEqual(installed_capabilities(), {"resource-sharing"})
        available = [feature["id"] for feature in self.fixture.service.status()["features"] if feature["available"]]
        self.assertEqual(available, ["resource-sharing"])
        self.assertTrue(self.service.can_use(self.private, self.principal("alice")))
        with patch("licensing.time.time", return_value=self.fixture.now + 7200):
            self.assertFalse(self.service.can_use(self.private, self.principal("alice")))
            self.assertTrue(self.service.can_use(self.public, self.principal("alice")))
            self.assertEqual(self.private["spec"]["access"]["sharing"]["mode"], "selected")

    def test_direct_users_groups_ancestors_and_no_admin_use_bypass(self):
        for name, allowed in (("alice", True), ("bob", True), ("carol", False), ("admin", False)):
            with self.subTest(name=name):
                self.assertEqual(self.service.can_use(self.private, self.principal(name)), allowed)
        self.membership["bob"] = []
        self.assertFalse(self.service.can_use(self.private, self.principal("bob")))
        self.users["alice"]["enabled"] = False
        self.assertFalse(self.service.can_use(self.private, self.principal("alice")))

    def test_minimum_role_is_checked_live_and_cannot_be_bypassed_with_stale_token(self):
        principal = self.principal("alice")
        self.private["spec"]["access"]["role"] = "viewer"
        self.roles["alice"] = ["magicstick-user"]
        self.assertFalse(self.service.can_use(self.private, principal))

    def test_empty_invalid_and_public_restrictions_fail_closed(self):
        for policy in ({"mode": "selected"}, {"mode": "all", "users": ["alice"]}, None, {}, {"mode": "unknown"}):
            value = copy.deepcopy(self.private)
            value["spec"]["access"]["sharing"] = policy
            with self.subTest(policy=policy):
                self.assertTrue(restricted(value))
                self.assertFalse(self.service.can_use(value, self.principal("alice")))
        self.private["spec"]["access"]["authentication"] = "none"
        self.assertFalse(self.service.can_use(self.private, self.principal("alice")))

    def test_missing_extension_or_untrusted_license_denies_only_private(self):
        with patch.dict(sys.modules, {"magicstick_enterprise": None, "magicstick_enterprise.sharing": None}):
            self.assertFalse(self.service.can_use(self.private, self.principal("alice")))
            self.assertTrue(self.service.can_use(self.public, self.principal("alice")))
        self.fixture.trust.write_text('{"keys":{}}')
        self.assertFalse(self.service.can_use(self.private, self.principal("alice")))

    def test_ids_not_display_names_and_strict_policy_validation(self):
        for policy in ({"mode": "selected", "users": ["alice", "alice"]}, {"mode": "selected", "groups": "team"},
                       {"mode": "selected", "users": ["../admin"]}, {"mode": "selected", "users": [str(i) for i in range(101)]},
                       {"mode": "all", "groups": ["team"]}, {"mode": "selected", "adminBypass": True}):
            with self.subTest(policy=policy), self.assertRaises(ValueError):
                enterprise.validate_policy(policy)
        self.users["carol"]["username"] = "alice"
        self.assertFalse(self.service.can_use(self.private, self.principal("carol")))

    def test_visibility_and_membership_privacy(self):
        self.assertEqual(self.service.visible([self.private, self.public], self.principal("carol")), [self.public])
        self.assertEqual(self.service.visible([self.private, self.public], self.principal("admin")), [self.private, self.public])
        self.users["admin"]["enabled"] = False
        with self.assertRaises(LicenseError):
            self.service.visible([self.private], self.principal("admin"))

    def test_policy_mutation_requires_admin_license_ready_guard_and_revision(self):
        payload = {"sharing": {"mode": "selected", "users": ["carol"]}, "expectedRevision": "4"}
        for name, resource, body in (("alice", self.private, payload), ("admin", self.private, {**payload, "expectedRevision": "3"}),
                                    ("admin", {**self.private, "status": {}}, payload)):
            with self.subTest(name=name), self.assertRaises(LicenseError):
                self.service.update(self.principal(name), resource, body)
        self.assertFalse(self.writes)
        result = self.service.update(self.principal("admin"), self.private, payload)
        self.assertEqual(result["sharing"], {"mode": "selected", "users": ["carol"], "groups": []})
        self.assertEqual(self.writes[0][0], "PUT")
        self.assertEqual(self.writes[0][2]["metadata"]["resourceVersion"], "4")
        self.assertNotIn("status", self.writes[0][2])
        self.assertEqual(result["principals"]["users"], [{"id": "carol", "name": "carol"}])

    def test_reject_disabled_users_service_accounts_missing_groups(self):
        self.users["alice"]["enabled"] = False
        self.users["bob"]["serviceAccountClientId"] = "machine"
        for user in ("alice", "bob"):
            with self.assertRaises(ValueError):
                self.service.prepare(self.principal("admin"), {"mode": "selected", "users": [user]})
        with self.assertRaises(ValueError):
            self.service.prepare(self.principal("admin"), {"mode": "selected", "users": ["carol"]}, "none")

    def test_redacts_routes_events_and_workload_metadata(self):
        payload = {"routes": [{"name": "private-local", "hostnames": ["private.hermes.example.local"]}, {"name": "public", "hostnames": ["public.hermes.example.local"]}],
                   "events": [{"message": "Created hermes-private-pod"}, {"message": "Cluster ready"}],
                   "modules": {"message": "Wait for hermes-private"}, "count": 0}
        result = redact_hidden(payload, [self.private])
        self.assertNotIn("private", json.dumps(result))
        self.assertIn("public", json.dumps(result))
        self.assertIn("Cluster ready", json.dumps(result))

    def test_directory_is_admin_only_and_returns_no_secrets(self):
        with self.assertRaises(LicenseError):
            self.service.principals(self.principal("alice"), {})
        self.users["alice"]["attributes"] = {"private": ["do-not-return"]}
        result = self.service.principals(self.principal("admin"), {"kind": ["users"]})
        self.assertNotIn("attributes", json.dumps(result))
        self.assertTrue(all(set(item) == {"id", "name"} for item in result["items"]))

    def test_http_guard_and_every_visibility_surface(self):
        manifest = yaml.safe_load((ROOT / "magic-cluster/apps/dashboard/dashboard-api.yaml").read_text())
        code = manifest["data"]["server.py"].replace("SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)", "SSL_CONTEXT = None")
        server = {"__name__": "sharing_http_test"}
        exec(compile(code, "server.py", "exec"), server)
        server["instance_access_service"] = lambda: self.service
        server["app_instances"] = lambda: [copy.deepcopy(self.private), copy.deepcopy(self.public)]
        server["app_instance"] = lambda name: copy.deepcopy(next((value for value in [self.private, self.public] if value["metadata"]["name"] == name), None))
        server["live_admin_actor"] = self.service.require_admin
        server["instance_credentials"] = lambda name: {"credentials": [{"key": "token", "value": "synthetic-credential"}]}
        original = {"appInstances": [self.private, self.public], "routes": [{"hostnames": ["private.hermes.example.local"]}]}
        server["appliance"] = server["summarized_modules"] = lambda: copy.deepcopy(original)
        for name in ("status_payload", "summarized_events"):
            if name in server:
                server[name] = lambda: copy.deepcopy(original)
        server["list_resource"] = lambda path: [{"metadata": {"name": "hermes-private-event"}, "message": "private.hermes.example.local"}]

        def authenticate(header):
            name = header.removeprefix("Bearer ")
            if name not in self.users:
                raise server["AuthError"](401, "Invalid token")
            return self.principal(name)
        server["authenticated_principal"] = authenticate
        http = server["ThreadingHTTPServer"](("127.0.0.1", 0), server["Handler"])
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)

        def request(path, name="carol", method="GET", body=None, headers=None):
            headers = {"Authorization": "Bearer " + name, **(headers or {})}
            if body is not None:
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(f"http://127.0.0.1:{http.server_port}" + path, method=method, headers=headers,
                                         data=json.dumps(body).encode() if body is not None else None)
            try:
                response = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            return response.status, response.read().decode()
        guard = "/internal/instance-access/hermes-private/test-uid/anything"
        for method in ("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"):
            self.assertEqual(request(guard, "alice", method)[0], 200)
            self.assertEqual(request(guard, "carol", method)[0], 403)
        self.assertEqual(request(guard, "unknown", headers={"X-User": "alice", "X-Auth-Request-User": "alice"})[0], 403)
        self.assertEqual(request(guard, "admin")[0], 403)
        self.assertEqual(request(guard.replace("test-uid", "old-uid"), "alice")[0], 403)
        self.assertEqual(request(guard, "", headers={"Authorization": "", "Cookie": "MagicStickAccessToken=alice"})[0], 200)
        self.assertEqual(request("/api/instances/hermes-private/credentials", "admin")[0], 403)
        for path in ("/api/instances", "/api/appliance", "/api/modules", "/api/my-instances", "/api/status", "/api/events"):
            code, body = request(path)
            self.assertEqual(code, 200, body)
            self.assertNotIn("private", body, path)
        self.assertIn("private", request("/api/instances", "alice")[1])
        self.assertNotIn('"groups"', request("/api/instances", "alice")[1])
        self.assertEqual(request("/api/instances/hermes-private/access", "carol")[0], 403)
        self.assertEqual(request("/api/instances/hermes-private/access", "admin", "PUT", {"sharing": {"mode": "all"}, "expectedRevision": "4"})[0], 403)
        self.roles["alice"] = ["magicstick-user"]
        self.assertEqual(request("/api/session", "alice")[0], 200)
        self.assertIn("private", request("/api/my-instances", "alice")[1])
        self.assertEqual(request("/api/status", "alice")[0], 403)

        # Legacy create/upsert clients preserve sharing and use the checked
        # revision, so concurrent ACL changes cannot be silently overwritten.
        server["app_catalog_json"] = lambda: {"applications": {"hermes": {}}}
        stored = []
        def store(method, path, body, *_):
            stored.append((method, path, copy.deepcopy(body)))
            return body
        server["request_json"] = store
        mutation_headers = {"X-MagicStick-CSRF": "dashboard"}
        code, body = request("/api/instances/hermes", "admin", "POST", {"name": "private"}, mutation_headers)
        self.assertEqual(code, 200, body)
        self.assertEqual(stored[-1][0], "PATCH")
        self.assertEqual(stored[-1][2]["metadata"]["resourceVersion"], "4")
        self.assertEqual(stored[-1][2]["spec"]["access"]["sharing"], self.private["spec"]["access"]["sharing"])
        code, body = request("/api/instances/hermes", "admin", "POST", {"name": "brand-new"}, mutation_headers)
        self.assertEqual(code, 200, body)
        self.assertEqual(stored[-1][0], "POST")
        self.roles["bob"] = ["magicstick-operator"]
        self.assertEqual(request("/api/instances/hermes", "bob", "POST", {"name": "private"}, mutation_headers)[0], 403)
        self.assertEqual(len(stored), 2)


if __name__ == "__main__":
    unittest.main()
