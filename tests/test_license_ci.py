# SPDX-License-Identifier: BUSL-1.1
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from license_ci import license_category, markdown_report, summarize_sbom, upstream_checks
from license_audit import references_checksum

ROOT = Path(__file__).resolve().parents[1]


class LicenseCiTests(unittest.TestCase):
    def evidence_fixture(self, root):
        (root / "licenses").mkdir()
        (root / "build.txt").write_text("upstream-ref: " + "a" * 40)
        readme = b"This project is licensed under the [MIT License](LICENSE)."
        item = {"id": "example", "repository": "https://github.com/example/project", "revision": "a" * 40,
                "declaredLicense": "MIT", "distributionReview": "incomplete-notice-evidence",
                "binding": {"file": "build.txt", "text": "a" * 40},
                "files": [{"path": "README.md", "sha256": hashlib.sha256(readme).hexdigest(),
                           "bytes": len(readme), "requiredText": "MIT License"},
                          {"path": "LICENSE", "sha256": hashlib.sha256(b"").hexdigest(), "bytes": 0}]}
        manifest = {"schemaVersion": 1, "components": [item]}
        (root / "licenses/upstream-evidence.json").write_text(json.dumps(manifest))
        return lambda url: readme if url.endswith("README.md") else b""

    def test_mit_declaration_and_empty_notice_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = upstream_checks(root, self.evidence_fixture(root))
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["components"][0]["declaredLicense"], "MIT")
            self.assertEqual(result["components"][0]["distributionReview"], "incomplete-notice-evidence")
            self.assertIn("not-distribution-approval", result["status"])

    def test_upstream_change_or_missing_declaration_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.evidence_fixture(root)
            result = upstream_checks(root, lambda url: b"different")
            self.assertTrue(any("changed" in item for item in result["errors"]))
            self.assertTrue(any("declaration missing" in item for item in result["errors"]))

    def test_unavailable_upstream_is_not_a_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.evidence_fixture(root)
            def offline(url):
                raise OSError("network unavailable")
            self.assertTrue(upstream_checks(root, offline)["errors"])

    def test_evidence_must_follow_build_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fetcher = self.evidence_fixture(root)
            (root / "build.txt").write_text("new revision")
            self.assertTrue(any("pin changed" in item for item in upstream_checks(root, fetcher)["errors"]))

    def test_new_upstream_notice_requires_manual_review_not_automatic_clearance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fetcher = self.evidence_fixture(root)
            path = root / "licenses/upstream-evidence.json"
            manifest = json.loads(path.read_text())
            manifest["components"][0]["noticeWatch"] = {
                "ref": "main", "path": "LICENSE", "sha256": hashlib.sha256(b"").hexdigest(), "bytes": 0}
            path.write_text(json.dumps(manifest))
            result = upstream_checks(root, lambda url: b"New upstream notice" if "/main/" in url else fetcher(url))
            self.assertTrue(any("upstream notice changed" in item for item in result["errors"]))
            self.assertEqual(result["components"][0]["distributionReview"], "incomplete-notice-evidence")

    def test_missing_and_nonstandard_licenses_require_review(self):
        for value in [[], ["UNKNOWN"], ["NOASSERTION"], ["NONE"], [""]]:
            self.assertEqual(license_category(value), "missing-license-evidence")
        self.assertEqual(license_category(["invented-license"]), "expression-review")

    def test_special_licenses_never_pass_as_permissive(self):
        for value in ["AGPL-3.0-only", "GPL-2.0-or-later", "LGPL-2.1-only", "MPL-2.0"]:
            self.assertEqual(license_category([value]), "copyleft-review")
        for value in ["SSPL-1.0", "Elastic-2.0", "MIT AND Commons-Clause", "PolyForm-Noncommercial-1.0.0",
                      "BUSL-1.1", "LicenseRef-Custom", "proprietary"]:
            self.assertEqual(license_category([value]), "restricted-or-custom-review")

    def test_compound_expressions_and_exceptions_are_not_simplified(self):
        self.assertEqual(license_category(["MIT OR Apache-2.0"]), "expression-review")
        self.assertEqual(license_category(["MIT OR GPL-3.0-only"]), "copyleft-review")
        self.assertEqual(license_category(["GPL-2.0-or-later WITH Bootloader-exception"]), "copyleft-review")
        self.assertEqual(license_category(["MIT", "Apache-2.0"]), "notice-review")

    def document(self):
        return {"descriptor": {"name": "syft", "version": "1.52.0"},
                "source": {"metadata": {"imageID": "sha256:fixture", "architecture": "amd64", "os": "linux",
                                         "config": {"Env": ["FIXTURE_SECRET=do-not-copy"]}}},
                "artifacts": [{"name": "example", "type": "python", "version": "1.0",
                               "purl": "pkg:pypi/example@1.0", "licenses": [{"spdxExpression": "MIT"}]}]}

    def test_report_records_exact_identity_without_environment_or_history(self):
        result = summarize_sbom(self.document(), "fixture")
        self.assertEqual(result["packageCount"], 1)
        self.assertEqual(result["reviewCounts"], {"notice-review": 1})
        self.assertEqual(result["sourceIdentity"]["imageID"], "sha256:fixture")
        self.assertNotIn("FIXTURE_SECRET", json.dumps(result))
        self.assertIn("not distribution approval", markdown_report(result))

    def test_empty_or_malformed_sbom_fails_closed(self):
        for value in [{}, {"artifacts": []}, {"artifacts": "bad"}, {"artifacts": [{}]}]:
            with self.assertRaises(ValueError):
                summarize_sbom(value, "fixture")

    def test_missing_license_is_visible_in_package_inventory(self):
        document = self.document()
        document["artifacts"][0]["licenses"] = []
        result = summarize_sbom(document, "fixture")
        self.assertEqual(result["reviewCounts"], {"missing-license-evidence": 1})

    def test_dependency_digest_ignores_line_numbers_not_changed_references(self):
        before = [{"file": "sample.yaml", "line": 1, "reference": "image: example:1"}]
        after = copy.deepcopy(before)
        after[0]["line"] = 100
        self.assertEqual(references_checksum(before), references_checksum(after))
        after[0]["reference"] = "image: example:2"
        self.assertNotEqual(references_checksum(before), references_checksum(after))

    def test_ci_is_scheduled_read_only_and_keeps_strict_review_opt_in(self):
        text = (ROOT / ".github/workflows/license-audit.yml").read_text()
        self.assertIn("23 4 * * 1", text)
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("pull_request:", text)
        self.assertIn("contents: read", text)
        self.assertNotIn("pull_request_target", text)
        self.assertNotIn("packages: write", text)
        self.assertNotIn("continue-on-error", text)
        self.assertIn("tools/license_audit.py --release", text)
        self.assertIn("tools/license_audit.py --review", text)
        self.assertIn("if: always()", text)
        self.assertIn("architecture: [amd64, arm64]", text)
        import yaml
        workflow = yaml.load(text, Loader=yaml.BaseLoader)
        option = workflow["on"]["workflow_dispatch"]["inputs"]["strict_release_review"]
        self.assertEqual(option["type"], "boolean")
        self.assertEqual(option["default"], "false")
        step = workflow["jobs"]["release-readiness"]["steps"][-1]
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.strict_release_review",
                      step["env"]["STRICT_RELEASE_REVIEW"])
        self.assertIn('if [ "$STRICT_RELEASE_REVIEW" = true ]', step["run"])
        self.assertIn('if [ "$result" != success ]', step["run"])

    def test_audit_uses_workspace_pinned_package_manager(self):
        import yaml
        workflow = yaml.safe_load((ROOT / ".github/workflows/license-audit.yml").read_text())
        install = next(step for step in workflow["jobs"]["source"]["steps"]
                       if step.get("name") == "Install frozen audit dependencies without package scripts")
        self.assertEqual(install["working-directory"], "dashboard")
        self.assertIn("pnpm install --frozen-lockfile --ignore-scripts", install["run"])
        self.assertNotIn("pnpm --dir", install["run"])

    def test_release_scan_never_persists_checkout_credentials(self):
        import yaml
        workflow = yaml.safe_load((ROOT / ".github/workflows/public-release-checks.yml").read_text())
        steps = workflow["jobs"]["release-checks"]["steps"]
        checkout = next(step for step in steps if step.get("uses", "").startswith("actions/checkout@"))
        self.assertIs(checkout["with"]["persist-credentials"], False)
        scan = next(step for step in steps if step.get("name") == "Secret scan current tree")
        self.assertIn("--redact", scan["run"])
        self.assertIn("--report-path", scan["run"])
        report = next(step for step in steps if step.get("name") == "Report secret-scan locations without matched values")
        self.assertIn("[.File, .StartLine, .RuleID]", report["run"])
        self.assertNotIn(".Secret", report["run"])
        self.assertNotIn(".Match", report["run"])

    def test_kdns_false_positive_exception_is_exact_and_rule_scoped(self):
        import re
        import tomllib
        config = tomllib.loads((ROOT / ".gitleaks.toml").read_text())
        self.assertTrue(config["extend"]["useDefault"])
        rule = next(item for item in config["rules"] if item["id"] == "sourcegraph-access-token")
        self.assertNotIn("regex", rule)  # Inherit the upstream detector unchanged.
        self.assertEqual(len(rule["allowlists"]), 1)
        exception = rule["allowlists"][0]
        self.assertEqual(exception["condition"], "AND")
        self.assertEqual(exception["regexTarget"], "line")
        line = (ROOT / "licenses/kdns-dependency-evidence.json").read_text().splitlines()[2]
        pattern = exception["regexes"][0]
        self.assertIsNotNone(re.fullmatch(pattern, line))
        self.assertIsNone(re.fullmatch(pattern, line.replace("f956", "aaaa")))
        self.assertIsNone(re.fullmatch(pattern, line + ' "token": "unexpected"'))
        path = exception["paths"][0]
        self.assertIsNotNone(re.search(path, "licenses/kdns-dependency-evidence.json"))
        self.assertIsNone(re.search(path, "licenses/different-file.json"))


if __name__ == "__main__":
    unittest.main()
