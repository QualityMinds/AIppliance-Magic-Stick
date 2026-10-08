from pathlib import Path
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest

import yaml


ROLE = Path(__file__).resolve().parents[1]
ROOT = ROLE.parents[2]
DETECTOR = ROLE / "files/detect.py"
SELECTOR = ROLE / "files/select-driver.py"
selection_spec = importlib.util.spec_from_file_location("nvidia_driver_selection", SELECTOR)
selection = importlib.util.module_from_spec(selection_spec)
selection_spec.loader.exec_module(selection)


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

    def test_host_driver_uses_ubuntu_recommendation_without_version_or_series_pin(self):
        defaults = yaml.safe_load((ROLE / "defaults/main.yml").read_text())
        self.assertNotIn("nvidia_display_driver_version", defaults)
        self.assertNotIn("nvidia_display_ubuntu_package_version", defaults)
        prerequisite = next(task for task in self.inner if task.get("name") == "Install Ubuntu hardware-based driver selection")
        self.assertEqual(prerequisite["ansible.builtin.apt"]["name"], "ubuntu-drivers-common")
        selected = next(task for task in self.inner if "nvidia_display_driver_plan" == task.get("register"))
        self.assertEqual(selected["ansible.builtin.script"], {"cmd": "select-driver.py", "executable": "/usr/bin/python3"})
        self.assertFalse(selected["changed_when"])
        install = next(task for task in self.inner if task.get("register") == "nvidia_display_packages")
        self.assertIn("nvidia_display_driver_plan.stdout", install["ansible.builtin.apt"]["name"])
        for task in (prerequisite, install):
            apt = task["ansible.builtin.apt"]
            self.assertEqual(apt["state"], "present")
            self.assertFalse(apt["allow_unauthenticated"])
            self.assertFalse(apt["allow_downgrade"])
            self.assertTrue(apt["fail_on_autoremove"])
        self.assertTrue(any("packages | length > 0" in condition for condition in install["when"]))
        self.assertNotIn("595", (ROLE / "tasks/main.yml").read_text())
        self.assertNotIn("595", (ROLE / "defaults/main.yml").read_text())

    def test_boot_configuration_is_nvidia_only_and_keeps_drm_console(self):
        files = {
            task["ansible.builtin.copy"]["dest"]: task["ansible.builtin.copy"]["content"]
            for task in self.inner if "ansible.builtin.copy" in task
        }
        self.assertIn("options nvidia-drm modeset=1 fbdev=1", files["/etc/modprobe.d/90-magicstick-nvidia-display.conf"])
        self.assertIn("nvidia-drm", files["/etc/modules-load.d/90-magicstick-nvidia-display.conf"])
        self.assertIn("nvidia.com/gpu.deploy.driver=false", files["/etc/rancher/k3s/config.yaml.d/90-magicstick-nvidia-display.yaml"])

    def test_host_owned_driver_keeps_cdi_persistence_socket_available(self):
        override = next(task for task in self.inner if task.get("name") == "Keep the host NVIDIA persistence socket available for CDI containers")
        self.assertEqual(
            override["ansible.builtin.copy"]["dest"],
            "/etc/systemd/system/nvidia-persistenced.service.d/90-magicstick.conf",
        )
        content = override["ansible.builtin.copy"]["content"]
        self.assertIn("StopWhenUnneeded=false", content)
        self.assertIn("Restart=on-failure", content)
        self.assertIn("WantedBy=multi-user.target", content)

        enabled = next(task for task in self.inner if task.get("name") == "Enable NVIDIA persistence daemon across host reboots")
        self.assertEqual(enabled["ansible.builtin.systemd_service"]["name"], "nvidia-persistenced.service")
        self.assertTrue(enabled["ansible.builtin.systemd_service"]["enabled"])

        probe = next(task for task in self.inner if task.get("name") == "Check whether the NVIDIA driver is already usable before starting persistence")
        self.assertEqual(probe["ansible.builtin.command"]["argv"], ["/usr/bin/nvidia-smi", "-L"])
        self.assertFalse(probe["failed_when"])
        start = next(task for task in self.inner if task.get("name") == "Start NVIDIA persistence daemon when the driver is usable")
        self.assertEqual(start["when"], "nvidia_display_gpu_probe.rc == 0")
        self.assertEqual(start["ansible.builtin.systemd_service"]["state"], "started")
        self.assertLess(self.inner.index(enabled), self.inner.index(probe))
        self.assertLess(self.inner.index(probe), self.inner.index(start))

    def test_existing_installation_media_delegates_reboot_to_host_ansible(self):
        usb = (ROOT / "magic-installer/user-data").read_text()
        linux = (ROOT / "install-from-linux.sh").read_text()
        self.assertIn("MAGICSTICK_PUBLIC_REF=main", usb)
        self.assertIn("ai-appliance-converge", usb)
        self.assertIn("start_installation", linux)
        for installer in (usb, linux):
            self.assertNotIn("magicstick-nvidia-display-reboot-required", installer)
            self.assertNotIn("Finish Magic Stick NVIDIA console installation", installer)
            self.assertNotIn("shutdown -r +1", installer)

    def test_only_changed_fresh_installations_request_a_reboot(self):
        defaults = yaml.safe_load((ROLE / "defaults/main.yml").read_text())
        self.assertEqual(defaults["nvidia_display_new_install_marker"], "/var/lib/magicstick/setup/new-install")
        self.assertIn("first-install", defaults["nvidia_display_reboot_marker"])
        self.assertIn("first-install", defaults["nvidia_display_reboot_scheduled_marker"])
        marker = next(task for task in self.inner if task.get("name") == "Mark a changed first installation for the host-managed reboot")
        self.assertIn("nvidia_display_new_install.stat.exists", marker["when"])
        self.assertTrue(any("nvidia_display_packages.changed" in condition for condition in marker["when"]))

    def test_finalizer_runs_after_roles_and_schedules_at_most_once_per_boot(self):
        playbook = yaml.safe_load((ROOT / "magic-host/playbooks/local.yml").read_text())[0]
        self.assertEqual(playbook["post_tasks"][0]["ansible.builtin.meta"], "flush_handlers")
        finalizer = playbook["post_tasks"][1]
        self.assertEqual(finalizer["ansible.builtin.import_role"], {"name": "nvidia-display", "tasks_from": "finalize"})
        self.assertIn("nvidia_display_detected", finalizer["when"])
        tasks = yaml.safe_load((ROLE / "tasks/finalize.yml").read_text())
        names = [task["name"] for task in tasks]
        guard = names.index("Record the completed first-install reboot scheduling")
        shutdown = names.index("Schedule the first-install NVIDIA display reboot after successful convergence")
        self.assertLess(shutdown, guard)
        self.assertTrue(any("nvidia_display_reboot_handled.stat.exists" in condition for condition in tasks[guard]["when"]))
        self.assertIn("not ansible_check_mode", tasks[guard]["when"])
        shutdown_state = next(task for task in tasks if task.get("name") == "Check for an existing system shutdown")
        self.assertEqual(shutdown_state["ansible.builtin.stat"]["path"], "/run/systemd/shutdown/scheduled")
        command = tasks[shutdown]["ansible.builtin.command"]["argv"]
        self.assertEqual(command[:3], ["/usr/sbin/shutdown", "-r", "+1"])
        self.assertIn("not ansible_check_mode", tasks[shutdown]["when"])
        self.assertIn("not nvidia_display_other_shutdown.stat.exists", tasks[shutdown]["when"])
        self.assertTrue(any("nvidia_display_reboot_command.changed" in condition for condition in tasks[guard]["when"]))

    def test_host_role_precedes_k3s_and_existing_node_is_relabeled(self):
        playbook = yaml.safe_load((ROOT / "magic-host/playbooks/local.yml").read_text())
        roles = playbook[0]["roles"]
        self.assertLess(roles.index("nvidia-display"), roles.index("k3s"))
        k3s = yaml.safe_load((ROOT / "magic-host/roles/k3s/tasks/main.yml").read_text())
        label = next(task for task in k3s if task.get("name") == "Keep an existing NVIDIA display node on the host-owned driver")
        self.assertIn("nvidia_display_detected", " ".join(label["when"]))
        self.assertIn("nvidia.com/gpu.deploy.driver=false", label["ansible.builtin.command"]["argv"])


