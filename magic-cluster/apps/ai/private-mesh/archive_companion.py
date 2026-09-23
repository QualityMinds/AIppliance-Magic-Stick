"""Verify and archive a clean companion build, preserving executable metadata."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

from build_companion import write_checksum


TARGETS = {
    'macos-arm64': ('darwin', 'arm64'),
    'macos-x64': ('darwin', 'x86_64'),
    'linux-x64': ('linux', 'x86_64'),
    'windows-x64': ('win32', 'x86_64'),
}
UPSTREAM_REVISION = 'a0c1e66b0ac037dd56544b9e2d94969ea43d694f'


def verify_transport(binary, checksum):
    with binary.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if checksum.read_text().split() != [actual, binary.name]:
        raise ValueError('Packaged transport checksum mismatch; refusing to publish.')
    # --version can initialize the native cache. Never use the user's profile.
    with tempfile.TemporaryDirectory(prefix='mesh-archive-probe-') as directory:
        env = dict(os.environ, MESH_LLM_DATA_DIR=directory)
        result = subprocess.run([str(binary), '--version'], env=env, text=True,
                                capture_output=True, timeout=30, check=True)
    if result.stdout.strip() != 'mesh-llm 0.76.2':
        raise ValueError('Unexpected packaged MeshLLM version; refusing to publish.')


def verify_launcher(launcher):
    # Exercise the frozen application, not the build host's Python modules.
    # It creates only disposable state, never joins a mesh or opens a browser.
    with tempfile.TemporaryDirectory(prefix='mesh-launch-probe-') as directory:
        report = Path(directory) / 'launch.json'
        result = subprocess.run([str(launcher), '--self-test-report', str(report)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=60)
        if result.returncode != 0 or not report.is_file():
            # The self-test only uses disposable, unconfigured state. Preserve
            # its bounded diagnostic rather than hiding every platform error.
            detail = report.read_text(encoding='utf-8') if report.is_file() else (result.stderr or 'No self-test report was written.')
            raise ValueError(f'Packaged client launch failed (exit {result.returncode}); refusing to publish. {detail[:1500]}')
        info = json.loads(report.read_text(encoding='utf-8'))
        if (info.get('version') != 1 or info.get('platform') != sys.platform
                or info.get('launcherVerified') is not True
                or info.get('transportVerified') is not True
                or info.get('loopbackAuthVerified') is not True
                or info.get('meshInferenceVerified') is not False):
            raise ValueError('Packaged client launch checks did not pass.')
        return info


def archive_companion(bundle, output, target, revision, native_source):
    machine = platform.machine().lower()
    machine = {'amd64': 'x86_64', 'aarch64': 'arm64'}.get(machine, machine)
    if (sys.platform, machine) != TARGETS[target]:
        raise ValueError('Build host does not match the requested artifact architecture.')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('An exact source commit is required.')
    upstream = subprocess.check_output(
        ['git', '-C', str(native_source), 'rev-parse', 'HEAD'], text=True).strip()
    if upstream != UPSTREAM_REVISION:
        raise ValueError('Unexpected native source revision.')
    is_mac = target.startswith('macos-')
    is_windows = target == 'windows-x64'
    app = bundle / ('MagicStickMesh.app' if is_mac else 'MagicStickMesh')
    runtime = app / ('Contents/Frameworks' if is_mac else '_internal')
    checksum = app / 'Contents/Resources/magicstick-mesh.sha256' if is_mac else runtime / 'magicstick-mesh.sha256'
    verify_transport(runtime / ('mesh-llm.exe' if is_windows else 'mesh-llm'), checksum)
    if is_mac:
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    launcher = app / ('Contents/MacOS/MagicStickMesh' if is_mac else 'MagicStickMesh.exe' if is_windows else 'MagicStickMesh')
    launch_check = verify_launcher(launcher)

    output.mkdir(parents=True, exist_ok=True)
    name = 'MagicStickMesh-' + target
    archive = output / (name + ('.zip' if is_mac or is_windows else '.tar.gz'))
    with tempfile.TemporaryDirectory(prefix='mesh-client-archive-') as directory:
        package = Path(directory) / name
        package.mkdir()
        if is_mac:
            subprocess.run(['ditto', str(app), str(package / app.name)], check=True)
        else:
            shutil.copytree(app, package / app.name, symlinks=True)
        shutil.copyfile(Path(__file__).with_name('COMPANION-README.md'), package / 'README.md')
        shutil.copyfile(native_source / 'Cargo.lock', package / 'Cargo.lock')
        dependencies = sorted(
            [{'name': item.metadata['Name'], 'version': item.version}
             for item in importlib.metadata.distributions()], key=lambda item: item['name'].lower())
        (package / 'PYTHON-DEPENDENCIES.json').write_text(json.dumps(dependencies, indent=2) + '\n')
        info = {
            'platform': target, 'sourceRevision': revision,
            'sourceLicense': 'BUSL-1.1',
            'licenseRelease': json.loads((Path(__file__).resolve().parents[4] / 'LICENSE-RELEASE.json').read_text()),
            'meshLLM': {'version': '0.76.2', 'revision': upstream, 'privatePolicy': True},
            'python': platform.python_version(), 'pyinstaller': importlib.metadata.version('pyinstaller'),
            'rust': subprocess.check_output(['rustc', '+1.98.1', '--version'], text=True).strip(),
            'protoc': subprocess.check_output(['protoc', '--version'], text=True).strip(),
            'nativeBuildProfile': 'dev, debug=0; dynamic-native-runtime only' + ('' if is_windows else '; stripped'),
            'signing': 'ad-hoc; not Developer ID signed or notarized' if is_mac else 'unsigned',
            'releaseStatus': 'test-artifact', 'meshInferenceVerified': False,
            'launchCheck': launch_check,
        }
        (package / 'BUILD-INFO.json').write_text(json.dumps(info, indent=2) + '\n')
        if is_mac:
            subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent',
                            str(package), str(archive)], check=True)
        elif is_windows:
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zip:
                for file in sorted(package.rglob('*')):
                    if file.is_file():
                        zip.write(file, file.relative_to(package.parent).as_posix())
        else:
            with tarfile.open(archive, 'w:gz') as tar:
                tar.add(package, arcname=name)
    write_checksum(archive, archive.with_name(archive.name + '.sha256'))
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--platform', choices=TARGETS, required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--native-source', type=Path, required=True)
    args = parser.parse_args()
    archive = archive_companion(args.bundle.resolve(), args.output.resolve(), args.platform,
                                args.revision, args.native_source.resolve())
    print(f'Verified test artifact: {archive}')


if __name__ == '__main__':
    main()
