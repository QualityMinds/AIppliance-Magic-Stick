# SPDX-License-Identifier: BUSL-1.1
"""Keep cleanup boundaries, branch defaults and build filters explicit."""
import fnmatch
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


def workflow(name):
    return yaml.load((ROOT / '.github/workflows' / (name + '.yml')).read_text(), Loader=yaml.BaseLoader)


def selected(path, patterns):
    include = False
    for pattern in patterns:
        negative = pattern.startswith('!')
        glob = pattern.lstrip('!')
        # GitHub's **/ also matches zero directories (unlike fnmatch).
        if fnmatch.fnmatchcase(path, glob) or ('**/' in glob and fnmatch.fnmatchcase(path, glob.replace('**/', ''))):
            include = not negative
    return include


@unittest.skipUnless(os.name != 'nt' and shutil.which('bash'), 'Unix dependency step requires Bash')
class CompanionRustDownloadTests(unittest.TestCase):
    def run_dependency_step(self, failures):
        definition = workflow('build-mesh-companion')
        step = next(step for step in definition['jobs']['build']['steps']
                    if step.get('name') == 'Build dependencies')
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            commands = temporary / 'bin'
            commands.mkdir()
            stub = textwrap.dedent('''\
                #!/bin/sh
                case "$(basename "$0")" in
                  uname) printf '%s\\n' "$EXPECTED_MACHINE" ;;
                  curl|shasum|unzip) exit 0 ;;
                  sleep) printf 'sleep %s\\n' "$*" >> "$RUST_TEST_LOG" ;;
                  rustup)
                    count=0
                    if [ -f "$RUST_TEST_STATE" ]; then read -r count < "$RUST_TEST_STATE"; fi
                    count=$((count + 1))
                    printf '%s\\n' "$count" > "$RUST_TEST_STATE"
                    printf 'rustup %s\\n' "$*" >> "$RUST_TEST_LOG"
                    if [ "$count" -le "$RUST_TEST_FAILURES" ]; then exit 1; fi
                    ;;
                  python) printf 'pip static=%s %s\\n' "$OPENSSL_STATIC" "$*" >> "$RUST_TEST_LOG" ;;
                esac
                ''')
            for name in ('uname', 'curl', 'shasum', 'unzip', 'sleep', 'rustup', 'python'):
                executable = commands / name
                executable.write_text(stub)
                executable.chmod(0o755)
            log = temporary / 'calls.log'
            environment = os.environ | definition['env'] | {
                'PATH': str(commands) + os.pathsep + os.environ['PATH'],
                'RUNNER_OS': 'macOS', 'EXPECTED_MACHINE': 'x86_64',
                'PROTOC_PLATFORM': 'osx-x86_64', 'PROTOC_SHA256': 'synthetic-checksum',
                'RUNNER_TEMP': str(temporary), 'GITHUB_PATH': str(temporary / 'paths'),
                'RUST_TEST_LOG': str(log), 'RUST_TEST_STATE': str(temporary / 'attempts'),
                'RUST_TEST_FAILURES': str(failures),
            }
            result = subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step['run']],
                                    cwd=ROOT, env=environment, capture_output=True, text=True, timeout=10)
            calls = log.read_text().splitlines()
        return result, calls, definition['env']['RUST_VERSION']

    def assert_install_calls(self, calls, version, attempts, pip):
        self.assertEqual([call for call in calls if call.startswith('rustup ')],
                         [f'rustup toolchain install {version} --profile minimal'] * attempts)
        self.assertEqual(len([call for call in calls if call.startswith('sleep ')]), attempts - 1)
        self.assertEqual(len([call for call in calls if call.startswith('pip static=1 ')]), pip)

    def test_success_installs_pinned_toolchain_once(self):
        result, calls, version = self.run_dependency_step(failures=0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_install_calls(calls, version, attempts=1, pip=1)

    def test_transient_failures_retry_before_installing_python_dependencies(self):
        result, calls, version = self.run_dependency_step(failures=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_install_calls(calls, version, attempts=3, pip=1)

    def test_exhausted_retries_stop_before_installing_python_dependencies(self):
        result, calls, version = self.run_dependency_step(failures=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('failed after 3 attempts', result.stderr)
        self.assert_install_calls(calls, version, attempts=3, pip=0)


class RepositoryHygieneTests(unittest.TestCase):
    def test_real_git_exclusions_cover_current_and_legacy_private_paths(self):
        for name in ('magic-host/inventory/host_vars/example.vault.yml',
                     'magic-host/inventory/host_vars/example.vault.yaml',
                     'infra-host/inventory/host_vars/example.vault.yml',
                     'dist/example.img', '.build/example/output',
                     'dashboard/apps/web/playwright-report/index.html',
                     'dashboard/apps/web/test-results/fixture/trace.zip'):
            with self.subTest(path=name):
                result = subprocess.run(['git', 'check-ignore', '--no-index', '-q', name], cwd=ROOT)
                self.assertEqual(result.returncode, 0)
        tracked = subprocess.check_output(['git', 'ls-files', '--', 'dist', '.build'], cwd=ROOT, text=True)
        self.assertEqual(tracked, '')

    def test_docker_context_has_explicit_private_and_local_output_guards(self):
        patterns = set((ROOT / '.dockerignore').read_text().splitlines())
        for pattern in ('**/.env', '**/.env.*', '**/*.env', '**/*.vault.yml', '**/*.vault.yaml',
                        '**/kubeconfig', '**/kubeconfig.yaml', '**/*.key', '**/*private*.pem',
                        '.build', 'audit-output', '**/dist', '**/node_modules', '**/test-results'):
            self.assertIn(pattern, patterns)
        self.assertNotIn('magic-host', patterns)
        self.assertNotIn('dashboard', patterns)

    def test_dashboard_build_ignores_docs_but_keeps_shared_runtime_inputs(self):
        push = workflow('build-dashboard-image')['on']['push']
        self.assertEqual(push['branches'], ['main', 'develop'])
        for path in ('dashboard/apps/web/src/App.tsx', 'dashboard/apps/api/server.py',
                     'dashboard/pnpm-lock.yaml', 'core/magicstick_core/license.py',
                     'magic-host/roles/host-management/files/network_contract.py', '.dockerignore'):
            self.assertTrue(selected(path, push['paths']), path)
        for path in ('dashboard/README.md', 'dashboard/apps/web/README.md',
                     'docs/user-guide/dashboard.md', 'tools/docs.py'):
            self.assertFalse(selected(path, push['paths']), path)

    def test_mesh_build_does_not_follow_unrelated_tools(self):
        definition = workflow('build-mesh-image')['on']
        for event in ('push', 'pull_request'):
            patterns = definition[event]['paths']
            for path in ('tools/license_audit.py', 'tools/collect_python_notices.py',
                         'magic-cluster/apps/ai/private-mesh/main.py', '.dockerignore'):
                self.assertTrue(selected(path, patterns), path)
            for path in ('tools/docs.py', 'tools/release.py', 'tools/update_runtime_images.py'):
                self.assertFalse(selected(path, patterns), path)

    def test_mesh_companion_checks_checkout_before_expensive_builds(self):
        definition = workflow('build-mesh-companion')
        for event in ('push', 'pull_request'):
            self.assertTrue(selected('.gitattributes', definition['on'][event]['paths']))
        steps = definition['jobs']['build']['steps']
        license_check = next(i for i, step in enumerate(steps)
                             if 'tools/license_audit.py --review' in step.get('run', ''))
        self.assertIn('test_lockfile_checkout_preserves_lf_with_windows_conversion',
                      steps[license_check]['run'])
        dependencies = next(i for i, step in enumerate(steps) if step.get('name') == 'Build dependencies')
        native = next(i for i, step in enumerate(steps) if step.get('name') == 'Build pinned Windows private transport')
        self.assertLess(license_check, dependencies)
        self.assertLess(license_check, native)
        self.assertNotIn('continue-on-error', steps[license_check])

    def test_development_builds_do_not_publish_production_aliases(self):
        for name in ('build-dashboard-image', 'build-mesh-image', 'build-amd-dra-image',
                     'build-freetoken-image', 'build-omni-rocm-image', 'build-kdns-image',
                     'build-mesh-companion'):
            self.assertEqual(workflow(name)['on']['push']['branches'], ['main', 'develop'], name)
        for name in ('build-dashboard-image', 'build-freetoken-image', 'build-kdns-image'):
            value = (ROOT / '.github/workflows' / (name + '.yml')).read_text()
            raw = [line for line in value.splitlines() if 'type=raw,value=' in line]
            for line in raw:
                self.assertIn('enable=${{ github.ref ==', line)
                self.assertIn('develop' if 'develop' in line.split(',enable=')[0] else 'main', line.split(',enable=')[1])
        for name in ('build-mesh-image', 'build-amd-dra-image'):
            value = (ROOT / '.github/workflows' / (name + '.yml')).read_text()
            self.assertIn("github.ref == 'refs/heads/main' && 'v", value)
            self.assertIn("|| 'develop'", value)

    def test_old_images_and_collateral_are_not_shipped(self):
        self.assertFalse((ROOT / 'docs/assets/dashboard-overview.webp').exists())
        self.assertFalse((ROOT / 'docs/assets/dashboard-models.webp').exists())
        self.assertTrue((ROOT / 'docs/assets/screenshots/dashboard-overview.webp').is_file())
        remaining = [p.name for p in (ROOT / 'docs/sales-deck').rglob('*') if p.is_file()]
        self.assertEqual(remaining, ['README.md'])
        self.assertNotIn("'sales-deck'", (ROOT / 'tools/docs.py').read_text())

    def test_update_proposals_are_not_automatic_releases(self):
        value = workflow('runtime-image-updates')
        self.assertEqual(value['on']['schedule'][0]['cron'], '23 5 * * 1')
        proposal = next(s for s in value['jobs']['updates']['steps']
                        if s.get('uses', '').startswith('peter-evans/create-pull-request'))
        self.assertEqual(proposal['with']['base'], 'develop')
        self.assertIn('runtime-images.json', proposal['with']['add-paths'])
        self.assertIn('licenses/dependency-inventory.json', proposal['with']['add-paths'])
        self.assertNotIn('gh pr merge', json.dumps(value))
        draft = workflow('release-draft')
        self.assertEqual(set(draft['on']), {'workflow_dispatch'})
        commands = '\n'.join(s.get('run', '') for s in draft['jobs']['draft']['steps'])
        self.assertIn('merge-base --is-ancestor', commands)
        self.assertIn('--verify-tag --draft', commands)
        self.assertNotIn('--release', commands)
