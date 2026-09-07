#!/usr/bin/env python3
"""Opt-in integration test: real API + Kubernetes storage, synthetic userinfo.

Requires locally built magicstick-api:license-test and dashboard client bundles.
Never uses the current kubectl context. Creates and removes only its own random
namespace. Signing keys/tokens are ephemeral; no production credentials used.
--serve keeps a loopback-only UI fixture open until Ctrl+C for browser testing.
--web also deploys the standard frontend and runs Chrome against its real API proxy.
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


def available_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--web', action='store_true')
    args = parser.parse_args()
    namespace = 'magicstick-license-test-' + uuid.uuid4().hex[:8]
    api_port = available_port()
    api_url = f'http://127.0.0.1:{api_port}'
    web_port = available_port() if args.web else None
    web_url = f'http://127.0.0.1:{web_port}' if args.web else None
    allowed_origins = ['http://127.0.0.1:18082']
    if web_url:
        allowed_origins.append(web_url)
    subprocess.run(['docker', '--context', CONTEXT, 'image', 'inspect', 'magicstick-api:license-test'], check=True, stdout=subprocess.DEVNULL)
    key = Ed25519PrivateKey.generate()
    now = int(time.time())
    tokens = {role: jwt.encode({'iss': 'https://id.example.local/realms/test', 'azp': 'magicstick-cli',
                              'exp': now + 3600, 'sub': role, 'realm_access': {'roles': ['magicstick-' + role]}},
                              key, algorithm='EdDSA') for role in ('admin', 'viewer')}
    test_public_key = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
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
                overrides = {'OIDC_USERINFO_URL': 'http://127.0.0.1:8082/userinfo', 'OIDC_EXPECTED_ISSUER': 'https://id.example.local/realms/test', 'DASHBOARD_ALLOWED_ORIGINS': ','.join(allowed_origins), 'IDENTITY_MANAGEMENT_MODE': 'disabled'}
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
    official = yaml.safe_load((BASE / 'license-official-trust.yaml').read_text())
    official['metadata']['namespace'] = namespace
    release_trust = json.loads(official['data']['trusted-keys.json'])
    assert release_trust['keys'] and 'ephemeral-test' not in release_trust['keys']
    trust = json.dumps({**release_trust, 'keys': {**release_trust['keys'], 'ephemeral-test': test_public_key}})
    # Retain the shipped public keys, adding a signer only inside this fixture.
    # The manufacturer's private key is never read or needed for local tests.
    official['data']['trusted-keys.json'] = trust
    legacy = yaml.safe_load((BASE / 'license-trust.yaml').read_text())
    legacy['metadata']['namespace'] = namespace
    objects += [official, {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'ephemeral-userinfo', 'namespace': namespace}, 'stringData': {'tokens.json': json.dumps(tokens), 'idp.py': idp}}]
    forwarding = None
    web_forwarding = None
    created_namespace = False
    try:
        kubectl('create', '-f', '-', document=yaml.safe_dump(objects.pop(0)))
        created_namespace = True
        # Simulate the persisted empty trust store from an older installation.
        kubectl('create', '-f', '-', document=yaml.safe_dump(legacy))
        legacy_before = json.loads(kubectl('-n', namespace, 'get', 'configmap', 'magicstick-license-trust', '-o', 'json'))
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
        sharing = next(feature for feature in status['features'] if feature['id'] == 'resource-sharing')
        assert sharing['implemented'] and not sharing['licensed'] and not sharing['available']
        assert all(not feature['implemented'] and not feature['available']
                   for feature in status['features'] if feature['id'] != 'resource-sharing')
        assert status['trustedKeyIds'] == sorted(json.loads(trust)['keys']), 'Shipped public keys must load without populating the existing empty local store'
        legacy_after = json.loads(kubectl('-n', namespace, 'get', 'configmap', 'magicstick-license-trust', '-o', 'json'))
        assert legacy_after['data'] == legacy_before['data'] and legacy_after['metadata']['uid'] == legacy_before['metadata']['uid']
        print('PASS: shipped public keys load beside an unchanged existing empty legacy store; signing uses only an ephemeral test key', flush=True)
        claims = {'version': 1, 'product': 'magicstick', 'issuer': 'magicstick', 'licenseId': 'rancher-test', 'customer': 'Example organization',
                  'issuedAt': now - 1, 'notBefore': now - 1, 'expiresAt': now + 3600, 'features': list(FEATURES), 'installationId': status['installationId']}
        document = json.dumps({'format': FORMAT, 'token': jwt.encode(claims, key, algorithm='EdDSA', headers={'typ': TOKEN_TYPE, 'kid': 'ephemeral-test'})})
        request('POST', '/api/license/validate', {'document': document}, csrf=False, expected=403)
        assert request('POST', '/api/license/validate', {'document': document})['candidate']['valid']
        assert request()['state'] == 'missing', 'Preview must not save the license'
        result = request('PUT', body={'document': document, 'expectedRevision': status['revision']})
        sharing = next(feature for feature in result['features'] if feature['id'] == 'resource-sharing')
        assert result['valid'] and sharing['licensed'] and sharing['implemented'] and sharing['available']
        assert all(feature['licensed'] and not feature['implemented'] and not feature['available']
                   for feature in result['features'] if feature['id'] != 'resource-sharing')
        request('PUT', body={'document': document, 'expectedRevision': status['revision']}, expected=409)
        request('PUT', body={'document': '{}', 'expectedRevision': result['revision']}, expected=400)
        assert request('GET', '/api/license/export')['content'] == document
        print('PASS: authentication, admin-only access, CSRF, preview, activation of only the packaged capability, conflicts, invalid replacement, exact export', flush=True)

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

        def wait_for_trust(predicate):
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                current = request()
                if predicate(current):
                    return current
                time.sleep(1)
            raise RuntimeError('Mounted trust bundle did not update within 150 seconds')

        # Kubelet refreshes projected files asynchronously. No reloader is needed
        # for correctness: every API check rereads both mounted public stores.
        pod_uid = kubectl('-n', namespace, 'get', 'pods', '-l', 'app=ai-appliance-dashboard-api', '-o', 'jsonpath={.items[0].metadata.uid}')
        other = Ed25519PrivateKey.generate()
        other_pem = other.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        local_trust = json.dumps({'keys': {'local-test': other_pem, 'ephemeral-test': test_public_key}})
        kubectl('-n', namespace, 'patch', 'configmap', 'magicstick-license-trust', '--type=merge', '-p', json.dumps({'data': {'trusted-keys.json': local_trust}}))
        wait_for_trust(lambda state: 'local-test' in state['trustedKeyIds'] and state['valid'])
        retired = json.dumps({'keys': {'new-official-test': other_pem}, 'retiredKeyIds': ['ephemeral-test']})
        kubectl('-n', namespace, 'patch', 'configmap', 'magicstick-license-official-trust', '--type=merge', '-p', json.dumps({'data': {'trusted-keys.json': retired}}))
        wait_for_trust(lambda state: state['state'] == 'untrusted_key' and state['trustedKeyIds'] == ['local-test', 'new-official-test'])
        assert request('GET', '/api/license/export')['content'] == document
        assert kubectl('-n', namespace, 'get', 'secret', SECRET_NAME, '-o', 'jsonpath={.metadata.uid}') == uid
        # Restore fixture trust for the optional browser check.
        kubectl('-n', namespace, 'patch', 'configmap', 'magicstick-license-official-trust', '--type=merge', '-p', json.dumps({'data': {'trusted-keys.json': trust}}))
        wait_for_trust(lambda state: state['valid'] and 'ephemeral-test' in state['trustedKeyIds'])
        assert kubectl('-n', namespace, 'get', 'pods', '-l', 'app=ai-appliance-dashboard-api', '-o', 'jsonpath={.items[0].metadata.uid}') == pod_uid
        print('PASS: mounted official-key rotation/retirement, preserved local trust and license state, no Pod restart', flush=True)

        if args.web:
            subprocess.run(['docker', '--context', CONTEXT, 'image', 'inspect', 'magicstick-web:default-test'], check=True, stdout=subprocess.DEVNULL)
            # Keep production ports, selectors, probes and security settings. Only
            # the namespace, local image and isolated backend DNS name differ.
            web_objects = []
            for filename in ('deployment.yaml', 'service.yaml'):
                obj = yaml.safe_load((BASE / filename).read_text())
                obj['metadata']['namespace'] = namespace
                if obj['kind'] == 'Deployment':
                    pod = obj['spec']['template']['spec']
                    container = pod['containers'][0]
                    assert [item['name'] for item in pod['containers']] == ['web']
                    assert pod['automountServiceAccountToken'] is False
                    container['image'] = 'magicstick-web:default-test'
                    container['imagePullPolicy'] = 'Never'
                    container['volumeMounts'].append({'name': 'web-config', 'mountPath': '/etc/nginx/nginx.conf', 'subPath': 'nginx.conf', 'readOnly': True})
                    pod['volumes'].append({'name': 'web-config', 'configMap': {'name': 'web-test-config'}})
                web_objects.append(obj)
            nginx = (ROOT / 'dashboard/apps/web/nginx.conf').read_text()
            upstream = 'ai-appliance-dashboard-api.identity-system.svc.cluster.local'
            assert nginx.count(upstream) == 1
            nginx = nginx.replace(upstream, f'ai-appliance-dashboard-api.{namespace}.svc.cluster.local')
            web_objects += [
                {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'web-test-config', 'namespace': namespace}, 'data': {'nginx.conf': nginx}},
                {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'ai-appliance-dashboard-api', 'namespace': namespace},
                 'spec': {'selector': {'app': 'ai-appliance-dashboard-api'}, 'ports': [{'port': 8080, 'targetPort': 'api'}]}},
            ]
            kubectl('apply', '-f', '-', document=yaml.safe_dump_all(web_objects))
            kubectl('-n', namespace, 'rollout', 'status', 'deployment/ai-appliance-dashboard', '--timeout=120s')
            web_forwarding = subprocess.Popen(['kubectl', '--context', CONTEXT, '-n', namespace, 'port-forward', '--address=127.0.0.1', 'service/ai-appliance-dashboard', f'{web_port}:80'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    urllib.request.urlopen(web_url + '/healthz', timeout=1).close()
                    break
                except OSError:
                    if web_forwarding.poll() is not None:
                        raise RuntimeError('Frontend port-forward failed')
                    time.sleep(0.1)
            else:
                raise RuntimeError('Frontend port-forward not ready')
            browser_env = {**os.environ, 'MAGICSTICK_TEST_URL': web_url, 'MAGICSTICK_TEST_TOKENS': json.dumps(tokens), 'MAGICSTICK_TEST_LICENSE': document}
            subprocess.run(['node', str(ROOT / 'dashboard/apps/web/rancher_smoke.cjs')], env=browser_env, check=True)

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
        if web_forwarding:
            web_forwarding.terminate(); web_forwarding.wait(timeout=10)
        if forwarding:
            forwarding.terminate(); forwarding.wait(timeout=10)
        if created_namespace:
            kubectl('delete', 'namespace', namespace, '--wait=false', '--ignore-not-found=true')
            print('Removed isolated test namespace:', namespace, flush=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
