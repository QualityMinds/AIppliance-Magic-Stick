# SPDX-License-Identifier: BUSL-1.1
import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / 'magic-cluster/platform/gateway'
spec = importlib.util.spec_from_file_location('callback_activation', DIRECTORY / 'callback-backend-activation/activate.py')
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)


class ActivationTests(unittest.TestCase):
    def test_only_named_admission_denial_qualifies_not_schema_rbac_or_transport(self):
        names = ['magicstick-callback-backend-only', 'magicstick-callback-gate-policies', 'magicstick-security-baseline']
        for code in (403, 422):
            responses = [(code, {'message': "ValidatingAdmissionPolicy '" + name + "' denied request"}) for name in names]
            with (patch.object(activation, 'snapshot', return_value=[('uid', 'revision')]),
                  patch.object(activation, 'request', side_effect=responses) as request):
                self.assertEqual(len(activation.prove()), 64)
                self.assertTrue(all('?dryRun=All' in call.args[1] for call in request.call_args_list))
        for response in ((201, {}), (403, {'message': 'RBAC forbidden'}), (422, {'message': 'Schema invalid'}),
                         (503, {}), (403, {'message': "ValidatingAdmissionPolicy 'wrong-policy' denied request"})):
            with (patch.object(activation, 'snapshot', return_value=[('uid', 'revision')]),
                  patch.object(activation, 'request', return_value=response)):
                with self.assertRaises(RuntimeError):
                    activation.prove()

    def test_policy_revision_change_during_canary_does_not_enable(self):
        names = ['magicstick-callback-backend-only', 'magicstick-callback-gate-policies', 'magicstick-security-baseline']
        responses = [(422, {'message': "ValidatingAdmissionPolicy '" + name + "' denied request"}) for name in names]
        with (patch.object(activation, 'snapshot', side_effect=[[('uid', 'old')], [('uid', 'new')]]),
              patch.object(activation, 'request', side_effect=responses)):
            with self.assertRaisesRegex(RuntimeError, 'changed during'):
                activation.prove()

    def test_bootstrap_failure_leaves_backend_disabled(self):
        with (patch.object(activation, 'flag') as flag,
              patch.object(activation, 'prove', side_effect=RuntimeError('Admission changed during verification')),
              patch.object(activation.time, 'sleep')):
            with self.assertRaises(SystemExit):
                activation.main()
            flag.assert_called_once_with(False)

    def test_bootstrap_success_is_revision_bound(self):
        with (patch.object(activation, 'flag') as flag,
              patch.object(activation, 'prove', return_value='proof')):
            activation.main()
            self.assertEqual([call.args for call in flag.call_args_list], [(False,), (True, 'proof')])

    def test_canary_reads_every_declared_policy_and_binding(self):
        documents = []
        for path in (DIRECTORY / 'callback-backend-admission').glob('*.yaml'):
            documents.extend(item for item in yaml.safe_load_all(path.read_text()) if item)
        policies = {item['metadata']['name'] for item in documents if item['kind'] == 'ValidatingAdmissionPolicy'}
        bindings = {item['metadata']['name'] for item in documents if item['kind'] == 'ValidatingAdmissionPolicyBinding'}
        self.assertEqual(set(activation.NAMES), policies)
        self.assertEqual(policies, bindings)
        for document in documents:
            if document['kind'] == 'ValidatingAdmissionPolicy':
                self.assertEqual(document['spec']['failurePolicy'], 'Fail')
            if document['kind'] == 'ValidatingAdmissionPolicyBinding':
                self.assertEqual(document['spec']['validationActions'], ['Deny'])
                if 'paramRef' in document['spec']:
                    self.assertEqual(document['spec']['paramRef']['parameterNotFoundAction'], 'Deny')


