import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import yaml


ROLE = Path(__file__).resolve().parents[1]
HOST = ROLE.parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROLE / "files" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preflight = load("gpu_preflight", "magicstick-gpu-preflight.py")
smoke = load("gpu_smoke", "magicstick-hip-smoke.py")
publisher = load("gpu_publish", "magicstick-gpu-publish.py")


class HostEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, filename, text):
        file = self.root / filename.lstrip("/")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
        return file

    def device(self, device="1586", address="0000:01:00.0", cls="0x030000", minor=128):
        prefix = f"/sys/bus/pci/devices/{address}"
        self.write(prefix + "/vendor", "0x1002")
        self.write(prefix + "/device", "0x" + device)
        self.write(prefix + "/class", cls)
        self.write(prefix + "/drm/renderD" + str(minor), "")
        self.write(prefix + "/mem_info_vram_total", str(512 * 1024**2))
        self.write(prefix + "/mem_info_gtt_total", str(32 * 1024**3))
        driver = self.root / "sys/bus/pci/drivers/amdgpu"
        driver.mkdir(parents=True, exist_ok=True)
        (self.root / prefix.lstrip("/") / "driver").symlink_to(driver)

    def strix_fixture(self):
        self.write("/etc/os-release", 'ID=ubuntu\nVERSION_ID="24.04"\n')
        self.write("/proc/sys/kernel/osrelease", "6.14.0-1018-oem")
        self.write("/proc/meminfo", "MemTotal: 67108864 kB\nMemAvailable: 33554432 kB\n")
        self.write("/sys/module/ttm/parameters/pages_limit", "8388608")
        self.write("/sys/module/amdgpu/version", "6.14.0")
        self.write("/sys/class/kfd/kfd/topology/nodes/1/properties", "vendor_id 4098\ndevice_id 5510\ngfx_target_version 110501\ndrm_render_minor 128\n")
        self.device()

    def test_exact_profile_and_shared_memory_not_summed(self):
        self.strix_fixture()
        with patch.object(preflight.subprocess, "run", side_effect=AssertionError("offline fixture ran command")):
            report = preflight.collect(self.root, live=False)
        self.assertEqual(report["devices"][0]["profileId"], "strix-halo")
        self.assertEqual(report["devices"][0]["gfxArchitectures"], ["gfx1151"])
        self.assertEqual(report["devices"][0]["memoryTopology"], "shared")
        self.assertEqual(report["nodeAnnotation"]["physicalMemoryMi"], 65536)
        self.assertEqual(report["nodeAnnotation"]["gpuAccessibleMi"], 32768)
        self.assertFalse(report["nodeAnnotation"]["memoryAccountingVerified"])
        self.assertFalse(report["nodeAnnotation"]["hostDriverReady"])
        self.assertFalse(report["devices"][0]["computeValidated"])

    def test_unknown_amd_card_is_not_marked_as_strix_or_shared(self):
        self.device(device="9999")
        report = preflight.collect(self.root, live=False)
        self.assertIsNone(report["devices"][0]["profileId"])
        self.assertEqual(report["devices"][0]["memoryTopology"], "unknown")
        self.assertNotIn("nodeAnnotation", report)

    def test_non_display_amd_function_is_not_a_gpu(self):
        self.device(cls="0x060400")
        self.assertEqual(preflight.collect(self.root, live=False)["devices"], [])

    def test_unknown_gfx_never_filled_from_expected_profile(self):
        self.strix_fixture()
        self.write("/sys/class/kfd/kfd/topology/nodes/1/properties", "vendor_id 4098\ndevice_id 5510\ndrm_render_minor 128\n")
        report = preflight.collect(self.root, live=False)
        self.assertIsNone(report["nodeAnnotation"]["detectedArchitecture"])
        self.assertFalse(report["nodeAnnotation"]["hostDriverReady"])

    def test_kfd_topology_is_matched_by_render_minor_not_only_vendor(self):
        self.strix_fixture()
        self.write("/sys/class/kfd/kfd/topology/nodes/1/properties", "vendor_id 4098\ndevice_id 5510\ngfx_target_version 110501\ndrm_render_minor 129\n")
        self.assertEqual(preflight.collect(self.root, live=False)["devices"][0]["gfxArchitectures"], [])

    def test_kernel_evidence_is_version_specific_not_certification(self):
        for release, expected in [("6.8.0-139-generic", "missing"), ("6.14.0-1017-oem", "unknown"), ("6.14.0-1018-oem", "present"), ("6.18.3", "unknown"), ("6.18.4", "present"), ("unknown", "unknown")]:
            evidence = preflight.kernel_evidence(release)
            self.assertEqual(evidence["strixHaloFixes"], expected)
            self.assertEqual(evidence["runtimeCompatibility"], "not-validated")

    def test_fingerprint_stable_when_free_memory_changes_but_not_kernel(self):
        self.strix_fixture()
        before = preflight.collect(self.root, live=False)["hardwareFingerprint"]
        self.write("/proc/meminfo", "MemTotal: 67108864 kB\nMemAvailable: 1 kB\n")
        self.assertEqual(before, preflight.collect(self.root, live=False)["hardwareFingerprint"])
        self.write("/proc/sys/kernel/osrelease", "6.18.4")
        self.assertNotEqual(before, preflight.collect(self.root, live=False)["hardwareFingerprint"])

    def test_missing_and_timeout_commands_are_structured_and_raw_output_not_leaked(self):
        with patch.object(preflight.shutil, "which", return_value=None):
            status, output = preflight.command(["definitely-missing"])
        self.assertEqual(status["reason"], "command-not-found")
        self.assertEqual(output, "")
        with patch.object(preflight.shutil, "which", return_value="/test/rocminfo"), patch.object(preflight.subprocess, "run", side_effect=subprocess.TimeoutExpired("rocminfo", 20)):
            status, _ = preflight.command(["rocminfo"])
        self.assertEqual(status["reason"], "timeout")
        self.assertNotIn("/test", json.dumps(status))

    def test_absent_memory_is_unknown_not_invented_capacity(self):
        self.device()
        report = preflight.collect(self.root, live=False)
        self.assertIsNone(report["nodeAnnotation"]["gpuAccessibleMi"])
        self.assertIsNone(report["nodeAnnotation"]["physicalMemoryMi"])

    def test_cli_requires_exact_profile_and_absolute_root(self):
        command = [sys.executable, str(ROLE / "files/magicstick-gpu-preflight.py"), "--json", "--root", str(self.root), "--require-profile", "strix-halo"]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["devices"], [])
        result = subprocess.run(command[:3] + ["--root", "relative"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)


class HipSmokeTests(unittest.TestCase):
    def torch_stub(self, hip="7.2", available=True, architecture="gfx1151:sramecc-:xnack-"):
        return types.SimpleNamespace(version=types.SimpleNamespace(hip=hip), cuda=types.SimpleNamespace(is_available=lambda: available, device_count=lambda: 1, get_device_properties=lambda index: types.SimpleNamespace(gcnArchName=architecture)))

    def test_cpu_build_is_never_a_gpu_pass(self):
        with self.assertRaisesRegex(RuntimeError, "not built for HIP"):
            smoke.validate(self.torch_stub(hip=None))

    def test_missing_gpu_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, "No selected HIP GPU"):
            smoke.validate(self.torch_stub(available=False))

    def test_wrong_architecture_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, "architecture mismatch"):
            smoke.validate(self.torch_stub(architecture="gfx1100"))

    def test_out_of_range_device_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, "No selected HIP GPU"):
            smoke.validate(self.torch_stub(), device_index=1)

    def test_small_compute_requires_gpu_and_exact_reference(self):
        class Tensor:
            def __init__(self, kind="cpu"):
                self.device = types.SimpleNamespace(type=kind)

            def reshape(self, *_):
                return self

            def __mod__(self, _):
                return self

            def __sub__(self, _):
                return self

            def __matmul__(self, _):
                return Tensor(self.device.type)

            def to(self, _):
                return Tensor("cuda")

            def cpu(self):
                return Tensor("cpu")

        torch = self.torch_stub()
        torch.device = lambda value: value
        torch.float32 = "float32"
        torch.arange = lambda *args, **kwargs: Tensor()
        torch.cuda.synchronize = lambda device: None
        torch.isfinite = lambda tensor: types.SimpleNamespace(all=lambda: True)
        torch.equal = lambda result, expected: True
        torch.__version__ = "fixture"
        report = smoke.validate(torch)
        self.assertEqual(report["status"], "passed")
        self.assertFalse(report["modelInferenceValidated"])
        torch.equal = lambda result, expected: False
        with self.assertRaisesRegex(RuntimeError, "did not match"):
            smoke.validate(torch)


