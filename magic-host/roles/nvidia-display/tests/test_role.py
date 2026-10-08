from pathlib import Path
import importlib.util
import json
import contextlib
import fcntl
import io
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml


ROLE = Path(__file__).resolve().parents[1]
ROOT = ROLE.parents[2]
DETECTOR = ROLE / "files/detect.py"
SELECTOR = ROLE / "files/select-driver.py"
selection_spec = importlib.util.spec_from_file_location("nvidia_driver_selection", SELECTOR)
selection = importlib.util.module_from_spec(selection_spec)
selection_spec.loader.exec_module(selection)
readiness_spec = importlib.util.spec_from_file_location("nvidia_driver_readiness", ROLE / "files/driver_ready.py")
handoff = importlib.util.module_from_spec(readiness_spec)
readiness_spec.loader.exec_module(handoff)


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
            for task in self.inner if "content" in task.get("ansible.builtin.copy", {})
        }
        self.assertIn("options nvidia-drm modeset=1 fbdev=1", files["/etc/modprobe.d/90-magicstick-nvidia-display.conf"])
        self.assertIn("nvidia-drm", files["/etc/modules-load.d/90-magicstick-nvidia-display.conf"])
        self.assertIn("nvidia_display_driver_bindings.stdout", files["/etc/rancher/k3s/config.yaml.d/90-magicstick-nvidia-display.yaml"])
        self.assertIn("bootstrapConfig", files["/etc/rancher/k3s/config.yaml.d/90-magicstick-nvidia-display.yaml"])

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
        self.assertIn("ExecCondition=/usr/bin/python3 /usr/local/lib/magicstick/nvidia-display/driver_ready.py --ready", content)
        self.assertIn("After=systemd-modules-load.service", content)
        install = next(task for task in self.inner if task.get("register") == "nvidia_display_packages")
        reload_guard = next(task for task in self.inner if task.get("name") == "Load the persistence guard before NVIDIA package post-install services run")
        helper = next(task for task in self.inner if task.get("name") == "Install the sysfs-only NVIDIA readiness and first-boot handoff helper")
        self.assertLess(self.inner.index(helper), self.inner.index(override))
        self.assertLess(self.inner.index(override), self.inner.index(reload_guard))
        self.assertLess(self.inner.index(reload_guard), self.inner.index(install))

        enabled = next(task for task in self.inner if task.get("name") == "Enable NVIDIA persistence daemon across host reboots")
        self.assertEqual(enabled["ansible.builtin.systemd_service"]["name"], "nvidia-persistenced.service")
        self.assertTrue(enabled["ansible.builtin.systemd_service"]["enabled"])

        probe = next(task for task in self.inner if task.get("name") == "Check whether the NVIDIA driver is already usable before starting persistence")
        self.assertEqual(probe["ansible.builtin.command"]["argv"], ["/usr/bin/nvidia-smi", "-L"])
        self.assertFalse(probe["failed_when"])
        self.assertEqual(probe["when"], "nvidia_display_driver_ready | bool")
        start = next(task for task in self.inner if task.get("name") == "Start NVIDIA persistence daemon when the driver is usable")
        self.assertIn("nvidia_display_driver_ready | bool", start["when"])
        self.assertIn("nvidia_display_gpu_probe.rc | default(1) == 0", start["when"])
        self.assertEqual(start["ansible.builtin.systemd_service"]["state"], "started")
        self.assertLess(self.inner.index(enabled), self.inner.index(probe))
        self.assertLess(self.inner.index(probe), self.inner.index(start))

    def test_boot_policy_refreshes_initramfs_without_unloading_the_console(self):
        policy = next(task for task in self.inner if task.get("register") == "nvidia_display_nouveau_policy")
        self.assertEqual(policy["ansible.builtin.copy"]["dest"], "/etc/modprobe.d/90-magicstick-nouveau.conf")
        self.assertIn("blacklist nouveau", policy["ansible.builtin.copy"]["content"])
        refresh = next(task for task in self.inner if task.get("name") == "Refresh initramfs after preparing the complete NVIDIA boot configuration")
        self.assertEqual(refresh["ansible.builtin.command"]["argv"], ["/usr/sbin/update-initramfs", "-u"])
        self.assertIn("nvidia_display_nouveau_policy.changed", refresh["when"])
        drm = next(task for task in self.inner if task.get("register") == "nvidia_display_modprobe")
        self.assertLess(self.inner.index(drm), self.inner.index(refresh))
        self.assertNotIn("modprobe -r", (ROLE / "tasks/main.yml").read_text())
        bindings = next(task for task in self.inner if task.get("register") == "nvidia_display_driver_bindings")
        self.assertIn("driver_ready.py --status", bindings["ansible.builtin.script"]["cmd"])
        self.assertIn("nvidia_display_new_install.stat.exists", bindings["ansible.builtin.script"]["cmd"])

    def test_fresh_unready_nodes_are_gated_but_existing_or_ready_nodes_are_not(self):
        policy = next(task for task in self.inner if task.get("register") == "nvidia_display_k3s_policy")
        self.assertIn("bootstrapConfig", policy["ansible.builtin.copy"]["content"])
        for new, ready, gated in ((True, False, True), (True, True, False), (False, False, False), (False, True, False)):
            with self.subTest(new=new, ready=ready):
                rendered = yaml.safe_load(handoff.bootstrap_config(new, ready))
                self.assertIn("nvidia.com/gpu.deploy.driver=false", rendered["node-label"])
                self.assertEqual("nvidia.com/gpu.deploy.operands=false" in rendered["node-label"], gated)

    def test_handoff_is_periodic_and_respects_existing_reboot_ownership(self):
        service = next(task for task in self.inner if task.get("name") == "Install the bounded NVIDIA first-boot release service")["ansible.builtin.copy"]["content"]
        timer = next(task for task in self.inner if task.get("name") == "Install the NVIDIA first-boot release timer")["ansible.builtin.copy"]["content"]
        self.assertIn("After=k3s.service systemd-modules-load.service", service)
        self.assertIn("--release --node", service)
        self.assertIn("TimeoutStartSec=45s", service)
        self.assertIn("OnUnitInactiveSec=30s", timer)
        k3s = yaml.safe_load((ROOT / "magic-host/roles/k3s/tasks/main.yml").read_text())
        gate = next(task for task in k3s if task.get("register") == "nvidia_display_startup_gate")
        self.assertIn("nvidia_display_new_install.stat.exists", gate["when"])
        self.assertIn("not nvidia_display_driver_ready | bool", gate["when"])
        self.assertIn("--arm", gate["ansible.builtin.command"]["argv"])
        self.assertNotIn("shutdown", service)

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

    def test_removing_the_bootstrap_gate_does_not_schedule_a_second_reboot(self):
        marker = next(task for task in self.inner if task.get("name") == "Mark a changed first installation for the host-managed reboot")
        condition = next(item for item in marker["when"] if "nvidia_display_packages.changed" in item)
        self.assertIn("(nvidia_display_k3s_policy.changed and not nvidia_display_driver_ready)", condition)
        self.assertNotIn("or nvidia_display_k3s_policy.changed", condition)

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


class NvidiaStartupHandoffTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ms-nv-", dir="/tmp")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.pci = self.root / "sys/bus/pci/devices"
        self.pci.mkdir(parents=True)
        self.node = {"metadata": {"name": "example-host-01", "uid": "fixture-node-uid", "resourceVersion": "17",
                                 "annotations": {handoff.GATE: handoff.PENDING, "example.com/retain": "yes"},
                                 "labels": {handoff.OPERANDS: "false", "nvidia.com/gpu.deploy.driver": "false"}}}
        self.calls = []

    def gpu(self, pci="0000:01:00.0", driver="nvidia", vendor="0x10de"):
        add_pci_device(self.root, pci, vendor, "0x030000")
        if driver:
            target = self.root / "sys/bus/pci/drivers" / driver
            target.mkdir(parents=True, exist_ok=True)
            (self.pci / pci / "driver").symlink_to(target, target_is_directory=True)

    def invoke(self, argv):
        self.calls.append(argv)
        if "get" in argv:
            return json.dumps(self.node)
        return ""

    def persistence_socket(self):
        path = self.root / "run/nvidia-persistenced/socket"
        path.parent.mkdir(parents=True)
        connection = socket.socket(socket.AF_UNIX)
        self.addCleanup(connection.close)
        connection.bind(str(path))

    def test_nouveau_and_unbound_gpus_defer_all_probes_and_writes(self):
        self.gpu(driver="nouveau")
        self.gpu("0000:02:00.0", driver=None)
        state = handoff.release_gate("example-host-01", self.invoke, self.root)
        self.assertEqual(state["state"], handoff.PENDING)
        self.assertFalse(state["changed"])
        self.assertEqual(self.calls, [])
        with patch.object(handoff.subprocess, "run", side_effect=AssertionError("driver probe")):
            self.assertFalse(handoff.readiness(self.root)["ready"])

    def test_every_nvidia_gpu_must_be_bound_and_amd_is_independent(self):
        self.gpu()
        self.gpu("0000:02:00.0", vendor="0x1002", driver="amdgpu")
        self.assertTrue(handoff.readiness(self.root)["ready"])
        self.gpu("0000:03:00.0", driver="nouveau")
        self.assertFalse(handoff.readiness(self.root)["ready"])

    def test_incomplete_inventory_never_reports_ready(self):
        self.gpu()
        (self.pci / "0000:01:00.0/class").write_text("broken")
        self.assertFalse(handoff.readiness(self.root)["ready"])
        self.assertFalse(handoff.readiness(self.root)["inventoryComplete"])

    def test_cpu_only_and_non_pci_hosts_never_release_a_gpu_gate(self):
        self.assertFalse(handoff.readiness(self.root)["ready"])
        self.pci.rmdir()
        self.assertFalse(handoff.readiness(self.root)["ready"])

    def test_arm_is_idempotent_and_uid_version_bound(self):
        self.assertFalse(handoff.arm_gate("example-host-01", self.invoke)["changed"])
        self.node["metadata"]["annotations"].pop(handoff.GATE)
        self.assertTrue(handoff.arm_gate("example-host-01", self.invoke)["changed"])
        patch_ops = json.loads(self.calls[-1][-1])
        self.assertEqual(patch_ops[:2], [
            {"op": "test", "path": "/metadata/uid", "value": "fixture-node-uid"},
            {"op": "test", "path": "/metadata/resourceVersion", "value": "17"},
        ])
        self.assertNotIn("example.com/retain", json.dumps(patch_ops))

    def test_arm_handles_absent_maps_without_replacing_other_metadata(self):
        self.node["metadata"].pop("annotations")
        self.node["metadata"].pop("labels")
        handoff.arm_gate("example-host-01", self.invoke)
        operations = json.loads(self.calls[-1][-1])
        self.assertIn({"op": "add", "path": "/metadata/annotations", "value": {}}, operations)
        self.assertIn({"op": "add", "path": "/metadata/labels", "value": {}}, operations)

    def test_healthy_post_boot_releases_only_the_owned_gate(self):
        self.gpu()
        self.persistence_socket()
        result = handoff.release_gate("example-host-01", self.invoke, self.root)
        self.assertEqual(result["state"], "ready")
        self.assertTrue(result["changed"])
        self.assertEqual(self.calls[1], ["/usr/bin/nvidia-smi", "-L"])
        self.assertEqual(self.calls[2], ["/usr/bin/systemctl", "start", "nvidia-persistenced.service"])
        operations = json.loads(self.calls[-1][-1])
        self.assertIn({"op": "test", "path": "/metadata/labels/nvidia.com~1gpu.deploy.operands", "value": "false"}, operations)
        self.assertIn({"op": "replace", "path": "/metadata/labels/nvidia.com~1gpu.deploy.operands", "value": "true"}, operations)
        self.assertIn({"op": "remove", "path": "/metadata/annotations/appliance.magicstick.dev~1nvidia-startup-gate"}, operations)
        self.assertIn({"op": "add", "path": "/metadata/labels/nvidia.com~1gpu.deploy.driver", "value": "false"}, operations)

    def test_operator_removed_driver_label_is_restored_in_the_release_patch(self):
        self.gpu()
        self.persistence_socket()
        self.node["metadata"]["labels"].pop(handoff.DRIVER)
        handoff.release_gate("example-host-01", self.invoke, self.root)
        operations = json.loads(self.calls[-1][-1])
        restore = {"op": "add", "path": "/metadata/labels/nvidia.com~1gpu.deploy.driver", "value": "false"}
        release = {"op": "replace", "path": "/metadata/labels/nvidia.com~1gpu.deploy.operands", "value": "true"}
        self.assertLess(operations.index(restore), operations.index(release))
        self.assertEqual(sum("patch" in call for call in self.calls), 1)

    def test_manually_disabled_or_foreign_gates_are_not_enabled(self):
        self.gpu()
        for annotation in (None, "other-owner"):
            with self.subTest(annotation=annotation):
                self.calls.clear()
                self.node["metadata"]["annotations"][handoff.GATE] = annotation
                self.assertEqual(handoff.release_gate("example-host-01", self.invoke, self.root)["state"], "unmanaged")
                self.assertEqual(len(self.calls), 1)

    def test_modified_owned_gate_is_not_overwritten(self):
        self.gpu()
        self.node["metadata"]["labels"][handoff.OPERANDS] = "true"
        with self.assertRaises(ValueError):
            handoff.release_gate("example-host-01", self.invoke, self.root)
        self.assertEqual(len(self.calls), 1)

    def test_health_failure_and_missing_socket_keep_gate_closed(self):
        self.gpu()
        with self.assertRaisesRegex(ValueError, "socket"):
            handoff.release_gate("example-host-01", self.invoke, self.root)
        self.assertFalse(any("patch" in call for call in self.calls))
        self.calls.clear()
        def failing(argv):
            if argv[0] == "/usr/bin/nvidia-smi":
                raise subprocess.CalledProcessError(1, argv)
            return self.invoke(argv)
        with self.assertRaises(subprocess.CalledProcessError):
            handoff.release_gate("example-host-01", failing, self.root)
        self.assertFalse(any("patch" in call for call in self.calls))

    def test_concurrent_patch_failure_does_not_retry_by_overwriting(self):
        self.gpu()
        self.persistence_socket()
        def conflicting(argv):
            if "patch" in argv:
                raise subprocess.CalledProcessError(1, argv)
            return self.invoke(argv)
        with self.assertRaises(subprocess.CalledProcessError):
            handoff.release_gate("example-host-01", conflicting, self.root)
        self.assertEqual(self.node["metadata"]["labels"][handoff.OPERANDS], "false")

    def test_timer_defers_during_maintenance_and_a_scheduled_restart(self):
        lock = self.root / "maintenance.lock"
        shutdown = self.root / "scheduled"
        with patch.object(handoff, "LOCK", lock), patch.object(handoff, "SHUTDOWN", shutdown), \
             patch.object(handoff.os, "geteuid", return_value=0), \
             patch.object(sys, "argv", ["driver_ready.py", "--release", "--node", "example-host-01"]), \
             patch.object(handoff, "release_gate", side_effect=AssertionError("must defer")):
            with lock.open("w") as owner:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(handoff.main(), 0)
                self.assertEqual(json.loads(output.getvalue())["state"], "maintenance-active")
            shutdown.touch()
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(handoff.main(), 0)
            self.assertEqual(json.loads(output.getvalue())["state"], "reboot-pending")

    def test_ready_cli_skips_nouveau_without_loading_a_driver(self):
        self.gpu(driver="nouveau")
        result = subprocess.run([sys.executable, str(ROLE / "files/driver_ready.py"), "--ready", "--root", str(self.root)],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")


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
