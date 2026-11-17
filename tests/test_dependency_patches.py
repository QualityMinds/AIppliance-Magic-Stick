# SPDX-License-Identifier: BUSL-1.1
"""SEC-03 local patch integrity/behavior; not a replacement for registry audit."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "dashboard"


class DependencyPatchTests(unittest.TestCase):
    def test_actual_matcher_counterexamples_and_compatible_globs(self):
        result = subprocess.run(["node", "--test", "tests/picomatch-security.test.cjs"], cwd=DASHBOARD,
                                capture_output=True, text=True, timeout=40, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("GHSA-fc5q-39xc-vjpf single-branch repeated extglob ReDoS is bounded", result.stdout)

    def test_every_locked_consumer_uses_the_exact_patch(self):
        workspace = yaml.safe_load((DASHBOARD / "pnpm-workspace.yaml").read_text())
        lock = yaml.safe_load((DASHBOARD / "pnpm-lock.yaml").read_text())
        patch = DASHBOARD / workspace["patchedDependencies"]["picomatch@4.0.7"]
        digest = hashlib.sha256(patch.read_bytes()).hexdigest()
        self.assertEqual(lock["patchedDependencies"], {"picomatch@4.0.7": digest})
        attributes = (ROOT / ".gitattributes").read_text()
        self.assertIn("dashboard/patches/*.patch text eol=lf -whitespace", attributes)
        self.assertIn("picomatch@4.0.7(patch_hash=" + digest + ")", lock["snapshots"])
        consumers = []
        for name, snapshot in lock["snapshots"].items():
            for dependencies in (snapshot.get("dependencies", {}), snapshot.get("optionalDependencies", {})):
                if "picomatch" in dependencies:
                    consumers.append(name)
                    self.assertEqual(dependencies["picomatch"], "4.0.7(patch_hash=" + digest + ")", name)
        self.assertGreater(len(consumers), 0)
        self.assertEqual(lock["importers"]["apps/web"]["devDependencies"]["vite"],
                         lock["importers"]["apps/cli"]["devDependencies"]["vite"])
        self.assertEqual(lock["packages"]["picomatch@4.0.7"]["resolution"]["integrity"],
                         "sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==")

    def test_build_contexts_include_patch_before_frozen_install(self):
        for component in ("web", "cli"):
            with self.subTest(component=component):
                source = (DASHBOARD / "apps" / component / "Dockerfile").read_text()
                self.assertLess(source.index("COPY dashboard/patches patches"), source.index("RUN pnpm install --frozen-lockfile"))
        runner = (DASHBOARD / "apps/web/regression/Dockerfile").read_text()
        copied_inputs = runner.split("cp -a --parents dashboard", 1)[1].split("/opt/magicstick/", 1)[0]
        self.assertIn(".gitattributes", copied_inputs.split())
        self.assertLess(runner.index("cp -a --parents dashboard"), runner.index("pnpm install --frozen-lockfile"))
        package = json.loads((DASHBOARD / "package.json").read_text())
        self.assertTrue(package["scripts"]["test"].startswith("pnpm test:dependency-patches && "))
        owning = (DASHBOARD / "apps/web/regression/administration/owning.unit.spec.ts").read_text()
        supply_chain = owning.split("'supply-chain':", 1)[1].split("forms:", 1)[0]
        self.assertIn("test_dependency_patches.DependencyPatchTests", supply_chain)

    def test_registry_security_gate_is_not_replaced_or_suppressed(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/dependency-security.yml").read_text())
        steps = workflow["jobs"]["advisories"]["steps"]
        audit = next(step for step in steps if step.get("name") == "Query current registry advisories")
        self.assertEqual(audit["run"], "pnpm audit --audit-level high")
        for filename in ("package.json", "pnpm-workspace.yaml"):
            source = (DASHBOARD / filename).read_text()
            for suppressed in ("auditConfig", "ignoreCves", "ignoreGhsas", "ignoreUnfixable"):
                self.assertNotIn(suppressed, source)


if __name__ == "__main__":
    unittest.main()
