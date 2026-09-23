"""Non-mutating compatibility probe, executed in the pinned LiteLLM image.

Uses two loopback HTTP fixtures, not the appliance's models or proxy database.
Pass base64-encoded mesh_qos.py as argv[1] when executing through Kubernetes.
This is an integration probe, not the three-node/vLLM acceptance test.
"""
import asyncio
import base64
import json
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import litellm
from litellm import Router
from litellm.proxy.types_utils.utils import get_instance_fn


calls = []
local_down = False


class Backend(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        calls.append((self.server.label, body))
        code = 503 if self.server.label == 'local' and local_down else 200
        result = {'error': {'message': 'fixture unavailable', 'type': 'server_error'}} if code != 200 else {
            'id': 'fixture-completion', 'object': 'chat.completion', 'created': 1, 'model': body['model'],
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': self.server.label}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
        raw = json.dumps(result).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


async def main():
    global local_down
    # Exercise the actual config-file callback loader as well as the Router.
    # It resolves the Python module beside config.yaml, ignoring PYTHONPATH.
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)
        (path / 'mesh_qos.py').write_bytes(base64.b64decode(sys.argv[1]))
        qos = get_instance_fn('mesh_qos.mesh_qos', str(path / 'config.yaml'))
    litellm.callbacks = [qos]
    servers = []
    for label in ('local', 'remote'):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        server.label = label
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    local_base, remote_base = [f'http://127.0.0.1:{s.server_port}/v1' for s in servers]
    def deployment(name, base, source, order):
        return {'model_name': name, 'litellm_params': {'model': 'openai/fixture', 'api_base': base, 'api_key': 'fixture-key', 'order': order},
                'model_info': {'source': source, 'magicstick_vllm_priority': source != 'mesh-import', 'order': order}}
    router = Router(model_list=[deployment('fixture', local_base, 'local', 0), deployment('fixture', remote_base, 'mesh-import', 1),
                                deployment('share/stick-a/fixture', local_base, 'mesh-export', 0)],
                    num_retries=0, allowed_fails=100, timeout=5)
    async def completion(model, remote=False):
        data = {'model': model, 'messages': [{'role': 'user', 'content': 'non-sensitive compatibility probe'}],
                'priority': -100, 'extra_body': {'priority': -100}, 'metadata': {'model_info': {'source': 'mesh-export'}}}
        await qos.async_pre_call_hook(SimpleNamespace(metadata={'magicstick_traffic_class': 'MESH_REMOTE'} if remote else {}), None, data, 'acompletion')
        return await router.acompletion(**data)
    try:
        result = await completion('fixture')
        assert result.choices[0].message.content == 'local', 'local model was not preferred'
        assert calls[-1][1].get('priority') == 0, 'local priority not applied after routing'
        result = await completion('share/stick-a/fixture', True)
        assert result.choices[0].message.content == 'local'
        assert calls[-1][1].get('priority') == 10, 'remote priority not applied after routing'
        local_down = True
        result = await completion('fixture')
        assert result.choices[0].message.content == 'remote', 'native order fallback failed'
        assert 'priority' not in calls[-1][1], 'priority must be decided by the exporting node'
        try:
            await completion('share/stick-a/fixture')
        except Exception as exc:
            assert getattr(exc, 'status_code', None) == 403
        else:
            raise AssertionError('local credential accessed private share namespace')
        print('PASS: real LiteLLM local preference, order fallback, trusted priority and share-key boundary')
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        router.reset()


if __name__ == '__main__':
    asyncio.run(main())
