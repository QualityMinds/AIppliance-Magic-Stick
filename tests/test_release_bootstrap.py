# SPDX-License-Identifier: BUSL-1.1
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from tools import release_bootstrap as bootstrap
from tests.test_release_catalog import manifest


class BootstrapTests(unittest.TestCase):
    def test_stable_is_resolved_once_without_prerelease_or_main_fallback(self):
        client = Mock()
        client.latest_stable.return_value = {"version": "v1.2.3", "commit": "a" * 40}
        self.assertEqual(bootstrap.resolve("stable", client=client)["version"], "v1.2.3")
        client.resolve.assert_not_called()
        client.latest_stable.side_effect = bootstrap.catalog.ReleaseError("No stable release")
        with self.assertRaises(bootstrap.catalog.ReleaseError): bootstrap.resolve("stable", client=client)
        client.resolve.assert_not_called()

    def test_embedded_commit_must_still_match_the_published_release(self):
        client = Mock(); client.latest_stable.return_value = {"commit": "a" * 40}
        with self.assertRaisesRegex(bootstrap.catalog.ReleaseError, "embedded"):
            bootstrap.resolve("stable", "b" * 40, client=client)

    def test_real_git_checkout_and_moved_tag_rejection_preserve_source_license_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "source"; root.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(root), *args], text=True, stderr=subprocess.PIPE).strip()
            git("init", "-q", "-b", "main"); git("config", "user.name", "Synthetic fixture"); git("config", "user.email", "fixture@example.com")
            git("config", "commit.gpgsign", "false"); git("config", "tag.gpgsign", "false")
            record = manifest()["license"]
            for name in ("LICENSE-RELEASE.json", "licenses/releases/v1.2.3.json"):
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(record))
            runtime = root / "magic-cluster/apps/regression/runtime.yaml"; runtime.parent.mkdir(parents=True)
            images = manifest()["images"]
            runtime.write_text('data:\n  image: "' + images[-1]["image"] + '"\n')
            git("add", "."); git("commit", "-q", "-m", "Synthetic release source"); commit = git("rev-parse", "HEAD")
            git("tag", "-a", "v1.2.3", "-m", "Synthetic fixture tag"); tag = git("rev-parse", "v1.2.3")
            git("remote", "add", "origin", str(root))
            proof = {"version": "v1.2.3", "commit": commit, "tagObject": tag, "license": record, "images": images}
            original = bootstrap.git
            def fixture_git(path, *args):
                if args == ("remote", "get-url", "origin"):
                    return "https://github.com/" + bootstrap.catalog.REPOSITORY + ".git"
                return original(path, *args)
            critical = [{"image": i["image"]} for i in images[:4]]
            with patch.object(bootstrap, "git", side_effect=fixture_git), patch.object(bootstrap.host_software(), "image_inventory", return_value=critical):
                bootstrap.checkout(root, proof)
                self.assertEqual(git("rev-parse", "HEAD"), commit)
                self.assertEqual(json.loads((root / "LICENSE-RELEASE.json").read_text()), record)
                git("checkout", "-q", "main"); git("commit", "--allow-empty", "-q", "-m", "Different source")
                git("tag", "-f", "v1.2.3")
                changed = git("rev-parse", "HEAD")
                with self.assertRaisesRegex(bootstrap.catalog.ReleaseError, "differs"):
                    bootstrap.checkout(root, proof)
                self.assertEqual(git("rev-parse", "HEAD"), changed)

    def test_dirty_or_foreign_checkout_never_fetches_or_rewrites_metadata(self):
        proof = {"version": "v1.2.3", "commit": "a" * 40, "tagObject": "b" * 40}
        for values in (["https://example.com/project.git"], ["https://github.com/" + bootstrap.catalog.REPOSITORY + ".git", " M user-file"]):
            with patch.object(bootstrap, "git", side_effect=values) as command, self.assertRaises(bootstrap.catalog.ReleaseError):
                bootstrap.checkout(Path("/synthetic"), proof)
            self.assertLessEqual(command.call_count, 2)

    def test_public_resolution_never_imports_linux_only_host_modules(self):
        code = '''
import builtins,json,sys,subprocess
# subprocess itself selects its platform implementation; preload the POSIX
# stdlib implementation before refusing direct Linux-worker dependencies.
original = builtins.__import__
def portable(name,*args,**kwargs):
    if name in {"fcntl","software_channel"}:
        raise AssertionError("A public release lookup cannot require Linux host modules")
    return original(name,*args,**kwargs)
builtins.__import__ = portable
from tools import release_bootstrap as bootstrap
class Client:
    def latest_stable(self):
        return {"version":"v1.2.3","commit":"a"*40,"tagObject":"b"*40}
bootstrap.catalog.ReleaseClient = Client
sys.argv = ["release_bootstrap.py","--resolve-only"]
bootstrap.main()
'''
        output = subprocess.check_output([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], text=True)
        self.assertEqual(json.loads(output)["version"], "v1.2.3")


if __name__ == "__main__": unittest.main()