def ubuntu_device(driver="nvidia-driver-610-open", pci="0000:01:00.0", flags="distro non-free recommended"):
    return (
        f"== /sys/devices/pci0000:00/{pci} ==\n"
        "modalias : pci:v000010DEd00002230sv000010DEsd00001459bc03sc00i00\n"
        "vendor   : NVIDIA Corporation\n"
        "model    : Synthetic GPU\n"
        "driver   : nvidia-driver-595-open - distro non-free\n"
        f"driver   : {driver} - {flags}\n"
        "driver   : xserver-xorg-video-nouveau - distro free builtin\n\n"
    )


class NvidiaDriverSelectionTests(unittest.TestCase):
    def make_plan(self, installed="", devices=None, packages=None):
        calls = []
        outputs = {
            "/usr/bin/dpkg-query": installed,
            "devices": ubuntu_device() if devices is None else devices,
            "list": "nvidia-driver-610-open linux-modules-nvidia-610-open-generic\n" if packages is None else packages,
        }

        def reader(argv):
            calls.append(argv)
            return outputs[argv[1] if argv[0].endswith("ubuntu-drivers") else argv[0]]

        return selection.plan(reader), calls

    def test_fresh_install_uses_recommended_series_not_old_pinned_packages(self):
        plan, calls = self.make_plan()
        self.assertEqual(plan["selection"], "ubuntu-recommended")
        self.assertEqual(plan["packages"], ["nvidia-driver-610-open", "linux-modules-nvidia-610-open-generic"])
        self.assertTrue(all("=" not in package for package in plan["packages"]))
        self.assertEqual(calls[-1], ["/usr/bin/ubuntu-drivers", "list", "--recommended", "--include-dkms"])

    def test_recommendation_can_change_to_another_series_without_code_changes(self):
        for driver in ("nvidia-driver-580", "nvidia-driver-615-open", "nvidia-driver-570-server-open"):
            with self.subTest(driver=driver):
                plan, _ = self.make_plan(devices=ubuntu_device(driver), packages=driver + "\n")
                self.assertEqual(plan["packages"], [driver])

    def test_prebuilt_kernel_module_is_kept_in_the_install_set(self):
        plan, _ = self.make_plan(packages="nvidia-driver-610-open linux-modules-nvidia-610-open-7.0.0-38-generic\n")
        self.assertEqual(len(plan["packages"]), 2)

    def test_matching_dkms_recommendation_is_supported(self):
        plan, _ = self.make_plan(packages="nvidia-driver-610-open nvidia-dkms-610-open\n")
        self.assertEqual(plan["packages"][-1], "nvidia-dkms-610-open")

    def test_four_matching_gpus_use_one_driver_package_set(self):
        devices = "".join(ubuntu_device(pci=f"0000:{index:02x}:00.0") for index in range(1, 5))
        plan, _ = self.make_plan(devices=devices)
        self.assertEqual(plan["driverPackages"], ["nvidia-driver-610-open"])

    def test_existing_legacy_headless_driver_does_not_upgrade_or_reselect(self):
        installed = "nvidia-headless-595-open\tii \nnvidia-headless-no-dkms-595-open\tii \nnvidia-utils-595\tii \n"
        plan, calls = self.make_plan(installed=installed)
        self.assertEqual(plan["selection"], "installed")
        self.assertEqual(plan["packages"], [])
        self.assertEqual(len(calls), 1)

    def test_existing_full_driver_and_arch_qualified_package_are_retained(self):
        plan, calls = self.make_plan(installed="nvidia-driver-580-server-open:amd64\tii \n")
        self.assertEqual(plan["driverPackages"], ["nvidia-driver-580-server-open"])
        self.assertEqual(plan["packages"], [])
        self.assertEqual(len(calls), 1)

    def test_removed_and_partly_configured_packages_do_not_suppress_selection(self):
        plan, _ = self.make_plan(installed="nvidia-driver-595-open\trc \nnvidia-driver-610-open\tiU \n")
        self.assertEqual(plan["selection"], "ubuntu-recommended")

    def test_conflicting_existing_driver_series_fail_without_reselection(self):
        with self.assertRaisesRegex(ValueError, "Multiple NVIDIA"):
            self.make_plan(installed="nvidia-driver-580\tii \nnvidia-driver-610-open\tii \n")

    def test_missing_recommendation_fails_without_installing(self):
        for devices in ("", ubuntu_device(flags="distro non-free")):
            with self.subTest(devices=devices), self.assertRaisesRegex(ValueError, "recommended|recommendation"):
                self.make_plan(devices=devices)

    def test_every_nvidia_gpu_requires_the_same_recommendation(self):
        devices = ubuntu_device() + ubuntu_device("nvidia-driver-580", pci="0000:02:00.0")
        with self.assertRaisesRegex(ValueError, "common NVIDIA"):
            self.make_plan(devices=devices)
        missing = ubuntu_device() + ubuntu_device(pci="0000:02:00.0", flags="distro non-free")
        with self.assertRaisesRegex(ValueError, "every GPU"):
            self.make_plan(devices=missing)

    def test_other_vendors_and_oem_recommendations_are_not_installed(self):
        other = "== /sys/devices/wifi ==\nvendor : Example WiFi\ndriver : oem-example-meta - distro free recommended\n\n"
        plan, _ = self.make_plan(devices=other + ubuntu_device(), packages="oem-example-meta\nnvidia-driver-610-open linux-modules-nvidia-610-open-generic\n")
        self.assertNotIn("oem-example-meta", plan["packages"])

    def test_third_party_recommendation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "third-party"):
            self.make_plan(devices=ubuntu_device(flags="third-party non-free recommended"))

    def test_missing_kernel_plan_and_wrong_branch_fail_closed(self):
        for packages in ("", "nvidia-driver-610-open linux-modules-nvidia-595-open-generic\n",
                         "nvidia-driver-610-open nvidia-dkms-610\n"):
            with self.subTest(packages=packages), self.assertRaises(ValueError):
                self.make_plan(packages=packages)

    def test_package_output_cannot_introduce_versions_flags_or_commands(self):
        for packages in ("nvidia-driver-610-open=610.57.04\n",
                         "nvidia-driver-610-open --allow-unauthenticated\n",
                         "nvidia-driver-610-open linux-modules-nvidia-610-open-generic extra\n",
                         "nvidia-driver-610-open linux-modules-nvidia-610-open-generic;touch\n"):
            with self.subTest(packages=packages), self.assertRaises(ValueError):
                self.make_plan(packages=packages)


if __name__ == "__main__":
    unittest.main()
