import pathlib
import io
import types
import unittest

import yaml


def load_setup_module():
    manifest = pathlib.Path(__file__).parents[1] / "setup-configmap.yaml"
    script = yaml.safe_load(manifest.read_text(encoding="utf-8"))["data"]["server.py"]
    module = types.ModuleType("magicstick_setup")
    module.__file__ = str(manifest)
    module.__loader_source__ = script
    exec(compile(script, str(manifest), "exec"), module.__dict__)
    return module


setup = load_setup_module()


class SetupValidationTests(unittest.TestCase):
    def valid_payload(self):
        return {
            "applianceName": "Test Appliance",
            "mdnsDomain": "magicstick.local",
            "timezone": "Europe/Berlin",
            "language": "de",
            "publicDomain": "magicstick.example.com",
            "username": "first-admin",
            "password": "correct horse battery staple",
            "displayName": "First Administrator",
            "email": "admin@example.com",
            "recoveryUsername": "recovery-a1b2c3d4",
            "recoveryCode": "123456-abcdef-123456-abcdef",
        }

    def test_claim_hash_is_stable_and_not_plaintext(self):
        claim = "00112233445566778899aabbccddeeff"
        digest = setup.secret_hash(claim)
        self.assertEqual(len(digest), 64)
        self.assertNotIn(claim, digest)
        self.assertTrue(setup.constant_match(digest, setup.secret_hash(claim)))

    def test_complete_payload_accepts_safe_defaults(self):
        result = setup.validate_complete(self.valid_payload())
        self.assertEqual(result["mdnsDomain"], "magicstick.local")
        self.assertEqual(result["username"], "first-admin")

    def test_mdns_domain_must_remain_local(self):
        payload = self.valid_payload()
        payload["mdnsDomain"] = "setup.example.com"
        with self.assertRaises(setup.ApiError) as error:
            setup.validate_complete(payload)
        self.assertEqual(error.exception.code, "invalid_mdns_domain")

    def test_password_minimum_is_enforced(self):
        payload = self.valid_payload()
        payload["password"] = "too-short"
        with self.assertRaises(setup.ApiError) as error:
            setup.validate_complete(payload)
        self.assertEqual(error.exception.code, "weak_password")


class SetupGatewayTests(unittest.TestCase):
    def test_dynamic_routes_have_no_public_hostname(self):
        resources = setup.dynamic_resources("magicstick.local", ["192.0.2.50"])
        objects = [resource for _, _, resource in resources]
        routes = [resource for resource in objects if resource["kind"] == "HTTPRoute"]
        self.assertEqual(len(routes), 2)
        self.assertNotIn("magicstick.example.com", str(routes))
        local = next(route for route in routes if route["metadata"]["name"] == "magicstick-setup-local")
        self.assertEqual(local["spec"]["hostnames"], ["magicstick.local"])
        direct = next(route for route in routes if route["metadata"]["name"] == "magicstick-setup-direct")
        self.assertNotIn("hostnames", direct["spec"])

    def test_certificate_contains_current_private_ips(self):
        resources = setup.dynamic_resources("magicstick.local", ["192.0.2.50", "2001:db8::10"])
        certificate = next(resource for _, _, resource in resources if resource["kind"] == "Certificate")
        self.assertEqual(certificate["spec"]["ipAddresses"], ["192.0.2.50", "2001:db8::10"])

    def test_setup_policy_is_private_network_only(self):
        resources = setup.dynamic_resources("magicstick.local", ["192.0.2.50"])
        policy = next(resource for _, _, resource in resources if resource["kind"] == "SecurityPolicy")
        cidrs = policy["spec"]["authorization"]["rules"][0]["principal"]["clientCIDRs"]
        self.assertEqual(cidrs, setup.PRIVATE_CIDRS)

    def test_cleanup_includes_temporary_tls_secret(self):
        self.assertIn(
            "/api/v1/namespaces/identity-system/secrets/magicstick-setup-tls",
            setup.DYNAMIC_PATHS,
        )

    def test_gateway_load_balancer_ip_is_added_to_certificate(self):
        original_nodes = setup.private_node_ips
        original_get = setup.get_resource
        try:
            setup.private_node_ips = lambda: ["192.0.2.50"]
            setup.get_resource = lambda path: {"status": {"addresses": [{"type": "IPAddress", "value": "192.0.2.60"}]}}
            self.assertEqual(setup.setup_access_ips(), ["192.0.2.50", "192.0.2.60"])
        finally:
            setup.private_node_ips = original_nodes
            setup.get_resource = original_get


