import pathlib
import re
import subprocess
import tempfile
import textwrap
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILDER = ROOT / "magic-installer/scripts/build-installer-image-container.sh"
GRUB = textwrap.dedent('''\
    set timeout=30
    set default=0
    loadfont unicode
    menuentry "Try or Install Ubuntu Server" {
        set gfxpayload=keep
        linux /casper/vmlinuz ---
        initrd /casper/initrd
    }
    menuentry "Ubuntu Server with the HWE kernel" {
        set gfxpayload=keep
        linux /casper/hwe-vmlinuz ---
        initrd /casper/hwe-initrd
    }
    if [ "$grub_platform" = "efi" ]; then
    menuentry 'Boot from next volume' {
        exit 1
    }
    menuentry 'UEFI Firmware Settings' {
        fwsetup
    }
    fi
''')


class InstallerBootTests(unittest.TestCase):
    def patch(self, content, expect_success=True):
        # Exercise the production function without downloads or image writes.
        functions = BUILDER.read_text().split('\nOUTPUT=""', 1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "grub.cfg"
            config.write_text(content)
            result = subprocess.run(
                ["bash", "-c", functions + '\npatch_boot_config "$1"', "test", str(config)],
                text=True, capture_output=True, check=False,
            )
            if expect_success:
                self.assertEqual(result.returncode, 0, result.stderr)
            else:
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(config.read_text(), content)
                self.assertFalse(config.with_suffix(".cfg.tmp").exists())
            return config.read_text(), result.stderr

    def test_native_kernel_is_the_default_and_optional_hwe_keeps_autoinstall(self):
        patched, _ = self.patch(GRUB)
        self.assertTrue(patched.startswith("set default=magicstick-install\n"))
        self.assertEqual(patched.count("set default="), 1)
        self.assertIn('menuentry "Ubuntu Server with the HWE kernel" {', patched)
        self.assertIn('menuentry "Try or Install Ubuntu Server" --id magicstick-install {', patched)
        self.assertIn("linux /casper/vmlinuz autoinstall ds=nocloud ---", patched)
        self.assertIn("linux /casper/hwe-vmlinuz autoinstall ds=nocloud ---", patched)
        self.assertIn("initrd /casper/initrd", patched)
        self.assertIn("initrd /casper/hwe-initrd", patched)
        self.assertIn("menuentry 'UEFI Firmware Settings' {\n    fwsetup\n}", patched)

    def test_patch_is_idempotent(self):
        patched, _ = self.patch(GRUB)
        second, _ = self.patch(patched)
        self.assertEqual(patched, second)

    def test_native_selection_does_not_depend_on_title_or_position(self):
        original = GRUB.replace('"Try or Install Ubuntu Server"', "'Different title' --id old-default")
        original = 'menuentry "Diagnostics" {\n    echo test\n}\n' + original
        patched, _ = self.patch(original)
        self.assertIn("menuentry 'Different title' --id magicstick-install {", patched)
        self.assertNotIn("--id old-default", patched)
        self.assertEqual(patched.count("--id magicstick-install"), 1)

    def test_loopback_and_linuxefi_keep_their_other_arguments(self):
        original = GRUB.replace("linux /casper/", "linuxefi /casper/").replace(
            " ---", " iso-scan/filename=${iso_path} quiet ---"
        )
        patched, _ = self.patch(original)
        self.assertIn("linuxefi /casper/hwe-vmlinuz iso-scan/filename=${iso_path} quiet autoinstall ds=nocloud ---", patched)

    def test_partial_arguments_are_completed_once(self):
        for args in ("autoinstall", "ds=nocloud", "autoinstall ds=nocloud", ""):
            with self.subTest(args=args):
                patched, _ = self.patch(GRUB.replace(" ---", " " + args + " ---"))
                for line in patched.splitlines():
                    if re.match(r"\s*linux\s", line):
                        self.assertEqual(line.split().count("autoinstall"), 1)
                        self.assertEqual(line.split().count("ds=nocloud"), 1)

    def test_no_separator_and_legacy_append_are_supported(self):
        original = "append initrd=/casper/initrd quiet\nlinux /casper/hwe-vmlinuz\n"
        patched, _ = self.patch(original)
        self.assertIn("append initrd=/casper/initrd quiet autoinstall ds=nocloud", patched)
        self.assertIn("linux /casper/hwe-vmlinuz autoinstall ds=nocloud", patched)
        self.assertNotIn("set default=", patched)

    def test_new_lts_does_not_require_an_hwe_entry(self):
        patched, _ = self.patch("set default=0\nmenuentry 'GA' {\n linux /casper/vmlinuz ---\n}\n")
        self.assertNotIn("magicstick-hwe", patched)
        self.assertIn("set default=magicstick-install", patched)
        self.assertIn("menuentry 'GA' --id magicstick-install {", patched)
        self.assertIn("autoinstall ds=nocloud", patched)

    def test_conflicting_datasource_does_not_overwrite_the_config(self):
        _, error = self.patch(GRUB.replace(" ---", " ds=other ---"), expect_success=False)
        self.assertIn("Conflicting installer datasource", error)

    def test_target_tracks_generic_without_pinning_a_kernel_version(self):
        data = yaml.safe_load((ROOT / "magic-installer/user-data").read_text())
        self.assertEqual(data["autoinstall"]["kernel"], {"flavor": "generic"})

    def test_builder_requires_native_files_and_a_selectable_entry(self):
        source = BUILDER.read_text()
        self.assertIn("-ls /casper/vmlinuz /casper/initrd", source)
        self.assertIn('if [[ "$native_patched_count" -eq 0 ]]', source)
        self.assertIn("(/casper/(hwe-)?vmlinuz|initrd=.*casper)", source)

    def test_iso_version_and_checksum_match_in_all_build_entrypoints(self):
        url = "https://releases.ubuntu.com/26.04.1/ubuntu-26.04.1-live-server-amd64.iso"
        checksum = "cc8a95cde20f6ced61a322420de00f10cc3c90ced545daa46cb9c1a117f1d927"
        for path in (BUILDER, ROOT / "magic-installer/build-installer-image.sh",
                     ROOT / "magic-installer/build-installer-image.ps1"):
            with self.subTest(path=path.name):
                source = path.read_text()
                self.assertIn(url, source)
                self.assertIn(checksum, source)


if __name__ == "__main__":
    unittest.main()
