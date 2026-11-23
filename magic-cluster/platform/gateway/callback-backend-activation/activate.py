# SPDX-License-Identifier: BUSL-1.1
"""Enable Backend only after real fail-closed admission canaries pass.

Runs once as a restricted, declarative bootstrap Job. No Secret, credential,
raw API error, callback or header value is printed.
"""
import json
import os
from pathlib import Path
import ssl
import time
import urllib.error
import urllib.request

DIRECTORY = Path('/var/run/secrets/kubernetes.io/serviceaccount')
FLAG = '/api/v1/namespaces/envoy-gateway-system/configmaps/magicstick-callback-backend-activation'
NAMES = ('magicstick-callback-backend-only', 'magicstick-no-backend-tls-overrides',
         'magicstick-callback-ca-writers', 'magicstick-callback-gate-policies',
         'magicstick-security-baseline', 'magicstick-route-needs-callback-baseline',
         'magicstick-route-needs-security-baseline', 'magicstick-callback-filter-order')


def request(method, path, body=None):
    host = os.environ.get('KUBERNETES_SERVICE_HOST', 'kubernetes.default.svc')
    port = os.environ.get('KUBERNETES_SERVICE_PORT_HTTPS', '443')
    data = None if body is None else json.dumps(body).encode()
    headers = {'Authorization': 'Bearer ' + (DIRECTORY / 'token').read_text().strip(),
               'Content-Type': 'application/merge-patch+json' if method == 'PATCH' else 'application/json'}
    req = urllib.request.Request('https://' + host + ':' + port + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ssl.create_default_context(cafile=str(DIRECTORY / 'ca.crt')), timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def flag(enabled, proof=''):
    code, current = request('GET', FLAG)
    if code != 200 or not current.get('metadata', {}).get('resourceVersion'):
        raise RuntimeError('Activation flag is unavailable')
    code, _ = request('PATCH', FLAG, {'metadata': {'resourceVersion': current['metadata']['resourceVersion']},
                                    'data': {'enabled': 'true' if enabled else 'false', 'proof': proof}})
    if code != 200:
        raise RuntimeError('Activation flag could not be updated safely')


def snapshot():
    result = []
    for name in NAMES:
        code, policy = request('GET', '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/' + name)
        status = policy.get('status') or {}
        if (code != 200 or policy.get('spec', {}).get('failurePolicy') != 'Fail'
                or status.get('observedGeneration') != policy['metadata']['generation']
                or status.get('typeChecking', {}).get('expressionWarnings')):
            raise RuntimeError('Admission policy has not compiled safely')
        code, binding = request('GET', '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/' + name)
        if code != 200 or binding.get('spec', {}).get('policyName') != name or binding['spec'].get('validationActions') != ['Deny']:
            raise RuntimeError('Deny binding is unavailable')
        result.append((policy['metadata']['uid'], policy['metadata']['resourceVersion'],
                       binding['metadata']['uid'], binding['metadata']['resourceVersion']))
    return result


def prove():
    before = snapshot()
    canaries = [
        ('backends', 'magicstick-callback-backend-only', {'endpoints': [{'fqdn': {'hostname': 'unapproved.example.com', 'port': 443}}]}),
        ('envoyextensionpolicies', 'magicstick-callback-gate-policies',
         {'targetRefs': [{'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute', 'name': 'admission-canary'}],
          'lua': [{'type': 'ValueRef', 'valueRef': {'group': '', 'kind': 'ConfigMap', 'name': 'unapproved-canary'}}]}),
        ('securitypolicies', 'magicstick-security-baseline',
         {'targetRefs': [{'group': 'gateway.networking.k8s.io', 'kind': 'HTTPRoute', 'name': 'admission-canary'}],
          'authorization': {'defaultAction': 'Allow'}}),
    ]
    kinds = {'backends': 'Backend', 'envoyextensionpolicies': 'EnvoyExtensionPolicy', 'securitypolicies': 'SecurityPolicy'}
    for plural, name, spec in canaries:
        body = {'apiVersion': 'gateway.envoyproxy.io/v1alpha1', 'kind': kinds[plural],
                'metadata': {'name': 'magicstick-admission-canary', 'namespace': 'identity-system'}, 'spec': spec}
        code, status = request('POST', '/apis/gateway.envoyproxy.io/v1alpha1/namespaces/identity-system/' + plural + '?dryRun=All', body)
        if code not in (403, 422) or "ValidatingAdmissionPolicy '" + name + "'" not in status.get('message', ''):
            # RBAC/schema/transport denial is not evidence that CEL is active.
            raise RuntimeError('Admission deny canary was not enforced')
    if snapshot() != before:
        raise RuntimeError('Admission changed during verification')
    import hashlib
    return hashlib.sha256(json.dumps(before).encode()).hexdigest()


def main():
    flag(False)
    last_reason = None
    for _ in range(60):
        try:
            proof = prove()
            flag(True, proof)
            print('Callback Backend admission verified; activation enabled.')
            return
        except Exception as error:
            reason = str(error) if isinstance(error, RuntimeError) else 'Admission API is unavailable'
            if reason != last_reason:
                print('Callback activation waiting: ' + reason, flush=True)
                last_reason = reason
            time.sleep(2)
    raise SystemExit('Callback Backend remains disabled: admission verification failed.')


if __name__ == '__main__':
    main()
