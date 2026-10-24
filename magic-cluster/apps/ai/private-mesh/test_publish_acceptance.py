import json
from pathlib import Path
import tempfile
import unittest

from publish_acceptance import acceptance_payload, PLATFORMS, FLAGS, REPO, WORKFLOW


class PublicAcceptanceTests(unittest.TestCase):
    def fixture(self, root):
        revision = 'a' * 40
        run = {'id': 123, 'run_attempt': 2, 'path': WORKFLOW, 'head_sha': revision,
               'head_repository': {'full_name': REPO}, 'event': 'workflow_dispatch', 'status': 'in_progress'}
        jobs = [{'name': platform, 'conclusion': 'success'} for platform in PLATFORMS]
        for platform, native in PLATFORMS.items():
            folder = root / ('companion-acceptance-' + platform)
            folder.mkdir()
            value = {'version': 1, 'platform': platform, 'sourceRevision': revision, 'archiveSha256': 'b' * 64,
                     'private': 'synthetic-credential-must-not-publish', 'launchCheck': {
                         'version': 1, 'platform': native, **{key: True for key in FLAGS}, 'meshInferenceVerified': False}}
            (folder / (platform + '.acceptance.json')).write_text(json.dumps(value))
        return run, jobs

    def test_current_complete_native_build_publishes_only_bounded_public_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, jobs = self.fixture(root)
            payload = acceptance_payload(root, run, jobs, 123)
            self.assertEqual(payload['external_id'], '123:2')
            self.assertEqual(len(json.loads(payload['output']['text'])['reports']), 4)
            self.assertNotIn('synthetic-credential', json.dumps(payload))
            self.assertLess(len(payload['output']['text'].encode()), 48 * 1024)

    def test_foreign_failed_or_incomplete_build_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, jobs = self.fixture(root)
            for patch in ({'id': 456}, {'event': 'pull_request'}, {'status': 'completed'},
                          {'head_repository': {'full_name': 'foreign/repo'}}, {'path': 'foreign.yml'},
                          {'run_attempt': True}, {'run_attempt': 0}):
                with self.subTest(patch=patch), self.assertRaises(ValueError):
                    acceptance_payload(root, {**run, **patch}, jobs, 123)
            with self.assertRaises(ValueError):
                acceptance_payload(root, run, jobs[:-1], 123)
            with self.assertRaises(ValueError):
                acceptance_payload(root, run, [{**job, 'conclusion': 'failure'} for job in jobs], 123)

    def test_failed_native_boundary_wrong_revision_or_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, jobs = self.fixture(root)
            file = root / 'companion-acceptance-linux-x64/linux-x64.acceptance.json'
            original = json.loads(file.read_text())
            for value in ({**original, 'sourceRevision': 'c' * 40},
                          {**original, 'launchCheck': {**original['launchCheck'], 'originHostVerified': False}},
                          {**original, 'launchCheck': {**original['launchCheck'], 'meshInferenceVerified': True}}):
                file.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    acceptance_payload(root, run, jobs, 123)
            file.unlink()
            file.symlink_to(root / 'companion-acceptance-macos-arm64/macos-arm64.acceptance.json')
            with self.assertRaises(ValueError):
                acceptance_payload(root, run, jobs, 123)


if __name__ == '__main__':
    unittest.main()
