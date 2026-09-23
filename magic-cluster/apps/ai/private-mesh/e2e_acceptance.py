"""Three real transport identities, two LiteLLM proxies and one CPU vLLM.

Developer-only isolated Job. The local backend inventory is a fixed test fixture;
Kubernetes discovery/RBAC is checked separately. No production routes or models
are changed. Prints assertions/status only, never credentials or chat contents.
"""
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import sys
import threading
import time
from types import SimpleNamespace
from urllib import request, error

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import test_support  # noqa: F401
from desktop_client import DesktopClient
from integration import ExportBridge, LiteLLM, ModelSync, json_request
from mesh_service import MeshError, MeshService, Store, canonical
from runtime import MeshRuntime, atomic_file, enrollment_exchange
from server import BoundedHTTPServer, handler


ROOT = Path('/test')


def wait_for(label, predicate, timeout=180):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            value = predicate()
            if value:
                print('READY ' + label, flush=True)
                return value
        except (MeshError, OSError):
            pass
        time.sleep(2)
    raise AssertionError('Timeout: ' + label)


def initialize():
    ROOT.mkdir(parents=True, exist_ok=True)
    atomic_file(ROOT / 'master', ('sk-' + secrets.token_urlsafe(32)).encode())
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Isolated mesh acceptance')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(hours=2)).add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), False)
            .sign(key, hashes.SHA256()))
    atomic_file(ROOT / 'ca.pem', cert.public_bytes(serialization.Encoding.PEM))
    atomic_file(ROOT / 'key.pem', key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    atomic_file(ROOT / 'litellm.yaml', b'''model_list: []
litellm_settings:
  callbacks: [mesh_qos.mesh_qos]
  turn_off_message_logging: true
general_settings:
  store_model_in_db: true
  disable_spend_logs: true
router_settings:
  num_retries: 0
''')
    print('Prepared isolated acceptance state')


def proxy():
    port, schema = sys.argv[2:4]
    # LiteLLM resolves configured callbacks beside the config, not PYTHONPATH.
    atomic_file(ROOT / 'mesh_qos.py', (Path(__file__).parent / 'mesh_qos.py').read_bytes())
    end = time.monotonic() + 120
    while time.monotonic() < end:
        try:
            with socket.create_connection(('127.0.0.1', 55432), timeout=2):
                break
        except OSError:
            time.sleep(1)
    env = dict(os.environ, PYTHONPATH='/input', LITELLM_MASTER_KEY=(ROOT / 'master').read_text(),
               DATABASE_URL=f'postgresql://postgres@127.0.0.1:55432/{schema}', STORE_MODEL_IN_DB='True',
               LITELLM_LOG='ERROR', LITELLM_TELEMETRY='False')
    os.execvpe('litellm', ['litellm', '--config', str(ROOT / 'litellm.yaml'), '--host', '127.0.0.1', '--port', port], env)


def run():
    master = (ROOT / 'master').read_text()
    a_lite, b_lite = LiteLLM('http://127.0.0.1:4001', master), LiteLLM('http://127.0.0.1:4002', master)
    wait_for('LiteLLM A', lambda: a_lite.admin('GET', '/health/liveliness'), 600)
    wait_for('LiteLLM B', lambda: b_lite.admin('GET', '/health/liveliness'), 600)
    wait_for('CPU vLLM', lambda: json_request('http://127.0.0.1:8000/v1/models'), 1800)
    preflight = json_request('http://127.0.0.1:8000/v1/chat/completions', 'POST', {
        'model': 'qwen', 'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 4, 'temperature': 0}, timeout=60)
    assert preflight.get('choices'), 'Synthetic backend preflight failed'
    print('PASS synthetic backend inference preflight', flush=True)
    for url in (a_lite.base, b_lite.base):
        assert json_request(url + '/model/info', token=master).get('data') == []
    binary = Path(os.environ['MESH_BINARY']).read_bytes()
    assert b'owner control is disabled in the private embedding' in binary, 'Native control-plane hardening was not built'
    results, priorities, servers = [], [], []
    stopping = threading.Event()
    failures = []

    # Records only trusted priority values then forwards to real vLLM. This is
    # an observation point, not a model stub or a second inference runtime.
    from http.server import BaseHTTPRequestHandler
    class BackendObserver(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            priorities.append(body.get('priority'))
            try:
                result = json_request('http://127.0.0.1:8000' + self.path, 'POST', body, timeout=120)
                raw = canonical(result)
                self.send_response(200)
            except MeshError as exc:
                raw = canonical({'error': {'message': 'Test backend unavailable'}})
                self.send_response(exc.status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    def start(port, handle, tls=False):
        server = BoundedHTTPServer(('127.0.0.1', port), handle)
        if tls:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(ROOT / 'ca.pem', ROOT / 'key.pem')
            server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return server

    inventory = {'qwen': {'uid': 'isolated-local-vllm-fixture', 'source': 'kubeai', 'engine': 'VLLM', 'ready': True}}
    a = MeshService(Store(str(ROOT / 'a.db')), lambda: inventory)
    b = MeshService(Store(str(ROOT / 'b.db')), lambda: {})
    ca = (ROOT / 'ca.pem').read_text()
    a.createMesh('acceptance-mesh', 'stick-a', 'https://127.0.0.1:19443', hashlib.sha256(ca.encode()).hexdigest(), ca_certificate=ca)
    a.shareModel('qwen', {'enabled': True, 'maxOutput': 128, 'rpm': 50, 'tpm': 100000})
    a_token, b_token = secrets.token_hex(32), secrets.token_hex(32)
    ar = MeshRuntime(a, ROOT / 'a-runtime', a_token, 19337, 13131, 18101)
    br = MeshRuntime(b, ROOT / 'b-runtime', b_token, 19338, 13132, 18111)
    c = DesktopClient(ROOT / 'c', os.environ['MESH_BINARY'], os.environ['MESH_BINARY_CHECKSUM'])
    a_app = SimpleNamespace(service=a, store=a.store, bridge=ExportBridge(a, a_lite.base, a_token), wake=threading.Event())
    b_app = SimpleNamespace(service=b, store=b.store, bridge=ExportBridge(b, b_lite.base, b_token), runtime=br,
                            import_token=secrets.token_hex(32), outgoing={'requests': 0, 'errors': 0, 'active': 0})
    sa = ModelSync(a, a_lite, ar.models, 'http://127.0.0.1:18150/v1', 'http://127.0.0.1:18102/v1', secrets.token_hex(32), grace=5)
    sb = ModelSync(b, b_lite, br.models, 'http://127.0.0.1:18150/v1', 'http://127.0.0.1:18112/v1', b_app.import_token, grace=5)
    start(18150, BackendObserver)
    start(18101, handler(a_app, 'export'))
    start(18111, handler(b_app, 'export'))
    start(18112, handler(b_app, 'import'))
    start(19443, handler(a_app, 'enrollment'), tls=True)

    def tick():
        while not stopping.is_set():
            try:
                a.refreshMembership(enrollment_exchange)
                ar.reconcile()
                try:
                    status = ar.status()
                    if status.get('token'):
                        with a.store.change() as state:
                            state['bootstrap'] = status['token']
                except MeshError:
                    pass
                if b.store.read().get('mesh'):
                    b.refreshMembership(enrollment_exchange)
                    br.reconcile()
                sa.reconcile()
                if b.store.read().get('mesh'):
                    sb.reconcile()
                failures.clear()
            except Exception as exc:
                failures[:] = [type(exc).__name__ + ':' + (exc.code if isinstance(exc, MeshError) else 'runtime')]
            stopping.wait(1)
    worker = threading.Thread(target=tick, daemon=True)
    client_worker = threading.Thread(target=c.loop, daemon=True)
    worker.start()
    client_worker.start()
    try:
        wait_for('A restricted export key', lambda: bool(a.store.read().get('exportKeys')))
        key = a.store.read()['exportKeys']['share/stick-a/qwen']['key']
        try:
            json_request(a_lite.base + '/model/info', token=key)
            raise AssertionError('Export key reached the admin API')
        except MeshError as exc:
            assert exc.status in {401, 403}
        results.append('restricted LiteLLM export key')
        wait_for('A bootstrap', lambda: a.store.read().get('bootstrap'))
        invite_b = a.createInvite('magic-stick', 'acceptance')
        b.joinMesh(invite_b['token'], 'stick-b', enrollment_exchange)
        invite_c = a.createInvite('client', 'acceptance')
        c.command('/join', {'token': invite_c['token'], 'nodeName': 'laptop-c'})
        wait_for('Mesh B discovers A', lambda: any(m.get('id') == 'share/stick-a/qwen' for m in br.models().get('data', [])))
        wait_for('LiteLLM B synchronized alias', lambda: any(m['model_name'] == 'mesh/stick-a/qwen' for m in b_lite.deployments()))
        wait_for('Laptop C discovers A', lambda: 'share/stick-a/qwen' in c.status()['models'])
        results.append('A + B + laptop C real QUIC discovery and dynamic LiteLLM registration')
        payload = {'messages': [{'role': 'user', 'content': 'Reply with one short greeting.'}], 'max_tokens': 16, 'stream': False, 'temperature': 0}
        response = json_request(b_lite.base + '/v1/chat/completions', 'POST', {**payload, 'model': 'mesh/stick-a/qwen', 'priority': -1000}, master, timeout=180)
        assert response.get('choices'), 'No real vLLM completion through B'
        assert priorities[-1] == 10, 'Remote priority is not controlled by the server'
        results.append('LiteLLM B -> Mesh B -> Mesh A -> Bridge -> restricted LiteLLM A -> vLLM')
        response = c.command('/v1/chat/completions', {**payload, 'model': 'share/stick-a/qwen'})
        assert response.get('choices') and priorities[-1] == 10
        results.append('consume-only laptop inference')
        response = json_request(a_lite.base + '/v1/chat/completions', 'POST', {**payload, 'model': 'local/qwen', 'priority': 999}, master, timeout=180)
        assert response.get('choices') and priorities[-1] == 0
        results.append('local priority 0 / remote priority 10 at actual vLLM boundary')
        assert b.exportModels() == {}
        for service in (b, c.service):
            try:
                service.shareModel('mesh/stick-a/qwen', {'enabled': True})
                raise AssertionError('Imported model was re-exported')
            except MeshError:
                pass
        try:
            c.command('/invite', {'type': 'magic-stick'})
            raise AssertionError('Laptop authorized infrastructure')
        except MeshError as exc:
            assert exc.status == 403
        try:
            enrollment_exchange(c.service.store.read()['mesh'], '/mesh/heartbeat', c.service.memberRequest('/mesh/heartbeat', {'exports': {'share/laptop-c/evil': {'enabled': True}}}))
            raise AssertionError('Laptop advertised a model')
        except MeshError:
            pass
        results.append('client role and loop prevention')
        try:
            json_request('http://127.0.0.1:18101/v1/chat/completions', 'POST', {**payload, 'model': 'share/stick-a/qwen'})
            raise AssertionError('Unauthenticated export succeeded')
        except MeshError as exc:
            assert exc.status == 401
        results.append('export bridge rejects direct unauthenticated requests')
        a.unshareModel('qwen')
        wait_for('unshare removes B routes', lambda: not any(m['model_name'] == 'mesh/stick-a/qwen' for m in b_lite.deployments()))
        results.append('unshare removes imported routes without proxy restart')
        a.revokeNode(c.service.identity.endpoint)
        a.refreshMembership(enrollment_exchange)
        try:
            c.service.refreshMembership(enrollment_exchange)
            raise AssertionError('Revoked client refreshed membership')
        except MeshError:
            pass
        results.append('revoked client cannot renew authorization')
        # Exercise membership revocation without any license file.
        a.revokeNode(b.identity.endpoint)
        a.refreshMembership(enrollment_exchange)
        with b.store.change() as state:
            state['roster'] = {}
        try:
            json_request('http://127.0.0.1:18112/v1/chat/completions', 'POST', {**payload, 'model': 'share/stick-a/qwen'}, b_app.import_token)
            raise AssertionError('Revoked appliance imported a mesh model')
        except MeshError as exc:
            assert exc.status == 404
        try:
            a_app.bridge.authorize(a_token, b.identity.endpoint)
            raise AssertionError('Revoked peer received a mesh export')
        except MeshError as exc:
            assert exc.status == 403
        sa.reconcile()
        assert not a.store.read()['exportKeys']
        response = json_request(a_lite.base + '/v1/chat/completions', 'POST', {**payload, 'model': 'local/qwen'}, master, timeout=180)
        assert response.get('choices') and priorities[-1] == 0
        results.append('membership revocation blocks imports/exports while local inference survives')
        report = {'passed': results, 'backendRequests': len(priorities), 'priorityValues': sorted(set(priorities)),
                  'weights': 'synthetic deterministic Qwen2 fixture; no quality or GPU performance claim',
                  'inventory': 'isolated local fixture, not Kubernetes discovery', 'topology': 'three identities in one isolated pod; not a cross-NAT test'}
        atomic_file(ROOT / 'result.json', canonical(report))
        print(json.dumps(report, indent=2), flush=True)
    except Exception:
        print('Component error classes: ' + ','.join(failures), flush=True)
        for label, runtime in [('A', ar), ('B', br), ('C', c.runtime)]:
            print(label + ' process ' + str(None if runtime.process is None else runtime.process.poll()), flush=True)
        raise
    finally:
        stopping.set()
        c.stop.set()
        worker.join(timeout=20)
        client_worker.join(timeout=20)
        for runtime in (ar, br, c.runtime):
            runtime.stop()
        for server in servers:
            server.shutdown()
            server.server_close()
        for service in (a, b, c.service):
            service.store.db.close()


if __name__ == '__main__':
    {'init': initialize, 'proxy': proxy, 'run': run}[sys.argv[1]]()
