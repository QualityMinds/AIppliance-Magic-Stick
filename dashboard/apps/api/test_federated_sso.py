# SPDX-License-Identifier: MIT
"""Security and lifecycle tests for dashboard-managed identity federation."""
import copy
import json
from pathlib import Path
import sys
import threading
import unittest
import urllib.error
import urllib.request

import yaml


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "enterprise"))

from federated_sso import FederatedSso  # noqa: E402
from licensing import LicenseError  # noqa: E402
from magicstick_enterprise import federated_sso as policy  # noqa: E402


def oidc_payload(**changes):
    value = {
        "alias": "company",
        "displayName": "Company Login",
        "protocol": "oidc",
        "metadataUrl": "https://login.example.com/.well-known/openid-configuration",
        "clientId": "magicstick",
        "clientSecret": "private-client-secret",
        "scopes": "openid profile email",
        "enabled": True,
        "trustEmail": False,
        "mappings": [{"source": "groups", "value": "magicstick-users", "accessLevel": "user"}],
        "expectedRevision": "new",
    }
    value.update(changes)
    return value


def saml_payload(**changes):
    value = oidc_payload(
        protocol="saml", clientId="", clientSecret="", scopes="", trustEmail=False,
        metadataUrl="https://login.example.com/saml/metadata",
    )
    value.update(changes)
    return value


class License:
    def __init__(self, available=True):
        self.available = available
        self.status_error = False

    def status(self):
        if self.status_error:
            raise LicenseError("storage_unavailable", "license storage unavailable", 503)
        return {"features": [{"id": "federated-sso", "name": "Federated SSO", "licensed": self.available,
                              "implemented": True, "available": self.available,
                              "reason": "available" if self.available else "unlicensed"}]}

    def require_capability(self, feature, *, authorized):
        if feature != "federated-sso" or not authorized or not self.available:
            raise LicenseError("unlicensed", "A valid license entitlement is required.", 403)


class Keycloak:
    def __init__(self):
        self.providers = {}
        self.mappers = {}
        self.calls = []
        self.fail_mapper = False
        self.create_conflict = False

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        base = "/admin/realms/magicstick"
        if method == "POST" and path == base + "/identity-provider/import-config":
            if body["providerId"] == "oidc":
                return ({"issuer": "https://login.example.com", "authorizationUrl": "https://login.example.com/auth",
                         "tokenUrl": "https://login.example.com/token", "userInfoUrl": "https://login.example.com/userinfo",
                         "jwksUrl": "https://login.example.com/keys", "unsafe": "must-not-pass"}, {})
            return ({
                "idpEntityId": "https://login.example.com/saml",
                "singleSignOnServiceUrl": "https://login.example.com/sso",
                "signingCertificate": "U0FNTC1URVNULUNFUlQ=",
                "postBindingAuthnRequest": "true",
                "postBindingResponse": "true",
                "enabledFromMetadata": "true",
            }, {})
        collection = base + "/identity-provider/instances"
        if method == "GET" and path == collection:
            return (list(copy.deepcopy(self.providers).values()), {})
        if method == "POST" and path == collection:
            if self.create_conflict:
                self.providers[body["alias"]] = copy.deepcopy(body)
                self.mappers[body["alias"]] = []
                raise LicenseError("conflict", "provider already exists", 409)
            self.providers[body["alias"]] = copy.deepcopy(body)
            self.mappers[body["alias"]] = []
            return ({}, {})
        suffix = path.removeprefix(collection + "/")
        alias, separator, child = suffix.partition("/")
        if not alias:
            raise AssertionError((method, path, body))
        if not separator:
            if method == "PUT":
                self.providers[alias] = copy.deepcopy(body)
                return ({}, {})
            if method == "DELETE":
                self.providers.pop(alias, None); self.mappers.pop(alias, None)
                return ({}, {})
        if child == "mappers":
            if method == "GET":
                return (copy.deepcopy(self.mappers.get(alias, [])), {})
            if method == "POST":
                if self.fail_mapper:
                    raise LicenseError("identity_unavailable", "mapping failed", 503)
                value = copy.deepcopy(body); value["id"] = f"mapper-{len(self.mappers[alias]) + 1}"
                self.mappers[alias].append(value)
                return ({}, {})
        if child.startswith("mappers/") and method == "DELETE":
            identifier = child.split("/", 1)[1]
            self.mappers[alias] = [item for item in self.mappers[alias] if item.get("id") != identifier]
            return ({}, {})
        raise AssertionError((method, path, body))


