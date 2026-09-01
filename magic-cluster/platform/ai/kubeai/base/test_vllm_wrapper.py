import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parent


def load_wrapper():
    manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text(encoding="utf-8"))
    namespace = {"__name__": "magicstick_vllm_wrapper_test"}
    exec(compile(manifest["data"]["wrapper.py"], "wrapper.py", "exec"), namespace)
    return namespace


class VllmWrapperTests(unittest.TestCase):
    def setUp(self):
        self.wrapper = load_wrapper()
        self.original_environ = dict(self.wrapper["os"].environ)
        self.original_argv = list(self.wrapper["sys"].argv)
        self.original_subprocess_run = self.wrapper["subprocess"].run

    def tearDown(self):
        self.wrapper["os"].environ.clear()
        self.wrapper["os"].environ.update(self.original_environ)
        self.wrapper["sys"].argv[:] = self.original_argv
        self.wrapper["subprocess"].run = self.original_subprocess_run

    def test_cpu_target_starts_vllm_without_inspecting_nvidia(self):
        self.wrapper["os"].environ["MAGICSTICK_COMPUTE_TARGET"] = "cpu"
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--max-model-len=2048", "--gpu-memory-utilization=0.9"]
        self.wrapper["subprocess"].run = lambda *_args, **_kwargs: self.fail("CPU target must not run nvidia-smi")

        self.wrapper["configure_argv"]()

        self.assertEqual(
            self.wrapper["sys"].argv,
            ["wrapper.py", "--max-model-len=2048"],
        )

    def test_nvidia_target_adds_memory_utilization_from_physical_capacity(self):
        self.wrapper["os"].environ.update({
            "MAGICSTICK_COMPUTE_TARGET": "nvidia-gpu",
            "MAGICSTICK_VLLM_VRAM_LIMIT": "8Gi",
        })
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--max-model-len=4096"]
        self.wrapper["gpu_total_mib"] = lambda _target, _device: 16384

        self.wrapper["configure_argv"]()

        self.assertIn("--gpu-memory-utilization=0.5000", self.wrapper["sys"].argv)
        self.assertIn("--max-model-len=4096", self.wrapper["sys"].argv)

    def test_amd_and_intel_targets_use_their_runtime_memory_capacity(self):
        for target in ("amd-gpu", "intel-gpu"):
            with self.subTest(target=target):
                observed = []
                self.wrapper["os"].environ.update({
                    "MAGICSTICK_COMPUTE_TARGET": target,
                    "MAGICSTICK_VLLM_VRAM_LIMIT": "6Gi",
                })
                self.wrapper["sys"].argv[:] = ["wrapper.py"]
                self.wrapper["gpu_total_mib"] = lambda selected, device: observed.append((selected, device)) or 12288

                self.wrapper["configure_argv"]()

                self.assertEqual(observed, [(target, "0")])
                self.assertIn("--gpu-memory-utilization=0.5000", self.wrapper["sys"].argv)

    def test_unknown_compute_target_fails_closed(self):
        self.wrapper["os"].environ["MAGICSTICK_COMPUTE_TARGET"] = "future-accelerator"

        with self.assertRaises(SystemExit) as raised:
            self.wrapper["main"]()

        self.assertEqual(raised.exception.code, 2)

    def test_helm_values_keep_all_vendor_profiles_separate(self):
        release = yaml.safe_load((ROOT / "helmrelease.yaml").read_text(encoding="utf-8"))
        values = release["spec"]["values"]
        images = values["modelServers"]["VLLM"]["images"]
        ollama_images = values["modelServers"]["OLlama"]["images"]
        profiles = values["resourceProfiles"]

        self.assertEqual(images["magicstick-vllm-cpu"], "vllm/vllm-openai-cpu:v0.23.0")
        self.assertEqual(images["magicstick-vllm-nvidia"], "vllm/vllm-openai:v0.23.0")
        self.assertEqual(images["magicstick-vllm-amd"], "vllm/vllm-openai-rocm:v0.26.0")
        self.assertEqual(images["magicstick-vllm-intel"], "vllm/vllm-openai-xpu:v0.26.0")
        self.assertEqual(ollama_images["magicstick-ollama-cpu"], "ollama/ollama:0.11.11")
        self.assertEqual(ollama_images["magicstick-ollama-nvidia"], "ollama/ollama:0.11.11")
        self.assertEqual(ollama_images["magicstick-ollama-amd"], "ollama/ollama:0.11.11-rocm")
        self.assertNotIn("nvidia.com/gpu", profiles["magicstick-vllm-cpu"]["requests"])
        self.assertNotIn("nvidia.com/gpu", profiles["magicstick-vllm-cpu"]["limits"])
        self.assertEqual(profiles["magicstick-nvidia-gpu"]["limits"]["nvidia.com/gpu"], "1")
        self.assertEqual(profiles["magicstick-amd-gpu"]["limits"]["amd.com/gpu"], "1")
        self.assertEqual(profiles["magicstick-intel-i915-gpu"]["limits"]["gpu.intel.com/i915"], "1")
        self.assertEqual(profiles["magicstick-intel-xe-gpu"]["limits"]["gpu.intel.com/xe"], "1")
        self.assertEqual(profiles["magicstick-ollama-nvidia-gpu"]["limits"]["nvidia.com/gpu"], "1")
        self.assertEqual(profiles["magicstick-ollama-amd-gpu"]["limits"]["amd.com/gpu"], "1")

    def test_global_pod_patch_does_not_override_ollama_command(self):
        release = yaml.safe_load((ROOT / "helmrelease.yaml").read_text(encoding="utf-8"))
        patches = release["spec"]["values"]["modelServerPods"]["jsonPatches"]

        self.assertNotIn("/spec/containers/0/command", {patch["path"] for patch in patches})
        self.assertTrue(any(
            patch.get("value", {}).get("name") == "ollama-model-cache"
            for patch in patches
            if isinstance(patch.get("value"), dict)
        ))

    def test_sitecustomize_only_activates_the_vllm_argument_wrapper_explicitly(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text(encoding="utf-8"))
        source = manifest["data"]["sitecustomize.py"]

        self.assertIn("MAGICSTICK_VLLM_WRAPPER_ENABLED", source)
        self.assertIn("MAGICSTICK_VLLM_WRAPPER_APPLIED", source)
        self.assertIn("wrapper.configure_argv()", source)

    def test_python_automatically_applies_sitecustomize_to_vllm_arguments(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in ("wrapper.py", "sitecustomize.py"):
                (root / name).write_text(manifest["data"][name], encoding="utf-8")
            module = root / "vllm" / "entrypoints" / "openai" / "api_server.py"
            module.parent.mkdir(parents=True)
            for package in (root / "vllm", root / "vllm" / "entrypoints", module.parent):
                (package / "__init__.py").write_text("", encoding="utf-8")
            module.write_text("import json,sys; print(json.dumps(sys.argv))\n", encoding="utf-8")
            environment = dict(os.environ)
            environment.update({
                "PYTHONPATH": directory,
                "MAGICSTICK_VLLM_WRAPPER_ENABLED": "true",
                "MAGICSTICK_COMPUTE_TARGET": "cpu",
            })
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vllm.entrypoints.openai.api_server",
                    "--max-model-len=2048",
                    "--gpu-memory-utilization=0.9",
                ],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )

        self.assertEqual(
            json.loads(result.stdout.strip().splitlines()[-1]),
            [str(module), "--max-model-len=2048"],
        )

    def test_sitecustomize_does_not_change_unrelated_python_children(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in ("wrapper.py", "sitecustomize.py"):
                (root / name).write_text(manifest["data"][name], encoding="utf-8")
            environment = dict(os.environ)
            environment.update({
                "PYTHONPATH": directory,
                "MAGICSTICK_VLLM_WRAPPER_ENABLED": "true",
                "MAGICSTICK_VLLM_WRAPPER_APPLIED": "true",
                "MAGICSTICK_COMPUTE_TARGET": "cpu",
            })
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import json,sys; print(json.dumps(sys.argv))",
                    "--gpu-memory-utilization=0.9",
                ],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )

        self.assertEqual(
            json.loads(result.stdout.strip().splitlines()[-1]),
            ["-c", "--gpu-memory-utilization=0.9"],
        )


if __name__ == "__main__":
    unittest.main()
