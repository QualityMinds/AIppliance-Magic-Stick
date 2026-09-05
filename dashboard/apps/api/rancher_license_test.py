#!/usr/bin/env python3
"""Opt-in integration test: real API + Kubernetes storage, synthetic userinfo.

Requires locally built magicstick-api:license-test and dashboard client bundles.
Never uses the current kubectl context. Creates and removes only its own random
namespace. Signing keys/tokens are ephemeral; no production credentials used.
--serve keeps a loopback-only UI fixture open until Ctrl+C for browser testing.
"""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

import jwt
import yaml
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from licensing import FEATURES, FORMAT, TOKEN_TYPE, SECRET_NAME

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'magic-cluster/apps/dashboard'
CONTEXT = 'rancher-desktop'


def kubectl(*args, document=None, allow_denial=False):
    result = subprocess.run(['kubectl', '--context', CONTEXT, *args], input=document, text=True, capture_output=True)
    if result.returncode and not (allow_denial and result.returncode == 1 and result.stdout.strip() == 'no'):
        raise RuntimeError('kubectl failed: ' + result.stderr[:1000])
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true')
    args = parser.parse_args()
    namespace = 'magicstick-license-test-' + uuid.uuid4().hex[:8]
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        api_port = listener.getsockname()[1]
    api_url = f'http://127.0.0.1:{api_port}'
    subprocess.run(['docker', '--context', CONTEXT, 'image', 'inspect', 'magicstick-api:license-test'], check=True, stdout=subprocess.DEVNULL)
    key = Ed25519PrivateKey.generate()
    now = int(time.time())
    tokens = {role: jwt.encode({'iss': 'https://id.example.local/realms/test', 'azp': 'magicstick-cli',
                              'exp': now + 3600, 'sub': role, 'realm_access': {'roles': ['magicstick-' + role]}},
                              key, algorithm='EdDSA') for role in ('admin', 'viewer')}
    trust = json.dumps({'keys': {'ephemeral-test': key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()}})
    objects = [{'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': namespace}},
               {'apiVersion': 'v1', 'kind': 'ServiceAccount', 'metadata': {'name': 'ai-appliance-dashboard-api', 'namespace': namespace}}]
    for filename in ('license-rbac.yaml', 'dashboard-api.yaml', 'api-deployment.yaml'):
        for obj in yaml.safe_load_all((BASE / filename).read_text()):
            obj['metadata']['namespace'] = namespace
            if obj['kind'] == 'RoleBinding':
                for subject in obj['subjects']:
                    subject['namespace'] = namespace
            if obj['kind'] == 'Deployment':
                pod = obj['spec']['template']['spec']
                container = pod['containers'][0]
                container['image'] = 'magicstick-api:license-test'
                container['imagePullPolicy'] = 'Never'
                overrides = {'OIDC_USERINFO_URL': 'http://127.0.0.1:8082/userinfo', 'OIDC_EXPECTED_ISSUER': 'https://id.example.local/realms/test', 'DASHBOARD_ALLOWED_ORIGINS': 'http://127.0.0.1:18082', 'IDENTITY_MANAGEMENT_MODE': 'disabled'}
                for env in container['env']:
                    if env['name'] in overrides:
                        env['value'] = overrides[env['name']]
                pod['containers'].append({'name': 'synthetic-userinfo', 'image': 'magicstick-api:license-test', 'imagePullPolicy': 'Never',
                                         'command': ['python', '/fixture/idp.py'], 'volumeMounts': [{'name': 'fixture', 'mountPath': '/fixture', 'readOnly': True}]})
                pod['volumes'].append({'name': 'fixture', 'secret': {'secretName': 'ephemeral-userinfo'}})
            objects.append(obj)
    idp = '''import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
tokens = json.loads(Path('/fixture/tokens.json').read_text())
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        role = next((role for role, token in tokens.items() if self.headers.get('Authorization') == 'Bearer ' + token), None)
        self.send_response(200 if role else 401); self.end_headers()
        self.wfile.write(json.dumps({'sub': role, 'preferred_username': role}).encode())
    def log_message(self, *args): pass
HTTPServer(('127.0.0.1', 8082), Handler).serve_forever()
'''
    objects += [{'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'magicstick-license-trust', 'namespace': namespace}, 'data': {'trusted-keys.json': trust}},
                {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'ephemeral-userinfo', 'namespace': namespace}, 'stringData': {'tokens.json': json.dumps(tokens), 'idp.py': idp}}]
    forwarding = None
    try:
        kubectl('create', '-f', '-', document=yaml.safe_dump_all(objects))
        print('Created isolated namespace:', namespace, flush=True)
        kubectl('-n', namespace, 'rollout', 'status', 'deployment/ai-appliance-dashboard-api', '--timeout=120s')

        def start_forward():
            process = subprocess.Popen(['kubectl', '--context', CONTEXT, '-n', namespace, 'port-forward', '--address=127.0.0.1', 'deployment/ai-appliance-dashboard-api', f'{api_port}:8080'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    urllib.request.urlopen(api_url + '/healthz', timeout=1).close()
                    return process
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError('Port-forward failed.')
                    time.sleep(0.1)
            process.terminate()
            raise RuntimeError('Port-forward not ready')

        forwarding = start_forward()

        def request(method='GET', path='/api/license', body=None, role='admin', csrf=True, expected=200):
            headers = {'Content-Type': 'application/json'}
            if role:
                headers['Authorization'] = 'Bearer ' + tokens[role]
            if csrf:
                headers['X-MagicStick-CSRF'] = 'dashboard'
            req = urllib.request.Request(api_url + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
            try:
                response = urllib.request.urlopen(req, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            assert response.status == expected, f'{method} {path}: expected {expected}, got {response.status}'
            payload = json.loads(response.read())
            assert response.headers.get('Cache-Control') == 'no-store'
            return payload

        request(role=None, expected=401)
        for method, path, body in [('GET', '/api/license', None), ('GET', '/api/license/export', None), ('POST', '/api/license/validate', {'document': '{}'}), ('PUT', '/api/license', {'document': '{}', 'expectedRevision': '0'})]:
            request(method, path, body, role='viewer', expected=403)
        status = request()
        assert status['state'] == 'missing'
        claims = {'version': 1, 'product': 'magicstick', 'issuer': 'magicstick', 'licenseId': 'rancher-test', 'customer': 'Example organization',
                  'issuedAt': now - 1, 'notBefore': now - 1, 'expiresAt': now + 3600, 'features': list(FEATURES), 'installationId': status['installationId']}
        document = json.dumps({'format': FORMAT, 'token': jwt.encode(claims, key, algorithm='EdDSA', headers={'typ': TOKEN_TYPE, 'kid': 'ephemeral-test'})})
        request('POST', '/api/license/validate', {'document': document}, csrf=False, expected=403)
        assert request('POST', '/api/license/validate', {'document': document})['candidate']['valid']
        assert request()['state'] == 'missing', 'Preview must not save the license'
        result = request('PUT', body={'document': document, 'expectedRevision': status['revision']})
        assert result['valid'] and all(f['licensed'] and not f['available'] for f in result['features'])
        request('PUT', body={'document': document, 'expectedRevision': status['revision']}, expected=409)
        request('PUT', body={'document': '{}', 'expectedRevision': result['revision']}, expected=400)
        assert request('GET', '/api/license/export')['content'] == document
        print('PASS: authentication, admin-only access, CSRF, preview, activation, conflicts, invalid replacement, exact export', flush=True)

        uid = kubectl('-n', namespace, 'get', 'secret', SECRET_NAME, '-o', 'jsonpath={.metadata.uid}')
        forwarding.terminate(); forwarding.wait(timeout=10); forwarding = None
        kubectl('-n', namespace, 'rollout', 'restart', 'deployment/ai-appliance-dashboard-api')
        kubectl('-n', namespace, 'rollout', 'status', 'deployment/ai-appliance-dashboard-api', '--timeout=120s')
        forwarding = start_forward()
        assert request()['installationId'] == status['installationId'] and request()['valid']
        assert kubectl('-n', namespace, 'get', 'secret', SECRET_NAME, '-o', 'jsonpath={.metadata.uid}') == uid
        print('PASS: Pod restart preserves installation ID, Secret UID and valid license', flush=True)
        assert kubectl('auth', 'can-i', 'list', 'secrets', '-n', namespace, '--as=system:serviceaccount:' + namespace + ':ai-appliance-dashboard-api', allow_denial=True).strip() == 'no'
        # CLI uses the same real API; the token is passed privately in its environment.
        env = {**os.environ, 'MAGICSTICK_ACCESS_TOKEN': tokens['admin'], 'MAGICSTICK_API_URL': api_url}
        cli = ['node', str(ROOT / 'dashboard/apps/cli/dist/magicstick.js')]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'license.json'
            path.write_text(document); path.chmod(0o600)
            for command in (['license', 'status', '--json'], ['license', 'inspect', str(path)], ['license', 'import', str(path), '--yes']):
                run = subprocess.run([*cli, *command], env=env, text=True, capture_output=True)
                assert run.returncode == 0, 'CLI license command failed: ' + run.stderr[:300]
        print('PASS: built CLI status, inspect and import against Rancher API', flush=True)

        if args.serve:
            class Preview(http.server.SimpleHTTPRequestHandler):
                def do_GET(self):
                    if self.path.startswith('/api/'):
                        self.proxy()
                    else:
                        super().do_GET()
                def do_POST(self): self.proxy()
                def do_PUT(self): self.proxy()
                def proxy(self):
                    body = self.rfile.read(int(self.headers.get('Content-Length', '0'))) or None
                    headers = {'Authorization': 'Bearer ' + tokens['admin'], 'Content-Type': 'application/json'}
                    for name in ('X-MagicStick-CSRF', 'Origin', 'Sec-Fetch-Site'):
                        if self.headers.get(name): headers[name] = self.headers[name]
                    req = urllib.request.Request(api_url + self.path, method=self.command, headers=headers, data=body)
                    try: response = urllib.request.urlopen(req, timeout=10)
                    except urllib.error.HTTPError as error: response = error
                    self.send_response(response.status); self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(response.read())
                def log_message(self, *args): pass
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 18082), functools.partial(Preview, directory=str(ROOT / 'dashboard/apps/web/dist')))
            print('Browser fixture: http://127.0.0.1:18082/#/license (synthetic admin, loopback only; Ctrl+C cleans up)', flush=True)
            server.serve_forever()
    finally:
        if forwarding:
            forwarding.terminate(); forwarding.wait(timeout=10)
        kubectl('delete', 'namespace', namespace, '--wait=false', '--ignore-not-found=true')
        print('Removed isolated test namespace:', namespace, flush=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
