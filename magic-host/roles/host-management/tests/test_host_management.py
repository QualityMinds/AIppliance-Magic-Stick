import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROLE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROLE / "files"))
import host_plan as planner
import host_worker as executor


def report(ready=False):
    return {"bootId": "boot-a", "os": {"id": "ubuntu", "versionId": "24.04"},
            "kernel": {"release": "7.0.0-31-generic" if ready else "6.8.0-1-generic", "strixHaloFixes": "present" if ready else "missing"},
            "hardwareFingerprint": "f" * 64, "nodeAnnotation": {"hostDriverReady": ready}}


def node():
    return {"metadata": {"name": "example-node", "uid": "node-uid"}}


def operation(plan, action="prepare-gpu", **changes):
    spec = {"action": action, "nodeName": "example-node", "nodeUid": "node-uid", "bootId": "boot-a", "requestId": "a" * 32,
            "planId": plan["id"] if action == "prepare-gpu" else "", "allowExperimental": action == "prepare-gpu",
            "experimentMode": False, "acknowledgeDisruption": True, "actorHash": "b" * 64, **changes}
    return {"metadata": {"name": executor.operation_name("node-uid"), "uid": "operation-uid", "creationTimestamp": executor.stamp()}, "spec": spec}


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads((ROLE / "files/profiles.json").read_text())

    def plan(self, evidence=None, gpus=None, installed=None, arch="x86_64"):
        return planner.build_plan(evidence or report(), ["1002:1586"] if gpus is None else gpus, installed or {}, self.catalog, arch)

    def test_strix_plan_is_exact_and_requires_one_restart(self):
        value = self.plan()
        self.assertEqual(value["state"], "available")
        self.assertEqual(value["packages"], {"linux-generic-hwe-24.04": "7.0.0-31.31~24.04.1"})
        self.assertTrue(value["rebootRequired"])
        self.assertEqual(self.plan(), value)

    def test_running_good_host_does_not_change_packages_or_reboot(self):
        value = self.plan(report(True))
        self.assertEqual(value["state"], "ready")
        self.assertFalse(value["packages"])
        self.assertFalse(value["rebootRequired"])

    def test_cpu_nvidia_intel_and_unknown_amd_do_not_receive_strix_kernel(self):
        for gpus in ([], ["10de:2684"], ["8086:56a0"], ["1002:9999"], ["10de:2684", "8086:56a0"]):
            with self.subTest(gpus=gpus):
                value = self.plan(gpus=gpus)
                self.assertEqual(value["state"], "not-required")
                self.assertEqual(value["packages"], {})
                self.assertNotIn("experiment", value)

    def test_mixed_gpu_upgrade_blocked_but_bounded_experiment_available(self):
        for other in ("10de:2684", "8086:56a0", "1002:9999"):
            value = self.plan(gpus=["1002:1586", other])
            self.assertEqual(value["state"], "blocked")
            self.assertEqual(value["packages"], {})
            experiment = value["experiment"]
            self.assertTrue(experiment["experimentMode"])
            self.assertEqual(experiment["packages"], self.plan()["packages"])
            self.assertEqual(experiment["engineValidationAvailable"], not other.startswith("1002:"))

    def test_working_mixed_host_can_validate_without_kernel_change(self):
        value = self.plan(report(True), ["1002:1586", "10de:2684"])
        self.assertEqual(value["state"], "ready")
        self.assertFalse(value["rebootRequired"])
        self.assertFalse(value["packages"])

    def test_missing_inventory_never_offers_experiment(self):
        value = planner.build_plan(report(), None, {}, self.catalog, "x86_64")
        self.assertEqual(value["state"], "blocked")
        self.assertNotIn("experiment", value)

    def test_unknown_os_architecture_and_driver_failure_stay_blocked(self):
        bad_os = report(); bad_os["os"]["versionId"] = "99.04"
        broken_driver = report(True); broken_driver["nodeAnnotation"]["hostDriverReady"] = False
        for evidence, arch in ((bad_os, "x86_64"), (report(), "aarch64"), (broken_driver, "x86_64")):
            value = self.plan(evidence, arch=arch)
            self.assertEqual(value["state"], "blocked")
            self.assertNotIn("experiment", value)

    def test_plan_changes_when_boot_hardware_packages_or_catalog_changes(self):
        original = self.plan()["id"]
        for key, value in (("bootId", "boot-b"), ("hardwareFingerprint", "e" * 64)):
            changed = report(); changed[key] = value
            self.assertNotEqual(self.plan(changed)["id"], original)
        self.assertNotEqual(self.plan(installed=self.plan()["packages"])["id"], original)
        self.catalog["profiles"][0]["version"] = "2"
        self.assertNotEqual(self.plan()["id"], original)

    def test_installed_target_only_needs_reboot_not_reinstall(self):
        value = self.plan(installed=self.plan()["packages"])
        self.assertFalse(value["packages"])
        self.assertTrue(value["rebootRequired"])


