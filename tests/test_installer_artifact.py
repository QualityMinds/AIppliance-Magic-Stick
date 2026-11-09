# SPDX-License-Identifier: BUSL-1.1
import copy
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

import yaml

from tools import installer_artifact as artifact
from tests.test_release_catalog import manifest as product_manifest


ROOT = Path(__file__).resolve().parents[1]
REVISION = 'a' * 40


class InstallerArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in (*artifact.INPUTS, 'LICENSE-RELEASE.json', 'THIRD_PARTY_NOTICES.md'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        self.value = artifact.plan(self.root, 'main', REVISION)
        self.directory = self.root / 'assets'
        self.directory.mkdir()

    def build_fixture(self):
        image = self.directory / self.value['imageName']
        image.write_bytes(b'synthetic image fixture, not bootable')
        sha = artifact.digest(image)
        Path(str(image) + '.sha256').write_text(f'{sha}  {image.name}\n')
        report = Path(str(image) + '.report')
        artifact.save(report / 'size-report.json', {
            'mode': 'reduced', 'image': {'sha256': sha, 'bytes': image.stat().st_size},
            'sourceIso': {'sha256': self.value['ubuntu']['sha256']},
            'poolAfter': {'pool': 1024, 'poolPackageCount': 2}})
        artifact.save(report / 'verification.json', {
            'biosBootEntry': True, 'uefiBootEntry': True, 'publicBootstrapChannel': 'main',
            'imageSha256': sha, 'checkedIntegrityEntries': 645, 'protectedFilesUnchanged': 27})
        for name in ('pool-before.json', 'pool-after.json'):
            artifact.save(report / name, {'packages': []})
        return image, report

    def make_bundle(self):
        self.build_fixture()
        return artifact.bundle(self.root, self.value, self.directory, '123')

    def remote_release(self, draft=False):
        assets = []
        for index, name in enumerate(sorted(artifact.asset_names(self.value))):
            path = self.directory / name
            assets.append({'id': index + 1, 'name': name, 'state': 'uploaded',
                           'size': path.stat().st_size, 'digest': 'sha256:' + artifact.digest(path)})
        return {'id': 42, 'draft': draft, 'prerelease': True, 'tag_name': self.value['tag'],
                'html_url': f'https://github.com/{artifact.REPOSITORY}/releases/tag/{self.value["tag"]}',
                'assets': assets}

    def valid_run(self):
        return {'id': 123, 'path': artifact.WORKFLOW, 'head_branch': 'main', 'head_sha': REVISION,
                'event': 'push', 'head_repository': {'full_name': artifact.REPOSITORY}}

    def test_identity_changes_only_with_relevant_inputs_or_channel(self):
        for name in ('CHANGELOG.md', 'LICENSE-RELEASE.json', 'dashboard/new-feature.ts', 'docs/new-guide.md'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('new product version or unrelated content')
        later = artifact.plan(self.root, 'main', 'b' * 40)
        self.assertEqual(later['fingerprint'], self.value['fingerprint'])
        self.assertNotEqual(later['sourceRevision'], self.value['sourceRevision'])
        self.assertNotEqual(artifact.plan(self.root, 'develop', REVISION)['fingerprint'], self.value['fingerprint'])
        source = self.root / 'magic-installer/user-data'
        source.write_text(source.read_text() + '\n# relevant recipe change\n')
        self.assertNotEqual(artifact.plan(self.root, 'main', REVISION)['fingerprint'], self.value['fingerprint'])
        with self.assertRaisesRegex(ValueError, 'changed after planning'):
            artifact.check_plan(self.value, self.root)

    def test_explicit_recipe_refresh_and_optional_dockerignore_change_identity(self):
        config = self.root / 'magic-installer/ci-build.json'
        data = json.loads(config.read_text())
        data['recipeRevision'] += 1
        artifact.save(config, data)
        changed = artifact.plan(self.root, 'main', REVISION)
        self.assertNotEqual(changed['fingerprint'], self.value['fingerprint'])
        (self.root / 'magic-installer/.dockerignore').write_text('README.md\n')
        self.assertNotEqual(artifact.plan(self.root, 'main', REVISION)['fingerprint'], changed['fingerprint'])

    def test_product_media_identity_includes_exact_tag_commit_and_original_license_dates(self):
        record = product_manifest()['license']
        proof = {'version': 'v1.2.3', 'commit': 'b' * 40, 'tagObject': 'c' * 40,
                 'manifestDigest': 'sha256:' + 'd' * 64, 'license': record}
        value = artifact.plan(self.root, 'main', REVISION, proof)
        self.assertNotEqual(value['fingerprint'], self.value['fingerprint'])
        self.assertTrue(value['tag'].startswith('installer-v1.2.3-'))
        self.assertEqual(value['productRelease']['license'], record)
        changed = artifact.plan(self.root, 'main', REVISION, {**proof, 'commit': 'e' * 40})
        self.assertNotEqual(value['fingerprint'], changed['fingerprint'])
        with self.assertRaises(ValueError):
            artifact.plan(self.root, 'main', REVISION, {**proof, 'license': {**record, 'changeDate': '2030-01-01'}})
        # An old main-following image cannot be bundled as fixed-version media.
        self.value = value
        self.build_fixture()
        with self.assertRaises(ValueError): artifact.bundle(self.root, value, self.directory, '123')

    def test_public_profile_rejects_private_full_or_unpinned_builds(self):
        path = self.root / 'magic-installer/ci-build.json'
        config = json.loads(path.read_text())
        for key, value in (('offlinePool', 'full'), ('hostname', 'private-host'),
                           ('publicRepository', 'https://example.com/private.git'), ('token', 'CHANGEME')):
            artifact.save(path, {**config, key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                artifact.plan(self.root, 'main', REVISION)
        artifact.save(path, config)
        with self.assertRaises(ValueError):
            artifact.plan(self.root, 'feature', REVISION)
        with self.assertRaises(ValueError):
            artifact.plan(self.root, 'main', 'main')
        script = self.root / 'magic-installer/build-installer-image.sh'
        script.write_text(script.read_text().replace('https://releases.ubuntu.com/', 'http://example.com/'))
        with self.assertRaises(ValueError):
            artifact.plan(self.root, 'main', REVISION)

    def test_unsafe_input_is_rejected(self):
        path = self.root / 'magic-installer/meta-data'
        path.unlink()
        with self.assertRaises(ValueError):
            artifact.plan(self.root, 'main', REVISION)
        path.symlink_to(ROOT / 'magic-installer/meta-data')
        with self.assertRaises(ValueError):
            artifact.plan(self.root, 'main', REVISION)

    def test_bundle_keeps_checksums_evidence_notices_and_original_identity(self):
        info = self.make_bundle()
        artifact.check_manifest(info, self.value)
        self.assertEqual(info['sourceRunId'], '123')
        self.assertFalse(info['acceptance']['physicalInstallation'])
        with tarfile.open(self.directory / (self.value['stem'] + '.evidence.tar.gz')) as archive:
            self.assertIn('source-notices/LICENSE-RELEASE.json', archive.getnames())
            self.assertIn('source-notices/THIRD_PARTY_NOTICES.md', archive.getnames())
            self.assertIn('reports/verification.json', archive.getnames())
        with self.assertRaisesRegex(ValueError, 'replace existing'):
            artifact.bundle(self.root, self.value, self.directory, '123')

    def test_bundle_requires_verified_reduced_image_and_public_channel(self):
        image, report = self.build_fixture()
        original = json.loads((report / 'verification.json').read_text())
        for key, value in (('biosBootEntry', False), ('imageSha256', '0' * 64),
                           ('publicBootstrapChannel', 'develop'), ('protectedFilesUnchanged', 0)):
            artifact.save(report / 'verification.json', {**original, key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                artifact.bundle(self.root, self.value, self.directory, '123')
        artifact.save(report / 'verification.json', original)
        size = json.loads((report / 'size-report.json').read_text())
        artifact.save(report / 'size-report.json', {**size, 'mode': 'full'})
        with self.assertRaises(ValueError):
            artifact.bundle(self.root, self.value, self.directory, '123')
        # Sparse file: exercise the real strict 2 GiB boundary without allocating it.
        with image.open('r+b') as stream:
            stream.truncate(2 * artifact.GIB)
        with self.assertRaisesRegex(ValueError, 'smaller than 2 GiB'):
            artifact.bundle(self.root, self.value, self.directory, '123')

    def test_lookup_reuses_original_build_after_unrelated_source_change(self):
        self.make_bundle()
        release = self.remote_release()
        metadata = (self.directory / (self.value['stem'] + '.build.json')).read_bytes()
        later = artifact.plan(self.root, 'main', 'b' * 40)
        with mock.patch.object(artifact, 'api', side_effect=[release, {'object': {'type': 'commit', 'sha': REVISION}}]), \
                mock.patch.object(artifact, 'gh', return_value=metadata):
            self.assertEqual(artifact.lookup(artifact.REPOSITORY, later), release['html_url'])

    def test_only_an_absent_release_and_tag_is_a_cache_miss(self):
        with mock.patch.object(artifact, 'api', return_value=None), mock.patch.object(artifact, 'gh', return_value='[[]]'):
            self.assertIsNone(artifact.lookup(artifact.REPOSITORY, self.value))
        with mock.patch.object(artifact, 'api', side_effect=[None, {'object': {'sha': REVISION}}]), \
                mock.patch.object(artifact, 'gh', return_value='[[]]'), self.assertRaises(ValueError):
            artifact.lookup(artifact.REPOSITORY, self.value)
        for stderr in (b'gh: Not Found (HTTP 404)', b'gh: denied (HTTP 403)', b'network timeout'):
            error = subprocess.CalledProcessError(1, ['gh'], stderr=stderr)
            with mock.patch.object(artifact, 'gh', side_effect=error):
                if b'404' in stderr:
                    self.assertIsNone(artifact.api('example', True))
                else:
                    with self.assertRaises(RuntimeError):
                        artifact.api('example', True)

    def test_lookup_rejects_draft_partial_or_modified_assets(self):
        self.make_bundle()
        original = self.remote_release()
        metadata = (self.directory / (self.value['stem'] + '.build.json')).read_bytes()
        variants = [copy.deepcopy(original) for _ in range(4)]
        variants[0]['draft'] = True
        variants[1]['assets'].pop()
        variants[2]['assets'][0]['digest'] = 'sha256:' + '0' * 64
        variants[3]['assets'][0]['state'] = 'starter'
        for release in variants:
            with self.subTest(release=release['assets'][0]['name']), \
                    mock.patch.object(artifact, 'api', return_value=release), \
                    mock.patch.object(artifact, 'gh', return_value=metadata), self.assertRaises(ValueError):
                artifact.lookup(artifact.REPOSITORY, self.value)

    def test_publish_requires_matching_successful_source_run(self):
        info = self.make_bundle()
        run = self.valid_run()
        jobs = [{'name': 'build', 'conclusion': 'success'}]
        artifact.validate_run(run, jobs, info, artifact.REPOSITORY)
        for key, value in (('head_sha', 'b' * 40), ('head_branch', 'develop'), ('event', 'pull_request'),
                           ('path', 'another.yml'), ('head_repository', {'full_name': 'other/repo'})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                artifact.validate_run({**run, key: value}, jobs, info, artifact.REPOSITORY)
        with self.assertRaises(ValueError):
            artifact.validate_run(run, [{'name': 'build', 'conclusion': 'failure'}], info, artifact.REPOSITORY)

    def test_product_dispatch_requires_the_matching_product_tag_and_commit(self):
        info = self.make_bundle()
        info['productRelease'] = {'version': 'v1.2.3', 'commit': REVISION}
        run = {**self.valid_run(), 'event': 'workflow_dispatch', 'head_branch': 'v1.2.3'}
        jobs = [{'name': 'build', 'conclusion': 'success'}]
        artifact.validate_run(run, jobs, info, artifact.REPOSITORY)
        for change in ({'head_branch': 'v1.2.4'}, {'head_sha': 'b' * 40}, {'event': 'push'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                artifact.validate_run({**run, **change}, jobs, info, artifact.REPOSITORY)

    def test_planning_passes_an_expected_product_commit_to_public_resolution(self):
        proof = {'version': 'v1.2.3', 'commit': REVISION, 'tagObject': 'c' * 40,
                 'manifestDigest': 'sha256:' + 'd' * 64, 'license': product_manifest()['license']}
        argv = ['installer_artifact.py', 'plan', '--root', str(self.root), '--channel', 'main',
                '--revision', REVISION, '--plan', str(self.root / 'plan.json'),
                '--product-version', 'v1.2.3', '--expected-product-commit', REVISION]
        with mock.patch('sys.argv', argv), mock.patch.object(artifact, 'output'), \
                mock.patch.object(artifact.release_bootstrap, 'resolve', return_value=proof) as resolve:
            artifact.main()
        resolve.assert_called_once_with('v1.2.3', REVISION)
        with mock.patch('sys.argv', argv[:-4] + argv[-2:]), mock.patch.object(artifact.release_bootstrap, 'resolve') as resolve, \
                mock.patch('sys.stderr'), self.assertRaises(SystemExit):
            artifact.main()
        resolve.assert_not_called()

    def test_publish_draft_then_verify_then_publish_without_overwrite(self):
        self.make_bundle()
        final = self.remote_release()
        draft = {**final, 'draft': True, 'assets': []}
        calls = []

        def api(path, optional=False, *args):
            calls.append((path, args))
            if '/actions/runs/' in path:
                return self.valid_run()
            if '/git/ref/' in path or '/releases/tags/' in path:
                return None
            if path.endswith('/git/refs'):
                return {'object': {'type': 'commit', 'sha': REVISION}}
            if path.endswith('/releases'):
                return draft
            if path.endswith('/releases/42'):
                return final if 'PATCH' in args else {**final, 'draft': True}
            self.fail(path)

        def gh(*args, **kwargs):
            if args[0] == 'release':
                self.assertEqual(args[1], 'upload')
                self.assertNotIn('--clobber', args)
                return ''
            if '/jobs?' in args[1]:
                return json.dumps([{'jobs': [{'name': 'build', 'conclusion': 'success'}]}])
            return '[[]]'

        with mock.patch.object(artifact, 'api', side_effect=api), mock.patch.object(artifact, 'gh', side_effect=gh) as command:
            url = artifact.publish(artifact.REPOSITORY, self.value, self.directory, '123')
        self.assertEqual(url, final['html_url'])
        self.assertTrue(any(c.args[:2] == ('release', 'upload') for c in command.call_args_list))
        self.assertIn('draft=false', calls[-1][1])
        self.assertIn('make_latest=false', calls[-1][1])

    def test_publish_never_replaces_a_tag_or_asset_and_validates_local_bytes(self):
        self.make_bundle()
        with mock.patch.object(artifact, 'api', return_value={'object': {'type': 'commit', 'sha': 'b' * 40}}), \
                self.assertRaises(ValueError):
            artifact.source_tag('repos/example', self.value['tag'], REVISION, create=True)
        (self.directory / self.value['imageName']).write_bytes(b'tampered')
        with mock.patch.object(artifact, 'api') as api, self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            artifact.publish(artifact.REPOSITORY, self.value, self.directory, '123')
        api.assert_not_called()

    def test_original_publish_job_can_resume_but_cannot_replace_existing_assets(self):
        self.make_bundle()
        final = self.remote_release()
        partial = {**final, 'draft': True, 'assets': final['assets'][1:]}
        tag = {'object': {'type': 'commit', 'sha': REVISION}}
        jobs = json.dumps([{'jobs': [{'name': 'build', 'conclusion': 'success'}]}])
        with mock.patch.object(artifact, 'api', side_effect=[
                self.valid_run(), tag, partial, {**final, 'draft': True}, final]), \
                mock.patch.object(artifact, 'gh', side_effect=[jobs, '']) as command:
            self.assertEqual(artifact.publish(artifact.REPOSITORY, self.value, self.directory, '123'),
                             final['html_url'])
        upload = command.call_args_list[1]
        self.assertEqual(upload.args[:3], ('release', 'upload', self.value['tag']))
        self.assertEqual(upload.args[3], self.directory / final['assets'][0]['name'])
        self.assertNotIn('--clobber', upload.args)

        partial = copy.deepcopy(partial)
        partial['assets'][0]['digest'] = 'sha256:' + '0' * 64
        with mock.patch.object(artifact, 'api', side_effect=[self.valid_run(), tag, partial]), \
                mock.patch.object(artifact, 'gh', return_value=jobs) as command, \
                self.assertRaisesRegex(ValueError, 'never overwrite'):
            artifact.publish(artifact.REPOSITORY, self.value, self.directory, '123')
        self.assertEqual(command.call_count, 1)  # Only the read-only jobs lookup.

    def test_workflow_build_and_publication_retain_the_same_product_identity(self):
        workflow = yaml.load((ROOT / artifact.WORKFLOW).read_text(), Loader=yaml.BaseLoader)
        stages = [next(step for step in workflow['jobs'][job]['steps']
                       if step.get('name') == name) for job, name in (
                           ('build', 'Fingerprint build inputs'),
                           ('publish', 'Restore exact build identity'))]
        proof = {'version': 'v1.2.3', 'commit': 'b' * 40, 'tagObject': 'c' * 40,
                 'manifestDigest': 'sha256:' + 'd' * 64,
                 'license': product_manifest()['license']}
        for ref_type, ref_name, version in (('branch', 'main', ''), ('branch', 'main', proof['version']),
                                            ('tag', proof['version'], proof['version'])):
            with self.subTest(product_version=version, ref_type=ref_type):
                plans = []
                for step in stages:
                    env = {'PATH': os.defpath, 'GITHUB_REF_NAME': ref_name, 'GITHUB_REF_TYPE': ref_type,
                           'GITHUB_SHA': REVISION, 'RUNNER_TEMP': str(self.root)}
                    for key, value in step.get('env', {}).items():
                        self.assertEqual(value, '${{ inputs.product_version }}')
                        env[key] = version
                    # Execute the real workflow shell, capturing only argv. A
                    # shell function needs no executable fixture on /tmp and
                    # cannot contact GitHub or publish an installer.
                    script = 'python() { printf \'%s\\0\' "$@"; }\n' + step['run']
                    result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', script],
                                            cwd=self.root, env=env, check=True, capture_output=True)
                    arguments = result.stdout.decode().split('\0')[:-1]
                    self.assertEqual(arguments[:2], ['tools/installer_artifact.py', 'plan'])
                    self.assertEqual(len(arguments) % 2, 0)
                    options = dict(zip(arguments[2::2], arguments[3::2]))
                    selected = options.get('--product-version')
                    if selected:
                        self.assertEqual(selected, version)
                    self.assertEqual(options.get('--expected-product-commit'), REVISION if ref_type == 'tag' else None)
                    plans.append(artifact.plan(self.root, options['--channel'],
                                               options['--revision'], proof if selected else None))
                self.assertEqual(plans[0]['fingerprint'], plans[1]['fingerprint'])
                self.assertEqual(plans[0].get('productRelease'), proof if version else None)
                self.assertEqual(plans[1].get('productRelease'), plans[0].get('productRelease'))
        for version in ('', 'v1.2.4'):
            for step in stages:
                script = 'python() { exit 99; }\n' + step['run']
                env = {'PATH': os.defpath, 'GITHUB_REF_TYPE': 'tag', 'GITHUB_REF_NAME': 'v1.2.3',
                       'GITHUB_SHA': REVISION, 'RUNNER_TEMP': str(self.root), 'PRODUCT_VERSION': version}
                result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', script], cwd=self.root,
                                        env=env, capture_output=True)
                self.assertNotIn(result.returncode, (0, 99))  # Reject before any planning/publication command.

    def test_workflow_filters_inputs_and_separates_build_from_publication(self):
        workflow = yaml.load((ROOT / artifact.WORKFLOW).read_text(), Loader=yaml.BaseLoader)
        triggers = workflow['on']
        self.assertEqual(set(triggers), {'push', 'workflow_dispatch'})
        self.assertEqual(triggers['push']['branches'], ['main'])
        paths = triggers['push']['paths']
        for path in (*artifact.INPUTS, *artifact.OPTIONAL_INPUTS):
            self.assertTrue(any(fnmatch.fnmatch(path, pattern) for pattern in paths), path)
        for path in ('CHANGELOG.md', 'LICENSE-RELEASE.json', 'dashboard/src/main.ts', 'magic-host/playbooks/local.yml'):
            self.assertFalse(any(fnmatch.fnmatch(path, pattern) for pattern in paths), path)
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertEqual(workflow['concurrency']['cancel-in-progress'], 'false')
        self.assertIn('inputs.product_version', workflow['concurrency']['group'])
        self.assertEqual(workflow['env']['INSTALLER_DELIVERY_CONTRACT'], '1')
        jobs = workflow['jobs']
        self.assertIn("github.event_name == 'workflow_dispatch'", jobs['build']['if'])
        self.assertIn("github.ref == format('refs/tags/{0}', inputs.product_version)", jobs['build']['if'])
        self.assertEqual(jobs['publish']['permissions'], {'contents': 'write', 'actions': 'read'})
        self.assertEqual(jobs['publish']['if'], "needs.build.outputs.reused == 'false'")
        build = jobs['build']['steps']
        image_step = next(s for s in build if s.get('name') == 'Build reduced media')
        self.assertEqual(image_step['if'], "steps.lookup.outputs.reused != 'true'")
        self.assertIn('--offline-pool reduced', image_step['run'])
        self.assertIn('--public-ref "$PUBLIC_REF"', image_step['run'])
        self.assertIn('--public-ref-kind "$PUBLIC_REF_KIND"', image_step['run'])
        cache = next(s for s in build if s.get('uses', '').startswith('actions/cache@'))
        self.assertEqual(cache['with']['path'], '.installer-cache')
        self.assertNotIn('restore-keys', cache['with'])


if __name__ == '__main__':
    unittest.main()
