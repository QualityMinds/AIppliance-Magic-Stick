# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. See LICENSE.
"""Lifecycle and certificate-pinned enrollment for the private transport."""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit

from integration import json_request
from mesh_service import LOCAL_ENGINES, NAME, MeshError, canonical, ready_local_model


def transport_process_options(home):
    """Minimal native environment, with the OS bootstrap required on Windows."""
    env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'HOME': str(home)}
    options = {'env': env}
    if sys.platform == 'win32':
        system_root = os.environ.get('SystemRoot') or os.environ.get('SYSTEMROOT')
        if not system_root:
            raise MeshError('Windows SystemRoot is unavailable; the mesh transport cannot start.', 503)
        temporary = Path(home) / 'tmp'
        temporary.mkdir(parents=True, exist_ok=True)
        env.update(SystemRoot=system_root, WINDIR=system_root, USERPROFILE=str(home),
                   TEMP=str(temporary), TMP=str(temporary))
        options['creationflags'] = subprocess.CREATE_NO_WINDOW
    return options


def atomic_file(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + secrets.token_hex(6))
    with temporary.open("xb") as stream:
        temporary.chmod(0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def enrollment_exchange(mesh, path, body):
    if path not in {"/mesh/enroll", "/mesh/heartbeat"}:
        raise MeshError("Unsupported enrollment route.")
    origin = urlsplit(mesh["origin"])
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password:
        raise MeshError("Invalid enrollment address.")
    ca = mesh.get("caCertificate")
    if not isinstance(ca, str) or not hmac.compare_digest(hashlib.sha256(ca.encode()).hexdigest(), mesh["tlsPin"]):
        raise MeshError("Invalid enrollment trust certificate.", 401)
    context = ssl.create_default_context(cadata=ca)
    connection = http.client.HTTPSConnection(origin.hostname, origin.port or 443, context=context, timeout=10)
    try:
        connection.connect()
        # Secrets are sent only after CA and hostname verification on this same
        # socket. The invitation pins the appliance CA, not a rotating leaf.
        connection.request("POST", path, canonical(body), {"Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 1024 * 1024:
            raise MeshError("Enrollment was rejected or is unavailable.", 401 if response.status in {401, 403} else 503, "authentication_failed")
        return json.loads(raw)
    except (OSError, ValueError, http.client.HTTPException):
        raise MeshError("The mesh owner is unreachable.", 503, "mesh_unavailable") from None
    finally:
        connection.close()


class MeshRuntime:
    def __init__(self, service, directory, bridge_token, api_port=9337, web_port=3131, bridge_port=8081):
        self.service, self.directory, self.bridge_token = service, Path(directory), bridge_token
        self.api_port, self.web_port, self.bridge_port = api_port, web_port, bridge_port
        self.process = None
        self.fingerprint = None
        self.last_start = None
        self.last_error = None
        self.last_exit_code = None

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None

    def reconcile(self):
        if self.process and self.process.poll() is not None:
            self.last_exit_code = self.process.returncode
        state = self.service.store.read()
        atomic_file(self.directory / "policy.json", canonical(self.service.policy()))
        if not state.get("mesh"):
            self.stop()
            return
        try:
            self.service.require_runtime()
        except MeshError:
            self.stop()
            raise
        member = self.service.activeRoster().get("members", {}).get(self.service.identity.endpoint)
        if not member or member["revoked"]:
            self.stop()
            self.last_error = "authentication_failed"
            return
        bootstrap = (state.get("roster") or {}).get("bootstrap", "")
        owner = state["mesh"]["authority"] == self.service.identity.endpoint
        if not owner and not bootstrap:
            self.last_error = "connecting"
            return
        # Bootstrap contains live address hints. Their refresh must not restart
        # a healthy node and interrupt inference; use the latest token only
        # when starting/restarting the transport.
        fingerprint = hashlib.sha256(canonical([state["node"], state["relay"], state["mesh"]["id"], state["mesh"]["authority"]])).hexdigest()
        if self.process and self.process.poll() is None and self.fingerprint == fingerprint:
            return
        if self.last_start is not None and time.monotonic() - self.last_start < 10:
            return
        self.stop()
        self.last_start = time.monotonic()
        binary = os.environ.get("MESH_BINARY", "/usr/local/bin/mesh-llm")
        checksum_file = Path(os.environ.get("MESH_BINARY_CHECKSUM", "/usr/local/share/magicstick-mesh.sha256"))
        expected = checksum_file.read_text().split()[0]
        with open(binary, "rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if not hmac.compare_digest(actual, expected):
            raise MeshError("The mesh binary does not match the verified build.", 503)
        home = self.directory / "home"
        key_path = home / ".mesh-llm/key"
        atomic_file(key_path, self.service.identity.seed.encode())
        config = '[logging]\nenabled = false\n[runtime]\nmode = "on_demand"\n'
        if state["node"]["type"] == "magic-stick":
            config += ('\n[[plugin]]\nname = "openai-endpoint"\nenabled = true\nweb_ui_enabled = false\n'
                       f'command = {json.dumps(os.environ.get("MESH_ENDPOINT_PLUGIN", "/usr/local/bin/openai-endpoint"))}\n'
                       f'url = "http://127.0.0.1:{self.bridge_port}/v1"\n')
        atomic_file(home / ".mesh-llm/config.toml", config.encode())
        mode = "client" if state["node"]["type"] == "client" else "serve"
        args = [binary, mode, "--headless", "--port", str(self.api_port), "--console", str(self.web_port)]
        if not owner:
            args += ["--join", bootstrap]
        relay = state["relay"]
        if relay["mode"] == "custom":
            args += ["--relay", relay["url"]]
        # Auto/Public both use Iroh's shipped public relay set with direct-path
        # upgrades. Neither enables Nostr mesh publication or public discovery.
        options = transport_process_options(home)
        options['env'].update({"MESH_LLM_DATA_DIR": str(home / ".mesh-llm"), "MESH_LLM_NODE_KEY_PATH": str(key_path),
               "MAGICSTICK_MESH_POLICY": str(self.directory / "policy.json"),
               "MAGICSTICK_BRIDGE_TOKEN": self.bridge_token, "MAGICSTICK_BRIDGE_PORT": str(self.bridge_port),
               "RUST_LOG": "error"})
        # Do not inherit LiteLLM master/admin keys, Kubernetes credentials, proxy
        # credentials, user HOME or untrusted config search paths.
        self.process = subprocess.Popen(args, **options, cwd=str(home), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.fingerprint, self.last_error = fingerprint, None

    def status(self):
        return json_request(f"http://127.0.0.1:{self.web_port}/api/status", timeout=3)

    def models(self):
        return json_request(f"http://127.0.0.1:{self.api_port}/v1/models", timeout=3)

    def network(self):
        return json_request(f"http://127.0.0.1:{self.web_port}/api/diagnostics/network", timeout=3)


class LocalInventory:
    MODEL_PATH = "/apis/kubeai.org/v1/namespaces/ai/models"
    ACTIVATION_PATH = "/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/modelactivations"

    def __init__(self, read=None):
        self.items = {}
        self.available = False
        self.read = read or self._read

    @staticmethod
    def _read(path):
        from urllib import request
        token_path = Path("/var/run/secrets/kubernetes.io/serviceaccount/token")
        token = token_path.read_text().strip()
        ca = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
        url = "https://kubernetes.default.svc" + path
        with request.urlopen(request.Request(url, headers={"Authorization": "Bearer " + token}), context=ssl.create_default_context(cafile=ca), timeout=5) as result:
            return json.load(result).get("items", [])

    @staticmethod
    def _freetoken_endpoint(activation):
        # Match the existing catalog contract: the operator's versioned local
        # Service endpoint, not an external provider or a route imported by Mesh.
        namespace = (activation.get("spec") or {}).get("targetNamespace") or "ai"
        endpoint = str((activation.get("status") or {}).get("runtimeEndpoint") or "").strip().rstrip("/")
        if not isinstance(namespace, str) or not NAME.fullmatch(namespace):
            return None
        try:
            parsed = urlsplit(endpoint)
            suffix = f".{namespace}.svc.cluster.local"
            host = parsed.hostname or ""
            if (parsed.scheme not in {"http", "https"} or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or parsed.path != "/v1"
                    or not host.endswith(suffix) or not NAME.fullmatch(host[:-len(suffix)])
                    or parsed.port == 0):
                return None
        except ValueError:
            return None
        return endpoint

    def refresh(self):
        try:
            models = self.read(self.MODEL_PATH)
            activations = self.read(self.ACTIVATION_PATH)
            items = {}
            for model in models:
                meta, spec, status = model.get("metadata") or {}, model.get("spec") or {}, model.get("status") or {}
                engine = str(spec.get("engine", "")).upper()
                if (engine not in LOCAL_ENGINES["kubeai"] or meta.get("deletionTimestamp")
                        or not meta.get("name") or not meta.get("uid")
                        or "TextGeneration" not in (spec.get("features") or [])):
                    continue
                items[meta["name"]] = {"uid": meta.get("uid"), "ready": (status.get("replicas") or {}).get("ready", 0) > 0,
                                       "source": "kubeai", "engine": engine}
            for activation in activations:
                meta, spec, status = activation.get("metadata") or {}, activation.get("spec") or {}, activation.get("status") or {}
                local = spec.get("local") or {}
                engine = str(local.get("engine", "")).upper()
                if (spec.get("type") != "local" or spec.get("enabled", True) is False
                        or meta.get("deletionTimestamp") or not meta.get("name") or not meta.get("uid")
                        or engine not in LOCAL_ENGINES["freetoken"]
                        or local.get("modelType", "chat") != "chat"):
                    continue
                endpoint = self._freetoken_endpoint(activation)
                if not endpoint:
                    continue
                name = meta["name"]
                if name in items:
                    # Do not guess which backend owns an ambiguous local alias.
                    del items[name]
                    continue
                items[name] = {"uid": meta["uid"], "source": "freetoken", "engine": engine,
                               "ready": str(status.get("phase", "")).lower() == "ready",
                               "apiBase": endpoint}
            self.items, self.available = items, True
        except (OSError, ValueError, TypeError, AttributeError):
            # Fail closed on loss of backend provenance instead of keeping an
            # arbitrarily old export allowlist alive.
            self.items, self.available = {}, False

    def status(self):
        if not self.available:
            return "unavailable"
        return "ready" if any(ready_local_model(item) for item in self.items.values()) else "no_local_model"

    def __call__(self):
        return self.items.copy()
