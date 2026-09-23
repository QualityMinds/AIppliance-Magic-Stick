# SPDX-License-Identifier: BUSL-1.1
"""Exercise the HTTP boundary, not only the standalone license service."""
import io
import json
from pathlib import Path
import sys
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from test_dashboard_api import load_server

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "dashboard/apps/api"))
from licensing import FORMAT, TOKEN_TYPE, LicenseService, public_keys


class LicenseHttpTests(unittest.TestCase):
    def setUp(self):
        self.api = load_server()
        self.handler = self.api["Handler"].__new__(self.api["Handler"])
        self.handler.path = "/api/license/request"
        self.handler.headers = {}
        self.handler.require_access = Mock(return_value={"roles": ["magicstick-admin"]})
        self.handler.send_json = Mock()
        self.handler.send_response = Mock()
        self.handler.send_header = Mock()
        self.handler.end_headers = Mock()
        self.csrf = Mock()
        self.api["validate_dashboard_mutation_request"] = self.csrf
        self.service = LicenseService(Mock(), "identity-system", "/unused-public-trust.json")
        self.installation = "11111111-1111-4111-8111-111111111111"
        self.service.state = Mock(return_value=({"metadata": {"resourceVersion": "1"}}, {}, self.installation))
        self.api["license_service"] = lambda: self.service

    def body(self, payload):
        content = json.dumps(payload).encode()
        self.handler.rfile = io.BytesIO(content)
        self.handler.headers = {"Content-Length": str(len(content)), "Content-Type": "application/json"}

    def request_payload(self, edition="free-registered"):
        features = ["federated-sso"] if edition == "free-registered" else ["commercial-production", "federated-sso"]
        return {"customer": "Example organization", "edition": edition, "features": features, "ttlSeconds": 3600}

    def test_http_request_accepts_both_editions_and_keeps_entitlements_unsigned(self):
        for edition in ("free-registered", "commercial"):
            with self.subTest(edition=edition):
                self.body(self.request_payload(edition))
                self.handler.do_POST()
                result = self.handler.send_json.call_args.args[0]
                claims = json.loads(result["content"])
                self.assertEqual(claims["edition"], edition)
                self.assertEqual(claims["features"], self.request_payload(edition)["features"])
                self.assertEqual(claims["installationId"], self.installation)
                self.assertNotIn("token", claims)
                self.service.request.assert_not_called()
        self.assertEqual(self.handler.require_access.call_count, 2)
        self.handler.require_access.assert_called_with("admin")
        self.assertEqual(self.csrf.call_count, 2)

    def test_http_request_rejects_unknown_fields_before_storage(self):
        self.body({**self.request_payload(), "untrusted": True})
        self.handler.do_POST()
        self.assertEqual(self.handler.send_json.call_args.args[1], 400)
        self.service.state.assert_not_called()

    def test_http_request_rejects_missing_or_inconsistent_edition(self):
        payloads = [self.request_payload(), {**self.request_payload(), "edition": "commercial"}]
        del payloads[0]["edition"]
        for payload in payloads:
            self.body(payload)
            self.handler.do_POST()
            self.assertEqual(self.handler.send_json.call_args.args[1], 400)
        self.service.state.assert_not_called()

    def test_http_request_enforces_admin_and_csrf_before_reading_body(self):
        self.body(self.request_payload())
        self.handler.require_access.side_effect = self.api["AuthError"](403, "Denied")
        self.handler.do_POST()
        self.assertEqual(self.handler.send_json.call_args.args[1], 403)
        self.csrf.assert_not_called()
        self.handler.require_access.side_effect = None
        self.csrf.side_effect = self.api["RequestError"](403, "Invalid origin")
        self.handler.do_POST()
        self.assertEqual(self.handler.send_json.call_args.args[1], 403)
        self.assertEqual(self.handler.rfile.tell(), 0)
        self.service.state.assert_not_called()

    def signed_state(self, *, expired=False, tampered=False, bound=True):
        key = Ed25519PrivateKey.generate()
        pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        self.service.keys = lambda: public_keys({"keys": {"test": pem}})
        now = int(time.time())
        claims = {"version": 1, "product": "magicstick", "issuer": "magicstick",
                  "licenseId": "example-license", "customer": "Example organization",
                  "edition": "free-registered", "features": ["federated-sso"],
                  "issuedAt": now - 7200, "notBefore": now - 7200,
                  "expiresAt": now - 60 if expired else now + 3600,
                  "installationId": self.installation if bound else "22222222-2222-4222-8222-222222222222"}
        signer = Ed25519PrivateKey.generate() if tampered else key
        token = jwt.encode(claims, signer, algorithm="EdDSA", headers={"typ": TOKEN_TYPE, "kid": "test"})
        self.service.state.return_value = ({"metadata": {"resourceVersion": "1"}},
                                          {"license.json": json.dumps({"format": FORMAT, "token": token})}, self.installation)

    def broker_path(self):
        self.handler.path = "/internal/federation-license/realms/magicstick/broker/company/endpoint?code=private-callback-code"

    def test_edge_allows_valid_signed_entitlement_for_every_callback_method(self):
        self.signed_state()
        self.broker_path()
        with patch("licensing.installed_capabilities", return_value={"federated-sso"}):
            for method in ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
                getattr(self.handler, "do_" + method)()
                self.handler.send_response.assert_called_with(200)
        self.assertEqual(self.handler.send_response.call_count, 7)
        self.handler.send_header.assert_any_call("Cache-Control", "no-store")
        self.handler.require_access.assert_not_called()
        self.handler.send_json.assert_not_called()

    def test_edge_denies_missing_expired_tampered_or_wrong_installation(self):
        self.broker_path()
        with patch("licensing.installed_capabilities", return_value={"federated-sso"}):
            self.handler.do_GET()
            self.assertEqual(self.handler.send_json.call_args.args[1], 403)
            for options in ({"expired": True}, {"tampered": True}, {"bound": False}):
                self.signed_state(**options)
                self.handler.do_GET()
                self.assertEqual(self.handler.send_json.call_args.args[1], 403)
        self.handler.send_response.assert_not_called()

    def test_edge_denies_missing_implementation_or_verification_outage(self):
        self.signed_state()
        self.broker_path()
        with patch("licensing.installed_capabilities", return_value=set()):
            self.handler.do_GET()
            self.assertEqual(self.handler.send_json.call_args.args[1], 403)
        self.service.state.side_effect = OSError("sensitive upstream failure details")
        self.handler.do_POST()
        self.assertEqual(self.handler.send_json.call_args.args[1], 403)
        self.assertNotIn("sensitive", repr(self.handler.send_json.call_args))
        self.handler.send_response.assert_not_called()

    def test_edge_does_not_cache_a_previously_valid_decision(self):
        self.signed_state()
        self.broker_path()
        with patch("licensing.installed_capabilities", return_value={"federated-sso"}):
            self.handler.do_GET()
            self.handler.send_response.assert_called_once_with(200)
            self.service.state.side_effect = TimeoutError()
            self.handler.do_GET()
            self.assertEqual(self.handler.send_json.call_args.args[1], 403)
            self.handler.send_response.assert_called_once_with(200)

    def test_edge_does_not_guard_local_login_recovery_or_core_endpoints(self):
        for path in ("/healthz", "/api/session", "/realms/magicstick/protocol/openid-connect/auth",
                     "/realms/magicstick/login-actions/reset-credentials", "/internal/federation-license-spoof"):
            self.handler.path = path
            self.assertFalse(self.handler.handle_edge_guard())
        self.service.state.assert_not_called()

    def test_edge_callback_codes_are_not_logged(self):
        self.broker_path()
        output = io.StringIO()
        with redirect_stdout(output):
            self.handler.log_message('"%s"', self.handler.path)
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
