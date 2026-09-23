# SPDX-License-Identifier: BUSL-1.1
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "magic-cluster/platform/basis/kdns/image/Dockerfile"
DECLARATION = b"This project is licensed under the [MIT License](LICENSE)."
README = b"# kdns fixture\n\n<h2>License</h2>\n\n" + DECLARATION + b"\n"


class KdnsLicenseTests(unittest.TestCase):
    def evidence_command(self):
        # Exercise the actual image recipe, not a second implementation of its policy.
        lines = DOCKERFILE.read_text().splitlines()
        start = lines.index("RUN set -eu; \\")
        command = []
        for line in lines[start:]:
            command.append(line)
            if not line.endswith("\\"):
                break
        return "\n".join(command).removeprefix("RUN ")

    def prepare_evidence(self, files):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, content in files.items():
                (root / name).write_bytes(content)
            result = subprocess.run(
                ["sh", "-ec", self.evidence_command()], cwd=root,
                env={**os.environ, "KDNS_REF": "fixture-revision"},
                capture_output=True, text=True, check=False,
            )
            evidence = {path.name: path.read_bytes()
                        for path in (root / ".magicstick-license-evidence").glob("*")}
            return result, evidence

    def test_nonempty_license_and_readme_are_preserved_verbatim(self):
        notice = b"Original upstream notice fixture.\n"
        result, evidence = self.prepare_evidence({"LICENSE": notice, "README.md": README})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(evidence["LICENSE"], notice)
        self.assertEqual(evidence["README.md"], README)
        self.assertNotIn("WARNING", result.stderr)
        self.assertNotIn("MAGICSTICK-NOTICE.txt", evidence)

    def test_nonempty_license_does_not_require_readme(self):
        result, evidence = self.prepare_evidence({"LICENSE": b"Upstream notice fixture.\n"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("LICENSE", evidence)
        self.assertNotIn("README.md", evidence)

    def test_empty_license_with_explicit_mit_declaration_warns_but_builds(self):
        result, evidence = self.prepare_evidence({"LICENSE": b"", "README.md": README})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(evidence["LICENSE"], b"")
        self.assertEqual(evidence["README.md"], README)
        warning = evidence["MAGICSTICK-NOTICE.txt"].decode()
        self.assertIn("WARNING: kdns LICENSE is empty or missing", warning)
        self.assertIn("not legal approval", warning)
        self.assertEqual(result.stderr, warning)

    def test_missing_license_with_explicit_mit_declaration_warns_but_builds(self):
        result, evidence = self.prepare_evidence({"README.md": README})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(evidence["README.md"], README)
        self.assertNotIn("LICENSE", evidence)  # Never invent an upstream notice.
        self.assertIn("WARNING", result.stderr)

    def test_empty_license_without_declaration_fails(self):
        result, _ = self.prepare_evidence({"LICENSE": b"", "README.md": b"# kdns\n"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR: kdns has neither", result.stderr)

    def test_missing_license_and_readme_fail(self):
        result, _ = self.prepare_evidence({})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR: kdns has neither", result.stderr)

    def test_unrelated_mit_mention_is_not_a_project_declaration(self):
        result, _ = self.prepare_evidence({"README.md": b"A dependency uses the MIT License.\n"})
        self.assertNotEqual(result.returncode, 0)

    def test_build_evidence_records_upstream_revision(self):
        result, evidence = self.prepare_evidence({"README.md": README})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(evidence["UPSTREAM.txt"],
                         b"Upstream repository: lab42/kdns\nRevision: fixture-revision\n")

    def test_final_image_retains_evidence_directory(self):
        self.assertIn(
            "COPY --from=build /src/.magicstick-license-evidence/ /usr/share/licenses/kdns/",
            DOCKERFILE.read_text(),
        )
        self.assertNotIn("RUN test -s LICENSE", DOCKERFILE.read_text())

    def test_readme_fallback_matches_verified_upstream_declaration(self):
        manifest = json.loads((ROOT / "licenses/upstream-evidence.json").read_text())
        kdns = next(item for item in manifest["components"] if item["id"] == "kdns")
        readme = next(item for item in kdns["files"] if item["path"] == "README.md")
        self.assertEqual(readme["requiredText"], DECLARATION.decode())
        self.assertIn(readme["requiredText"], self.evidence_command())
        self.assertIn("ARG KDNS_REF=" + kdns["revision"], DOCKERFILE.read_text())

    def test_ci_runs_evidence_tests(self):
        for name in ["build-kdns-image", "license-audit", "public-release-checks"]:
            with self.subTest(workflow=name):
                text = (ROOT / ".github/workflows" / (name + ".yml")).read_text()
                self.assertIn("-m unittest", text)
                self.assertIn("tests/test_license_kdns.py", text)


if __name__ == "__main__":
    unittest.main()
