import base64
import json
import time
import unittest

from test_dashboard_api import load_server


CONSOLE_ID = "console-account-id"


def access_token(azp, roles, subject=CONSOLE_ID):
    claims = {
        "iss": "https://id.magicstick.local/realms/magicstick",
        "azp": azp,
        "sub": subject,
        "exp": time.time() + 300,
        "realm_access": {"roles": roles},
    }
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{body}.signature"


class Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.payload


class ConsoleAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        names = (
            "keycloak_admin_request",
            "keycloak_user_roles",
            "_replace_managed_roles",
            "audit_user_action",
            "IDENTITY_MANAGEMENT_MODE",
        )
        self.originals = {name: self.server[name] for name in names}
        self.original_urlopen = self.server["urllib"].request.urlopen
        self.server["IDENTITY_MANAGEMENT_MODE"] = "keycloak"
        self.audit = []
        self.server["audit_user_action"] = lambda *args, **_kwargs: self.audit.append(args[1:4])
        self.roles = {"magicstick-user", "magicstick-admin"}
        self.account = {
            "id": CONSOLE_ID,
            "username": "service-account-magicstick-console",
            "serviceAccountClientId": "magicstick-console",
            "enabled": True,
        }
        self.accounts = {CONSOLE_ID: self.account}

        def admin_request(method, path, body=None):
            if "/users?" in path:
                return ([self.account] if self.account else []), {}
            user_id = path.rsplit("/", 1)[-1]
            if user_id not in self.accounts:
                raise self.server["RequestError"](404, "user not found")
            return self.accounts[user_id], {}

        self.server["keycloak_admin_request"] = admin_request
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "role-" + name, "name": name} for name in sorted(self.roles)
        ]
        self.server["_replace_managed_roles"] = lambda _user_id, desired: self.roles.__init__(desired)
        self.server["urllib"].request.urlopen = lambda *_args, **_kwargs: Response(
            {"sub": CONSOLE_ID, "preferred_username": "service-account-magicstick-console"}
        )
        self.principal = {
            "subject": CONSOLE_ID,
            "username": "service-account-magicstick-console",
            "roles": ["magicstick-admin", "magicstick-user"],
            "localConsole": True,
        }

    def tearDown(self):
        self.server.update(self.originals)
        self.server["urllib"].request.urlopen = self.original_urlopen

    def test_console_client_is_a_trusted_token_client(self):
        self.assertIn("magicstick-console", self.server["OIDC_EXPECTED_CLIENT_IDS"])

    def test_console_principal_uses_live_roles_instead_of_stale_token_claims(self):
        token = access_token("magicstick-console", ["magicstick-admin"])
        self.roles = {"magicstick-user", "magicstick-viewer"}

        principal = self.server["authenticated_principal"]("Bearer " + token)

        self.assertTrue(principal["localConsole"])
        self.assertEqual(principal["roles"], ["magicstick-user", "magicstick-viewer"])
        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["authorize"]("Bearer " + token, "operator", {})
        self.assertEqual(raised.exception.status, 403)

    def test_disabled_console_sign_in_denies_every_route_despite_token_roles(self):
        token = access_token("magicstick-console", ["magicstick-admin", "magicstick-user"])
        self.roles = set()

        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["authorize"]("Bearer " + token, "user", {})

        self.assertEqual(raised.exception.status, 403)

    def test_console_token_is_accepted_only_on_the_direct_in_cluster_connection(self):
        token = "Bearer " + access_token("magicstick-console", ["magicstick-admin", "magicstick-user"])

        self.assertTrue(self.server["authorize"](token, "admin", {})["localConsole"])

        # Every hop from the network (gateway, frontend proxy) marks the request.
        for header in self.server["PROXIED_REQUEST_HEADERS"]:
            with self.subTest(header=header), self.assertRaises(self.server["AuthError"]) as raised:
                self.server["authorize"](token, "user", {header: "203.0.113.7"})
            self.assertEqual(raised.exception.status, 403)
            self.assertIn("only accepted on the appliance itself", str(raised.exception))
        # Unknown transport fails closed.
        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["authorize"](token, "user")
        self.assertEqual(raised.exception.status, 403)

    def test_request_handler_applies_the_transport_rule_to_real_header_objects(self):
        import email.message

        def handler(**extra):
            headers = email.message.Message()  # Case-insensitive like the HTTP server's headers.
            headers["Authorization"] = "Bearer " + access_token("magicstick-console", ["magicstick-admin"])
            for name, value in extra.items():
                headers[name] = value
            return type("FakeHandler", (), {"headers": headers})()

        require_access = self.server["Handler"].require_access
        self.assertTrue(require_access(handler(), "admin")["localConsole"])
        with self.assertRaises(self.server["AuthError"]) as raised:
            require_access(handler(**{"x-forwarded-for": "203.0.113.7"}), "viewer")
        self.assertEqual(raised.exception.status, 403)

    def test_proxied_human_sessions_are_unaffected_by_the_console_transport_rule(self):
        token = access_token("magicstick-cli", ["magicstick-operator"], subject="human-id")
        self.server["urllib"].request.urlopen = lambda *_args, **_kwargs: Response(
            {"sub": "human-id", "preferred_username": "tova"}
        )

        principal = self.server["authorize"](
            "Bearer " + token, "operator", {"X-Forwarded-For": "203.0.113.7", "X-Real-IP": "203.0.113.7"}
        )

        self.assertEqual(principal["username"], "tova")

    def test_console_client_token_for_another_account_is_rejected(self):
        self.accounts["other-id"] = {"id": "other-id", "username": "alice", "enabled": True}
        self.server["urllib"].request.urlopen = lambda *_args, **_kwargs: Response({"sub": "other-id"})
        token = access_token("magicstick-console", ["magicstick-admin"], subject="other-id")

        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["authenticated_principal"]("Bearer " + token)

        self.assertEqual(raised.exception.status, 401)

    def test_human_tokens_are_not_marked_as_local_console(self):
        token = access_token("magicstick-cli", ["magicstick-operator"], subject="human-id")
        self.server["urllib"].request.urlopen = lambda *_args, **_kwargs: Response(
            {"sub": "human-id", "preferred_username": "tova"}
        )

        principal = self.server["authenticated_principal"]("Bearer " + token)

        self.assertNotIn("localConsole", principal)
        self.assertEqual(principal["roles"], ["magicstick-operator"])

    def test_live_admin_actor_accepts_only_the_console_service_account(self):
        self.assertEqual(self.server["live_admin_actor"](self.principal)["id"], CONSOLE_ID)

        self.accounts["svc-id"] = {
            "id": "svc-id", "username": "service-account-magicstick-user-admin",
            "serviceAccountClientId": "magicstick-user-admin", "enabled": True,
        }
        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["live_admin_actor"]({**self.principal, "subject": "svc-id"})
        self.assertEqual(raised.exception.status, 403)

        self.roles = {"magicstick-user", "magicstick-operator"}
        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["live_admin_actor"](self.principal)
        self.assertEqual(raised.exception.status, 403)

    def test_get_reports_level_and_missing_provisioning(self):
        self.assertEqual(
            self.server["get_console_access"](self.principal),
            {"available": True, "accessLevel": "admin", "accessLevels": ["off", "viewer", "operator", "admin"]},
        )
        human = {"subject": "human-id", "username": "admin", "roles": ["magicstick-admin"]}
        self.accounts["human-id"] = {"id": "human-id", "username": "admin", "enabled": True}
        self.account = None
        result = self.server["get_console_access"](human)
        self.assertEqual((result["available"], result["accessLevel"]), (False, "off"))

    def test_update_changes_live_roles_and_audits(self):
        result = self.server["update_console_access"](self.principal, {"accessLevel": "operator"}, "request-1")

        self.assertEqual(result["accessLevel"], "operator")
        self.assertEqual(self.roles, {"magicstick-user", "magicstick-operator"})
        self.assertNotIn("AUTH_CACHE", self.server)
        self.assertEqual(self.audit, [("update-console-access", "local-console:operator", "success")])

    def test_update_off_removes_every_managed_role(self):
        human = {"subject": "human-id", "username": "admin", "roles": ["magicstick-admin"]}
        self.accounts["human-id"] = {"id": "human-id", "username": "admin", "enabled": True}
        original_roles = self.server["keycloak_user_roles"]
        self.server["keycloak_user_roles"] = lambda user_id, effective=False: (
            [{"id": "role-admin", "name": "magicstick-admin"}] if user_id == "human-id"
            else original_roles(user_id, effective)
        )

        result = self.server["update_console_access"](human, {"accessLevel": "off"})

        self.assertEqual(result["accessLevel"], "off")
        self.assertEqual(self.roles, set())

    def test_update_rejects_invalid_levels_and_unprovisioned_console(self):
        for payload in ({"accessLevel": "user"}, {"accessLevel": "root"}, {"accessLevel": "admin", "extra": 1}):
            with self.assertRaises(self.server["RequestError"]) as raised:
                self.server["update_console_access"](self.principal, payload)
            self.assertEqual(raised.exception.status, 400)
        self.assertEqual(self.roles, {"magicstick-user", "magicstick-admin"})

        human = {"subject": "human-id", "username": "admin", "roles": ["magicstick-admin"]}
        self.accounts["human-id"] = {"id": "human-id", "username": "admin", "enabled": True}
        self.account = None
        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["update_console_access"](human, {"accessLevel": "admin"})
        self.assertEqual(raised.exception.status, 409)

    def test_downgraded_console_cannot_restore_its_own_access(self):
        self.roles = {"magicstick-user", "magicstick-viewer"}

        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["update_console_access"](self.principal, {"accessLevel": "admin"})

        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(self.roles, {"magicstick-user", "magicstick-viewer"})


if __name__ == "__main__":
    unittest.main()