class RoleSafetyTests(unittest.TestCase):
    def test_default_role_never_prepares_or_mutates_gpu_driver(self):
        defaults = yaml.safe_load((ROLE / "defaults/main.yml").read_text())
        self.assertFalse(defaults["gpu_compatibility_prepare_host"])
        self.assertEqual(defaults["gpu_compatibility_package_versions"], {})
        self.assertIsNone(defaults["gpu_compatibility_ttm_limit_mib"])
        tasks = yaml.safe_load((ROLE / "tasks/main.yml").read_text())
        preparation = next(task for task in tasks if "block" in task)
        self.assertEqual(preparation["when"], "gpu_compatibility_prepare_host | bool")
        contents = (ROLE / "tasks/main.yml").read_text()
        for forbidden in ("ansible.builtin.reboot", "blacklist amdgpu", "modprobe amdgpu", "state: latest", "allow_downgrade: true"):
            self.assertNotIn(forbidden, contents)

    def test_preparation_restricts_os_packages_and_explicit_reserve(self):
        tasks = (ROLE / "tasks/main.yml").read_text()
        self.assertIn("gpu_compatibility_profile == 'strix-halo'", tasks)
        self.assertIn("--require-profile strix-halo", tasks)
        self.assertIn("item.value is string", tasks)
        self.assertIn("gpu_compatibility_system_reserve_mib | int >= 8192", tasks)
        self.assertIn("memory", tasks.lower())
        self.assertIn("--require-profile strix-halo", tasks)

    def test_helper_role_runs_before_k3s(self):
        play = yaml.safe_load((HOST / "playbooks/local.yml").read_text())[0]
        self.assertLess(play["roles"].index("gpu-compatibility"), play["roles"].index("k3s"))

    def test_publisher_is_separate_and_has_no_eligibility_labels(self):
        defaults = yaml.safe_load((ROLE / "defaults/main.yml").read_text())
        self.assertTrue(defaults["gpu_compatibility_publish_evidence"])
        timer = (ROLE / "templates/magicstick-gpu-preflight.timer.j2").read_text()
        self.assertIn("OnUnitActiveSec=5min", timer)
        service = (ROLE / "templates/magicstick-gpu-preflight.service.j2").read_text()
        self.assertIn("ConditionPathExists=/etc/rancher/k3s/k3s.yaml", service)
        self.assertIn("User=root", service)
        self.assertIn("ProtectSystem=strict", service)
        script = (ROLE / "files/magicstick-gpu-publish.py").read_text()
        self.assertNotIn('"labels"', script)
        self.assertNotIn("feature.node.kubernetes.io/amd-gpu", script)


