# SPDX-License-Identifier: BUSL-1.1
import copy
import hashlib
import importlib.util
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "magic-installer/build-installer-image.sh"
HELPER = ROOT / "magic-installer/scripts/installer-media.py"
spec = importlib.util.spec_from_file_location("installer_media", HELPER)
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)

SOURCE = """Types: deb
URIs: file:///cdrom
Suites: resolute
Components: main restricted
Check-Date: no
Signed-By:
 -----BEGIN PGP PUBLIC KEY BLOCK-----
 .
 dGVzdA==
 -----END PGP PUBLIC KEY BLOCK-----
"""


class InstallerPoolTests(unittest.TestCase):
    def test_public_ci_bootstrap_is_token_free_and_channel_specific(self):
        config = yaml.safe_load((ROOT / "magic-installer/user-data").read_text())["autoinstall"]
        metadata = {"instance-id": "example-host-01", "local-hostname": "example-host-01"}
        media.verify_public_bootstrap(config, metadata, "main")
        with self.assertRaises(ValueError):
            media.verify_public_bootstrap(config, metadata, "develop")
        development = copy.deepcopy(config)
        development["user-data"]["write_files"][0]["content"] = (
            development["user-data"]["write_files"][0]["content"].replace(
                "MAGICSTICK_PUBLIC_REF=main", "MAGICSTICK_PUBLIC_REF=develop"))
        media.verify_public_bootstrap(development, metadata, "develop")
        for extra in ("FLUX_GITHUB_TOKEN=CHANGEME", "MAGICSTICK_PUBLIC_REF=main",
                      "AI_APPLIANCE_PRIVATE_CHECKOUT=/opt/private"):
            modified = copy.deepcopy(config)
            modified["user-data"]["write_files"][0]["content"] += "\n" + extra
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                media.verify_public_bootstrap(modified, metadata, "main")
        for key in ("identity", "ssh", "proxy"):
            modified = copy.deepcopy(config)
            modified[key] = {}
            with self.subTest(key=key), self.assertRaises(ValueError):
                media.verify_public_bootstrap(modified, metadata, "main")
        with self.assertRaises(ValueError):
            media.verify_public_bootstrap(config, {**metadata, "local-hostname": "private-host"}, "main")

    def test_only_local_components_are_changed(self):
        result, source = media.configure_local_source(SOURCE, "reduced")
        self.assertEqual(result, SOURCE.replace("Components: main restricted", "Components: main"))
        self.assertEqual(source["Suites"], "resolute")
        for invalid in (SOURCE.replace("file:///cdrom", "https://example.com/ubuntu"),
                        SOURCE.replace("main restricted", "main universe"),
                        SOURCE.replace("Signed-By:", "Unknown-Key:"), SOURCE + "\n" + SOURCE):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                media.configure_local_source(invalid, "reduced")

    def test_online_source_is_disabled_without_losing_iso_key(self):
        result, source = media.configure_local_source(SOURCE, "online")
        self.assertEqual(result, "Enabled: no\n" + SOURCE)
        disabled = media.control_records(result)[0]
        self.assertEqual(disabled["Enabled"], "no")
        self.assertEqual(disabled["Signed-By"], source["Signed-By"])
        for invalid in (SOURCE.replace("file:///cdrom", "https://example.com/ubuntu"),
                        "Enabled: yes\n" + SOURCE, SOURCE + "\n" + SOURCE):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                media.configure_local_source(invalid, "online")
        with self.assertRaises(ValueError):
            media.configure_local_source(SOURCE, "full")

    def test_media_paths_cannot_escape(self):
        for path in ("/etc/passwd", "../file", "pool/../../file", "pool/a\nfile", "pool\\file"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                media.safe_media_path(path)

    def test_logical_size_boundary_is_strict(self):
        self.assertTrue(media.size_metrics(2 * media.GIB - 1)["under2GiB"])
        self.assertFalse(media.size_metrics(2 * media.GIB)["under2GiB"])
        self.assertEqual(media.size_metrics(media.GIB)["GiB"], 1)
        self.assertEqual(media.size_metrics(media.GIB)["bytesBelow2GiB"], media.GIB)

    def test_cidata_partition_bounds(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / "test.img"
            data = bytearray(8192)
            data[512:520] = b"EFI PART"
            struct.pack_into("<QII", data, 512 + 72, 2, 4, 128)
            struct.pack_into("<QQ", data, 1024 + 2 * 128 + 32, 6, 15)
            image.write_bytes(data)
            self.assertEqual(media.cidata_offset(image), 3072)
            with self.assertRaises(ValueError):
                media.cidata_offset(image, 0)
            image.write_bytes(data[:4096])
            with self.assertRaises(ValueError):
                media.cidata_offset(image)

    def test_selection_preserves_main_and_rejects_needed_restricted_packages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "casper").mkdir()
            manifest = root / "casper/base.manifest"
            manifest.write_text("+linux-generic\t1\n+openssh-client\t1\n")
            template = root / "user-data"
            config = yaml.safe_load((ROOT / "magic-installer/user-data").read_text())
            template.write_text(yaml.safe_dump(config))
            package = {"path": "pool/restricted/driver.deb", "name": "optional-driver",
                       "depends": "", "provides": "optional-virtual"}
            before = {"packages": [package, {"path": "pool/main/boot.deb", "name": "boot", "depends": ""}]}
            self.assertEqual(media.validate_selection(before, root, template), [package])
            for depends in ("optional-driver (= 1)", "optional-virtual"):
                invalid = copy.deepcopy(before)
                invalid["packages"][1]["depends"] = depends
                with self.subTest(depends=depends), self.assertRaises(ValueError):
                    media.validate_selection(invalid, root, template)
            for mutate in (
                lambda c: c["autoinstall"].update(drivers={"install": True}),
                lambda c: c["autoinstall"].update(oem={"install": True}),
                lambda c: c["autoinstall"]["interactive-sections"].append("drivers"),
                lambda c: c["autoinstall"]["apt"].update(fallback="offline-install"),
                lambda c: c["autoinstall"]["packages"].append("optional-driver=1"),
                lambda c: c["autoinstall"]["packages"].append("desktop^"),
            ):
                modified = copy.deepcopy(config)
                mutate(modified)
                template.write_text(yaml.safe_dump(modified))
                with self.assertRaises(ValueError):
                    media.validate_selection(before, root, template)
            template.write_text(yaml.safe_dump(config))
            manifest.write_text("+optional-driver\t1\n")
            with self.assertRaises(ValueError):
                media.validate_selection(before, root, template)

    def test_online_selection_removes_all_archives_not_installed_packages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "casper").mkdir()
            (root / "casper/base.manifest").write_text("+linux-generic\t1\n")
            template = root / "user-data"
            config = yaml.safe_load((ROOT / "magic-installer/user-data").read_text())
            template.write_text(yaml.safe_dump(config))
            before = {"packages": [
                {"path": "pool/main/kernel.deb", "name": "linux-generic"},
                {"path": "pool/restricted/driver.deb", "name": "optional-driver"},
            ]}
            self.assertEqual(media.validate_selection(before, root, template, "online"), before["packages"])
            config["autoinstall"]["apt"]["fallback"] = "offline-install"
            template.write_text(yaml.safe_dump(config))
            with self.assertRaises(ValueError):
                media.validate_selection(before, root, template, "online")

    def test_pool_scope_is_mode_specific(self):
        for mode, expected in (("full", [False, False, False]),
                               ("reduced", [False, True, False]),
                               ("online", [True, True, False])):
            self.assertEqual([media.removed_pool_file(path, mode) for path in
                              ("pool/main/kernel.deb", "pool/restricted/driver.deb", "casper/vmlinuz")],
                             expected)

    def test_inventory_checks_package_bytes_and_sizes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / "pool/main/test.deb"
            package.parent.mkdir(parents=True)
            package.write_bytes(b"package")
            index = root / "dists/example/main/binary-amd64/Packages"
            index.parent.mkdir(parents=True)
            index.write_text("Package: test\nVersion: 1\nArchitecture: amd64\n"
                             "Filename: pool/main/test.deb\nSize: 7\n"
                             f"SHA256: {hashlib.sha256(b'package').hexdigest()}\n")
            inventory = media.inventory(root)
            self.assertEqual(inventory["sizes"]["pool"], 7)
            self.assertEqual(inventory["sizes"]["poolPackageCount"], 1)
            package.write_bytes(b"corrupt")
            with self.assertRaises(ValueError):
                media.inventory(root)

    def test_checksum_metadata_omits_removed_files_and_updates_changed_files(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            original = work / "media"
            original.mkdir()
            replacements = work / "replacements"
            replacements.mkdir()
            (replacements / "boot.cfg").write_bytes(b"updated")
            (original / "md5sum.txt").write_text(
                "old  ./boot.cfg\nold  ./pool/main/keep.deb\nold  ./pool/restricted/remove.deb\n")
            before = {"files": {name: {"bytes": 1, "md5": "old", "sha256": "old"}
                                for name in ("boot.cfg", "pool/main/keep.deb", "pool/restricted/remove.deb")},
                      "packages": [{"path": "pool/main/keep.deb"}, {"path": "pool/restricted/remove.deb"}]}
            media.write_json(work / "pool-before.json", before)
            media.write_json(work / "preparation.json", {"mode": "reduced"})
            media.metadata(type("Args", (), {"work": work})())
            result = (replacements / "md5sum.txt").read_text()
            self.assertNotIn("remove.deb", result)
            self.assertIn("keep.deb", result)
            self.assertIn(hashlib.md5(b"updated").hexdigest() + "  ./boot.cfg", result)
            media.write_json(work / "preparation.json", {"mode": "online"})
            media.metadata(type("Args", (), {"work": work})())
            result = (replacements / "md5sum.txt").read_text()
            self.assertNotIn("pool/", result)
            after = yaml.safe_load((work / "pool-after.json").read_text())
            self.assertEqual(after["sizes"]["pool"], 0)
            self.assertEqual(after["sizes"]["poolPackageCount"], 0)
            self.assertEqual(after["packages"], [])
            media.write_json(work / "preparation.json", {"mode": "full"})
            media.metadata(type("Args", (), {"work": work})())
            result = (replacements / "md5sum.txt").read_text()
            self.assertIn("keep.deb", result)
            self.assertIn("remove.deb", result)

    def run_wrapper(self, temp, *arguments):
        runtime = Path(temp) / "runtime"
        runtime.write_text('#!/bin/sh\nprintf "%s\\n" "$MAGICSTICK_OFFLINE_POOL" "$@"\n')
        runtime.chmod(0o755)
        # Do not depend on a user's real dist/ outputs or write their cache.
        script = Path(temp) / "repo/magic-installer/build-installer-image.sh"
        script.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SCRIPT, script)
        return subprocess.run(["bash", str(script), "--hostname", "example-host-01", "--no-build",
                               "--container-runtime", str(runtime), *arguments],
                              text=True, capture_output=True, check=False)

    def test_wrapper_full_default_and_explicit_pool_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            for mode in ("full", "reduced", "online"):
                output = str(Path(temp) / (mode + ".img"))
                args = [] if mode == "full" else ["--offline-pool", mode]
                result = self.run_wrapper(temp, "--output", output, *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines()[0], mode)
                self.assertIn("MAGICSTICK_OFFLINE_POOL", result.stdout)

    def test_wrapper_has_distinct_default_names(self):
        with tempfile.TemporaryDirectory() as temp:
            full = self.run_wrapper(temp)
            reduced = self.run_wrapper(temp, "--offline-pool", "reduced")
            online = self.run_wrapper(temp, "--offline-pool", "online")
            self.assertEqual(full.returncode, 0, full.stderr)
            self.assertEqual(reduced.returncode, 0, reduced.stderr)
            self.assertEqual(online.returncode, 0, online.stderr)
            self.assertIn("/output/magicstick-installer.img", full.stdout)
            self.assertIn("/output/magicstick-installer-reduced.img", reduced.stdout)
            self.assertIn("/output/magicstick-installer-online.img", online.stdout)

    def test_wrapper_rejects_invalid_mode_and_existing_output(self):
        with tempfile.TemporaryDirectory() as temp:
            for arguments in (("--offline-pool", "invalid"), ("--offline-pool",)):
                result = self.run_wrapper(temp, *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("--offline-pool", result.stderr)
            output = Path(temp) / "existing.img"
            output.write_bytes(b"preserve this")
            for path in (output, Path(temp) / "symlink.img"):
                if path != output:
                    path.symlink_to(output)
                result = self.run_wrapper(temp, "--output", str(path))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("already exists", result.stderr)
                self.assertEqual(output.read_bytes(), b"preserve this")

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell is not installed")
    def test_powershell_wrapper_parses(self):
        script = str(ROOT / "magic-installer/build-installer-image.ps1").replace("'", "''")
        subprocess.run(["pwsh", "-NoProfile", "-Command",
                        f"[scriptblock]::Create([IO.File]::ReadAllText('{script}')) | Out-Null"], check=True)


if __name__ == "__main__":
    unittest.main()
