"""Server-side priority policy for LiteLLM 1.84.0.

The proxy-authenticated key and router-selected deployment determine the class.
Neither request metadata nor a client-supplied priority selects MESH_REMOTE.
"""
from litellm.integrations.custom_logger import CustomLogger
from fastapi import HTTPException
import hmac
import json
import os
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


class TrafficMetrics:
    """Bounded, in-memory counters only; no prompts, responses, URLs or keys."""
    def __init__(self):
        self.lock = threading.Lock()
        self.by_model = {}

    def record(self, kwargs, start, end, failed):
        params = kwargs.get('litellm_params') or {}
        metadata = params.get('metadata') or kwargs.get('metadata') or {}
        info = metadata.get('model_info') or {}
        model = str(metadata.get('deployment_model_name') or kwargs.get('model') or 'unknown')[:200]
        traffic = 'MESH_REMOTE' if info.get('source') == 'mesh-export' else 'LOCAL'
        duration = max(0, (end - start).total_seconds())
        with self.lock:
            key = (traffic, model)
            if key not in self.by_model and len(self.by_model) >= 512:
                key = (traffic, 'other')
            row = self.by_model.setdefault(key, {'traffic': traffic, 'model': key[1], 'requests': 0, 'errors': 0, 'latencySeconds': 0.0})
            row['requests'] += 1
            row['errors'] += int(failed)
            row['latencySeconds'] += duration

    def snapshot(self):
        with self.lock:
            return {'semantics': 'completed_backend_attempts', 'byModel': [dict(row) for row in self.by_model.values()]}


traffic_metrics = TrafficMetrics()


def start_metrics_server():
    port = os.environ.get('MAGICSTICK_MESH_METRICS_PORT')
    if not port:
        return
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(3)

        def do_GET(self):
            try:
                token = Path('/var/run/magicstick-mesh/MESH_ADMIN_TOKEN').read_text().strip()
            except OSError:
                token = ''
            if self.path != '/metrics' or not token or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.send_error(403)
                return
            raw = json.dumps(traffic_metrics.snapshot()).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(raw)
    server = HTTPServer(('0.0.0.0', int(port)), Handler)
    threading.Thread(target=server.serve_forever, name='mesh-metrics', daemon=True).start()


class MeshQoS(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        traffic_metrics.record(kwargs, start_time, end_time, False)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        traffic_metrics.record(kwargs, start_time, end_time, True)

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        data.pop("priority", None)
        extra = data.get("extra_body")
        if isinstance(extra, dict):
            extra.pop("priority", None)
        remote = (getattr(user_api_key_dict, "metadata", None) or {}).get("magicstick_traffic_class") == "MESH_REMOTE"
        model = str(data.get("model", ""))
        if model.startswith("share/") != remote:
            raise HTTPException(status_code=403, detail="This key cannot use the requested model namespace.")
        if model.startswith(("local/", "mesh/", "share/")):
            for key in ("api_base", "base_url", "api_key", "fallbacks", "model_list", "deployment_id"):
                data.pop(key, None)
        return data

    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        metadata = kwargs.get("metadata") or kwargs.get("litellm_metadata") or {}
        info = metadata.get("model_info") or {}
        if info.get("magicstick_vllm_priority") is True:
            extra = dict(kwargs.get("extra_body") or {})
            extra["priority"] = 10 if info.get("source") == "mesh-export" else 0
            kwargs["extra_body"] = extra
        return kwargs


mesh_qos = MeshQoS()
start_metrics_server()
