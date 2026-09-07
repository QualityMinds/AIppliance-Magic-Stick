# SPDX-License-Identifier: MIT
"""Packaging guard for the single license-gated dashboard API image."""
import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]


class ApiImageContractTests(unittest.TestCase):
    def test_dockerfile_builds_one_combined_runtime(self):
        dockerfile = (ROOT / "dashboard/apps/api/Dockerfile").read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r"^FROM\s+", dockerfile, re.MULTILINE)), 1)
        self.assertIn("COPY enterprise/magicstick_enterprise ./magicstick_enterprise", dockerfile)
        self.assertIn("COPY LICENSE /licenses/MagicStick-MIT", dockerfile)
        self.assertIn("COPY enterprise/LICENSE /licenses/MagicStick-Enterprise", dockerfile)
        self.assertIn("dashboard/apps/api/federated_sso.py", dockerfile)
        self.assertIn('org.opencontainers.image.licenses="MIT AND LicenseRef-MagicStick-Enterprise"', dockerfile)
        self.assertNotRegex(dockerfile, r"\bAS\s+(community|enterprise)\b")

    def test_ci_publishes_only_the_combined_api_runtime(self):
        workflow = (ROOT / ".github/workflows/build-dashboard-image.yml").read_text(encoding="utf-8")
        self.assertEqual(workflow.count("file: dashboard/apps/api/Dockerfile"), 1)
        self.assertNotRegex(workflow, r"(?m)^\s*target:\s*(community|enterprise)\s*$")
        self.assertIn("org.opencontainers.image.licenses=MIT AND LicenseRef-MagicStick-Enterprise", workflow)
        self.assertIn("type=raw,value=api-licensing-v1", workflow)

    def test_enterprise_package_has_a_bounded_declared_capability(self):
        package = ROOT / "enterprise/magicstick_enterprise"
        for source in package.glob("*.py"):
            self.assertTrue(source.read_text(encoding="utf-8").startswith(
                "# SPDX-License-Identifier: LicenseRef-MagicStick-Enterprise"
            ))
        init = (package / "__init__.py").read_text(encoding="utf-8")
        self.assertIn('CAPABILITIES = frozenset({"resource-sharing", "federated-sso"})', init)


if __name__ == "__main__":
    unittest.main()