class RequestTests(unittest.TestCase):
    setUp = PlanTests.setUp
    plan = PlanTests.plan
    def test_rejects_wrong_identity_boot_stale_plan_unknown_fields_and_missing_consent(self):
        plan = self.plan()
        for changes in ({"nodeName": "another-node"}, {"nodeUid": "old-uid"}, {"bootId": "old-boot"},
                        {"planId": "changed"}, {"action": "shell"}, {"command": "touch /tmp/unwanted"},
                        {"acknowledgeDisruption": False}, {"acknowledgeDisruption": 1},
                        {"allowExperimental": False}, {"requestId": "../../bad"}, {"experimentMode": "true"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                planner.validate_request(operation(plan, **changes), node(), report(), plan, time.time())

    def test_expired_and_future_requests_never_execute(self):
        plan = self.plan()
        for seconds in (-301, 60):
            request = operation(plan)
            request["metadata"]["creationTimestamp"] = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
            with self.assertRaises(ValueError):
                planner.validate_request(request, node(), report(), plan, time.time())

    def test_power_does_not_accept_preparation_parameters(self):
        plan = self.plan()
        for changes in ({"experimentMode": True}, {"planId": plan["id"]}, {"allowExperimental": True}):
            with self.assertRaises(ValueError):
                planner.validate_request(operation(plan, "reboot", **changes), node(), report(), plan, time.time())

    def test_experiment_requires_explicit_mode_and_exact_experiment_plan(self):
        plan = self.plan(gpus=["1002:1586", "10de:2684"])
        experiment = plan["experiment"]
        request = operation(experiment)
        with self.assertRaises(ValueError):
            planner.validate_request(request, node(), report(), plan, time.time())
        request["spec"]["experimentMode"] = True
        self.assertEqual(planner.validate_request(request, node(), report(), plan, time.time())["planId"], experiment["id"])


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.report = report(True)
        catalog = json.loads((ROLE / "files/profiles.json").read_text())
        self.plan = planner.build_plan(self.report, ["1002:1586"], {}, catalog, "x86_64")
        self.worker = executor.Worker(node(), self.report, self.plan, self.root)
        self.kube = patch.object(executor, "kube", return_value={}).start()
        self.run = patch.object(executor, "run", return_value="{}").start()
        self.addCleanup(patch.stopall)

    def test_reboot_is_scheduled_once_and_resume_never_repeats_it(self):
        request = operation(self.plan, "reboot")
        self.worker.reconcile(request)
        self.run.assert_called_once_with(["/usr/sbin/shutdown", "-r", "+1", "Magic Stick administrator requested host maintenance."])
        self.assertEqual(self.worker.state["current"]["phase"], "RebootScheduled")
        # A second tick / service restart in the same boot is not a retry.
        worker = executor.Worker(node(), self.report, self.plan, self.root)
        worker.reconcile(request)
        self.assertEqual(self.run.call_count, 1)
        changed = copy.deepcopy(self.report); changed["bootId"] = "boot-b"
        worker = executor.Worker(node(), changed, self.plan, self.root)
        worker.reconcile(request)
        self.assertEqual(worker.state["current"]["phase"], "Succeeded")
        self.assertEqual(self.run.call_count, 1)

    def test_poweroff_only_schedules_orderly_systemd_poweroff(self):
        request = operation(self.plan, "poweroff")
        self.worker.reconcile(request)
        self.run.assert_called_once_with(["/usr/sbin/shutdown", "-P", "+1", "Magic Stick administrator requested host maintenance."])
        self.assertEqual(self.worker.state["current"]["phase"], "PoweroffScheduled")

    def test_duplicate_request_id_cannot_be_replayed_as_new_resource(self):
        request = operation(self.plan, "reboot")
        self.worker.reconcile(request)
        self.worker.update(request, "Failed", "test")
        request["metadata"]["uid"] = "new-operation-uid"
        self.worker.reconcile(request)
        self.assertEqual(self.run.call_count, 1)
        self.assertEqual(self.worker.state["current"]["phase"], "Rejected")

    def test_invalid_request_never_runs_host_command(self):
        self.worker.reconcile(operation(self.plan, "reboot", bootId="another-boot"))
        self.assertEqual(self.worker.state["current"]["phase"], "Rejected")
        self.run.assert_not_called()

    def test_interrupted_preparation_never_repeats_ansible_or_reboots(self):
        request = operation(self.plan)
        self.worker.reconcile(request)
        self.worker.state["current"]["phase"] = "Preparing"; self.worker.save()
        self.run.reset_mock()
        restored = executor.Worker(node(), self.report, self.plan, self.root)
        restored.reconcile(request)
        self.assertEqual(restored.state["current"]["phase"], "Interrupted")
        self.run.assert_not_called()

    def test_busy_local_state_blocks_replacement(self):
        self.worker.reconcile(operation(self.plan, "poweroff"))
        replacement = operation(self.plan, "reboot"); replacement["metadata"]["uid"] = "second-uid"
        with self.assertRaisesRegex(RuntimeError, "previous local"):
            self.worker.reconcile(replacement)
        self.assertEqual(self.run.call_count, 1)

    def test_failed_power_command_is_not_retried(self):
        self.run.side_effect = RuntimeError("failed")
        request = operation(self.plan, "reboot")
        self.worker.reconcile(request)
        self.worker.reconcile(request)
        self.assertEqual(self.worker.state["current"]["phase"], "Failed")
        self.assertEqual(self.run.call_count, 1)

    def test_no_reboot_loop_when_expected_kernel_did_not_boot(self):
        request = operation(self.plan)
        self.worker.reconcile(request)
        self.worker.state["current"].update(phase="RebootScheduled", scheduledAt=time.time())
        self.worker.save()
        changed = report(); changed["bootId"] = "boot-b"
        self.run.reset_mock()
        restored = executor.Worker(node(), changed, self.plan, self.root)
        restored.reconcile(request)
        self.assertEqual(restored.state["current"]["phase"], "Failed")
        self.run.assert_not_called()

    def test_gpu_registration_never_claims_success_from_old_boot(self):
        request = operation(self.plan)
        self.worker.reconcile(request)
        self.assertEqual(self.worker.state["current"]["phase"], "Registering")
        self.worker.report["bootId"] = "boot-b"
        self.worker.reconcile(request)
        self.assertEqual(self.worker.state["current"]["phase"], "Interrupted")

    def test_preparation_with_good_kernel_enables_gpu_without_requesting_engine_validation(self):
        self.worker.reconcile(operation(self.plan))
        self.run.assert_called_once_with(["/usr/local/sbin/magicstick-gpu-publish"], timeout=90)
        requests = [call.args for call in self.kube.call_args_list if call.args[0][0] == "create"]
        self.assertEqual(requests[0][1]["spec"]["parameters"]["validationRequest"], "")
        self.assertEqual(self.worker.state["current"]["phase"], "Registering")

    def test_host_preparation_succeeds_with_registered_gpu_regardless_of_smoke_results(self):
        request = operation(self.plan)
        self.worker.reconcile(request)
        activation = next(call.args[1] for call in self.kube.call_args_list if call.args[0][0] == "create")
        self.run.reset_mock()
        for state in ("unverified", "failed", "running", "stale"):
            with self.subTest(validation=state):
                self.worker.state["current"]["phase"] = "Registering"
                evidence = {"nodeUid": node()["metadata"]["uid"], "hostFingerprint": self.report["hardwareFingerprint"],
                            "hostBootId": self.report["bootId"],
                            "eligible": True, "hostDriverReady": True, "resourceRegistered": True,
                            "validation": {"OLlama": {"state": state}, "VLLM": {"state": state}}}
                appliance = {"status": {"hardwareOperators": {"amd-gpu": {"compatibility": {"nodes": [evidence]}}}}}
                self.kube.side_effect = lambda args, *_: appliance if args[:2] == ["get", "appliances.appliance.magicstick.dev"] else activation
                self.worker.reconcile(request)
                self.assertEqual(self.worker.state["current"]["phase"], "Succeeded")
                self.assertIn("optional", self.worker.state["current"]["message"])
        self.run.assert_not_called()

    def test_old_appliance_boot_evidence_cannot_complete_registration(self):
        request = operation(self.plan)
        self.worker.reconcile(request)
        activation = next(call.args[1] for call in self.kube.call_args_list if call.args[0][0] == "create")
        evidence = {"nodeUid": node()["metadata"]["uid"], "hostFingerprint": self.report["hardwareFingerprint"],
                    "hostBootId": "older-boot", "eligible": True, "hostDriverReady": True, "resourceRegistered": True}
        appliance = {"status": {"hardwareOperators": {"amd-gpu": {"compatibility": {"nodes": [evidence]}}}}}
        self.kube.side_effect = lambda args, *_: appliance if args[:2] == ["get", "appliances.appliance.magicstick.dev"] else activation
        self.worker.reconcile(request)
        self.assertEqual(self.worker.state["current"]["phase"], "Registering")

    def test_host_preparation_still_waits_for_gpu_registration_and_times_out_without_retry(self):
        request = operation(self.plan)
        self.worker.reconcile(request)
        activation = next(call.args[1] for call in self.kube.call_args_list if call.args[0][0] == "create")
        self.kube.return_value = activation
        self.worker.reconcile(request)
        self.assertEqual(self.worker.state["current"]["phase"], "Registering")
        self.worker.state["current"]["registrationStartedAt"] = time.time() - 901
        self.run.reset_mock()
        self.worker.reconcile(request)
        self.assertEqual(self.worker.state["current"]["phase"], "Failed")
        self.run.assert_not_called()

    def test_kernel_preparation_runs_fixed_ansible_then_one_reboot_and_resumes(self):
        evidence = report()
        catalog = json.loads((ROLE / "files/profiles.json").read_text())
        plan = planner.build_plan(evidence, ["1002:1586"], {}, catalog, "x86_64")
        worker = executor.Worker(node(), evidence, plan, self.root)
        request = operation(plan)
        with patch.object(Path, "is_file", return_value=True):
            worker.reconcile(request)
        args = self.run.call_args_list[0].args[0]
        self.assertEqual(args[:4], ["/usr/bin/ansible-playbook", "-i", "localhost,", "--connection=local"])
        self.assertEqual(json.loads((self.root / "approved-vars.json").read_text())["gpu_compatibility_package_versions"], plan["packages"])
        self.assertEqual(worker.state["current"]["phase"], "RebootScheduled")
        changed = report(True); changed["bootId"] = "boot-b"
        restored = executor.Worker(node(), changed, plan, self.root)
        restored.reconcile(request)
        self.assertEqual(restored.state["current"]["phase"], "Verifying")
        restored.reconcile(request)
        self.assertEqual(restored.state["current"]["phase"], "Registering")
        shutdowns = [call for call in self.run.call_args_list if call.args[0][0] == "/usr/sbin/shutdown"]
        self.assertEqual(len(shutdowns), 1)

    def test_unconfirmed_api_status_never_allows_a_power_side_effect(self):
        self.kube.side_effect = RuntimeError("API unavailable")
        with self.assertRaises(RuntimeError):
            self.worker.reconcile(operation(self.plan, "poweroff"))
        self.run.assert_not_called()
        self.assertEqual(executor.Worker(node(), self.report, self.plan, self.root).state["current"]["phase"], "Failed")

    def test_profile_change_during_preparation_is_never_overwritten(self):
        request = operation(self.plan)
        self.worker.reconcile(request)
        self.worker.state["current"].update(phase="Verifying", verifyStartedAt=time.time())
        self.worker.save()
        self.kube.return_value = {"metadata": {"uid": "changed"}, "spec": {"enabled": False}}
        self.kube.reset_mock(); self.run.reset_mock()
        self.worker.reconcile(request)
        self.assertEqual(self.worker.state["current"]["phase"], "Interrupted")
        self.assertFalse(any(call.args[0][0] == "create" for call in self.kube.call_args_list))
        self.run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
