#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Opt-in Rancher test: real Keycloak, Envoy, API and Kubernetes storage.

Build magicstick-api:sharing-test from the repository root first. Uses only
rancher-desktop, a random namespace/class/release and ephemeral identities/keys.
Existing CRDs are never replaced; newly created test CRDs are removed on exit.
No passwords, tokens, private keys or license documents are printed.
"""
import datetime
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import jwt
import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.x509.oid import NameOID
from licensing import FORMAT, TOKEN_TYPE

ROOT = Path(__file__).resolve().parents[3]
CONTEXT = "rancher-desktop"


def run(args, document=None):
    result = subprocess.run(args, input=document, text=True, capture_output=True)
    if result.returncode:
        # Never include a resource/Secret document in an error.
        raise RuntimeError(f"{args[0]} failed: {result.stderr[:700]}")
    return result.stdout


def k(*args, document=None):
    return run(["kubectl", "--context", CONTEXT, *args], document)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def until(check, description, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, RuntimeError, KeyError):
            pass
        time.sleep(1)
    raise RuntimeError("Timed out: " + description)


def main():
    ns = "magicstick-sharing-test-" + uuid.uuid4().hex[:8]
    created_crds, processes = [], []
    helm_installed = False
    existing = {item["metadata"]["name"] for item in json.loads(k("get", "crd", "-o", "json"))["items"]}
    kc_port, api_port, edge_port = port(), port(), port()
    issuer_base = f"http://127.0.0.1:{kc_port}"
    issuer = issuer_base + "/realms/sharing-test"
    kc_internal = f"http://keycloak.{ns}.svc.cluster.local:8080"
    edge = f"https://localhost:{edge_port}"
    tls_context = ssl._create_unverified_context()  # Ephemeral loopback certificate only.

    def obj(kind, name, **kwargs):
        return {"apiVersion": "v1", "kind": kind, "metadata": {"name": name, "namespace": ns}, **kwargs}

    def apply(*objects):
        k("apply", "--server-side", "--field-manager=magicstick-sharing-test", "-f", "-", document=yaml.safe_dump_all(objects))

    def forward(target, local, remote):
        process = subprocess.Popen(["kubectl", "--context", CONTEXT, "-n", ns, "port-forward", "--address=127.0.0.1", target, f"{local}:{remote}"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        processes.append(process)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Port-forward {target} stopped: {process.communicate()[0][:500]}")
            try:
                with socket.create_connection(("127.0.0.1", local), timeout=1):
                    return process
            except OSError:
                time.sleep(.5)
        raise RuntimeError(f"Port-forward {target} did not start")

    def request(url, method="GET", body=None, headers=None):
        headers = headers or {}
        if isinstance(body, dict):
            headers = {"Content-Type": "application/json", **headers}
            body = json.dumps(body).encode()
        try:
            response = urllib.request.urlopen(urllib.request.Request(url, method=method, data=body, headers=headers), context=tls_context, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        return response.status, response.read()

    def deployment(name, container, volumes=None, service_account=None):
        pod = {"containers": [container], "volumes": volumes or []}
        if service_account:
            pod["serviceAccountName"] = service_account
        return {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name, "namespace": ns},
                "spec": {"replicas": 1, "selector": {"matchLabels": {"app": name}}, "template": {"metadata": {"labels": {"app": name}}, "spec": pod}}}

    def service(name, target=8080):
        return obj("Service", name, spec={"selector": {"app": name}, "ports": [{"port": target, "targetPort": target}]})

    try:
        k("create", "namespace", ns)
        print("Isolated Rancher namespace:", ns, flush=True)
        chart = run(["helm", "template", ns, "oci://docker.io/envoyproxy/gateway-helm", "--version", "v1.8.2", "--namespace", ns, "--include-crds"])
        crds = [item for item in yaml.safe_load_all(chart) if item and item.get("kind") == "CustomResourceDefinition"]
        crds.append(yaml.safe_load((ROOT / "magic-cluster/platform/magicstick-operator/crds/appinstances.appliance.magicstick.dev.yaml").read_text()))
        for crd in crds:
            name = crd["metadata"]["name"]
            if name not in existing:
                k("create", "-f", "-", document=yaml.safe_dump(crd))
                created_crds.append(name)
        for name in created_crds:
            k("wait", "--for=condition=Established", "crd/" + name, "--timeout=30s")
        helm_installed = True
        run(["helm", "--kube-context", CONTEXT, "install", ns, "oci://docker.io/envoyproxy/gateway-helm", "--version", "v1.8.2", "-n", ns, "--set", "crds.enabled=false", "--wait=legacy", "--timeout", "4m"])
        print("Envoy Gateway ready; pre-existing Gateway API CRDs preserved.", flush=True)

        password, client_secret, gateway_secret = secrets.token_urlsafe(24), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        ids = {name: str(uuid.uuid4()) for name in ("alice", "bob", "carol", "admin", "team", "child")}
        realm = {"realm": "sharing-test", "enabled": True, "sslRequired": "none", "registrationAllowed": False,
                 "roles": {"realm": [{"name": "magicstick-" + role} for role in ("user", "viewer", "operator", "admin")]},
                 "groups": [{"id": ids["team"], "name": "Team", "subGroups": [{"id": ids["child"], "name": "Child"}]}],
                 "clients": [{"clientId": "magicstick-cli", "publicClient": True, "directAccessGrantsEnabled": True, "defaultClientScopes": ["roles", "profile", "email"]},
                             {"clientId": "sharing-admin", "secret": client_secret, "serviceAccountsEnabled": True, "defaultClientScopes": ["roles"]},
                             {"clientId": "magicstick-human-gateway-local", "secret": gateway_secret, "standardFlowEnabled": True, "redirectUris": [edge + "/oauth2/callback"], "defaultClientScopes": ["roles", "profile", "email"]}],
                 "users": [{"id": ids[name], "username": name, "enabled": True, "email": name + "@example.com", "emailVerified": True,
                            "firstName": name, "lastName": "Example", "credentials": [{"type": "password", "value": password, "temporary": False}],
                            "realmRoles": ["magicstick-admin" if name == "admin" else "magicstick-viewer"], "groups": ["/Team/Child"] if name == "bob" else []} for name in ("alice", "bob", "carol", "admin")]}
        realm["users"].append({"username": "service-account-sharing-admin", "enabled": True, "serviceAccountClientId": "sharing-admin", "clientRoles": {"realm-management": ["view-users", "query-users", "query-groups", "view-realm", "manage-users"]}})
        apply(obj("Secret", "test-realm", stringData={"sharing-test-realm.json": json.dumps(realm)}),
              obj("Secret", "magicstick-user-admin-client", stringData={"client-id": "sharing-admin", "client-secret": client_secret}),
              obj("Secret", "magicstick-human-gateway-client", stringData={"client-secret": gateway_secret}),
              deployment("keycloak", {"name": "keycloak", "image": "quay.io/keycloak/keycloak:26.6.3", "args": ["start-dev", "--import-realm"],
                  "env": [{"name": "KC_HOSTNAME", "value": issuer_base}], "ports": [{"containerPort": 8080}],
                  "resources": {"requests": {"cpu": "250m", "memory": "512Mi"}, "limits": {"memory": "1536Mi"}},
                  "readinessProbe": {"httpGet": {"path": "/realms/sharing-test", "port": 8080}, "periodSeconds": 2},
                  "volumeMounts": [{"name": "realm", "mountPath": "/opt/keycloak/data/import", "readOnly": True}]}, [{"name": "realm", "secret": {"secretName": "test-realm"}}]), service("keycloak"))
        k("-n", ns, "rollout", "status", "deployment/keycloak", "--timeout=180s")
        forward("service/keycloak", kc_port, 8080)
        until(lambda: request(issuer)[0] == 200, "Keycloak port-forward")
        tokens = {}
        for name in ("alice", "bob", "carol", "admin"):
            code, raw = request(issuer + "/protocol/openid-connect/token", "POST", urllib.parse.urlencode({"client_id": "magicstick-cli", "grant_type": "password", "username": name, "password": password, "scope": "openid profile"}).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
            assert code == 200, f"Keycloak login failed for test identity ({code})"
            tokens[name] = json.loads(raw)["access_token"]
        print("Real Keycloak users and nested-group membership ready.", flush=True)

        key = ed25519.Ed25519PrivateKey.generate()
        pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        manifest = yaml.safe_load((ROOT / "magic-cluster/apps/dashboard/dashboard-api.yaml").read_text())
        manifest["metadata"]["namespace"] = ns
        env = {"APPLIANCE_NAMESPACE": ns, "APP_CATALOG_NAMESPACE": ns, "LICENSE_NAMESPACE": ns, "LICENSE_TRUST_STORE": "/trust/trusted-keys.json",
               "OIDC_USERINFO_URL": kc_internal + "/realms/sharing-test/protocol/openid-connect/userinfo", "OIDC_EXPECTED_ISSUER": issuer,
               "IDENTITY_MANAGEMENT_MODE": "keycloak", "KEYCLOAK_ADMIN_URL": kc_internal, "KEYCLOAK_REALM": "sharing-test", "KEYCLOAK_USER_ADMIN_SECRET_NAMESPACE": ns}
        api = deployment("ai-appliance-dashboard-api", {"name": "api", "image": "magicstick-api:sharing-test", "imagePullPolicy": "Never", "command": ["python", "/app/server.py"],
            "env": [{"name": name, "value": value} for name, value in env.items()], "readinessProbe": {"httpGet": {"path": "/healthz", "port": 8080}, "periodSeconds": 2},
            "volumeMounts": [{"name": "api", "mountPath": "/app"}, {"name": "trust", "mountPath": "/trust"}]},
            [{"name": "api", "configMap": {"name": manifest["metadata"]["name"]}}, {"name": "trust", "configMap": {"name": "test-trust"}}], "sharing-api")
        role = {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role", "metadata": {"name": "sharing-api", "namespace": ns}, "rules": [
            {"apiGroups": [""], "resources": ["secrets", "configmaps"], "verbs": ["get", "create", "update"]},
            {"apiGroups": ["appliance.magicstick.dev"], "resources": ["appinstances"], "verbs": ["get", "list", "create", "update", "patch"]}]}
        binding = {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": {"name": "sharing-api", "namespace": ns}, "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "sharing-api"}, "subjects": [{"kind": "ServiceAccount", "name": "sharing-api", "namespace": ns}]}
        apply(manifest, obj("ConfigMap", "test-trust", data={"trusted-keys.json": json.dumps({"keys": {"test": pem}})}), obj("ServiceAccount", "sharing-api"), role, binding, api, service("ai-appliance-dashboard-api"))
        k("-n", ns, "rollout", "status", "deployment/ai-appliance-dashboard-api", "--timeout=60s")
        forward("service/ai-appliance-dashboard-api", api_port, 8080)
        api_url = f"http://127.0.0.1:{api_port}"
        until(lambda: request(api_url + "/healthz")[0] == 200, "API port-forward")

        def api_request(path, name="admin", method="GET", body=None, expected=200):
            code, raw = request(api_url + path, method, body, {"Authorization": "Bearer " + tokens[name], "X-MagicStick-CSRF": "dashboard"})
            assert code == expected, f"API {method} {path}: {code} != {expected}: {raw[:200]!r}"
            return json.loads(raw)

        current = api_request("/api/license")
        now = int(time.time())
        claims = {"version": 1, "product": "magicstick", "issuer": "magicstick", "licenseId": "test-only", "customer": "Example", "issuedAt": now - 1, "notBefore": now - 1, "expiresAt": now + 1800, "features": ["resource-sharing"], "installationId": current["installationId"]}
        document = json.dumps({"format": FORMAT, "token": jwt.encode(claims, key, algorithm="EdDSA", headers={"typ": TOKEN_TYPE, "kid": "test"})})
        activated = api_request("/api/license", method="PUT", body={"document": document, "expectedRevision": current["revision"]})
        assert next(f for f in activated["features"] if f["id"] == "resource-sharing")["available"]
        resource = {"apiVersion": "appliance.magicstick.dev/v1alpha1", "kind": "AppInstance", "metadata": {"name": "hermes-private", "namespace": ns}, "spec": {"application": "hermes", "targetNamespace": ns, "enabled": True, "values": {"name": "private"}, "access": {"authentication": "sso", "role": "user", "exposure": "local", "sharing": {"mode": "selected", "users": [ids["alice"]], "groups": [ids["team"]]}}}}
        apply(resource)
        resource = json.loads(k("-n", ns, "get", "appinstance/hermes-private", "-o", "json"))
        for name, visible in (("alice", True), ("bob", True), ("carol", False)):
            assert bool(api_request("/api/my-instances", name)["items"]) == visible
        assert api_request("/api/instance-principals?kind=groups")["items"]
        print("Signed entitlement, user/group filtering and identity directory passed.", flush=True)

        # A real Gateway/EnvoyProxy with the production filter ordering and policy.
        tls_key = ec.generate_private_key(ec.SECP256R1())
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
        cert = x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(tls_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False).sign(tls_key, hashes.SHA256())
        proxy = next(yaml.safe_load_all((ROOT / "magic-cluster/platform/identity/gateway.yaml").read_text()))
        proxy["metadata"] = {"name": "sharing-test", "namespace": ns}
        proxy["spec"]["provider"]["kubernetes"]["envoyService"]["type"] = "ClusterIP"
        gwclass = {"apiVersion": "gateway.networking.k8s.io/v1", "kind": "GatewayClass", "metadata": {"name": ns}, "spec": {"controllerName": "gateway.envoyproxy.io/gatewayclass-controller"}}
        gateway = {"apiVersion": "gateway.networking.k8s.io/v1", "kind": "Gateway", "metadata": {"name": "sharing-test", "namespace": ns}, "spec": {"gatewayClassName": ns, "infrastructure": {"parametersRef": {"group": "gateway.envoyproxy.io", "kind": "EnvoyProxy", "name": "sharing-test"}}, "listeners": [{"name": "https", "port": 8443, "protocol": "HTTPS", "tls": {"mode": "Terminate", "certificateRefs": [{"name": "test-tls"}]}}]}}
        route = {"apiVersion": "gateway.networking.k8s.io/v1", "kind": "HTTPRoute", "metadata": {"name": "private", "namespace": ns}, "spec": {"parentRefs": [{"name": "sharing-test"}], "rules": [{"backendRefs": [{"name": "echo", "port": 8080}]}]}}
        controller_code = yaml.safe_load((ROOT / "magic-cluster/platform/magicstick-operator/controller-configmap.yaml").read_text())["data"]["controller.py"].replace("SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)", "SSL_CONTEXT = None")
        controller = {"__name__": "test_controller"}
        exec(compile(controller_code, "controller.py", "exec"), controller)
        controller["mdns_domain"] = lambda: "example.local"
        policy = controller["app_instance_security_policy"](resource, "private", ["private"], edge + "/oauth2/callback", "localhost", "user")
        policy["metadata"]["namespace"] = ns
        oidc = policy["spec"]["oidc"]
        oidc["provider"] = {"issuer": issuer, "authorizationEndpoint": issuer + "/protocol/openid-connect/auth", "tokenEndpoint": kc_internal + "/realms/sharing-test/protocol/openid-connect/token"}
        provider = policy["spec"]["jwt"]["providers"][0]
        provider["issuer"] = issuer
        provider["remoteJWKS"]["uri"] = kc_internal + "/realms/sharing-test/protocol/openid-connect/certs"
        echo_code = "from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'APP_OK')\n def log_message(self,*args):pass\nHTTPServer(('0.0.0.0',8080),H).serve_forever()"
        apply(obj("Secret", "test-tls", type="kubernetes.io/tls", stringData={"tls.crt": cert.public_bytes(serialization.Encoding.PEM).decode(), "tls.key": tls_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}), proxy, gwclass, gateway,
              deployment("echo", {"name": "echo", "image": "magicstick-api:sharing-test", "imagePullPolicy": "Never", "command": ["python", "-c", echo_code]}), service("echo"), route, policy)
        k("-n", ns, "rollout", "status", "deployment/echo", "--timeout=60s")
        def envoy_service():
            items = json.loads(k("-n", ns, "get", "svc", "-l", "gateway.envoyproxy.io/owning-gateway-name=sharing-test", "-o", "json"))["items"]
            return items[0]["metadata"]["name"] if items else None
        envoy_name = until(envoy_service, "Envoy service")
        k("-n", ns, "wait", "gateway/sharing-test", "--for=condition=Programmed", "--timeout=90s")
        k("-n", ns, "wait", "pods", "-l", "gateway.envoyproxy.io/owning-gateway-name=sharing-test", "--for=condition=Ready", "--timeout=90s")
        forward("service/" + envoy_name, edge_port, 8443)
        # OAuth2 cookies are encrypted by Envoy. Log in through the real browser;
        # a raw access token placed in a cookie is intentionally not a session.
        def login_ready():
            code, _ = request(edge + "/")
            if code not in (200, 503):
                raise AssertionError(f"Envoy unauthenticated login returned HTTP {code}")
            return code == 200
        until(login_ready, "Envoy login redirect", seconds=90)
        cookies = json.loads(run(["node", str(Path(__file__).with_name("rancher_sharing_login.cjs"))],
                                 json.dumps({"base": edge, "password": password, "names": ["alice", "bob", "carol", "admin"]})))
        print("Real Chrome OIDC logins completed; session cookies kept in memory only.", flush=True)
        def edge_request(name):
            return request(edge + "/", headers={"Cookie": cookies[name]})
        until(lambda: edge_request("alice") == (200, b"APP_OK"), "Allowed user through real Envoy", seconds=180)
        for name, expected in (("alice", 200), ("bob", 200), ("carol", 403), ("admin", 403)):
            code, _ = edge_request(name)
            assert code == expected, f"Envoy {name}: {code} != {expected}"
        print("Real Envoy: direct user and nested group allowed; nonmember/admin denied.", flush=True)

        # API CAS update changes authorization without waiting for route reconciliation.
        k("-n", ns, "patch", "appinstance/hermes-private", "--subresource=status", "--type=merge", "-p", json.dumps({"status": {"accessGuardReady": True}}))
        state = api_request("/api/instances/hermes-private/access")
        api_request("/api/instances/hermes-private/access", method="PUT", body={"sharing": {"mode": "selected", "users": [ids["carol"]], "groups": []}, "expectedRevision": state["revision"]})
        assert edge_request("alice")[0] == 403
        assert edge_request("bob")[0] == 403
        assert edge_request("carol")[0] == 200
        api_request("/api/instances/hermes-private/access", method="PUT", body={"sharing": {"mode": "all"}, "expectedRevision": state["revision"]}, expected=409)
        # Trust revocation closes the application immediately and preserves its policy.
        apply(obj("ConfigMap", "test-trust", data={"trusted-keys.json": '{"keys":{}}'}))
        until(lambda: edge_request("carol")[0] == 403, "Revoked trust blocks restricted app", seconds=150)
        assert json.loads(k("-n", ns, "get", "appinstance/hermes-private", "-o", "json"))["spec"]["access"]["sharing"]["mode"] == "selected"
        print("CAS changes, immediate ACL enforcement and fail-closed trust revocation passed.", flush=True)
        print("RANCHER SHARING TEST PASSED", flush=True)
    except Exception as error:
        print("Integration test failed:", str(error), flush=True)
        for kind in ("securitypolicy", "envoyproxy", "gateway"):
            try:
                values = json.loads(k("-n", ns, "get", kind, "-o", "json"))["items"]
                for value in values:
                    print(kind, value["metadata"]["name"], json.dumps(value.get("status", {})), flush=True)
            except Exception:
                pass
        try:
            print(k("-n", ns, "get", "pods"), flush=True)
            logs = k("-n", ns, "logs", "-l", "gateway.envoyproxy.io/owning-gateway-name=sharing-test", "-c", "envoy", "--tail=15")
            for line in logs.splitlines():
                try:
                    record = json.loads(line)
                    print("Envoy response:", record.get("response_code"), record.get("response_code_details"), flush=True)
                except ValueError:
                    pass  # Native filter errors may contain credential material.
        except Exception:
            pass
        raise
    finally:
        for process in processes:
            process.terminate()
            process.wait(timeout=10)
        k("-n", ns, "delete", "gateway", "sharing-test", "--wait=false", "--ignore-not-found")
        k("delete", "gatewayclass", ns, "--wait=false", "--ignore-not-found")
        if helm_installed:
            if k("get", "gatewayclass", ns, "--ignore-not-found", "-o", "name").strip():
                k("wait", "--for=delete", "gatewayclass/" + ns, "--timeout=30s")
            run(["helm", "--kube-context", CONTEXT, "uninstall", ns, "-n", ns])
        # Keep API discovery stable until the namespace controller has finished.
        # Removing its CRDs concurrently can strand an otherwise empty namespace.
        k("delete", "namespace", ns, "--wait=true", "--timeout=60s", "--ignore-not-found")
        for name in reversed(created_crds):
            k("delete", "crd", name, "--wait=false")
        print("Removed isolated test resources; original CRDs preserved.", flush=True)


if __name__ == "__main__":
    main()
