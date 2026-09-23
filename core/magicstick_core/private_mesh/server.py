# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. See LICENSE.
"""Four isolated HTTP surfaces; only enrollment is routed by the gateway.

8080 dashboard admin (service secret), 8081 export (loopback, transport proof),
8082 LiteLLM imports (service secret), 8083 enrollment (signed membership).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request, error

from integration import ExportBridge, LiteLLM, ModelSync, NoRedirect, json_request
from mesh_service import MeshService, MeshError, Store, canonical, integer
from runtime import LocalInventory, MeshRuntime, enrollment_exchange, atomic_file


class BoundedHTTPServer(ThreadingHTTPServer):
    """Bound concurrent sockets, including unauthenticated enrollment sockets."""
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, *args, **kwargs):
        self.capacity = threading.BoundedSemaphore(32)
        super().__init__(*args, **kwargs)

    def process_request(self, sock, address):
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(sock)
            return
        try:
            super().process_request(sock, address)
        except BaseException:
            self.capacity.release()
            raise

    def process_request_thread(self, sock, address):
        try:
            super().process_request_thread(sock, address)
        finally:
            self.capacity.release()


class Application:
    def __init__(self):
        directory = Path(os.environ.get("MESH_STATE_DIR", "/state"))
        self.store = Store(str(directory / "mesh.db"))
        self.inventory = LocalInventory()
        self.service = MeshService(self.store, self.inventory)
        self.admin_token = os.environ["MESH_ADMIN_TOKEN"]
        self.import_token = os.environ["MESH_IMPORT_TOKEN"]
        bridge_token = secrets.token_hex(32)
        self.runtime = MeshRuntime(self.service, directory / "runtime", bridge_token)
        base = os.environ.get("LITELLM_BASE_URL", "http://litellm.ai.svc.cluster.local:4000")
        self.litellm = LiteLLM(base, os.environ["LITELLM_MASTER_KEY"])
        self.bridge = ExportBridge(self.service, base, bridge_token)
        self.sync = ModelSync(self.service, self.litellm, self.runtime.models,
                              "http://kubeai.ai.svc.cluster.local/openai/v1",
                              "http://private-mesh.ai.svc.cluster.local:8082/v1", self.import_token,
                              grace=integer(int(os.environ.get("MESH_MODEL_GRACE_SECONDS", "120")), 5, 3600, "Model disappearance grace"))
        self.components = {name: "disconnected" for name in ("mesh", "litellm", "models", "sync", "export")}
        self.last_error = None
        self.transport = "unknown"
        self.connected_peers = set()
        self.outgoing = {"requests": 0, "errors": 0, "active": 0}
        self.local_metrics = None
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.operation_lock = threading.RLock()
        self.last_diagnostic = None

    def status(self):
        payload = self.service.getStatus()
        for node in payload["nodes"]:
            node["online"] = node["online"] and self.components["mesh"] == "ready" and (
                node["id"] == self.service.identity.endpoint or node["id"] in self.connected_peers)
        payload.update(components=self.components.copy(), transport=self.transport,
                       lastError=self.last_error, lastSync=self.sync.last_success,
                       metrics={"incoming": self.bridge.metrics.copy(), "outgoing": self.outgoing.copy(),
                                "backends": self.local_metrics, "byPeerModel": self.bridge.activity()})
        if not payload["configured"]:
            phase = "disconnected"
        elif not payload["membershipValid"]:
            phase = "authentication_failed" if self.last_error else "connecting"
        elif self.components["mesh"] == "ready" and self.components["sync"] == "ready":
            connected = payload['authority'] or any(node['online'] and node['id'] != self.service.identity.endpoint for node in payload['nodes'])
            phase = ("relay" if self.transport == "relay" else "connected") if connected else "connecting"
        else:
            phase = self.last_error or "connecting"
        payload["phase"] = phase
        return payload

    def run(self):
        while not self.stopping.is_set():
            try:
                with self.operation_lock:
                    self.inventory.refresh()
                    self.components["models"] = self.inventory.status()
                    self.service.require_appliance()
                    try:
                        self.service.refreshMembership(enrollment_exchange)
                    except MeshError as exc:
                        self.last_error = exc.code
                    self.runtime.reconcile()
                    if self.store.read().get("mesh"):
                        try:
                            status = self.runtime.status()
                            self.components["mesh"] = "ready"
                            diagnostics = self.runtime.network()
                            paths = [p.get("path", "unknown") for p in diagnostics.get("peers", [])]
                            self.connected_peers = {p["node_id"] for p in diagnostics.get("peers", []) if p.get("path") in {"direct", "relay"}}
                            self.transport = "relay" if "relay" in paths else "direct" if "direct" in paths else "unknown"
                            if self.store.read()["mesh"]["authority"] == self.service.identity.endpoint and status.get("token"):
                                with self.store.change() as state:
                                    state["bootstrap"] = status["token"]
                        except MeshError:
                            self.connected_peers = set()
                            self.components["mesh"] = "unavailable"
                            self.last_error = "mesh_unavailable"
                    else:
                        self.components["mesh"] = "disconnected"
                    try:
                        self.sync.reconcile()
                        self.components["litellm"] = "ready"
                        self.components["sync"] = "ready" if not self.sync.last_error else "unavailable"
                        self.components["export"] = "ready" if self.service.exportModels() else "not_shared"
                        if not self.sync.last_error and self.components["mesh"] == "ready":
                            self.last_error = None
                    except MeshError as exc:
                        self.components["litellm"] = self.components["sync"] = "unavailable"
                        self.last_error = exc.code
                    try:
                        self.local_metrics = json_request('http://litellm.ai.svc.cluster.local:9099/metrics', token=self.admin_token, timeout=2)
                    except MeshError:
                        self.local_metrics = None
            except MeshError as exc:
                self.last_error = exc.code
            except Exception:
                # No exception strings here: Mesh/HTTP errors can contain secrets.
                self.last_error = "configuration_error"
            diagnostic = {"event": "private_mesh_state", "components": self.components.copy(),
                          "error": self.last_error, "transportExitCode": self.runtime.last_exit_code}
            if diagnostic != self.last_diagnostic:
                print(json.dumps(diagnostic, sort_keys=True), flush=True)
                self.last_diagnostic = diagnostic
            self.wake.wait(5)
            self.wake.clear()
        self.runtime.stop()

    def command(self, action, payload):
        with self.operation_lock:
            if action not in {'leave', 'unshare', 'revoke-invite', 'revoke-node'}:
                self.service.require_appliance()
            if action == "create":
                ca = str(payload.get("caCertificate") or "")
                if not ca.startswith("-----BEGIN CERTIFICATE-----") or "PRIVATE KEY" in ca:
                    raise MeshError("The appliance trust certificate is not ready.", 409)
                result = self.service.createMesh(payload.get("meshName"), payload.get("nodeName"), payload.get("origin", ""),
                                                 hashlib.sha256(ca.encode()).hexdigest(), payload.get("relay"), payload.get("shares"), ca)
            elif action == "join":
                result = self.service.joinMesh(payload.get("token", ""), payload.get("nodeName"), enrollment_exchange)
            elif action == "leave":
                self.service.leaveMesh()
                self.runtime.reconcile()
                result = {"accepted": True}
            elif action == "invite":
                result = self.service.createInvite(payload.get("type"), payload.get("creator", "administrator"), payload.get("lifetime", 3600))
            elif action == "revoke-invite":
                self.service.revokeInvite(payload.get("id"))
                result = {"accepted": True}
            elif action == "revoke-node":
                self.service.revokeNode(payload.get("id"))
                result = {"accepted": True}
            elif action == "share":
                result = self.service.shareModel(payload.get("model"), payload.get("settings", {}))
            elif action == "unshare":
                self.service.unshareModel(payload.get("model"))
                result = {"accepted": True}
            elif action == "relay":
                result = self.service.setRelayConfig(payload)
            elif action == "sync":
                result = {"accepted": True}
            else:
                raise MeshError("Unknown mesh operation.", 404)
            self.wake.set()
            return result


def handler(app, surface):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def setup(self):
            super().setup()
            self.response_started = False
            self.connection.settimeout(15)

        def send_json(self, body, status=200):
            if self.response_started:
                return
            self.response_started = True
            self.close_connection = True
            raw = canonical(body)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            if status == 429:
                self.send_header("Retry-After", "5")
            self.end_headers()
            self.wfile.write(raw)

        def body(self):
            lengths = self.headers.get_all("Content-Length") or []
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
                raise MeshError("A single bounded Content-Length is required.")
            size = int(lengths[0])
            if not 0 < size <= 1024 * 1024:
                raise MeshError("Request exceeds the safety limit.", 413)
            if self.headers.get_content_type() != "application/json":
                raise MeshError("JSON is required.", 415)
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise MeshError("Incomplete request.")
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                raise MeshError("Invalid JSON.") from None
            if not isinstance(value, dict):
                raise MeshError("A JSON object is required.")
            return value

        def token(self, expected):
            values = self.headers.get_all("Authorization") or []
            if len(values) != 1 or not hmac.compare_digest(values[0], "Bearer " + expected):
                raise MeshError("Authentication required.", 401, "authentication_failed")

        def relay(self, upstream):
            self.response_started = True
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    block = upstream.read1(65536)
                    if not block:
                        break
                    self.wfile.write(block)
                    self.wfile.flush()
            finally:
                upstream.close()

        def dispatch(self):
            if len(self.path) > 2048 or "?" in self.path:
                raise MeshError("Unsupported route.", 404)
            if self.command == "GET" and self.path == "/healthz":
                return self.send_json({"ok": True})
            if surface == "admin":
                self.token(app.admin_token)
                if self.command == "GET" and self.path == "/status":
                    return self.send_json(app.status())
                if self.command == "POST" and self.path.startswith("/commands/"):
                    return self.send_json(app.command(self.path[len("/commands/"):], self.body()))
            elif surface == "enrollment":
                if self.command != "POST":
                    raise MeshError("Not found.", 404)
                if self.path == "/mesh/enroll":
                    result = app.service.enroll(self.body())
                elif self.path == "/mesh/heartbeat":
                    result = app.service.heartbeat(self.body())
                else:
                    raise MeshError("Not found.", 404)
                app.wake.set()
                return self.send_json(result)
            elif surface == "export":
                if self.command == "GET" and self.path == "/v1/models":
                    return self.send_json(app.bridge.models())
                if self.command == "POST" and self.path == "/v1/chat/completions":
                    app.bridge.authorize(self.headers.get("X-MagicStick-Bridge"), self.headers.get("X-MagicStick-Peer"))
                    model, settings, body, key, estimate = app.bridge.prepare(self.body())
                    with app.bridge.reserve(model, settings, estimate, self.headers.get("X-MagicStick-Peer")):
                        return self.relay(app.bridge.open(body, key))
            elif surface == "import":
                self.token(app.import_token)
                app.service.require_appliance()
                if self.command == "GET" and self.path == "/v1/models":
                    return self.send_json({"object": "list", "data": [{"id": item["remote"], "object": "model"} for item in app.store.read()["imports"].values()]})
                if self.command == "POST" and self.path == "/v1/chat/completions":
                    body = self.body()
                    roster = app.service.activeRoster()
                    allowed = {name for node, member in roster.get("members", {}).items() if node != app.service.identity.endpoint and not member["revoked"] and member["type"] == "magic-stick" for name in member.get("exports", {})}
                    if body.get("model") not in allowed:
                        raise MeshError("Remote model is unavailable or not trusted.", 404, "model_unavailable")
                    # Never forward an application's LiteLLM credentials or
                    # provider URLs into the mesh transport.
                    clean = {key: value for key, value in body.items() if key in {"model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "seed", "tools", "tool_choice", "response_format"}}
                    with app.bridge.lock:
                        app.outgoing["requests"] += 1
                        app.outgoing["active"] += 1
                    try:
                        upstream = request.build_opener(NoRedirect()).open(request.Request(
                            f"http://127.0.0.1:{app.runtime.api_port}/v1/chat/completions", canonical(clean),
                            {"Content-Type": "application/json"}, method="POST"), timeout=120)
                        return self.relay(upstream)
                    except error.HTTPError as exc:
                        with app.bridge.lock:
                            app.outgoing["errors"] += 1
                        raise MeshError("The remote model rejected the request.", exc.code if exc.code in {400, 413, 429} else 503, "model_unavailable") from None
                    except (error.URLError, TimeoutError):
                        with app.bridge.lock:
                            app.outgoing["errors"] += 1
                        raise MeshError("The remote model is unavailable.", 503, "model_unavailable") from None
                    finally:
                        with app.bridge.lock:
                            app.outgoing["active"] -= 1
            raise MeshError("Not found.", 404)

        def execute(self):
            self.close_connection = True
            try:
                self.dispatch()
            except MeshError as exc:
                self.send_json({"error": {"message": str(exc), "code": exc.code}}, exc.status)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            except Exception:
                self.send_json({"error": {"message": "Mesh service is unavailable.", "code": "configuration_error"}}, 503)

        do_GET = execute
        do_POST = execute
    return Handler


def main():
    app = Application()
    servers = []
    for host, port, surface in [("0.0.0.0", 8080, "admin"), ("127.0.0.1", 8081, "export"), ("0.0.0.0", 8082, "import"), ("0.0.0.0", 8083, "enrollment")]:
        server = BoundedHTTPServer((host, port), handler(app, surface))
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    def shutdown(*_args):
        app.stopping.set()
        app.wake.set()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    app.run()
    for server in servers:
        server.shutdown()


if __name__ == "__main__":
    main()
