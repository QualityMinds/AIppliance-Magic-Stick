# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. All rights reserved.
"""Coordinate tested image pins through a normal main PR, never a main push."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import promote_dashboard_images as dashboard
import promote_regression_image as regression
import product_release as product
import license_audit

ALLOWED = dashboard.ALLOWED | {regression.PIN}
REPO = "repos/" + dashboard.REPOSITORY


class Pending(dashboard.PromotionError):
    """No write: another ordinary workflow completion may qualify this source."""


def pin_only(root, base, head):
    """Prove the delta by content, including unchanged package/legal metadata."""
    try:
        if dashboard.git(root, "rev-parse", "HEAD") != head:
            return False
        paths = set(dashboard.git(root, "diff", "--name-only", base, head, "--").splitlines())
        if not paths or not paths <= ALLOWED or not paths - {dashboard.INVENTORY}:
            return False
        for component, (path, key, prefix) in dashboard.FILES.items():
            if path not in paths:
                continue
            before, after = (dashboard.git(root, "show", rev + ":" + path) for rev in (base, head))
            pattern = r"(?m)^([ \t]*" + key + r":[ \t]*)" + re.escape(dashboard.IMAGE + ":" + prefix) + r"([a-f0-9]{40})@(sha256:[a-f0-9]{64})([ \t]*(?:#.*)?)$"
            old, new = re.search(pattern, before), re.search(pattern, after)
            if not old or not new or before[:old.start()] + old[1] + dashboard.IMAGE + ":" + prefix + new[2] + "@" + new[3] + old[4] + before[old.end():] != after:
                return False
        if regression.PIN in paths:
            before, after = (dashboard.git(root, "show", rev + ":" + regression.PIN) for rev in (base, head))
            match = re.search(r'^  image: "ghcr[.]io/qualityminds/magicstick-regression:sha-([a-f0-9]{40})@(sha256:[a-f0-9]{64})"$', after, re.M)
            if not match or regression.replacement(before, match[1], match[2]).strip() != after:
                return False
        before, after = (json.loads(dashboard.git(root, "show", rev + ":" + dashboard.INVENTORY)) for rev in (base, head))
        ignored = {"deploymentReferences", "deploymentReferencesSha256"}
        if {k: v for k, v in before.items() if k not in ignored} != {k: v for k, v in after.items() if k not in ignored}:
            return False
        references = license_audit.deployment_references(root)
        if after.get("deploymentReferences") != references or after.get("deploymentReferencesSha256") != license_audit.references_checksum(references):
            return False
        return not license_audit.source_checks(root)
    except (ValueError, KeyError, TypeError, OSError, dashboard.GitError):
        return False


def trusted_run(workflow, source, *, required=True, api=product.github):
    query = urllib.parse.urlencode({"head_sha": source, "branch": "main", "event": "push", "per_page": 100})
    payload = api(REPO + "/actions/workflows/" + workflow + "/runs?" + query)
    state = dashboard.check_state(payload, "main", source, missing="absent")
    if state == "absent" and not required:
        return None
    if state != "success":
        raise Pending("Waiting for exact-main " + workflow + " on " + source[:12] + "; no pins or PR were written.")
    runs = [r for r in payload["workflow_runs"] if r["head_sha"] == source and r["head_branch"] == "main"
            and r["event"] == "push" and r["head_repository"]["full_name"] == dashboard.REPOSITORY]
    return max(runs, key=lambda r: (r["id"], r.get("run_attempt", 1)))


def native_build(workflow, source, required_job, required_steps, *, api=product.github):
    run = trusted_run(workflow, source, api=api)
    attempt = run.get("run_attempt", 1)
    value = api(REPO + "/actions/runs/" + str(run["id"]) + "/attempts/" + str(attempt) + "/jobs?per_page=100")
    jobs = value.get("jobs", [])
    matching = [j for j in jobs if j.get("name") == required_job]
    if value.get("total_count") != len(jobs) or len(matching) != 1 or matching[0].get("conclusion") != "success":
        raise dashboard.PromotionError("The exact native publishing job is missing or unsuccessful: " + workflow)
    steps = matching[0].get("steps", [])
    if any(not any(s.get("name") == name and s.get("status") == "completed" and s.get("conclusion") == "success" for s in steps) for name in required_steps):
        raise dashboard.PromotionError("The publishing source did not complete its required tests/publication: " + workflow)
    return run


def verify_pins(root, *, api=product.github):
    source = dashboard.git(root, "rev-parse", "HEAD")
    images = product.image_inventory(root, source)
    web_source = next(i["sourceRevision"] for i in images if i["component"] == "web")
    runner_source = next(i["sourceRevision"] for i in images if i["component"] == "runner")
    native_build("build-dashboard-image.yml", web_source, "build", {"Verify dashboard clients", "Test license foundation", "Build and push dashboard API runtime"}, api=api)
    native_build("regression-runner.yml", runner_source, "regression-image",
                 {"Verify isolated contracts and native recovery tests in the built image", "Publish tested Linux AMD64 runner"}, api=api)
    return images


def candidates(source, *, dashboard_ready, runner_ready):
    digests, runner = None, None
    if dashboard_ready:
        token_url = "https://ghcr.io/token?" + urllib.parse.urlencode({"service": "ghcr.io", "scope": "repository:qualityminds/magicstick-dashboard:pull"})
        token = product.catalog.strict_json(dashboard.registry_fetch(token_url)).get("token")
        if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
            raise dashboard.PromotionError("Dashboard candidates are not anonymously readable.")
        headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.oci.image.index.v1+json"}
        digests = {component: "sha256:" + hashlib.sha256(dashboard.registry_fetch(dashboard.REGISTRY + "/manifests/" + item[2] + source, headers)).hexdigest()
                   for component, item in dashboard.FILES.items()}
        dashboard.verify_images(source, digests)
    if runner_ready:
        token_url = "https://ghcr.io/token?" + urllib.parse.urlencode({"service": "ghcr.io", "scope": "repository:qualityminds/magicstick-regression:pull"})
        token = product.catalog.strict_json(product.runner_fetch(token_url)).get("token")
        if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
            raise dashboard.PromotionError("The runner candidate is not anonymously readable.")
        raw = product.runner_fetch("https://ghcr.io/v2/qualityminds/magicstick-regression/manifests/sha-" + source,
            {"Authorization": "Bearer " + token, "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json"})
        runner = "sha256:" + hashlib.sha256(raw).hexdigest()
        product.verify_runner(regression.image_reference(source, runner), source)
    return digests, runner


def propose(root, source, *, api=product.github, read_candidates=candidates):
    if not product.catalog.SHA.fullmatch(source) or dashboard.git(root, "status", "--porcelain"):
        raise dashboard.PromotionError("Use a full source SHA and a clean dedicated CI checkout.")
    head = dashboard.channel_head(root, "main")
    dashboard.git(root, "merge-base", "--is-ancestor", source, head)
    # A merged promotion is not another image source. Prove its content, not its
    # commit message/author, before deciding that the native build was skipped.
    dashboard.git(root, "checkout", "--detach", source)
    if pin_only(root, source + "^1", source):
        return None
    changes = dashboard.git(root, "diff", "--name-only", source, head, "--").splitlines()
    if regression.source_advanced(changes) or any(p in dashboard.AUTOMATION for p in changes):
        raise dashboard.Superseded("A newer source/policy owns main; no old images or PR were applied.")
    trusted_run("public-release-checks.yml", source, api=api)
    if head != source:
        trusted_run("public-release-checks.yml", head, api=api)
    dashboard_run = trusted_run("build-dashboard-image.yml", source, required=False, api=api)
    runner_run = trusted_run("regression-runner.yml", source, required=False, api=api)
    if not dashboard_run and not runner_run:
        return None
    if dashboard_run:
        trusted_run("dashboard-browser-smoke.yml", source, api=api)
        native_build("build-dashboard-image.yml", source, "build", {"Verify dashboard clients", "Test license foundation", "Build and push dashboard API runtime"}, api=api)
    if runner_run:
        native_build("regression-runner.yml", source, "regression-image",
                     {"Verify isolated contracts and native recovery tests in the built image", "Publish tested Linux AMD64 runner"}, api=api)
    digests, runner = read_candidates(source, dashboard_ready=bool(dashboard_run), runner_ready=bool(runner_run))
    branch = "codex/promote-images-" + source[:12]
    refs = api(REPO + "/git/matching-refs/heads/" + branch)
    if not isinstance(refs, list):
        raise dashboard.PromotionError("The existing promotion branch could not be checked.")
    if any(ref.get("ref") == "refs/heads/" + branch for ref in refs):
        prs = api(REPO + "/pulls?" + urllib.parse.urlencode({"state": "open", "head": "QualityMinds:" + branch, "base": "main"}))
        if not isinstance(prs, list) or len(prs) != 1:
            raise dashboard.PromotionError("A promotion branch already exists without one exact open PR. Inspect it; it was not overwritten.")
        pr = prs[0]
        if (pr.get("base", {}).get("ref") != "main" or pr.get("head", {}).get("ref") != branch
                or pr.get("head", {}).get("repo", {}).get("full_name") != dashboard.REPOSITORY
                or not re.fullmatch(r"https://github[.]com/QualityMinds/AIppliance-Magic-Stick/pull/[1-9][0-9]*", pr.get("html_url", ""))):
            raise dashboard.PromotionError("The existing PR has a different repository/base/head identity; it was not changed.")
        return pr["html_url"]
    dashboard.git(root, "checkout", "--detach", head)
    inventory_before = json.loads((root / dashboard.INVENTORY).read_text())
    if digests:
        dashboard.rewrite_pins(root, source, digests)
    if runner:
        pin = root / regression.PIN
        pin.write_text(regression.replacement(pin.read_text(), source, runner))
    license_audit.refresh_references(root)
    inventory_after = json.loads((root / dashboard.INVENTORY).read_text())
    ignored = {"deploymentReferences", "deploymentReferencesSha256"}
    if {k: v for k, v in inventory_before.items() if k not in ignored} != {k: v for k, v in inventory_after.items() if k not in ignored}:
        raise dashboard.PromotionError("Image promotion must preserve all package and legal metadata.")
    changed = set(dashboard.git(root, "diff", "--name-only").splitlines())
    if not changed:
        return None
    if not changed <= ALLOWED or license_audit.source_checks(root):
        raise dashboard.PromotionError("Only canonical pins and generated deployment references may enter a promotion PR.")
    dashboard.git(root, "add", "--", *sorted(changed))
    if set(dashboard.git(root, "diff", "--cached", "--name-only").splitlines()) != changed:
        raise dashboard.PromotionError("Unexpected staged content; no promotion branch was pushed.")
    dashboard.git(root, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                  "commit", "-m", "chore(images): propose tested images " + source[:12])
    verify_pins(root, api=api)
    dashboard.git(root, "push", "origin", "HEAD:refs/heads/" + branch)
    result = api(REPO + "/pulls", method="POST", payload={"base": "main", "head": branch,
        "title": "chore(images): reviewed image pins " + source[:12],
        "body": "Coordinated immutable image promotion for source `" + source + "`.\n\n"
            "Public/source/browser and native publishing evidence plus anonymous registry hashes/platform/source labels were verified. "
            "Only canonical image pins and generated deployment references change; package identities and legal decisions are retained.\n\n"
            "Normal PR checks and review are required. If GitHub requires approval for GITHUB_TOKEN-created PR workflows, approve those checks; "
            "this workflow never bypasses protection or merges itself. Merging updates only opted-in main followers, not fixed-version installations."})
    if not isinstance(result, dict) or not isinstance(result.get("html_url"), str):
        raise dashboard.PromotionError("The promotion branch was pushed, but PR creation was not confirmed. Inspect before any retry.")
    return result["html_url"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--pin-only", action="store_true")
    mode.add_argument("--verify-pins", action="store_true")
    mode.add_argument("--propose", action="store_true")
    parser.add_argument("--source")
    parser.add_argument("--base")
    args = parser.parse_args()
    try:
        if args.pin_only:
            head = dashboard.git(ROOT, "rev-parse", "HEAD")
            print("pin_only=" + str(pin_only(ROOT, args.base or head + "^1", head)).lower())
        elif args.verify_pins:
            verify_pins(ROOT)
            print("Unchanged pinned images and their exact-source native publishing checks verified. No build, promotion or rollout was started.")
        else:
            url = propose(ROOT, args.source or "")
            print("Promotion PR: " + url if url else "No new image pins are needed. Main was not pushed or merged.")
    except (Pending, dashboard.Superseded) as error:
        print(str(error))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, (str(error) if isinstance(error, (dashboard.PromotionError, product.ReleaseFailure, product.catalog.ReleaseError)) else "Trunk promotion verification failed; no main push or protection bypass was attempted.") + "\n")


if __name__ == "__main__":
    main()
