"""Promote verified main-branch client archives to permanent pre-release assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / 'tools'))
from license_release import validate as validate_license_release


PLATFORMS = {'macos-arm64': '.zip', 'macos-x64': '.zip', 'linux-x64': '.tar.gz', 'windows-x64': '.zip'}
WORKFLOW = '.github/workflows/build-mesh-companion.yml'


def gh(*args, timeout=120):
    return subprocess.run(['gh', *map(str, args)], check=True, text=True,
                          capture_output=True, timeout=timeout).stdout


def api(path, optional=False, *args):
    try:
        return json.loads(gh('api', path, *args))
    except subprocess.CalledProcessError as exc:
        if optional and '(HTTP 404)' in (exc.stderr or ''):
            return None
        try:
            message = json.loads(exc.stdout).get('message', 'GitHub request failed')
        except (ValueError, TypeError):
            message = (exc.stderr or 'GitHub request failed').strip()
        raise RuntimeError(f'GitHub API {path}: {message}') from exc


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_run(run, repo, current_run_id, jobs):
    if (run.get('path') != WORKFLOW or run.get('head_branch') != 'main'
            or run.get('event') not in {'push', 'workflow_dispatch'}
            or (run.get('head_repository') or {}).get('full_name') != repo):
        raise ValueError('Only this repository\'s main-branch companion builds may be published.')
    complete = run.get('status') == 'completed' and run.get('conclusion') == 'success'
    own_build = str(run.get('id')) == current_run_id and run.get('status') == 'in_progress'
    if not (complete or own_build):
        raise ValueError('The source build did not succeed.')
    for target in PLATFORMS:
        matches = [job for job in jobs if job.get('name') == target]
        if len(matches) != 1 or matches[0].get('conclusion') != 'success':
            raise ValueError(f'Missing successful build for {target}.')
    revision = run.get('head_sha', '')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('An exact source revision is required.')
    number, attempt = int(run['run_number']), int(run['run_attempt'])
    if min(number, attempt) < 1:
        raise ValueError('Invalid source run number or attempt.')
    return revision, f'mesh-client-{number}.{attempt}-{revision[:12]}'


def verify_archives(directory, revision):
    assets = []
    for target, extension in PLATFORMS.items():
        name = 'MagicStickMesh-' + target
        folder = directory / name
        archive = folder / (name + extension)
        checksum = archive.with_name(archive.name + '.sha256')
        for path in (folder, archive, checksum):
            if path.is_symlink() or not path.exists():
                raise ValueError(f'Missing or unsafe artifact path: {path.name}')
        if checksum.read_text().split() != [digest(archive), archive.name]:
            raise ValueError(f'Archive checksum mismatch: {target}')
        # Read metadata only; never extract or execute application code with the
        # release job's write-capable token in its environment.
        metadata = name + '/BUILD-INFO.json'
        if extension == '.zip':
            with zipfile.ZipFile(archive) as package:
                if package.getinfo(metadata).file_size > 65536:
                    raise ValueError('Oversized build metadata.')
                info = json.loads(package.read(metadata))
        else:
            with tarfile.open(archive, 'r:gz') as package:
                member = package.getmember(metadata)
                if not member.isfile() or member.size > 65536:
                    raise ValueError('Invalid build metadata.')
                info = json.load(package.extractfile(member))
        if (info.get('sourceRevision') != revision or info.get('platform') != target
                or info.get('releaseStatus') != 'test-artifact'):
            raise ValueError(f'Build provenance mismatch: {target}')
        if info.get('sourceLicense') != 'BUSL-1.1':
            raise ValueError(f'Missing source license metadata: {target}')
        validate_license_release(info.get('licenseRelease'), release=True)
        checks = info.get('launchCheck') or {}
        if not all(checks.get(key) is True for key in ('launcherVerified', 'transportVerified', 'loopbackAuthVerified')):
            raise ValueError(f'Missing packaged launch verification: {target}')
        assets.extend([archive, checksum])
    return assets


def missing_assets(release, assets):
    existing = {item['name']: item for item in release.get('assets', [])}
    if set(existing) - {path.name for path in assets}:
        raise ValueError('Unexpected existing release assets; refusing to modify the release.')
    missing = []
    for path in assets:
        remote = existing.get(path.name)
        if remote is None:
            missing.append(path)
        elif (remote.get('state') != 'uploaded' or remote.get('size') != path.stat().st_size
              or remote.get('digest') != 'sha256:' + digest(path)):
            raise ValueError(f'Refusing to overwrite a different existing asset: {path.name}')
    return missing


def ensure_source_tag(base, tag, revision):
    ref = api(f'{base}/git/ref/tags/{tag}', True)
    if ref is None:
        try:
            api(f'{base}/git/refs', False, '--method', 'POST',
                '-f', f'ref=refs/tags/{tag}', '-f', f'sha={revision}')
        except RuntimeError as exc:
            raise RuntimeError(
                f'{exc}. If GitHub denies tagging a historical workflow revision, '
                f'a maintainer must create refs/tags/{tag} at exactly {revision}, '
                'then retry publication. Do not move the tag or change the build source.'
            ) from exc
    elif (ref.get('object', {}).get('type') != 'commit'
          or ref.get('object', {}).get('sha') != revision):
        raise ValueError('Existing release tag does not point at the verified source commit.')


def publish(repo, run_id, current_run_id):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not run_id.isdigit():
        raise ValueError('Invalid repository or workflow run ID.')
    base = f'repos/{repo}'
    run = api(f'{base}/actions/runs/{run_id}')
    jobs = api(f'{base}/actions/runs/{run_id}/jobs?filter=latest&per_page=100')['jobs']
    revision, tag = validate_run(run, repo, current_run_id, jobs)
    # A former branch named main in a fork, or an unrelated/deleted branch,
    # must not become a release source via the manual backfill input.
    comparison = api(f'{base}/compare/{revision}...main')
    if comparison.get('status') not in {'identical', 'ahead'}:
        raise ValueError('Source revision is not on this repository\'s main history.')
    artifacts = api(f'{base}/actions/runs/{run_id}/artifacts?per_page=100')['artifacts']
    expected = {'MagicStickMesh-' + target for target in PLATFORMS}
    selected = [item for item in artifacts if item.get('name') in expected]
    if len(selected) != len(expected) or {item['name'] for item in selected} != expected or any(item['expired'] for item in selected):
        raise ValueError('All four unexpired platform artifacts are required, including Windows x64.')

    with tempfile.TemporaryDirectory(prefix='mesh-release-') as directory:
        root = Path(directory)
        gh('run', 'download', run_id, '--repo', repo, '--pattern', 'MagicStickMesh-*',
           '--dir', root, timeout=600)
        assets = verify_archives(root, revision)
        ensure_source_tag(base, tag, revision)
        release = api(f'{base}/releases/tags/{tag}', True)
        if release is None:
            # The published-by-tag endpoint may not return an interrupted draft.
            pages = json.loads(gh('api', f'{base}/releases?per_page=100', '--paginate', '--slurp'))
            release = next((item for page in pages for item in page if item['tag_name'] == tag), None)
        if release is None:
            notes = (
                f'Permanent client downloads from [{revision[:12]}](https://github.com/{repo}/commit/{revision}) '
                f'and [verified build {run["run_number"]}.{run["run_attempt"]}]'
                f'(https://github.com/{repo}/actions/runs/{run_id}).\n\n'
                'Choose **macos-arm64** for Apple Silicon/M5, **macos-x64** for Intel Macs, '
                '**linux-x64** for x86-64 Linux, or **windows-x64** for Windows x64. Download the platform archive and its `.sha256` file, '
                'then extract the archive once. The GitHub-generated Source code archives are not the client.\n\n'
                'These release assets have no automatic retention expiry. Older builds are not overwritten.\n\n'
                '**Test builds:** macOS apps are ad-hoc signed, not Developer ID signed or notarized. '
                'Windows packages are unsigned: extract the complete ZIP and open `MagicStickMesh/MagicStickMesh.exe`. '
                'CI packaging and frozen-launch checks passed; real mesh inference and customer-release approval are separate. '
                'BSL, MIT Change License and upstream notices are included.\n')
            release = api(f'{base}/releases', False, '--method', 'POST',
                          '-f', f'tag_name={tag}', '-f', f'name=MagicStickMesh {run["run_number"]}.{run["run_attempt"]} (test build)',
                          '-f', f'body={notes}', '-F', 'draft=true', '-F', 'prerelease=true', '-f', 'make_latest=false')
        release_path = f'{base}/releases/{release["id"]}'
        pending = missing_assets(release, assets)
        if pending and not release['draft']:
            raise ValueError('Published release is incomplete; refusing to modify it.')
        if pending:
            gh('release', 'upload', tag, *pending, '--repo', repo, timeout=600)
        release = api(release_path)
        if missing_assets(release, assets):
            raise ValueError('Release asset upload is incomplete.')
        if release['draft']:
            api(release_path, False, '--method', 'PATCH', '-F', 'draft=false',
                '-F', 'prerelease=true', '-f', 'make_latest=false')
        return api(release_path)['html_url']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--current-run-id', default='')
    args = parser.parse_args()
    url = publish(args.repo, args.run_id, args.current_run_id)
    print(f'Permanent client downloads: {url}')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as summary:
            summary.write(f'## Permanent client downloads\n\n[Release assets]({url}) — no automatic expiry.\n')


if __name__ == '__main__':
    main()
