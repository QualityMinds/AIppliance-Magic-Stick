"""Private input wizard safety checks. Inert adapters; no Docker or appliance."""
from pathlib import Path
import argparse
import base64
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('regression_input_setup', ROOT / 'tools/regression_inputs.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class RegressionInputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='regression private inputs ')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.root.chmod(0o700)

    def write(self, name, content):
        path = self.root / name
        setup.private_write(path, content)
        return path

    def test_private_file_helpers_reject_symlinks_world_readable_inputs_and_unsafe_directory(self):
        path = self.write('credential.txt', 'synthetic credential')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        link = self.root / 'alias'
        link.symlink_to(path)
        with self.assertRaises(OSError):
            setup.private_read(link)
        with self.assertRaises(setup.SetupError):
            setup.private_write(link, 'replacement')
        path.chmod(0o644)
        with self.assertRaises(setup.SetupError):
            setup.private_read(path)
        directory = self.root / 'public'
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)
        with self.assertRaises(setup.SetupError):
            setup.private_directory(directory)

    def test_https_origins_never_accept_credentials_paths_or_insecure_scheme(self):
        self.assertEqual(setup.origin('https://lab.example.test/'), 'https://lab.example.test')
        for url in ['http://lab.example.test', 'https://user:secret@lab.example.test',
                    'https://lab.example.test/path', 'https://lab.example.test?token=secret',
                    'https://lab.example.test#fragment', 'https://lab.example.test\n']:
            with self.subTest(url=url), self.assertRaises(setup.SetupError):
                setup.origin(url)

    def test_one_time_setup_imports_credentials_without_replacing_accepted_pins(self):
        inputs = self.root / 'inputs'
        observer = self.write('observer.json', {'kind': 'Config', 'users': [{'user': {'token': 'synthetic-observer'}}]})
        locker = self.write('locker.json', {'kind': 'Config', 'users': [{'user': {'token': 'synthetic-locker'}}]})
        cleaner = self.write('cleaner.json', {'kind': 'Config', 'users': [{'user': {'token': 'synthetic-cleaner'}}]})
        answers = ['https://lab.example.test', 'https://id.lab.example.test', 'https://inference.lab.example.test',
                   'synthetic-admin', '', str(observer), str(locker), str(cleaner)]
        args = argparse.Namespace(manual=True, provision_rbac=False, bootstrap_kubeconfig=None, api_restart=False, advanced=False, no_host_mapping=True)
        console = io.StringIO()
        with patch('builtins.input', side_effect=answers), patch.object(setup.getpass, 'getpass', return_value='synthetic-password'), \
                patch.object(setup.sys.stdin, 'isatty', return_value=True), \
                patch('sys.stdout', console):
            setup.wizard(inputs, args)
        value = json.loads(setup.private_read(inputs / 'setup.json'))
        self.assertEqual(value['observerKubeconfig'], 'observer.yaml')
        self.assertEqual(value['lock']['kubeconfig'], 'locker.yaml')
        self.assertFalse((inputs / 'lab.json').exists())
        self.assertNotIn('synthetic-password', console.getvalue())
        self.assertNotIn('synthetic-observer', console.getvalue())
        self.assertEqual(setup.private_read(inputs / 'password.txt'), 'synthetic-password\n')
        self.assertEqual(stat.S_IMODE(inputs.stat().st_mode), 0o700)
        previous = {'expected': {'applianceUid': 'previous-pin'}}
        setup.private_write(inputs / 'lab.json', previous)
        answers = ['', '', '', '', '', '', '', '', '']
        with patch('builtins.input', side_effect=answers), patch('sys.stdout', io.StringIO()):
            setup.wizard(inputs, args)
        self.assertEqual(json.loads(setup.private_read(inputs / 'lab.json')), previous)

    def test_saved_runner_paths_resolve_to_host_inputs_without_repeated_import(self):
        self.assertEqual(setup.saved_input_path(self.root, '/inputs/password.txt'), self.root / 'password.txt')
        self.assertEqual(setup.saved_input_path(self.root, 'password.txt'), self.root / 'password.txt')
        self.assertEqual(setup.saved_input_path(self.root, '/private/source/password.txt'), Path('/private/source/password.txt'))
        for value in ['/inputs/../password.txt', '../password.txt']:
            with self.assertRaises(setup.SetupError):
                setup.saved_input_path(self.root, value)

    def test_hidden_password_refuses_pipes_and_echoed_getpass_fallback(self):
        with patch.object(setup.sys.stdin, 'isatty', return_value=False), patch.object(setup.getpass, 'getpass') as prompt, \
                self.assertRaises(setup.SetupError):
            setup.hidden_password('Password')
        prompt.assert_not_called()
        with patch.object(setup.sys.stdin, 'isatty', return_value=True), \
                patch.object(setup.getpass, 'getpass', side_effect=setup.getpass.GetPassWarning('synthetic terminal failure')), \
                self.assertRaises(setup.SetupError):
            setup.hidden_password('Password')

    def oidc_context(self):
        ca = '-----BEGIN CERTIFICATE-----\n' + base64.b64encode(b'synthetic public DER').decode() + '\n-----END CERTIFICATE-----\n'
        return ca, {'clusters': [{'cluster': {'certificate-authority-data': base64.b64encode(b'wrong cluster CA').decode()}}],
            'users': [{'user': {'exec': {'command': 'kubectl', 'args': ['oidc-login', 'get-token',
                '--oidc-issuer-url=https://id.lab.example.test/realms/magicstick',
                '--certificate-authority-data=' + base64.b64encode(ca.encode()).decode()]}}}]}

    def test_public_appliance_ca_import_uses_matching_oidc_issuer_never_cluster_ca_or_authentication(self):
        source = self.write('selected-admin.yaml', 'synthetic selected private source')
        ca, value = self.oidc_context()
        output = io.StringIO()
        with patch.object(setup, 'kubectl', return_value=json.dumps(value)) as command, patch('sys.stdout', output):
            extracted = setup.appliance_ca_from_kubeconfig(source, 'https://id.lab.example.test')
        self.assertEqual(extracted, ca)
        command.assert_called_once_with(source, ['config', 'view', '--raw', '--minify', '-o', 'json'])
        target = self.root / 'appliance-ca.pem'
        with patch('builtins.input', return_value='no'), patch('sys.stdout', output), self.assertRaises(setup.SetupError):
            setup.trust_ca(extracted, target)
        self.assertFalse(target.exists())
        with patch('builtins.input', return_value='TRUST'), patch('sys.stdout', output):
            setup.trust_ca(extracted, target)
        self.assertEqual(setup.private_read(target), ca)
        self.assertNotIn('wrong cluster CA', output.getvalue())
        self.assertNotIn('synthetic selected private source', output.getvalue())

    def test_appliance_ca_extraction_rejects_foreign_issuer_duplicate_flags_plugins_and_private_keys(self):
        source = self.write('selected.yaml', 'synthetic private source')
        ca, value = self.oidc_context()
        for variation in ['foreign', 'duplicate', 'plugin', 'private-key', 'invalid-base64']:
            current = json.loads(json.dumps(value))
            plugin = current['users'][0]['user']['exec']
            if variation == 'foreign':
                plugin['args'][2] = '--oidc-issuer-url=https://foreign.example.test/realms/magicstick'
            elif variation == 'duplicate':
                plugin['args'].append(plugin['args'][3])
            elif variation == 'plugin':
                plugin['command'] = 'unreviewed-executable'
            elif variation == 'private-key':
                plugin['args'][3] = '--certificate-authority-data=' + base64.b64encode((ca + 'PRIVATE KEY').encode()).decode()
            else:
                plugin['args'][3] = '--certificate-authority-data=not valid base64'
            with self.subTest(variation=variation), patch.object(setup, 'kubectl', return_value=json.dumps(current)), \
                    self.assertRaises((setup.SetupError, ValueError)):
                setup.appliance_ca_from_kubeconfig(source, 'https://id.lab.example.test')

    def test_local_setup_requires_explicit_ca_and_never_reports_success_with_blank_trust(self):
        inputs = self.root / 'inputs'
        setup.private_directory(inputs)
        self.write('inputs/username.txt', 'synthetic-user')
        self.write('inputs/password.txt', 'synthetic-password')
        self.write('inputs/setup.json', {'dashboardUrl': 'https://lab.example.local', 'identityUrl': 'https://id.example.local',
                                       'inferenceUrl': 'https://inference.example.local'})
        args = argparse.Namespace(manual=True, provision_rbac=False, bootstrap_kubeconfig=None, api_restart=False, advanced=False, no_host_mapping=True)
        with patch('builtins.input', side_effect=[''] * 6), patch('sys.stdout', io.StringIO()), self.assertRaises(setup.SetupError) as failure:
            setup.wizard(inputs, args)
        self.assertIn('.local endpoints require', str(failure.exception))
        self.assertFalse((inputs / 'observer.yaml').exists())
        self.assertFalse((inputs / 'lab.json').exists())

    def test_test_roles_reject_downloaded_oidc_admin_and_duplicate_credentials_before_copying(self):
        _, value = self.oidc_context()
        with self.assertRaises(setup.SetupError):
            setup.role_credential(json.dumps(value))
        with self.assertRaises(setup.SetupError):
            setup.role_credential('users:\n  - user:\n      exec:\n        command: kubectl\n')
        inputs = self.root / 'inputs'
        same = self.write('same.yaml', {'kind': 'Config', 'users': [{'user': {'token': 'synthetic-same-token'}}]})
        args = argparse.Namespace(manual=True, provision_rbac=False, bootstrap_kubeconfig=None, api_restart=False, advanced=False, no_host_mapping=True)
        answers = ['https://lab.example.test', 'https://id.lab.example.test', 'https://inference.lab.example.test',
                   'synthetic-user', '', str(same), str(same), str(same)]
        with patch('builtins.input', side_effect=answers), patch.object(setup.getpass, 'getpass', return_value='synthetic-password'), \
                patch.object(setup.sys.stdin, 'isatty', return_value=True), patch('sys.stdout', io.StringIO()), self.assertRaises(setup.SetupError) as failure:
            setup.wizard(inputs, args)
        self.assertIn('distinct scoped credentials', str(failure.exception))
        for filename in ['observer.yaml', 'locker.yaml', 'model-cleaner.yaml']:
            self.assertFalse((inputs / filename).exists())

    def test_one_time_bootstrap_can_import_downloaded_identity_ca_but_only_after_explicit_trust(self):
        source = self.write('selected-admin.yaml', 'synthetic selected private source')
        ca, value = self.oidc_context()
        args = argparse.Namespace(provision_rbac=True, bootstrap_kubeconfig=str(source), api_restart=False, advanced=False, no_host_mapping=True)
        for confirmation in ['no', 'TRUST']:
            inputs = self.root / ('inputs-' + confirmation)
            answers = ['https://lab.example.local', 'https://id.lab.example.test', 'https://inference.lab.example.local',
                       'synthetic-user', '', '', confirmation]
            with patch('builtins.input', side_effect=answers), patch.object(setup.getpass, 'getpass', return_value='synthetic-password'), \
                    patch.object(setup.sys.stdin, 'isatty', return_value=True), patch('sys.stdout', io.StringIO()), \
                    patch.object(setup, 'kubectl', return_value=json.dumps(value)), patch.object(setup, 'bootstrap') as provision:
                if confirmation == 'no':
                    with self.assertRaises(setup.SetupError):
                        setup.wizard(inputs, args)
                    provision.assert_not_called()
                    self.assertFalse((inputs / 'appliance-ca.pem').exists())
                else:
                    setup.wizard(inputs, args)
                    provision.assert_called_once_with(source, inputs, False)
                    self.assertEqual(setup.private_read(inputs / 'appliance-ca.pem'), ca)
                    saved = json.loads(setup.private_read(inputs / 'setup.json'))
                    self.assertEqual(saved['caFile'], 'appliance-ca.pem')
                    self.assertFalse((inputs / 'lab.json').exists())

    def bootstrap_adapter(self, holder=None, label='appliance-uid'):
        calls = []
        cluster = {'server': 'https://kubernetes.example.test:6443', 'certificate-authority-data': base64.b64encode(b'synthetic CA').decode()}
        def command(kubeconfig, arguments, data=None):
            calls.append((arguments, data))
            if arguments[:2] == ['config', 'view']:
                return json.dumps({'clusters': [{'cluster': cluster}], 'users': [{'user': {'token': 'synthetic-admin-token'}}]})
            if arguments[:2] == ['get', 'appliances.appliance.magicstick.dev']:
                return json.dumps({'items': [{'metadata': {'name': 'local', 'namespace': 'ai-system', 'uid': 'appliance-uid'}}]})
            if arguments[:2] == ['get', 'leases.coordination.k8s.io']:
                return json.dumps({'items': [{'metadata': {'name': 'lab-lock', 'namespace': 'magicstick-regression',
                    'labels': {'regression.magicstick.dev/appliance-uid': label}}, 'spec': {'holderIdentity': holder}}]})
            if arguments[0] == 'apply':
                return ''
            if arguments[:2] == ['create', '--raw']:
                return json.dumps({'status': {'token': 'synthetic-short-lived-token',
                    'expirationTimestamp': (datetime.now(timezone.utc) + timedelta(hours=20)).isoformat()}})
            self.fail('Unexpected bootstrap command')
        return command, calls

    def test_bootstrap_is_explicit_uses_reviewed_grants_and_retains_neither_admin_credentials_nor_active_lease(self):
        inputs = self.root / 'inputs'
        setup.private_directory(inputs)
        admin = self.write('admin.yaml', 'synthetic private administrator context')
        command, calls = self.bootstrap_adapter()
        with patch.object(setup, 'kubectl', side_effect=command), patch('builtins.input', return_value='appliance-uid'), patch('sys.stdout', io.StringIO()):
            setup.bootstrap(admin, inputs)
        manifest = setup.private_read(inputs / 'bootstrap-rbac.yaml')
        self.assertNotIn('kind: Lease', manifest)
        self.assertNotIn('regression-api-restarter', manifest)
        self.assertNotIn('synthetic-admin-token', manifest)
        writes = [args for args, _ in calls if args[0] in ['apply', 'create']]
        self.assertEqual(writes[0], ['apply', '--dry-run=server', '-f', '-'])
        self.assertEqual(writes[1], ['apply', '-f', '-'])
        for filename in ['observer.yaml', 'locker.yaml', 'model-cleaner.yaml', 'app-cleaner.kubeconfig']:
            value = json.loads(setup.private_read(inputs / filename))
            self.assertEqual(value['users'][0]['user'], {'token': 'synthetic-short-lived-token'})
            self.assertEqual(set(value['clusters'][0]['cluster']), {'server', 'certificate-authority-data'})
            self.assertNotIn('admin', setup.private_read(inputs / filename))
        self.assertFalse((inputs / 'admin.yaml').exists())
        self.assertFalse((inputs / 'api-restarter.kubeconfig').exists())

    def test_bootstrap_refuses_busy_or_foreign_lease_and_missing_confirmation_without_writes(self):
        for holder, label, confirmation in [('busy', 'appliance-uid', 'appliance-uid'),
                                            (None, 'foreign-uid', 'appliance-uid'), (None, 'appliance-uid', 'no')]:
            inputs = self.root / ('inputs-' + str(len(list(self.root.iterdir()))))
            setup.private_directory(inputs)
            admin = self.write('admin.yaml', 'synthetic private context')
            command, calls = self.bootstrap_adapter(holder, label)
            with patch.object(setup, 'kubectl', side_effect=command), patch('builtins.input', return_value=confirmation), patch('sys.stdout', io.StringIO()), \
                    self.assertRaises(setup.SetupError):
                setup.bootstrap(admin, inputs)
            self.assertFalse(any(args[0] in ['apply', 'create'] for args, _ in calls))

    def test_license_baseline_grant_is_separate_exact_and_opt_in(self):
        inputs = self.root / 'license-inputs'
        setup.private_directory(inputs)
        admin = self.write('admin.yaml', 'synthetic private context')
        command, calls = self.bootstrap_adapter()
        with patch.object(setup, 'kubectl', side_effect=command), patch('builtins.input', return_value='appliance-uid'), patch('sys.stdout', io.StringIO()):
            setup.bootstrap(admin, inputs, expected_uid='appliance-uid', license_baseline=True)
        manifest = setup.private_read(inputs / 'bootstrap-rbac.yaml')
        self.assertIn('resourceNames: [magicstick-license]', manifest)
        self.assertIn('verbs: [get, patch]', manifest)
        self.assertNotIn('resourceNames: [magicstick-license-trust]', manifest)
        self.assertTrue((inputs / 'license-resetter.kubeconfig').exists())
        self.assertFalse((inputs / 'api-restarter.kubeconfig').exists())
        self.assertNotIn('synthetic-admin-token', manifest)

    def test_suite_approval_questions_store_refusals_and_reuse_only_same_installation(self):
        facts = {'applianceUid': 'appliance-uid', 'inventory': {'nodes': [{'nodeUid': 'node-uid'}]}}
        def deny(prompt):
            if prompt.startswith('Test phases'):
                return '5'
            if prompt.startswith('Type that UID'):
                return 'appliance-uid'
            return 'n'
        with patch('builtins.input', side_effect=deny), patch('sys.stdout', io.StringIO()):
            denied = setup.suite_consent(facts)
        self.assertEqual(denied['phases'], [5])
        self.assertEqual(denied['scopes'], [])
        self.assertIn('license', denied['reviewedScopes'])
        approved = {**denied, 'scopes': ['identity']}
        prompts = []
        def reuse(prompt):
            prompts.append(prompt)
            if prompt.startswith('Type that UID'):
                return 'appliance-uid'
            return ''
        with patch('builtins.input', side_effect=reuse), patch('sys.stdout', io.StringIO()):
            retained = setup.suite_consent(facts, approved)
        self.assertEqual(retained['scopes'], ['identity'])
        self.assertFalse(any(prompt.startswith('Approve this exact') for prompt in prompts))
        with patch('builtins.input', side_effect=['0', 'foreign']), patch('sys.stdout', io.StringIO()), self.assertRaises(setup.SetupError):
            setup.suite_consent(facts, approved)

    def test_complete_setup_runs_all_forms_reviewed_bootstrap_and_final_acceptance_without_pre_activation(self):
        facts, args = self.auto_inputs()
        args.minimal = False
        facts['inventory'] = {'nodes': [{'nodeUid': 'node-uid'}], 'activeModels': [], 'license': {'hasDocument': False}}
        consent = {'version': 1, 'testLab': True, 'applianceUid': facts['applianceUid'], 'nodeUids': ['node-uid'],
                   'phases': [5], 'scopes': ['license', 'api-restart', 'first-license']}
        calls = []
        profile = {'version': 1, 'federation': {'fixtures': [{'protocol': 'oidc'}]}}
        def api(directory, seed, mode, reviewed=None, approve_admin=False):
            calls.append(mode)
            if mode == 'authorize':
                self.write('.setup-bootstrap.kubeconfig', 'synthetic temporary token')
            if mode == 'license-fixtures':
                self.write('license-valid.license', 'synthetic TEST document')
                return {**facts, 'licenseFixture': {'kid': 'synthetic-fixture'}}
            return facts
        with patch('builtins.input', side_effect=['https://lab.example.test', '', '']), \
                patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), patch.object(setup, 'setup_api', side_effect=api), \
                patch.object(setup, 'suite_consent', return_value=consent), patch.object(setup, 'complete_fixtures', return_value=profile) as forms, \
                patch.object(setup, 'yes_no', return_value=True), patch.object(setup, 'bootstrap') as provision, \
                patch.object(setup, 'provision_test_license_trust') as trust, patch.object(setup, 'finish_complete_setup', return_value=True) as finish, \
                patch('sys.stdout', io.StringIO()):
            self.assertTrue(setup.wizard(self.root, args))
        forms.assert_called_once()
        provision.assert_called_once_with(self.root / '.setup-bootstrap.kubeconfig', self.root, True,
                                        expected_uid='appliance-uid', license_baseline=True)
        trust.assert_called_once()
        finish.assert_called_once()
        self.assertEqual(calls, ['inspect', 'suite-inventory', 'license-fixtures', 'authorize', 'verify-fixtures'])
        self.assertFalse((self.root / '.setup-bootstrap.kubeconfig').exists())
        self.assertEqual(setup.private_read(self.root / 'license-original.license'), 'synthetic TEST document')

    def test_final_setup_reports_missing_foundations_without_false_success_or_suggesting_blocked_all(self):
        identifier = '11111111-2222-4333-8444-555555555555'
        seed = {'suiteConsent': {'phases': [3, 4]}}
        self.write('.preparation-latest.json', {'id': identifier})
        self.write('prepared/' + identifier + '/plan.json', {'readiness': [{'phase': phase, 'state': 'Blocked'} for phase in [3, 4]]})
        self.write('prepared/' + identifier + '/readiness.txt', 'Missing: real GPUs\nAction: supply supported hardware\n')
        output = io.StringIO()
        with patch.object(setup, 'run_preparation') as preparation, patch('builtins.input', return_value='ACCEPT'), patch('sys.stdout', output):
            self.assertFalse(setup.finish_complete_setup(self.root, seed))
        self.assertEqual(preparation.call_args_list[1].args[1], ['--accept', identifier])
        self.assertIn('SETUP INCOMPLETE', output.getvalue())
        self.assertNotIn('Run: bash tools/regression.sh all', output.getvalue())
        saved = json.loads(setup.private_read(self.root / 'setup-readiness.json'))
        self.assertFalse(saved['testsExecuted'])
        self.assertFalse(saved['allSelectedInputsReady'])

    def test_destructive_recipe_refusal_revokes_old_saved_approval(self):
        original = {'version': 2, 'approveDestructive': True, 'independentRecoveryAvailable': True, 'cases': {}}
        self.write('host-drills.json', original)
        facts = {'inventory': {'hosts': [{'name': 'fixture', 'nodeUid': 'node-uid'}]}}
        with patch.object(setup, 'question', return_value='fixture'), patch.object(setup, 'yes_no', return_value=False), patch('sys.stdout', io.StringIO()):
            setup.host_drill_questions(self.root, facts, {})
        revoked = json.loads(setup.private_read(self.root / 'host-drills.json'))
        self.assertFalse(revoked['approveDestructive'])
        self.assertFalse(revoked['independentRecoveryAvailable'])

    def test_private_app_dns_is_explicit_suffix_only_and_can_be_revoked(self):
        seed = {'dashboardUrl': 'https://fixture.local'}
        profile = {'applications': {'fixtures': [{'originTemplate': 'https://{name}.openclaw.fixture.local'},
                                               {'originTemplate': 'https://{name}.unrelated.local'}]}}
        addresses = [(2, 1, 6, '', ('192.0.2.10', 0))]
        with patch.object(setup, 'yes_no', return_value=True), patch.object(setup.socket, 'getaddrinfo', return_value=addresses):
            setup.application_dns(self.root, seed, profile)
        value = json.loads(setup.private_read(self.root / 'browser-dns.json'))
        self.assertEqual(value['mappings'], [{'suffix': 'openclaw.fixture.local', 'address': '192.0.2.10'}])
        with patch.object(setup, 'yes_no', return_value=False):
            setup.application_dns(self.root, seed, profile)
        self.assertEqual(json.loads(setup.private_read(self.root / 'browser-dns.json'))['mappings'], [])

    def test_peer_import_rejects_missing_or_non_private_directories_without_creating_a_peer(self):
        missing = self.root / 'not-a-real-peer'
        with self.assertRaises(setup.SetupError):
            setup.import_peer_inputs(missing, self.root)
        self.assertFalse(missing.exists())
        public = self.root / 'public-peer'
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        with self.assertRaises(setup.SetupError):
            setup.import_peer_inputs(public, self.root)

    def test_oidc_import_requires_linux_binary_and_explicit_checksum_approval(self):
        source = self.root / 'linux-plugin'
        source.write_bytes(b'\x7fELF' + b'synthetic-linux' * 5)
        target = self.root / 'kubectl-oidc_login'
        with patch('builtins.input', return_value='no'), patch('sys.stdout', io.StringIO()), self.assertRaises(setup.SetupError):
            setup.oidc_plugin(source, target)
        self.assertFalse(target.exists())
        with patch('builtins.input', return_value='TRUST'), patch('sys.stdout', io.StringIO()):
            digest = setup.oidc_plugin(source, target)
        self.assertEqual(len(digest), 64)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        self.assertEqual(target.read_bytes(), source.read_bytes())
        source.write_bytes(b'not-a-linux-plugin')
        with self.assertRaises(setup.SetupError):
            setup.oidc_plugin(source, target)

    def test_private_dns_mapping_covers_both_services_and_never_prints_address(self):
        seed = {'dashboardUrl': 'https://appliance.example.local', 'identityUrl': 'https://id.example.local',
                'inferenceUrl': 'https://inference.example.local'}
        output = io.StringIO()
        resolver = [(2, 1, 6, '', ('192.0.2.123', 0))]
        with patch.object(setup.socket, 'getaddrinfo', return_value=resolver), patch('builtins.input', return_value=''), patch('sys.stdout', output):
            setup.host_mapping(self.root, seed)
        value = json.loads(setup.private_read(self.root / 'compose.override.yaml'))
        self.assertEqual(value['services']['regression'], value['services']['prepare'])
        self.assertEqual(value['services']['setup-api'], value['services']['prepare'])
        self.assertEqual(len(value['services']['prepare']['extra_hosts']), 3)
        self.assertNotIn('192.0.2.123', output.getvalue())

    def auto_inputs(self, access='admin'):
        self.write('username.txt', 'synthetic-admin\n')
        self.write('password.txt', 'synthetic-password\n')
        self.write('appliance-ca.pem', 'synthetic public CA')
        self.write('lab.json', {'expected': {'applianceUid': 'accepted-pin'}})
        facts = {'version': 1, 'dashboardUrl': 'https://lab.example.test', 'identityUrl': 'https://id.lab.example.test',
                 'inferenceUrl': 'https://inference.lab.example.test', 'kubernetesApiUrl': 'https://kubernetes.example.test:6443',
                 'subject': 'subject-id', 'username': 'synthetic-admin', 'accessLevel': access, 'applianceUid': 'appliance-uid'}
        args = argparse.Namespace(manual=False, provision_rbac=False, bootstrap_kubeconfig=None, api_restart=False,
                                  advanced=False, no_host_mapping=True, restore_kubernetes_access=False)
        return facts, args

    def test_automatic_setup_asks_no_identity_inference_or_kubeconfig_paths_and_never_replaces_pins(self):
        facts, args = self.auto_inputs()
        calls = []
        def api(directory, seed, mode, reviewed=None, approve_admin=False):
            calls.append((mode, reviewed, approve_admin))
            if mode == 'authorize':
                self.write('.setup-bootstrap.kubeconfig', 'synthetic transient admin token')
            return facts
        output = io.StringIO()
        with patch('builtins.input', side_effect=['https://lab.example.test', '', '']), \
                patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                patch.object(setup, 'setup_api', side_effect=api), patch.object(setup, 'bootstrap') as provision, patch('sys.stdout', output):
            setup.wizard(self.root, args)
        provision.assert_called_once_with(self.root / '.setup-bootstrap.kubeconfig', self.root, False, expected_uid='appliance-uid', license_baseline=False)
        self.assertEqual([mode for mode, _, _ in calls], ['inspect', 'authorize'])
        self.assertEqual(calls[1][1], facts)
        self.assertFalse(calls[1][2])
        value = json.loads(setup.private_read(self.root / 'setup.json'))
        self.assertEqual(value['inferenceUrl'], facts['inferenceUrl'])
        self.assertEqual(value['observerKubeconfig'], 'observer.yaml')
        self.assertEqual(json.loads(setup.private_read(self.root / 'lab.json'))['expected']['applianceUid'], 'accepted-pin')
        self.assertFalse((self.root / '.setup-bootstrap.kubeconfig').exists())
        self.assertNotIn('synthetic-password', output.getvalue())
        self.assertNotIn('synthetic transient admin token', output.getvalue())

    def test_temporary_self_account_grant_requires_explicit_consent_before_authorize(self):
        facts, args = self.auto_inputs('none')
        for consent in ['', 'GRANT']:
            calls = []
            def api(directory, seed, mode, reviewed=None, approve_admin=False):
                calls.append((mode, approve_admin))
                if mode == 'authorize':
                    self.write('.setup-bootstrap.kubeconfig', 'synthetic transient token')
                return facts
            with patch('builtins.input', side_effect=['https://lab.example.test', '', '', consent]), \
                    patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                    patch.object(setup, 'setup_api', side_effect=api), patch.object(setup, 'bootstrap') as provision, patch('sys.stdout', io.StringIO()):
                if consent:
                    setup.wizard(self.root, args)
                    self.assertEqual(calls, [('inspect', False), ('authorize', True)])
                    provision.assert_called_once()
                else:
                    with self.assertRaises(setup.SetupError):
                        setup.wizard(self.root, args)
                    self.assertEqual(calls, [('inspect', False)])
                    provision.assert_not_called()

    def test_automatic_setup_removes_ephemeral_admin_credential_on_bootstrap_failure(self):
        facts, args = self.auto_inputs()
        def api(directory, seed, mode, *unused):
            if mode == 'authorize':
                self.write('.setup-bootstrap.kubeconfig', 'synthetic transient token')
            return facts
        with patch('builtins.input', side_effect=['https://lab.example.test', '', '']), \
                patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                patch.object(setup, 'setup_api', side_effect=api), patch.object(setup, 'bootstrap', side_effect=setup.SetupError('synthetic failure')), \
                patch('sys.stdout', io.StringIO()), self.assertRaises(setup.SetupError):
            setup.wizard(self.root, args)
        self.assertFalse((self.root / '.setup-bootstrap.kubeconfig').exists())
        self.assertFalse((self.root / 'setup.json').exists())
        self.assertTrue((self.root / 'lab.json').exists())

    def test_interrupted_access_grant_blocks_new_setup_until_separate_restore_command(self):
        facts, args = self.auto_inputs('none')
        self.write('.setup-access-restore.json', {'version': 1, 'facts': facts})
        with patch('builtins.input') as prompt, self.assertRaises(setup.SetupError):
            setup.wizard(self.root, args)
        prompt.assert_not_called()
        args.restore_kubernetes_access = True
        with patch('builtins.input', side_effect=['', '', '']), \
                patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                patch.object(setup, 'setup_api', return_value={'version': 1, 'restored': True}) as api, \
                patch.object(setup, 'bootstrap') as provision, patch('sys.stdout', io.StringIO()):
            setup.wizard(self.root, args)
        self.assertEqual(api.call_args.args[2], 'restore')
        provision.assert_not_called()

    def test_first_contact_without_trusted_ca_does_not_contact_api_or_bypass_tls(self):
        args = argparse.Namespace(manual=False, provision_rbac=False, bootstrap_kubeconfig=None, api_restart=False,
                                  advanced=False, no_host_mapping=True, restore_kubernetes_access=False)
        with patch('builtins.input', side_effect=['https://lab.example.local', 'synthetic-admin', '']), \
                patch.object(setup, 'hidden_password', return_value='synthetic-password'), \
                patch.object(setup, 'keychain_appliance_ca', return_value=None), patch.object(setup, 'setup_api') as api, \
                self.assertRaises(setup.SetupError):
            setup.wizard(self.root, args)
        api.assert_not_called()

    def test_api_discovery_transfers_only_private_paths_never_password_arguments_and_cleans_temporary_files(self):
        facts, _ = self.auto_inputs()
        calls = []
        def command(arguments, **options):
            calls.append((arguments, options))
            if 'compose' in arguments:
                self.assertNotIn('synthetic-password', json.dumps(arguments) + json.dumps(options.get('env', {})))
                request = json.loads(setup.private_read(self.root / '.setup-api-request.json'))
                self.assertEqual(request['mode'], 'inspect')
                self.assertEqual(request['passwordFile'], 'password.txt')
                self.write('.setup-api-result.json', facts)
            return argparse.Namespace(returncode=0)
        seed = {**facts, 'usernameFile': 'username.txt', 'passwordFile': 'password.txt', 'caFile': 'appliance-ca.pem'}
        with patch.object(setup.subprocess, 'run', side_effect=command):
            value = setup.setup_api(self.root, seed, 'inspect')
        self.assertEqual(value['subject'], facts['subject'])
        self.assertEqual(calls[-1][0][-5:], ['run', '--rm', '--no-deps', '-T', 'setup-api'])
        self.assertFalse((self.root / '.setup-api-request.json').exists())
        self.assertFalse((self.root / '.setup-api-result.json').exists())
        self.assertTrue(all('build' not in arguments and 'pull' not in arguments for arguments, _ in calls))

    def test_worker_rejections_use_only_fixed_public_reasons_not_arbitrary_private_stderr(self):
        facts, _ = self.auto_inputs()
        seed = {**facts, 'usernameFile': 'username.txt', 'passwordFile': 'password.txt', 'caFile': 'appliance-ca.pem'}
        def command(arguments, **unused):
            return argparse.Namespace(returncode=2 if 'compose' in arguments else 0,
                stderr='[AUTH] synthetic-private-password-and-token\nPrivate upstream diagnostics\n')
        with patch.object(setup.subprocess, 'run', side_effect=command), self.assertRaises(setup.SetupError) as rejection:
            setup.setup_api(self.root, seed, 'inspect')
        self.assertIn('admin login', str(rejection.exception))
        self.assertNotIn('synthetic-private', str(rejection.exception))
        self.assertNotIn('Private upstream', str(rejection.exception))
        self.assertFalse((self.root / '.setup-api-request.json').exists())

    def test_worker_rejections_survive_compose_stream_multiplexing_without_private_output(self):
        facts, _ = self.auto_inputs()
        seed = {**facts, 'usernameFile': 'username.txt', 'passwordFile': 'password.txt', 'caFile': 'appliance-ca.pem'}
        for code, public_reason in [('AUTH', 'admin login'), ('LAB', 'immutable test-server marker'),
                                    ('LOCK_BUSY', 'lab lease'), ('LOCK_STALE', 'expired test lease')]:
            with self.subTest(code=code):
                def command(arguments, **unused):
                    return argparse.Namespace(returncode=2 if 'compose' in arguments else 0,
                        stderr='Container created\n', stdout='[' + code + '] synthetic-private-token\n')
                with patch.object(setup.subprocess, 'run', side_effect=command), self.assertRaises(setup.SetupError) as rejection:
                    setup.setup_api(self.root, seed, 'inspect')
                self.assertIn(public_reason, str(rejection.exception))
                self.assertNotIn('synthetic-private-token', str(rejection.exception))
                self.assertNotIn('Container created', str(rejection.exception))
                self.assertEqual(rejection.exception.code, code)

    def test_refresh_diagnostic_preserves_current_fixed_reason_stage_and_outcome_only(self):
        output = self.root / '.preparation-ABC123'
        environment = {'REGRESSION_INPUT_DIR': str(self.root), 'REGRESSION_PRIVATE_DIR': str(self.root),
                       'REGRESSION_PREPARATION_STATUS_FILE': str(output)}
        for code, outcome in [('LOCK_STALE', 'Blocked'), ('API', 'Failed')]:
            failure = setup.SetupError('Fixed public reason.', outcome, code=code, stage='lab-bootstrap')
            with patch.dict(os.environ, environment), patch.object(setup, 'registered_setup', side_effect=failure), \
                    patch('sys.stderr', io.StringIO()):
                self.assertEqual(setup.main(['--refresh']), 1 if outcome == 'Failed' else 2)
            self.assertEqual(json.loads(setup.private_read(output)),
                             {'version': 1, 'outcome': outcome, 'reason': code, 'setupStage': 'lab-bootstrap'})
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        with patch.dict(os.environ, environment):
            setup.preparation_status('Blocked', setup.SetupError('synthetic-secret', code='synthetic-secret',
                                                               stage='synthetic-secret', detail='synthetic-secret'))
        self.assertNotIn('synthetic-secret', setup.private_read(output))
        with patch.dict(os.environ, environment), patch.object(setup, 'registered_setup', return_value=True):
            self.assertEqual(setup.main(['--refresh']), 0)
        self.assertEqual(json.loads(setup.private_read(output)), {'version': 1, 'outcome': 'Passed'})

    def test_refresh_reports_reviewed_automatic_recovery_without_hiding_failed_outcomes(self):
        output = self.root / '.preparation-ABC123'
        run_id = 'reg-11111111-1111-4111-8111-111111111111'
        environment = {'REGRESSION_PRIVATE_DIR': str(self.root), 'REGRESSION_PREPARATION_STATUS_FILE': str(output)}
        with patch.dict(os.environ, environment), patch.object(setup, 'RECOVERED_RUN_IDS', [run_id]):
            setup.preparation_status('Passed')
        self.assertEqual(json.loads(setup.private_read(output)),
                         {'version': 1, 'outcome': 'Passed', 'recoveredRunIds': [run_id]})
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

    def test_refresh_diagnostic_cannot_write_outside_private_attempt_path(self):
        for filename in ['summary.json', '.preparation-../../other', '.preparation-ABC1234']:
            with self.subTest(filename=filename), patch.dict(os.environ, {'REGRESSION_PRIVATE_DIR': str(self.root),
                    'REGRESSION_PREPARATION_STATUS_FILE': str(self.root / filename)}), self.assertRaises(setup.SetupError):
                setup.preparation_status('Passed')

    def test_worker_stage_diagnostic_reports_only_known_steps_and_error_types(self):
        facts, _ = self.auto_inputs()
        seed = {**facts, 'usernameFile': 'username.txt', 'passwordFile': 'password.txt', 'caFile': 'appliance-ca.pem'}
        def command(arguments, **unused):
            return argparse.Namespace(returncode=1 if 'compose' in arguments else 0, stderr='',
                stdout='[UNEXPECTED] sensitive upstream detail\n[SETUP_STAGE:lab-bootstrap] [detail:ENOENT]\n')
        with patch.object(setup.subprocess, 'run', side_effect=command), self.assertRaises(setup.SetupError) as rejection:
            setup.setup_api(self.root, seed, 'inspect')
        self.assertIn('provisioning registered lab access', str(rejection.exception))
        self.assertIn('required runner file is missing', str(rejection.exception))
        self.assertNotIn('sensitive upstream detail', str(rejection.exception))

    def test_api_bootstrap_checks_appliance_uid_before_any_rbac_write(self):
        admin = self.write('transient.yaml', 'synthetic private token')
        command, calls = self.bootstrap_adapter()
        with patch.object(setup, 'kubectl', side_effect=command), patch('builtins.input') as prompt, self.assertRaises(setup.SetupError):
            setup.bootstrap(admin, self.root, expected_uid='wrong-appliance')
        prompt.assert_not_called()
        self.assertFalse(any(args[0] in ['apply', 'create'] for args, _ in calls))

    def test_bootstrap_refuses_expired_or_overlong_role_tokens_without_replacing_previous_credentials(self):
        admin = self.write('admin.yaml', 'synthetic selected private token')
        self.write('observer.yaml', 'synthetic previous observer credential')
        command, _ = self.bootstrap_adapter()
        for delta in [timedelta(seconds=-30), timedelta(days=2)]:
            def bad_expiry(kubeconfig, arguments, data=None):
                value = command(kubeconfig, arguments, data)
                if arguments[:2] == ['create', '--raw']:
                    result = json.loads(value)
                    result['status']['expirationTimestamp'] = (datetime.now(timezone.utc) + delta).isoformat()
                    return json.dumps(result)
                return value
            with patch.object(setup, 'kubectl', side_effect=bad_expiry), patch('builtins.input', return_value='appliance-uid'), \
                    patch('sys.stdout', io.StringIO()), self.assertRaises(setup.SetupError):
                setup.bootstrap(admin, self.root)
            self.assertEqual(setup.private_read(self.root / 'observer.yaml'), 'synthetic previous observer credential')
            self.assertFalse((self.root / 'locker.yaml').exists())

    def test_identity_discovery_verifies_each_redirect_and_rejects_http_foreign_realm_or_unbounded_chain(self):
        identity = 'https://id.lab.example.test/realms/magicstick/protocol/openid-connect/auth?client_id=magicstick-dashboard'
        class Response:
            def __init__(self, status, location=None):
                self.status, self.location = status, location
            def getheader(self, unused):
                return self.location
        class Connection:
            def __init__(self, response):
                self.response = response
            def request(self, method, path, headers):
                self.method = method
            def getresponse(self):
                return self.response
            def close(self):
                pass
        with patch.object(setup.http.client, 'HTTPSConnection', side_effect=[Connection(Response(302, identity)), Connection(Response(200))]) as connect:
            self.assertEqual(setup.verified_identity('https://lab.example.test'), 'https://id.lab.example.test')
            self.assertEqual(connect.call_count, 2)
            for call in connect.call_args_list:
                self.assertTrue(call.kwargs['context'].check_hostname)
                self.assertEqual(call.kwargs['context'].verify_mode, setup.ssl.CERT_REQUIRED)
        for location in ['http://id.lab.example.test/realms/magicstick/protocol/openid-connect/auth',
                         'https://id.lab.example.test/realms/foreign/protocol/openid-connect/auth', 'https://lab.example.test/loop']:
            with patch.object(setup.http.client, 'HTTPSConnection', return_value=Connection(Response(302, location))), self.assertRaises(setup.SetupError):
                setup.verified_identity('https://lab.example.test')

    def test_generic_failure_output_never_contains_source_exceptions_or_tokens(self):
        output = io.StringIO()
        with patch.object(setup, 'registered_setup', side_effect=OSError('sensitive-token')), patch('sys.stderr', output):
            self.assertEqual(setup.main([]), 2)
        self.assertNotIn('sensitive-token', output.getvalue())

    def registered_inputs(self):
        facts, _ = self.auto_inputs()
        facts['inventory'] = {'nodes': [{'nodeUid': 'node-uid'}], 'activeModels': [{'name': 'original-model'}],
                              'runnerArchitecture': 'amd64', 'license': {'hasDocument': True}}
        self.write('setup.json', {'dashboardUrl': facts['dashboardUrl'], 'caFile': 'appliance-ca.pem'})
        args = argparse.Namespace(refresh=False, url=None, username=None, password_file=None, ca_file=None, no_host_mapping=True)
        return facts, args

    def test_registered_setup_and_refresh_have_no_phase_approval_plugin_or_kubeconfig_questions(self):
        facts, args = self.registered_inputs()
        calls = []
        header = b'\x7fELF\x02\x01' + bytes(12) + (62).to_bytes(2, 'little')
        downloaded = self.root / '.oidc-downloaded'
        downloaded.write_bytes(header + b'synthetic pinned binary')
        downloaded.chmod(0o700)
        def api(directory, seed, mode, reviewed=None, approve_admin=False):
            calls.append((mode, approve_admin))
            return facts
        def preparation(directory, arguments):
            self.assertEqual(arguments, ['--automatic'])
            self.write('remaining-p0.json', {'version': 1, 'applications': {'fixtures': []}})
        output = io.StringIO()
        with patch('builtins.input', side_effect=AssertionError('No questionnaire allowed')) as prompt, \
                patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                patch.object(setup, 'setup_api', side_effect=api), patch.object(setup, 'run_preparation', side_effect=preparation), \
                patch.object(setup, 'download_oidc_plugin', return_value=downloaded) as download, patch('sys.stdout', output):
            self.assertTrue(setup.registered_setup(self.root, args))
            registration = json.loads(setup.private_read(self.root / 'lab-registration.json'))
            self.assertEqual(registration['applianceUid'], 'appliance-uid')
            self.assertEqual(registration['nodeUids'], ['node-uid'])
            self.assertEqual([mode for mode, _ in calls], ['inspect', 'suite-inventory', 'register', 'recover-actions', 'export-license', 'stop-models'])
            self.assertTrue(dict(calls)['register'])
            args.refresh = True
            self.assertTrue(setup.registered_setup(self.root, args))
            self.assertIn(('refresh', True), calls)
            prompt.assert_not_called()
            download.assert_called_once_with(self.root, 'amd64', automatic=True)
        saved = json.loads(setup.private_read(self.root / 'setup.json'))
        self.assertEqual(saved['registrationFile'], 'lab-registration.json')
        self.assertEqual(saved['observerKubeconfig'], 'observer.yaml')
        self.assertNotIn('synthetic-password', output.getvalue())
        self.assertNotIn('ACCEPT', output.getvalue())
        self.assertNotIn('synthetic pinned binary', output.getvalue())

    def test_refresh_cannot_register_a_missing_or_replacement_lab(self):
        facts, args = self.registered_inputs()
        args.refresh = True
        with patch('builtins.input') as prompt, patch.object(setup, 'setup_api') as api, self.assertRaises(setup.SetupError):
            setup.registered_setup(self.root, args)
        prompt.assert_not_called()
        api.assert_not_called()
        self.write('lab-registration.json', {'applianceUid': 'old-installation', 'nodeUids': ['node-uid'],
                   'dashboardUrl': facts['dashboardUrl'], 'identityUrl': facts['identityUrl']})
        with patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                patch.object(setup, 'setup_api', return_value=facts) as api, self.assertRaises(setup.SetupError):
            setup.registered_setup(self.root, args)
        self.assertEqual([call.args[2] for call in api.call_args_list], ['inspect', 'suite-inventory'])

    def test_refresh_resumes_only_an_interrupted_registration_for_the_same_lab(self):
        facts, args = self.registered_inputs()
        calls = []
        def failed_bootstrap(directory, seed, mode, reviewed=None, approve_admin=False):
            calls.append(mode)
            if mode == 'register':
                raise setup.SetupError('Synthetic interrupted OIDC bootstrap', 'Failed')
            return facts
        with patch('builtins.input', side_effect=AssertionError('No questionnaire allowed')), \
                patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                patch.object(setup, 'setup_api', side_effect=failed_bootstrap), patch('sys.stdout', io.StringIO()):
            with self.assertRaises(setup.SetupError):
                setup.registered_setup(self.root, args)
        registration = json.loads(setup.private_read(self.root / 'lab-registration.json'))
        pending = self.root / '.setup-registration-pending.json'
        self.assertEqual(json.loads(setup.private_read(pending)), {'version': 1, 'registrationId': registration['id']})
        args.refresh = True
        calls.clear()
        def resumed_bootstrap(directory, seed, mode, reviewed=None, approve_admin=False):
            calls.append(mode)
            if mode == 'recover-actions':
                raise setup.SetupError('Synthetic stop after registration succeeded')
            return facts
        with patch('builtins.input', side_effect=AssertionError('No questionnaire allowed')), \
                patch.object(setup, 'verified_identity', return_value=facts['identityUrl']), \
                patch.object(setup, 'setup_api', side_effect=resumed_bootstrap), patch('sys.stdout', io.StringIO()):
            with self.assertRaises(setup.SetupError):
                setup.registered_setup(self.root, args)
        self.assertEqual(calls, ['inspect', 'suite-inventory', 'register', 'recover-actions'])
        self.assertFalse(pending.exists())
        self.assertEqual(json.loads(setup.private_read(self.root / 'lab-registration.json')), registration)
        self.write('.setup-registration-pending.json', {'version': 1, 'registrationId': 'foreign'})
        with patch.object(setup, 'setup_api') as api, self.assertRaises(setup.SetupError):
            setup.registered_setup(self.root, args)
        api.assert_not_called()

    def test_explicit_ca_and_automatic_architecture_checked_plugin_import_work_without_a_terminal(self):
        ca = '-----BEGIN CERTIFICATE-----\n' + base64.b64encode(b'synthetic public DER').decode() + '\n-----END CERTIFICATE-----\n'
        source = self.write('selected-ca.pem', ca)
        binary = self.root / 'selected-plugin'
        binary.write_bytes(b'\x7fELF\x02\x01' + bytes(12) + (183).to_bytes(2, 'little'))
        binary.chmod(0o700)
        with patch('builtins.input', side_effect=AssertionError('No trust questionnaire')) as prompt, patch('sys.stdout', io.StringIO()):
            setup.import_file(source, self.root / 'imported-ca.pem', ca=True, automatic=True)
            setup.oidc_plugin(binary, self.root / 'arm64-plugin', automatic=True, architecture='arm64')
            with self.assertRaises(setup.SetupError) as mismatch:
                setup.oidc_plugin(binary, self.root / 'wrong-plugin', automatic=True, architecture='amd64')
            self.assertEqual(mismatch.exception.outcome, 'Failed')
        prompt.assert_not_called()


if __name__ == '__main__':
    unittest.main()