class BootstrapCompositionTests(unittest.TestCase):
    def test_native_gate_covers_fresh_and_existing_route_upgrades(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/public-release-checks.yml').read_text())
        gate = workflow['jobs']['gateway-security']
        self.assertFalse(gate['strategy']['fail-fast'])
        self.assertEqual(gate['strategy']['matrix']['bootstrap'], ['fresh', 'upgrade'])
        commands = '\n'.join(step.get('run', '') for step in gate['steps'])
        self.assertIn('--seed-legacy-route', commands)
        self.assertIn('--require-existing-route', commands)
        self.assertIn('flux install --version=v2.9.2', commands)
        script = (ROOT / 'magic-cluster/platform/identity/tests/gateway_policy_contract.py').read_text()
        self.assertIn('legacy_uid', script)
        self.assertIn('InvalidCELExpression', script)
        self.assertNotIn("call('delete', 'validatingadmissionpolicy", script)

    def render(self, path):
        result = subprocess.run(['kubectl', 'kustomize', str(ROOT / path)],
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return [item for item in yaml.safe_load_all(result.stdout) if item]

    @staticmethod
    def identity(item):
        return item['apiVersion'], item['kind'], item['metadata'].get('namespace', ''), item['metadata']['name']

    def test_two_waves_are_an_exact_nonoverlapping_partition_of_identity(self):
        full = self.render('magic-cluster/platform/identity')
        bootstrap = self.render('magic-cluster/platform/identity-bootstrap')
        routes = self.render('magic-cluster/platform/identity/routes')
        self.assertTrue(routes)
        self.assertTrue(all(item['kind'] == 'HTTPRoute' for item in routes))
        self.assertFalse(any(item['kind'] == 'HTTPRoute' for item in bootstrap))
        first, second = ({self.identity(item): item for item in wave} for wave in (bootstrap, routes))
        self.assertFalse(first.keys() & second.keys())
        self.assertEqual({**first, **second}, {self.identity(item): item for item in full})
        names = {(item['kind'], item['metadata']['name']) for item in bootstrap}
        for required in [('Gateway', 'identity-pilot'), ('EnvoyExtensionPolicy', 'magicstick-cookie-migration'),
                         ('SecurityPolicy', 'magicstick-default-deny'), ('Backend', 'magicstick-callback-gate'),
                         ('ConfigMap', 'magicstick-cookie-migration'), ('Deployment', 'magicstick-setup')]:
            self.assertIn(required, names)

    def test_both_entrypoints_wait_for_current_root_policy_acceptance(self):
        for path in ('base', 'single-node'):
            graph = self.render('magic-cluster/flux/entrypoints/' + path)
            nodes = {item['metadata']['name']: item['spec'] for item in graph if item['kind'] == 'Kustomization'}
            bootstrap, routes = nodes['identity-bootstrap'], nodes['identity-pilot']
            self.assertEqual(routes['path'], './magic-cluster/platform/identity/routes')
            self.assertIn({'name': 'identity-bootstrap'}, routes['dependsOn'])
            self.assertIn({'name': 'callback-backend-activation'}, bootstrap['dependsOn'])
            self.assertTrue(bootstrap['prune'])
            self.assertTrue(routes['prune'])
            self.assertFalse(bootstrap['wait'])
            checks = {(item['kind'], item['name']) for item in bootstrap['healthChecks']}
            self.assertIn(('EnvoyExtensionPolicy', 'magicstick-cookie-migration'), checks)
            self.assertIn(('SecurityPolicy', 'magicstick-default-deny'), checks)
            self.assertIn(('Deployment', 'keycloak'), checks)
            self.assertIn(('StatefulSet', 'keycloak-postgresql'), checks)
            for check in bootstrap['healthCheckExprs']:
                self.assertNotIn('has(status)', check['current'])
                self.assertIn("c.type == 'Accepted' && c.status == 'True'", check['current'])
                self.assertIn('c.observedGeneration == metadata.generation', check['current'])


if __name__ == '__main__':
    unittest.main()
