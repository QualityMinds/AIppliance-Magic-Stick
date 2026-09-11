import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROLE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROLE / "files"))
import gpu_memory as memory
import host_plan
import host_worker

OPTIONS = "0: Minimum (512 MB)\n1:  (1 GB)\n2: Medium (16 GB)\n3: High (32 GB)\n"
ADDRESS = "0000:01:00.0"


def evidence(boot="boot-a", reserved=32768, total=64000, dynamic=32768):
    return {"bootId": boot, "os": {"id": "ubuntu", "versionId": "24.04"},
            "kernel": {"release": "7.0.0-1-generic", "strixHaloFixes": "present"}, "hardwareFingerprint": "f" * 64,
            "systemMemory": {"totalBytes": total * memory.MIB, "pageSizeBytes": 4096, "ttmLimitBytes": dynamic * memory.MIB},
            "devices": [{"pciAddress": ADDRESS, "vendorId": "1002", "deviceId": "1586", "driver": "amdgpu", "memory": {"vramTotalBytes": reserved * memory.MIB}}]}


def capability(boot="boot-a", reserved=32768, index=3, total=64000, dynamic=32768):
    return {"id": "b" * 64, "supported": True, "message": "fixture", "pciAddress": ADDRESS,
            "systemMemoryMi": total, "currentCarveoutMi": reserved, "currentCarveoutIndex": index,
            "currentDynamicLimitMi": dynamic, "options": memory.parse_options(OPTIONS),
            "systemReserveMi": 16384, "stepMi": 1024, "minDynamicLimitMi": 1024}


def node():
    return {"metadata": {"name": "example-node", "uid": "example-uid"}}


def request(index=0, dynamic=65536):
    return {"metadata": {"name": "example-operation", "uid": "example-operation-uid", "creationTimestamp": host_worker.stamp()},
            "spec": {"action": "configure-gpu-memory", "nodeName": "example-node", "nodeUid": "example-uid", "bootId": "boot-a",
                     "requestId": "a" * 32, "actorHash": "c" * 64, "planId": "b" * 64, "allowExperimental": True,
                     "experimentMode": False, "acknowledgeDisruption": True, "gpuMemory": {"carveoutIndex": index, "dynamicLimitMi": dynamic}}}


class MemoryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / "sys/bus/pci/devices" / ADDRESS
        self.put(self.base / "uma/carveout_options", OPTIONS)
        self.put(self.base / "uma/carveout", "3\n")
        self.put(self.root / "sys/module/ttm/parameters/pages_limit", "8388608")
        self.put(self.root / "sys/module/amdgpu/parameters/gttsize", "-1")
        for filename, value in (("vendor", "0x1002"), ("device", "0x1586"), ("class", "0x030000")):
            self.put(self.base / filename, value)
        self.bind(self.base, "amdgpu")

    @staticmethod
    def put(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def bind(self, base, driver):
        target = self.root / "sys/bus/pci/drivers" / driver
        target.mkdir(parents=True, exist_ok=True)
        (base / "driver").unlink(missing_ok=True)
        (base / "driver").symlink_to(target, target_is_directory=True)

    def add_gpu(self, pci_id="10de:2684", driver="nvidia", address="0000:02:00.0"):
        base = self.root / "sys/bus/pci/devices" / address
        vendor, device = pci_id.split(":")
        for filename, value in (("vendor", "0x" + vendor), ("device", "0x" + device), ("class", "0x030200")):
            self.put(base / filename, value)
        self.bind(base, driver)
        return base

    def collect(self, report=None, devices=None):
        return memory.collect(report or evidence(), devices if devices is not None else ["1002:1586"], self.root)

    def test_firmware_options_are_runtime_authoritative_and_capacity_is_os_visible(self):
        value = self.collect()
        self.assertTrue(value["supported"])
        self.assertEqual(value["options"][0], {"index": 0, "label": "Minimum (512 MB)", "sizeMi": 512})
        self.assertEqual(value["currentCarveoutMi"], 32768)
        self.assertEqual(value["systemMemoryMi"], 64000)
        self.assertEqual(len(value["id"]), 64)

    def test_ubuntu_2604_retains_evidence_based_shared_memory_controls(self):
        report = evidence()
        report["os"]["versionId"] = "26.04"
        self.assertTrue(self.collect(report)["supported"])
        report["kernel"]["strixHaloFixes"] = "unknown"
        self.assertFalse(self.collect(report)["supported"])
        report["kernel"]["strixHaloFixes"] = "present"
        report["os"]["versionId"] = "99.04"
        self.assertFalse(self.collect(report)["supported"])

    def test_duplicate_unknown_empty_firmware_options_fail_closed(self):
        for bad in ("", "0: Auto (half RAM)", "0: (1 GB)\n0: (2 GB)", "0: (1 GB)\n1: (1024 MB)", "256: (1 GB)", "0: (0 GB)"):
            with self.subTest(bad=bad):
                self.put(self.base / "uma/carveout_options", bad)
                self.assertFalse(self.collect()["supported"])

    def test_unknown_or_missing_inventory_is_not_configurable(self):
        for devices in ([], ["1002:9999"], ["1002:1586", "10de:1234"], ["1002:1586", "1002:1586"]):
            self.assertFalse(self.collect(devices=devices)["supported"])
        self.assertFalse(memory.collect(evidence(), None, self.root)["supported"])

    def test_strix_halo_with_nvidia_preserves_amd_options_and_limits(self):
        original = self.collect()
        self.add_gpu()
        for version in ("24.04", "26.04"):
            for devices in (["1002:1586", "10de:2684"], ["10de:2684", "1002:1586"]):
                with self.subTest(version=version, devices=devices):
                    report = evidence(); report["os"]["versionId"] = version
                    value = self.collect(report, devices)
                    self.assertTrue(value["supported"], value["message"])
                    for key in ("pciAddress", "options", "currentCarveoutMi", "systemMemoryMi", "currentDynamicLimitMi", "systemReserveMi"):
                        self.assertEqual(value[key], original[key])
                    self.assertNotEqual(value["pciIdentity"], original["pciIdentity"])
                    self.assertNotEqual(value["id"], original["id"])
                    self.assertEqual(memory.validate_selection(value, {"carveoutIndex": 0, "dynamicLimitMi": 65536})["pciAddress"], ADDRESS)
        self.add_gpu(address="0000:03:00.0")
        self.assertTrue(self.collect(devices=["10de:2684", "1002:1586", "10de:2684"])["supported"])

    def test_other_ttm_consumers_unknown_drivers_and_multi_amd_remain_blocked(self):
        for pci_id, driver in (("10de:2684", "nouveau"), ("10de:2684", "vfio-pci"),
                               ("1002:1586", "amdgpu"), ("1002:9999", "amdgpu"), ("8086:1234", "xe")):
            with self.subTest(pci_id=pci_id, driver=driver):
                self.add_gpu(pci_id=pci_id, driver=driver)
                self.assertFalse(self.collect(devices=["1002:1586", pci_id])["supported"])

    def test_mixed_inventory_requires_consistent_local_binding_and_amd_evidence(self):
        companion = self.add_gpu()
        devices = ["1002:1586", "10de:2684"]
        self.assertFalse(self.collect(devices=["1002:1586"])["supported"])
        for key, value in (("pciAddress", "0000:02:00.0"), ("vendorId", "10de"), ("driver", "nouveau")):
            report = evidence(); report["devices"][0][key] = value
            self.assertFalse(self.collect(report, devices)["supported"])
        (companion / "driver").unlink()
        self.assertFalse(self.collect(devices=devices)["supported"])
        self.bind(companion, "nvidia")
        (companion / "class").unlink()
        self.assertFalse(self.collect(devices=devices)["supported"])

    def test_mixed_host_keeps_kernel_firmware_and_override_safety_checks(self):
        self.add_gpu()
        devices = ["1002:1586", "10de:2684"]
        report = evidence(); report["kernel"]["strixHaloFixes"] = "unknown"
        self.assertFalse(self.collect(report, devices)["supported"])
        self.put(self.base / "uma/carveout", "0")
        self.assertFalse(self.collect(devices=devices)["supported"])
        self.put(self.base / "uma/carveout", "3")
        self.put(self.root / "etc/modprobe.d/foreign.conf", "options ttm pages_limit=123")
        self.assertFalse(self.collect(devices=devices)["supported"])

    def test_pending_uma_reservation_must_match_active_vram(self):
        self.put(self.base / "uma/carveout", "0")
        value = self.collect()
        self.assertFalse(value["supported"])
        self.assertIn("pending firmware", value["message"])

    def test_missing_unsupported_or_inconsistent_memory_evidence_blocks(self):
        for key, value in (("totalBytes", None), ("totalBytes", True), ("pageSizeBytes", 65536), ("ttmLimitBytes", None)):
            report = evidence(); report["systemMemory"][key] = value
            self.assertFalse(self.collect(report)["supported"])
        self.put(self.base / "uma/carveout", "999")
        self.assertFalse(self.collect()["supported"])

    def test_foreign_modprobe_and_kernel_boot_overrides_block(self):
        paths = ("etc/modprobe.d/foreign.conf", "usr/lib/modprobe.d/foreign.conf", "run/modprobe.d/foreign.conf",
                 "proc/cmdline", "etc/default/grub", "etc/default/grub.d/gpu.cfg")
        for path in paths:
            entry = self.root / path
            self.put(entry, "options ttm pages_limit=123" if "modprobe" in path else 'GRUB_CMDLINE_LINUX="ttm.pages_limit=123"')
            self.assertFalse(self.collect()["supported"], path)
            entry.unlink()

    def test_owned_override_is_allowed_only_if_exact_and_active(self):
        entry = self.root / memory.MANAGED_CONFIG.lstrip("/")
        self.put(entry, "# Managed override\noptions ttm pages_limit=8388608\n")
        self.assertTrue(self.collect()["supported"])
        self.put(entry, "options ttm pages_limit=123\n")
        self.assertFalse(self.collect()["supported"])
        self.put(entry, "options ttm pages_limit=8388608 extra=1\n")
        self.assertFalse(self.collect()["supported"])

    def test_out_of_tree_module_or_runtime_override_does_not_receive_inbox_config(self):
        self.put(self.root / "sys/module/amdgpu/parameters/gttsize", "8192")
        self.assertFalse(self.collect()["supported"])
        self.put(self.root / "sys/module/amdgpu/parameters/gttsize", "-1")
        (self.root / "sys/module/amdttm").mkdir()
        self.assertFalse(self.collect()["supported"])

    def test_capability_identity_changes_with_boot_options_configuration_and_memory(self):
        initial = self.collect()["id"]
        self.assertNotEqual(self.collect(evidence(boot="boot-b"))["id"], initial)
        self.assertNotEqual(self.collect(evidence(total=63900))["id"], initial)
        self.put(self.base / "uma/carveout_options", OPTIONS + "4: (48 GB)\n")
        self.assertNotEqual(self.collect()["id"], initial)

    def test_bounded_firmware_write_rechecks_options_and_identity(self):
        memory.write_carveout(ADDRESS, 0, self.root)
        self.assertEqual((self.base / "uma/carveout").read_text(), "0\n")
        for address, index in (("../../elsewhere", 0), (ADDRESS, True), (ADDRESS, 99)):
            with self.assertRaises(ValueError):
                memory.write_carveout(address, index, self.root)
        self.put(self.base / "device", "0x9999")
        with self.assertRaises(ValueError):
            memory.write_carveout(ADDRESS, 1, self.root)


class MemoryRequestTests(unittest.TestCase):
    def test_projected_preview_can_exceed_current_ram_before_reclaim(self):
        value = memory.validate_selection(capability(), {"carveoutIndex": 0, "dynamicLimitMi": 65536})
        self.assertGreater(value["dynamicLimitMi"], capability()["systemMemoryMi"])
        self.assertEqual(value["projectedSystemMemoryMi"], 96256)

    def test_unsafe_noninteger_unknown_and_noop_requests_are_rejected(self):
        for values in ({"carveoutIndex": True, "dynamicLimitMi": 1024}, {"carveoutIndex": 99, "dynamicLimitMi": 1024},
                       {"carveoutIndex": 0, "dynamicLimitMi": True}, {"carveoutIndex": 0, "dynamicLimitMi": 2000},
                       {"carveoutIndex": 0, "dynamicLimitMi": 999424}, {"carveoutIndex": 0, "dynamicLimitMi": 0},
                       {"carveoutIndex": 3, "dynamicLimitMi": 32768}, {"carveoutIndex": 0, "dynamicLimitMi": 1024, "path": "unsafe"}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                memory.validate_selection(capability(), values)

    def test_privilege_boundary_rechecks_identity_consent_and_allowed_action(self):
        for changes in ({"planId": "stale"}, {"bootId": "old"}, {"nodeUid": "other"}, {"allowExperimental": False},
                        {"experimentMode": True}, {"action": "reboot"}, {"command": "untrusted"}):
            value = request(); value["spec"].update(changes)
            with self.assertRaises(ValueError):
                host_plan.validate_request(value, node(), evidence(), {}, time.time(), capability())
        host_plan.validate_request(request(), node(), evidence(), {}, time.time(), capability())


class MemoryWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.report, self.memory = evidence(), capability()
        self.config = {"id": "initial", "conflicts": False, "managedPages": None}
        self.configuration = patch.object(memory, "configuration", side_effect=lambda: dict(self.config)).start()
        self.collect = patch.object(memory, "collect", side_effect=lambda *args: copy.deepcopy(self.memory)).start()
        patch.object(host_worker, "display_gpus", return_value=["1002:1586"]).start()
        self.write = patch.object(memory, "write_carveout").start()
        self.run = patch.object(host_worker, "run", side_effect=self.command).start()
        self.kube = patch.object(host_worker, "kube", return_value={}).start()
        self.addCleanup(patch.stopall)

    def command(self, args, **kwargs):
        if args[0] == "/usr/bin/ansible-playbook":
            variables = json.loads((self.root / "approved-memory-vars.json").read_text())
            self.config.update(id="managed", managedPages=variables["gpu_compatibility_ttm_limit_mib"] * 256)
        return "{}"

    def worker(self):
        return host_worker.Worker(node(), self.report, {}, self.root, memory=self.memory)

    def advance_boot(self, boot, reserved, index, total, dynamic):
        self.report = evidence(boot, reserved, total, dynamic)
        self.memory = capability(boot, reserved, index, total, dynamic)

    def shutdowns(self):
        return [call for call in self.run.call_args_list if call.args[0][0] == "/usr/sbin/shutdown"]

    def ansibles(self):
        return [call for call in self.run.call_args_list if call.args[0][0] == "/usr/bin/ansible-playbook"]

    def test_two_phase_uma_then_actual_capacity_then_ttm_and_two_reboots(self):
        operation = request()
        worker = self.worker(); worker.reconcile(operation)
        self.write.assert_called_once_with(ADDRESS, 0, expected_index=3, expected_options=self.memory["options"])
        self.assertEqual(len(self.shutdowns()), 1)
        self.assertEqual(len(self.ansibles()), 0)
        self.worker().reconcile(operation)
        self.assertEqual(len(self.shutdowns()), 1)
        self.advance_boot("boot-b", 512, 0, 96000, 48000)
        self.worker().reconcile(operation)  # durable verification boundary
        self.assertEqual(len(self.ansibles()), 0)
        self.worker().reconcile(operation)
        self.assertEqual(len(self.ansibles()), 1)
        self.assertEqual(len(self.shutdowns()), 2)
        variables = json.loads((self.root / "approved-memory-vars.json").read_text())
        self.assertEqual(variables["gpu_compatibility_package_versions"], {})
        self.assertFalse(variables["gpu_compatibility_update_cache"])
        self.assertEqual(variables["gpu_compatibility_initramfs_kernel"], self.report["kernel"]["release"])
        self.advance_boot("boot-c", 512, 0, 96000, 65536)
        self.worker().reconcile(operation)
        self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Succeeded")
        self.assertEqual(len(self.shutdowns()), 2)
        self.assertFalse(any("moduleactivations" in str(call) for call in self.kube.call_args_list))

    def test_ttm_only_uses_one_reboot_and_no_firmware_write(self):
        operation = request(index=3, dynamic=40960)
        self.worker().reconcile(operation)
        self.write.assert_not_called()
        self.assertEqual(len(self.ansibles()), 1)
        self.advance_boot("boot-b", 32768, 3, 64000, 40960)
        self.worker().reconcile(operation); self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Succeeded")
        self.assertEqual(len(self.shutdowns()), 1)

    def test_companion_gpu_change_during_reboot_prevents_more_memory_writes(self):
        self.memory["pciIdentity"] = "d" * 64
        operation = request()
        self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["memoryPciIdentity"], "d" * 64)
        self.advance_boot("boot-b", 512, 0, 96000, 48000)
        self.memory["pciIdentity"] = "e" * 64
        self.run.reset_mock()
        self.worker().reconcile(operation); self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Failed")
        self.run.assert_not_called()

    def test_uma_only_does_not_write_ttm_if_dynamic_is_already_exact(self):
        operation = request(index=0, dynamic=32768)
        self.worker().reconcile(operation)
        self.advance_boot("boot-b", 512, 0, 96000, 32768)
        self.worker().reconcile(operation); self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Succeeded")
        self.assertEqual(len(self.ansibles()), 0)
        self.assertEqual(len(self.shutdowns()), 1)

    def test_near_matching_dynamic_limit_is_not_treated_as_exact(self):
        operation = request(index=0, dynamic=32768)
        self.worker().reconcile(operation)
        self.advance_boot("boot-b", 512, 0, 96000, 32768)
        self.report["systemMemory"]["ttmLimitBytes"] += 4096
        self.worker().reconcile(operation); self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "RebootScheduled")
        self.assertEqual(len(self.ansibles()), 1)
        self.assertEqual(len(self.shutdowns()), 2)

    def test_actual_capacity_after_uma_is_authoritative_not_projection(self):
        operation = request()
        self.worker().reconcile(operation)
        self.advance_boot("boot-b", 512, 0, 70000, 35000)
        self.worker().reconcile(operation); self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Failed")
        self.assertEqual(len(self.ansibles()), 0)
        self.assertEqual(len(self.shutdowns()), 1)

    def test_wrong_reservation_kernel_options_or_conflicts_never_continue(self):
        for problem in ("carveout", "kernel", "options", "config", "mixed", "fingerprint", "os"):
            with self.subTest(problem=problem):
                (self.root / "state.json").unlink(missing_ok=True)
                self.config = {"id": "initial", "conflicts": False, "managedPages": None}
                self.report, self.memory = evidence(), capability()
                operation = request(); self.worker().reconcile(operation)
                self.advance_boot("boot-b", 512, 0, 96000, 48000)
                if problem == "carveout": self.memory["currentCarveoutIndex"] = 3
                elif problem == "kernel": self.report["kernel"]["release"] = "other-kernel"
                elif problem == "options": self.memory["options"] = []
                elif problem == "config": self.config["id"] = "foreign"
                elif problem == "fingerprint": self.report["hardwareFingerprint"] = "e" * 64
                elif problem == "os": self.report["os"]["versionId"] = "26.04"
                else: self.memory["supported"] = False
                self.run.reset_mock()
                self.worker().reconcile(operation); self.worker().reconcile(operation)
                self.assertEqual(self.worker().state["current"]["phase"], "Failed")
                self.run.assert_not_called()

    def test_interrupted_firmware_write_is_not_replayed_or_rebooted(self):
        self.write.side_effect = KeyboardInterrupt()
        operation = request()
        with self.assertRaises(KeyboardInterrupt): self.worker().reconcile(operation)
        self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Interrupted")
        self.assertEqual(self.write.call_count, 1)
        self.run.assert_not_called()

    def test_interrupted_ansible_is_not_replayed(self):
        self.run.side_effect = KeyboardInterrupt()
        operation = request(index=3, dynamic=40960)
        with self.assertRaises(KeyboardInterrupt): self.worker().reconcile(operation)
        self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Interrupted")
        self.assertEqual(self.run.call_count, 1)

    def test_api_acknowledgement_failure_prevents_firmware_write(self):
        self.kube.side_effect = RuntimeError("API unavailable")
        with self.assertRaises(RuntimeError): self.worker().reconcile(request())
        self.write.assert_not_called()
        self.run.assert_not_called()

    def test_stale_config_discovered_at_execution_prevents_all_writes(self):
        self.collect.side_effect = lambda *args: {**self.memory, "id": "changed-config"}
        worker = self.worker(); worker.reconcile(request())
        self.assertEqual(worker.state["current"]["phase"], "Failed")
        self.write.assert_not_called()
        self.run.assert_not_called()

    def test_request_mutation_and_replay_never_create_more_effects(self):
        operation = request(); self.worker().reconcile(operation)
        operation["spec"]["gpuMemory"]["dynamicLimitMi"] = 32768
        self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Interrupted")
        operation["metadata"]["uid"] = "replacement"
        self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Rejected")
        self.assertEqual(self.write.call_count, 1)
        self.assertEqual(len(self.shutdowns()), 1)

    def test_no_reboot_observed_times_out_without_repeat(self):
        operation = request(); worker = self.worker(); worker.reconcile(operation)
        worker.state["current"]["scheduledAt"] = time.time() - 601; worker.save()
        self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Failed")
        self.assertEqual(len(self.shutdowns()), 1)

    def test_ttm_active_value_mismatch_never_claims_success(self):
        operation = request(index=3, dynamic=40960)
        self.worker().reconcile(operation)
        self.advance_boot("boot-b", 32768, 3, 64000, 40000)
        self.worker().reconcile(operation); self.worker().reconcile(operation)
        self.assertEqual(self.worker().state["current"]["phase"], "Failed")
        self.assertEqual(len(self.shutdowns()), 1)


if __name__ == "__main__":
    unittest.main()
