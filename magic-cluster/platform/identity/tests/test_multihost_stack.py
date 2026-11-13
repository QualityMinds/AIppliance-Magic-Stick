# SPDX-License-Identifier: BUSL-1.1
"""Disposable TLS Keycloak/Envoy/real dashboard guard for browser acceptance.

Run ``python test_multihost_stack.py serve``. A single JSON line on stdout
provides the Docker network and public CA path; send SIGTERM to clean up. All
identities, credentials, hostnames and generated secrets are synthetic.
"""
import json
import copy
import collections
import os
import re
from pathlib import Path
import secrets
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid

import yaml

ROOT = Path(__file__).resolve().parents[3]
KEYCLOAK = "quay.io/keycloak/keycloak:26.6.3@sha256:9b0330756022422149aa6502eb2def8cd47c6e1b000c7c65cdb13e7c0133e992"
ENVOY = "docker.io/envoyproxy/envoy:distroless-v1.38.7@sha256:3d79fb37be70734406e0d3b36189f662a2fd0d202813af492880aa3646426fda"
# Fixture only: immutable multi-platform index; linux/amd64 and linux/arm64
# are present. Product image pins remain unchanged.
PYTHON = "docker.io/library/python:3.13-alpine@sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e"
ISSUER = "https://id.fixture.test/realms/magicstick"


