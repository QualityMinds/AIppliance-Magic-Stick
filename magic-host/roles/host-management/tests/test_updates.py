from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "files"))
import host_updates as updates
import updates_contract as contract
import host_worker
from test_host_management import node, operation, report


class ContractTests(unittest.TestCase):
    def test_defaults_are_security_with_no_automatic_reboot(self):
        self.assertEqual(contract.validate_policy(contract.DEFAULT_POLICY),
                         {"mode": "security", "windowStart": "03:00", "windowMinutes": 120, "automaticReboot": False})

    def test_rejects_unbounded_or_wrong_types(self):
        for key, value in (("mode", "dist-upgrade"), ("mode", []), ("windowStart", "25:10"),
                           ("windowStart", "03:00; reboot"), ("windowMinutes", 361), ("windowMinutes", True),
                           ("windowMinutes", 1), ("automaticReboot", "true")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                contract.validate_policy({**contract.DEFAULT_POLICY, key: value})
        with self.assertRaises(ValueError):
            contract.validate_policy({**contract.DEFAULT_POLICY, "packages": ["anything"]})

    def test_request_requires_fresh_policy_and_bounded_action_fields(self):
        capability = {"supported": True, "busy": False, "id": contract.policy_id(contract.DEFAULT_POLICY)}
        payload = {"planId": capability["id"], "updateScope": "security"}
        contract.validate_update_request("install-updates", payload, capability)
        for change in ({"planId": "b" * 64}, {"updateScope": []}, {"updateScope": "dist-upgrade"},
                       {"allowExperimental": True}, {"updatePolicy": contract.DEFAULT_POLICY}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                contract.validate_update_request("install-updates", {**payload, **change}, capability)
        for capability_change in ({"supported": False}, {"busy": True}):
            with self.assertRaises(ValueError):
                contract.validate_update_request("install-updates", payload, {**capability, **capability_change})
        with self.assertRaises(ValueError):
            contract.validate_update_request("check-updates", payload, capability)

    def test_protects_hardware_packages_not_regular_userland(self):
        for name in ("linux-generic", "linux-image-7.0.0-31-generic", "linux-firmware", "firmware-amd-graphics",
                     "nvidia-driver-595", "libnvidia-compute-595", "amdgpu-dkms", "rocm-core", "librocblas0",
                     "hip-runtime-amd", "miopen-hip", "libdrm2", "libgl1-mesa-dri", "mesa-vulkan-drivers",
                     "intel-opencl-icd", "libigc2", "intel-microcode", "dkms"):
            with self.subTest(name=name): self.assertTrue(contract.protected(name))
        for name in ("openssl", "libssl3t64", "openssh-server", "systemd", "curl"):
            with self.subTest(name=name): self.assertFalse(contract.protected(name))

    def test_origin_config_never_enables_third_party_or_release_upgrade(self):
        security = updates.apt_config("security")
        self.assertIn('#clear Unattended-Upgrade::Origins-Pattern;', security)
        self.assertIn('${distro_codename}-security', security)
        self.assertNotIn('${distro_codename}-updates', security)
        self.assertIn('${distro_codename}-updates', updates.apt_config("all"))
        self.assertIn('Automatic-Reboot "false"', security)
        self.assertNotIn('trusted=yes', security)

    def test_windows_cross_midnight_and_end_is_exclusive(self):
        value = {**contract.DEFAULT_POLICY, "windowStart": "23:30", "windowMinutes": 120}
        for hour, minute, inside in ((23, 29, False), (23, 30, True), (0, 30, True), (1, 29, True), (1, 30, False)):
            with self.subTest(hour=hour, minute=minute):
                self.assertEqual(updates.window(value, datetime(2026, 9, 11, hour, minute, tzinfo=timezone.utc))[1], inside)


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ("STATE", "POLICY", "STATUS", "APT_CONFIG", "PERIODIC_CONFIG", "TIMER_CONFIG", "REBOOT_REQUIRED", "SHUTDOWN_SCHEDULED", "CLOUD_INSTANCE"):
            target = self.root if name == "STATE" else self.root / name
            self.patch(name, target)
        self.patch("os_release", return_value={"ID": "ubuntu", "VERSION_ID": "26.04", "VERSION_CODENAME": "resolute"})
        self.patch("boot_id", return_value="boot-a")
        self.patch("process_start", return_value="123")
        self.command = self.patch("command")
        self.packages = self.patch("packages", return_value={"pendingCount": 3, "securityCount": 2, "blockedCount": 1,
                                                           "packages": [], "checkedAt": "2026-09-11T03:05:00Z"})
        self.clock = self.patch("datetime")
        self.clock.now.return_value = datetime(2026, 9, 11, 3, 5, tzinfo=timezone.utc)
        updates.configure(contract.DEFAULT_POLICY)
        self.command.reset_mock()

    def patch(self, name, *args, **kwargs):
        patcher = patch.object(updates, name, *args, **kwargs)
        result = patcher.start(); self.addCleanup(patcher.stop)
        return result

    def run_main(self, action="automatic"):
        with patch.object(sys, "argv", ["host_updates.py", action]), patch.object(updates.os, "geteuid", return_value=0):
            updates.main()

    def state(self):
        return json.loads(updates.STATUS.read_text())

    def commands(self):
        return [call.args[0][0] for call in self.command.call_args_list]

    def test_configure_preserves_saved_policy_and_avoids_repeated_timer_restart(self):
        value = {**contract.DEFAULT_POLICY, "mode": "all", "windowStart": "22:10"}
        updates.configure(value)
        self.command.reset_mock()
        updates.configure(updates.policy())
        self.assertEqual(updates.policy(), value)
        self.assertNotIn(["/usr/bin/systemctl", "restart", "apt-daily-upgrade.timer"],
                         [call.args[0] for call in self.command.call_args_list])
        self.assertIn("22:10:00 UTC", updates.TIMER_CONFIG.read_text())
        self.assertIn("Persistent=false", updates.TIMER_CONFIG.read_text())

    def test_configure_failure_restores_policy_and_files(self):
        before = updates.TIMER_CONFIG.read_text()
        self.command.side_effect = subprocess.CalledProcessError(1, "systemctl")
        with self.assertRaises(subprocess.CalledProcessError):
            updates.configure({**contract.DEFAULT_POLICY, "windowStart": "12:10"})
        self.assertEqual(updates.policy(), contract.DEFAULT_POLICY)
        self.assertEqual(updates.TIMER_CONFIG.read_text(), before)

    def test_automatic_security_execution_is_once_per_window(self):
        self.run_main(); self.run_main()
        self.assertEqual(self.commands(), ["/usr/bin/apt-get", "/usr/bin/unattended-upgrade"])
        self.assertEqual(self.state()["phase"], "Succeeded")
        self.assertIn("lastSuccessAt", self.state())
        self.assertNotIn("shutdown", str(self.command.call_args_list))

    def test_manual_mode_checks_but_does_not_install_or_reboot(self):
        updates.configure({**contract.DEFAULT_POLICY, "mode": "manual", "automaticReboot": True})
        updates.REBOOT_REQUIRED.touch(); self.command.reset_mock()
        self.run_main()
        self.assertEqual(self.commands(), ["/usr/bin/apt-get"])
        self.assertNotIn("lastSuccessAt", self.state())

    def test_no_update_outside_window_during_cloud_init_or_shutdown(self):
        self.clock.now.return_value = datetime(2026, 9, 11, 13, tzinfo=timezone.utc)
        self.run_main(); self.command.assert_not_called()
        self.clock.now.return_value = datetime(2026, 9, 11, 3, 5, tzinfo=timezone.utc)
        updates.CLOUD_INSTANCE.mkdir(); self.run_main(); self.command.assert_not_called()
        (updates.CLOUD_INSTANCE / "boot-finished").touch()
        updates.SHUTDOWN_SCHEDULED.touch(); self.run_main(); self.command.assert_not_called()

    def test_maintenance_lock_is_shared_and_not_removed(self):
        with (self.root / "maintenance.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.run_main()
        self.command.assert_not_called()
        self.assertTrue((self.root / "maintenance.lock").exists())

    def test_active_hardware_or_network_operation_blocks_auto_updates(self):
        updates.write(self.root / "state.json", json.dumps({"current": {"phase": "AwaitingConfirmation"}}))
        self.run_main(); self.command.assert_not_called()

    def test_slow_package_check_cannot_start_installation_outside_window(self):
        # Execute directly: stamp, windowAttempt, checkedAt is mocked, then pre-install check.
        self.clock.now.side_effect = [datetime(2026, 9, 11, 3, 5, tzinfo=timezone.utc),
                                      datetime(2026, 9, 11, 3, 5, tzinfo=timezone.utc),
                                      datetime(2026, 9, 11, 5, 5, tzinfo=timezone.utc)]
        updates.execute("security", automatic=True)
        self.assertEqual(self.commands(), ["/usr/bin/apt-get"])
        self.assertIn("deferred", self.state()["message"])

    def test_failed_install_is_not_replayed_and_restores_scope(self):
        self.command.side_effect = [None, subprocess.CalledProcessError(1, "unattended-upgrade")]
        with self.assertRaises(subprocess.CalledProcessError): updates.execute("all", automatic=True)
        self.assertEqual(self.state()["phase"], "Failed")
        self.assertNotIn("lastSuccessAt", self.state())
        self.assertNotIn("${distro_codename}-updates", updates.APT_CONFIG.read_text())
        self.command.reset_mock(); self.run_main(); self.command.assert_not_called()

    def test_reboot_is_opt_in_automatic_only_and_bounded(self):
        updates.configure({**contract.DEFAULT_POLICY, "automaticReboot": True})
        updates.REBOOT_REQUIRED.touch(); self.command.reset_mock()
        updates.execute("security", request_id="manual")
        self.assertNotIn("/usr/sbin/shutdown", self.commands())
        updates.execute("security", automatic=True)
        self.assertEqual(self.commands().count("/usr/sbin/shutdown"), 1)
        updates.execute("security", automatic=True)
        self.assertEqual(self.commands().count("/usr/sbin/shutdown"), 1)

    def test_reboot_cannot_be_scheduled_past_window_end(self):
        updates.configure({**contract.DEFAULT_POLICY, "automaticReboot": True})
        updates.REBOOT_REQUIRED.touch(); self.command.reset_mock()
        self.clock.now.return_value = datetime(2026, 9, 11, 4, 59, 30, tzinfo=timezone.utc)
        updates.execute("security", automatic=True)
        self.assertNotIn("/usr/sbin/shutdown", self.commands())

    def test_stale_running_process_is_reported_interrupted(self):
        updates.save({"phase": "Running", "pid": 999, "processStart": "different", "bootId": "boot-a"})
        self.assertFalse(updates.status()["busy"])
        self.assertEqual(updates.status()["phase"], "Interrupted")

    def test_approved_manual_operation_rechecks_identity_age_and_no_replay(self):
        request = {"action": "check-updates", "scope": "security", "requestId": "a" * 32,
                   "operationUid": "op-1", "approvedAt": time.time()}
        updates.write(self.root / "approved-updates.json", json.dumps(request))
        updates.write(self.root / "state.json", json.dumps({"current": {"requestId": request["requestId"],
                      "operationUid": "op-1", "phase": "Applying", "initialBootId": "boot-a"}}))
        self.run_main("requested"); self.run_main("requested")
        self.assertEqual(self.commands(), ["/usr/bin/apt-get"])
        self.assertEqual(self.state()["requestId"], request["requestId"])
        self.command.reset_mock()
        updates.write(self.root / "approved-updates.json", json.dumps({**request, "approvedAt": time.time() - 301}))
        with self.assertRaises(RuntimeError): self.run_main("requested")
        self.command.assert_not_called()


class PackageTests(unittest.TestCase):
    def test_classifies_ubuntu_security_hardware_holds_and_external_candidates(self):
        def version(number, origin="Ubuntu", archive="resolute-security"):
            return SimpleNamespace(version=number, origins=[SimpleNamespace(origin=origin, archive=archive)])
        def package(name, candidate, versions=None, held=False):
            return SimpleNamespace(name=name, is_installed=True, candidate=candidate, installed=version("1"),
                                   versions=versions or [candidate], _pkg=SimpleNamespace(selected_state=2 if held else 1))
        values = [package("openssl", version("2")), package("linux-generic", version("2")),
                  package("curl", version("2", archive="resolute-updates"), held=True),
                  package("third-party", version("3", "Vendor"), versions=[version("3", "Vendor"), version("2")]),
                  package("external-only", version("2", "Vendor")), package("unchanged", version("1"))]
        modules = {"apt": SimpleNamespace(Cache=lambda: values), "apt_pkg": SimpleNamespace(SELSTATE_HOLD=2, version_compare=lambda a, b: int(a) - int(b))}
        with patch.dict(sys.modules, modules), patch.object(updates, "os_release", return_value={"VERSION_CODENAME": "resolute"}):
            result = updates.packages()
        self.assertEqual(result["pendingCount"], 4)
        self.assertEqual(result["securityCount"], 3)
        self.assertEqual(result["blockedCount"], 3)
        self.assertEqual({p["name"]: p["blocked"] for p in result["packages"]},
                         {"openssl": "", "linux-generic": "Hardware preparation", "curl": "Package hold", "third-party": "External package candidate"})


class WorkerTests(unittest.TestCase):
    def test_queued_update_uses_existing_worker_and_fixed_service_then_reports_completion(self):
        capability = {"supported": True, "id": contract.policy_id(contract.DEFAULT_POLICY)}
        request = operation({}, "install-updates", planId=capability["id"], updateScope="security")
        with tempfile.TemporaryDirectory() as directory, patch.object(host_worker, "kube"), patch.object(host_worker, "run") as run, patch.object(updates, "status", return_value=capability):
            worker = host_worker.Worker(node(), report(), {}, state_dir=Path(directory), updates=capability)
            worker.reconcile(request)
            self.assertEqual(worker.state["current"]["phase"], "Applying")
            run.assert_called_once_with(["/usr/bin/systemctl", "start", "--no-block", "magicstick-host-updates.service"])
            queued = json.loads((Path(directory) / "approved-updates.json").read_text())
            self.assertEqual(queued["operationUid"], request["metadata"]["uid"])
            with patch.object(updates, "status", return_value={**capability, "requestId": request["spec"]["requestId"], "phase": "Succeeded", "message": "Done"}):
                worker.reconcile(request)
            self.assertEqual(worker.state["current"]["phase"], "Succeeded")
            self.assertEqual(run.call_count, 1)

    def test_configuration_failure_is_terminal_not_automatic_retry(self):
        capability = {"supported": True, "id": contract.policy_id(contract.DEFAULT_POLICY)}
        request = operation({}, "configure-updates", planId=capability["id"], updatePolicy=contract.DEFAULT_POLICY)
        with tempfile.TemporaryDirectory() as directory, patch.object(host_worker, "kube"), patch.object(updates, "status", return_value=capability), patch.object(updates, "configure", side_effect=subprocess.CalledProcessError(1, "systemctl")) as configure:
            worker = host_worker.Worker(node(), report(), {}, state_dir=Path(directory), updates=capability)
            worker.reconcile(request); worker.reconcile(request)
            self.assertEqual(worker.state["current"]["phase"], "Failed")
            configure.assert_called_once()


if __name__ == "__main__":
    unittest.main()