class EvidencePublicationTests(unittest.TestCase):
    def setUp(self):
        self.report = {"kernel": {"release": "6.18.4"}, "bootId": "boot-fixture", "nodeAnnotation": {"profileId": "strix-halo", "memoryAccountingVerified": False}}
        self.node = {"metadata": {"uid": "node-fixture", "annotations": {"unrelated": "preserve"}}, "status": {"nodeInfo": {"kernelVersion": "6.18.4", "bootID": "boot-fixture"}}}

    def test_only_owned_annotation_is_published_with_node_identity(self):
        patch_value = publisher.evidence_patch(self.report, self.node)
        self.assertEqual(set(patch_value), {"metadata"})
        self.assertEqual(set(patch_value["metadata"]), {"annotations"})
        self.assertEqual(set(patch_value["metadata"]["annotations"]), {publisher.ANNOTATION})
        annotation = json.loads(patch_value["metadata"]["annotations"][publisher.ANNOTATION])
        self.assertEqual(annotation["nodeUid"], "node-fixture")
        self.assertFalse(annotation["memoryAccountingVerified"])

    def test_wrong_node_boot_is_rejected_before_any_mutation(self):
        self.node["status"]["nodeInfo"]["bootID"] = "other-boot"
        with self.assertRaisesRegex(RuntimeError, "boot identity"):
            publisher.evidence_patch(self.report, self.node)

    def test_stale_node_kernel_is_rejected(self):
        self.node["status"]["nodeInfo"]["kernelVersion"] = "6.8.0"
        with self.assertRaisesRegex(RuntimeError, "kernel metadata"):
            publisher.evidence_patch(self.report, self.node)

    def test_missing_profile_removes_only_stale_owned_annotation(self):
        self.report.pop("nodeAnnotation")
        self.assertIsNone(publisher.evidence_patch(self.report, self.node))
        self.node["metadata"]["annotations"][publisher.ANNOTATION] = "old"
        self.assertEqual(publisher.evidence_patch(self.report, self.node), {"metadata": {"annotations": {publisher.ANNOTATION: None}}})

    def test_command_failure_does_not_expose_raw_stdout_or_stderr(self):
        result = types.SimpleNamespace(returncode=1, stdout="sensitive-fixture", stderr="sensitive-fixture")
        with patch.object(publisher.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "local Kubernetes request failed") as caught:
                publisher.execute(["fixture"])
        self.assertNotIn("sensitive-fixture", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
