import contextlib
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import yaml


ROOT = pathlib.Path(__file__).resolve().parent


def load_wrapper():
    manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text(encoding="utf-8"))
    namespace = {"__name__": "magicstick_vllm_wrapper_test"}
    exec(compile(manifest["data"]["wrapper.py"], "wrapper.py", "exec"), namespace)
    return namespace


class VllmWrapperTests(unittest.TestCase):
    def ple_backport(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text())
        namespace = {"__name__": "magicstick_ple_backport_test"}
        exec(compile(manifest["data"]["ple_backport.py"], "ple_backport.py", "exec"), namespace)
        return namespace

    def test_ple_backport_copies_storage_bytes_and_passes_row_bytes_to_the_caller(self):
        source = '''@triton.jit
def _lookup_ple_embedding_from_pinned_kernel(
    weight_ptr,
    ids_ptr,
    output_ptr,
    embedding_dim,
    tp_vocab_start,
    tp_vocab_end,
    BLOCK_D: tl.constexpr,
):
    """Look up TP-owned PLE rows through a CUDA view of pinned host memory."""
    row_id = tl.program_id(0)
    global_idx = tl.load(ids_ptr + row_id)
    in_range = (global_idx >= tp_vocab_start) & (global_idx < tp_vocab_end)
    local_idx = tl.where(in_range, global_idx - tp_vocab_start, 0)
    offsets = tl.arange(0, BLOCK_D)
    store_mask = offsets < embedding_dim
    load_mask = store_mask & in_range
    values = tl.load(
        weight_ptr + local_idx * embedding_dim + offsets,
        mask=load_mask,
        other=0.0,
    )
    tl.store(
        output_ptr + row_id * embedding_dim + offsets,
        values,
        mask=store_mask,
    )


class Qwen4ExpPLEPinnedHostEmbedding:
    def prepare(self):
        self._block_d = triton.next_power_of_2(self.embedding_dim)
    def call(self, output):
        return launch(
                output,
                self.embedding_dim,
        )
'''
        backport = self.ple_backport()
        result = backport["transform"]("models/qwen4_exp/common/ngram_embedding.py", source)
        # Execute the actual transformed caller, checking dtype element widths
        # instead of merely asserting that the new setting's name exists.
        import ast
        definition = next(node for node in ast.parse(result).body if isinstance(node, ast.ClassDef))
        calls = []
        namespace = {"triton": types.SimpleNamespace(next_power_of_2=lambda size: 1 << (size - 1).bit_length()),
                     "launch": lambda output, row_bytes: calls.append(row_bytes)}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), "native-caller.py", "exec"), namespace)
        for element_size in (1, 2, 4):
            embedding = namespace["Qwen4ExpPLEPinnedHostEmbedding"]()
            embedding.embedding_dim = 257
            embedding.weight = types.SimpleNamespace(element_size=lambda: element_size)
            embedding.prepare()
            embedding.call(None)
            self.assertEqual(calls[-1], 257 * element_size)
            self.assertGreaterEqual(embedding._block_d, calls[-1])
        kernel = next(node for node in ast.parse(result).body if isinstance(node, ast.FunctionDef))
        pointers = [arg for arg in kernel.args.args if arg.arg in ("weight_ptr", "output_ptr")]
        self.assertTrue(all(ast.unparse(arg.annotation) == "tl.pointer_type(tl.uint8)" for arg in pointers))
        self.assertNotIn("embedding_dim", ast.unparse(kernel))
        self.assertIn("tl.program_id(0).to(tl.int64)", ast.unparse(kernel))

    def test_ple_backport_refuses_wrong_version_vendor_opt_in_and_foreign_files(self):
        backport = self.ple_backport()
        with patch.dict(os.environ, {"MAGICSTICK_VLLM_PLE_BACKPORT": backport["FIX"],
                                     "MAGICSTICK_COMPUTE_TARGET": "nvidia-gpu"}):
            for version in ("0.30.0", "0.31.1", "0.32.0"):
                backport["distribution"] = lambda name, version=version: types.SimpleNamespace(version=version)
                with self.assertRaisesRegex(ValueError, "exact reviewed"):
                    backport["apply"]()
            os.environ["MAGICSTICK_COMPUTE_TARGET"] = "cpu"
            with self.assertRaisesRegex(ValueError, "NVIDIA-only"):
                backport["apply"]()
            os.environ["MAGICSTICK_COMPUTE_TARGET"] = "nvidia-gpu"
            os.environ["MAGICSTICK_VLLM_PLE_BACKPORT"] = "latest"
            with self.assertRaisesRegex(ValueError, "Unreviewed"):
                backport["apply"]()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            files = {}
            for name in backport["ORIGINAL"]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("foreign source\n")
                files[name] = path
            backport["distribution"] = lambda name: types.SimpleNamespace(version="0.31.0",
                locate_file=lambda path: files[path.removeprefix("vllm/")])
            with patch.dict(os.environ, {"MAGICSTICK_VLLM_PLE_BACKPORT": backport["FIX"],
                                         "MAGICSTICK_COMPUTE_TARGET": "nvidia-gpu"}):
                with self.assertRaisesRegex(ValueError, "checksum differs"):
                    backport["apply"]()
            self.assertTrue(all(path.read_text() == "foreign source\n" for path in files.values()))

    def test_ple_backport_is_atomic_idempotent_and_validates_every_file_before_writing(self):
        backport = self.ple_backport()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            originals, expected = {}, {}
            for name in ("first.py", "second.py"):
                (root / name).write_text("original = 1\n")
                originals[name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
                expected[name] = hashlib.sha256(b"original = 2\n").hexdigest()
            backport.update(ORIGINAL=originals, PATCHED=expected,
                transform=lambda name, source: source.replace("= 1", "= 2"),
                distribution=lambda name: types.SimpleNamespace(version="0.31.0",
                    locate_file=lambda name: root / name.removeprefix("vllm/")))
            with patch.dict(os.environ, {"MAGICSTICK_VLLM_PLE_BACKPORT": backport["FIX"],
                                         "MAGICSTICK_COMPUTE_TARGET": "nvidia-gpu"}):
                (root / "second.py").write_text("foreign = 3\n")
                with self.assertRaisesRegex(ValueError, "checksum differs"):
                    backport["apply"]()
                self.assertEqual((root / "first.py").read_text(), "original = 1\n")
                (root / "second.py").write_text("original = 1\n")
                self.assertEqual(backport["apply"](), expected)
                self.assertEqual(backport["apply"](), expected)
                self.assertEqual((root / "first.py").read_text(), "original = 2\n")
                self.assertEqual(list(root.glob(".magicstick-ple-*")), [])

    def test_ple_backport_missing_or_ambiguous_anchor_is_rejected(self):
        backport = self.ple_backport()
        for source in ("", "        self.int32 = None\n        self.tensor = None\n" * 2):
            with self.assertRaisesRegex(ValueError, "missing or ambiguous"):
                backport["transform"]("triton_utils/importing.py", source)

    def test_sitecustomize_backport_failure_terminates_instead_of_silently_continuing(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text())
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "sitecustomize.py").write_text(manifest["data"]["sitecustomize.py"])
            (root / "ple_backport.py").write_text("def apply():\n    raise ValueError('wrong native checksum')\n")
            environment = {**os.environ, "PYTHONPATH": directory,
                           "MAGICSTICK_VLLM_PLE_BACKPORT": "reviewed-opt-in",
                           "MAGICSTICK_VLLM_WRAPPER_ENABLED": "false"}
            result = subprocess.run([sys.executable, "-c", "print('unqualified server started')"],
                                    env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("PLE backport rejected", result.stderr)
        self.assertNotIn("unqualified server started", result.stdout)

    def test_ollama_pins_diagnostics_and_amd_adoption_use_one_immutable_release(self):
        release = yaml.safe_load((ROOT / "helmrelease.yaml").read_text())
        images = release["spec"]["values"]["modelServers"]["OLlama"]["images"]
        operator = ROOT.parents[2] / "magicstick-operator"
        amd = yaml.safe_load((operator / "gpu-runtime-images.yaml").read_text())["data"]
        catalog = json.loads(yaml.safe_load((operator / "gpu-compatibility-catalog.yaml").read_text())["data"]["profiles.json"])
        standard = "ollama/ollama:0.40.3@sha256:adca95a12c2b386a8f9a995e7fa0600e187e3323b5e5522f5a6c3b1ec73eff99"
        rocm = "ollama/ollama:0.40.3-rocm@sha256:8cd88596698ab3283fd2f11727f1ffeb1519508d83f3ec1d137a4979e7bb9b6d"
        self.assertEqual(images, {"magicstick-ollama-cpu": standard, "magicstick-ollama-nvidia": standard})
        self.assertEqual(amd["ollama-amd"], rocm)
        self.assertEqual(amd["ollama-amd-source"], rocm)
        self.assertEqual(catalog["diagnostics"]["nvidia"]["engines"]["OLlama"]["image"], standard)
        self.assertEqual(catalog["profiles"][0]["engines"]["OLlama"]["image"], rocm)
        checksum = hashlib.sha256(json.dumps({key: amd[key] for key in ("vllm-amd", "ollama-amd")}, sort_keys=True).encode()).hexdigest()
        self.assertEqual(amd["runtime-config-checksum"], checksum)
        self.assertTrue(any(item.get("valuesKey") == "ollama-amd" and
                            item.get("targetPath") == "modelServers.OLlama.images.magicstick-ollama-amd"
                            for item in release["spec"]["valuesFrom"]))

    def test_runtime_pins_and_diagnostics_use_the_same_immutable_release(self):
        release = yaml.safe_load((ROOT / "helmrelease.yaml").read_text())
        images = release["spec"]["values"]["modelServers"]["VLLM"]["images"]
        operator = ROOT.parents[2] / "magicstick-operator"
        amd = yaml.safe_load((operator / "gpu-runtime-images.yaml").read_text())["data"]
        catalog = json.loads(yaml.safe_load((operator / "gpu-compatibility-catalog.yaml").read_text())["data"]["profiles.json"])
        for image in [*images.values(), amd["vllm-amd"]]:
            self.assertRegex(image, r"^vllm/vllm-openai(?:-cpu|-rocm|-xpu)?:v0\.31\.0@sha256:[a-f0-9]{64}$")
        self.assertEqual(amd["vllm-amd"], amd["vllm-amd-source"])
        self.assertEqual(catalog["diagnostics"]["nvidia"]["engines"]["VLLM"]["image"], images["magicstick-vllm-nvidia"])
        self.assertEqual(catalog["profiles"][0]["engines"]["VLLM"]["image"], amd["vllm-amd"])
        job = yaml.safe_load((ROOT.parents[3] / "apps/ai/private-mesh/e2e-job.yaml").read_text())
        pod = job["spec"]["template"]["spec"]
        fixture_images = [c["image"] for c in [*pod.get("initContainers", []), *pod["containers"]]
                          if c["image"].startswith("vllm/")]
        self.assertEqual(fixture_images, [images["magicstick-vllm-cpu"]] * 2)

    def test_embedded_probe_uses_native_model_config_registry_and_a_guarded_child(self):
        config_calls, registry_calls = [], []
        class ModelConfig:
            def __init__(self, **kwargs):
                config_calls.append(kwargs)
                self.architectures = ["FixtureForCausalLM"]
                self.hf_text_config = types.SimpleNamespace(num_attention_heads=8, hidden_size=1024, num_hidden_layers=32)
        registry = types.SimpleNamespace(is_pp_supported_model=lambda architectures, config:
            registry_calls.append((architectures, config.architectures)) or True)
        torch = types.ModuleType("torch")
        torch.cuda = types.SimpleNamespace(device_count=lambda: 2, get_device_properties=lambda i:
            types.SimpleNamespace(uuid=f"GPU-{i}", total_memory=24576 * 1048576))
        config_module = types.ModuleType("vllm.config"); config_module.ModelConfig = ModelConfig
        registry_module = types.ModuleType("vllm.model_executor.models"); registry_module.ModelRegistry = registry
        modules = {"torch": torch, "vllm": types.ModuleType("vllm"), "vllm.config": config_module,
                   "vllm.model_executor": types.ModuleType("vllm.model_executor"),
                   "vllm.model_executor.models": registry_module}
        def child(command, **options):
            self.assertEqual(command[:2], [sys.executable, "-c"])
            self.assertEqual(options["env"]["MAGICSTICK_VLLM_WRAPPER_ENABLED"], "false")
            self.assertEqual(options["timeout"], 180)
            self.assertTrue(options["check"])
            output = io.StringIO()
            with patch.dict(sys.modules, modules), patch.object(sys, "argv", ["-c", *command[3:]]), contextlib.redirect_stdout(output):
                exec(compile(command[2], "probe.py", "exec"), {})
            return subprocess.CompletedProcess(command, 0, output.getvalue(), "")
        with patch.object(self.wrapper["subprocess"], "run", side_effect=child):
            probe = self.wrapper["parallelism_probe"](["--model=fixture/small", "--revision", "pinned-revision"])
        self.assertEqual(config_calls, [{"model": "fixture/small", "revision": "pinned-revision", "trust_remote_code": False}])
        self.assertEqual(registry_calls, [(["FixtureForCausalLM"], ["FixtureForCausalLM"])])
        self.assertEqual(probe["devices"], [{"uuid": f"GPU-{i}", "totalMi": 24576} for i in range(2)])
        self.assertEqual((probe["heads"], probe["hidden"], probe["layers"], probe["pipeline"]), (8, 1024, 32, True))

    def test_probe_import_and_model_errors_fail_closed_without_gpu_fallback(self):
        for details in ("Transformers does not recognize model type qwen4_exp", "ImportError: incompatible runtime module"):
            output = io.StringIO()
            failure = subprocess.CalledProcessError(1, [sys.executable], stderr=details)
            with self.subTest(details=details), patch.object(self.wrapper["subprocess"], "run", side_effect=failure), contextlib.redirect_stderr(output):
                with self.assertRaises(SystemExit) as raised:
                    self.wrapper["parallelism_probe"](["--model=fixture/small"])
                self.assertEqual(raised.exception.code, 2)
                self.assertIn("Could not validate the multi-GPU runtime/model", output.getvalue())
                self.assertIn(details, output.getvalue())

    def test_probe_timeout_and_malformed_output_are_errors_not_missing_capacity(self):
        for result in (subprocess.TimeoutExpired([sys.executable], 180), subprocess.CompletedProcess([], 0, "runtime output without a probe record", "")):
            with self.subTest(result=type(result).__name__), patch.object(self.wrapper["subprocess"], "run") as run, contextlib.redirect_stderr(io.StringIO()):
                if isinstance(result, Exception): run.side_effect = result
                else: run.return_value = result
                with self.assertRaises(SystemExit) as raised:
                    self.wrapper["parallelism_probe"](["--model=fixture/small"])
                self.assertEqual(raised.exception.code, 2)

    def test_unequal_card_capacities_use_a_native_worker_and_the_smallest_physical_ceiling(self):
        self.wrapper["collective_probe"] = lambda *_: True
        group = ["GPU-0", "GPU-1"]
        self.wrapper["parallelism_probe"] = lambda _: {"devices": [{"uuid": group[i], "totalMi": capacity} for i, capacity in enumerate((24576, 49152))],
            "heads": 8, "hidden": 1024, "layers": 32, "pipeline": True}
        self.wrapper["os"].environ.update(MAGICSTICK_GPU_UUIDS=",".join(group), MAGICSTICK_VLLM_PARALLELISM="auto",
            MAGICSTICK_COMPUTE_TARGET="nvidia-gpu", MAGICSTICK_VLLM_VRAM_LIMIT="12288Mi")
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--model=fixture/small", "--worker-cls=custom.Worker"]
        self.wrapper["configure_argv"]()
        self.assertIn("--worker-cls=budget_worker.BudgetWorker", self.wrapper["sys"].argv)
        self.assertNotIn("--worker-cls=custom.Worker", self.wrapper["sys"].argv)
        self.wrapper["os"].environ["MAGICSTICK_VLLM_VRAM_LIMIT"] = "30000Mi"
        with self.assertRaises(SystemExit): self.wrapper["configure_argv"]()

    def test_each_native_worker_gets_the_same_mib_budget_on_different_size_cards(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text())
        capacities = [24576 * 1048576, 49152 * 1048576]
        calls = []
        class NativeWorker:
            def init_device(self): calls.append((self.local_rank, self.cache_config.gpu_memory_utilization))
        torch = types.ModuleType("torch")
        torch.cuda = types.SimpleNamespace(set_device=lambda rank: None,
            get_device_properties=lambda rank: types.SimpleNamespace(total_memory=capacities[rank]))
        native = types.ModuleType("vllm.v1.worker.gpu_worker"); native.Worker = NativeWorker
        wrapper = types.ModuleType("wrapper"); wrapper.parse_mib = self.wrapper["parse_mib"]; wrapper.log = self.wrapper["log"]
        modules = {"torch": torch, "vllm": types.ModuleType("vllm"), "vllm.v1": types.ModuleType("vllm.v1"),
            "vllm.v1.worker": types.ModuleType("vllm.v1.worker"), "vllm.v1.worker.gpu_worker": native, "wrapper": wrapper}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"MAGICSTICK_VLLM_VRAM_LIMIT": "12288Mi"}):
            worker_module = {"__name__": "budget_worker"}
            exec(compile(manifest["data"]["budget_worker.py"], "budget_worker.py", "exec"), worker_module)
            for rank in range(2):
                worker = worker_module["BudgetWorker"]()
                worker.local_rank = rank; worker.parallel_config = types.SimpleNamespace(data_parallel_size=1)
                worker.cache_config = types.SimpleNamespace(gpu_memory_utilization=0.5, kv_cache_memory_bytes=None, num_gpu_blocks_override=None)
                worker.init_device()
                self.assertAlmostEqual(capacities[rank] * worker.cache_config.gpu_memory_utilization, 12288 * 1048576)
            self.assertEqual(calls, [(0, 0.5), (1, 0.25)])
            worker.cache_config.kv_cache_memory_bytes = 40000 * 1048576
            with self.assertRaises(ValueError): worker.init_device()
            worker.cache_config.kv_cache_memory_bytes = None; worker.cache_config.num_gpu_blocks_override = 999999
            with self.assertRaises(ValueError): worker.init_device()
            worker.cache_config.num_gpu_blocks_override = None; worker.local_rank = 0
            os.environ["MAGICSTICK_VLLM_VRAM_LIMIT"] = "30000Mi"
            with self.assertRaises(ValueError): worker.init_device()

    def test_cuda_uuid_format_without_nvidia_prefix_is_the_same_identity(self):
        ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"]
        self.wrapper["parallelism_probe"] = lambda _: {"devices": [{"uuid": value, "totalMi": 24000} for value in reversed(ids)],
            "heads": 8, "hidden": 1024, "layers": 32, "pipeline": True}
        args, _ = self.wrapper["configure_parallelism"]([], ["GPU-" + value for value in ids])
        self.assertIn("--tensor-parallel-size=2", args)

    def test_two_and_four_gpu_tensor_pipeline_and_auto_are_runtime_validated(self):
        self.wrapper["collective_probe"] = lambda *_: True
        for count in (1, 2, 4):
            for strategy in ("auto", "tensor", "pipeline"):
                group = [f"GPU-{i}" for i in range(count)]
                self.wrapper["parallelism_probe"] = lambda _: {"devices": [{"uuid": uuid, "totalMi": 24000} for uuid in group],
                    "heads": 16, "hidden": 2048, "layers": 32, "pipeline": True}
                self.wrapper["os"].environ.update(MAGICSTICK_GPU_UUIDS=",".join(group), MAGICSTICK_VLLM_PARALLELISM=strategy,
                    MAGICSTICK_COMPUTE_TARGET="nvidia-gpu", MAGICSTICK_VLLM_VRAM_LIMIT="12000Mi", MAGICSTICK_CPU_OFFLOAD_MI="1024")
                self.wrapper["sys"].argv[:] = ["wrapper.py", "--model=fixture/small", "--tensor-parallel-size=99", "-pp", "99"]
                self.wrapper["configure_argv"]()
                args = self.wrapper["sys"].argv
                self.assertIn(f"--tensor-parallel-size={1 if strategy == 'pipeline' else count}", args)
                self.assertIn(f"--pipeline-parallel-size={count if strategy == 'pipeline' else 1}", args)
                self.assertIn("--distributed-executor-backend=mp", args)
                self.assertIn("--gpu-memory-utilization=0.5000", args)
                self.assertIn("--cpu-offload-gb=1.000000", args)
                self.assertNotIn("99", args)

    def test_collective_fallback_requires_same_group_native_success_and_preserves_explicit_policy(self):
        group = ["GPU-0", "GPU-1", "GPU-2", "GPU-3"]
        calls = []
        def probe(expected, environment):
            calls.append((list(expected), environment.get("NCCL_P2P_DISABLE")))
            return environment.get("NCCL_P2P_DISABLE") == "1"
        self.wrapper["collective_probe"] = probe
        os.environ.pop("NCCL_P2P_DISABLE", None)
        result = self.wrapper["qualify_collectives"](["--model=fixture"], group)
        self.assertEqual(calls, [(group, None), (group, "1")])
        self.assertEqual(os.environ["NCCL_P2P_DISABLE"], "1")
        self.assertIn("--disable-custom-all-reduce", result)
        os.environ["NCCL_P2P_DISABLE"] = "0"
        calls.clear()
        with self.assertRaises(SystemExit): self.wrapper["qualify_collectives"]([], group)
        self.assertEqual(calls, [(group, "0")])
        os.environ.pop("NCCL_P2P_DISABLE")
        self.wrapper["collective_probe"] = lambda *_: False
        with self.assertRaises(SystemExit): self.wrapper["qualify_collectives"]([], group)
        self.assertNotIn("NCCL_P2P_DISABLE", os.environ)
        self.wrapper["collective_probe"] = lambda *_: self.fail("Independent copies do not use collectives")
        self.assertEqual(self.wrapper["qualify_collectives"](["fixture"], group[:1]), ["fixture"])

    def test_collective_success_keeps_native_transport_and_probe_has_hard_process_group_deadline(self):
        self.wrapper["collective_probe"] = lambda *_: True
        os.environ.pop("NCCL_P2P_DISABLE", None)
        self.assertEqual(self.wrapper["qualify_collectives"](["fixture"], ["GPU-0", "GPU-1"]), ["fixture"])
        self.assertNotIn("NCCL_P2P_DISABLE", os.environ)
        wrapper = load_wrapper()
        wrapper["__file__"] = "/fixture/wrapper.py"
        wrapper["collective_rendezvous_port"] = lambda: "29500"
        diagnostics=[]
        wrapper["collective_diagnostic"] = lambda output, code, environment, **details: diagnostics.append((output, code, details))
        from unittest.mock import MagicMock
        import time
        processes = [MagicMock(pid=12345 + rank) for rank in range(2)]
        for process in processes:
            process.poll.return_value = None
        with patch.object(subprocess, "Popen", side_effect=processes) as launch, patch.object(os, "killpg") as kill, \
                patch.object(time, "monotonic", side_effect=[0, 76, 76, 76, 76]):
            self.assertFalse(wrapper["collective_probe"](["GPU-0", "GPU-1"], {}))
            self.assertTrue(launch.call_args.kwargs["start_new_session"])
            self.assertEqual(launch.call_args.kwargs["env"]["MAGICSTICK_VLLM_WRAPPER_ENABLED"], "false")
            self.assertEqual([call.args[0] for call in kill.call_args_list], [12345, 12346])
            self.assertTrue(all(process.wait.call_args.kwargs["timeout"] == 10 for process in processes))
            self.assertTrue(all(not process.communicate.called for process in processes))
            self.assertEqual(diagnostics, [("", None, {"reason": "COLLECTIVE_PROBE_TIMEOUT"})])

    def test_collective_second_cleanup_timeout_is_recorded_and_never_starts_a_fallback(self):
        from unittest.mock import MagicMock
        import time
        wrapper = load_wrapper()
        wrapper["__file__"] = "/fixture/wrapper.py"
        wrapper["collective_rendezvous_port"] = lambda: "29500"
        diagnostics = []
        wrapper["collective_diagnostic"] = lambda output, code, environment, **details: diagnostics.append(details)
        processes = [MagicMock(pid=12345 + rank) for rank in range(2)]
        for process in processes:
            process.poll.return_value = None
            process.wait.side_effect = subprocess.TimeoutExpired("rank", 10)
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(subprocess, "Popen", side_effect=processes) as launch, patch.object(os, "killpg"), \
                patch.object(time, "monotonic", side_effect=[0, 76, 76, 76, 76]):
            with self.assertRaises(SystemExit) as stopped:
                wrapper["qualify_collectives"]([], ["GPU-0", "GPU-1"])
            self.assertEqual(stopped.exception.code, 2)
            self.assertEqual(launch.call_count, 2)  # No second pair / unsafe retry.
            self.assertNotIn("NCCL_P2P_DISABLE", os.environ)
            self.assertEqual(diagnostics, [{"reason": "COLLECTIVE_PROBE_CLEANUP_UNCONFIRMED", "cleanup_confirmed": False}])

    def test_collective_exit_races_partial_launch_and_missing_success_marker_fail_closed(self):
        from unittest.mock import MagicMock
        wrapper = load_wrapper()
        wrapper["__file__"] = "/fixture/wrapper.py"
        wrapper["collective_rendezvous_port"] = lambda: "29500"
        diagnostics = []
        wrapper["collective_diagnostic"] = lambda output, code, environment, **details: diagnostics.append(details)
        for failure, marker, expected in ((False, True, True), (False, False, False), (True, False, False)):
            launched = []
            def launch(command, **options):
                self.assertEqual(command[1], "/fixture/collective_probe.py")
                self.assertNotIn("torch.distributed.run", command)
                if failure and launched:
                    raise OSError("synthetic-sensitive-native-path")
                process = MagicMock(pid=12345 + len(launched))
                process.poll.return_value = process.wait.return_value = 0
                launched.append((process, options))
                if marker and len(launched) == 1:
                    os.write(options["stdout"], b"MAGICSTICK_COLLECTIVE_OK\n")
                return process
            with self.subTest(failure=failure, marker=marker), patch.object(subprocess, "Popen", launch), \
                    patch.object(os, "killpg", side_effect=ProcessLookupError):
                self.assertEqual(wrapper["collective_probe"](["GPU-0", "GPU-1"], {
                    "OMP_NUM_THREADS": "3", "TORCH_NCCL_ASYNC_ERROR_HANDLING": "0",
                    "TORCHELASTIC_USE_AGENT_STORE": "True", "TORCHELASTIC_RESTART_COUNT": "99"}), expected)
                self.assertEqual([options["env"]["RANK"] for _, options in launched], [str(rank) for rank in range(len(launched))])
                self.assertTrue(all(options["env"]["WORLD_SIZE"] == "2" for _, options in launched))
                self.assertTrue(all(options["env"]["OMP_NUM_THREADS"] == "3" for _, options in launched))
                self.assertTrue(all(options["env"]["TORCH_NCCL_ASYNC_ERROR_HANDLING"] == "0" for _, options in launched))
                self.assertTrue(all(options["env"]["TORCHELASTIC_USE_AGENT_STORE"] == "False" for _, options in launched))
                self.assertTrue(all(options["env"]["TORCHELASTIC_RESTART_COUNT"] == "0" for _, options in launched))
        self.assertEqual(diagnostics[-1]["reason"], "COLLECTIVE_PROBE_LAUNCH_FAILED")

    @unittest.skipUnless(os.name == "posix", "The shipped runtimes use POSIX process groups")
    def test_collective_owns_rank_descendants_and_does_not_wait_for_inherited_pipe_eof(self):
        import time
        wrapper = load_wrapper()
        diagnostics = []
        wrapper["collective_rendezvous_port"] = lambda: "29500"
        wrapper["collective_diagnostic"] = lambda output, code, environment, **details: diagnostics.append((output, details))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            wrapper["__file__"] = str(root / "wrapper.py")
            # Rank zero exits unsuccessfully while its descendant keeps stdout
            # open. Rank one also remains alive. The parent must kill BOTH owned
            # groups, reap their leaders and return without a communicate wait.
            (root / "collective_probe.py").write_text(
                "import os, subprocess, sys, time\n"
                "if os.environ['LOCAL_RANK'] == '0':\n"
                "    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
                "    print('synthetic-private-native-detail', flush=True)\n"
                "    sys.exit(1)\n"
                "time.sleep(30)\n"
            )
            launched, native_launch = [], subprocess.Popen
            def launch(*args, **kwargs):
                process = native_launch(*args, **kwargs)
                launched.append(process)
                return process
            started = time.monotonic()
            with patch.object(subprocess, "Popen", launch):
                self.assertFalse(wrapper["collective_probe"](["GPU-0", "GPU-1"], dict(os.environ)))
            self.assertLess(time.monotonic() - started, 5)
            self.assertTrue(all(process.returncode is not None for process in launched))
            self.assertIn("synthetic-private-native-detail", diagnostics[0][0])
            self.assertEqual(diagnostics[0][1]["reason"], "COLLECTIVE_PROBE_FAILED")

    @unittest.skipUnless(os.name == "posix", "The shipped runtimes use POSIX process groups")
    def test_collective_direct_launch_preserves_native_rank_contract_and_bounded_output(self):
        wrapper = load_wrapper()
        wrapper["collective_rendezvous_port"] = lambda: "29500"
        for count in (2, 4):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                wrapper["__file__"] = str(root / "wrapper.py")
                # Counterexample: only rank zero printing OK is not enough;
                # every rank must exit successfully under the exact same group.
                (root / "collective_probe.py").write_text(
                    "import os, sys\n"
                    "assert os.environ['RANK'] == os.environ['LOCAL_RANK']\n"
                    "assert os.environ['WORLD_SIZE'] == os.environ['LOCAL_WORLD_SIZE'] == str(len(sys.argv[1].split(',')))\n"
                    "assert os.environ['MASTER_ADDR'] == '127.0.0.1'\n"
                    "assert int(os.environ['MASTER_PORT']) > 0\n"
                    "if os.environ['RANK'] == '0':\n"
                    "    print('synthetic-private-noise' * 10000, flush=True)\n"
                    "    print('MAGICSTICK_COLLECTIVE_OK', flush=True)\n"
                    "sys.exit(1 if os.environ.get('FAIL_RANK') == os.environ['RANK'] else 0)\n"
                )
                group = [f"GPU-{rank}" for rank in range(count)]
                self.assertTrue(wrapper["collective_probe"](group, dict(os.environ)))
                captured = []
                wrapper["collective_diagnostic"] = lambda output, code, environment, **details: captured.append((output, details))
                self.assertFalse(wrapper["collective_probe"](group, {**os.environ, "FAIL_RANK": "1"}))
                self.assertLessEqual(len(captured[0][0]), 65536)

    def test_replicated_single_gpu_rejects_wrong_visible_identity_and_count(self):
        self.wrapper["os"].environ.update(MAGICSTICK_GPU_UUIDS="GPU-0", MAGICSTICK_GPU_COUNT="1",
            MAGICSTICK_COMPUTE_TARGET="nvidia-gpu", MAGICSTICK_VLLM_VRAM_LIMIT="12000Mi")
        self.wrapper["parallelism_probe"] = lambda _: {"devices": [{"uuid": "GPU-1", "totalMi": 24000}],
            "heads": 16, "hidden": 2048, "layers": 32, "pipeline": True}
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--model=fixture/small"]
        with self.assertRaises(SystemExit):
            self.wrapper["configure_argv"]()
        self.wrapper["os"].environ["MAGICSTICK_GPU_COUNT"] = "2"
        with self.assertRaises(SystemExit):
            self.wrapper["configure_argv"]()

    def test_group_probe_rejects_partial_cuda_placement_and_unsupported_models(self):
        good = {"devices": [{"uuid": "GPU-0", "totalMi": 24000}, {"uuid": "GPU-1", "totalMi": 24000}],
                "heads": 8, "hidden": 1024, "layers": 32, "pipeline": True}
        for changed in ({"devices": good["devices"][:1]}, {"devices": [good["devices"][0]]*2},
                        {"heads": 7, "pipeline": False}, {"hidden": 0, "layers": 1}):
            self.wrapper["parallelism_probe"] = lambda _, changed=changed: {**good, **changed}
            self.wrapper["os"].environ["MAGICSTICK_VLLM_PARALLELISM"] = "auto"
            with self.assertRaises(SystemExit): self.wrapper["configure_parallelism"]([], ["GPU-0", "GPU-1"])
        self.wrapper["parallelism_probe"] = lambda _: {**good, "heads": 7}
        args, _ = self.wrapper["configure_parallelism"]([], ["GPU-0", "GPU-1"])
        self.assertIn("--pipeline-parallel-size=2", args)

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

    def test_cpu_offload_budget_is_converted_to_gib_and_cannot_be_overridden(self):
        self.wrapper["os"].environ.update(MAGICSTICK_COMPUTE_TARGET="nvidia-gpu", MAGICSTICK_VLLM_VRAM_LIMIT="12000Mi", MAGICSTICK_CPU_OFFLOAD_MI="8192")
        self.wrapper["gpu_total_mib"] = lambda *_: 24000
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--cpu-offload-gb", "64", "--offload-backend=prefetch", "--offload-group-size=4"]
        self.wrapper["configure_argv"]()
        args = self.wrapper["sys"].argv
        self.assertIn("--cpu-offload-gb=8.000000", args)
        self.assertIn("--offload-backend=uva", args)
        self.assertIn("--offload-group-size=0", args)
        self.assertNotIn("64", args)
        self.assertIn("--gpu-memory-utilization=0.5000", args)

    def test_explicit_offloading_disabled_keeps_zero(self):
        self.wrapper["os"].environ.update(MAGICSTICK_COMPUTE_TARGET="nvidia-gpu", MAGICSTICK_VLLM_VRAM_LIMIT="12000Mi", MAGICSTICK_CPU_OFFLOAD_MI="0")
        self.wrapper["gpu_total_mib"] = lambda *_: 24000
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--cpu-offload-gb=16"]
        self.wrapper["configure_argv"]()
        self.assertIn("--cpu-offload-gb=0.000000", self.wrapper["sys"].argv)

    def test_cpu_target_starts_vllm_without_inspecting_nvidia(self):
        self.wrapper["os"].environ["MAGICSTICK_COMPUTE_TARGET"] = "cpu"
        self.wrapper["sys"].argv[:] = ["wrapper.py", "--max-model-len=2048", "--gpu-memory-utilization=0.9"]
        self.wrapper["subprocess"].run = lambda *_args, **_kwargs: self.fail("CPU target must not run nvidia-smi")

        self.wrapper["configure_argv"]()

        self.assertEqual(
            self.wrapper["sys"].argv,
            ["wrapper.py", "--max-model-len=2048", "--scheduling-policy", "priority"],
        )

    def test_cpu_threads_follow_the_real_container_quota_not_the_host_core_count(self):
        cases = [({"/sys/fs/cgroup/cpu.max": "800000 100000"}, 128, "7"),
                 ({"/sys/fs/cgroup/cpu.max": "150000 100000"}, 128, "1"),
                 ({"/sys/fs/cgroup/cpu.max": "max 100000"}, 128, None),
                 ({"/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "400000",
                   "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000"}, 64, "3"),
                 ({"/sys/fs/cgroup/cpu.max": "800000 100000"}, 4, None),
                 ({"/sys/fs/cgroup/cpu.max": "800000 0"}, 128, None), ({}, 128, None)]
        for files, cores, expected in cases:
            def read(path, **_):
                if str(path) not in files:
                    raise FileNotFoundError()
                return files[str(path)]
            with self.subTest(files=files, cores=cores), patch.dict(os.environ, {}, clear=True), \
                    patch.object(self.wrapper["Path"], "read_text", read), \
                    patch.object(os, "sched_getaffinity", lambda _: set(range(cores)), create=True):
                self.wrapper["configure_cpu_threads"]()
                self.assertEqual(os.environ.get("OMP_NUM_THREADS"), expected)
                self.assertEqual(os.environ.get("VLLM_CPU_OMP_THREADS_BIND"), "nobind" if expected else None)
        for override in ({"OMP_NUM_THREADS": "3"}, {"VLLM_CPU_OMP_THREADS_BIND": "0-15"},
                         {"VLLM_CPU_OMP_THREADS_BIND": "auto"}):
            with self.subTest(override=override), patch.dict(os.environ, override, clear=True), \
                    patch.object(self.wrapper["Path"], "read_text", side_effect=AssertionError("Explicit policy must not be replaced")):
                self.wrapper["configure_cpu_threads"]()
                self.assertEqual(dict(os.environ), override)

    def test_auto_cpu_startup_threads_do_not_disable_native_vllm_serving_thread_reduction(self):
        # The live failure was Ready + OMP_NUM_THREADS=7 in both EngineCore
        # and worker. Native 0.31 treats an unmarked value as user policy and
        # leaves both spin-waiting pools active under an eight-core CFS quota.
        for version, marker in (("0.31.0", "1"), ("0.32.0", "1"), ("0.30.0", None)):
            with self.subTest(version=version), patch.dict(os.environ, {}, clear=True), \
                    patch.object(self.wrapper["Path"], "read_text", return_value="800000 100000"), \
                    patch.object(os, "sched_getaffinity", return_value=set(range(128)), create=True), \
                    patch.dict(self.wrapper, {"runtime_version": lambda _: version}):
                self.wrapper["configure_cpu_threads"]()
                self.assertEqual(os.environ["OMP_NUM_THREADS"], "7")
                self.assertEqual(os.environ.get("VLLM_OMP_NUM_THREADS_SET_BY_VLLM"), marker)
                # Reproduce the selected upstream's actual serving decision:
                # explicit OMP values win; automatic startup pools can shrink.
                externally_set = os.environ.get("OMP_NUM_THREADS") is not None and \
                    os.environ.get("VLLM_OMP_NUM_THREADS_SET_BY_VLLM") != "1"
                self.assertEqual(7 if externally_set else 1, 1 if marker else 7)
        for policy in ({"OMP_NUM_THREADS": "5"}, {"VLLM_CPU_OMP_THREADS_BIND": "0-5"}):
            with patch.dict(os.environ, policy, clear=True):
                self.wrapper["configure_cpu_threads"]()
                self.assertEqual(dict(os.environ), policy)

    def test_native_collective_failures_retain_only_bounded_private_diagnostics(self):
        output="synthetic-private-detail-" * 8000
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as logged:
            self.wrapper["collective_diagnostic"](output, 2, {"NCCL_P2P_DISABLE":"1"}, directory)
            files=list(pathlib.Path(directory).glob("magicstick-nccl-*/probe.log"))
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].read_text(), output[-65536:])
            self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(files[0].parent.stat().st_mode & 0o777, 0o700)
            self.assertIn("exit=2", logged.getvalue())
            self.assertIn("transport=host-mediated", logged.getvalue())
            self.assertNotIn("synthetic-private-detail", logged.getvalue())
            marker = next(line.split("MAGICSTICK_STARTUP_DIAGNOSTIC=", 1)[1]
                for line in logged.getvalue().splitlines() if "MAGICSTICK_STARTUP_DIAGNOSTIC=" in line)
            self.assertEqual(json.loads(marker), {"version": 1, "stage": "collective-preflight",
                "reason": "COLLECTIVE_PROBE_FAILED", "transport": "host-mediated", "exitCode": 2,
                "cleanupConfirmed": True})
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            self.wrapper["collective_diagnostic"]("\U0001f512" * 70000, -9, {}, directory,
                reason="COLLECTIVE_PROBE_CLEANUP_UNCONFIRMED", cleanup_confirmed=False)
            retained = next(pathlib.Path(directory).glob("magicstick-nccl-*/probe.log"))
            self.assertLessEqual(retained.stat().st_size, 65536)
            self.assertTrue(retained.read_text())
        with patch.object(tempfile, "mkdtemp", side_effect=OSError("synthetic-private-path")), \
                contextlib.redirect_stdout(io.StringIO()) as logged:
            self.wrapper["collective_diagnostic"]("synthetic-sensitive-native-detail", None, {},
                reason="COLLECTIVE_PROBE_TIMEOUT")
            self.assertIn('"reason": "COLLECTIVE_PROBE_TIMEOUT"', logged.getvalue())
            self.assertNotIn("synthetic-", logged.getvalue())

    def test_collective_timeout_exposes_only_last_fixed_milestone_per_rank(self):
        marker = "MAGICSTICK_COLLECTIVE_PROGRESS="
        output = "synthetic-private-native-text\n" + "\n".join(marker + json.dumps(value) for value in [
            {"rank": 0, "stage": "import"}, {"rank": 0, "stage": "init", "uuid": "synthetic-private"},
            {"rank": 1, "stage": "assignment"}, {"rank": 16, "stage": "init"},
            {"rank": True, "stage": "init"}, {"rank": 2, "stage": "synthetic-private"},
            {"rank": 3, "stage": {}},
        ])
        expected = [{"rank": 0, "stage": "init"}, {"rank": 1, "stage": "assignment"}]
        self.assertEqual(self.wrapper["collective_progress"](output), expected)
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as logged:
            self.wrapper["collective_diagnostic"](output, None, {}, directory, reason="COLLECTIVE_PROBE_TIMEOUT")
            line = next(line for line in logged.getvalue().splitlines() if "MAGICSTICK_STARTUP_DIAGNOSTIC=" in line)
            data = json.loads(line.split("MAGICSTICK_STARTUP_DIAGNOSTIC=", 1)[1])
            self.assertEqual(data["progress"], expected)
            self.assertNotIn("synthetic-private", line)

    def test_native_probe_reports_import_assignment_and_init_before_a_stalled_collective(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text())
        namespace = {"__name__": "collective_probe_fixture"}
        exec(compile(manifest["data"]["collective_probe.py"], "collective_probe.py", "exec"), namespace)
        torch, dist = types.ModuleType("torch"), types.ModuleType("torch.distributed")
        torch.distributed = dist
        torch.cuda = types.SimpleNamespace(device_count=lambda: 2,
            get_device_properties=lambda i: types.SimpleNamespace(uuid=f"GPU-private-{i}"), set_device=lambda _: None)
        def stall(*_, **__):
            raise RuntimeError("synthetic-private-native-error")
        dist.init_process_group = stall
        with patch.dict(sys.modules, {"torch": torch, "torch.distributed": dist}), \
                patch.dict(os.environ, {"LOCAL_RANK": "1"}), \
                patch.object(sys, "argv", ["probe", "GPU-private-0,GPU-private-1"]), \
                contextlib.redirect_stdout(io.StringIO()) as logged:
            with self.assertRaises(RuntimeError):
                namespace["main"]()
        self.assertEqual(self.wrapper["collective_progress"](logged.getvalue()), [{"rank": 1, "stage": "init"}])
        self.assertNotIn("private", logged.getvalue())
        self.assertEqual([json.loads(line.split("=", 1)[1])["stage"] for line in logged.getvalue().splitlines()],
                         ["import", "assignment", "init"])

    def test_native_probe_uses_matching_float32_payloads_for_every_peer(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text())
        namespace = {"__name__": "collective_probe_fixture"}
        exec(compile(manifest["data"]["collective_probe.py"], "collective_probe.py", "exec"), namespace)
        for count in (2, 4):
            sent, received = [], []
            for rank in range(count):
                torch, dist = types.ModuleType("torch"), types.ModuleType("torch.distributed")
                torch.distributed = dist
                torch.float32, torch.int64 = "float32", "int64"

                class Tensor:
                    def __init__(self, shape, value, *, device, dtype=None):
                        self.shape, self.value, self.device = shape, value, device
                        # torch.full infers integer versus floating dtype from
                        # its fill value unless the caller explicitly owns it.
                        self.dtype = dtype or ("float32" if isinstance(value, float) else "int64")

                    def __eq__(self, expected):
                        return self.value == expected

                torch.full = Tensor
                torch.all = lambda result: types.SimpleNamespace(item=lambda: result)
                torch.cuda = types.SimpleNamespace(device_count=lambda: count,
                    get_device_properties=lambda i: types.SimpleNamespace(uuid=f"GPU-fixture-{i}"),
                    set_device=lambda _: None, synchronize=lambda: None)
                dist.init_process_group = lambda *_, **__: None
                dist.get_world_size = lambda: count
                dist.all_reduce = lambda value: setattr(value, "value", count * (count + 1) / 2)
                dist.barrier = dist.destroy_process_group = lambda: None

                def wire(value):
                    self.assertEqual((value.shape, value.device, value.dtype), ((1024,), "cuda", "float32"))

                def send(value, peer):
                    wire(value); sent.append((rank, peer))

                def recv(value, peer):
                    wire(value); received.append((peer, rank)); value.value = peer + 1

                dist.send, dist.recv = send, recv
                with self.subTest(count=count, rank=rank), \
                        patch.dict(sys.modules, {"torch": torch, "torch.distributed": dist}), \
                        patch.dict(os.environ, {"LOCAL_RANK": str(rank)}), \
                        patch.object(sys, "argv", ["probe", ",".join(f"GPU-fixture-{i}" for i in range(count))]), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    namespace["main"]()
                    self.assertIn('"stage": "complete"', output.getvalue())
            expected = {(source, target) for source in range(count) for target in range(count) if source != target}
            self.assertEqual(set(sent), expected)
            self.assertEqual(set(received), expected)
            self.assertEqual(len(sent), count * (count - 1))
            self.assertEqual(len(received), len(sent))

    def test_fp8_calibration_flags_follow_the_actual_runtime_without_changing_precision(self):
        self.wrapper["os"].environ["MAGICSTICK_COMPUTE_TARGET"] = "cpu"
        for version in ("0.23.0", "0.26.0", "0.28.0", "0.31.0", "0.31.0+cpu"):
            for flag in ("--calculate-kv-scales", "--no-calculate-kv-scales"):
                with self.subTest(version=version, flag=flag):
                    self.wrapper["runtime_version"] = lambda package, version=version: version
                    self.wrapper["sys"].argv[:] = ["wrapper.py", "--kv-cache-dtype=fp8", flag]
                    self.wrapper["configure_argv"]()
                    self.assertIn("--kv-cache-dtype=fp8", self.wrapper["sys"].argv)
                    self.assertEqual(flag in self.wrapper["sys"].argv, version in ("0.23.0", "0.26.0"))

    def test_unknown_runtime_does_not_silently_change_fp8_calibration(self):
        for failure in (self.wrapper["PackageNotFoundError"]("vllm"), "unknown"):
            def version(_):
                if isinstance(failure, Exception): raise failure
                return failure
            self.wrapper["runtime_version"] = version
            with self.subTest(failure=str(failure)), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.wrapper["normalize_legacy_cache_flags"](["--kv-cache-dtype=fp8", "--calculate-kv-scales"])

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

    def test_queue_policy_cannot_be_overridden_by_model_arguments(self):
        for supplied in (["--scheduling-policy", "fcfs"], ["--scheduling_policy=fcfs"]):
            with self.subTest(supplied=supplied):
                self.wrapper["os"].environ["MAGICSTICK_COMPUTE_TARGET"] = "cpu"
                self.wrapper["sys"].argv[:] = ["wrapper.py", *supplied]
                self.wrapper["configure_argv"]()
                self.assertEqual(self.wrapper["sys"].argv, ["wrapper.py", "--scheduling-policy", "priority"])

    def test_small_nvidia_budget_is_not_raised_to_five_percent(self):
        self.wrapper["os"].environ.update({
            "MAGICSTICK_COMPUTE_TARGET": "nvidia-gpu",
            "MAGICSTICK_VLLM_VRAM_LIMIT": "512Mi",
        })
        self.wrapper["sys"].argv[:] = ["wrapper.py"]
        self.wrapper["gpu_total_mib"] = lambda _target, _device: 24564

        self.wrapper["configure_argv"]()

        self.assertIn("--gpu-memory-utilization=0.0208", self.wrapper["sys"].argv)
        self.assertNotIn("--gpu-memory-utilization=0.0500", self.wrapper["sys"].argv)

    def test_zero_gpu_budget_is_rejected(self):
        self.wrapper["os"].environ.update({
            "MAGICSTICK_COMPUTE_TARGET": "nvidia-gpu",
            "MAGICSTICK_VLLM_VRAM_LIMIT": "0Mi",
        })

        with self.assertRaises(SystemExit) as raised:
            self.wrapper["configure_argv"]()

        self.assertEqual(raised.exception.code, 2)

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
        amd_images = yaml.safe_load((ROOT.parents[2] / "magicstick-operator/gpu-runtime-images.yaml").read_text(encoding="utf-8"))["data"]
        profiles = values["resourceProfiles"]

        self.assertEqual(images["magicstick-vllm-cpu"], "vllm/vllm-openai-cpu:v0.31.0@sha256:495c84fe30f3572b83a78100a1e8ba423dbb77fc532ecefebe114e6b77327bd9")
        self.assertEqual(images["magicstick-vllm-nvidia"], "vllm/vllm-openai:v0.31.0@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3")
        catalog = json.loads(yaml.safe_load((ROOT.parents[2] / "magicstick-operator" / "compute-target-catalog.yaml").read_text())["data"]["targets.json"])
        for engine in ("VLLM", "OLlama"):
            self.assertFalse(catalog["engines"][engine]["multiGpu"]["matchingCardsOnly"])
            self.assertTrue(catalog["engines"][engine]["multiGpu"]["sameNodeOnly"])
        self.assertNotIn("magicstick-vllm-amd", images)
        self.assertEqual(amd_images["vllm-amd"], "vllm/vllm-openai-rocm:v0.31.0@sha256:749f6f3f944f12af49966ac523c1f8573e4b229594b541954bd5f879b4496b1f")
        self.assertEqual(images["magicstick-vllm-intel"], "vllm/vllm-openai-xpu:v0.31.0@sha256:95ac815038c4b3537b173798bfe3b89bdf525a52bd653cd14d4deb01f1062be7")
        self.assertEqual(ollama_images["magicstick-ollama-cpu"], "ollama/ollama:0.40.3@sha256:adca95a12c2b386a8f9a995e7fa0600e187e3323b5e5522f5a6c3b1ec73eff99")
        self.assertEqual(ollama_images["magicstick-ollama-nvidia"], ollama_images["magicstick-ollama-cpu"])
        self.assertNotIn("magicstick-ollama-amd", ollama_images)
        self.assertEqual(amd_images["ollama-amd"], "ollama/ollama:0.40.3-rocm@sha256:8cd88596698ab3283fd2f11727f1ffeb1519508d83f3ec1d137a4979e7bb9b6d")
        self.assertNotIn("nvidia.com/gpu", profiles["magicstick-vllm-cpu"]["requests"])
        self.assertNotIn("nvidia.com/gpu", profiles["magicstick-vllm-cpu"]["limits"])
        self.assertEqual(profiles["magicstick-vllm-cpu-memory"]["requests"]["memory"], "16Mi")
        self.assertNotIn("cpu", profiles["magicstick-vllm-cpu-memory"]["requests"])
        self.assertNotIn("cpu", profiles["magicstick-vllm-cpu-memory"]["limits"])
        self.assertEqual(profiles["magicstick-ollama-cpu-memory"]["requests"]["memory"], "16Mi")
        self.assertNotIn("cpu", profiles["magicstick-ollama-cpu-memory"]["requests"])
        self.assertNotIn("cpu", profiles["magicstick-ollama-cpu-memory"]["limits"])
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
        cache_mounts = [patch["value"] for patch in patches
                        if patch["path"] == "/spec/containers/0/volumeMounts/-"
                        and patch.get("value", {}).get("name") == "ollama-model-cache"]
        self.assertEqual(len(cache_mounts), 1)
        self.assertEqual(cache_mounts[0]["mountPath"], "/root/.ollama")
        self.assertFalse(cache_mounts[0].get("readOnly", False))

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
            [str(module), "--max-model-len=2048", "--scheduling-policy", "priority"],
        )

    def test_sitecustomize_never_continues_with_unqualified_arguments_after_wrapper_failure(self):
        manifest = yaml.safe_load((ROOT / "vllm-wrapper-configmap.yaml").read_text())
        for fault in ("raise ImportError('synthetic-sensitive-import')\n",
                      "def configure_argv():\n    raise RuntimeError('synthetic-sensitive-runtime')\n"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory)
                (root/"sitecustomize.py").write_text(manifest["data"]["sitecustomize.py"])
                (root/"wrapper.py").write_text(fault)
                environment={**os.environ,"PYTHONPATH":directory,"TMPDIR":directory,
                             "MAGICSTICK_VLLM_WRAPPER_ENABLED":"true","MAGICSTICK_VLLM_WRAPPER_APPLIED":""}
                result=subprocess.run([sys.executable,"-c","print('UNQUALIFIED_RUNTIME_STARTED')"],
                                      capture_output=True,text=True,env=environment,timeout=10)
                self.assertEqual(result.returncode,2)
                self.assertNotIn("UNQUALIFIED_RUNTIME_STARTED",result.stdout)
                self.assertIn("WRAPPER_STARTUP",result.stderr)
                self.assertNotIn("synthetic-sensitive",result.stderr)
                files=list(root.glob("magicstick-vllm-startup-*/startup.log"))
                self.assertEqual(len(files),1)
                self.assertIn("synthetic-sensitive",files[0].read_text())
                self.assertEqual(files[0].stat().st_mode & 0o777,0o600)
                self.assertEqual(files[0].parent.stat().st_mode & 0o777,0o700)

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
