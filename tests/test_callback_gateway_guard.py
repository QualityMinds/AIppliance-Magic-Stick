# SPDX-License-Identifier: BUSL-1.1
import importlib.util
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


if __name__ == '__main__':
    unittest.main()
