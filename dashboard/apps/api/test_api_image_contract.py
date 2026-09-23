# SPDX-License-Identifier: BUSL-1.1
"""Packaging guard for the single license-gated dashboard API image."""
import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]


class ApiImageContractTests(unittest.TestCase):
    def test_dockerfile_builds_one_combined_runtime(self):
        dockerfile = (ROOT / "dashboard/apps/api/Dockerfile").read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r"^FROM\s+", dockerfile, re.MULTILINE)), 1)
        self.assertIn("COPY core/magicstick_core ./magicstick_core", dockerfile)
        self.assertIn("COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /licenses/", dockerfile)
        self.assertIn("COPY licenses /licenses/licenses", dockerfile)
        self.assertIn("dashboard/apps/api/federated_sso.py", dockerfile)
        self.assertIn('org.opencontainers.image.licenses="BUSL-1.1"', dockerfile)
        self.assertNotRegex(dockerfile, r"\bAS\s+(community|enterprise)\b")

    def test_ci_publishes_only_the_combined_api_runtime(self):
        workflow = (ROOT / ".github/workflows/build-dashboard-image.yml").read_text(encoding="utf-8")
        self.assertEqual(workflow.count("file: dashboard/apps/api/Dockerfile"), 1)
        self.assertNotRegex(workflow, r"(?m)^\s*target:\s*(community|enterprise)\s*$")
        self.assertIn("org.opencontainers.image.licenses=BUSL-1.1", workflow)
        self.assertIn("type=raw,value=api-licensing-v1", workflow)

    def test_core_package_has_consistent_spdx_and_no_feature_registry(self):
        package = ROOT / "core/magicstick_core"
        for source in package.rglob("*.py"):
            self.assertTrue(source.read_text(encoding="utf-8").startswith(
                "# SPDX-License-Identifier: BUSL-1.1"
            ))
        init = (package / "__init__.py").read_text(encoding="utf-8")
        self.assertNotIn('CAPABILITIES', init)

    def test_mesh_image_has_notices_but_no_license_verifier_or_test_fixtures(self):
        source = (ROOT / 'magic-cluster/apps/ai/private-mesh/Dockerfile').read_text()
        self.assertIn('COPY core/magicstick_core ./magicstick_core', source)
        self.assertNotIn('mesh_license.py', source)
        self.assertNotIn('dashboard/apps/api/licensing.py', source)
        self.assertIn('COPY licenses /usr/local/share/licenses/licenses', source)
        self.assertIn('org.opencontainers.image.licenses="BUSL-1.1"', source)
        self.assertNotIn('COPY test', source)
        self.assertNotIn('test_support', source)


if __name__ == "__main__":
    unittest.main()
