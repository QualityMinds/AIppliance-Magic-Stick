"""Local runner startup guards; no Docker daemon or appliance is contacted."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class RegressionLauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='regression launcher ')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.log = self.root / 'calls.jsonl'
        self.docker = self.root / 'fake docker.py'
        self.docker.write_text('''
import json, os, sys
args = sys.argv[1:]
with open(os.environ['FAKE_DOCKER_LOG'], 'a') as output:
    output.write(json.dumps(args) + '\\n')
if args == ['info']:
    sys.exit(int(os.environ.get('FAKE_DOCKER_DOWN', '0')))
if args[:2] == ['image', 'inspect']:
    sys.exit(int(os.environ.get('FAKE_IMAGE_MISSING', '0')))
if args and args[0] in ['build', 'compose']:
    with open(os.environ['FAKE_RUN_ENV_LOG'], 'a') as output:
        output.write(json.dumps({key: os.environ.get(key) for key in ['REGRESSION_INPUT_DIR', 'REGRESSION_PREPARATION_FAILED']}) + '\\n')
    sys.exit(0)
sys.exit(9)
''')
        preparation = self.root / 'fake preparation.py'
        preparation.write_text('''
import json, os, sys
with open(os.environ['FAKE_SETUP_LOG'], 'a') as output:
    output.write(json.dumps(sys.argv[1:]) + '\\n')
sys.exit(int(os.environ.get('FAKE_PREPARATION_EXIT', '0')))
''')
        git = self.root / 'fake git.py'
        git.write_text('''
import sys
if sys.argv[-2:] == ['rev-parse', 'HEAD']:
    print('a' * 40)
elif sys.argv[-2:] != ['status', '--porcelain']:
    sys.exit(9)
''')
        self.environment = {
            **os.environ,
            'DOCKER_CLI': 'regression_docker_fixture',
            'FAKE_PYTHON': sys.executable,
            'FAKE_DOCKER_SCRIPT': str(self.docker),
            'FAKE_GIT_SCRIPT': str(git),
            'FAKE_DOCKER_LOG': str(self.log),
            'FAKE_RUN_ENV_LOG': str(self.root / 'run-environment.jsonl'),
            'FAKE_SETUP_SCRIPT': str(preparation),
            'FAKE_SETUP_LOG': str(self.root / 'setup.jsonl'),
            'REGRESSION_SETUP_PYTHON': 'regression_setup_fixture',
            'FAKE_DOCKER_DOWN': '0',
            'FAKE_IMAGE_MISSING': '0',
            'REGRESSION_RUNNER_IMAGE': 'magicstick-regression:local',
            'REGRESSION_INPUT_DIR': str(self.root / 'inputs'),
            'REGRESSION_PRIVATE_DIR': str(self.root / 'reports'),
        }
        self.environment.pop('REGRESSION_COMPOSE_OVERRIDE', None)

    def run_launcher(self, mode, *arguments, **environment):
        # The hardened runner mounts /tmp noexec. Read fixture scripts with the
        # trusted interpreter instead of executing files from that mount. These
        # exported functions also prevent accidentally invoking real Docker/Git.
        wrapper = '''
regression_docker_fixture() {
    "$FAKE_PYTHON" "$FAKE_DOCKER_SCRIPT" "$@"
}
git() {
    "$FAKE_PYTHON" "$FAKE_GIT_SCRIPT" "$@"
}
regression_setup_fixture() {
    "$FAKE_PYTHON" "$FAKE_SETUP_SCRIPT" "$@"
}
export -f regression_docker_fixture regression_setup_fixture git
exec bash "$@"
'''
        return subprocess.run(
            ['bash', '-c', wrapper, 'regression-launcher-test',
             str(ROOT / 'tools/regression.sh'), mode, *arguments], cwd=ROOT,
            env={**self.environment, **environment}, capture_output=True,
            text=True, timeout=10,
        )

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_missing_image_stops_before_creating_a_container_or_private_directories(self):
        result = self.run_launcher('phase6-fixtures', FAKE_IMAGE_MISSING='1')
        self.assertEqual(result.returncode, 2)
        self.assertIn('magicstick-regression:local', result.stderr)
        self.assertIn('bash tools/regression.sh build', result.stderr)
        self.assertIn('context switch', result.stderr)
        self.assertEqual(self.calls(), [['info'], ['image', 'inspect', 'magicstick-regression:local']])
        self.assertFalse((self.root / 'inputs').exists())
        self.assertFalse((self.root / 'reports').exists())

    def test_daemon_unavailable_is_not_reported_as_a_missing_image(self):
        result = self.run_launcher('phase5-fast', FAKE_DOCKER_DOWN='1')
        self.assertEqual(result.returncode, 2)
        self.assertIn('Cannot reach the active Docker daemon', result.stderr)
        self.assertNotIn('Build it first', result.stderr)
        self.assertEqual(self.calls(), [['info']])

    def test_present_image_runs_only_the_requested_suite_without_a_pull_or_build(self):
        result = self.run_launcher('phase7-fast')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(calls[:2], [['info'], ['image', 'inspect', 'magicstick-regression:local']])
        self.assertEqual(calls[2][0], 'compose')
        self.assertEqual(calls[2][-6:], ['run', '--rm', '--no-deps', '-T', 'regression', 'phase7-fast'])
        self.assertTrue((self.root / 'inputs').is_dir())
        self.assertTrue((self.root / 'reports').is_dir())

    def test_custom_image_name_is_checked_and_retained_in_build_guidance(self):
        result = self.run_launcher('typecheck', FAKE_IMAGE_MISSING='1', REGRESSION_RUNNER_IMAGE='custom-runner:test')
        self.assertEqual(result.returncode, 2)
        self.assertIn('REGRESSION_RUNNER_IMAGE=custom-runner:test', result.stderr)
        self.assertEqual(self.calls()[-1], ['image', 'inspect', 'custom-runner:test'])

    def test_build_and_help_do_not_require_an_existing_image(self):
        result = self.run_launcher('build', FAKE_IMAGE_MISSING='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0][0], 'build')
        self.assertIn('SOURCE_REVISION=' + 'a' * 40, self.calls()[0])
        self.assertIn('magicstick-regression:local', self.calls()[0])
        self.log.unlink()
        result = self.run_launcher('help', FAKE_DOCKER_DOWN='1')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_prepare_uses_only_separate_writable_input_service_and_forwards_bounded_arguments(self):
        result = self.run_launcher('prepare', '--phases', '0-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-1][-6:], ['run', '--rm', '--no-deps', 'prepare', '--phases', '0-8'])

    def test_private_generated_dns_override_is_used_without_reading_or_printing_its_content(self):
        inputs = self.root / 'inputs'
        inputs.mkdir()
        override = inputs / 'compose.override.yaml'
        override.write_text('private synthetic mappings')
        result = self.run_launcher('prepare', '--phases', '0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(override), self.calls()[-1])
        self.assertNotIn('private synthetic mappings', result.stdout + result.stderr)

    def test_full_phases_refresh_without_stdin_and_run_the_case_ledger_even_when_preparation_is_blocked(self):
        for mode in ['phase0', 'phase1', 'all']:
            with self.subTest(mode=mode):
                result = self.run_launcher(mode, FAKE_PREPARATION_EXIT='2')
                self.assertEqual(result.returncode, 0, result.stderr)  # Inert Docker adapter, not a live acceptance.
                self.assertIn('Continuing isolated tests', result.stderr)
                self.assertEqual(self.calls()[-1][-6:], ['run', '--rm', '--no-deps', '-T', 'regression', mode])
                environment = json.loads((self.root / 'run-environment.jsonl').read_text().splitlines()[-1])
                self.assertEqual(environment['REGRESSION_PREPARATION_FAILED'], 'Blocked')
                refresh = json.loads((self.root / 'setup.jsonl').read_text().splitlines()[-1])
                self.assertEqual(refresh, [str(ROOT / 'tools/regression_inputs.py'), '--refresh'])
                self.log.unlink()

    def test_preparation_failure_is_forwarded_as_failed_not_missing_hardware(self):
        result = self.run_launcher('all', FAKE_PREPARATION_EXIT='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        environment = json.loads((self.root / 'run-environment.jsonl').read_text().splitlines()[-1])
        self.assertEqual(environment['REGRESSION_PREPARATION_FAILED'], 'Failed')

    def test_accepted_input_presence_does_not_bypass_runner_validation_or_start_a_different_mode(self):
        inputs = self.root / 'inputs'
        inputs.mkdir()
        (inputs / 'lab.json').write_text('{}')  # Actual schema/pin/RBAC checks remain inside the runner.
        result = self.run_launcher('preflight')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-1][-6:], ['run', '--rm', '--no-deps', '-T', 'regression', 'preflight'])

    def test_interrupted_bootstrap_never_mounts_an_admin_token_into_regular_test_or_prepare_service(self):
        inputs = self.root / 'inputs'
        inputs.mkdir()
        (inputs / 'lab.json').write_text('{}')
        for name in ['.setup-access-restore.json', '.setup-bootstrap.kubeconfig']:
            for mode in ['prepare', 'preflight']:
                with self.subTest(name=name, mode=mode):
                    (inputs / name).write_text('synthetic interrupted setup')
                    result = self.run_launcher(mode)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('interrupted setup', result.stderr)
                    self.assertEqual(self.calls(), [['info'], ['image', 'inspect', 'magicstick-regression:local']])
                    (inputs / name).unlink()
                    self.log.unlink()
            with self.subTest(name=name, mode='phase2-fast'):
                (inputs / name).write_text('synthetic interrupted setup')
                result = self.run_launcher('phase2-fast')
                self.assertEqual(result.returncode, 0, result.stderr)
                environment = json.loads((self.root / 'run-environment.jsonl').read_text().splitlines()[-1])
                self.assertEqual(environment['REGRESSION_INPUT_DIR'], str(self.root / 'reports/blocked-inputs'))
                self.assertNotIn(str(inputs), json.dumps(self.calls()[-1]))
                (inputs / name).unlink()
                self.log.unlink()


if __name__ == '__main__':
    unittest.main()
