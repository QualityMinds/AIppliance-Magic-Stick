# SPDX-License-Identifier: BUSL-1.1
"""Real API/controller contract. Only a named disposable Kind cluster is allowed.

No appliance context, raw request headers, tokens or Pod environments are read.
The caller owns cluster creation and always-cleanup (including on failure).
"""
import argparse
import copy
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

import yaml

ROOT = Path(__file__).resolve().parents[4]
IDENTITY = ROOT / 'magic-cluster/platform/identity'
PYTHON = 'python:3.13-alpine@sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kubeconfig', required=True)
    parser.add_argument('--context', required=True)
    parser.add_argument('--seed-legacy-route', action='store_true')
    parser.add_argument('--require-existing-route', action='store_true')
    args = parser.parse_args()
    if not args.context.startswith('kind-magicstick-cookie-guard-'):
        raise SystemExit('Only the disposable cookie-guard Kind context is permitted')
    base = ['kubectl', '--kubeconfig', args.kubeconfig, '--context', args.context]

    def call(*argv, data=None, ok=True):
        result = subprocess.run([*base, *argv], input=data, text=True, capture_output=True, timeout=120)
        if ok and result.returncode:
            # Only controlled synthetic manifests are submitted. Avoid dumping
            # commands/manifests, even though these identities are synthetic.
            raise RuntimeError('Isolated Kubernetes operation failed: ' + result.stderr[:1000])
        return result

    nodes = json.loads(call('get', 'nodes', '-o', 'json').stdout)['items']
    expected_node = args.context.removeprefix('kind-') + '-control-plane'
    if len(nodes) != 1 or nodes[0]['metadata']['name'] != expected_node:
        raise SystemExit('Unexpected test-cluster identity')

    def apply(*documents):
        call('apply', '-f', '-', data=yaml.safe_dump_all(documents))

    def wait(check, label, seconds=100):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if check():
                return
            time.sleep(1)
        raise AssertionError('Timed out: ' + label)

    def render(path):
        return [item for item in yaml.safe_load_all(call('kustomize', str(ROOT / path)).stdout) if item]

    bootstrap = render('magic-cluster/platform/identity-bootstrap')
    route_wave = render('magic-cluster/platform/identity/routes')
    if any(item['kind'] == 'HTTPRoute' for item in bootstrap) or not route_wave or \
            any(item['kind'] != 'HTTPRoute' for item in route_wave):
        raise AssertionError('Identity prerequisites and routes must occupy separate apply waves')

    def prerequisite(kind, name):
        return copy.deepcopy(next(item for item in bootstrap
                                  if item['kind'] == kind and item['metadata']['name'] == name))

    # The real Flux controller parses these expressions before source lookup.
    # Deliberately supply no GitRepository: this verifies the native reader's
    # syntax only, never claims a missing source as a successful reconciliation.
    source = call('get', 'gitrepository/flux-system', '-n', 'flux-system', ok=False)
    if source.returncode == 0 or 'NotFound' not in source.stderr:
        raise SystemExit('The disposable Flux parser fixture requires a confirmed absent source')
    graph = yaml.safe_load((ROOT / 'magic-cluster/flux/graph/base/08-identity-bootstrap.yaml').read_text())
    apply(graph)
    def flux_reader_parsed():
        item = json.loads(call('get', 'kustomization/identity-bootstrap', '-n', 'flux-system', '-o', 'json').stdout)
        ready = next((c for c in item.get('status', {}).get('conditions', []) if c['type'] == 'Ready'), {})
        if ready.get('reason') == 'InvalidCELExpression':
            raise AssertionError('Native Flux rejected the bootstrap health expressions')
        return ready.get('reason') == 'ArtifactFailed' and ready.get('observedGeneration') == item['metadata']['generation']
    wait(flux_reader_parsed, 'native Flux health reader parsed before expected missing-source failure')

    def deny(document, policy=True):
        result = call('create', '--dry-run=server', '-f', '-', data=yaml.safe_dump(document), ok=False)
        expected = 'ValidatingAdmissionPolicy' if policy else 'Invalid value'
        if result.returncode == 0 or expected not in result.stderr:
            raise AssertionError('Expected an actual API rejection: ' + result.stderr[:1000])

    apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'identity-system'}})
    route = {'apiVersion': 'gateway.networking.k8s.io/v1', 'kind': 'HTTPRoute',
             'metadata': {'name': 'fixture', 'namespace': 'identity-system',
                          'labels': {'magicstick.dev/test-fixture': 'callback-bootstrap'}},
             'spec': {'parentRefs': [{'group': 'gateway.networking.k8s.io', 'kind': 'Gateway',
                                      'name': 'identity-pilot', 'sectionName': 'https'}],
                      'hostnames': ['guard.fixture.test'],
                      'rules': [{'matches': [{'path': {'type': 'PathPrefix', 'value': '/'}}],
                                 'backendRefs': [{'group': '', 'kind': 'Service', 'weight': 1,
                                                  'name': 'ai-appliance-dashboard-api', 'port': 8080}]}]}}
    if args.seed_legacy_route:
        # Upgrade-only preparation, called before admission installation while
        # the Gateway Backend extension is still disabled. Never remove or
        # weaken a guard to manufacture the old state.
        for name in ('magicstick-route-needs-callback-baseline', 'magicstick-route-needs-security-baseline'):
            binding = call('get', 'validatingadmissionpolicybinding', name, ok=False)
            if binding.returncode == 0:
                raise SystemExit('Legacy fixture seeding requires a disposable pre-guard cluster')
            if 'NotFound' not in binding.stderr:
                raise SystemExit('Could not confirm absent admission binding for legacy fixture')
        apply(route)
        print('Seeded synthetic pre-guard route without a running backend or human credentials.')
        return
    previous = call('get', 'httproute/fixture', '-n', 'identity-system', '-o', 'json', ok=False)
    legacy_uid = None
    if previous.returncode == 0:
        legacy = json.loads(previous.stdout)
        if legacy['spec'] != route['spec'] or legacy['metadata'].get('labels', {}).get('magicstick.dev/test-fixture') != 'callback-bootstrap':
            raise SystemExit('Unexpected existing test route; refusing to adopt it')
        legacy_uid = legacy['metadata']['uid']
    if args.require_existing_route and not legacy_uid:
        raise SystemExit('The upgrade contract requires its pre-guard route')
    call('apply', '-k', str(ROOT / 'magic-cluster/platform/gateway/callback-backend-admission'))
    wait(lambda: all(item.get('status', {}).get('observedGeneration') == item['metadata']['generation']
                     for item in json.loads(call('get', 'validatingadmissionpolicies', '-o', 'json').stdout)['items']),
         'admission compilation')
    warnings = [item for item in json.loads(call('get', 'validatingadmissionpolicies', '-o', 'json').stdout)['items']
                if item.get('status', {}).get('typeChecking', {}).get('expressionWarnings')]
    if warnings:
        raise AssertionError('Admission CEL type checking produced warnings')
    if call('get', 'envoyextensionpolicy/magicstick-cookie-migration', '-n', 'identity-system', ok=False).returncode:
        fresh = copy.deepcopy(route)
        fresh['metadata']['name'] = 'fresh-fixture'
        deny(fresh)  # Fresh-install dependency absent: no unguarded route.
        combined = [prerequisite('EnvoyExtensionPolicy', 'magicstick-cookie-migration'),
                    prerequisite('SecurityPolicy', 'magicstick-default-deny'), route]
        result = call('apply', '--server-side', '--dry-run=server', '-f', '-',
                      data=yaml.safe_dump_all(combined), ok=False)
        if result.returncode == 0 or 'magicstick-route-needs-callback-baseline' not in result.stderr:
            raise AssertionError('The legacy combined Flux dry-run must reproduce the bootstrap deadlock')
        for kind, name in [('envoyextensionpolicy', 'magicstick-cookie-migration'),
                           ('securitypolicy', 'magicstick-default-deny')]:
            if call('get', kind, name, '-n', 'identity-system', ok=False).returncode == 0:
                raise AssertionError('A rejected dry-run must not persist its baseline prerequisites')
    setup_policy = {'apiVersion': 'gateway.envoyproxy.io/v1alpha1', 'kind': 'SecurityPolicy',
                    'metadata': {'name': 'magicstick-setup-local-only', 'namespace': 'identity-system'},
                    'spec': {'targetRefs': [{'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute', 'name': 'magicstick-setup-local'}],
                             'authorization': {'defaultAction': 'Deny', 'rules': [{'action': 'Allow', 'principal': {'clientCIDRs': ['192.168.0.0/16']}}]}}}
    call('create', '--dry-run=server', '-f', '-', data=yaml.safe_dump(setup_policy))
    unsafe_setup = copy.deepcopy(setup_policy)
    unsafe_setup['spec']['authorization']['rules'][0]['principal']['clientCIDRs'] = ['0.0.0.0/0']
    deny(unsafe_setup)

    with tempfile.TemporaryDirectory(prefix='magicstick-cookie-guard-material-') as work:
        directory = Path(work)
        commands = [
            ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Synthetic guard CA',
             '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash'],
            ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tls.key', '-out', 'tls.csr', '-subj', '/CN=guard.fixture.test'],
        ]
        for command in commands:
            subprocess.run(['openssl', *command], cwd=work, check=True, capture_output=True, timeout=30)
        (directory / 'extensions').write_text('subjectAltName=DNS:guard.fixture.test,DNS:magicstick-callback-gate.identity-system.svc.cluster.local\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
        subprocess.run(['openssl', 'x509', '-req', '-in', 'tls.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
                        '-out', 'tls.crt', '-days', '1', '-extfile', 'extensions'], cwd=work, check=True, capture_output=True)
        apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'fixture-tls', 'namespace': 'identity-system'},
               'type': 'kubernetes.io/tls', 'stringData': {name: (directory / name).read_text() for name in ('tls.crt', 'tls.key')}})
        # Exercise the same narrowly authorized CA writer used in deployment.
        apply({'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'Role', 'metadata': {'name': 'fixture-ca-writer', 'namespace': 'identity-system'},
               'rules': [{'apiGroups': [''], 'resources': ['configmaps'], 'verbs': ['get', 'create', 'patch']}]},
              {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'RoleBinding', 'metadata': {'name': 'fixture-ca-writer', 'namespace': 'identity-system'},
               'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': 'fixture-ca-writer'},
               'subjects': [{'kind': 'ServiceAccount', 'name': 'kustomize-controller', 'namespace': 'flux-system'}]})
        ca = {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'magicstick-callback-gate-ca', 'namespace': 'identity-system'},
              'data': {'ca.crt': (directory / 'ca.crt').read_text()}}
        call('--as=system:serviceaccount:flux-system:kustomize-controller', 'apply', '-f', '-', data=yaml.safe_dump(ca))
        fixture = """from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import callback_gate
class Handler(BaseHTTPRequestHandler):
 def log_message(self, *args): pass
 def do_GET(self):
  self.send_response(200); self.end_headers(); self.wfile.write(b'backend reached')
server=callback_gate.start(cert_dir='/tls')
# The decision is synthetic; the real product gRPC stream/TLS is unchanged.
callback_gate.ready=lambda host: Path('/tmp/ready').exists()
ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
"""
        # Gate captures ready() as its constructor default, so replace that
        # function's body through its upstream status URL, not via monkeypatch.
        fixture = fixture.replace("callback_gate.ready=lambda host: Path('/tmp/ready').exists()", "callback_gate.STATUS_URL='http://127.0.0.1:8082/status'")
        fixture = fixture.replace('server=callback_gate.start(cert_dir=', "from threading import Thread\nclass Status(Handler):\n def do_GET(self):\n  self.send_response(204 if Path('/tmp/ready').exists() else 503); self.end_headers()\nThread(target=ThreadingHTTPServer(('127.0.0.1',8082),Status).serve_forever,daemon=True).start()\nserver=callback_gate.start(cert_dir=")
        migration = {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'magicstick-cookie-migration', 'namespace': 'identity-system'},
                     'data': {'lua': (IDENTITY / 'cookie-migration.lua').read_text()}}
        apply(migration, {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'fixture-code', 'namespace': 'identity-system'},
                          'data': {'callback_gate.py': (ROOT / 'dashboard/apps/api/callback_gate.py').read_text(), 'server.py': fixture}})
        pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'fixture', 'namespace': 'identity-system', 'labels': {'app': 'fixture'}},
               'spec': {'containers': [{'name': 'fixture', 'image': PYTHON, 'command': ['sh', '-ec',
                         'pip install --disable-pip-version-check grpcio==1.76.0 protobuf==6.33.6 xds-protos==1.76.0 >/dev/null 2>&1; exec python /code/server.py'],
                         'readinessProbe': {'httpGet': {'port': 8080, 'path': '/ready'}},
                         'volumeMounts': [{'name': 'code', 'mountPath': '/code', 'readOnly': True}, {'name': 'tls', 'mountPath': '/tls', 'readOnly': True}]}],
                        'volumes': [{'name': 'code', 'configMap': {'name': 'fixture-code'}}, {'name': 'tls', 'secret': {'secretName': 'fixture-tls'}}]}}
        call('delete', 'pod/fixture', '-n', 'identity-system', '--ignore-not-found=true')
        apply(pod)
        for name, port in [('ai-appliance-dashboard-api', 8080), ('magicstick-callback-gate', 8081)]:
            apply({'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': name, 'namespace': 'identity-system'},
                   'spec': {'selector': {'app': 'fixture'}, 'ports': [{'port': port, 'targetPort': port}]}})
        backend = prerequisite('Backend', 'magicstick-callback-gate')
        apply(backend)
        invalid = copy.deepcopy(backend)
        invalid['metadata']['name'] = 'unapproved-fixture'
        deny(invalid)
        invalid = copy.deepcopy(backend)
        invalid['spec']['tls']['insecureSkipVerify'] = True
        invalid['metadata']['name'] = 'unsafe-fixture'
        deny(invalid, policy=False)  # The CRD itself forbids skip-verify + CA.
        apply(*yaml.safe_load_all((IDENTITY / 'default-deny-policy.yaml').read_text()))
        root_gate = prerequisite('EnvoyExtensionPolicy', 'magicstick-cookie-migration')
        apply(root_gate)
        gateway = {'apiVersion': 'gateway.networking.k8s.io/v1', 'kind': 'Gateway', 'metadata': {'name': 'identity-pilot', 'namespace': 'identity-system'},
                   'spec': {'gatewayClassName': 'fixture', 'listeners': [{'name': 'https', 'port': 443, 'protocol': 'HTTPS',
                             'tls': {'mode': 'Terminate', 'certificateRefs': [{'name': 'fixture-tls'}]}}]}}
        proxy = next(yaml.safe_load_all((IDENTITY / 'gateway.yaml').read_text()))
        gateway['spec']['infrastructure'] = {'parametersRef': {'group': 'gateway.envoyproxy.io', 'kind': 'EnvoyProxy', 'name': 'identity-pilot'}}
        apply(proxy, {'apiVersion': 'gateway.networking.k8s.io/v1', 'kind': 'GatewayClass', 'metadata': {'name': 'fixture'},
               'spec': {'controllerName': 'gateway.envoyproxy.io/gatewayclass-controller'}}, gateway)
        def baseline_accepted(kind, name):
            item = json.loads(call('get', kind, name, '-n', 'identity-system', '-o', 'json').stdout)
            return any(c.get('type') == 'Accepted' and c.get('status') == 'True' and
                       c.get('observedGeneration') == item['metadata']['generation']
                       for ancestor in item.get('status', {}).get('ancestors', []) for c in ancestor.get('conditions', []))
        wait(lambda: baseline_accepted('envoyextensionpolicy', 'magicstick-cookie-migration') and
                     baseline_accepted('securitypolicy', 'magicstick-default-deny'), 'current controller baseline acceptance')
        # The exact route-only product wave now passes the same server-side
        # dry-run used before Flux apply. No exception or Deny rule was removed.
        rendered_routes = yaml.safe_dump_all(route_wave).replace(
            '${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}', 'fixture.test')
        call('apply', '--server-side', '--dry-run=server', '-f', '-', data=rendered_routes)
        call('apply', '--server-side', '--dry-run=server', '-f', '-', data=yaml.safe_dump(route))
        policy = {'apiVersion': 'gateway.envoyproxy.io/v1alpha1', 'kind': 'SecurityPolicy',
                  'metadata': {'name': 'fixture', 'namespace': 'identity-system'},
                  'spec': {'targetRefs': [{'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute', 'name': 'fixture'}],
                           'extAuth': {'failOpen': False, 'http': {'backendRefs': [{'name': 'ai-appliance-dashboard-api', 'port': 8080}], 'path': '/internal/session-access'}}}}
        apply(policy, route)
        if legacy_uid and json.loads(call('get', 'httproute/fixture', '-n', 'identity-system', '-o', 'json').stdout)['metadata']['uid'] != legacy_uid:
            raise AssertionError('The upgrade replaced its legacy route instead of updating it')
        child_gate = copy.deepcopy(root_gate)
        child_gate['metadata']['name'] = 'fixture'
        child_gate['spec']['targetRefs'] = [{'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute', 'name': 'fixture'}]
        apply(child_gate)
        call('wait', '--for=condition=Ready', 'pod/fixture', '-n', 'identity-system', '--timeout=110s')
        # Kind has no external LoadBalancer address. Verify the translated
        # listener and then its real TLS data path, not a fabricated LB status.
        wait(lambda: any(c.get('type') == 'Programmed' and c.get('status') == 'True'
                         for listener in json.loads(call('get', 'gateway/identity-pilot', '-n', 'identity-system', '-o', 'json').stdout).get('status', {}).get('listeners', [])
                         for c in listener.get('conditions', [])), 'translated listener')
        for resource in ('envoyextensionpolicy/magicstick-cookie-migration', 'securitypolicy/magicstick-default-deny'):
            result = call('delete', resource, '-n', 'identity-system', ok=False)
            if result.returncode == 0 or 'ValidatingAdmissionPolicy' not in result.stderr:
                raise AssertionError('A required baseline could be removed')
        # A syntactically valid empty override must not defeat the fallback.
        empty = copy.deepcopy(child_gate)
        empty['metadata']['name'] = 'unsafe-override'
        empty['spec'].pop('extProc')
        deny(empty)
        skip = copy.deepcopy(child_gate)
        skip['metadata']['name'] = 'unsafe-skip-headers'
        skip['spec']['extProc'][0]['processingMode'].pop('request')
        deny(skip)
        order = copy.deepcopy(proxy)
        order['metadata']['name'] = 'identity-pilot'
        order['spec']['filterOrder'][1] = {'name': 'envoy.filters.http.ext_proc', 'after': 'envoy.filters.http.oauth2'}
        # Exercise UPDATE rather than an AlreadyExists CREATE.
        result = call('apply', '--dry-run=server', '-f', '-', data=yaml.safe_dump(order), ok=False)
        if result.returncode == 0 or 'magicstick-callback-filter-order' not in result.stderr:
            raise AssertionError('Gate could be moved after OAuth')
        call('delete', 'envoyextensionpolicy/fixture', '-n', 'identity-system')
        services = json.loads(call('get', 'svc', '-n', 'envoy-gateway-system', '-o', 'json').stdout)['items']
        envoy = next(item['metadata']['name'] for item in services if item['metadata'].get('labels', {}).get('gateway.envoyproxy.io/owning-gateway-name') == 'identity-pilot')
        deployments = json.loads(call('get', 'deployments', '-n', 'envoy-gateway-system', '-l',
                                      'gateway.envoyproxy.io/owning-gateway-name=identity-pilot,gateway.envoyproxy.io/owning-gateway-namespace=identity-system', '-o', 'json').stdout)['items']
        if len(deployments) != 1:
            raise AssertionError('Expected exactly one owned synthetic Gateway deployment')
        call('rollout', 'status', 'deployment/' + deployments[0]['metadata']['name'],
             '-n', 'envoy-gateway-system', '--timeout=110s')
        forward = subprocess.Popen([*base, '-n', 'envoy-gateway-system', 'port-forward', '--address=127.0.0.1', 'service/' + envoy, ':443'],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            line = forward.stdout.readline()
            if not line.startswith('Forwarding from 127.0.0.1:'):
                raise AssertionError('Synthetic TLS port-forward did not establish its owned IPv4 loopback listener')
            port = int(line.split('127.0.0.1:')[1].split(' ')[0])
            # Connect to loopback but validate the correct synthetic hostname.
            import http.client
            context = ssl.create_default_context(cafile=str(directory / 'ca.crt'))
            class Connection(http.client.HTTPSConnection):
                def connect(self):
                    import socket
                    sock = socket.create_connection(('127.0.0.1', port), timeout=5)
                    self.sock = context.wrap_socket(sock, server_hostname='guard.fixture.test')
            def status():
                connection = Connection('guard.fixture.test', timeout=5)
                try:
                    connection.request('GET', '/', headers={'Host': 'guard.fixture.test', 'Cookie': 'synthetic=marker'})
                    response = connection.getresponse()
                    result = response.status
                    response.read()
                    return result
                except ssl.SSLCertVerificationError as error:
                    raise AssertionError('Synthetic TLS verification failed: code ' + str(error.verify_code)) from None
                except OSError:
                    return None
                finally:
                    connection.close()
            wait(lambda: status() == 503, 'missing child gate retains parent fail-closed decision')
            call('exec', '-n', 'identity-system', 'fixture', '--', 'python', '-c', "from pathlib import Path; Path('/tmp/ready').touch()")
            wait(lambda: status() == 200, 'healthy root fallback')
            call('delete', 'securitypolicy/fixture', '-n', 'identity-system')
            wait(lambda: status() == 403, 'missing route authentication falls back to deny')
            apply(policy)
            wait(lambda: status() == 200, 'restored route authentication')
            call('exec', '-n', 'identity-system', 'fixture', '--', 'python', '-c', "from pathlib import Path; Path('/tmp/ready').unlink()")
            wait(lambda: status() == 503, 'callback not ready fails closed again')
            # Prove real controller order before OAuth, not just handwritten
            # Envoy JSON. The synthetic IdP endpoints are never authenticated.
            apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'fixture-oidc', 'namespace': 'identity-system'},
                   'stringData': {'client-secret': 'synthetic-nonhuman-client-secret'}})
            oidc = copy.deepcopy(policy)
            oidc['spec']['oidc'] = {
                'clientID': 'synthetic', 'clientSecret': {'name': 'fixture-oidc'},
                'provider': {'issuer': 'https://id.fixture.test/realms/synthetic',
                             'authorizationEndpoint': 'https://id.fixture.test/authorize',
                             'tokenEndpoint': 'http://ai-appliance-dashboard-api.identity-system.svc.cluster.local:8080/token',
                             'endSessionEndpoint': 'https://id.fixture.test/logout'},
                'redirectURL': 'https://guard.fixture.test/oauth2/callback', 'logoutPath': '/logout',
                'cookieNames': {'accessToken': '__Host-MagicStickAccessToken', 'idToken': '__Host-MagicStickIDToken'}}
            apply(oidc)
            time.sleep(3)
            if status() != 503:
                raise AssertionError('OAuth ran before the closed callback gate')
            call('exec', '-n', 'identity-system', 'fixture', '--', 'python', '-c', "from pathlib import Path; Path('/tmp/ready').touch()")
            wait(lambda: status() in (302, 303), 'verified callback permits OAuth start')
        finally:
            forward.terminate()
            forward.wait(timeout=10)
    print('PASS: native admission/bootstrap, TLS root callback fallback, missing-policy deny and recovery (synthetic backend).')


if __name__ == '__main__':
    main()
