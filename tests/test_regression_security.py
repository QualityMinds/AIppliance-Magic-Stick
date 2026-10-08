"""Offline regression guards, not a claim of a current advisory/secret audit.

The existing release workflow runs the actual redacted Gitleaks scans. Fresh
dependency advisories remain an online CI gate; this suite proves known guards
and rejects security-control regressions in the shipped implementation.
"""
from pathlib import Path
import json
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


def unsafe_tls(source):
    return bool(re.search(r"rejectUnauthorized\s*:\s*false|ssl\._create_unverified_context\s*\(|verify\s*=\s*False|CERT_NONE|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['\"]?0", source))


class RegressionSecurityTests(unittest.TestCase):
    def test_registration_observer_can_read_only_the_immutable_lab_marker(self):
        documents = list(yaml.safe_load_all((ROOT / 'dashboard/apps/web/regression/lab-rbac.example.yaml').read_text()))
        role = next(item for item in documents if item['kind'] == 'Role' and item['metadata']['name'] == 'regression-registration-observer')
        self.assertEqual(role['metadata']['namespace'], 'magicstick-regression')
        self.assertEqual(role['rules'], [{'apiGroups': [''], 'resources': ['configmaps'], 'resourceNames': ['registered-lab'], 'verbs': ['get']}])
        binding = next(item for item in documents if item['kind'] == 'RoleBinding' and item['metadata']['name'] == role['metadata']['name'])
        self.assertEqual(binding['subjects'][0]['name'], 'regression-observer')

    def test_private_examples_never_implicitly_approve_operations(self):
        directory = ROOT / 'dashboard/apps/web/regression'
        def inspect(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key.startswith('approve') or key in {'allowFirstActivation', 'independentRecoveryAvailable'}:
                        self.assertIs(item, False, key)
                    inspect(item)
            elif isinstance(value, list):
                for item in value:
                    inspect(item)
        inspect(json.loads((directory / 'remaining-profile.example.json').read_text()))
        drills = json.loads((directory / 'host-drills.example.json').read_text())
        self.assertIs(drills['cases']['BOOT-02']['acknowledgeDisruption'], False)
        self.assertIs(drills['cases']['BOOT-02']['independentRecoveryAvailable'], False)

    def test_optional_lab_rbac_has_no_secret_wildcard_or_workload_create(self):
        filename = ROOT / 'dashboard/apps/web/regression/lab-rbac-administration.example.yaml'
        documents = list(yaml.safe_load_all(filename.read_text()))
        roles = {item['metadata']['name']: item for item in documents if item['kind'] in {'Role', 'ClusterRole'}}
        for item in roles.values():
            for rule in item['rules']:
                self.assertNotIn('secrets', rule['resources'])
                self.assertFalse(any('*' in resource or '/' in resource for resource in rule['resources']))
                self.assertTrue(set(rule['verbs']) <= {'get', 'list', 'watch', 'delete'})
        self.assertEqual(roles['regression-app-cleaner']['metadata']['namespace'], 'ai-system')
        self.assertEqual(roles['regression-app-cleaner']['rules'][0]['resources'], ['appinstances'])
        self.assertEqual(roles['regression-api-restarter']['metadata']['namespace'], 'identity-system')
        self.assertEqual(roles['regression-api-restarter']['rules'][0]['resources'], ['pods'])
        self.assertEqual(roles['regression-catalog-observer']['rules'][0]['resourceNames'], ['ai-model-catalog'])

    def test_automatic_setup_service_preserves_linux_runner_isolation_and_normal_read_only_inputs(self):
        compose = yaml.safe_load((ROOT / 'dashboard/apps/web/regression/compose.yaml').read_text())
        services = compose['services']
        self.assertEqual(services['setup-api']['entrypoint'], ['node', 'regression/setup.mjs'])
        self.assertEqual(services['setup-api']['volumes'], [
            {'type': 'bind', 'source': '${REGRESSION_INPUT_DIR:?Set REGRESSION_INPUT_DIR}', 'target': '/inputs'},
            {'type': 'bind', 'source': '${REGRESSION_PRIVATE_DIR:?Set REGRESSION_PRIVATE_DIR}', 'target': '/private'},
        ])
        self.assertEqual(services['setup-api']['environment']['REGRESSION_OUTPUT_DIR'], '/private/runs')
        self.assertTrue(services['regression']['volumes'][0]['read_only'])
        for service in services.values():
            self.assertTrue(service['read_only'])
            self.assertEqual(service['cap_drop'], ['ALL'])
            self.assertEqual(service['pull_policy'], 'never')
            self.assertNotIn('ports', service)
            self.assertNotIn('privileged', service)
            self.assertEqual(service['network_mode'], 'bridge')
            self.assertNotIn('docker.sock', json.dumps(service))
        source = (ROOT / 'dashboard/apps/web/regression/setup.mjs').read_text()
        self.assertNotIn('ignoreHTTPSErrors', source)
        self.assertNotIn('storageState', source)
        self.assertIn("grantFile = join(directory, '.setup-access-restore.json')", source)
        recovery = (ROOT / 'dashboard/apps/web/regression/core/recovery-adapters.ts').read_text()
        self.assertNotIn('.setup-bootstrap.kubeconfig', recovery)
        for name in ['observer.yaml', 'locker.yaml', 'model-cleaner.yaml', 'app-cleaner.kubeconfig']:
            self.assertIn(name, recovery)

    def test_license_test_reset_grant_cannot_touch_issuer_trust_or_other_secrets(self):
        documents = list(yaml.safe_load_all((ROOT / 'dashboard/apps/web/regression/lab-rbac-license-resetter.example.yaml').read_text()))
        role = next(item for item in documents if item['kind'] == 'Role')
        self.assertEqual(role['metadata']['namespace'], 'identity-system')
        self.assertEqual(role['rules'], [{'apiGroups': [''], 'resources': ['secrets'], 'resourceNames': ['magicstick-license'], 'verbs': ['get', 'patch']}])
        source = (ROOT / 'dashboard/apps/web/regression/core/license-baseline.ts').read_text()
        self.assertIn("path:'/metadata/resourceVersion'", source)
        self.assertIn("path:'/data/license.json'", source)
        self.assertIn('withPrivateCommandInput(patch,filename=>', source)
        self.assertIn("'--patch-file='+filename", source)
        self.assertNotIn('/dev/stdin', source)
        self.assertNotIn("'--patch='", source)
        self.assertNotIn("['delete'", source)
        self.assertNotIn('magicstick-license-trust', source)

    def test_detector_rejects_disabled_tls_in_ts_and_python(self):
        for source in ["new Agent({rejectUnauthorized: false})", "ssl._create_unverified_context()", "requests.get(url, verify=False)", "ctx.verify_mode = ssl.CERT_NONE"]:
            self.assertTrue(unsafe_tls(source))
        self.assertFalse(unsafe_tls("create_default_context(cafile=path); new Agent({ca: certificate})"))

    def test_shipped_runtime_keeps_certificate_verification(self):
        paths = list((ROOT / 'core').rglob('*.py')) + list((ROOT / 'dashboard/packages').rglob('*.ts')) + list((ROOT / 'dashboard/apps/cli/src').rglob('*.ts'))
        checked = 0
        for path in paths:
            if 'node_modules' in path.parts or '.test.' in path.name or path.name.startswith('test_'):
                continue
            checked += 1
            self.assertFalse(unsafe_tls(path.read_text()), f'Unsafe TLS setting: {path.relative_to(ROOT)}')
        self.assertGreater(checked, 20)

    def test_known_undici_fixes_are_pinned_in_current_lock(self):
        lock = yaml.safe_load((ROOT / 'dashboard/pnpm-lock.yaml').read_text())
        version = lock['overrides']['undici']
        self.assertRegex(version, r'^\d+\.\d+\.\d+$')
        self.assertGreaterEqual(tuple(map(int, version.split('.'))), (8, 10, 2))
        self.assertIn('undici@' + version, lock['packages'])

    def test_secret_checks_are_real_redacted_scans_not_success_stubs(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/public-release-checks.yml').read_text())
        steps = workflow['jobs']['release-checks']['steps']
        for name in ['Secret scan current tree', 'Secret scan git history']:
            scan = next(item for item in steps if item.get('name') == name)
            self.assertIn('gitleaks', scan['run'])
            self.assertIn('--redact', scan['run'])
            self.assertNotIn('|| true', scan['run'])
        report = next(item for item in steps if item.get('name') == 'Report secret-scan locations without matched values')
        self.assertNotIn('.Secret', report['run'])
        self.assertNotIn('.Match', report['run'])

    def test_fresh_advisory_gate_is_scheduled_and_fails_closed(self):
        text = (ROOT / '.github/workflows/dependency-security.yml').read_text()
        workflow = yaml.safe_load(text)
        triggers = workflow.get('on', workflow.get(True))
        self.assertIn('schedule', triggers)
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        steps = workflow['jobs']['advisories']['steps']
        audit = next(item for item in steps if item.get('name') == 'Query current registry advisories')['run']
        self.assertEqual(audit, 'pnpm audit --audit-level high')
        for unsafe in ['|| true', '--fix', '--ignore-registry-errors', '--ignore-unfixable']:
            self.assertNotIn(unsafe, audit)

    def test_cli_and_hostname_parsers_have_adversarial_owning_tests(self):
        source = (ROOT / 'dashboard/packages/core/src/index.ts').read_text()
        self.assertIn('while (start < end', source)
        self.assertIn('Math.min(end, start + 48)', source)
        runtime = (ROOT / 'dashboard/apps/cli/src/runtime.ts').read_text()
        self.assertNotIn('rejectUnauthorized: false', runtime)


if __name__ == '__main__':
    unittest.main()
