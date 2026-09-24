# SPDX-License-Identifier: BUSL-1.1
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import unittest

from tools import update_runtime_images as updates


class RuntimeImageTests(unittest.TestCase):
    def fixture(self):
        return json.loads(updates.LOCK.read_text())

    def test_all_runtime_defaults_are_immutable(self):
        for image in self.fixture()["images"].values():
            self.assertRegex(image["digest"], r"^sha256:[a-f0-9]{64}$")

    def test_unchanged_resolution_does_not_produce_a_weekly_diff(self):
        original = self.fixture()
        by_repository = {v["repository"]: v["digest"] for v in original["images"].values()}
        result, changes = updates.updated_lock(original, lambda repo, tag: by_repository[repo])
        self.assertEqual(changes, [])
        self.assertEqual(result, original)

    def test_changes_are_atomic_and_do_not_mutate_input(self):
        original = self.fixture()
        candidate = "sha256:" + "a" * 64
        result, changes = updates.updated_lock(original, lambda *_: candidate)
        self.assertEqual(len(changes), 3)
        self.assertTrue(all(v["digest"] == candidate for v in result["images"].values()))
        self.assertEqual(original, self.fixture())
        with self.assertRaises(ValueError):
            updates.updated_lock(original, lambda *_: "invalid")
        self.assertEqual(original, self.fixture())

    def test_registry_manifest_hash_and_platform_are_verified(self):
        body = json.dumps({"schemaVersion": 2, "manifests": [
            {"platform": {"os": "linux", "architecture": "amd64"}}
        ]}).encode()
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        calls = []
        def fetch(url, headers=None):
            calls.append((url, headers))
            if "auth.docker.io" in url:
                return b'{"token":"synthetic-pull-token"}', {}
            return body, {"Docker-Content-Digest": digest}
        self.assertEqual(updates.resolve("docker.io/example/app", "stable", fetch), digest)
        self.assertTrue(calls[-1][0].endswith("/manifests/stable"))
        self.assertEqual(calls[-1][1]["Authorization"], "Bearer synthetic-pull-token")
        def corrupt(url, headers=None):
            data, metadata = fetch(url, headers)
            return data, {"Docker-Content-Digest": "sha256:" + "0" * 64} if headers else metadata
        with self.assertRaises(ValueError):
            updates.resolve("docker.io/example/app", "stable", corrupt)

    def test_untrusted_repository_and_invalid_tag_rejected_before_network(self):
        def no_network(*args):
            self.fail("must not access the network")
        for repo, tag in [("private.example/app", "latest"), ("ghcr.io/../secret", "latest"),
                          ("docker.io/example/app", "x?token=example")]:
            with self.subTest(repo=repo, tag=tag), self.assertRaises(ValueError):
                updates.resolve(repo, tag, no_network)

    def test_single_platform_manifest_verifies_config_and_rejects_wrong_architecture(self):
        for architecture in ('amd64', 'arm64'):
            config = json.dumps({'os': 'linux', 'architecture': architecture}).encode()
            body = json.dumps({'schemaVersion': 2, 'config': {
                'digest': 'sha256:' + hashlib.sha256(config).hexdigest()}}).encode()
            def fetch(url, headers=None):
                if 'auth.docker.io' in url:
                    return b'{"token":"fixture"}', {}
                return (config if '/blobs/' in url else body), {}
            if architecture == 'amd64':
                self.assertEqual(updates.resolve('docker.io/example/app', 'stable', fetch),
                                 'sha256:' + hashlib.sha256(body).hexdigest())
            else:
                with self.assertRaisesRegex(ValueError, 'linux/amd64'):
                    updates.resolve('docker.io/example/app', 'stable', fetch)

    def test_empty_or_unknown_platform_index_is_rejected(self):
        def fetch(url, headers=None):
            return (b'{"token":"fixture"}' if not headers else b'{"schemaVersion":2,"manifests":[]}'), {}
        with self.assertRaisesRegex(ValueError, 'linux/amd64'):
            updates.resolve('docker.io/example/app', 'stable', fetch)

    @unittest.skipUnless(shutil.which("helm"), "Helm is needed for chart rendering")
    def test_chart_consumes_lock_and_preserves_explicit_override(self):
        command = ["helm", "template", "fixture", str(updates.LOCK.parent.parent),
                   "--set", "instance.name=example", "--set", "instance.namespace=ai",
                   "--set", "instance.application=odysseus", "--set", "instance.localName=example",
                   "--set", "instance.localHost=example.odysseus.example.local",
                   "--set-json", "instance.values={}"]
        default = subprocess.check_output(command, text=True)
        self.assertNotIn(":latest", default)
        for item in self.fixture()["images"].values():
            self.assertIn(item["repository"] + "@" + item["digest"], default)
        custom = subprocess.check_output(command + ["--set", "instance.values.image.repository=example/app",
                                                    "--set", "instance.values.image.tag=1.2.3"], text=True)
        self.assertEqual(custom.count('image: "example/app:1.2.3"'), 2)
