"""Real three-identity discovery test; no inference/production resources."""
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace

import test_support  # noqa: F401
from desktop_client import free_port
from integration import ExportBridge
from mesh_service import MeshService, MeshError, Store
from runtime import MeshRuntime
from server import BoundedHTTPServer, handler


def main():
    used = set()
    def port():
        while True:
            value = free_port()
            if value not in used:
                used.add(value)
                return value
    services, runtimes, servers, process_logs = [], [], [], []
    original_popen = subprocess.Popen
    def diagnostic_popen(*args, **kwargs):
        log = tempfile.TemporaryFile()
        process_logs.append(log)
        kwargs['stderr'] = log
        return original_popen(*args, **kwargs)
    # Developer probe only: production never prints native logs containing
    # bootstrap tokens. Keep only bounded, redacted failure diagnostics here.
    subprocess.Popen = diagnostic_popen
    with tempfile.TemporaryDirectory(prefix='mesh-discovery-') as directory:
        try:
            for index in range(3):
                inventory = {'qwen': {'uid': 'fixture', 'ready': True, 'source': 'kubeai', 'engine': 'VLLM'}} if index == 0 else {}
                service = MeshService(Store(str(Path(directory) / f'{index}.db')), lambda inventory=inventory: inventory,
                                      consume_only=index == 2)
                token, bridge_port = secrets.token_hex(32), port()
                runtime = MeshRuntime(service, Path(directory) / f'{index}-runtime', token, port(), port(), bridge_port)
                bridge = ExportBridge(service, 'http://127.0.0.1:1', token)
                server = BoundedHTTPServer(('127.0.0.1', bridge_port), handler(SimpleNamespace(bridge=bridge), 'export'))
                threading.Thread(target=server.serve_forever, daemon=True).start()
                services.append(service)
                runtimes.append(runtime)
                servers.append(server)
            a, b, c = services
            a.createMesh('discovery-test', 'stick-a', 'https://example.local', '0' * 64)
            a.shareModel('qwen', {'enabled': True})
            def exchange(_mesh, path, payload):
                return a.enroll(payload) if path == '/mesh/enroll' else a.heartbeat(payload)
            joined = False
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                for index, (service, runtime) in enumerate(zip(services, runtimes)):
                    service.refreshMembership(exchange)
                    runtime.reconcile()
                    if index == 0:
                        try:
                            status = runtime.status()
                            # /api/status uses an abbreviated display id; the
                            # network diagnostics expose the full endpoint key.
                            assert runtime.network()['node_id'] == service.identity.endpoint, 'Native endpoint does not match enrolled identity'
                            with a.store.change() as state:
                                state['bootstrap'] = status['token']
                        except MeshError:
                            pass
                if not joined and a.store.read().get('bootstrap'):
                    for service, role, name in [(b, 'magic-stick', 'stick-b'), (c, 'client', 'laptop-c')]:
                        service.joinMesh(a.createInvite(role, 'discovery')['token'], name, exchange)
                    joined = True
                if joined:
                    try:
                        catalogs = [[m['id'] for m in runtime.models().get('data', [])] for runtime in runtimes]
                        if all('share/stick-a/qwen' in names for names in catalogs):
                            print('PASS: three real QUIC identities, exact endpoint binding and private export discovery')
                            # An attacker can modify its own policy and copy a
                            # bootstrap token, but cannot enter A's allowlist.
                            rogue = MeshService(Store(str(Path(directory) / 'rogue.db')), lambda: {}, consume_only=True)
                            services.append(rogue)
                            with rogue.store.change() as state:
                                state['mesh'] = a.store.read()['mesh']
                                state['node'] = {'id': rogue.identity.endpoint, 'name': 'uninvited', 'type': 'client'}
                                state['roster'] = a.activeRoster()
                                state['roster']['members'][rogue.identity.endpoint] = {'name': 'uninvited', 'type': 'client', 'revoked': False, 'exports': {}}
                            outsider = MeshRuntime(rogue, Path(directory) / 'rogue-runtime', secrets.token_hex(32), port(), port(), port())
                            runtimes.append(outsider)
                            outsider.reconcile()
                            denied = False
                            for _ in range(40):
                                log = process_logs[-1]
                                log.seek(0)
                                if b'closed by peer: private mesh only' in log.read(65536):
                                    denied = True
                                    break
                                time.sleep(1)
                            assert denied, 'No transport rejection observed for the uninvited endpoint'
                            try:
                                assert not any(item['id'].startswith('share/') for item in outsider.models().get('data', []))
                            except MeshError:
                                pass
                            print('PASS: copied bootstrap plus attacker-owned policy cannot admit an uninvited endpoint')
                            return
                    except MeshError:
                        pass
                time.sleep(1)
            for index, runtime in enumerate(runtimes):
                state = {'node': index, 'exitCode': None if runtime.process is None else runtime.process.poll()}
                try:
                    status = runtime.status()
                    state.update(serving=status.get('serving_models'), models=runtime.models(), peerCount=len(status.get('peers', [])))
                except MeshError:
                    state['api'] = 'unavailable'
                print(json.dumps(state))
            for log in process_logs:
                log.seek(0)
                for line in log.read(65536).decode(errors='replace').splitlines():
                    if not any(word in line.lower() for word in ('error', 'failed', 'panic')):
                        continue
                    line = re.sub(r'https?://\S+|/[\w/.-]+|[A-Za-z0-9_+/=-]{32,}', '[REDACTED]', line)
                    print(line[:300])
            raise AssertionError('Private native discovery timed out')
        finally:
            subprocess.Popen = original_popen
            for runtime in runtimes:
                runtime.stop()
            for server in servers:
                server.shutdown()
                server.server_close()
            for service in services:
                service.store.db.close()
            for log in process_logs:
                log.close()


if __name__ == '__main__':
    main()
