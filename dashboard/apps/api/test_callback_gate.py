# SPDX-License-Identifier: BUSL-1.1
"""Protocol/negative checks for the pre-OIDC callback gate."""
import unittest
import datetime
import tempfile
from concurrent import futures
from pathlib import Path

import grpc
import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from envoy.config.core.v3 import base_pb2
from envoy.service.ext_proc.v3 import external_processor_pb2 as messages
from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as service

import callback_gate


class CallbackGateTests(unittest.TestCase):
    def request(self, host="demo.example.local", secret="synthetic-private"):
        headers = base_pb2.HeaderMap(headers=[
            base_pb2.HeaderValue(key=":authority", value=host),
            base_pb2.HeaderValue(key="cookie", value=secret),
            base_pb2.HeaderValue(key="authorization", value=secret),
        ])
        return messages.ProcessingRequest(request_headers=messages.HttpHeaders(headers=headers))

    def test_success_and_failure_do_not_expose_credentials(self):
        seen = []
        gate = callback_gate.Gate(lambda host: seen.append(host) or True)
        result = next(gate.Process(iter([self.request()]), None))
        self.assertTrue(result.HasField("request_headers"))
        self.assertEqual(seen, ["demo.example.local"])
        self.assertNotIn("synthetic-private", str(result))
        failed = next(callback_gate.Gate(lambda _: False).Process(iter([self.request()]), None))
        self.assertEqual(failed.immediate_response.status.code, 503)
        self.assertNotIn("synthetic-private", str(failed))

    def test_missing_or_duplicate_authority_fails_closed(self):
        no_headers = messages.ProcessingRequest(request_headers=messages.HttpHeaders())
        request = self.request()
        request.request_headers.headers.headers.add(key=":authority", value="other.example.local")
        gate = callback_gate.Gate(lambda _: self.fail("untrusted authority used"))
        for item in (no_headers, request):
            self.assertEqual(next(gate.Process(iter([item]), None)).immediate_response.status.code, 503)

    def test_real_grpc_stream(self):
        server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
        service.add_ExternalProcessorServicer_to_server(callback_gate.Gate(lambda _: True), server)
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        self.addCleanup(lambda: server.stop(0).wait())
        with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
            result = list(service.ExternalProcessorStub(channel).Process(iter([self.request()]), timeout=3))
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0].HasField("request_headers"))

    def test_static_policies_are_fail_closed_and_keep_cookie_migration(self):
        root = Path(__file__).resolve().parents[3]
        paths = ["magic-cluster/platform/identity/callback-gate-policy.yaml",
                 "magic-cluster/apps/dashboard/callback-gate-policy.yaml",
                 "magic-cluster/apps/ai/anything-llm/base/callback-gate-policy.yaml",
                 "magic-cluster/apps/ai/kubeopencode/base/callback-gate-policy.yaml",
                 "magic-cluster/apps/ai/litellm/base/callback-gate-policy.yaml"]
        for path in paths:
            with self.subTest(path=path):
                spec = yaml.safe_load((root / path).read_text())["spec"]
                self.assertEqual(spec["lua"][0]["valueRef"]["name"], "magicstick-cookie-migration")
                processor = spec["extProc"][0]
                self.assertFalse(processor["failOpen"])
                self.assertEqual(processor["backendRefs"], [{"group": "gateway.envoyproxy.io", "kind": "Backend", "name": "magicstick-callback-gate"}])
                self.assertEqual(processor["processingMode"], {"request": {}})

    def test_grpc_ingress_is_limited_to_gateway_namespace(self):
        root = Path(__file__).resolve().parents[3]
        policy = yaml.safe_load((root / "magic-cluster/apps/dashboard/callback-gate-network-policy.yaml").read_text())
        grpc_rules = [rule for rule in policy["spec"]["ingress"] if any(port["port"] == 8081 for port in rule["ports"])]
        self.assertEqual(len(grpc_rules), 1)
        self.assertEqual(grpc_rules[0]["from"][0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"], "envoy-gateway-system")

    def test_tls_bootstrap_does_not_make_setup_depend_on_leaf_secret(self):
        root = Path(__file__).resolve().parents[3]
        docs = list(yaml.safe_load_all((root / "magic-cluster/platform/identity/setup-app.yaml").read_text()))
        setup = next(doc for doc in docs if doc["kind"] == "Deployment")
        setup_volumes = setup["spec"]["template"]["spec"]["volumes"]
        public_ca = next(v for v in setup_volumes if v["name"] == "callback-gate-ca")["secret"]
        self.assertTrue(public_ca["optional"])
        self.assertEqual([item["key"] for item in public_ca["items"]], ["ca.crt"])
        api = yaml.safe_load((root / "magic-cluster/apps/dashboard/api-deployment.yaml").read_text())
        leaf = next(v for v in api["spec"]["template"]["spec"]["volumes"] if v["name"] == "callback-gate-tls")["secret"]
        self.assertEqual(leaf["secretName"], public_ca["secretName"])
        self.assertFalse(leaf.get("optional", False))
        self.assertIn("magicstick-callback-gate-tls", api["metadata"]["annotations"]["secret.reloader.stakater.com/reload"])

    def test_backend_tls_is_inline_and_admission_precedes_feature_enablement(self):
        root = Path(__file__).resolve().parents[3]
        docs = list(yaml.safe_load_all((root / "magic-cluster/platform/identity/callback-gate-tls.yaml").read_text()))
        backend = next(doc for doc in docs if doc["kind"] == "Backend")
        hostname = "magicstick-callback-gate.identity-system.svc.cluster.local"
        self.assertEqual(backend["spec"]["endpoints"], [{"fqdn": {"hostname": hostname, "port": 8081}}])
        self.assertEqual(backend["spec"]["tls"], {"caCertificateRefs": [{"group": "", "kind": "ConfigMap", "name": "magicstick-callback-gate-ca"}], "sni": hostname, "insecureSkipVerify": False})
        self.assertFalse(any(doc["kind"] == "BackendTLSPolicy" for doc in docs))
        gateway = yaml.safe_load((root / "magic-cluster/platform/gateway/envoy-gateway/helmrelease.yaml").read_text())
        self.assertFalse(gateway["spec"]["values"]["config"]["envoyGateway"]["extensionApis"]["enableBackend"])
        ordering = yaml.safe_load((root / "magic-cluster/flux/graph/base/05-envoy-gateway.yaml").read_text())
        self.assertIn({"name": "callback-backend-admission"}, ordering["spec"]["dependsOn"])
        admission = list(yaml.safe_load_all((root / "magic-cluster/platform/gateway/callback-backend-admission/policy.yaml").read_text()))
        policies = [doc for doc in admission if doc["kind"] == "ValidatingAdmissionPolicy"]
        bindings = [doc for doc in admission if doc["kind"] == "ValidatingAdmissionPolicyBinding"]
        self.assertEqual(len(policies), 3)
        self.assertEqual(len(bindings), 3)
        self.assertTrue(all(policy["spec"]["failurePolicy"] == "Fail" for policy in policies))
        self.assertTrue(all(binding["spec"]["validationActions"] == ["Deny"] for binding in bindings))
        for manifest in ("magic-cluster/platform/identity/setup-rbac.yaml", "magic-cluster/platform/magicstick-operator/rbac.yaml"):
            for doc in yaml.safe_load_all((root / manifest).read_text()):
                for rule in (doc or {}).get("rules", []):
                    if "gateway.envoyproxy.io" in rule.get("apiGroups", []):
                        self.assertNotIn("backends", rule.get("resources", []))

    def test_production_server_requires_tls_and_verifies_peer_name_ca_and_expiry(self):
        utc = datetime.timezone.utc
        now = datetime.datetime.now(utc)
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic test CA")])
        ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
              .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
              .not_valid_before(now - datetime.timedelta(days=2)).not_valid_after(now + datetime.timedelta(days=2))
              .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
              .sign(ca_key, hashes.SHA256()))
        cert_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = "magicstick-callback-gate.identity-system.svc.cluster.local"
        def leaf(expired=False):
            return (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
                    .issuer_name(ca_name).public_key(cert_key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(now - datetime.timedelta(days=2))
                    .not_valid_after(now - datetime.timedelta(days=1) if expired else now + datetime.timedelta(days=1))
                    .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
                    .sign(ca_key, hashes.SHA256()))
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "tls.key").write_bytes(cert_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            def check(expired, target, root, succeeds):
                (directory / "tls.crt").write_bytes(leaf(expired).public_bytes(serialization.Encoding.PEM))
                # OS allocates a port for this synthetic loopback-only test.
                import socket
                with socket.socket() as sock:
                    sock.bind(("127.0.0.1", 0))
                    port = sock.getsockname()[1]
                server = callback_gate.start(port, str(directory))
                try:
                    with grpc.secure_channel(f"127.0.0.1:{port}", grpc.ssl_channel_credentials(root),
                                             options=(("grpc.ssl_target_name_override", target),)) as channel:
                        if succeeds:
                            grpc.channel_ready_future(channel).result(timeout=3)
                        else:
                            with self.assertRaises(grpc.FutureTimeoutError):
                                grpc.channel_ready_future(channel).result(timeout=1)
                    with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
                        with self.assertRaises(grpc.FutureTimeoutError):
                            grpc.channel_ready_future(channel).result(timeout=1)
                finally:
                    server.stop(0).wait()
            ca_pem = ca.public_bytes(serialization.Encoding.PEM)
            check(False, name, ca_pem, True)
            check(False, "wrong.example", ca_pem, False)
            wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            wrong_ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
                        .public_key(wrong_key.public_key()).serial_number(x509.random_serial_number())
                        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
                        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                        .sign(wrong_key, hashes.SHA256())).public_bytes(serialization.Encoding.PEM)
            check(False, name, wrong_ca, False)
            check(True, name, ca_pem, False)


if __name__ == "__main__":
    unittest.main()
