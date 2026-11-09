# SPDX-License-Identifier: BUSL-1.1
import copy
import unittest
from tools import release_codeql as gate

SHA = "a" * 40
RUN_ID = 12
PROJECT_URL = "https://github.com/" + gate.product.catalog.REPOSITORY


def native_job(language, job_id):
    return {"id": job_id, "name": "Analyze (" + language + ")", "run_id": RUN_ID,
            "head_sha": SHA, "status": "completed", "conclusion": "success",
            "html_url": PROJECT_URL + f"/actions/runs/{RUN_ID}/job/{job_id}",
            "steps": [{"name": "Perform CodeQL Analysis", "status": "completed", "conclusion": "success"}]}


def attached_check():
    return {"id": 99, "name": "magicstick-companion-acceptance", "run_id": RUN_ID,
            "head_sha": SHA, "status": "completed", "conclusion": "success",
            "html_url": PROJECT_URL + "/runs/99", "steps": []}


class ReleaseCodeQLTests(unittest.TestCase):
    def setUp(self):
        self.main = SHA
        self.runs = [{"id": RUN_ID, "run_attempt": 1, "head_sha": SHA, "head_branch": "main", "event": "dynamic",
            "head_repository": {"full_name": gate.product.catalog.REPOSITORY}, "path": "dynamic/github-code-scanning/codeql",
            "status": "completed", "conclusion": "success"}]
        self.jobs = {"total_count": 4, "jobs": [native_job(name, index) for index, name in enumerate(sorted(gate.LANGUAGES), 1)]}
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

    def test_successful_attached_check_is_not_a_fifth_native_language_job(self):
        # GitHub includes successful standalone check runs in the workflow Jobs
        # response, but gives them /runs/<check-id>, not a native /job/<job-id> URL.
        self.jobs["jobs"].append(attached_check())
        self.jobs["total_count"] = 5
        proof = gate.verify(SHA, self.api)
        self.assertEqual(set(proof["analyses"]), gate.LANGUAGES)
        self.assertEqual(proof["openAlerts"], 0)

    def test_attached_check_cannot_replace_a_missing_native_analysis(self):
        removed = self.jobs["jobs"].pop()
        check = attached_check()
        check["name"] = removed["name"]
        self.jobs["jobs"].append(check)
        with self.assertRaisesRegex(gate.product.ReleaseFailure, "native CodeQL"):
            gate.verify(SHA, self.api)

    def test_duplicate_and_unexpected_native_languages_are_not_accepted(self):
        for extra in (native_job("go", 98), native_job("python", 98)):
            with self.subTest(name=extra["name"]):
                self.jobs["jobs"].append(extra)
                self.jobs["total_count"] = 5
                with self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)
                self.jobs["jobs"].pop()
                self.jobs["total_count"] = 4

    def test_native_and_attached_check_states_must_all_be_successful(self):
        before = copy.deepcopy(self.jobs)
        for attached in (False, True):
            for status, conclusion in (("queued", None), ("in_progress", None),
                    ("completed", "failure"), ("completed", "cancelled"),
                    ("completed", "skipped"), ("completed", "neutral"),
                    ("completed", "timed_out"), ("completed", "action_required")):
                with self.subTest(attached=attached, status=status, conclusion=conclusion):
                    self.jobs = copy.deepcopy(before)
                    if attached:
                        self.jobs["jobs"].append(attached_check())
                        self.jobs["total_count"] += 1
                    self.jobs["jobs"][-1].update(status=status, conclusion=conclusion)
                    with self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)

    def test_foreign_run_source_id_and_url_attribution_fail_closed(self):
        before = copy.deepcopy(self.jobs)
        changes = (("run_id", 13), ("head_sha", "b" * 40), ("id", True), ("id", None),
                   ("html_url", PROJECT_URL + f"/actions/runs/{RUN_ID}/job/999"),
                   ("html_url", "https://github.com/other/project/actions/runs/12/job/1"),
                   ("html_url", PROJECT_URL + "/runs/1"), ("html_url", None),
                   ("steps", []), ("steps", None))
        for field, value in changes:
            with self.subTest(field=field, value=value):
                self.jobs = copy.deepcopy(before)
                self.jobs["jobs"][0][field] = value
                with self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)

    def test_attached_check_identity_and_empty_steps_are_required(self):
        before = copy.deepcopy(self.jobs)
        for changes in ({"steps": [{}]}, {"steps": None}, {"run_id": 13},
                        {"head_sha": "b" * 40}, {"html_url": PROJECT_URL + "/runs/98"},
                        {"html_url": PROJECT_URL + "/runs/99?native=true"}):
            with self.subTest(changes=changes):
                self.jobs = copy.deepcopy(before)
                self.jobs["jobs"].append({**attached_check(), **changes})
                self.jobs["total_count"] = 5
                with self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)

    def test_duplicate_row_ids_partial_pagination_and_malformed_lists_fail_closed(self):
        before = copy.deepcopy(self.jobs)
        for value in (None, {}, {"total_count": 4, "jobs": None},
                      {**before, "total_count": 5}, {**before, "total_count": True},
                      {"total_count": 4, "jobs": before["jobs"][:-1] + [None]},
                      {"total_count": 5, "jobs": before["jobs"] + [before["jobs"][0]]}):
            with self.subTest(value=value):
                self.jobs = value
                with self.assertRaises(gate.product.ReleaseFailure): gate.verify(SHA, self.api)

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
