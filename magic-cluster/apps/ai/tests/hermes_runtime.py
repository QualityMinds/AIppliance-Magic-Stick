# SPDX-License-Identifier: BUSL-1.1
"""Run inside the selected Hermes image with networking disabled and fixtures only.

Use the native entrypoint, /opt/data/config.yaml fixture (synthetic-chat through
http://127.0.0.1:9001/v1), HERMES_DASHBOARD_HOST=127.0.0.1/PORT=9118, a
synthetic Secret key file and API_SERVER_KEY, and the proxy mounted at /proxy.
"""
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

seen = []


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/show":
            self.send_error(404)
            return
        assert self.path == "/v1/chat/completions", self.path
        assert self.headers["Authorization"] == "Bearer synthetic-litellm-key"
        assert body["model"] == "synthetic-chat", body["model"]
        seen.append(body)
        reply = {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1,
                 "model": "synthetic-chat", "choices": [{"index": 0,
                 "message": {"role": "assistant", "content": "synthetic Hermes response"},
                 "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}
        if body.get("stream"):
            chunk = {"id": reply["id"], "object": "chat.completion.chunk", "created": 1,
                     "model": "synthetic-chat", "choices": [{"index": 0,
                     "delta": {"role": "assistant", "content": "synthetic Hermes response"},
                     "finish_reason": None}]}
            final = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            data = (f"data: {json.dumps(chunk)}\n\ndata: {json.dumps(final)}\n\ndata: [DONE]\n\n").encode()
            content_type = "text/event-stream"
        else:
            data = json.dumps(reply).encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def request(path, *, port=9119, body=None, token=None):
    headers = {"Host": "hermes.example.local" if port == 9119 else "127.0.0.1",
               "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if body is None else json.dumps(body).encode()
    with urlopen(Request(f"http://127.0.0.1:{port}{path}", data, headers), timeout=90) as response:
        return response.read()


def main():
    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider
    config = load_config()
    runtime = resolve_runtime_provider(requested=config["model"]["provider"], target_model="synthetic-chat")
    assert runtime["base_url"] == "http://127.0.0.1:9001/v1"
    assert runtime["api_mode"] == "chat_completions"
    runtime_key = runtime["api_key"]() if callable(runtime["api_key"]) else runtime["api_key"]
    assert runtime_key == "synthetic-litellm-key"
    fixture = ThreadingHTTPServer(("127.0.0.1", 9001), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    from agent.auxiliary_client import resolve_provider_client
    from agent.secret_scope import reset_secret_scope, set_secret_scope
    scope = set_secret_scope({"OPENAI_API_KEY": "stale-profile-key"})
    try:
        client, model = resolve_provider_client("custom:litellm", model="synthetic-chat")
        assert client is not None
        reply = client.chat.completions.create(model=model,
            messages=[{"role": "user", "content": "Synthetic auxiliary request"}])
        assert reply.choices[0].message.content == "synthetic Hermes response"
        client.close()
    finally:
        reset_secret_scope(scope)
    gateway_log = open("/opt/data/fixture-gateway.log", "w")
    gateway = subprocess.Popen(["hermes", "gateway", "run"], stdout=gateway_log, stderr=subprocess.STDOUT)
    proxy = subprocess.Popen(["node", "/proxy/dashboard-proxy.cjs"], env={
        **os.environ, "POD_IP": "127.0.0.1", "HERMES_PROXY_HOSTS": '["hermes.example.local"]'})
    try:
        for _ in range(120):
            try:
                request("/api/health")
                request("/health", port=8443)
                break
            except Exception:
                if gateway.poll() is not None:
                    raise RuntimeError("Native Hermes gateway stopped; inspect synthetic fixture-gateway.log")
                time.sleep(1)
        else:
            raise RuntimeError("Hermes gateway/dashboard did not become ready")
        html = request("/").decode()
        assert "html" in html.lower()
        response = json.loads(request("/v1/chat/completions", port=8443,
            token=os.environ["API_SERVER_KEY"], body={"model": "synthetic-chat", "stream": False,
            "messages": [{"role": "user", "content": "Reply with a short message; use no tools."}]}))
        assert "synthetic Hermes response" in response["choices"][0]["message"]["content"]
        assert seen, "Native agent did not call the fixture"
        print("Hermes native provider, authenticated gateway request and proxied dashboard passed")
    finally:
        gateway.terminate()
        proxy.terminate()
        fixture.shutdown()
        gateway_log.close()


if __name__ == "__main__":
    main()
