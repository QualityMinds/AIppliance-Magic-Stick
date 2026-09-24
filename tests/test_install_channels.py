# SPDX-License-Identifier: BUSL-1.1
"""Exercise installer ref resolution against a disposable local Git remote."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstallChannelTests(unittest.TestCase):
    def test_branch_tracking_and_explicit_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote"
            remote.mkdir()
            env = {**os.environ, "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.com",
                   "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.com"}
            def git(*args):
                return subprocess.check_output(["git", "-C", str(remote), *args], env=env, text=True).strip()
            git("init", "--quiet", "--initial-branch=main")
            git("commit", "--quiet", "--allow-empty", "-m", "fixture")
            commit = git("rev-parse", "HEAD")
            git("branch", "develop")
            git("tag", "v1.2.3")
            source = (ROOT / "install-from-linux.sh").read_text().split("\nrun_preflight\nif ", 1)[0]
            for index, (requested, kind, value) in enumerate([
                ("main", "branch", "main"), ("develop", "branch", "develop"),
                ("v1.2.3", "tag", "v1.2.3"), (commit, "commit", commit),
                ("refs/heads/develop", "branch", "develop"), ("refs/tags/v1.2.3", "tag", "v1.2.3"),
            ]):
                with self.subTest(requested=requested):
                    checkout = root / f"checkout-{index}"
                    metadata = root / f"metadata-{index}"
                    # Exercise the metadata writer without chown/root operations.
                    script = source + f'''
REQUESTED_REF={shlex.quote(requested)}
REPOSITORY_URL={shlex.quote(str(remote))}
INSTALL_DIRECTORY={shlex.quote(str(checkout))}
checkout_repository
METADATA_FILE={shlex.quote(str(metadata))}
install() {{ cp "${{@: -2:1}}" "${{@: -1}}"; }}
write_metadata
'''
                    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    content = metadata.read_text()
                    self.assertIn(f"MAGICSTICK_PUBLIC_REF={value}\n", content)
                    self.assertIn(f"MAGICSTICK_PUBLIC_REF_KIND={kind}\n", content)
                    self.assertEqual(subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip(), commit)

    def test_public_install_paths_default_to_main(self):
        for path, text in [
            ("install-from-linux.sh", 'REQUESTED_REF="main"'),
            ("deploy-on-k8s.sh", 'REQUESTED_REF="main"'),
            ("deploy-on-k8s.ps1", '[string]$Ref = "main"'),
            ("magic-installer/user-data", 'MAGICSTICK_PUBLIC_REF=main'),
        ]:
            self.assertIn(text, (ROOT / path).read_text(), path)
