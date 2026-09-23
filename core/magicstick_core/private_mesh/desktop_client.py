# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. See LICENSE.
"""Consume-only desktop companion; the packaged app opens its local browser UI.

It has no Kubernetes access, LiteLLM master key, export plugin or admin API.
Authorization also remains enforced by the exporting appliance's QUIC policy.
"""
import argparse
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler

from integration import json_request
from mesh_service import MeshService, MeshError, Store, canonical
from runtime import MeshRuntime, enrollment_exchange, transport_process_options
from server import BoundedHTTPServer


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class DesktopClient:
    def __init__(self, directory, binary, checksum):
        self.service = MeshService(Store(str(Path(directory) / 'client.db')), lambda: {}, consume_only=True)
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.token = secrets.token_urlsafe(32)
        # Applications receive a separate, inference-only credential. Never
        # disclose the browser's lifecycle/session token as an application key.
        self.api_token = secrets.token_urlsafe(32)
        self.nonce = secrets.token_urlsafe(24)
        self.error = None
        self.connected = False
        self.models = []
        os.environ['MESH_BINARY'] = str(binary)
        os.environ['MESH_BINARY_CHECKSUM'] = str(checksum)
        ports = set()
        while len(ports) < 3:
            ports.add(free_port())
        api, console, bridge = ports
        self.runtime = MeshRuntime(self.service, Path(directory) / 'runtime', secrets.token_hex(32), api, console, bridge)

    def loop(self):
        while not self.stop.is_set():
            with self.lock:
                try:
                    self.service.refreshMembership(enrollment_exchange)
                    self.runtime.reconcile()
                    if self.service.store.read().get('mesh'):
                        self.runtime.status()
                        roster = self.service.activeRoster()
                        allowed = {model for member in roster.get('members', {}).values() if not member['revoked'] and member['type'] == 'magic-stick' for model in member.get('exports', {})}
                        discovered = self.runtime.models().get('data', [])
                        self.models = sorted({item['id'] for item in discovered if item.get('id') in allowed})
                        peers = self.runtime.network().get('peers', [])
                        self.connected = bool(roster) and any(
                            peer.get('path') in {'direct', 'relay'}
                            and (roster.get('members', {}).get(peer.get('node_id')) or {}).get('type') == 'magic-stick'
                            and not roster['members'][peer['node_id']]['revoked'] for peer in peers)
                        self.error = None
                except (MeshError, OSError) as exc:
                    self.error = exc.code if isinstance(exc, MeshError) else 'configuration_error'
                    self.connected = False
                    self.models = []
            self.stop.wait(5)
        self.runtime.stop()

    def status(self):
        with self.lock:
            status = self.service.getStatus()
            return {'configured': status['configured'], 'connected': self.connected, 'mesh': (status.get('mesh') or {}).get('name'),
                    'node': (status.get('node') or {}).get('name'), 'role': 'client', 'models': list(self.models),
                    'relay': status['relay'], 'error': self.error}

    def command(self, path, payload):
        with self.lock:
            if path == '/join':
                invite = self.service.decodeInvite(payload.get('token', ''))
                if invite['type'] != 'client':
                    raise MeshError('Use a client invitation, not a Magic Stick invitation.', 403)
                self.service.joinMesh(payload.get('token', ''), payload.get('nodeName'), enrollment_exchange)
                return {'accepted': True}
            if path == '/leave':
                self.service.leaveMesh()
                self.runtime.stop()
                self.models, self.connected = [], False
                return {'accepted': True}
            if path == '/relay':
                return self.service.setRelayConfig(payload)
            if path == '/quit':
                self.stop.set()
                return {'accepted': True}
            if path != '/v1/chat/completions':
                raise MeshError('This client cannot configure infrastructure.', 403)
            if payload.get('stream') not in (None, False):
                raise MeshError('This local endpoint supports non-streaming chat only. Set stream to false.', 400)
            roster = self.service.activeRoster()
            allowed = {model for member in roster.get('members', {}).values() if not member['revoked'] and member['type'] == 'magic-stick' for model in member.get('exports', {})}
            if payload.get('model') not in allowed or payload.get('model') not in self.models:
                raise MeshError('The model is not available.', 404, 'model_unavailable')
            body = {key: value for key, value in payload.items() if key in {'model', 'messages', 'max_tokens', 'temperature'}}
            body['stream'] = False
        # Inference must not block the five-second membership refresh.
        return json_request(f'http://127.0.0.1:{self.runtime.api_port}/v1/chat/completions', 'POST', body, timeout=120)


