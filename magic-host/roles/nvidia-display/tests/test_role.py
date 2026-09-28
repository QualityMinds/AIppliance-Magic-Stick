from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

import yaml


ROLE = Path(__file__).resolve().parents[1]
ROOT = ROLE.parents[2]
DETECTOR = ROLE / "files/detect.py"


def add_pci_device(root: Path, name: str, vendor: str, class_code: str) -> None:
    device = root / "sys/bus/pci/devices" / name
    device.mkdir(parents=True)
    (device / "vendor").write_text(vendor)
    (device / "class").write_text(class_code)


class NvidiaDisplayDetectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "sys/bus/pci/devices").mkdir(parents=True)

    def detect(self):
        result = subprocess.run(
            [sys.executable, str(DETECTOR), "--root", str(self.root)],
            capture_output=True, text=True, check=True,
        )
        return json.loads(result.stdout)

    def test_cpu_only_skips_nvidia_path(self):
        self.assertEqual(self.detect(), {
            "displayCount": 0, "nvidiaDisplayCount": 0, "nvidiaDisplay": False,
        })

    def test_amd_only_skips_nvidia_path(self):
        add_pci_device(self.root, "0000:01:00.0", "0x1002", "0x030000")
        self.assertEqual(self.detect()["nvidiaDisplay"], False)

    def test_nvidia_display_controller_activates_host_path(self):
        add_pci_device(self.root, "0000:01:00.0", "0x10de", "0x030000")
        self.assertEqual(self.detect()["nvidiaDisplayCount"], 1)
        self.assertTrue(self.detect()["nvidiaDisplay"])

    def test_nvidia_non_display_controller_does_not_activate_host_path(self):
        add_pci_device(self.root, "0000:01:00.0", "0x10de", "0x020000")
        self.assertFalse(self.detect()["nvidiaDisplay"])

    def test_mixed_amd_and_nvidia_display_uses_host_driver(self):
        add_pci_device(self.root, "0000:01:00.0", "0x1002", "0x030000")
        add_pci_device(self.root, "0000:02:00.0", "0x10de", "0x030200")
        self.assertEqual(self.detect()["displayCount"], 2)
        self.assertTrue(self.detect()["nvidiaDisplay"])

    def test_non_pci_host_skips_nvidia_path(self):
        (self.root / "sys/bus/pci/devices").rmdir()
        self.assertFalse(self.detect()["nvidiaDisplay"])


class NvidiaDisplayRoleContractTests(unittest.TestCase):
    def setUp(self):
        self.tasks = yaml.safe_load((ROLE / "tasks/main.yml").read_text())
        self.block = next(task for task in self.tasks if task.get("name") == "Prepare a host-owned NVIDIA console only on matching hardware")
        self.inner = self.block["block"]

    def test_all_nvidia_mutations_are_guarded_by_hardware_detection(self):
        self.assertEqual(self.block["when"], "nvidia_display_detected | bool")
        self.assertFalse(any("ansible.builtin.apt" in task for task in self.tasks))
        self.assertTrue(any("ansible.builtin.apt" in task for task in self.inner))

    def test_host_driver_is_pinned_to_operator_version(self):
        defaults = yaml.safe_load((ROLE / "defaults/main.yml").read_text())
        release = yaml.safe_load((ROOT / "magic-cluster/platform/gpu/nvidia-gpu-operator/helmrelease.yaml").read_text())
        self.assertEqual(defaults["nvidia_display_driver_version"], release["spec"]["values"]["driver"]["version"])
        install = next(task for task in self.inner if "ansible.builtin.apt" in task)
        self.assertFalse(install["ansible.builtin.apt"]["allow_unauthenticated"])
        self.assertFalse(install["ansible.builtin.apt"]["install_recommends"])
        self.assertTrue(all("={{ nvidia_display_ubuntu_package_version }}" in name for name in install["ansible.builtin.apt"]["name"]))

    def test_boot_configuration_is_nvidia_only_and_keeps_drm_console(self):
        files = {
            task["ansible.builtin.copy"]["dest"]: task["ansible.builtin.copy"]["content"]
            for task in self.inner if "ansible.builtin.copy" in task
        }
        self.assertIn("options nvidia-drm modeset=1 fbdev=1", files["/etc/modprobe.d/90-magicstick-nvidia-display.conf"])
        self.assertIn("nvidia-drm", files["/etc/modules-load.d/90-magicstick-nvidia-display.conf"])
        self.assertIn("nvidia.com/gpu.deploy.driver=false", files["/etc/rancher/k3s/config.yaml.d/90-magicstick-nvidia-display.yaml"])

    def test_installers_reboot_only_after_nvidia_role_marks_change(self):
        usb = (ROOT / "magic-installer/user-data").read_text()
        linux = (ROOT / "install-from-linux.sh").read_text()
        marker = "/run/magicstick-nvidia-display-reboot-required"
        self.assertIn(f"if [ -f {marker} ]", usb)
        self.assertIn(f"if [[ -f {marker} ]]", linux)
        self.assertIn("shutdown -r +1", usb)
        self.assertIn("shutdown -r +1", linux)

    def test_host_role_precedes_k3s_and_existing_node_is_relabeled(self):
        playbook = yaml.safe_load((ROOT / "magic-host/playbooks/local.yml").read_text())
        roles = playbook[0]["roles"]
        self.assertLess(roles.index("nvidia-display"), roles.index("k3s"))
        k3s = yaml.safe_load((ROOT / "magic-host/roles/k3s/tasks/main.yml").read_text())
        label = next(task for task in k3s if task.get("name") == "Keep an existing NVIDIA display node on the host-owned driver")
        self.assertIn("nvidia_display_detected", " ".join(label["when"]))
        self.assertIn("nvidia.com/gpu.deploy.driver=false", label["ansible.builtin.command"]["argv"])


if __name__ == "__main__":
    unittest.main()
