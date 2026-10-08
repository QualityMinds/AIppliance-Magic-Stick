# SPDX-License-Identifier: BUSL-1.1
"""Contract tests for the disposable USB-image VM acceptance harness."""

import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

import yaml

from tools import installer_vm_acceptance as vm
from tools import azure_installer_vm_cleanup as cleanup


ROOT = Path(__file__).resolve().parents[1]
REVISION = "a" * 40
PUBLIC_KEY = "ssh-ed25519 " + "A" * 68 + " ci-test"


class InstallerVmAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.user_data = (ROOT / "magic-installer/user-data").read_text()
        self.meta_data = (ROOT / "magic-installer/meta-data").read_text()

    def config(self):
        return vm.ensure_public_template(self.user_data, self.meta_data)

    def test_test_answers_preserve_install_and_first_boot_commands(self):
        original = self.config()
        original_auto = original["autoinstall"]
        runcmd = copy.deepcopy(original_auto["user-data"]["runcmd"])
        packages = copy.deepcopy(original_auto["packages"])
        kernel = copy.deepcopy(original_auto["kernel"])
        rendered = vm.test_user_data(original, public_key=PUBLIC_KEY,
                                     password_hash="$6$test$hash", revision=REVISION)
        self.assertTrue(rendered.startswith("#cloud-config\n"))
        result = yaml.safe_load(rendered)["autoinstall"]
        self.assertEqual(result["interactive-sections"], [])
        self.assertEqual(result["storage"]["layout"], {
            "name": "direct", "match": {"serial": f"*{vm.TARGET_SERIAL}*"},
        })
        self.assertEqual(result["ssh"]["authorized-keys"], [PUBLIC_KEY])
        self.assertFalse(result["ssh"]["allow-pw"])
        self.assertEqual(result["packages"], packages)
        self.assertEqual(result["kernel"], kernel)
        self.assertEqual(result["user-data"]["runcmd"], runcmd)
        self.assertEqual(result["apt"]["fallback"], "abort")
        self.assertFalse(result["apt"]["geoip"])
        files = result["user-data"]["write_files"]
        repo = next(file["content"] for file in files
                    if file["path"] == "/etc/default/ai-appliance-repo")
        self.assertIn(f"MAGICSTICK_PUBLIC_REF={REVISION}", repo)
        self.assertIn("MAGICSTICK_PUBLIC_REF_KIND=commit", repo)
        self.assertNotIn("FLUX_GITHUB_TOKEN=", repo)
        sudoers = next(file for file in files if file["path"].startswith("/etc/sudoers.d/"))
        self.assertEqual(sudoers["permissions"], "0440")

    def test_unknown_or_private_media_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "placeholder"):
            vm.ensure_public_template(self.user_data, "instance-id: real-host\n")
        config = self.config()
        config["autoinstall"]["identity"] = {"username": "real"}
        with self.assertRaisesRegex(ValueError, "machine-specific"):
            vm.ensure_public_template(yaml.safe_dump(config), self.meta_data)
        config = self.config()
        config["autoinstall"]["user-data"]["write_files"][0]["content"] += "FLUX_GITHUB_TOKEN=secret\n"
        with self.assertRaisesRegex(ValueError, "token-free"):
            vm.ensure_public_template(yaml.safe_dump(config), self.meta_data)

    def test_invalid_ref_key_or_mirror_policy_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "full source commit"):
            vm.test_user_data(self.config(), public_key=PUBLIC_KEY,
                              password_hash="$6$test$hash", revision="main")
        with self.assertRaisesRegex(ValueError, "ed25519"):
            vm.test_user_data(self.config(), public_key="ssh-rsa x",
                              password_hash="$6$test$hash", revision=REVISION)
        config = self.config()
        config["autoinstall"]["apt"]["fallback"] = "offline-install"
        with self.assertRaisesRegex(ValueError, "online mirror"):
            vm.test_user_data(config, public_key=PUBLIC_KEY,
                              password_hash="$6$test$hash", revision=REVISION)

    def test_only_install_phase_attaches_source_media(self):
        common = dict(image=Path("installer.img"), target=Path("target.qcow2"),
                      vars_file=Path("vars.fd"), code_file=Path("code.fd"),
                      ssh_port=2222, setup_port=9444, memory_mib=16384, cpus=4,
                      serial_log=Path("serial.log"))
        installer = vm.qemu_args(**common, installer=True)
        first_boot = vm.qemu_args(**common, installer=False)
        self.assertIn("usb-storage,drive=installer,bootindex=1", installer)
        self.assertNotIn("usb-storage,drive=installer,bootindex=1", first_boot)
        self.assertIn(f"virtio-blk-pci,drive=target,serial={vm.TARGET_SERIAL},bootindex=1",
                      first_boot)
        self.assertTrue(any("127.0.0.1:2222-:22" in item for item in installer))
        self.assertTrue(any("127.0.0.1:9444-:9443" in item for item in installer))

    def test_expired_group_cleanup_requires_name_tag_region_and_deadline(self):
        now = datetime.now(timezone.utc)
        group = {
            "name": "ms-installer-ci-123-1", "location": "germanywestcentral",
            "tags": {"purpose": cleanup.PURPOSE,
                     "expiresAt": (now - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")},
        }
        self.assertTrue(cleanup.expired_test_group(group, now))
        for changed in (
            {**group, "name": "user-project"},
            {**group, "location": "westeurope"},
            {**group, "tags": {**group["tags"], "purpose": "other"}},
            {**group, "tags": {**group["tags"], "expiresAt": "bad"}},
            {**group, "tags": {**group["tags"],
                                "expiresAt": (now + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")}},
        ):
            with self.subTest(changed=changed):
                self.assertFalse(cleanup.expired_test_group(changed, now))


if __name__ == "__main__":
    unittest.main()
