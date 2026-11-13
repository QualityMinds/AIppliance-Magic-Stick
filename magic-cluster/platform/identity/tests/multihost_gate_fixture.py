# SPDX-License-Identifier: BUSL-1.1
"""Synthetic readiness control; real gRPC processor and API handler are used.

The control endpoint exists only on the disposable Docker test network. It is
not product code and does not model Kubernetes or Keycloak status provenance.
"""
import json
import runpy
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import callback_gate

state = {"mode": "ready", "active": 0, "maximum": 0, "calls": 0}
lock = threading.Lock()
gate = None


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
                    state.update(mode=mode, active=0, maximum=0, calls=0)
                self.send_response(204)
        elif parsed.path == "/metrics":
            with lock:
                payload = json.dumps({"maximum": state["maximum"], "calls": state["calls"]}).encode()
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
                    time.sleep(0.2)
                allowed = mode in {"ready", "slow"} or (mode == "additive" and host == "dash.fixture.test")
            finally:
                with lock:
                    state["active"] -= 1
            self.send_response(204 if allowed else 503)
        else:
            self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


callback_gate.STATUS_URL = "http://127.0.0.1:8082/internal/callback-readiness"
gate = callback_gate.start(cert_dir="/app/gate-valid")
expired_gate = callback_gate.start(port=8083, cert_dir="/app/gate-expired")
threading.Thread(target=ThreadingHTTPServer(("0.0.0.0", 8082), Fixture).serve_forever, daemon=True).start()
server = runpy.run_path("/app/server.py")
ThreadingHTTPServer(("0.0.0.0", 8080), server["Handler"]).serve_forever()
