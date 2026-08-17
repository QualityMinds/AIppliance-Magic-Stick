import json
import pathlib
import re
import subprocess
import unittest

import yaml


IDENTITY_DIR = pathlib.Path(__file__).parents[1]
CLIENT_ID = "magicstick-user-admin"
CLIENT_SECRET_NAME = "magicstick-user-admin-client"
HUMAN_GATEWAY_CLIENT_ID = "magicstick-human-gateway-local"
EXPECTED_POST_LOGOUT_REDIRECT_URIS = (
    "https://${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}/##"
    "https://${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}/"
)
EXPECTED_ADMIN_ROLES = {
    "manage-users",
    "query-users",
    "view-users",
    "view-realm",
}
FORBIDDEN_ADMIN_ROLES = {
    "create-client",
    "impersonation",
    "manage-authorization",
    "manage-clients",
    "manage-events",
    "manage-identity-providers",
    "manage-organizations",
    "manage-realm",
    "query-clients",
    "query-groups",
    "query-organizations",
    "query-realms",
    "realm-admin",
    "view-authorization",
    "view-clients",
    "view-events",
    "view-identity-providers",
    "view-organizations",
}


def load_documents(name):
    return list(yaml.safe_load_all((IDENTITY_DIR / name).read_text(encoding="utf-8")))


def keycloak_container():
    deployment = next(
        document
        for document in load_documents("keycloak.yaml")
        if document["kind"] == "Deployment"
    )
    return deployment["spec"]["template"]["spec"]["containers"][0]


def realm_import():
    config_map = load_documents("keycloak-realm.yaml")[0]
    return json.loads(config_map["data"]["magicstick-realm.json"])


def identity_gateway_documents():
    return [document for document in load_documents("gateway.yaml") if document]


