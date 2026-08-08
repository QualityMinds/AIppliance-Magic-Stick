#!/usr/bin/env python3
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODELS = ["aisix-contract-chat", "aisix-contract-embedding"]


class Handler(BaseHTTPRequestHandler):
    server_version = "MagicStickContractMock/1.0"

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)

    def write_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self.write_json(200, {"status": "ok"})
            return
        if self.path == "/v1/models":
            self.write_json(200, {"object": "list", "data": [{"id": model, "object": "model"} for model in MODELS]})
            return
        self.write_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.write_json(400, {"error": {"message": "invalid JSON", "type": "invalid_request_error"}})
            return

        if self.path == "/v1/chat/completions":
            model = request.get("model") or MODELS[0]
            if request.get("stream"):
                chunk = {
                    "id": "chatcmpl-contract",
                    "object": "chat.completion.chunk",
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": "ready"}, "finish_reason": None}],
                }
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            self.write_json(200, {
                "id": "chatcmpl-contract",
                "object": "chat.completion",
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "ready"},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
            return

        if self.path == "/v1/embeddings":
            values = request.get("input")
            count = len(values) if isinstance(values, list) else 1
            self.write_json(200, {
                "object": "list",
                "model": request.get("model") or MODELS[1],
                "data": [
                    {"object": "embedding", "index": index, "embedding": [0.125, -0.25, 0.5]}
                    for index in range(count)
                ],
                "usage": {"prompt_tokens": count, "total_tokens": count},
            })
            return

        self.write_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})


port = int(os.environ.get("PORT", "8080"))
ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
