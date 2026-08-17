import base64
import io
import pathlib
import threading
import time
import unittest
import urllib.error

import yaml


ROOT = pathlib.Path(__file__).resolve().parent


def load_server():
    manifest = yaml.safe_load((ROOT / "dashboard-api.yaml").read_text(encoding="utf-8"))
    source = manifest["data"]["server.py"]
    source = source.replace(
        "SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)",
        "SSL_CONTEXT = None",
    ).replace(
        "PUBLIC_SSL_CONTEXT = ssl.create_default_context()",
        "PUBLIC_SSL_CONTEXT = None",
    )
    namespace = {"__name__": "magicstick_dashboard_api_test"}
    exec(compile(source, "server.py", "exec"), namespace)
    return namespace


class LocalRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        self.originals = {
            "model_activations": self.server["model_activations"],
            "module_activation": self.server["module_activation"],
            "delete_json": self.server["delete_json"],
            "summarized_modules": self.server["summarized_modules"],
        }

    def tearDown(self):
        self.server.update(self.originals)

    def test_remove_local_runtime_deletes_only_auto_enabled_modules(self):
        deleted = []
        self.server["model_activations"] = lambda: []
        self.server["module_activation"] = lambda name: {
            "metadata": {
                "name": name,
                "annotations": {"appliance.magicstick.dev/auto-enabled": "true"},
            }
        }
        self.server["delete_json"] = lambda path: deleted.append(path) or {}

        result = self.server["remove_local_model_runtime"]()

        self.assertEqual(result, {"removed": ["kubeai", "gpu"], "skipped": []})
        self.assertTrue(deleted[0].endswith("/moduleactivations/kubeai"))
        self.assertTrue(deleted[1].endswith("/moduleactivations/gpu"))

    def test_remove_local_runtime_is_blocked_by_local_model(self):
        self.server["model_activations"] = lambda: [
            {
                "metadata": {"name": "local-chat"},
                "spec": {"type": "local", "enabled": True},
                "status": {"phase": "Ready"},
            }
        ]

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["remove_local_model_runtime"]()

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("local-chat", str(raised.exception))

    def test_remove_local_runtime_preserves_manually_managed_module(self):
        self.server["model_activations"] = lambda: []
        self.server["module_activation"] = lambda name: {
            "metadata": {"name": name, "annotations": {}}
        }
        self.server["delete_json"] = lambda _path: self.fail("manual module must not be deleted")

        result = self.server["remove_local_model_runtime"]()

        self.assertEqual(result, {"removed": [], "skipped": ["kubeai", "gpu"]})

    def test_manual_gpu_activation_is_marked_user_managed(self):
        resource = self.server["module_activation_payload"]("gpu", True)
        patch = self.server["manual_module_activation_patch"](resource)

        self.assertTrue(resource["spec"]["enabled"])
        self.assertEqual(
            resource["metadata"]["annotations"]["appliance.magicstick.dev/activation-source"],
            "manual",
        )
        self.assertIsNone(
            patch["metadata"]["annotations"]["appliance.magicstick.dev/auto-enabled"]
        )

    def test_manual_kubeai_disable_is_supported(self):
        resource = self.server["module_activation_payload"]("kubeai", False)

        self.assertFalse(resource["spec"]["enabled"])
        self.assertEqual(resource["spec"]["module"], "kubeai")

    def test_local_model_policy_does_not_block_manual_control(self):
        supported = self.server["module_manual_control_enabled"]({
            "activationMode": "moduleactivation",
            "activationPolicy": "local-model",
        })

        self.assertTrue(supported)

    def test_local_model_runtime_requires_gpu_and_kubeai_ready(self):
        requirements = self.server["local_model_runtime_requirements"]({
            "modules": {
                "gpu": {"enabled": True, "displayName": "NVIDIA GPU Operator", "status": {"phase": "Ready"}},
                "kubeai": {"enabled": True, "displayName": "KubeAI", "status": {"phase": "Ready"}},
            }
        })

        self.assertTrue(requirements["ready"])
        self.assertEqual(requirements["missing"], [])

    def test_local_model_runtime_reports_disabled_or_pending_modules(self):
        requirements = self.server["local_model_runtime_requirements"]({
            "modules": {
                "gpu": {"enabled": False, "displayName": "NVIDIA GPU Operator", "status": {"phase": "Disabled"}},
                "kubeai": {"enabled": True, "displayName": "KubeAI", "status": {"phase": "Reconciling"}},
            }
        })

        self.assertFalse(requirements["ready"])
        self.assertEqual([item["name"] for item in requirements["missing"]], ["gpu", "kubeai"])

    def test_local_model_creation_guard_returns_conflict(self):
        self.server["summarized_modules"] = lambda: {
            "modules": {
                "gpu": {"enabled": True, "displayName": "NVIDIA GPU Operator", "status": {"phase": "Ready"}},
                "kubeai": {"enabled": False, "displayName": "KubeAI", "status": {"phase": "Disabled"}},
            }
        }

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["require_local_model_runtime"]()

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("KubeAI", str(raised.exception))

    def test_dashboard_renders_starting_model_phase_as_progress(self):
        source = (ROOT / "configmap.yaml").read_text(encoding="utf-8")

        self.assertIn("normalized === 'starting'", source)
        self.assertIn("label: 'Starting model runtime'", source)
        self.assertIn("'starting', 'reconciling'", source)


class UserAdministrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        names = (
            "keycloak_admin_token",
            "_keycloak_http_request",
            "keycloak_admin_request",
            "request_json",
            "authenticated_principal",
            "keycloak_user",
            "keycloak_user_roles",
            "keycloak_user_groups",
            "keycloak_federated_identities",
            "identity_source",
            "live_admin_actor",
            "_all_human_users",
            "_keycloak_raw_user_page",
            "_keycloak_user_page",
            "_keycloak_user_count",
            "user_summary",
            "_exact_user_matches",
            "_realm_role",
            "_replace_managed_roles",
            "_logout_user",
            "_enabled_admin_counts",
            "_ensure_admins_survive",
            "audit_user_action",
        )
        self.originals = {name: self.server[name] for name in names}
        self.original_mode = self.server["IDENTITY_MANAGEMENT_MODE"]
        self.original_origins = self.server["DASHBOARD_ALLOWED_ORIGINS"]
        self.server["audit_user_action"] = lambda *_args, **_kwargs: None
        self.principal = {"subject": "actor-id", "username": "admin", "roles": ["magicstick-admin"]}

    def tearDown(self):
        self.server.update(self.originals)
        self.server["IDENTITY_MANAGEMENT_MODE"] = self.original_mode
        self.server["DASHBOARD_ALLOWED_ORIGINS"] = self.original_origins

    @staticmethod
    def user(user_id="target-id", username="target", enabled=True, **extra):
        value = {
            "id": user_id,
            "username": username,
            "enabled": enabled,
            "firstName": "Target",
            "lastName": "User",
            "email": "target@example.com",
            "emailVerified": True,
            "createdTimestamp": 1234,
        }
        value.update(extra)
        return value

    def test_service_accounts_are_detected_by_field_and_username(self):
        self.assertTrue(self.server["is_service_account_user"]({"serviceAccountClientId": "client"}))
        self.assertTrue(self.server["is_service_account_user"]({"username": "service-account-client"}))
        self.assertFalse(self.server["is_service_account_user"]({"username": "regular-user"}))

        self.server["keycloak_admin_request"] = lambda *_args: (
            {"id": "service-id", "username": "service-account-hidden"},
            {},
        )
        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["keycloak_user"]("service-id")
        self.assertEqual(raised.exception.status, 404)

    def test_admin_access_is_rejected_for_viewer_and_operator(self):
        for role in ("magicstick-viewer", "magicstick-operator"):
            self.server["authenticated_principal"] = lambda _authorization, role=role: {
                "subject": "non-admin",
                "username": "non-admin",
                "roles": [role],
            }
            with self.assertRaises(self.server["AuthError"]) as raised:
                self.server["authorize"]("Bearer token", "admin")
            self.assertEqual(raised.exception.status, 403)

        self.server["authenticated_principal"] = lambda _authorization: self.principal
        self.assertEqual(
            self.server["authorize"]("Bearer token", "admin")["subject"],
            "actor-id",
        )

    def test_keycloak_credentials_are_read_from_only_the_named_kubernetes_secret(self):
        requested = []
        encoded_client_id = base64.b64encode(b"magicstick-user-admin").decode("ascii")
        encoded_client_secret = base64.b64encode(b"test-value").decode("ascii")

        def request_json(method, path, body=None, content_type="application/json"):
            requested.append((method, path))
            return {
                "data": {
                    "client-id": encoded_client_id,
                    "client-secret": encoded_client_secret,
                }
            }

        self.server["request_json"] = request_json

        client_id, client_secret = self.server["keycloak_client_credentials"]()

        self.assertEqual(client_id, "magicstick-user-admin")
        self.assertEqual(client_secret, "test-value")
        self.assertEqual(
            requested,
            [("GET", "/api/v1/namespaces/identity-system/secrets/magicstick-user-admin-client")],
        )

    def test_keycloak_error_mapping_never_returns_upstream_body(self):
        upstream = urllib.error.HTTPError(
            "/admin/test",
            500,
            "upstream failed",
            {},
            io.BytesIO(b'{"client_secret":"must-not-leak"}'),
        )

        mapped = self.server["_mapped_keycloak_error"](upstream)

        self.assertEqual(mapped.status, 503)
        self.assertNotIn("must-not-leak", str(mapped))

    def test_list_users_forwards_pagination_and_search_to_keycloak(self):
        calls = []
        actor = self.user("actor-id", "admin")
        selected = self.user("user-2", "alice")
        self.server["live_admin_actor"] = lambda principal: actor
        self.server["_keycloak_user_page"] = lambda first, maximum, search: (
            calls.append((first, maximum, search)) or [selected]
        )
        self.server["_keycloak_user_count"] = lambda search: 7
        self.server["keycloak_user"] = lambda _user_id: selected
        self.server["user_summary"] = lambda user, actor_id: {"id": user["id"], "actor": actor_id}

        result = self.server["list_users"](
            self.principal,
            {"first": ["2"], "max": ["1"], "search": ["ali"]},
        )

        self.assertEqual(calls, [(2, 1, "ali")])
        self.assertEqual(result["total"], 7)
        self.assertEqual(result["users"], [{"id": "user-2", "actor": "actor-id"}])

    def test_user_pagination_uses_human_offsets_around_service_accounts(self):
        service_one = self.user("service-1", "service-account-first")
        service_two = self.user("service-2", "service-account-second")
        alice = self.user("alice-id", "alice")
        bob = self.user("bob-id", "bob")
        calls = []

        def raw_page(first, maximum, search=""):
            calls.append((first, maximum, search))
            return [service_one, alice, service_two, bob]

        self.server["_keycloak_raw_user_page"] = raw_page

        result = self.server["_keycloak_user_page"](1, 1, "")

        self.assertEqual([user["username"] for user in result], ["bob"])
        self.assertEqual(calls, [(0, 100, "")])

    def test_brokered_user_has_read_only_profile_and_no_password_or_delete(self):
        brokered = self.user(
            federatedIdentities=[{"identityProvider": "entra", "userId": "external-id"}],
        )
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "role-user", "name": "magicstick-user"},
            *([{"id": "role-viewer", "name": "magicstick-viewer"}] if effective else []),
        ]
        self.server["keycloak_user_groups"] = lambda _user_id: []

        result = self.server["user_summary"](brokered, "actor-id")

        self.assertEqual(result["source"], "brokered")
        self.assertEqual(result["provider"], "entra")
        self.assertEqual(result["directRoles"], ["magicstick-user"])
        self.assertEqual(result["effectiveAccessLevel"], "viewer")
        self.assertFalse(result["capabilities"]["canEditProfile"])
        self.assertFalse(result["capabilities"]["canResetPassword"])
        self.assertFalse(result["capabilities"]["canDelete"])
        self.assertTrue(result["capabilities"]["canManageRoles"])

    def test_exact_recovery_group_marks_user_protected_without_exposing_group(self):
        recovery = self.user("recovery-id", "recovery", enabled=False)
        self.server["identity_source"] = lambda _user: ("local", "local")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "user", "name": "magicstick-user"},
            {"id": "admin", "name": "magicstick-admin"},
        ]
        self.server["keycloak_user_groups"] = lambda _user_id: [{
            "id": "recovery-group",
            "name": "magicstick-recovery",
            "path": "/magicstick-recovery",
        }]

        result = self.server["user_summary"](recovery, "actor-id")

        self.assertTrue(result["capabilities"]["isProtected"])
        self.assertFalse(result["capabilities"]["canEditProfile"])
        self.assertFalse(result["capabilities"]["canManageRoles"])
        self.assertFalse(result["capabilities"]["canEnable"])
        self.assertFalse(result["capabilities"]["canResetPassword"])
        self.assertFalse(result["capabilities"]["canDelete"])
        self.assertNotIn("groups", result)
        self.assertNotIn("magicstick-recovery", str(result))

    def test_nested_group_with_same_name_does_not_mark_recovery_user(self):
        candidate = self.user("candidate-id", "candidate")

        protected = self.server["protected_user"](candidate, [{
            "id": "nested-group",
            "name": "magicstick-recovery",
            "path": "/other/magicstick-recovery",
        }])

        self.assertFalse(protected)

    def test_recovery_membership_uses_exact_direct_group_endpoint(self):
        requested = []

        def request(method, path, body=None):
            requested.append((method, path, body))
            return [{
                "id": "recovery-group",
                "name": "magicstick-recovery",
                "path": "/magicstick-recovery",
            }], {}

        self.server["keycloak_admin_request"] = request

        groups = self.server["keycloak_user_groups"]("target-id")

        self.assertEqual(groups[0]["path"], "/magicstick-recovery")
        self.assertEqual(requested, [(
            "GET",
            "/admin/realms/magicstick/users/target-id/groups?briefRepresentation=true&first=0&max=100",
            None,
        )])

    def test_recovery_group_lookup_failure_blocks_mutation_fail_closed(self):
        target = self.user("target-id", "target", enabled=True)
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target

        def unavailable(_user_id):
            raise self.server["RequestError"](503, "identity administration is unavailable")

        self.server["keycloak_user_groups"] = unavailable
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["set_user_enabled"](self.principal, "target-id", False)

        self.assertEqual(raised.exception.status, 503)

    def test_recovery_access_update_is_blocked_even_when_target_stays_admin(self):
        target = self.user("recovery-id", "recovery", enabled=True)
        observed = {"groupReads": 0, "roleWrites": []}
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "user", "name": "magicstick-user"},
            {"id": "admin", "name": "magicstick-admin"},
        ]

        def groups(_user_id):
            observed["groupReads"] += 1
            return [{
                "id": "recovery-group",
                "name": "magicstick-recovery",
                "path": "/magicstick-recovery",
            }]

        self.server["keycloak_user_groups"] = groups
        self.server["_replace_managed_roles"] = lambda _user_id, roles: observed["roleWrites"].append(set(roles))
        self.server["_logout_user"] = lambda _user_id: None
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"]}

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["update_user_roles"](
                self.principal,
                "recovery-id",
                {"accessLevel": "admin"},
            )

        self.assertGreaterEqual(observed["groupReads"], 1)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(observed["roleWrites"], [])

    def test_live_actor_recheck_rejects_demoted_admin(self):
        self.server["keycloak_user"] = lambda _user_id: self.user("actor-id", "admin")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "role-user", "name": "magicstick-user"}
        ]

        with self.assertRaises(self.server["AuthError"]) as raised:
            self.server["live_admin_actor"](self.principal)

        self.assertEqual(raised.exception.status, 403)

    def test_keycloak_request_refreshes_token_once_after_unauthorized(self):
        forced = []
        attempts = []

        def admin_token(force_refresh=False):
            forced.append(force_refresh)
            return "new-token" if force_refresh else "old-token"

        def http_request(method, path, access_token=None, body=None):
            attempts.append(access_token)
            if access_token == "old-token":
                raise urllib.error.HTTPError(path, 401, "unauthorized", {}, io.BytesIO(b"secret details"))
            return {"ok": True}, {}

        self.server["keycloak_admin_token"] = admin_token
        self.server["_keycloak_http_request"] = http_request

        result, _ = self.server["keycloak_admin_request"]("GET", "/admin/test")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(forced, [False, True])
        self.assertEqual(attempts, ["old-token", "new-token"])

    def test_role_update_preserves_unmanaged_roles(self):
        assigned = {
            "magicstick-user": {"id": "user", "name": "magicstick-user"},
            "unmanaged": {"id": "foreign", "name": "unmanaged"},
        }
        requests = []

        def roles(_user_id, effective=False):
            return list(assigned.values())

        def role(name):
            return {"id": name, "name": name}

        def request(method, path, body=None):
            requests.append((method, path, body))
            if method == "POST":
                for item in body:
                    assigned[item["name"]] = item
            elif method == "DELETE":
                for item in body:
                    assigned.pop(item["name"], None)
            return {}, {}

        self.server["keycloak_user_roles"] = roles
        self.server["_realm_role"] = role
        self.server["keycloak_admin_request"] = request

        self.server["_replace_managed_roles"](
            "target-id",
            {"magicstick-user", "magicstick-admin"},
        )

        self.assertIn("unmanaged", assigned)
        self.assertIn("magicstick-admin", assigned)
        removed = [item["name"] for method, _path, body in requests if method == "DELETE" for item in body]
        self.assertNotIn("unmanaged", removed)

    def test_create_user_orders_disabled_password_roles_then_enable(self):
        calls = []
        created = self.user("new-id", "alice")
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["_exact_user_matches"] = lambda _field, _value: []

        def request(method, path, body=None):
            if method == "POST" and path.endswith("/users"):
                calls.append("create-disabled:" + str(body["enabled"]).lower())
                return {}, {"Location": "http://keycloak/admin/realms/magicstick/users/new-id"}
            if path.endswith("/reset-password"):
                calls.append("password-temporary:" + str(body["temporary"]).lower())
            elif method == "PUT" and path.endswith("/users/new-id"):
                calls.append("enable:" + str(body["enabled"]).lower())
            return {}, {}

        self.server["keycloak_admin_request"] = request
        self.server["_replace_managed_roles"] = lambda _user_id, roles: calls.append(
            "roles:" + ",".join(sorted(roles))
        )
        self.server["keycloak_user"] = lambda _user_id: created
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"], "username": user["username"]}

        result = self.server["create_user"](
            self.principal,
            {
                "username": "alice",
                "firstName": "Alice",
                "lastName": "Example",
                "email": "alice@example.com",
                "accessLevel": "operator",
                "password": "a-secure-temporary-password",
                "temporary": True,
                "enabled": True,
            },
        )

        self.assertEqual(
            calls,
            [
                "create-disabled:false",
                "password-temporary:true",
                "roles:magicstick-operator,magicstick-user",
                "enable:true",
            ],
        )
        self.assertEqual(result, {"id": "new-id", "username": "alice"})
        self.assertNotIn("password", result)

    def test_password_validation_preserves_leading_and_trailing_spaces(self):
        password = "  edge spaces stay  "

        validated = self.server["_validated_password"]({
            "password": password,
            "temporary": True,
        })

        self.assertEqual(validated, password)

    def test_create_user_rolls_back_after_partial_failure(self):
        calls = []
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["_exact_user_matches"] = lambda _field, _value: []

        def request(method, path, body=None):
            calls.append((method, path))
            if method == "POST" and path.endswith("/users"):
                return {}, {"Location": "http://keycloak/admin/realms/magicstick/users/new-id"}
            if path.endswith("/reset-password"):
                raise self.server["RequestError"](503, "identity administration is unavailable")
            return {}, {}

        self.server["keycloak_admin_request"] = request

        with self.assertRaises(self.server["RequestError"]):
            self.server["create_user"](
                self.principal,
                {
                    "username": "alice",
                    "email": "alice@example.com",
                    "accessLevel": "user",
                    "password": "a-secure-temporary-password",
                },
            )

        self.assertIn(("DELETE", "/admin/realms/magicstick/users/new-id"), calls)

    def test_self_disable_is_blocked_before_write(self):
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: self.user("actor-id", "admin")
        self.server["keycloak_user_groups"] = lambda _user_id: []
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["set_user_enabled"](self.principal, "actor-id", False)

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("own account", str(raised.exception))

    def test_disable_writes_disabled_state_before_logging_out_sessions(self):
        calls = []
        target = self.user("target-id", "target", enabled=True)
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: []
        self.server["keycloak_user_groups"] = lambda _user_id: []
        self.server["_ensure_admins_survive"] = lambda _target: None
        self.server["keycloak_admin_request"] = lambda method, path, body=None: (
            calls.append(("write", method, body)) or ({}, {})
        )
        self.server["_logout_user"] = lambda _user_id: calls.append(("logout",))
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"]}

        self.server["set_user_enabled"](self.principal, "target-id", False)

        self.assertEqual(calls[0], ("write", "PUT", {"enabled": False}))
        self.assertEqual(calls[1], ("logout",))

    def test_recovery_group_blocks_enable_and_disable_mutations(self):
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user_groups"] = lambda _user_id: [{
            "id": "recovery-group",
            "name": "magicstick-recovery",
            "path": "/magicstick-recovery",
        }]
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        for current, requested in ((True, False), (False, True)):
            with self.subTest(current=current, requested=requested):
                target = self.user("recovery-id", "recovery", enabled=current)
                self.server["keycloak_user"] = lambda _user_id, target=target: target
                with self.assertRaises(self.server["RequestError"]) as raised:
                    self.server["set_user_enabled"](self.principal, "recovery-id", requested)

                self.assertEqual(raised.exception.status, 409)
                self.assertIn("recovery", str(raised.exception))

    def test_last_local_administrator_is_protected(self):
        target = self.user("target-id", "last-admin")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "admin", "name": "magicstick-admin"}
        ]
        self.server["_enabled_admin_counts"] = lambda _excluding: (0, 0)

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["_ensure_admins_survive"](target)

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("last enabled administrator", str(raised.exception))

    def test_local_break_glass_admin_is_required_even_with_external_admin(self):
        target = self.user("target-id", "last-local-admin")
        self.server["keycloak_user_roles"] = lambda _user_id, effective=False: [
            {"id": "admin", "name": "magicstick-admin"}
        ]
        self.server["_enabled_admin_counts"] = lambda _excluding: (1, 0)
        self.server["identity_source"] = lambda _user: ("local", "local")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["_ensure_admins_survive"](target)

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("last enabled local administrator", str(raised.exception))

    def test_user_mutations_are_serialized(self):
        state = {"active": 0, "maximum": 0}
        state_lock = threading.Lock()
        errors = []

        def live_actor(_principal):
            with state_lock:
                state["active"] += 1
                state["maximum"] = max(state["maximum"], state["active"])
            time.sleep(0.03)
            with state_lock:
                state["active"] -= 1
            return self.user("actor-id", "admin")

        self.server["live_admin_actor"] = live_actor
        self.server["keycloak_user"] = lambda user_id: self.user(user_id, user_id, enabled=False)
        self.server["keycloak_user_groups"] = lambda _user_id: []
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: ({}, {})
        self.server["user_summary"] = lambda user, _actor: {"id": user["id"]}

        def mutate(user_id):
            try:
                self.server["set_user_enabled"](self.principal, user_id, True)
            except Exception as error:  # pragma: no cover - assertion reports details below
                errors.append(error)

        threads = [threading.Thread(target=mutate, args=(user_id,)) for user_id in ("one", "two")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(state["maximum"], 1)

    def test_external_password_reset_is_rejected_without_sending_password(self):
        target = self.user(
            "external-id",
            "external",
            federatedIdentities=[{"identityProvider": "entra"}],
        )
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["reset_user_password"](
                self.principal,
                "external-id",
                {"password": "a-secure-temporary-password", "temporary": True},
            )

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("external identity provider", str(raised.exception))

    def test_delete_requires_exact_username_confirmation(self):
        target = self.user("target-id", "alice")
        self.server["live_admin_actor"] = lambda _principal: self.user("actor-id", "admin")
        self.server["keycloak_user"] = lambda _user_id: target
        self.server["keycloak_admin_request"] = lambda *_args, **_kwargs: self.fail("must not write")

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["delete_user"](
                self.principal,
                "target-id",
                {"usernameConfirmation": "bob"},
            )

        self.assertEqual(raised.exception.status, 409)
        self.assertIn("confirmation", str(raised.exception))

    def test_request_body_is_limited_and_requires_json(self):
        class Handler:
            def __init__(self, headers, body=b""):
                self.headers = headers
                self.rfile = io.BytesIO(body)

        with self.assertRaises(self.server["RequestError"]) as too_large:
            self.server["read_body"](Handler({"Content-Length": str(64 * 1024 + 1)}))
        self.assertEqual(too_large.exception.status, 413)

        raw = b'{"enabled":true}'
        with self.assertRaises(self.server["RequestError"]) as wrong_type:
            self.server["read_body"](Handler({"Content-Length": str(len(raw)), "Content-Type": "text/plain"}, raw))
        self.assertEqual(wrong_type.exception.status, 415)

    def test_mutations_require_csrf_header_and_same_origin(self):
        class Handler:
            def __init__(self, headers):
                self.headers = headers

        with self.assertRaises(self.server["AuthError"]) as missing:
            self.server["validate_user_mutation_request"](Handler({"Host": "magicstick.local"}))
        self.assertEqual(missing.exception.status, 403)

        with self.assertRaises(self.server["AuthError"]) as cross_site:
            self.server["validate_user_mutation_request"](Handler({
                "X-MagicStick-CSRF": "dashboard",
                "Sec-Fetch-Site": "cross-site",
                "Origin": "https://attacker.example.com",
                "Host": "magicstick.local",
            }))
        self.assertEqual(cross_site.exception.status, 403)

        self.server["validate_user_mutation_request"](Handler({
            "X-MagicStick-CSRF": "dashboard",
            "Sec-Fetch-Site": "same-origin",
            "Origin": "https://magicstick.local",
            "Host": "magicstick.local",
        }))

    def test_mutations_accept_configured_local_and_public_origins_behind_http_nginx(self):
        class Handler:
            def __init__(self, origin, host):
                self.headers = {
                    "X-MagicStick-CSRF": "dashboard",
                    "Sec-Fetch-Site": "same-origin",
                    "Origin": origin,
                    "X-Forwarded-Host": host,
                    # Envoy terminates TLS before the dashboard nginx proxy, so
                    # nginx observes HTTP even though the browser origin is HTTPS.
                    "X-Forwarded-Proto": "http",
                }

        self.server["DASHBOARD_ALLOWED_ORIGINS"] = {
            "https://magicstick.local",
            "https://magicstick.example.com",
        }

        for origin in self.server["DASHBOARD_ALLOWED_ORIGINS"]:
            with self.subTest(origin=origin):
                self.server["validate_user_mutation_request"](
                    Handler(origin, origin.removeprefix("https://"))
                )

    def test_direct_external_mode_disables_identity_management(self):
        self.server["IDENTITY_MANAGEMENT_MODE"] = "direct-external"

        with self.assertRaises(self.server["RequestError"]) as raised:
            self.server["require_identity_management"]()

        self.assertEqual(raised.exception.status, 503)


if __name__ == "__main__":
    unittest.main()
