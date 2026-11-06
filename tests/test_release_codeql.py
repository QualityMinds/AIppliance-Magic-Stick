# SPDX-License-Identifier: BUSL-1.1
import copy
import unittest
from tools import release_codeql as gate

SHA = "a" * 40


class ReleaseCodeQLTests(unittest.TestCase):
    def setUp(self):
        self.main = SHA
        self.runs = [{"id": 12, "run_attempt": 1, "head_sha": SHA, "head_branch": "main", "event": "dynamic",
            "head_repository": {"full_name": gate.product.catalog.REPOSITORY}, "path": "dynamic/github-code-scanning/codeql",
            "status": "completed", "conclusion": "success"}]
        self.jobs = {"total_count": 4, "jobs": [{"name": "Analyze (" + name + ")", "status": "completed", "conclusion": "success"} for name in gate.LANGUAGES]}
        self.analyses = [{"id": i, "commit_sha": SHA, "ref": "refs/heads/main", "tool": {"name": "CodeQL"},
            "category": "/language:" + name, "error": "", "rules_count": 30} for i, name in enumerate(gate.LANGUAGES, 1)]
        self.alerts = []
        self.calls = []

    def api(self, path):
        self.calls.append(path)
        if path.endswith("/git/ref/heads/main"): return {"object": {"sha": self.main}}
        if "/actions/runs?" in path: return {"workflow_runs": copy.deepcopy(self.runs)}
        if "/attempts/1/jobs?" in path: return copy.deepcopy(self.jobs)
        if "/code-scanning/analyses?" in path: return copy.deepcopy(self.analyses)
        if "/code-scanning/alerts?" in path: return copy.deepcopy(self.alerts)
        raise AssertionError(path)

    def test_exact_current_native_analyses_and_no_open_findings(self):
        proof = gate.verify(SHA, self.api)
        self.assertEqual(proof["openAlerts"], 0)
        self.assertEqual(set(proof["analyses"]), gate.LANGUAGES)
        self.assertEqual(sum(path.endswith("/git/ref/heads/main") for path in self.calls), 2)
        self.assertTrue(any("state=open" in path for path in self.calls))

    def test_main_move_or_foreign_attempt_never_reuses_old_findings(self):
        self.main = "b" * 40
        with self.assertRaisesRegex(gate.product.ReleaseFailure, "advanced"): gate.verify(SHA, self.api)
        self.main = SHA
        self.runs[0]["head_repository"]["full_name"] = "other/project"
        with self.assertRaises(gate.Pending): gate.verify(SHA, self.api)

    def test_latest_failed_cancelled_or_pending_attempt_blocks_even_with_old_analyses(self):
        for status, conclusion in (("in_progress", None), ("completed", "failure"), ("completed", "cancelled"), ("completed", "neutral")):
            self.runs.append({**self.runs[0], "id": 99, "status": status, "conclusion": conclusion})
            with self.subTest(conclusion=conclusion), self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)
            self.runs.pop()

    def test_native_skips_missing_language_and_partial_analysis_ingestion_do_not_pass(self):
        self.jobs["jobs"][0]["conclusion"] = "skipped"
        with self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)
        self.jobs["jobs"][0]["conclusion"] = "success"
        self.analyses.pop()
        with self.assertRaises(gate.Pending): gate.verify(SHA, self.api)

    def test_scan_error_zero_rules_and_any_open_finding_are_not_acceptance(self):
        for field, value in (("error", "Synthetic upload error"), ("rules_count", 0), ("commit_sha", "c" * 40)):
            before = self.analyses[0][field]; self.analyses[0][field] = value
            with self.subTest(field=field), self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)
            self.analyses[0][field] = before
        self.alerts = [{"number": 1, "state": "open", "rule": {"security_severity_level": "low"}}]
        with self.assertRaisesRegex(gate.product.ReleaseFailure, "Open CodeQL"): gate.verify(SHA, self.api)

    def test_permission_or_api_failure_is_never_a_clean_security_result(self):
        del self.analyses[0]["error"]
        with self.assertRaisesRegex(gate.product.ReleaseFailure, "invalid"):
            gate.verify(SHA, self.api)
        def denied(_): raise gate.product.ReleaseFailure("Synthetic permission error")
        with self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, denied)


if __name__ == "__main__": unittest.main()