class KeycloakUserTests(unittest.TestCase):
    def test_recovery_account_joins_internal_group_without_user_attributes(self):
        original_request = setup.keycloak_request
        calls = []
        membership = set()
        recovery_group = {
            "id": "recovery-group-id", "name": "magicstick-recovery", "path": "/magicstick-recovery",
        }

        def fake_request(method, path, token=None, body=None, form=None):
            calls.append((method, path, body))
            if method == "GET" and "users?" in path:
                return ([{"id": "recovery-id", "attributes": {"existing": ["kept"]}}], {})
            if method == "GET" and path.endswith("/roles"):
                return ([
                    {"id": "user-role", "name": "magicstick-user"},
                    {"id": "admin-role", "name": "magicstick-admin"},
                ], {})
            if method == "GET" and path.endswith("/role-mappings/realm"):
                return ([
                    {"name": "magicstick-user"},
                    {"name": "magicstick-admin"},
                ], {})
            if method == "GET" and path.startswith("/admin/realms/magicstick/groups?"):
                return ([recovery_group], {})
            if method == "GET" and "/users/recovery-id/groups?" in path:
                return ([recovery_group] if recovery_group["id"] in membership else [], {})
            if method == "PUT" and path.endswith("/users/recovery-id/groups/recovery-group-id"):
                membership.add(recovery_group["id"])
                return ({}, {})
            return ({}, {})

        try:
            setup.keycloak_request = fake_request
            setup.ensure_keycloak_user(
                "token", "recovery-test", "a sufficiently long recovery code",
                "recovery@example.com", "Recovery Administrator", "recovery",
            )
        finally:
            setup.keycloak_request = original_request

        profile = next(body for method, path, body in calls if method == "PUT" and path.endswith("/recovery-id"))
        assignment = next(body for method, path, body in calls if method == "POST" and path.endswith("/role-mappings/realm"))
        self.assertNotIn("attributes", profile)
        self.assertEqual({role["name"] for role in assignment}, {"magicstick-user", "magicstick-admin"})
        self.assertEqual(membership, {"recovery-group-id"})

    def test_primary_account_never_joins_the_internal_recovery_group(self):
        original_request = setup.keycloak_request
        assignments = []

        def fake_request(method, path, token=None, body=None, form=None):
            if method == "GET" and "users?" in path:
                return ([{"id": "primary-id"}], {})
            if method == "GET" and path.endswith("/roles"):
                return ([
                    {"id": "user-role", "name": "magicstick-user"},
                    {"id": "admin-role", "name": "magicstick-admin"},
                ], {})
            if method == "POST" and path.endswith("/role-mappings/realm"):
                assignments.extend(role["name"] for role in body)
                return ({}, {})
            if method == "GET" and path.endswith("/role-mappings/realm"):
                return ([{"name": name} for name in assignments], {})
            return ({}, {})

        try:
            setup.keycloak_request = fake_request
            setup.ensure_keycloak_user(
                "token", "primary-test", "a sufficiently long primary password",
                "primary@example.com", "Primary Administrator", "primary",
            )
        finally:
            setup.keycloak_request = original_request

        self.assertEqual(set(assignments), {"magicstick-user", "magicstick-admin"})

    def test_missing_recovery_group_is_created_and_verified_idempotently(self):
        original_request = setup.keycloak_request
        calls = []
        groups = []
        recovery_group = {
            "id": "recovery-group-id", "name": "magicstick-recovery", "path": "/magicstick-recovery",
        }

        def fake_request(method, path, token=None, body=None, form=None):
            calls.append((method, path, body))
            if method == "GET" and path.startswith("/admin/realms/magicstick/groups?"):
                return (list(groups), {})
            if method == "POST" and path == "/admin/realms/magicstick/groups":
                self.assertEqual(body, {"name": "magicstick-recovery"})
                groups.append(recovery_group)
                return ({}, {})
            self.fail(f"unexpected Keycloak request: {method} {path}")

        try:
            setup.keycloak_request = fake_request
            self.assertEqual(setup.ensure_recovery_group("token"), recovery_group)
            self.assertEqual(setup.ensure_recovery_group("token"), recovery_group)
        finally:
            setup.keycloak_request = original_request

        creates = [call for call in calls if call[0] == "POST"]
        self.assertEqual(len(creates), 1)

    def test_concurrent_recovery_group_creation_conflict_is_reconciled(self):
        original_request = setup.keycloak_request
        groups = []
        recovery_group = {
            "id": "recovery-group-id", "name": "magicstick-recovery", "path": "/magicstick-recovery",
        }

        def fake_request(method, path, token=None, body=None, form=None):
            if method == "GET" and path.startswith("/admin/realms/magicstick/groups?"):
                return (list(groups), {})
            if method == "POST" and path == "/admin/realms/magicstick/groups":
                groups.append(recovery_group)
                raise setup.urllib.error.HTTPError(path, 409, "Conflict", {}, None)
            self.fail(f"unexpected Keycloak request: {method} {path}")

        try:
            setup.keycloak_request = fake_request
            self.assertEqual(setup.ensure_recovery_group("token"), recovery_group)
        finally:
            setup.keycloak_request = original_request


