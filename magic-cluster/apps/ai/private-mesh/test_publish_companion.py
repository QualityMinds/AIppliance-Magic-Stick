import copy
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from publish_companion import PLATFORMS, WORKFLOW, api, digest, ensure_source_tag, missing_assets, validate_run, verify_archives


class CompanionReleaseTests(unittest.TestCase):
    def setUp(self):
        self.repo = 'example/project'
        self.revision = 'a' * 40
        self.run = {'id': 123, 'path': WORKFLOW, 'head_branch': 'main', 'event': 'push',
                    'head_repository': {'full_name': self.repo}, 'head_sha': self.revision,
                    'status': 'completed', 'conclusion': 'success', 'run_number': 7, 'run_attempt': 1}
        self.jobs = [{'name': target, 'conclusion': 'success'} for target in PLATFORMS]

    def test_api_errors_explain_rejection_but_missing_optional_release_is_allowed(self):
        missing = subprocess.CalledProcessError(1, ['gh'], output='{}', stderr='gh: Not Found (HTTP 404)')
        with patch('publish_companion.gh', side_effect=missing):
            self.assertIsNone(api('repos/example/project/releases/tags/missing', True))
        denied = subprocess.CalledProcessError(1, ['gh'],
                    output='{"message":"Resource not accessible by integration"}', stderr='gh: Forbidden (HTTP 403)')
        with patch('publish_companion.gh', side_effect=denied):
            with self.assertRaisesRegex(RuntimeError, 'Resource not accessible by integration'):
                api('repos/example/project/git/refs')

    def test_successful_main_build_has_stable_versioned_tag(self):
        self.assertEqual(validate_run(self.run, self.repo, '', self.jobs),
                         (self.revision, 'mesh-client-7.1-aaaaaaaaaaaa'))

    def test_source_tag_created_at_verified_revision_only(self):
        with patch('publish_companion.api', side_effect=[None, {}]) as request:
            ensure_source_tag('repos/example/project', 'mesh-client-7.1-aaaaaaaaaaaa', self.revision)
            self.assertEqual(request.call_count, 2)
            self.assertIn('sha=' + self.revision, request.call_args.args)

    def test_existing_source_tag_never_moved(self):
        for revision in [self.revision, 'b' * 40]:
            with patch('publish_companion.api', return_value={'object': {'type': 'commit', 'sha': revision}}) as request:
                if revision == self.revision:
                    ensure_source_tag('repos/example/project', 'client-tag', self.revision)
                else:
                    with self.assertRaisesRegex(ValueError, 'verified source'):
                        ensure_source_tag('repos/example/project', 'client-tag', self.revision)
                self.assertEqual(request.call_count, 1)

    def test_denied_historical_tag_explains_exact_maintainer_step_without_fallback(self):
        with patch('publish_companion.api', side_effect=[None, RuntimeError('Resource not accessible by integration')]) as request:
            with self.assertRaisesRegex(RuntimeError, 'refs/tags/client-tag at exactly ' + self.revision):
                ensure_source_tag('repos/example/project', 'client-tag', self.revision)
            self.assertEqual(request.call_count, 2)

    def test_pull_requests_forks_other_workflows_and_failed_builds_rejected(self):
        for field, value in [('event', 'pull_request'), ('head_branch', 'topic'),
                             ('head_repository', {'full_name': 'other/project'}),
                             ('path', '.github/workflows/other.yml'), ('conclusion', 'failure')]:
            with self.subTest(field=field):
                run = dict(self.run, **{field: value})
                with self.assertRaises(ValueError):
                    validate_run(run, self.repo, '', self.jobs)

    def test_current_run_only_publishes_after_every_platform_succeeded(self):
        run = dict(self.run, status='in_progress', conclusion=None)
        validate_run(run, self.repo, '123', self.jobs)
        with self.assertRaises(ValueError):
            validate_run(run, self.repo, '456', self.jobs)
        with self.assertRaises(ValueError):
            validate_run(run, self.repo, '123', self.jobs[:-1])
        jobs = copy.deepcopy(self.jobs)
        jobs[0]['conclusion'] = 'failure'
        with self.assertRaises(ValueError):
            validate_run(run, self.repo, '123', jobs)

    def make_archives(self, root, revision=None, launch_check=None, source_license='BUSL-1.1', license_release=None):
        for target, extension in PLATFORMS.items():
            name = 'MagicStickMesh-' + target
            folder = root / name
            folder.mkdir()
            path = folder / (name + extension)
            info = json.dumps({'platform': target, 'sourceRevision': revision or self.revision,
                               'releaseStatus': 'test-artifact',
                               'sourceLicense': source_license,
                               'licenseRelease': license_release if license_release is not None else {
                                   'schemaVersion': 1, 'version': 'example-v1', 'firstPublicDistribution': '2020-01-01',
                                   'changeDate': '2023-01-01', 'changeLicense': 'MIT'},
                               'launchCheck': launch_check if launch_check is not None else {
                                   'launcherVerified': True, 'transportVerified': True,
                                   'loopbackAuthVerified': True}}).encode()
            metadata = name + '/BUILD-INFO.json'
            if extension == '.zip':
                with zipfile.ZipFile(path, 'w') as archive:
                    archive.writestr(metadata, info)
            else:
                with tarfile.open(path, 'w:gz') as archive:
                    member = tarfile.TarInfo(metadata)
                    member.size = len(info)
                    archive.addfile(member, io.BytesIO(info))
            path.with_name(path.name + '.sha256').write_text(digest(path) + '  ' + path.name + '\n')

    def test_verifies_all_four_archives_and_checksum_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_archives(root)
            self.assertEqual(len(verify_archives(root, self.revision)), 8)

    def test_unreviewable_license_metadata_cannot_be_published(self):
        for options in [{'source_license': None}, {'license_release': {}},
                        {'license_release': {'schemaVersion': 1, 'version': 'unreleased',
                         'firstPublicDistribution': None, 'changeDate': None, 'changeLicense': 'MIT'}}]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.make_archives(root, **options)
                with self.assertRaises(ValueError):
                    verify_archives(root, self.revision)

    def test_windows_archive_and_successful_native_job_are_required(self):
        with self.assertRaises(ValueError):
            validate_run(self.run, self.repo, '', [job for job in self.jobs if job['name'] != 'windows-x64'])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_archives(root)
            (root / 'MagicStickMesh-windows-x64/MagicStickMesh-windows-x64.zip').unlink()
            with self.assertRaises(ValueError):
                verify_archives(root, self.revision)

    def test_missing_or_failed_frozen_launch_evidence_blocks_publication(self):
        for report in [{}, {'launcherVerified': True, 'transportVerified': True, 'loopbackAuthVerified': False}]:
            with self.subTest(report=report), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.make_archives(root, launch_check=report)
                with self.assertRaisesRegex(ValueError, 'launch'):
                    verify_archives(root, self.revision)

    def test_rejects_wrong_build_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_archives(root, 'b' * 40)
            with self.assertRaisesRegex(ValueError, 'provenance'):
                verify_archives(root, self.revision)

    def test_rejects_changed_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_archives(root)
            path = root / 'MagicStickMesh-macos-arm64/MagicStickMesh-macos-arm64.zip'
            path.write_bytes(path.read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                verify_archives(root, self.revision)

    def test_retries_never_overwrite_existing_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'client.zip'
            path.write_bytes(b'archive')
            self.assertEqual(missing_assets({'assets': []}, [path]), [path])
            asset = {'name': path.name, 'size': path.stat().st_size,
                     'state': 'uploaded', 'digest': 'sha256:' + digest(path)}
            self.assertEqual(missing_assets({'assets': [asset]}, [path]), [])
            asset['digest'] = 'sha256:' + '0' * 64
            with self.assertRaisesRegex(ValueError, 'overwrite'):
                missing_assets({'assets': [asset]}, [path])
            with self.assertRaisesRegex(ValueError, 'Unexpected'):
                missing_assets({'assets': [dict(asset, name='unrelated.zip')]}, [path])


if __name__ == '__main__':
    unittest.main()
