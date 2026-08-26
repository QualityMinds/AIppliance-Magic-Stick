import pathlib
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
        self.original_execvp = self.wrapper["os"].execvp
        self.original_subprocess_run = self.wrapper["subprocess"].run

    def tearDown(self):
        self.wrapper["os"].environ.clear()
        self.wrapper["os"].environ.update(self.original_environ)
        self.wrapper["sys"].argv[:] = self.original_argv
        self.wrapper["os"].execvp = self.original_execvp
        self.wrapper["subprocess"].run = self.original_subprocess_run

    def test_cpu_target_starts_vllm_without_inspecting_nvidia(self):
        executed = []
        self.wrapper["os"].environ["MAGICSTICK_COMPUTE_TARGET"] = "cpu"
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--max-model-len=2048", "--gpu-memory-utilization=0.9"]
        self.wrapper["subprocess"].run = lambda *_args, **_kwargs: self.fail("CPU target must not run nvidia-smi")
        class Executed(Exception):
            pass

        def execvp(executable, command):
            executed.append((executable, command))
            raise Executed()

        self.wrapper["os"].execvp = execvp

        with self.assertRaises(Executed):
            self.wrapper["main"]()

        self.assertEqual(executed[0][0], "python3")
        self.assertEqual(
            executed[0][1],
            ["python3", "-m", "vllm.entrypoints.openai.api_server", "--max-model-len=2048"],
        )

    def test_nvidia_target_adds_memory_utilization_from_physical_capacity(self):
        executed = []
        self.wrapper["os"].environ.update({
            "MAGICSTICK_COMPUTE_TARGET": "nvidia-gpu",
            "MAGICSTICK_VLLM_VRAM_LIMIT": "8Gi",
        })
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--max-model-len=4096"]
        self.wrapper["gpu_total_mib"] = lambda _device: 16384
        class Executed(Exception):
            pass

        def execvp(executable, command):
            executed.append((executable, command))
            raise Executed()

        self.wrapper["os"].execvp = execvp

        with self.assertRaises(Executed):
            self.wrapper["main"]()

        self.assertIn("--gpu-memory-utilization=0.5000", executed[0][1])
        self.assertIn("--max-model-len=4096", executed[0][1])

    def test_unknown_compute_target_fails_closed(self):
        self.wrapper["os"].environ["MAGICSTICK_COMPUTE_TARGET"] = "future-accelerator"

        with self.assertRaises(SystemExit) as raised:
            self.wrapper["main"]()

        self.assertEqual(raised.exception.code, 2)

    def test_helm_values_keep_cpu_and_nvidia_profiles_separate(self):
        release = yaml.safe_load((ROOT / "helmrelease.yaml").read_text(encoding="utf-8"))
        values = release["spec"]["values"]
        images = values["modelServers"]["VLLM"]["images"]
        profiles = values["resourceProfiles"]

        self.assertEqual(images["magicstick-vllm-cpu"], "vllm/vllm-openai-cpu:v0.23.0")
        self.assertEqual(images["magicstick-vllm-nvidia"], "vllm/vllm-openai:v0.23.0")
        self.assertNotIn("nvidia.com/gpu", profiles["magicstick-vllm-cpu"]["requests"])
        self.assertNotIn("nvidia.com/gpu", profiles["magicstick-vllm-cpu"]["limits"])
        self.assertEqual(profiles["magicstick-nvidia-gpu"]["limits"]["nvidia.com/gpu"], "1")


if __name__ == "__main__":
    unittest.main()