class RecoveryUserMigrationTests(unittest.TestCase):
    INSTALLATION_ID = "a1b2c3d4-1234-4abc-8def-1234567890ab"

    def setUp(self):
        setup.RECOVERY_MIGRATIONS_COMPLETE.clear()

    def completed_setup(self, **overrides):
        resource = {
            "metadata": {"name": "local"},
            "spec": {"setupVersion": "v1", "installationId": self.INSTALLATION_ID},
            "status": {"phase": "Completed", "completedAt": "2026-08-17T12:00:00Z"},
        }
        for section, values in overrides.items():
            resource.setdefault(section, {}).update(values)
        return resource

    def test_completed_upgrade_marks_only_the_installation_bound_recovery_user_idempotently(self):
        original_token = setup.keycloak_token
        original_request = setup.keycloak_request
        calls = []
        user = {
            "id": "recovery-id",
            "username": "recovery-a1b2c3d4",
            "attributes": {"existing": ["kept"]},
        }
        assigned_names = {"magicstick-user", "magicstick-admin"}
        group_membership = set()
        recovery_group = {
            "id": "recovery-group-id", "name": "magicstick-recovery", "path": "/magicstick-recovery",
        }

        def fake_request(method, path, token=None, body=None, form=None):
            calls.append((method, path, body))
            if method == "GET" and "users?" in path:
                self.assertIn("username=recovery-a1b2c3d4", path)
                self.assertIn("exact=true", path)
                return ([{"id": user["id"], "username": user["username"]}], {})
            if method == "GET" and path.endswith("/role-mappings/realm"):
                return ([{"name": name} for name in sorted(assigned_names)], {})
            if method == "GET" and path.endswith("/recovery-id"):
                return (dict(user, attributes=dict(user["attributes"])), {})
            if method == "GET" and path.startswith("/admin/realms/magicstick/groups?"):
                return ([recovery_group], {})
            if method == "GET" and "/users/recovery-id/groups?" in path:
                return ([recovery_group] if recovery_group["id"] in group_membership else [], {})
            if method == "PUT" and path.endswith("/users/recovery-id/groups/recovery-group-id"):
                group_membership.add(recovery_group["id"])
                return ({}, {})
            self.fail(f"unexpected Keycloak request: {method} {path}")

        try:
            setup.keycloak_token = lambda: "scoped-token"
            setup.keycloak_request = fake_request
            self.assertTrue(setup.migrate_completed_recovery_user(self.completed_setup()))
            setup.RECOVERY_MIGRATIONS_COMPLETE.clear()  # Simulate a setup-service restart.
            self.assertFalse(setup.migrate_completed_recovery_user(self.completed_setup()))
        finally:
            setup.keycloak_token = original_token
            setup.keycloak_request = original_request

        membership_updates = [path for method, path, _ in calls if method == "PUT" and "/groups/" in path]
        self.assertEqual(membership_updates, [
            "/admin/realms/magicstick/users/recovery-id/groups/recovery-group-id",
        ])
        self.assertEqual(user["attributes"], {"existing": ["kept"]})
        self.assertFalse(any(method == "PUT" and path.endswith("/recovery-id") for method, path, _ in calls))
        self.assertFalse(any(path.endswith("/reset-password") for _, path, _ in calls))

    def test_migration_does_not_use_recovery_name_heuristics(self):
        original_token = setup.keycloak_token
        original_request = setup.keycloak_request
        calls = []

        def fake_request(method, path, token=None, body=None, form=None):
            calls.append((method, path, body))
            if method == "GET" and "users?" in path:
                return ([{"id": "other-id", "username": "recovery-deadbeef"}], {})
            self.fail(f"unexpected Keycloak request: {method} {path}")

        try:
            setup.keycloak_token = lambda: "scoped-token"
            setup.keycloak_request = fake_request
            self.assertFalse(setup.migrate_completed_recovery_user(self.completed_setup()))
        finally:
            setup.keycloak_token = original_token
            setup.keycloak_request = original_request

        self.assertFalse(any(method == "PUT" for method, _, _ in calls))

    def test_only_valid_v1_completed_setup_state_can_trigger_migration(self):
        original_token = setup.keycloak_token
        calls = []
        setup.keycloak_token = lambda: calls.append("token")
        invalid_resources = [
            self.completed_setup(status={"phase": "CompletedLegacy"}),
            self.completed_setup(status={"completedAt": ""}),
            self.completed_setup(spec={"setupVersion": "v2"}),
            self.completed_setup(spec={"installationId": "not-a-stored-uuid"}),
        ]
        try:
            for resource in invalid_resources:
                self.assertFalse(setup.migrate_completed_recovery_user(resource))
        finally:
            setup.keycloak_token = original_token

        self.assertEqual(calls, [])

    def test_exact_recovery_user_without_admin_roles_is_not_marked(self):
        original_token = setup.keycloak_token
        original_request = setup.keycloak_request
        updates = []

        def fake_request(method, path, token=None, body=None, form=None):
            if method == "GET" and "users?" in path:
                return ([{"id": "recovery-id", "username": "recovery-a1b2c3d4"}], {})
            if method == "GET" and path.endswith("/recovery-id"):
                return ({"id": "recovery-id", "username": "recovery-a1b2c3d4", "attributes": {}}, {})
            if method == "GET" and path.endswith("/role-mappings/realm"):
                return ([{"name": "magicstick-user"}], {})
            if method == "PUT":
                updates.append(body)
                return ({}, {})
            self.fail(f"unexpected Keycloak request: {method} {path}")

        try:
            setup.keycloak_token = lambda: "scoped-token"
            setup.keycloak_request = fake_request
            self.assertFalse(setup.migrate_completed_recovery_user(self.completed_setup()))
        finally:
            setup.keycloak_token = original_token
            setup.keycloak_request = original_request

        self.assertEqual(updates, [])

    def test_completed_reconciliation_runs_cleanup_and_upgrade_migration(self):
        original_setup_resource = setup.setup_resource
        original_delete = setup.delete_resource
        original_migrate = setup.migrate_completed_recovery_user
        resource = self.completed_setup()
        deleted = []
        migrated = []
        try:
            setup.setup_resource = lambda: resource
            setup.delete_resource = deleted.append
            setup.migrate_completed_recovery_user = migrated.append
            setup.reconcile_once()
        finally:
            setup.setup_resource = original_setup_resource
            setup.delete_resource = original_delete
            setup.migrate_completed_recovery_user = original_migrate

        self.assertEqual(deleted, setup.DYNAMIC_PATHS)
        self.assertEqual(migrated, [resource])


class HandlerTests(unittest.TestCase):
    def test_json_response_uses_security_headers(self):
        handler = object.__new__(setup.Handler)
        handler.command = "GET"
        handler.path = "/setup/api/status"
        handler.requestline = "GET /setup/api/status HTTP/1.1"
        handler.request_version = "HTTP/1.1"
        handler.protocol_version = "HTTP/1.0"
        handler.wfile = io.BytesIO()
        handler._headers_buffer = []
        handler.send_json(200, {"ready": True})
        response = handler.wfile.getvalue()
        self.assertIn(b"Cache-Control: no-store", response)
        self.assertIn(b"Content-Security-Policy:", response)
        self.assertTrue(response.endswith(b'{"ready":true}'))

    def test_csrf_cookie_is_visible_from_local_root_setup_page(self):
        self.assertIn('f"{CSRF_COOKIE}={csrf_token}; Path=/;', setup.__loader_source__)


if __name__ == "__main__":
    unittest.main()
