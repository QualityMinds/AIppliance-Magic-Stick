"""Expose bounded native acceptance in a public GitHub check, not client assets."""
import argparse
import json
from pathlib import Path
import re
import subprocess


REPO = 'QualityMinds/AIppliance-Magic-Stick'
CHECK = 'magicstick-companion-acceptance'
WORKFLOW = '.github/workflows/build-mesh-companion.yml'
PLATFORMS = {'macos-arm64': 'darwin', 'macos-x64': 'darwin', 'linux-x64': 'linux', 'windows-x64': 'win32'}
FLAGS = ('launcherVerified', 'transportVerified', 'loopbackAuthVerified',
         'inferenceAuthorityVerified', 'originHostVerified', 'isolatedStateVerified')


def acceptance_report(value, platform, revision):
    native = value.get('launchCheck', {})
    if (value.get('version') != 1 or value.get('platform') != platform
            or value.get('sourceRevision') != revision
            or not re.fullmatch(r'[a-f0-9]{64}', value.get('archiveSha256', ''))
            or native.get('version') != 1 or native.get('platform') != PLATFORMS[platform]
            or not all(native.get(key) is True for key in FLAGS)
            or native.get('meshInferenceVerified') is not False):
        raise ValueError('Native companion acceptance is incomplete or belongs to another build.')
    # Only fixed public fields. Ignore arbitrary uploaded strings or metadata.
    return {'version': 1, 'platform': platform, 'sourceRevision': revision,
            'archiveSha256': value['archiveSha256'], 'launchCheck': {
                'version': 1, 'platform': PLATFORMS[platform],
                **{key: True for key in FLAGS}, 'meshInferenceVerified': False}}


def acceptance_payload(root, run, jobs, expected_run_id):
    revision = run.get('head_sha', '')
    if (run.get('id') != expected_run_id or run.get('path') != WORKFLOW
            or (run.get('head_repository') or {}).get('full_name') != REPO
            or run.get('event') not in ('push', 'workflow_dispatch')
            or run.get('status') != 'in_progress' or not re.fullmatch(r'[a-f0-9]{40}', revision)
            or type(run.get('run_attempt')) is not int or run['run_attempt'] < 1):
        raise ValueError('Only the current trusted native build may publish acceptance.')
    reports = []
    for platform in PLATFORMS:
        matches = [job for job in jobs if job.get('name') == platform]
        if len(matches) != 1 or matches[0].get('conclusion') != 'success':
            raise ValueError('All four native platform builds must succeed.')
        folder = root / ('companion-acceptance-' + platform)
        files = list(folder.glob('*.acceptance.json'))
        if folder.is_symlink() or len(files) != 1:
            raise ValueError('Exactly one native proof per platform is required.')
        file = files[0]
        if file.is_symlink() or not file.is_file() or file.stat().st_size > 32768:
            raise ValueError('Unsafe or oversized native proof.')
        reports.append(acceptance_report(json.loads(file.read_text()), platform, revision))
    text = json.dumps({'version': 1, 'runId': run['id'], 'runAttempt': run['run_attempt'],
                       'sourceRevision': revision, 'reports': reports}, separators=(',', ':'))
    if len(text.encode()) > 48 * 1024:
        raise ValueError('Public native proof exceeds its bound.')
    return {'name': CHECK, 'head_sha': revision, 'external_id': f"{run['id']}:{run['run_attempt']}",
            'details_url': f"https://github.com/{REPO}/actions/runs/{run['id']}",
            'status': 'completed', 'conclusion': 'success', 'output': {
                'title': 'Four native companion packages verified',
                'summary': 'Native packaging and isolated boundaries passed. Real Mesh inference is a separate test.',
                'text': text}}


def gh_api(path, payload=None):
    args = ['gh', 'api', f'repos/{REPO}/' + path]
    if payload is not None:
        args += ['--method', 'POST', '--input', '-']
    result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True, timeout=60, check=True)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--run-id', type=int, required=True)
    args = parser.parse_args()
    run = gh_api(f'actions/runs/{args.run_id}')
    jobs = gh_api(f'actions/runs/{args.run_id}/jobs?filter=latest&per_page=100')['jobs']
    payload = acceptance_payload(args.directory, run, jobs, args.run_id)
    gh_api('check-runs', payload)
    print('Published bounded native acceptance; no client release or Appliance credentials were published.')


if __name__ == '__main__':
    main()