def client_handler(app, asset):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def reply(self, payload, code=200, content_type='application/json'):
            raw = payload if isinstance(payload, bytes) else canonical(payload)
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'nonce-" + app.nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(raw)

        def authenticated(self):
            expected_host = f'127.0.0.1:{self.server.server_port}'
            if self.headers.get('Host') != expected_host or (self.headers.get('Origin') and self.headers['Origin'] != 'http://' + expected_host):
                raise MeshError('Untrusted browser origin.', 403)
            authorization = self.headers.get('Authorization', '')
            bearer = authorization[7:] if authorization.startswith('Bearer ') else ''
            session = self.headers.get('X-MagicStick-Session') or bearer
            if hmac.compare_digest(session, app.token):
                return
            if hmac.compare_digest(bearer, app.api_token):
                if (self.command, self.path) in {('GET', '/v1/models'), ('POST', '/v1/chat/completions')}:
                    return
                raise MeshError('This API key only permits model listing and chat completions.', 403)
            raise MeshError('Open the endpoint application to connect.', 401)

        def do_GET(self):
            try:
                if self.path == '/':
                    return self.reply(asset.replace(b'__NONCE__', app.nonce.encode()), content_type='text/html; charset=utf-8')
                self.authenticated()
                if self.path == '/status':
                    return self.reply(app.status())
                if self.path == '/connection':
                    return self.reply({'baseUrl': f'http://127.0.0.1:{self.server.server_port}/v1',
                                       'apiKey': app.api_token, 'streaming': False})
                if self.path == '/v1/models':
                    return self.reply({'object': 'list', 'data': [{'id': name, 'object': 'model'} for name in app.status()['models']]})
                raise MeshError('Not found.', 404)
            except MeshError as exc:
                self.reply({'error': str(exc)}, exc.status)

        def do_POST(self):
            try:
                self.authenticated()
                sizes = self.headers.get_all('Content-Length') or []
                if len(sizes) != 1 or not sizes[0].isdigit() or not 0 < int(sizes[0]) <= 1024 * 1024 or self.headers.get('Transfer-Encoding'):
                    raise MeshError('Invalid request size.', 413)
                if self.headers.get_content_type() != 'application/json':
                    raise MeshError('JSON is required.', 415)
                payload = json.loads(self.rfile.read(int(sizes[0])))
                if not isinstance(payload, dict):
                    raise MeshError('Invalid request.')
                self.reply(app.command(self.path, payload))
            except MeshError as exc:
                self.reply({'error': str(exc)}, exc.status)
            except (ValueError, OSError):
                self.reply({'error': 'The private mesh is unavailable.'}, 503)
    return Handler


def bundle_files(bundle):
    binary = bundle / ('mesh-llm.exe' if os.name == 'nt' else 'mesh-llm')
    checksum = bundle / 'magicstick-mesh.sha256'
    if not binary.exists() or not checksum.exists():
        raise ValueError('The companion bundle is incomplete. Install the complete application.')
    return binary, checksum


def companion_self_test(bundle):
    """Frozen-launch acceptance without browser, membership or persistent state."""
    binary, checksum = bundle_files(bundle)
    with binary.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if checksum.read_text(encoding='utf-8').split() != [actual, binary.name]:
        raise ValueError('Packaged transport checksum mismatch.')
    with tempfile.TemporaryDirectory(prefix='magicstick-client-self-test-') as directory:
        home = Path(directory) / 'native'
        home.mkdir()
        options = transport_process_options(home)
        options['env']['MESH_LLM_DATA_DIR'] = str(home / '.mesh-llm')
        native = subprocess.run([str(binary), '--version'], **options, cwd=home,
                                capture_output=True, text=True, timeout=30, check=True)
        if native.stdout.strip() != 'mesh-llm 0.76.2':
            raise ValueError('Unexpected packaged transport version.')
        app = DesktopClient(Path(directory) / 'client', binary, checksum)
        server = None
        thread = None
        try:
            app.runtime.reconcile()
            server = BoundedHTTPServer(('127.0.0.1', 0), client_handler(app, (bundle / 'client.html').read_bytes()))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def request(path, token=None, method='GET'):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    headers = {'Content-Type': 'application/json'}
                    if token:
                        headers['X-MagicStick-Session'] = token
                    connection.request(method, path, b'{}' if method == 'POST' else None, headers)
                    response = connection.getresponse()
                    return response.status, response.read()
                finally:
                    connection.close()

            code, html = request('/')
            if code != 200 or b'Private Mesh' not in html or app.token.encode() in html:
                raise ValueError('Packaged browser interface failed its startup check.')
            if request('/status')[0] != 401:
                raise ValueError('Unauthenticated client status was not rejected.')
            code, data = request('/status', app.token)
            status = json.loads(data)
            if code != 200 or status.get('configured') or status.get('role') != 'client':
                raise ValueError('Client startup status is invalid.')
            if request('/quit', app.token, 'POST')[0] != 200 or not app.stop.is_set():
                raise ValueError('Client shutdown check failed.')
        finally:
            if server:
                if thread:
                    server.shutdown()
                    thread.join(timeout=5)
                server.server_close()
            app.runtime.stop()
            app.service.store.db.close()
    return {'version': 1, 'platform': sys.platform, 'launcherVerified': True,
            'transportVerified': True, 'loopbackAuthVerified': True, 'meshInferenceVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test-report', type=Path, help='Check the packaged client with disposable state and write a CI report; never join a mesh.')
    args = parser.parse_args()
    bundle = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
    if args.self_test_report:
        try:
            report = companion_self_test(bundle)
        except Exception as error:
            args.self_test_report.write_text(json.dumps({'version': 1, 'error': type(error).__name__,
                                             'detail': str(error)[:1000]}) + '\n', encoding='utf-8')
            raise SystemExit(1) from None
        args.self_test_report.write_text(json.dumps(report) + '\n', encoding='utf-8')
        return
    binary, checksum = bundle_files(bundle)
    if sys.platform == 'darwin':
        directory = Path.home() / 'Library/Application Support/MagicStickMesh'
    elif os.name == 'nt':
        directory = Path(os.environ['LOCALAPPDATA']) / 'MagicStickMesh'
    else:
        directory = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'magicstick-mesh'
    app = DesktopClient(directory, binary, checksum)
    server = BoundedHTTPServer(('127.0.0.1', 0), client_handler(app, (bundle / 'client.html').read_bytes()))
    worker = threading.Thread(target=app.loop, daemon=True)
    worker.start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    webbrowser.open(f'http://127.0.0.1:{server.server_port}/#{app.token}')
    try:
        while not app.stop.wait(0.5):
            pass
    except KeyboardInterrupt:
        app.stop.set()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=20)
        app.runtime.stop()
        app.service.store.db.close()


if __name__ == '__main__':
    main()
