import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

from build_companion import finalize_bundle, verify_crypto_linkage


class CompanionPackagingTests(unittest.TestCase):
    def make_runtime(self, directory, content):
        directory.mkdir(parents=True)
        (directory / 'mesh-llm').write_bytes(content)
        (directory / 'magicstick-mesh.sha256').write_text('outdated-build-input-checksum\n')

    def test_records_packaged_binary_in_standalone_distribution(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            runtime = output / 'MagicStickMesh/_internal'
            self.make_runtime(runtime, b'final collected binary')
            with patch('build_companion.sys.platform', 'linux'), patch('build_companion.subprocess.run') as sign:
                finalize_bundle(output, 'mesh-llm')
            self.assertEqual((runtime / 'magicstick-mesh.sha256').read_text(),
                             hashlib.sha256(b'final collected binary').hexdigest() + '  mesh-llm\n')
            sign.assert_not_called()

    def test_macos_hashes_nested_code_before_resealing_only_outer_app(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            self.make_runtime(output / 'MagicStickMesh/_internal', b'standalone binary')
            app = output / 'MagicStickMesh.app'
            framework = app / 'Contents/Frameworks'
            framework.mkdir(parents=True)
            (framework / 'mesh-llm').write_bytes(b'final signed app binary')
            resources = app / 'Contents/Resources'
            resources.mkdir(parents=True)
            checksum = resources / 'magicstick-mesh.sha256'
            checksum.write_text('old\n')

            def check_order(*args, **kwargs):
                self.assertEqual(checksum.read_text(),
                                 hashlib.sha256(b'final signed app binary').hexdigest() + '  mesh-llm\n')

            with patch('build_companion.sys.platform', 'darwin'), patch('build_companion.subprocess.run', side_effect=check_order) as sign:
                finalize_bundle(output, 'mesh-llm')
            self.assertEqual(sign.call_args_list, [
                call(['codesign', '--force', '--sign', '-', str(app)], check=True),
                call(['codesign', '--verify', '--deep', '--strict', str(app)], check=True),
            ])

    def test_incomplete_distribution_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                finalize_bundle(Path(directory), 'mesh-llm')

    def test_windows_records_final_exe_without_macos_signing(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            runtime = output / 'MagicStickMesh/_internal'
            runtime.mkdir(parents=True)
            (runtime / 'mesh-llm.exe').write_bytes(b'final Windows executable')
            with patch('build_companion.sys.platform', 'win32'), patch('build_companion.subprocess.run') as sign:
                finalize_bundle(output, 'mesh-llm.exe')
            self.assertEqual((runtime / 'magicstick-mesh.sha256').read_text().split(),
                             [hashlib.sha256(b'final Windows executable').hexdigest(), 'mesh-llm.exe'])
            self.assertNotIn(b'\r', (runtime / 'magicstick-mesh.sha256').read_bytes())
            sign.assert_not_called()

    def test_macos_rejects_dynamic_openssl_before_building_the_bundle(self):
        for library in ['@rpath/libssl.3.dylib', '/usr/local/opt/openssl@3/lib/libcrypto.3.dylib']:
            with self.subTest(library=library), patch('build_companion.sys.platform', 'darwin'), \
                    patch('build_companion.subprocess.check_output', return_value='_rust.abi3.so:\n\t' + library):
                with self.assertRaisesRegex(ValueError, 'OPENSSL_STATIC=1'):
                    verify_crypto_linkage('/fixture/_rust.abi3.so')

    def test_static_macos_crypto_is_accepted_and_other_platforms_are_unchanged(self):
        with patch('build_companion.sys.platform', 'darwin'), \
                patch('build_companion.subprocess.check_output', return_value='_rust.abi3.so:\n\t/usr/lib/libSystem.B.dylib') as inspect:
            verify_crypto_linkage('/fixture/_rust.abi3.so')
            inspect.assert_called_once_with(['otool', '-L', '/fixture/_rust.abi3.so'], text=True)
        for platform in ['win32', 'linux']:
            with patch('build_companion.sys.platform', platform), patch('build_companion.subprocess.check_output') as inspect:
                verify_crypto_linkage()
                inspect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
