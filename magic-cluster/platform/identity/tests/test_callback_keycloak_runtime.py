# SPDX-License-Identifier: BUSL-1.1
"""Exercise the actual callback reconciler against a disposable pinned Keycloak.

Run with MAGICSTICK_RUN_KEYCLOAK_CONTAINER_TESTS=1. No appliance is contacted;
the process never prints client secrets, tokens or full client representations.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import unittest
import urllib.parse
import urllib.request
import uuid
from unittest.mock import patch

from test_setup_server import setup

IMAGE = "quay.io/keycloak/keycloak:26.6.3@sha256:9b0330756022422149aa6502eb2def8cd47c6e1b000c7c65cdb13e7c0133e992"


@unittest.skipUnless(os.environ.get("MAGICSTICK_RUN_KEYCLOAK_CONTAINER_TESTS") == "1", "pinned Keycloak runtime gate not requested")
class CallbackKeycloakRuntimeTests(unittest.TestCase):
    def test_scoped_callback_write_preserves_client_state_and_secret(self):
        name = "magicstick-callback-test-" + uuid.uuid4().hex[:12]
        admin_password = secrets.token_urlsafe(24)
        gateway_secret = secrets.token_urlsafe(24)
        setup_secret = secrets.token_urlsafe(24)
        rotated_secret = secrets.token_urlsafe(24)
        # Kubernetes observations stay synthetic; the IdP protocol below is real.
        endpoint_uid = str(uuid.uuid4())
        rotation_mode = os.environ.get("MAGICSTICK_PROBE_UNSAFE_ROTATION", "")
        probe_rotation = rotation_mode in {"1", "guard"}
        realm = {"realm": "magicstick", "enabled": True, "sslRequired": "none", "clients": [
            {"clientId": "magicstick-human-gateway-local", "enabled": True, "publicClient": False,
             "secret": gateway_secret, "standardFlowEnabled": True, "serviceAccountsEnabled": True,
             "directAccessGrantsEnabled": True, "consentRequired": True, "fullScopeAllowed": False,
             "redirectUris": ["https://old.example.local/oauth2/callback"],
             "webOrigins": ["https://old.example.local"],
             "attributes": {"post.logout.redirect.uris": "https://old.example.local/",
                            "client.secret.creation.time": "1760000000", "synthetic-keep": "preserve"}},
            {"clientId": "magicstick-setup", "enabled": True, "publicClient": False,
             "secret": setup_secret, "serviceAccountsEnabled": True, "standardFlowEnabled": False}],
            "users": [{"username": "service-account-magicstick-setup", "enabled": True,
                       "serviceAccountClientId": "magicstick-setup",
                       "clientRoles": {"realm-management": ["manage-clients", "view-clients"]}}]}
        if probe_rotation:
            realm["clients"][0]["attributes"].update({
                "client.secret.expiration.time": str(int(time.time()) + 7200),
                "client.secret.remaining.expiration.time": "300",
                "client.secret.rotated": rotated_secret,
                "client.secret.rotated.creation.time": str(int(time.time()) - 60),
                "client.secret.rotated.expiration.time": str(int(time.time()) + 3600),
            })
        with tempfile.TemporaryDirectory(prefix="magicstick-keycloak-callback-") as directory:
            environment = {**os.environ, 'KC_BOOTSTRAP_ADMIN_USERNAME': 'fixture-admin',
                           'KC_BOOTSTRAP_ADMIN_PASSWORD': admin_password, 'KC_FEATURES': 'client-secret-rotation'}
            try:
                subprocess.run(["docker", "run", "-d", "--name", name, "--publish", "127.0.0.1::8080",
                    '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME', '-e', 'KC_BOOTSTRAP_ADMIN_PASSWORD', '-e', 'KC_FEATURES',
                    IMAGE, "start-dev"], env=environment, check=True, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=180)
                endpoint = subprocess.check_output(["docker", "port", name, "8080/tcp"], text=True).strip()
                base = "http://127.0.0.1:" + endpoint.rsplit(":", 1)[1]

                def request(method, path, token=None, body=None, form=None):
                    headers = {"Accept": "application/json"}
                    data = None
                    if token:
                        headers["Authorization"] = "Bearer " + token
                    if body is not None:
                        headers["Content-Type"] = "application/json"
                        data = json.dumps(body).encode()
                    if form is not None:
                        headers["Content-Type"] = "application/x-www-form-urlencoded"
                        data = urllib.parse.urlencode(form).encode()
                    req = urllib.request.Request(base + path, method=method, headers=headers, data=data)
                    with urllib.request.urlopen(req, timeout=5) as response:
                        raw = response.read()
                        return (json.loads(raw) if raw else {}), response.headers

                admin = None
                for _ in range(120):
                    try:
                        admin, _ = request("POST", "/realms/master/protocol/openid-connect/token", form={
                            "grant_type": "password", "client_id": "admin-cli", "username": "fixture-admin", "password": admin_password})
                        break
                    except (OSError, ValueError):
                        time.sleep(1)
                self.assertIsNotNone(admin, "isolated Keycloak did not become ready")
                admin_token = admin["access_token"]
                # Import over the isolated loopback API, never a plaintext
                # credential file or a secret-bearing command-line argument.
                request('POST', '/admin/realms', token=admin_token, body=realm)
                clients, _ = request("GET", "/admin/realms/magicstick/clients?clientId=magicstick-human-gateway-local", token=admin_token)
                self.assertEqual(len(clients), 1)
                client_path = "/admin/realms/magicstick/clients/" + clients[0]["id"]
                before, _ = request("GET", client_path, token=admin_token)
                before_secret, _ = request("GET", client_path + "/client-secret", token=admin_token)
                self.assertTrue(before_secret.get("value") == gateway_secret, "synthetic client secret was not imported")
                self.assertIn("client.secret.creation.time", before.get("attributes") or {}, "secret creation metadata was not imported")
                if probe_rotation:
                    keys = {"client.secret.expiration.time", "client.secret.remaining.expiration.time",
                            "client.secret.rotated", "client.secret.rotated.creation.time", "client.secret.rotated.expiration.time"}
                    self.assertTrue(keys.issubset(set(before.get("attributes") or {})), "rotation attributes were not imported")
                    before_rotated, _ = request("GET", client_path + "/client-secret/rotated", token=admin_token)
                    self.assertTrue(before_rotated.get("value") == rotated_secret, "rotated synthetic secret was not imported")
                    if rotation_mode == "guard":
                        raw = json.dumps({"version": 1, "entries": []}, separators=(",", ":"))
                        def guarded_resource(path):
                            if path == setup.KEYCLOAK_ENDPOINTS_PATH:
                                return {"subsets": [{"addresses": [{"targetRef": {"kind": "Pod", "uid": endpoint_uid}}]}]}
                            if path == setup.SETTINGS_PATH:
                                return {"data": {"AI_APPLIANCE_MDNS_DOMAIN": "fixture.local", "AI_APPLIANCE_DOMAIN": "example.com", "AI_APPLIANCE_DASHBOARD_HOST": "dashboard.example.com"}}
                            if path == setup.CALLBACKS_PATH:
                                return {"data": {"callbacks.json": raw}}
                            if path == setup.CALLBACKS_STATUS_PATH:
                                return {"data": {}}
                            return None
                        def guarded_token():
                            value, _ = request("POST", "/realms/magicstick/protocol/openid-connect/token", form={
                                "grant_type": "client_credentials", "client_id": "magicstick-setup", "client_secret": setup_secret})
                            return value["access_token"]
                        with (patch.object(setup, "get_resource", side_effect=guarded_resource),
                              patch.object(setup, "keycloak_token", side_effect=guarded_token),
                              patch.object(setup, "keycloak_request", side_effect=request),
                              patch.object(setup, "kube_request") as writes):
                            with self.assertRaisesRegex(ValueError, 'rotation requires review'):
                                setup.sync_oidc_callbacks()
                            writes.assert_not_called()
                        guarded_after, _ = request("GET", client_path, token=admin_token)
                        rotated_after, _ = request("GET", client_path + "/client-secret/rotated", token=admin_token)
                        self.assertTrue(before == guarded_after, "rotation-protected client changed")
                        self.assertTrue(before_rotated == rotated_after, "rotation-protected secret changed")
                        return
                    attributes = dict(before.get("attributes") or {})
                    attributes["post.logout.redirect.uris"] = "https://fixture.local/"
                    request("PUT", client_path, token=admin_token, body={"id": before["id"],
                        "clientId": "magicstick-human-gateway-local", "redirectUris": ["https://fixture.local/oauth2/callback"],
                        "webOrigins": ["https://fixture.local"], "attributes": attributes})
                    probe_after, _ = request("GET", client_path, token=admin_token)
                    actual_attrs = probe_after.get("attributes") or {}
                    lost = sorted(key for key in keys if actual_attrs.get(key) != before["attributes"].get(key))
                    self.assertEqual(lost, [], "UNSAFE PUT changed client rotation fields")
                    after_rotated, _ = request("GET", client_path + "/client-secret/rotated", token=admin_token)
                    self.assertTrue(before_rotated == after_rotated, "UNSAFE PUT changed rotated secret")
                    return
                def verify_client_credentials():
                    token, _ = request("POST", "/realms/magicstick/protocol/openid-connect/token", form={
                        "grant_type": "client_credentials", "client_id": "magicstick-human-gateway-local", "client_secret": gateway_secret})
                    self.assertTrue(bool(token.get("access_token")), "synthetic client authentication failed")
                verify_client_credentials()
                raw = json.dumps({"version": 1, "entries": []}, separators=(",", ":"))
                status = {}
                def resource(path):
                    if path == setup.KEYCLOAK_ENDPOINTS_PATH:
                        return {"subsets": [{"addresses": [{"targetRef": {"kind": "Pod", "uid": endpoint_uid}}]}]}
                    if path == setup.SETTINGS_PATH:
                        return {"data": {"AI_APPLIANCE_MDNS_DOMAIN": "fixture.local", "AI_APPLIANCE_DOMAIN": "example.com", "AI_APPLIANCE_DASHBOARD_HOST": "dashboard.example.com"}}
                    if path == setup.CALLBACKS_PATH:
                        return {"data": {"callbacks.json": raw}}
                    if path == setup.CALLBACKS_STATUS_PATH:
                        return {"data": dict(status)}
                    return None
                def scoped_token():
                    value, _ = request("POST", "/realms/magicstick/protocol/openid-connect/token", form={
                        "grant_type": "client_credentials", "client_id": "magicstick-setup", "client_secret": setup_secret})
                    return value["access_token"]
                def persist_status(method, path, body, *_):
                    self.assertEqual((method, path), ('PATCH', setup.CALLBACKS_STATUS_PATH))
                    status.update(body.get('data') or {})
                    return {'data': dict(status)}
                with (patch.object(setup, "get_resource", side_effect=resource),
                      patch.object(setup, "keycloak_token", side_effect=scoped_token),
                      patch.object(setup, "keycloak_request", side_effect=request),
                      patch.object(setup, "kube_request", side_effect=persist_status)):
                    setup.sync_oidc_callbacks()
                after, _ = request("GET", client_path, token=admin_token)
                after_secret, _ = request("GET", client_path + "/client-secret", token=admin_token)
                self.assertTrue(before_secret == after_secret, "client secret or secret metadata changed")
                verify_client_credentials()
                ignored = {"redirectUris", "webOrigins", "attributes"}
                changed = sorted(key for key in set(before) | set(after) if key not in ignored and before.get(key) != after.get(key))
                self.assertEqual(changed, [], "unrelated client settings changed")
                before_attrs, after_attrs = dict(before.get("attributes") or {}), dict(after.get("attributes") or {})
                before_attrs.pop("post.logout.redirect.uris", None)
                after_attrs.pop("post.logout.redirect.uris", None)
                self.assertEqual(sorted(key for key in set(before_attrs) | set(after_attrs) if before_attrs.get(key) != after_attrs.get(key)), [], "unrelated client attributes changed")
            finally:
                subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, check=False, timeout=30)
                remaining = subprocess.check_output(["docker", "ps", "-aq", "--filter", f"name=^/{name}$"],
                                                    text=True, timeout=30).strip()
                if remaining:
                    raise RuntimeError("isolated Keycloak test container cleanup was not verified")


if __name__ == "__main__":
    unittest.main()
