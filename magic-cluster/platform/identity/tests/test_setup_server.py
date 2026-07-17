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