class FederatedSsoPolicyTests(unittest.TestCase):
    def test_strict_input_and_https_metadata(self):
        self.assertEqual(policy.validate_payload(oidc_payload())["alias"], "company")
        self.assertEqual(policy.validate_metadata_payload({
            "protocol": "oidc",
            "metadataUrl": "https://login.example.com/.well-known/openid-configuration",
        })["protocol"], "oidc")
        with self.assertRaises(ValueError):
            policy.validate_metadata_payload({
                "protocol": "oidc", "metadataUrl": "https://login.example.com/config", "alias": "raw",
            })
        for value in (
            [],
            oidc_payload(metadataUrl="http://login.example.com/config"),
            oidc_payload(metadataUrl="https://user:secret@login.example.com/config"),
            oidc_payload(alias="Company"),
            oidc_payload(extra="raw-keycloak-field"),
            oidc_payload(mappings=[]),
            oidc_payload(mappings=[{"source": "groups", "value": "x", "accessLevel": "realm-admin"}]),
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy.validate_payload(value)

    def test_generated_representation_forces_safe_provider_and_role_mapper_fields(self):
        provider, mappers = policy.build_provider(oidc_payload(), {
            "issuer": "https://login.example.com",
            "authorizationUrl": "https://login.example.com/auth",
            "tokenUrl": "https://login.example.com/token",
            "jwksUrl": "https://login.example.com/keys",
            "unsafe": "raw-input-must-not-pass",
        }, issuer="https://id.magicstick.local/realms/magicstick")
        self.assertEqual(provider["providerId"], "oidc")
        self.assertEqual(provider["config"]["validateSignature"], "true")
        self.assertEqual(provider["config"]["clientSecret"], "private-client-secret")
        self.assertEqual(provider["config"]["magicstickSecretConfigured"], "true")
        self.assertNotIn("unsafe", provider["config"])
        self.assertEqual(mappers[0]["identityProviderMapper"], "oidc-role-idp-mapper")
        self.assertEqual(mappers[0]["config"]["role"], "magicstick-user")
        self.assertEqual(set(mappers[0]["config"]), {"syncMode", "claim", "claim.value", "role"})

    def test_saml_requires_signed_assertions_and_has_no_oidc_secret(self):
        provider, mappers = policy.build_provider(saml_payload(), {
            "idpEntityId": "https://login.example.com/saml",
            "singleSignOnServiceUrl": "https://login.example.com/sso",
            "signingCertificate": "U0FNTC1URVNULUNFUlQ=",
            "postBindingAuthnRequest": "true",
            "enabledFromMetadata": "true",
        }, issuer="https://id.magicstick.local/realms/magicstick")
        self.assertEqual(provider["config"]["wantAssertionsSigned"], "true")
        self.assertEqual(provider["config"]["entityId"], "https://id.magicstick.local/realms/magicstick")
        self.assertEqual(provider["config"]["idpEntityId"], "https://login.example.com/saml")
        self.assertEqual(provider["config"]["postBindingAuthnRequest"], "true")
        self.assertNotIn("clientSecret", provider["config"])
        self.assertEqual(mappers[0]["identityProviderMapper"], "saml-role-idp-mapper")

    def test_saml_rejects_expired_or_unsigned_metadata(self):
        base = {
            "idpEntityId": "https://login.example.com/saml",
            "singleSignOnServiceUrl": "https://login.example.com/sso",
            "signingCertificate": "U0FNTC1URVNULUNFUlQ=",
            "enabledFromMetadata": "true",
        }
        for imported in ({**base, "enabledFromMetadata": "false"}, {
            key: value for key, value in base.items() if key != "signingCertificate"
        }):
            with self.subTest(imported=imported), self.assertRaises(ValueError):
                policy.build_provider(
                    saml_payload(), imported,
                    issuer="https://id.magicstick.local/realms/magicstick",
                )


class FederatedSsoLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.license = License()
        self.keycloak = Keycloak()
        self.events = []
        self.principal = {"subject": "admin", "username": "admin", "roles": ["magicstick-admin"]}
        self.service = FederatedSso(
            license_service=self.license,
            admin=self.keycloak,
            verify_admin=lambda principal: principal if principal == self.principal else (_ for _ in ()).throw(LicenseError("forbidden", "admin", 403)),
            realm="magicstick",
            issuer="https://id.magicstick.local/realms/magicstick",
            audit=lambda **event: self.events.append(event),
        )

    def test_create_list_update_and_delete_never_return_secret(self):
        created = self.service.save(self.principal, oidc_payload(), request_id="request-1")
        self.assertEqual(len(created["providers"]), 1)
        item = created["providers"][0]
        self.assertTrue(item["secretConfigured"])
        self.assertNotIn("private-client-secret", repr(created))
        self.assertNotIn("unsafe", repr(created))
        updated = self.service.save(self.principal, oidc_payload(
            displayName="New Name", clientSecret="new-private-secret", expectedRevision=item["revision"]
        ), alias="company")
        self.assertEqual(updated["providers"][0]["displayName"], "New Name")
        self.assertNotIn("new-private-secret", repr(updated))
        revision = updated["providers"][0]["revision"]
        self.assertEqual(self.service.delete(self.principal, "company", revision), {"deleted": "company"})
        self.assertFalse(self.keycloak.providers)
        self.assertEqual([event["action"] for event in self.events], ["create", "update", "delete"])

    def test_validation_does_not_require_or_return_client_secret(self):
        result = self.service.validate(self.principal, {
            "protocol": "oidc",
            "metadataUrl": "https://login.example.com/.well-known/openid-configuration",
        })
        self.assertEqual(result["configuration"]["issuer"], "https://login.example.com")
        self.assertNotIn("secret", repr(result).lower())

    def test_non_object_save_payload_is_reported_as_invalid_input(self):
        with self.assertRaises(ValueError):
            self.service.save(self.principal, [])

    def test_license_blocks_changes_and_expiry_disables_without_deleting(self):
        created = self.service.save(self.principal, oidc_payload())
        self.license.available = False
        with self.assertRaises(LicenseError) as caught:
            self.service.save(self.principal, oidc_payload(expectedRevision=created["providers"][0]["revision"]), alias="company")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(self.service.enforce_entitlement(), 1)
        self.assertFalse(self.keycloak.providers["company"]["enabled"])
        self.assertIn("company", self.keycloak.providers)
        revision = self.service.status(self.principal)["providers"][0]["revision"]
        self.service.delete(self.principal, "company", revision)
        self.assertFalse(self.keycloak.providers)

    def test_unverifiable_license_state_disables_managed_provider(self):
        self.service.save(self.principal, oidc_payload())
        self.license.status_error = True
        status = self.service.status(self.principal)
        self.assertFalse(status["feature"]["available"])
        self.assertEqual(status["feature"]["reason"], "storage_unavailable")
        self.assertEqual(status["providers"][0]["alias"], "company")
        self.assertEqual(self.service.enforce_entitlement(), 1)
        self.assertFalse(self.keycloak.providers["company"]["enabled"])

    def test_new_provider_is_removed_if_mapping_creation_fails(self):
        self.keycloak.fail_mapper = True
        with self.assertRaises(LicenseError):
            self.service.save(self.principal, oidc_payload())
        self.assertNotIn("company", self.keycloak.providers)
        self.assertEqual(self.events[-1]["result"], "failure")

    def test_failed_update_stays_disabled_and_preserves_external_mappers(self):
        created = self.service.save(self.principal, oidc_payload())
        self.keycloak.mappers["company"].append({
            "id": "external-1", "name": "managed elsewhere", "config": {},
        })
        self.keycloak.fail_mapper = True
        with self.assertRaises(LicenseError):
            self.service.save(self.principal, oidc_payload(
                clientSecret="replacement", expectedRevision=created["providers"][0]["revision"],
            ), alias="company")
        self.assertFalse(self.keycloak.providers["company"]["enabled"])
        self.assertEqual([item["id"] for item in self.keycloak.mappers["company"]], ["external-1"])

    def test_saml_provider_lifecycle_uses_no_client_secret(self):
        created = self.service.save(self.principal, saml_payload())
        item = created["providers"][0]
        self.assertEqual(item["protocol"], "saml")
        self.assertFalse(item["secretConfigured"])
        self.assertNotIn("clientSecret", self.keycloak.providers["company"]["config"])

    def test_revision_and_external_provider_ownership_are_enforced(self):
        result = self.service.save(self.principal, oidc_payload())
        with self.assertRaises(LicenseError) as caught:
            self.service.save(self.principal, oidc_payload(expectedRevision="stale"), alias="company")
        self.assertEqual(caught.exception.status, 409)
        self.keycloak.providers["outside"] = {"alias": "outside", "providerId": "oidc", "enabled": True, "config": {}}
        with self.assertRaises(LicenseError):
            self.service.save(self.principal, oidc_payload(alias="outside"))
        self.assertEqual(len(result["providers"]), 1)

    def test_create_conflict_never_deletes_provider_created_by_another_writer(self):
        self.keycloak.create_conflict = True
        with self.assertRaises(LicenseError) as caught:
            self.service.save(self.principal, oidc_payload())
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("company", self.keycloak.providers)
        self.assertFalse(self.keycloak.providers["company"]["enabled"])

    def test_provider_protocol_is_immutable(self):
        created = self.service.save(self.principal, oidc_payload())
        saml = saml_payload(expectedRevision=created["providers"][0]["revision"])
        with self.assertRaises(LicenseError) as caught:
            self.service.save(self.principal, saml, alias="company")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.keycloak.providers["company"]["providerId"], "oidc")


class FederatedSsoHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = yaml.safe_load((ROOT / "magic-cluster/apps/dashboard/dashboard-api.yaml").read_text())
        source = manifest["data"]["server.py"].replace(
            "SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)", "SSL_CONTEXT = None"
        ).replace("PUBLIC_SSL_CONTEXT = ssl.create_default_context()", "PUBLIC_SSL_CONTEXT = None")
        cls.server = {"__name__": "federated_sso_http_test"}
        exec(compile(source, "server.py", "exec"), cls.server)

    def setUp(self):
        self.calls = []
        principal = {"subject": "admin", "username": "admin", "roles": ["magicstick-admin"]}
        self.original_authorize = self.server["authorize"]
        self.original_service = self.server["federated_sso_service"]
        self.server["authorize"] = lambda _header, access: principal if access == "admin" else None
        calls = self.calls

        class Service:
            def status(self, actor): calls.append(("status", actor)); return {"providers": []}
            def validate(self, actor, body): calls.append(("validate", actor, body)); return {"configuration": {}}
            def save(self, actor, body, alias=None, request_id=""): calls.append(("save", actor, body, alias)); return {"providers": []}
            def delete(self, actor, alias, revision, request_id=""): calls.append(("delete", actor, alias, revision)); return {"deleted": alias}

        self.server["federated_sso_service"] = lambda: Service()
        self.http = self.server["ThreadingHTTPServer"](("127.0.0.1", 0), self.server["Handler"])
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown(); self.http.server_close()
        self.server["authorize"] = self.original_authorize
        self.server["federated_sso_service"] = self.original_service

    def request(self, path, method="GET", body=None, csrf=True):
        headers = {"Authorization": "Bearer synthetic"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if method != "GET" and csrf:
            headers["X-MagicStick-CSRF"] = "dashboard"
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.http.server_port}{path}", method=method, headers=headers,
            data=json.dumps(body).encode() if body is not None else None,
        )
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        return response.status, json.loads(response.read().decode())

    def test_admin_routes_and_csrf_boundary(self):
        self.assertEqual(self.request("/api/federated-sso")[0], 200)
        self.assertEqual(self.request("/api/federated-sso/validate", "POST", {"protocol": "oidc"})[0], 200)
        self.assertEqual(self.request("/api/federated-sso/providers", "POST", {"alias": "company"})[0], 201)
        self.assertEqual(self.request("/api/federated-sso/providers/company", "PUT", {"alias": "company"})[0], 200)
        self.assertEqual(self.request("/api/federated-sso/providers/company", "DELETE", {"expectedRevision": "4"})[0], 200)
        self.assertEqual([call[0] for call in self.calls], ["status", "validate", "save", "save", "delete"])
        self.assertIsNone(self.calls[2][3])
        self.assertEqual(self.calls[3][3], "company")
        self.assertEqual(self.calls[4][3], "4")
        status, _ = self.request("/api/federated-sso/providers", "POST", {"alias": "blocked"}, csrf=False)
        self.assertEqual(status, 403)

    def test_provider_path_alias_is_validated_before_service_access(self):
        status, payload = self.request(
            "/api/federated-sso/providers/Company", "DELETE", {"expectedRevision": "4"}
        )
        self.assertEqual(status, 400)
        self.assertIn("lowercase DNS label", payload["error"])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
