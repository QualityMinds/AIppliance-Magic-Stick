import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from archive_companion import archive_companion, UPSTREAM_REVISION, verify_launcher, verify_transport


def launch_report(platform):
    return {'version': 1, 'platform': platform, 'launcherVerified': True,
            'transportVerified': True, 'loopbackAuthVerified': True, 'meshInferenceVerified': False}


class CompanionArchiveTests(unittest.TestCase):
    def make_runtime(self, directory, name='mesh-llm'):
        directory.mkdir(parents=True)
        binary = directory / name
        binary.write_bytes(b'test transport')
        binary.chmod(0o755)
        checksum = directory / 'magicstick-mesh.sha256'
        checksum.write_text(hashlib.sha256(binary.read_bytes()).hexdigest() + '  ' + name + '\n')
        return binary, checksum

    def test_rejects_changed_binary_before_executing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            binary, checksum = self.make_runtime(Path(directory) / 'runtime')
            binary.write_bytes(b'changed')
            with patch('archive_companion.subprocess.run') as run:
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    verify_transport(binary, checksum)
                run.assert_not_called()

    def test_version_probe_uses_disposable_native_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            binary, checksum = self.make_runtime(Path(directory) / 'runtime')
            with patch('archive_companion.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'mesh-llm 0.76.2\n')) as run:
                verify_transport(binary, checksum)
            self.assertEqual(run.call_args.args[0], [str(binary), '--version'])
            temporary_profile = Path(run.call_args.kwargs['env']['MESH_LLM_DATA_DIR'])
            self.assertFalse(temporary_profile.exists())
            self.assertEqual(run.call_args.kwargs['timeout'], 30)

    def test_rejects_unexpected_native_version(self):
        with tempfile.TemporaryDirectory() as directory:
            binary, checksum = self.make_runtime(Path(directory) / 'runtime')
            with patch('archive_companion.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'mesh-llm 0.99.0\n')):
                with self.assertRaisesRegex(ValueError, 'Unexpected packaged'):
                    verify_transport(binary, checksum)

    def test_platform_label_cannot_misrepresent_build_host(self):
        with patch('archive_companion.sys.platform', 'darwin'), patch('archive_companion.platform.machine', return_value='arm64'):
            with self.assertRaisesRegex(ValueError, 'architecture'):
                archive_companion(Path('/unused'), Path('/unused'), 'macos-x64', 'a' * 40, Path('/unused'))

    def test_unpinned_source_is_rejected(self):
        with patch('archive_companion.sys.platform', 'linux'), patch('archive_companion.platform.machine', return_value='x86_64'):
            with self.assertRaisesRegex(ValueError, 'exact source commit'):
                archive_companion(Path('/unused'), Path('/unused'), 'linux-x64', 'main', Path('/unused'))
            with patch('archive_companion.subprocess.check_output', return_value='b' * 40):
                with self.assertRaisesRegex(ValueError, 'Unexpected native source'):
                    archive_companion(Path('/unused'), Path('/unused'), 'linux-x64', 'a' * 40, Path('/unused'))

    def test_frozen_launcher_requires_successful_matching_report(self):
        def run(arguments, **kwargs):
            Path(arguments[2]).write_text(json.dumps(launch_report(sys.platform)))
            return subprocess.CompletedProcess(arguments, 0)

        with patch('archive_companion.subprocess.run', side_effect=run) as start:
            report = verify_launcher(Path('/fixture/MagicStickMesh'))
        self.assertTrue(report['loopbackAuthVerified'])
        self.assertEqual(start.call_args.args[0][:2], [str(Path('/fixture/MagicStickMesh')), '--self-test-report'])
        self.assertFalse(Path(start.call_args.args[0][2]).exists())
        self.assertEqual(start.call_args.kwargs['timeout'], 60)

    def test_failed_missing_or_incomplete_launch_check_is_rejected(self):
        for change in [None, {'transportVerified': False}, {'loopbackAuthVerified': False},
                       {'launcherVerified': False}, {'platform': 'other'}, {'meshInferenceVerified': True}]:
            with self.subTest(change=change):
                def run(arguments, **kwargs):
                    if change is not None:
                        Path(arguments[2]).write_text(json.dumps(dict(launch_report(sys.platform), **change)))
                    return subprocess.CompletedProcess(arguments, 0)
                with patch('archive_companion.subprocess.run', side_effect=run):
                    with self.assertRaises(ValueError):
                        verify_launcher(Path('/fixture/MagicStickMesh'))
        with patch('archive_companion.subprocess.run', return_value=subprocess.CompletedProcess([], 1)):
            with self.assertRaisesRegex(ValueError, 'launch failed'):
                verify_launcher(Path('/fixture/MagicStickMesh'))

    def test_failed_launch_retains_bounded_self_test_diagnostics(self):
        def run(arguments, **kwargs):
            Path(arguments[2]).write_text(json.dumps({'error': 'ValueError', 'detail': 'fixture startup error'}))
            return subprocess.CompletedProcess(arguments, 1)

        with patch('archive_companion.subprocess.run', side_effect=run):
            with self.assertRaisesRegex(ValueError, 'fixture startup error'):
                verify_launcher(Path('/fixture/MagicStickMesh'))
        with patch('archive_companion.subprocess.run', return_value=subprocess.CompletedProcess([], -9, stderr='fixture loader error')):
            with self.assertRaisesRegex(ValueError, 'exit -9.*fixture loader error'):
                verify_launcher(Path('/fixture/MagicStickMesh'))

    @unittest.skipIf(os.name == 'nt', 'POSIX mode and symlink preservation')
    def test_linux_archive_preserves_runtime_permissions_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            bundle = base / 'bundle'
            app = bundle / 'MagicStickMesh'
            binary, _ = self.make_runtime(app / '_internal')
            (app / '_internal/alias').symlink_to(binary.name)
            (app / 'MagicStickMesh').write_bytes(b'test launcher')
            (app / 'MagicStickMesh').chmod(0o755)
            (bundle / 'unrelated-profile.db').write_text('must not be archived')
            native = base / 'native'
            native.mkdir()
            (native / 'Cargo.lock').write_text('# fixture dependency lock\n')
            outputs = [UPSTREAM_REVISION, 'rustc 1.98.1\n', 'libprotoc 36.2\n']
            with patch('archive_companion.sys.platform', 'linux'), \
                    patch('archive_companion.platform.machine', return_value='x86_64'), \
                    patch('archive_companion.subprocess.check_output', side_effect=outputs), \
                    patch('archive_companion.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'mesh-llm 0.76.2\n')), \
                    patch('archive_companion.verify_launcher', return_value=launch_report('linux')), \
                    patch('archive_companion.importlib.metadata.version', return_value='6.22.3'), \
                    patch('archive_companion.importlib.metadata.distributions', return_value=[]):
                archive = archive_companion(bundle, base / 'artifacts', 'linux-x64', 'a' * 40, native)
            digest, filename = archive.with_name(archive.name + '.sha256').read_text().split()
            self.assertEqual(digest, hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertEqual(filename, archive.name)
            root = 'MagicStickMesh-linux-x64'
            with tarfile.open(archive) as tar:
                self.assertEqual(tar.getmember(root + '/MagicStickMesh/MagicStickMesh').mode & 0o777, 0o755)
                self.assertEqual(tar.getmember(root + '/MagicStickMesh/_internal/mesh-llm').mode & 0o777, 0o755)
                self.assertTrue(tar.getmember(root + '/MagicStickMesh/_internal/alias').issym())
                info = json.load(tar.extractfile(root + '/BUILD-INFO.json'))
                self.assertEqual(info['sourceRevision'], 'a' * 40)
                self.assertEqual(info['releaseStatus'], 'test-artifact')
                self.assertFalse(info['meshInferenceVerified'])
                self.assertTrue(info['launchCheck']['launcherVerified'])
                self.assertIn(root + '/README.md', tar.getnames())
                self.assertIn(root + '/Cargo.lock', tar.getnames())
                self.assertNotIn(root + '/unrelated-profile.db', tar.getnames())

    def test_windows_zip_contains_complete_exe_distribution_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            bundle = base / 'bundle'
            app = bundle / 'MagicStickMesh'
            self.make_runtime(app / '_internal', 'mesh-llm.exe')
            (app / '_internal/python313.dll').write_bytes(b'fixture Python runtime')
            (app / 'MagicStickMesh.exe').write_bytes(b'fixture launcher')
            (bundle / 'unrelated-profile.db').write_text('must not be archived')
            native = base / 'native'
            native.mkdir()
            (native / 'Cargo.lock').write_text('# fixture dependency lock\n')
            with patch('archive_companion.sys.platform', 'win32'), \
                    patch('archive_companion.platform.machine', return_value='AMD64'), \
                    patch('archive_companion.subprocess.check_output', side_effect=[UPSTREAM_REVISION, 'rustc 1.98.1', 'libprotoc 36.2']), \
                    patch('archive_companion.verify_transport') as transport, \
                    patch('archive_companion.verify_launcher', return_value=launch_report('win32')) as launcher, \
                    patch('archive_companion.importlib.metadata.version', return_value='6.22.3'), \
                    patch('archive_companion.importlib.metadata.distributions', return_value=[]):
                archive = archive_companion(bundle, base / 'artifacts', 'windows-x64', 'a' * 40, native)
            transport.assert_called_once_with(app / '_internal/mesh-llm.exe', app / '_internal/magicstick-mesh.sha256')
            launcher.assert_called_once_with(app / 'MagicStickMesh.exe')
            self.assertEqual(archive.name, 'MagicStickMesh-windows-x64.zip')
            self.assertEqual(archive.with_name(archive.name + '.sha256').read_text().split(),
                             [hashlib.sha256(archive.read_bytes()).hexdigest(), archive.name])
            root = 'MagicStickMesh-windows-x64/'
            with zipfile.ZipFile(archive) as zip:
                for name in ['MagicStickMesh/MagicStickMesh.exe', 'MagicStickMesh/_internal/mesh-llm.exe',
                             'MagicStickMesh/_internal/python313.dll', 'README.md', 'Cargo.lock', 'PYTHON-DEPENDENCIES.json']:
                    self.assertIn(root + name, zip.namelist())
                self.assertNotIn(root + 'unrelated-profile.db', zip.namelist())
                info = json.loads(zip.read(root + 'BUILD-INFO.json'))
                self.assertEqual(info['platform'], 'windows-x64')
                self.assertEqual(info['signing'], 'unsigned')
                self.assertEqual(info['sourceRevision'], 'a' * 40)
                self.assertEqual(info['launchCheck'], launch_report('win32'))
                self.assertNotIn('stripped', info['nativeBuildProfile'])


if __name__ == '__main__':
    unittest.main()
