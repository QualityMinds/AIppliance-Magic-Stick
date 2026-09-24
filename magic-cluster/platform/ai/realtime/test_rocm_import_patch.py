# SPDX-License-Identifier: BUSL-1.1
"""No GPU dependencies: exercise the actual guard and fail-closed source repair."""
import ast
import builtins
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from image import patch_rocm_import as repair


# Synthetic import fixture, not copied upstream source or hardware evidence.
SOURCE = repair.ANCHOR + b'''    try:
        from vllm.device_allocator.cumem import CuMemAllocator
    except ImportError:
        return
    CuMemAllocator.patched = True
'''


class RocmImportPatchTests(unittest.TestCase):
    def setUp(self):
        self.hash_patch = patch.object(repair, "UPSTREAM_SHA256", hashlib.sha256(SOURCE).hexdigest())
        self.hash_patch.start()
        self.addCleanup(self.hash_patch.stop)

    def invoke(self, hip=None, cuda=None, failure=None):
        source = repair.patch_source(SOURCE)
        ast.parse(source)
        allocator = SimpleNamespace(patched=False)
        imports = []

        def load(name, *args, **kwargs):
            imports.append(name)
            self.assertEqual(name, "vllm.device_allocator.cumem")
            if failure:
                raise failure
            return SimpleNamespace(CuMemAllocator=allocator)

        namespace = {"torch": SimpleNamespace(version=SimpleNamespace(hip=hip, cuda=cuda)),
                     "__builtins__": {**vars(builtins), "__import__": load}}
        exec(compile(source, "reviewed-fixture.py", "exec"), namespace)
        namespace["_patch_cumem_free_callback_cuda"]()
        return imports, allocator

    def test_hip_does_not_import_cuda_allocator_without_a_gpu(self):
        imports, allocator = self.invoke(hip="7.2", failure=AssertionError("libcudart unavailable"))
        self.assertEqual(imports, [])
        self.assertFalse(allocator.patched)

    def test_cpu_does_not_import_cuda_allocator(self):
        imports, allocator = self.invoke(failure=AssertionError("libcudart unavailable"))
        self.assertEqual(imports, [])
        self.assertFalse(allocator.patched)

    def test_cuda_still_applies_its_shutdown_repair(self):
        imports, allocator = self.invoke(cuda="13.0")
        self.assertEqual(imports, ["vllm.device_allocator.cumem"])
        self.assertTrue(allocator.patched)

    def test_cuda_import_errors_are_not_hidden(self):
        with self.assertRaisesRegex(AssertionError, "libcudart unavailable"):
            self.invoke(cuda="13.0", failure=AssertionError("libcudart unavailable"))

    def test_repair_is_idempotent_and_unknown_source_fails_closed(self):
        updated = repair.patch_source(SOURCE)
        self.assertNotEqual(updated, SOURCE)
        self.assertEqual(repair.patch_source(updated), updated)
        for unknown in (SOURCE + b"# drift\n", updated + b"# drift\n", SOURCE * 2):
            with self.subTest(source=unknown), self.assertRaisesRegex(ValueError, "Unreviewed"):
                repair.patch_source(unknown)

    def test_cli_target_is_modified_only_after_hash_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "vllm_omni/patch.py"
            path.parent.mkdir()
            path.write_bytes(SOURCE)
            self.assertTrue(repair.apply(root))
            updated = path.read_bytes()
            self.assertFalse(repair.apply(root))
            self.assertEqual(path.read_bytes(), updated)
            drifted = updated + b"# unreviewed change\n"
            path.write_bytes(drifted)
            with self.assertRaises(ValueError):
                repair.apply(root)
            self.assertEqual(path.read_bytes(), drifted)


if __name__ == "__main__":
    unittest.main()