class UserAdminIdentityTests(unittest.TestCase):
    def test_gateway_exposes_http_only_for_a_global_https_redirect(self):
        gateway = next(
            document
            for document in identity_gateway_documents()
            if document["kind"] == "Gateway"
        )
        listeners = {listener["name"]: listener for listener in gateway["spec"]["listeners"]}

        self.assertEqual(listeners["http"]["protocol"], "HTTP")
        self.assertEqual(listeners["http"]["port"], 80)
        self.assertNotIn("tls", listeners["http"])
        self.assertEqual(listeners["https"]["protocol"], "HTTPS")
        self.assertEqual(listeners["https"]["port"], 443)
        self.assertEqual(
            listeners["http"]["allowedRoutes"],
            listeners["https"]["allowedRoutes"],
        )

    def test_http_listener_has_no_backend_and_redirects_every_host_to_https(self):
        route = next(
            document
            for document in identity_gateway_documents()
            if document["kind"] == "HTTPRoute"
            and document["metadata"]["name"] == "redirect-http-to-https"
        )

        self.assertEqual(route["metadata"]["namespace"], "identity-system")
        self.assertNotIn("hostnames", route["spec"])
        self.assertEqual(
            route["spec"]["parentRefs"],
            [{"name": "identity-pilot", "sectionName": "http"}],
        )
        self.assertEqual(
            route["spec"]["rules"],
            [
                {
                    "filters": [
                        {
                            "type": "RequestRedirect",
                            "requestRedirect": {"scheme": "https", "statusCode": 301},
                        }
                    ]
                }
            ],
        )
        self.assertNotIn("backendRefs", route["spec"]["rules"][0])

    def test_fresh_realm_import_has_exact_dashboard_logout_redirects(self):
        realm = realm_import()
        client = next(
            client
            for client in realm["clients"]
            if client["clientId"] == HUMAN_GATEWAY_CLIENT_ID
        )

        self.assertEqual(
            client["attributes"],
            {"post.logout.redirect.uris": EXPECTED_POST_LOGOUT_REDIRECT_URIS},
        )
        self.assertNotIn("*", EXPECTED_POST_LOGOUT_REDIRECT_URIS)
        self.assertNotIn("+", EXPECTED_POST_LOGOUT_REDIRECT_URIS)

    def test_fresh_realm_import_defines_internal_recovery_group(self):
        realm = realm_import()
        groups = [group for group in realm["groups"] if group["name"] == "magicstick-recovery"]
        roles = {role["name"] for role in realm["roles"]["realm"]}

        self.assertEqual(groups, [{"name": "magicstick-recovery"}])
        self.assertNotIn("magicstick-recovery", roles)

    def test_secret_is_generated_at_runtime_and_flux_does_not_prune_it(self):
        secret = next(
            document
            for document in load_documents("secrets.yaml")
            if document["metadata"]["name"] == CLIENT_SECRET_NAME
        )

        self.assertEqual(secret["metadata"]["namespace"], "identity-system")
        self.assertEqual(secret["stringData"], {"client-id": CLIENT_ID})
        annotations = secret["metadata"]["annotations"]
        self.assertEqual(annotations["kustomize.toolkit.fluxcd.io/prune"], "disabled")
        self.assertEqual(
            annotations["secret-generator.v1.mittwald.de/autogenerate"],
            "client-secret",
        )
        self.assertEqual(annotations["secret-generator.v1.mittwald.de/encoding"], "hex")

    def test_fresh_realm_import_has_a_dedicated_confidential_client(self):
        realm = realm_import()
        client = next(client for client in realm["clients"] if client["clientId"] == CLIENT_ID)

        self.assertFalse(client["publicClient"])
        self.assertTrue(client["serviceAccountsEnabled"])
        self.assertFalse(client["standardFlowEnabled"])
        self.assertFalse(client["implicitFlowEnabled"])
        self.assertFalse(client["directAccessGrantsEnabled"])
        self.assertEqual(client["secret"], "$${MAGICSTICK_USER_ADMIN_CLIENT_SECRET}")
        self.assertNotEqual(client["clientId"], "magicstick-setup")

    def test_fresh_realm_import_grants_only_scoped_user_admin_roles(self):
        realm = realm_import()
        service_account = next(
            user
            for user in realm["users"]
            if user.get("serviceAccountClientId") == CLIENT_ID
        )
        assigned = set(service_account["clientRoles"]["realm-management"])

        self.assertEqual(assigned, EXPECTED_ADMIN_ROLES)
        self.assertTrue(assigned.isdisjoint(FORBIDDEN_ADMIN_ROLES))

    def test_keycloak_reads_the_runtime_generated_secret(self):
        env = {entry["name"]: entry for entry in keycloak_container()["env"]}
        reference = env["MAGICSTICK_USER_ADMIN_CLIENT_SECRET"]["valueFrom"]["secretKeyRef"]

        self.assertEqual(reference, {"name": CLIENT_SECRET_NAME, "key": "client-secret"})

    def test_upgrade_reconciliation_is_create_or_update_and_idempotent(self):
        script = keycloak_container()["lifecycle"]["postStart"]["exec"]["command"][-1]

        self.assertIn("sync_user_admin_client()", script)
        self.assertIn("user_admin_client_uuid=\"$(client_uuid magicstick-user-admin)\"", script)
        self.assertIn("if [ -z \"$user_admin_client_uuid\" ]; then", script)
        self.assertIn("kcadm.sh create clients", script)
        self.assertIn('kcadm.sh update "clients/$user_admin_client_uuid"', script)
        self.assertIn("sync_user_admin_client\n", script)
        self.assertEqual(
            re.search(r'user_admin_allowed_roles="([^"]+)"', script).group(1).split(),
            ["manage-users", "query-users", "view-users", "view-realm"],
        )
        self.assertNotIn("user_admin_denied_roles", script)
        self.assertIn("kcadm.sh remove-roles", script)

    def test_upgrade_reconciliation_sets_exact_dashboard_logout_redirects(self):
        script = keycloak_container()["lifecycle"]["postStart"]["exec"]["command"][-1]

        self.assertIn(
            "-s 'attributes.\"post.logout.redirect.uris\"="
            f"{EXPECTED_POST_LOGOUT_REDIRECT_URIS}'",
            script,
        )

    def test_upgrade_reconciliation_covers_the_full_keycloak_startup_budget(self):
        container = keycloak_container()
        script = container["lifecycle"]["postStart"]["exec"]["command"][-1]
        probe = container["startupProbe"]

        expected_attempts = probe["failureThreshold"]
        self.assertEqual(probe["periodSeconds"], 5)
        self.assertIn(f'while [ "$attempt" -lt {expected_attempts} ]; do', script)
        self.assertIn("sleep 5", script)

    def test_keycloak_poststart_does_not_require_realm_admin_for_recovery_marking(self):
        script = keycloak_container()["lifecycle"]["postStart"]["exec"]["command"][-1]

        self.assertNotIn("magicstick-recovery", script)
        self.assertNotIn("--rolename manage-realm", script)

    def test_upgrade_reconciliation_removes_and_verifies_every_direct_extra_role(self):
        script = keycloak_container()["lifecycle"]["postStart"]["exec"]["command"][-1]

        self.assertIn(
            '"users/$user_admin_service_account_uuid/role-mappings/clients/$realm_management_client_uuid"',
            script,
        )
        self.assertIn('current_user_admin_roles="$(direct_user_admin_roles)" || return 1', script)
        self.assertIn('for role in $current_user_admin_roles; do', script)
        self.assertIn('case " $user_admin_allowed_roles " in', script)
        removal = script[script.index("kcadm.sh remove-roles"):]
        removal = removal[:removal.index(";;")]
        self.assertIn('--rolename "$role" >/dev/null 2>&1 || return 1', removal)
        self.assertIn(
            'expected_user_admin_roles="$(printf \'%s\\n\' $user_admin_allowed_roles | LC_ALL=C sort)"',
            script,
        )
        self.assertIn(
            '[ "$current_user_admin_roles" = "$expected_user_admin_roles" ] || return 1',
            script,
        )

    def test_reconciliation_validates_the_scoped_client_without_logging_secrets(self):
        script = keycloak_container()["lifecycle"]["postStart"]["exec"]["command"][-1]

        self.assertIn("--client magicstick-user-admin", script)
        self.assertIn("kcadm.sh get roles/magicstick-user", script)
        self.assertIn("kcadm.sh get users", script)
        self.assertNotIn("set -x", script)
        self.assertNotRegex(script, r"echo[^\n]*MAGICSTICK_USER_ADMIN_CLIENT_SECRET")
        self.assertIn('trap cleanup EXIT', script)

    def test_embedded_reconciliation_script_has_valid_shell_syntax(self):
        script = keycloak_container()["lifecycle"]["postStart"]["exec"]["command"][-1]
        result = subprocess.run(
            ["/bin/sh", "-n"],
            input=script,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