class Stack:
    def __init__(self):
        self.suffix = uuid.uuid4().hex[:12]
        self.network = "magicstick-multihost-" + self.suffix
        self.keycloak = self.network + "-keycloak"
        self.api = self.network + "-api"
        self.envoy = self.network + "-envoy"
        self.bootstrap_volume = self.network + "-bootstrap"
        self.tmp = tempfile.TemporaryDirectory(prefix="magicstick-multihost-")
        self.path = Path(self.tmp.name)
        self.public_tmp = tempfile.TemporaryDirectory(prefix="magicstick-multihost-ca-")
        os.chmod(self.public_tmp.name, 0o711)
        self.public_ca = Path(self.public_tmp.name) / "ca.crt"
        self.client_secret = secrets.token_urlsafe(32)
        self.admin_password = secrets.token_urlsafe(32)
        # Freeze the processor under test before slow container startup so a
        # concurrent local edit cannot create a mixed-version test run.
        self.gate_source = (ROOT.parent / "dashboard/apps/api/callback_gate.py").read_text(encoding="utf-8")

    def docker(self, *args, timeout=180, environment=None, input_data=None):
        # Never include Docker's stderr in an exception: import/config files
        # contain synthetic credentials and must remain private too.
        result = subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False, input=input_data,
                                env=None if environment is None else {**os.environ, **environment})
        if result.returncode:
            raise RuntimeError("isolated Docker " + args[0] + " failed")
        return result.stdout.decode().strip()

    def file(self, name, content, public=False):
        path = self.path / name
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
        os.chmod(path, 0o644 if public else 0o600)
        return path

    def certificate(self):
        self.file("server.ext", "subjectAltName=DNS:id.fixture.test,DNS:dash.fixture.test,DNS:service.fixture.test,DNS:bad-ca.fixture.test,DNS:bad-host.fixture.test,DNS:expired.fixture.test\n"
                  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                  "extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n")
        self.file("gate.ext", "subjectAltName=DNS:magicstick-callback-gate.identity-system.svc.cluster.local\n"
                  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                  "extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n")
        for args in [
            ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Magicstick synthetic test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash"],
            ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=dash.fixture.test", "-addext", "subjectAltName=DNS:id.fixture.test,DNS:dash.fixture.test,DNS:service.fixture.test"],
            ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-extfile", "server.ext"],
            ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "gate.key", "-out", "gate.csr", "-subj", "/CN=magicstick-callback-gate.identity-system.svc.cluster.local"],
            ["x509", "-req", "-in", "gate.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "gate.crt", "-days", "1", "-extfile", "gate.ext"],
            ["x509", "-req", "-in", "gate.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "gate-expired.crt", "-days", "0", "-extfile", "gate.ext"],
            ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", "wrong-ca.key", "-out", "wrong-ca.crt", "-subj", "/CN=Magicstick unrelated synthetic CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
        ]:
            subprocess.run(["openssl", *args], cwd=self.path, check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
        os.chmod(self.path / "ca.crt", 0o644)
        shutil.copyfile(self.path / "ca.crt", self.public_ca)
        os.chmod(self.public_ca, 0o644)

    def start(self):
        self.certificate()
        realm = {"realm": "magicstick", "enabled": True, "sslRequired": "none",
                 "roles": {"realm": [{"name": "magicstick-user"}]},
                 "clients": [{"clientId": "magicstick-human-gateway-local", "enabled": True,
                   "publicClient": False, "secret": self.client_secret, "standardFlowEnabled": True,
                   "redirectUris": ["https://dash.fixture.test/oauth2/callback", "https://service.fixture.test/oauth2/callback"],
                   "webOrigins": ["https://dash.fixture.test", "https://service.fixture.test"],
                   "attributes": {"post.logout.redirect.uris": "https://dash.fixture.test/##https://service.fixture.test/"}}],
                 "users": [{"username": "fixture-user", "enabled": True, "emailVerified": True,
                   "firstName": "Fixture", "lastName": "User", "email": "fixture@example.com",
                   "realmRoles": ["magicstick-user"], "credentials": [{"type": "password", "value": "fixture-password", "temporary": False}]}]}
        environment = {'KC_BOOTSTRAP_ADMIN_USERNAME': 'fixture-admin', 'KC_BOOTSTRAP_ADMIN_PASSWORD': self.admin_password,
                       'KC_HOSTNAME': ISSUER.removesuffix('/realms/magicstick'), 'KC_HTTP_ENABLED': 'true', 'KC_PROXY_HEADERS': 'xforwarded'}
        self.docker("network", "create", "--subnet", f"10.253.{secrets.randbelow(240) + 1}.0/24", self.network)
        self.docker("run", "-d", "--name", self.keycloak, "--network", self.network, "--network-alias", "keycloak",
                    '-p', '127.0.0.1::8080', *[value for key in environment for value in ('-e', key)],
                    KEYCLOAK, 'start-dev', environment=environment)
        port = self.docker("port", self.keycloak, "8080/tcp").rsplit(":", 1)[1]
        for _ in range(150):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/realms/master/.well-known/openid-configuration", timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError("isolated Keycloak did not become ready")
        token_request = urllib.request.Request(f'http://127.0.0.1:{port}/realms/master/protocol/openid-connect/token',
            data=urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'admin-cli', 'username': 'fixture-admin', 'password': self.admin_password}).encode(),
            headers={'Content-Type': 'application/x-www-form-urlencoded'})
        with urllib.request.urlopen(token_request, timeout=5) as response:
            admin_token = json.load(response)['access_token']
        import_request = urllib.request.Request(f'http://127.0.0.1:{port}/admin/realms', data=json.dumps(realm).encode(),
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + admin_token}, method='POST')
        with urllib.request.urlopen(import_request, timeout=10) as response:
            response.read()

        api_manifest = ROOT / "apps/dashboard/dashboard-api.yaml"
        source = yaml.safe_load(api_manifest.read_text(encoding="utf-8"))["data"]["server.py"]
        api_file = self.file("server.py", source, True)
        gate_file = self.file("callback_gate.py", self.gate_source, True)
        gate_fixture = self.file("gate_fixture.py", (ROOT / "platform/identity/tests/multihost_gate_fixture.py").read_text(encoding="utf-8"), True)
        # Mount the RAM-backed volume in the long-lived fixture API before
        # writing it: tmpfs contents disappear when their last mount closes.
        self.docker("volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs",
                    "--opt", "o=size=1m,uid=65532,gid=65532,mode=0700", self.bootstrap_volume)
        self.docker("run", "-d", "--name", self.api, "--network", self.network, "--network-alias", "api",
                    "--mount", f"type=volume,source={self.bootstrap_volume},target=/bootstrap",
                    "--mount", f"type=bind,source={api_file},target=/app/server.py,readonly",
                    "--mount", f"type=bind,source={gate_file},target=/app/callback_gate.py,readonly",
                    "--mount", f"type=bind,source={gate_fixture},target=/app/gate_fixture.py,readonly",
                    "--mount", f"type=bind,source={self.path / 'gate.crt'},target=/app/gate-valid/tls.crt,readonly",
                    "--mount", f"type=bind,source={self.path / 'gate.key'},target=/app/gate-valid/tls.key,readonly",
                    "--mount", f"type=bind,source={self.path / 'gate-expired.crt'},target=/app/gate-expired/tls.crt,readonly",
                    "--mount", f"type=bind,source={self.path / 'gate.key'},target=/app/gate-expired/tls.key,readonly",
                    "--mount", f"type=bind,source={self.path / 'ca.crt'},target=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt,readonly",
                    "-e", "OIDC_USERINFO_URL=http://keycloak:8080/realms/magicstick/protocol/openid-connect/userinfo",
                    "-e", "OIDC_EXPECTED_ISSUER=" + ISSUER, PYTHON, "sh", "-ec",
                    "echo 'fixture-stage dependency-install'; "
                    "if ! pip install --timeout 15 --retries 2 --no-cache-dir --disable-pip-version-check "
                    "grpcio==1.76.0 protobuf==6.33.6 xds-protos==1.76.0 >/dev/null 2>&1; "
                    "then echo 'fixture-stage dependency-failed'; exit 1; fi; "
                    "echo 'fixture-stage processor'; exec python /app/gate_fixture.py")

        # Envoy requires a regular bootstrap file. Keep it only in a private
        # RAM-backed Docker volume, not on persistent host/container storage or
        # in process arguments. The distroless Envoy image runs as uid 65532.
        self.docker("exec", "-i", "--user", "65532:65532", self.api, "python", "-c",
                    "import os,sys; fd=os.open('/bootstrap/envoy.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400); "
                    "stream=os.fdopen(fd,'wb'); stream.write(sys.stdin.buffer.read()); stream.close()",
                    input_data=json.dumps(self.envoy_config()).encode())
        self.docker("run", "-d", "--name", self.envoy, "--network", self.network,
                    "--network-alias", "id.fixture.test", "--network-alias", "dash.fixture.test", "--network-alias", "service.fixture.test",
                    "--network-alias", "bad-ca.fixture.test", "--network-alias", "bad-host.fixture.test", "--network-alias", "expired.fixture.test",
                    "--mount", f"type=volume,source={self.bootstrap_volume},target=/bootstrap,readonly",
                    ENVOY, "-c", "/bootstrap/envoy.json", "--disable-hot-restart", "--log-level", "error")
        # Execute inside the network and validate the generated CA normally.
        category = "unknown"
        checker = """import ssl,urllib.request
try:
 ctx=ssl.create_default_context(cafile='/var/run/secrets/kubernetes.io/serviceaccount/ca.crt')
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx))
 op.open('https://id.fixture.test/realms/magicstick/.well-known/openid-configuration',timeout=2).read()
 op.open('http://127.0.0.1:8082/control?mode=ready',timeout=2).read()
except Exception as e:
 reason=getattr(e,'reason',None)
 print(type(e).__name__,type(reason).__name__,getattr(reason,'verify_code','none'),getattr(reason,'errno','none'),getattr(e,'code','none'))
 raise SystemExit(1)
"""
        ready = False
        for _ in range(180):
            result = subprocess.run(["docker", "exec", self.api, "python", "-c", checker],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
            if result.returncode == 0:
                ready = True
                break
            value = result.stdout.decode(errors="replace").strip()
            if len(value) < 80 and all(c.isalnum() or c in " -_" for c in value):
                category = value or "container-unavailable"
            if "SSLCertVerificationError" in category:
                break
            time.sleep(0.5)
        if not ready:
            status = []
            for name in (self.envoy, self.api):
                try:
                    status.append(self.docker("inspect", "--format", "{{.State.Status}}", name, timeout=5))
                except RuntimeError:
                    status.append("unknown")
            api_logs = subprocess.run(["docker", "logs", self.api], capture_output=True, timeout=10, check=False)
            allowed_stages = {"fixture-stage dependency-install", "fixture-stage dependency-failed", "fixture-stage processor"}
            stages = [line for line in api_logs.stdout.decode(errors="replace").splitlines() if line in allowed_stages]
            raise RuntimeError("isolated TLS gateway/guard not ready: " + category + "; envoy/api=" + "/".join(status)
                               + "; api-stage=" + (stages[-1].removeprefix("fixture-stage ") if stages else "unknown"))

    def envoy_config(self):
        def address(host, port):
            return {"socket_address": {"address": host, "port_value": port}}
        def cluster(name, host, port):
            return {"name": name, "connect_timeout": "3s", "type": "STRICT_DNS", "load_assignment": {
                "cluster_name": name, "endpoints": [{"lb_endpoints": [{"endpoint": {"address": address(host, port)}}]}]}}
        oauth_path = "/realms/magicstick/protocol/openid-connect"
        oauth = {"name": "envoy.filters.http.oauth2", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.oauth2.v3.OAuth2", "config": {
                "token_endpoint": {"cluster": "keycloak", "uri": "http://keycloak:8080" + oauth_path + "/token", "timeout": "5s"},
                "authorization_endpoint": ISSUER + "/protocol/openid-connect/auth",
                "end_session_endpoint": ISSUER + "/protocol/openid-connect/logout",
                "credentials": {"client_id": "magicstick-human-gateway-local", "token_secret": {"name": "client"},
                    "hmac_secret": {"name": "hmac"}, "cookie_names": {"bearer_token": "__Host-MagicStickAccessToken", "id_token": "__Host-MagicStickIDToken"}},
                "redirect_uri": "https://%REQ(:authority)%/oauth2/callback", "redirect_path_matcher": {"path": {"exact": "/oauth2/callback"}},
                "signout_path": {"path": {"exact": "/logout"}}, "forward_bearer_token": True, "use_refresh_token": True,
                "auth_scopes": ["openid", "profile", "email"], "pass_through_matcher": [{"name": ":authority", "string_match": {"exact": "id.fixture.test"}}]}}}
        jwt = {"name": "envoy.filters.http.jwt_authn", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.jwt_authn.v3.JwtAuthentication",
            "providers": {"keycloak": {"issuer": ISSUER,
                "remote_jwks": {"http_uri": {"uri": "http://keycloak:8080" + oauth_path + "/certs", "cluster": "keycloak", "timeout": "5s"},
                                "cache_duration": "300s"},
                "from_cookies": ["__Host-MagicStickAccessToken"]}},
            "rules": [{"match": {"prefix": "/"}, "requires": {"requires_any": {"requirements": [
                {"provider_name": "keycloak"}, {"allow_missing": {}}]}}}]}}
        auth = {"name": "envoy.filters.http.ext_authz", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz",
            "status_on_error": {"code": "Forbidden"}, "failure_mode_allow": False,
            "http_service": {"server_uri": {"uri": "http://api:8080", "cluster": "api", "timeout": "5s"},
                "path_prefix": "/internal/session-access", "authorization_request": {"allowed_headers": {"patterns": [
                    {"exact": "cookie"}, {"exact": "authorization"}]}}}}}
        extproc = {"name": "envoy.filters.http.ext_proc", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExternalProcessor",
            "grpc_service": {"envoy_grpc": {"cluster_name": "gate"}, "timeout": "8s"},
            "message_timeout": "8s",
            "failure_mode_allow": False,
            "processing_mode": {"request_header_mode": "SEND", "response_header_mode": "SKIP"}}}
        migration_source = (ROOT / "platform/identity/cookie-migration.lua").read_text(encoding="utf-8")
        migration_source = migration_source.replace("${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}", "fixture.test")
        migration_source = migration_source.replace("${AI_APPLIANCE_DOMAIN:=magicstick.example.com}", "fixture.test")
        migration_source = migration_source.replace("${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}", "dash.fixture.test")
        migration = {"name": "envoy.filters.http.lua", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua",
            "default_source_code": {"inline_string": migration_source}}}
        identity = {"name": "identity", "domains": ["id.fixture.test"], "routes": [
            {"match": {"prefix": "/"}, "route": {"cluster": "keycloak"}, "typed_per_filter_config": {
                "envoy.filters.http.ext_authz": {"@type": "type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthzPerRoute", "disabled": True},
                "envoy.filters.http.ext_proc": {"@type": "type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExtProcPerRoute", "disabled": True}}}]}
        dashboard = {"name": "dashboard", "domains": ["dash.fixture.test"],
                "routes": [{"match": {"prefix": "/"}, "direct_response": {"status": 200, "body": {"inline_string": "protected fixture"}}}]}
        # Match LiteLLM's contract: OAuth decrypts the host-only cookie for the
        # guard, but the application's own native Authorization is preserved.
        service_oauth = copy.deepcopy(oauth["typed_config"]["config"])
        service_oauth["forward_bearer_token"] = False
        service_oauth["preserve_authorization_header"] = True
        service = {"name": "service", "domains": ["service.fixture.test"],
            "routes": [{"match": {"prefix": "/"}, "direct_response": {"status": 200, "body": {"inline_string": "protected fixture"}},
                "typed_per_filter_config": {"envoy.filters.http.oauth2": {
                    "@type": "type.googleapis.com/envoy.extensions.filters.http.oauth2.v3.OAuth2PerRoute", "config": service_oauth}},
                "response_headers_to_add": [{"header": {"key": "x-fixture-native-authorization", "value": "%REQ(authorization)%"},
                                             "append_action": "OVERWRITE_IF_EXISTS_OR_ADD"}]}]}
        def negative_route(host, gate_name):
            return {"name": gate_name, "domains": [host], "routes": [{"match": {"prefix": "/"},
                "direct_response": {"status": 200}, "typed_per_filter_config": {"envoy.filters.http.ext_proc": {
                    "@type": "type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExtProcPerRoute",
                    "overrides": {"grpc_service": {"envoy_grpc": {"cluster_name": gate_name}, "timeout": "8s"}}}}}]}
        tls = {"name": "envoy.transport_sockets.tls", "typed_config": {"@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
            "common_tls_context": {"tls_certificates": [{"certificate_chain": {"inline_string": (self.path / "server.crt").read_text()},
                "private_key": {"inline_string": (self.path / "server.key").read_text()}}]}}}
        manager = {"name": "envoy.filters.network.http_connection_manager", "typed_config": {
            "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
            "stat_prefix": "fixture", "route_config": {"name": "fixture", "virtual_hosts": [identity, dashboard, service,
                negative_route("bad-ca.fixture.test", "gate-bad-ca"), negative_route("bad-host.fixture.test", "gate-bad-host"),
                negative_route("expired.fixture.test", "gate-expired")]},
            "access_log": [{"name": "envoy.access_loggers.stdout", "typed_config": {
                "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
                "log_format": {"text_format_source": {"inline_string": "fixture %RESPONSE_CODE% %RESPONSE_CODE_DETAILS%\n"}}}}],
            "http_filters": [migration, extproc, oauth, jwt, auth, {"name": "envoy.filters.http.router", "typed_config": {"@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router"}}]}}
        def tls_gate(name, port, ca_file, hostname):
            result = cluster(name, "api", port)
            result["typed_extension_protocol_options"] = {"envoy.extensions.upstreams.http.v3.HttpProtocolOptions": {
                "@type": "type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions",
                "explicit_http_config": {"http2_protocol_options": {}}}}
            result["transport_socket"] = {"name": "envoy.transport_sockets.tls", "typed_config": {
                "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext",
                "sni": hostname, "common_tls_context": {"validation_context": {
                    "trusted_ca": {"inline_string": (self.path / ca_file).read_text()},
                    "match_typed_subject_alt_names": [{"san_type": "DNS", "matcher": {"exact": hostname}}]}}}}
            return result
        gate_host = "magicstick-callback-gate.identity-system.svc.cluster.local"
        gate_clusters = [tls_gate("gate", 8081, "ca.crt", gate_host),
                         tls_gate("gate-bad-ca", 8081, "wrong-ca.crt", gate_host),
                         tls_gate("gate-bad-host", 8081, "ca.crt", "wrong.fixture.test"),
                         tls_gate("gate-expired", 8083, "ca.crt", gate_host)]
        return {"static_resources": {"secrets": [{"name": "client", "generic_secret": {"secret": {"inline_string": self.client_secret}}},
            {"name": "hmac", "generic_secret": {"secret": {"inline_string": secrets.token_hex(32)}}}],
            "clusters": [cluster("keycloak", "keycloak", 8080), cluster("api", "api", 8080), *gate_clusters],
            "listeners": [{"name": "https", "address": address("0.0.0.0", 443), "filter_chains": [{"transport_socket": tls, "filters": [manager]}]}]}}

    def stop(self):
        errors = []
        # Only fixed response-code details are emitted. OAuth URLs, headers,
        # token values and unrecognized log lines are never copied to output.
        logs = subprocess.run(["docker", "logs", self.envoy], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=30)
        reasons = collections.Counter()
        for line in logs.stdout.decode(errors="replace").splitlines():
            match = re.fullmatch(r"fixture (504) ([A-Za-z0-9_{}.-]{1,100})", line)
            if match:
                reasons[match.group(2)] += 1
        if reasons:
            print("Synthetic Envoy 504 reasons: " + json.dumps(dict(reasons), sort_keys=True), file=sys.stderr, flush=True)
        for name in (self.envoy, self.api, self.keycloak):
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
            try:
                if self.docker("ps", "-aq", "--filter", f"name=^/{name}$", timeout=30):
                    errors.append("container")
            except RuntimeError:
                errors.append("container-unverified")
        subprocess.run(["docker", "volume", "rm", self.bootstrap_volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        try:
            if self.docker("volume", "ls", "-q", "--filter", f"name=^{self.bootstrap_volume}$", timeout=30):
                errors.append("bootstrap-volume")
        except RuntimeError:
            errors.append("bootstrap-volume-unverified")
        subprocess.run(["docker", "network", "rm", self.network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        try:
            if self.docker("network", "ls", "-q", "--filter", f"name=^{self.network}$", timeout=30):
                errors.append("network")
        except RuntimeError:
            errors.append("network-unverified")
        self.tmp.cleanup()
        self.public_tmp.cleanup()
        if errors:
            raise RuntimeError("isolated stack cleanup not verified")


def main():
    if sys.argv[1:] != ["serve"]:
        raise SystemExit("usage: test_multihost_stack.py serve")
    finished = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: finished.set())
    signal.signal(signal.SIGINT, lambda *_: finished.set())
    stack = Stack()
    try:
        stack.start()
        print(json.dumps({"network": stack.network, "ca_file": str(stack.public_ca),
                          "dashboard": "https://dash.fixture.test", "service": "https://service.fixture.test",
                          "identity": "https://id.fixture.test"}), flush=True)
        finished.wait()
    finally:
        stack.stop()


if __name__ == "__main__":
    main()
