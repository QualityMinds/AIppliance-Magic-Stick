# SPDX-License-Identifier: BUSL-1.1
"""Read-only exact-main CodeQL acceptance, including findings, not just uploads."""
import argparse
import time
import urllib.parse
from tools import product_release as product

LANGUAGES = {"actions", "python", "rust", "javascript-typescript"}


class Pending(product.ReleaseFailure):
    pass


def verify(commit, api=product.github):
    if not product.catalog.SHA.fullmatch(commit):
        raise product.ReleaseFailure("A full main commit is required.")
    def main_identity():
        value = api(product.REPO + "/git/ref/heads/main")
        if (value or {}).get("object", {}).get("sha") != commit:
            raise product.ReleaseFailure("Main advanced; qualify the new final release commit, not stale branch findings.")
    main_identity()
    query = urllib.parse.urlencode({"head_sha": commit, "branch": "main", "per_page": 100})
    payload = api(product.REPO + "/actions/runs?" + query)
    runs = [r for r in payload.get("workflow_runs", []) if r.get("path") == "dynamic/github-code-scanning/codeql"
        and r.get("event") == "dynamic" and r.get("head_sha") == commit and r.get("head_branch") == "main"
        and (r.get("head_repository") or {}).get("full_name") == product.catalog.REPOSITORY]
    if not runs:
        raise Pending("Waiting for the exact-main managed CodeQL run.")
    run = max(runs, key=lambda r: (r.get("id", 0), r.get("run_attempt", 0)))
    if run.get("status") != "completed":
        raise Pending("Waiting for the latest exact-main CodeQL attempt.")
    if run.get("conclusion") != "success" or not product.catalog._integer(run.get("id")) or not product.catalog._integer(run.get("run_attempt")):
        raise product.ReleaseFailure("The latest exact-main CodeQL attempt is unsuccessful or invalid; no old green fallback.")
    data = api(product.REPO + f'/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100')
    names = {"Analyze (" + language + ")" for language in LANGUAGES}
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if (not isinstance(jobs, list) or not len(names) <= len(jobs) <= 100
            or type(data.get("total_count")) is not int or data["total_count"] != len(jobs)):
        raise product.ReleaseFailure("The complete current CodeQL job list is required; partial or invalid evidence cannot pass.")
    native, seen = [], set()
    project_url = "https://github.com/" + product.catalog.REPOSITORY
    for job in jobs:
        if (not isinstance(job, dict) or not product.catalog._integer(job.get("id"))
                or job["id"] in seen or job.get("run_id") != run["id"] or job.get("head_sha") != commit):
            raise product.ReleaseFailure("A CodeQL job identity differs from the selected source/run or is duplicated.")
        seen.add(job["id"])
        if job.get("status") != "completed" or job.get("conclusion") != "success":
            raise product.ReleaseFailure("Every current CodeQL job and attached check must succeed; incomplete, failed or skipped evidence cannot pass.")
        if job.get("html_url") == project_url + f'/actions/runs/{run["id"]}/job/{job["id"]}':
            if not isinstance(job.get("steps"), list) or not job["steps"]:
                raise product.ReleaseFailure("A native CodeQL language job has no execution steps.")
            native.append(job)
        elif job.get("html_url") != project_url + f'/runs/{job["id"]}' or job.get("steps") != []:
            raise product.ReleaseFailure("CodeQL job/check attribution is unavailable or inconsistent; no acceptance was inferred.")
        # GitHub also lists successful standalone /runs/<check-id> checks here.
        # They must not count as native /actions/runs/<run-id>/job/<job-id>
        # language executions, even if their display name resembles an analysis.
    if len(native) != len(names) or {job.get("name") for job in native} != names:
        raise product.ReleaseFailure("Every current native CodeQL language job must pass, without missing or skipped languages.")
    query = urllib.parse.urlencode({"ref": "refs/heads/main", "tool_name": "CodeQL", "per_page": 100})
    analyses = api(product.REPO + "/code-scanning/analyses?" + query)
    if not isinstance(analyses, list):
        raise product.ReleaseFailure("CodeQL findings/analysis metadata could not be read.")
    identities = {}
    for language in LANGUAGES:
        matching = [a for a in analyses if a.get("commit_sha") == commit and a.get("ref") == "refs/heads/main"
            and (a.get("tool") or {}).get("name") == "CodeQL" and a.get("category") == "/language:" + language]
        if not matching:
            raise Pending("Waiting for complete exact-commit CodeQL analysis ingestion.")
        latest = max(matching, key=lambda a: a.get("id", 0))
        if latest.get("error") != "" or not product.catalog._integer(latest.get("id")) or not product.catalog._integer(latest.get("rules_count")):
            raise product.ReleaseFailure("A current CodeQL analysis is invalid, empty or reports an error.")
        identities[language] = latest["id"]
    alerts = api(product.REPO + "/code-scanning/alerts?" + query + "&state=open")
    if not isinstance(alerts, list) or alerts:
        raise product.ReleaseFailure("Open CodeQL findings or an unreadable finding list prevent product-release acceptance. Inspect security alerts; none were dismissed.")
    main_identity()
    return {"commit": commit, "runId": run["id"], "attempt": run["run_attempt"], "analyses": identities, "openAlerts": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--wait-seconds", type=int, default=0)
    args = parser.parse_args()
    deadline = time.monotonic() + min(900, max(0, args.wait_seconds))
    while True:
        try:
            value = verify(args.commit)
            print("Exact main CodeQL accepted: four complete language analyses, latest native attempt successful, zero open findings. Commit " + value["commit"])
            return
        except Pending as error:
            if time.monotonic() >= deadline:
                parser.exit(1, str(error) + " No acceptance was inferred.\n")
            time.sleep(min(15, max(0, deadline - time.monotonic())))
        except (ValueError, OSError, TypeError, KeyError) as error:
            parser.exit(1, (str(error) if isinstance(error, product.ReleaseFailure) else "Release CodeQL evidence could not be verified.") + "\n")


if __name__ == "__main__":
    main()
