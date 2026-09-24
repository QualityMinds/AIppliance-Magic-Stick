# SPDX-License-Identifier: BUSL-1.1
"""Content-addressed installer candidates; no product release or live rollout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = '.github/workflows/build-installer-image.yml'
INPUTS = (
    WORKFLOW, 'tools/installer_artifact.py', 'magic-installer/ci-build.json',
    'magic-installer/Containerfile', 'magic-installer/build-installer-image.sh',
    'magic-installer/scripts/build-installer-image-container.sh',
    'magic-installer/scripts/installer-media.py',
    'magic-installer/user-data', 'magic-installer/meta-data', 'LICENSE', 'LICENSING.md',
)
OPTIONAL_INPUTS = ('magic-installer/.dockerignore',)
GIB = 1024 ** 3
REPOSITORY = 'QualityMinds/AIppliance-Magic-Stick'
SHA256 = re.compile(r'[0-9a-f]{64}')
REVISION = re.compile(r'[0-9a-f]{40}')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def plan(root, channel, revision):
    if channel not in {'main', 'develop'} or not REVISION.fullmatch(revision):
        raise ValueError('An exact source commit on main or develop is required')
    root = Path(root)
    config = json.loads((root / 'magic-installer/ci-build.json').read_text())
    expected = {'schemaVersion': 1, 'architecture': 'amd64', 'offlinePool': 'online',
                'hostname': 'example-host-01', 'releaseStatus': 'test-build',
                'publicRepository': f'https://github.com/{REPOSITORY}.git'}
    if (set(config) != set(expected) | {'recipeRevision'}
            or any(config.get(k) != v for k, v in expected.items())
            or type(config.get('recipeRevision')) is not int or config['recipeRevision'] < 1):
        raise ValueError('CI only builds the reviewed public, token-free online installer profile')
    files = {}
    for name in (*INPUTS, *OPTIONAL_INPUTS):
        path = root / name
        if not path.exists() and name in OPTIONAL_INPUTS and not path.is_symlink():
            files[name] = None
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Missing or unsafe build input: {name}')
        files[name] = {'sha256': digest(path), 'executable': bool(path.stat().st_mode & 0o111)}
    script = (root / 'magic-installer/build-installer-image.sh').read_text()
    iso = {}
    for field, variable in [('url', 'URL'), ('sha256', 'SHA256')]:
        matches = re.findall(r'^DEFAULT_UBUNTU_ISO_' + variable + r'="([^"\n]+)"$', script, re.M)
        if len(matches) != 1:
            raise ValueError('Cannot identify the pinned Ubuntu ISO')
        iso[field] = matches[0]
    if not SHA256.fullmatch(iso['sha256']) or not iso['url'].startswith('https://releases.ubuntu.com/'):
        raise ValueError('CI requires a checksum-pinned official Ubuntu ISO')
    identity = {'schemaVersion': 1, 'channel': channel, 'config': config, 'inputs': files, 'ubuntu': iso}
    fingerprint = hashlib.sha256(json_bytes(identity)).hexdigest()
    stem = f'magicstick-installer-{channel}-amd64-online-{fingerprint[:16]}'
    return {**identity, 'fingerprint': fingerprint, 'sourceRevision': revision,
            'tag': f'installer-{channel}-{fingerprint}', 'stem': stem, 'imageName': stem + '.img'}


def check_plan(value, root):
    expected = plan(root, value['channel'], value['sourceRevision'])
    if value != expected:
        raise ValueError('Build inputs changed after planning; refusing stale artifact identity')


def gh(*args, binary=False, timeout=120):
    result = subprocess.run(['gh', *map(str, args)], check=True, capture_output=True, timeout=timeout)
    return result.stdout if binary else result.stdout.decode()


def api(path, optional=False, *args):
    try:
        return json.loads(gh('api', path, *args))
    except subprocess.CalledProcessError as exc:
        if optional and b'(HTTP 404)' in (exc.stderr or b''):
            return None
        # Never convert network, authentication or rate-limit errors into a cache miss.
        raise RuntimeError(f'GitHub request failed for {path}; no build/publication fallback') from exc


def repository(repo):
    if repo != REPOSITORY:
        raise ValueError('Installer candidates may only be published/read from the project repository')
    return f'repos/{repo}'


def asset_names(value):
    return {value['imageName'], value['imageName'] + '.sha256',
            value['stem'] + '.evidence.tar.gz', value['stem'] + '.build.json'}


def asset_map(release):
    assets = release.get('assets', [])
    result = {a['name']: a for a in assets}
    if len(result) != len(assets):
        raise ValueError('Duplicate release assets')
    return result


def check_manifest(info, value):
    if (info.get('schemaVersion') != 1 or info.get('fingerprint') != value['fingerprint']
            or info.get('channel') != value['channel'] or info.get('inputs') != value['inputs']
            or info.get('config') != value['config'] or info.get('ubuntu') != value['ubuntu']
            or info.get('releaseStatus') != 'test-build'
            or not REVISION.fullmatch(info.get('sourceRevision', ''))
            or not str(info.get('sourceRunId', '')).isdigit()
            or int(info['sourceRunId']) < 1
            or info.get('acceptance') != {'mediaIntegrity': True, 'physicalInstallation': False}):
        raise ValueError('Installer manifest does not match the requested build inputs')
    expected_names = asset_names(value) - {value['stem'] + '.build.json'}
    if set(info.get('assets', {})) != expected_names:
        raise ValueError('Installer manifest has incomplete or unexpected assets')
    for name, entry in info['assets'].items():
        if (not SHA256.fullmatch(entry.get('sha256', '')) or type(entry.get('bytes')) is not int
                or not 0 < entry['bytes'] < 2 * GIB):
            raise ValueError(f'Invalid or oversized artifact: {name}')


def check_remote_assets(release, info, value):
    assets = asset_map(release)
    if set(assets) != asset_names(value):
        raise ValueError('Installer release is incomplete; rerun its original publish job, not the build')
    for name, expected in info['assets'].items():
        actual = assets[name]
        if (actual.get('state') != 'uploaded' or actual.get('size') != expected['bytes']
                or actual.get('digest') != 'sha256:' + expected['sha256']):
            raise ValueError(f'Remote artifact differs from its verified manifest: {name}')


def source_tag(base, tag, revision, *, create=False):
    ref = api(f'{base}/git/ref/tags/{tag}', True)
    if ref is None and create:
        api(f'{base}/git/refs', False, '--method', 'POST', '-f', f'ref=refs/tags/{tag}', '-f', f'sha={revision}')
    elif (ref is None or ref.get('object', {}).get('type') != 'commit'
          or ref.get('object', {}).get('sha') != revision):
        raise ValueError('Existing installer tag is missing or points at another source; never move it')


def lookup(repo, value):
    base = repository(repo)
    release = api(f'{base}/releases/tags/{value["tag"]}', True)
    if release is None:
        # An interrupted draft must not cause a fresh, differently timestamped build.
        pages = json.loads(gh('api', f'{base}/releases?per_page=100', '--paginate', '--slurp'))
        release = next((r for page in pages for r in page if r['tag_name'] == value['tag']), None)
    if release is None:
        if api(f'{base}/git/ref/tags/{value["tag"]}', True) is not None:
            raise ValueError('An installer tag already exists without a release; recover the original publish job')
        return None
    if release.get('draft') or not release.get('prerelease') or release.get('tag_name') != value['tag']:
        raise ValueError('Existing installer is not a complete test release; rerun its original publish job')
    assets = asset_map(release)
    metadata = assets.get(value['stem'] + '.build.json', {})
    if metadata.get('state') != 'uploaded' or not 0 < metadata.get('size', 0) < 1024 * 1024:
        raise ValueError('Missing or oversized installer build manifest')
    data = gh('api', f'{base}/releases/assets/{metadata["id"]}', '-H', 'Accept: application/octet-stream', binary=True)
    if len(data) != metadata['size'] or metadata.get('digest') != 'sha256:' + hashlib.sha256(data).hexdigest():
        raise ValueError('Installer manifest download checksum mismatch')
    info = json.loads(data)
    check_manifest(info, value)
    check_remote_assets(release, info, value)
    source_tag(base, value['tag'], info['sourceRevision'])
    return release['html_url']


def bundle(root, value, directory, run_id):
    check_plan(value, root)
    if not str(run_id).isdigit() or int(run_id) < 1:
        raise ValueError('A GitHub Actions run identity is required')
    directory = Path(directory)
    image = directory / value['imageName']
    report_dir = Path(str(image) + '.report')
    for path in (image, Path(str(image) + '.sha256'), report_dir):
        if path.is_symlink() or not path.exists():
            raise ValueError(f'Missing or unsafe build output: {path.name}')
    if not 0 < image.stat().st_size < 2 * GIB:
        raise ValueError('The installer must be smaller than 2 GiB per release asset')
    report = json.loads((report_dir / 'size-report.json').read_text())
    verified = json.loads((report_dir / 'verification.json').read_text())
    sha = digest(image)
    if (report.get('mode') != 'online' or report['image']['sha256'] != sha
            or report['image']['bytes'] != image.stat().st_size
            or report['sourceIso']['sha256'] != value['ubuntu']['sha256']
            or report['poolAfter']['pool'] != 0 or report['poolAfter']['poolPackageCount'] != 0
            or verified.get('biosBootEntry') is not True or verified.get('uefiBootEntry') is not True
            or verified.get('publicBootstrapChannel') != value['channel']
            or verified.get('imageSha256') != sha
            or verified.get('checkedIntegrityEntries', 0) < 1
            or verified.get('protectedFilesUnchanged', 0) < 1):
        raise ValueError('Installer build/media verification is missing or does not match')
    checksum = Path(str(image) + '.sha256')
    if checksum.read_text().split() != [sha, image.name]:
        raise ValueError('Installer checksum sidecar does not match')
    evidence = directory / (value['stem'] + '.evidence.tar.gz')
    manifest = directory / (value['stem'] + '.build.json')
    if evidence.exists() or manifest.exists():
        raise ValueError('Refusing to replace existing installer provenance')
    with tarfile.open(evidence, 'x:gz') as archive:
        for name in ('size-report.json', 'verification.json', 'pool-before.json', 'pool-after.json'):
            path = report_dir / name
            if path.is_symlink() or not path.is_file():
                raise ValueError(f'Missing evidence: {name}')
            archive.add(path, arcname='reports/' + name)
        for name in ('LICENSE', 'LICENSING.md', 'LICENSE-RELEASE.json', 'THIRD_PARTY_NOTICES.md'):
            archive.add(Path(root) / name, arcname='source-notices/' + name)
    info = {k: value[k] for k in ('schemaVersion', 'fingerprint', 'channel', 'inputs', 'config', 'ubuntu', 'sourceRevision')}
    info.update({'sourceRunId': str(run_id), 'releaseStatus': 'test-build',
                 'acceptance': {'mediaIntegrity': True, 'physicalInstallation': False},
                 'assets': {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)}
                            for p in (image, checksum, evidence)}})
    check_manifest(info, value)
    save(manifest, info)
    return info


def validate_run(run, jobs, info, repo):
    if (run.get('path') != WORKFLOW or run.get('head_branch') != info['channel']
            or run.get('head_sha') != info['sourceRevision']
            or run.get('event') not in {'push', 'workflow_dispatch'}
            or (run.get('head_repository') or {}).get('full_name') != repo
            or str(run.get('id')) != info['sourceRunId']
            or not any(j.get('name') == 'build' and j.get('conclusion') == 'success' for j in jobs)):
        raise ValueError('Only successful installer build jobs from this repository/channel may publish')


def publish(repo, value, directory, run_id):
    base = repository(repo)
    directory = Path(directory)
    info = json.loads((directory / (value['stem'] + '.build.json')).read_text())
    check_manifest(info, value)
    if info['sourceRevision'] != value['sourceRevision'] or info['sourceRunId'] != str(run_id):
        raise ValueError('Publication must use this exact source run and commit')
    files = {name: directory / name for name in asset_names(value)}
    for name, path in files.items():
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Missing publication asset: {name}')
        if name in info['assets']:
            item = info['assets'][name]
            if path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
                raise ValueError(f'Publication artifact checksum mismatch: {name}')
    run = api(f'{base}/actions/runs/{run_id}')
    pages = json.loads(gh('api', f'{base}/actions/runs/{run_id}/jobs?filter=all&per_page=100', '--paginate', '--slurp'))
    validate_run(run, [j for page in pages for j in page['jobs']], info, repo)
    source_tag(base, value['tag'], info['sourceRevision'], create=True)
    release = api(f'{base}/releases/tags/{value["tag"]}', True)
    if release is None:
        pages = json.loads(gh('api', f'{base}/releases?per_page=100', '--paginate', '--slurp'))
        release = next((r for page in pages for r in page if r['tag_name'] == value['tag']), None)
    if release is None:
        notes = (f'Online-only AMD64 installer candidate for **{value["channel"]}**.\n\n'
                 f'Build inputs: `{value["fingerprint"]}`. Source: `{info["sourceRevision"]}`. '
                 f'[CI evidence](https://github.com/{repo}/actions/runs/{run_id}).\n\n'
                 'Download the `.img` and `.img.sha256` assets; the generated source archives are not installation media. '
                 'The evidence archive retains media checks, package inventories and source notices. '
                 'Ubuntu and other third-party components retain their own licenses.\n\n'
                 f'First boot follows `{value["channel"]}`, not the source commit that built the stick. '
                 'Public defaults only: hostname `example-host-01`, no deployment token. '
                 'A working Ubuntu mirror is required.\n\n'
                 '**Test distribution, not installation/hardware acceptance.** CI checks media integrity; '
                 'a complete installation, first boot and GPU acceptance remain separate. '
                 'This artifact is not a versioned Magic Stick product release or a live rollout. '
                 'Downloads have no automatic CI retention expiry. Existing assets/tags are never overwritten.\n')
        release = api(f'{base}/releases', False, '--method', 'POST', '-f', f'tag_name={value["tag"]}',
                      '-f', f'name=Magic Stick installer {value["channel"]} {value["fingerprint"][:12]} (test build)',
                      '-f', f'body={notes}', '-F', 'draft=true', '-F', 'prerelease=true', '-f', 'make_latest=false')
    if release.get('tag_name') != value['tag'] or not release.get('prerelease'):
        raise ValueError('Unexpected release; refusing to modify it')
    actual = asset_map(release)
    if set(actual) - set(files):
        raise ValueError('Unexpected existing release assets')
    missing = []
    for name, path in files.items():
        if name not in actual:
            missing.append(path)
        elif (actual[name].get('state') != 'uploaded' or actual[name].get('size') != path.stat().st_size
              or actual[name].get('digest') != 'sha256:' + digest(path)):
            raise ValueError('Existing asset differs; rerun the original publish job, never overwrite')
    if missing and not release['draft']:
        raise ValueError('Published release is incomplete; no automatic overwrite or repair')
    if missing:
        gh('release', 'upload', value['tag'], *sorted(missing), '--repo', repo, timeout=900)
    release_path = f'{base}/releases/{release["id"]}'
    release = api(release_path)
    check_remote_assets(release, info, value)
    metadata = asset_map(release)[value['stem'] + '.build.json']
    manifest = files[value['stem'] + '.build.json']
    if (metadata.get('state') != 'uploaded' or metadata.get('size') != manifest.stat().st_size
            or metadata.get('digest') != 'sha256:' + digest(manifest)):
        raise ValueError('Uploaded manifest checksum mismatch')
    if release['draft']:
        release = api(release_path, False, '--method', 'PATCH', '-F', 'draft=false',
                      '-F', 'prerelease=true', '-f', 'make_latest=false')
    return release['html_url']


def output(values):
    for key, value in values.items():
        print(f'{key}={value}')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            for key, value in values.items():
                stream.write(f'{key}={value}\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('plan', 'lookup', 'bundle', 'publish'))
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--channel', choices=('main', 'develop'))
    parser.add_argument('--revision')
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--repo', default=REPOSITORY)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--run-id')
    args = parser.parse_args()
    try:
        if args.operation == 'plan':
            value = plan(args.root, args.channel, args.revision or '')
            save(args.plan, value)
            output({'fingerprint': value['fingerprint'], 'tag': value['tag'], 'stem': value['stem'],
                    'image': value['imageName'], 'ubuntu_sha256': value['ubuntu']['sha256']})
        else:
            value = json.loads(args.plan.read_text())
            check_plan(value, args.root)
            if args.operation == 'lookup':
                url = lookup(args.repo, value)
                output({'reused': 'true' if url else 'false', 'url': url or ''})
            elif args.operation == 'bundle':
                if not args.directory or not args.run_id:
                    parser.error('bundle requires --directory and --run-id')
                bundle(args.root, value, args.directory, args.run_id)
            else:
                if not args.directory or not args.run_id:
                    parser.error('publish requires --directory and --run-id')
                output({'url': publish(args.repo, value, args.directory, args.run_id)})
    except (ValueError, KeyError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        parser.exit(1, f'Installer artifact check failed: {exc}\n')


if __name__ == '__main__':
    main()
