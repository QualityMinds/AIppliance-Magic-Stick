"""Release-builder entry point; end users run the resulting application."""
import argparse
import hashlib
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def write_checksum(binary, destination):
    with binary.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    destination.write_text(digest + '  ' + binary.name + '\n', encoding='utf-8', newline='\n')


def verify_crypto_linkage(library=None):
    if sys.platform != 'darwin':
        return
    if library is None:
        from cryptography.hazmat.bindings import _rust
        library = _rust.__file__
    dependencies = subprocess.check_output(['otool', '-L', str(library)], text=True)
    if re.search(r'\blib(?:ssl|crypto)[^/\s]*\.dylib\b', dependencies):
        raise ValueError('The macOS cryptography binding must use static OpenSSL. Reinstall it with OPENSSL_STATIC=1 and --no-cache-dir before packaging; dynamic OpenSSL can conflict with Python in the frozen app.')


def finalize_bundle(output, binary_name):
    # PyInstaller relocates and signs Mach-O binaries during collection. Hash
    # those final bytes, not the original build input used by --add-binary.
    runtime = output / 'MagicStickMesh' / '_internal'
    write_checksum(runtime / binary_name, runtime / 'magicstick-mesh.sha256')
    if sys.platform == 'darwin':
        app = output / 'MagicStickMesh.app'
        write_checksum(app / 'Contents/Frameworks' / binary_name,
                       app / 'Contents/Resources/magicstick-mesh.sha256')
        # Nested code is already signed. Re-seal only the outer bundle so the
        # checksum stays valid; --deep signing here would change nested bytes.
        subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True, help='Native policy-enabled mesh-llm binary for this operating system')
    parser.add_argument('--upstream-license', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    verify_crypto_linkage()
    source = Path(__file__).resolve().parent
    root = source.parents[3]
    implementation = root / 'core/magicstick_core/private_mesh'
    binary = args.binary.resolve()
    # Reject a plain upstream binary: a role checkbox is not a trust boundary.
    with binary.open('rb') as stream:
        content = stream.read()
    if b'owner control is disabled in the private embedding' not in content:
        raise SystemExit('Build the pinned transport with native/apply_policy.py first.')
    with tempfile.TemporaryDirectory(prefix='magicstick-companion-') as tmp:
        stage = Path(tmp)
        (stage / 'magicstick-mesh.sha256').write_text(hashlib.sha256(content).hexdigest() + '  ' + binary.name + '\n')
        notice = stage / 'THIRD-PARTY-NOTICES.txt'
        notice.write_text('MeshLLM v0.76.2, modified with Magic Stick endpoint and role policy.\n'
                          'Source: https://github.com/Mesh-LLM/mesh-llm/tree/v0.76.2\n\n'
                          + args.upstream_license.read_text() + '\n'
                          'Python: PSF license. cryptography 50.0.1: Apache-2.0 OR BSD-3-Clause.\n'
                          'PyInstaller 6.22.3: GPL-2.0-or-later with bootloader exception.\n'
                          'PyJWT: MIT.\n'
                          'Magic Stick: Business Source License 1.1.\n'
                          + (root / 'LICENSE').read_text() + '\n'
                          + (root / 'licenses/MIT-CHANGE.txt').read_text() + '\n'
                          + (root / 'THIRD_PARTY_NOTICES.md').read_text() + '\n'
                          + (root / 'licenses/third-party/python.txt').read_text() + '\n'
                          + (root / 'LICENSING.md').read_text())
        command = [sys.executable, '-m', 'PyInstaller', '--clean', '--noconfirm', '--onedir',
                   '--name', 'MagicStickMesh', '--distpath', str(args.output.resolve()),
                   '--workpath', str(stage / 'build'), '--specpath', str(stage), '--paths', str(source),
                   '--paths', str(implementation), '--paths', str(root / 'dashboard/apps/api'),
                   '--add-binary', f'{binary}:.', '--add-data', f'{source / "client.html"}:.',
                   '--add-data', f'{stage / "magicstick-mesh.sha256"}:.', '--add-data', f'{notice}:.',
                   '--add-data', f'{root / "LICENSE-RELEASE.json"}:.']
        if sys.platform == 'darwin':
            command += ['--windowed', '--osx-bundle-identifier', 'com.qualityminds.magicstick.mesh']
        elif sys.platform == 'win32':
            command += ['--windowed']
        command.append(str(implementation / 'desktop_client.py'))
        subprocess.run(command, check=True)
    finalize_bundle(args.output.resolve(), binary.name)
    print('Companion bundle created. Platform signing/notarization and launch acceptance remain release gates.')


if __name__ == '__main__':
    main()
