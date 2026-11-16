# SPDX-License-Identifier: BUSL-1.1
"""Synthetic readiness control; real gRPC processor and API handler are used.

The control endpoint exists only on the disposable Docker test network. It is
not product code and does not model Kubernetes or Keycloak status provenance.
"""
import json
import runpy
import threading
import urllib.parse
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import callback_gate

state = {"mode": "ready", "active": 0, "maximum": 0, "calls": 0, "joined": 0}
lock = threading.Lock()
joined = threading.Condition(lock)
gate = None


class ReadinessFuture(Future):
    def result(self, timeout=None):
        # Observe actual production-gate followers, not just browser dispatch.
        # The synthetic owner is released only after all 31 others join it.
        with joined:
            if state["mode"] == "slow":
                state["joined"] += 1
                joined.notify_all()
        return super().result(timeout=timeout)


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        global gate
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/control":
            mode = query.get("mode", [""])[0]
            if mode not in {"ready", "stale", "additive", "slow"}:
                self.send_response(400)
            else:
                with lock:
                    state.update(mode=mode, active=0, maximum=0, calls=0, joined=0)
                self.send_response(204)
        elif parsed.path == "/metrics":
            with lock:
                payload = json.dumps({key: state[key] for key in ("maximum", "calls", "joined")}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        elif parsed.path == "/restart-gate":
            gate.stop(0).wait(timeout=5)
            gate = callback_gate.start(cert_dir="/app/gate-valid")
            self.send_response(204)
        elif parsed.path == "/stop-gate":
            gate.stop(0).wait(timeout=5)
            self.send_response(204)
        elif parsed.path == "/internal/callback-readiness":
            host = query.get("host", [""])[0]
            with lock:
                mode = state["mode"]
                state["calls"] += 1
                state["active"] += 1
                state["maximum"] = max(state["maximum"], state["active"])
            try:
                if mode == "slow":
                    with joined:
                        allowed = joined.wait_for(lambda: state["joined"] == 31, timeout=3)
                else:
                    allowed = mode == "ready" or (mode == "additive" and host == "dash.fixture.test")
            finally:
                with lock:
                    state["active"] -= 1
            self.send_response(204 if allowed else 503)
        else:
            self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


class PaperclipFixture(BaseHTTPRequestHandler):
    """Synthetic local_trusted/agent boundary, not the upstream application.

    Reproduce the installed application's observed 200 without Authorization
    versus 401 for a foreign Bearer. Never turn an invalid native credential
    into trusted browser access, and never echo any received header value.
    """
    def log_message(self, *_args):
        pass

    def do_GET(self):
        authorization = self.headers.get("Authorization")
        if authorization and authorization != "Bearer fixture-paperclip-agent":
            status, content_type = 401, "application/json"
            body = b'{"error":"Agent token did not verify; obtain fresh credentials and retry"}'
        elif self.path.startswith("/api/"):
            status, content_type = 200, "application/json"
            body = json.dumps({"actor": "agent" if authorization else "browser"}).encode()
        else:
            status, content_type = 200, "text/html"
            body = b"<!doctype html><button onclick=\"document.querySelector('output').textContent='clicked'\">Paperclip fixture</button><output>ready</output>"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


callback_gate.STATUS_URL = "http://127.0.0.1:8082/internal/callback-readiness"
callback_gate.Future = ReadinessFuture
gate = callback_gate.start(cert_dir="/app/gate-valid")
expired_gate = callback_gate.start(port=8083, cert_dir="/app/gate-expired")
threading.Thread(target=ThreadingHTTPServer(("0.0.0.0", 8082), Fixture).serve_forever, daemon=True).start()
threading.Thread(target=ThreadingHTTPServer(("0.0.0.0", 8084), PaperclipFixture).serve_forever, daemon=True).start()
server = runpy.run_path("/app/server.py")
# Keep authentication, userinfo, role and error handling real. This fixture
# has no Kubernetes API, so only fixed, UID-bound instance records are supplied.
server["Handler"].handle_instance_guard.__globals__["app_instance"] = lambda name: {
    "metadata": {"name": name, "uid": "fixture-owner"},
    "spec": {"enabled": True, "access": {"authentication": "sso", "role": "admin" if name.endswith("-denied") else "user"}},
} if name in {"hermes-fixture", "hermes-denied", "paperclip-fixture", "paperclip-denied"} else None
ThreadingHTTPServer(("0.0.0.0", 8080), server["Handler"]).serve_forever()
