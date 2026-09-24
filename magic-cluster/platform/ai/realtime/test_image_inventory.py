# SPDX-License-Identifier: BUSL-1.1
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

from inventory_ci_image import inventory, scan_command


IMAGE_ID = "sha256:" + "a" * 64
IMAGE = {"Id": IMAGE_ID, "Os": "linux", "Architecture": "amd64", "Config": {
    "Env": ["PRIVATE_VALUE=not-for-reports"], "Volumes": None,
}}
SBOM = {"source": {"type": "directory", "metadata": {"path": "/"}},
        "artifacts": [{"name": "fixture-package", "version": "1.0", "type": "python"}]}


class ImageInventoryTests(unittest.TestCase):
    def test_scan_is_offline_read_only_and_uses_installed_image_catalogers(self):
        command = scan_command(IMAGE_ID, "linux/amd64", "/tools/syft", "source-revision", "/tools/config.yaml")
        for option, value in [("--network", "none"), ("--pull", "never"), ("--cap-drop", "ALL"),
                              ("--security-opt", "no-new-privileges"), ("--memory", "6g"),
                              ("--override-default-catalogers", "image,file")]:
            self.assertEqual(command[command.index(option) + 1], value)
        self.assertIn("--read-only", command)
        self.assertIn("dir:/", command)
        self.assertIn("type=bind,source=/tools/syft,target=/magicstick-ci-tools/syft,readonly", command)
        self.assertIn("type=bind,source=/tools/config.yaml,target=/magicstick-ci-tools/syft.yaml,readonly", command)
        self.assertIn("./magicstick-ci-tools/**", command)
        self.assertIn("./run/magicstick-syft/**", command)
        self.assertEqual(command[command.index("scan") - 1], IMAGE_ID)
        for forbidden in ("docker.sock", "--privileged", "docker:", "save", "export", "prune"):
            self.assertNotIn(forbidden, " ".join(command))
        # Do not hide the image's own /tmp (which may contain shipped packages).
        self.assertNotIn("/tmp:rw", " ".join(command))

    def run_inventory(self, output, image=None, sbom=None, failure=None):
        scanner = output / "syft"
        scanner.touch()
        commands = []

        def run(command, **kwargs):
            self.assertTrue(kwargs["check"])
            commands.append(command)
            if command[:3] == ["docker", "image", "inspect"]:
                return subprocess.CompletedProcess(command, 0, json.dumps(image or IMAGE))
            if command[:2] == ["docker", "run"]:
                if failure:
                    raise subprocess.CalledProcessError(failure, command)
                json.dump(SBOM if sbom is None else sbom, kwargs["stdout"])
            return subprocess.CompletedProcess(command, 0)

        with patch("inventory_ci_image.shutil.which", return_value=str(scanner)), \
                patch("inventory_ci_image.subprocess.run", side_effect=run):
            result = inventory("candidate:ci", "source-revision", output / "evidence")
        return result, commands

    def test_reports_are_bound_to_exact_image_and_only_small_sbom_is_converted(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            identity, commands = self.run_inventory(output)
            evidence = output / "evidence"
            self.assertEqual((evidence / "tested-image-id.txt").read_text().strip(), IMAGE_ID)
            self.assertEqual(identity["sbomSha256"], hashlib.sha256((evidence / "image.syft.json").read_bytes()).hexdigest())
            self.assertEqual(identity["imageID"], IMAGE_ID)
            self.assertEqual(json.loads((evidence / "image-identity.json").read_text()), identity)
            self.assertEqual(len(commands), 3)
            self.assertEqual(commands[2][1:3], ["convert", str(evidence / "image.syft.json")])
            self.assertIn(f"spdx-json={evidence / 'image.spdx.json'}", commands[2])
            self.assertIn(f"cyclonedx-json={evidence / 'image.cdx.json'}", commands[2])
            self.assertNotIn("PRIVATE_VALUE", json.dumps(identity))
            self.assertFalse((evidence / "image.syft.json.partial").exists())

    def test_scan_failure_is_fatal_and_does_not_create_success_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            evidence = output / "evidence"
            evidence.mkdir()
            for name in ("image-identity.json", "image.syft.json", "image.spdx.json", "image.cdx.json"):
                (evidence / name).write_text("stale success evidence")
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_inventory(output, failure=137)
            for name in ("image-identity.json", "image.syft.json", "image.spdx.json", "image.cdx.json"):
                self.assertFalse((evidence / name).exists())

    def test_empty_or_nonfilesystem_inventory_is_rejected(self):
        for sbom in ({"artifacts": []}, {"source": {"type": "image"}, "artifacts": SBOM["artifacts"]}):
            with self.subTest(sbom=sbom), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    self.run_inventory(Path(directory), sbom=sbom)

    def test_ambiguous_image_or_hidden_volume_is_rejected_before_scan(self):
        for field, value in [("Id", "candidate:ci"), ("Architecture", "unknown"),
                             ("Config", {"Volumes": {"/usr/local/lib": {}}})]:
            image = copy.deepcopy(IMAGE)
            image[field] = value
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    self.run_inventory(Path(directory), image=image)


@unittest.skipUnless(os.environ.get("MAGICSTICK_IMAGE_SCAN_SMOKE") == "1",
                     "Opt in to the small native Docker/Syft integration test")
class ImageInventorySmokeTests(unittest.TestCase):
    def test_real_scanner_finds_installed_packages_without_inventoring_itself(self):
        # No base pull, package downloads, model weights or GPU are needed.
        tag = "magicstick-sbom-fixture:" + uuid.uuid4().hex
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {
                "etc/os-release": 'ID=ubuntu\nNAME=Ubuntu\nVERSION_ID="24.04"\n',
                "var/lib/dpkg/status": (
                    "Package: magicstick-audit-fixture\nStatus: install ok installed\n"
                    "Architecture: all\nVersion: 1.2.3\nDescription: Synthetic CI fixture\n\n"
                ),
                "usr/local/lib/python3.12/site-packages/magicstick_fixture-1.0.0.dist-info/METADATA": (
                    "Metadata-Version: 2.1\nName: magicstick-fixture\nVersion: 1.0.0\nLicense: MIT\n"
                ),
            }
            for relative, content in files.items():
                destination = root / "rootfs" / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(content)
            (root / "Dockerfile").write_text("FROM scratch\nCOPY rootfs /\n")
            try:
                subprocess.run(["docker", "build", "--network", "none", "--tag", tag, str(root)], check=True)
                output = root / "evidence"
                identity = inventory(tag, "synthetic-fixture", output,
                                     os.environ.get("MAGICSTICK_SYFT_LINUX_BINARY"))
                document = json.loads((output / "image.syft.json").read_text())
                packages = {(item["name"], item["version"], item["type"]) for item in document["artifacts"]}
                self.assertIn(("magicstick-audit-fixture", "1.2.3", "deb"), packages)
                self.assertIn(("magicstick-fixture", "1.0.0", "python"), packages)
                self.assertFalse(any("syft" in name for name, _, _ in packages))
                self.assertEqual(identity["sbomSha256"], hashlib.sha256((output / "image.syft.json").read_bytes()).hexdigest())
                for name, collection in [("image.spdx.json", "packages"), ("image.cdx.json", "components")]:
                    report = json.loads((output / name).read_text())
                    names = {item["name"] for item in report[collection]}
                    self.assertTrue({"magicstick-fixture", "magicstick-audit-fixture"}.issubset(names))
            finally:
                # Remove only the unique synthetic image created by this test.
                subprocess.run(["docker", "image", "rm", tag], check=False)


if __name__ == "__main__":
    unittest.main()
