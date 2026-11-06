# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. All rights reserved.
"""Qualify an exact main revision; publish only with an explicit --publish.

No version/date guessing, image rebuilds, tag replacement, CI reruns or appliance
operations. Failed or newer pending attempts cannot inherit an old green run.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "magic-host/roles/host-management/files"))
import release as release_metadata
import release_catalog as catalog
import software_channel
import license_audit
import promote_dashboard_images as dashboard

REPO = "repos/" + catalog.REPOSITORY
REQUIRED_JOBS = {
    "public-release-checks.yml": {"setup-upgrade", "release-checks"},
    "dashboard-browser-smoke.yml": {"chromium", "identity-sessions"},
    "dependency-security.yml": {"advisories", "python-advisories (dashboard/apps/api/requirements.txt)",
                                "python-advisories (magic-cluster/apps/ai/private-mesh/requirements.txt)"},
    "license-audit.yml": {"source", "release-readiness"},
    "regression-runner.yml": {"regression-image"},
}
IMAGE_BUILDS = {
    "web": ("build-dashboard-image.yml", "build", {"Verify dashboard clients", "Test license foundation", "Build and push dashboard API runtime"}),
    "runner": ("regression-runner.yml", "regression-image", {"Verify isolated contracts and native recovery tests in the built image", "Publish tested Linux AMD64 runner"}),
}


class ReleaseFailure(ValueError):
    pass


def gh(*arguments, payload=None, optional_404=False):
    try:
        return subprocess.check_output(["gh", *arguments], input=None if payload is None else json.dumps(payload).encode(),
                                       stderr=subprocess.PIPE, timeout=180)
    except subprocess.CalledProcessError as error:
        if optional_404 and re.search(rb"\(HTTP 404\)", error.stderr or b""):
            return b""
        raise ReleaseFailure("GitHub release operation failed. No automatic retry or tag/asset replacement was attempted.") from None
    except (OSError, subprocess.SubprocessError):
        raise ReleaseFailure("GitHub release operation failed. No automatic retry or tag/asset replacement was attempted.") from None


def github(path, *, method="GET", payload=None, optional=False):
    if not (path.startswith(REPO + "/") or path == REPO and method == "GET") or ".." in path:
        raise ReleaseFailure("Release operations are restricted to the official project repository.")
    args = ["api", "--method", method, "-H", "X-GitHub-Api-Version: 2026-03-10", path]
    if payload is not None:
        args.extend(["--input", "-"])
    raw = gh(*args, payload=payload, optional_404=optional and method == "GET")
    return catalog.strict_json(raw) if raw.strip() else None


def git(root, *args):
    try:
        return subprocess.check_output(["git", "-C", str(root), *args], text=True,
                                       stderr=subprocess.PIPE, timeout=180).strip()
    except (OSError, subprocess.SubprocessError):
        raise ReleaseFailure("The exact release Git revision or ancestry could not be verified.") from None


def qualify_checks(commit, api=github):
    evidence = []
    for workflow, required in REQUIRED_JOBS.items():
        query = urllib.parse.urlencode({"head_sha": commit, "branch": "main", "per_page": 100})
        runs = api(REPO + "/actions/workflows/" + workflow + "/runs?" + query)
        runs = runs.get("workflow_runs", []) if isinstance(runs, dict) else []
        matching = [r for r in runs if isinstance(r, dict) and r.get("head_sha") == commit
                    and r.get("head_branch") == "main" and r.get("event") in {"push", "workflow_dispatch"}
                    and (r.get("head_repository") or {}).get("full_name") == catalog.REPOSITORY]
        if not matching:
            raise ReleaseFailure("Missing exact-main CI: " + workflow + ". Run the normal checks for the final promotion commit first.")
        run = max(matching, key=lambda item: (item.get("id", 0), item.get("run_attempt", 0)))
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            raise ReleaseFailure("The latest exact-main attempt is not successful: " + workflow + ". No older green run may replace it.")
        if not catalog._integer(run.get("id")) or not catalog._integer(run.get("run_attempt")):
            raise ReleaseFailure("CI run identity is invalid: " + workflow)
        data = api(REPO + "/actions/runs/" + str(run["id"]) + "/attempts/" + str(run["run_attempt"]) + "/jobs?per_page=100")
        jobs = data.get("jobs", []) if isinstance(data, dict) else []
        if (not jobs or data.get("total_count") != len(jobs) or not required <= {j.get("name") for j in jobs}
                or any(j.get("status") != "completed" or j.get("conclusion") != "success" for j in jobs)):
            raise ReleaseFailure("Required jobs are missing, incomplete, failed or unexpectedly skipped: " + workflow)
        evidence.append({"workflow": workflow, "commit": commit, "runId": run["id"], "attempt": run["run_attempt"]})
    query = urllib.parse.urlencode({"head_sha": commit, "branch": "main", "per_page": 100})
    payload = api(REPO + "/actions/workflows/release-codeql-gate.yml/runs?" + query)
    runs = [r for r in payload.get("workflow_runs", []) if r.get("head_sha") == commit and r.get("head_branch") == "main"
            and r.get("event") in {"push", "workflow_dispatch"} and (r.get("head_repository") or {}).get("full_name") == catalog.REPOSITORY]
    if not runs:
        raise ReleaseFailure("The exact-main release CodeQL acceptance run is missing; native PR gates are not main acceptance.")
    run = max(runs, key=lambda r: (r.get("id", 0), r.get("run_attempt", 0)))
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ReleaseFailure("The latest exact-main release CodeQL acceptance is not successful.")
    if not catalog._integer(run.get("id")) or not catalog._integer(run.get("run_attempt")):
        raise ReleaseFailure("Release CodeQL run identity is invalid.")
    native = api(REPO + f'/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100')
    jobs = native.get("jobs", [])
    if (native.get("total_count") != 1 or len(jobs) != 1 or jobs[0].get("name") != "release-codeql"
            or jobs[0].get("status") != "completed" or jobs[0].get("conclusion") != "success"):
        raise ReleaseFailure("The current release CodeQL job is missing or unsuccessful.")
    data = api(REPO + "/commits/" + commit + "/check-runs?check_name=release-codeql&filter=latest&per_page=100")
    gates = [c for c in data.get("check_runs", []) if c.get("name") == "release-codeql"
             and c.get("head_sha") == commit and (c.get("app") or {}).get("slug") == "github-actions"
             and c.get("id") == jobs[0].get("id")
             and c.get("details_url") == "https://github.com/" + catalog.REPOSITORY + "/actions/runs/" + str(run["id"]) + "/job/" + str(c.get("id"))]
    if not gates:
        raise ReleaseFailure("The separate exact-commit CodeQL gate is missing; analysis jobs alone do not qualify a release.")
    gate = max(gates, key=lambda item: item.get("id", 0))
    if gate.get("status") != "completed" or gate.get("conclusion") != "success" or not catalog._integer(gate.get("id")):
        raise ReleaseFailure("The separate exact-commit CodeQL gate is not successful.")
    return evidence, {"commit": commit, "checkId": gate["id"]}


def qualify_image_builds(images, api=github):
    """Independently require native tests/publication of the ORIGINAL sources.

    Final pin-commit CI and valid OCI labels do not prove that an older image
    source actually ran its tests. A later skipped/failed attempt blocks it too.
    """
    for component, (workflow, job_name, required_steps) in IMAGE_BUILDS.items():
        source = next(item["sourceRevision"] for item in images if item["component"] == component)
        query = urllib.parse.urlencode({"head_sha": source, "branch": "main", "per_page": 100})
        payload = api(REPO + "/actions/workflows/" + workflow + "/runs?" + query)
        runs = [r for r in payload.get("workflow_runs", []) if r.get("head_sha") == source and r.get("head_branch") == "main"
                and r.get("event") in {"push", "workflow_dispatch"}
                and (r.get("head_repository") or {}).get("full_name") == catalog.REPOSITORY]
        if not runs:
            raise ReleaseFailure("Missing original native image-build evidence: " + workflow)
        run = max(runs, key=lambda r: (r.get("id", 0), r.get("run_attempt", 0)))
        if (run.get("status") != "completed" or run.get("conclusion") != "success"
                or not catalog._integer(run.get("id")) or not catalog._integer(run.get("run_attempt"))):
            raise ReleaseFailure("The latest original image-build attempt is not successful: " + workflow)
        data = api(REPO + f'/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100')
        jobs = data.get("jobs", [])
        matching = [j for j in jobs if j.get("name") == job_name]
        if (data.get("total_count") != len(jobs) or len(matching) != 1
                or matching[0].get("status") != "completed" or matching[0].get("conclusion") != "success"):
            raise ReleaseFailure("The original native publishing job is missing or unsuccessful: " + workflow)
        steps = matching[0].get("steps", [])
        if any(not any(s.get("name") == name and s.get("status") == "completed" and s.get("conclusion") == "success"
                       for s in steps) for name in required_steps):
            raise ReleaseFailure("Original native image tests or publication were skipped/missing: " + workflow)


def runner_fetch(url, headers=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "ghcr.io" or parsed.username or parsed.password or parsed.fragment:
        raise ReleaseFailure("Runner registry metadata must use the approved public registry.")
    opener = urllib.request.build_opener(dashboard.NoRedirect)
    try:
        try:
            response = opener.open(urllib.request.Request(url, headers=headers or {}), timeout=30)
        except urllib.error.HTTPError as error:
            target = urllib.parse.urlsplit(error.headers.get("Location", ""))
            if (error.code != 307 or not re.fullmatch(r"/v2/qualityminds/magicstick-regression/blobs/sha256:[a-f0-9]{64}", parsed.path)
                    or target.scheme != "https" or target.netloc != "pkg-containers.githubusercontent.com"
                    or target.username or target.password or target.fragment):
                raise ReleaseFailure("Runner registry metadata redirected outside the approved blob service.") from None
            # Do not forward registry Authorization to the signed CDN URL.
            response = opener.open(urllib.request.Request(target.geturl()), timeout=30)
        with response:
            raw = response.read(catalog.MAX_BYTES + 1)
    except (OSError, ValueError):
        raise ReleaseFailure("Published runner metadata could not be read safely.") from None
    if len(raw) > catalog.MAX_BYTES:
        raise ReleaseFailure("Runner registry metadata exceeds the inspection limit.")
    return raw


def verify_runner(image, source, fetch=runner_fetch):
    root = "https://ghcr.io/v2/qualityminds/magicstick-regression"
    if not re.fullmatch(r"ghcr.io/qualityminds/magicstick-regression:sha-" + source + r"@sha256:[a-f0-9]{64}", image):
        raise ReleaseFailure("The runner pin and source revision differ.")
    auth_url = "https://ghcr.io/token?" + urllib.parse.urlencode({"service": "ghcr.io", "scope": "repository:qualityminds/magicstick-regression:pull"})
    token = catalog.strict_json(fetch(auth_url)).get("token")
    if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
        raise ReleaseFailure("The runner is not anonymously available.")
    headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json"}
    manifest = dashboard.verified_json(fetch(root + "/manifests/" + image.split("@", 1)[1], headers), image.split("@", 1)[1])
    if "manifests" in manifest:
        entries = [e for e in manifest["manifests"] if (e.get("platform") or {}).get("os") == "linux"
                   and (e.get("platform") or {}).get("architecture") == "amd64"]
        if len(entries) != 1:
            raise ReleaseFailure("The runner requires exactly one Linux AMD64 platform.")
        digest = entries[0]["digest"]
        manifest = dashboard.verified_json(fetch(root + "/manifests/" + digest, headers), digest)
    config_digest = manifest["config"]["digest"]
    config = dashboard.verified_json(fetch(root + "/blobs/" + config_digest, headers), config_digest)
    labels = (config.get("config") or {}).get("Labels") or {}
    if (config.get("os") != "linux" or config.get("architecture") != "amd64"
            or labels.get("org.opencontainers.image.revision") != source
            or labels.get("org.opencontainers.image.source") != "https://github.com/" + catalog.REPOSITORY
            or labels.get("org.opencontainers.image.title") != "Magic Stick local regression harness"):
        raise ReleaseFailure("The runner platform, project or tested source labels do not match.")


def image_inventory(root, commit):
    git_dir = Path(git(root, "rev-parse", "--absolute-git-dir"))
    critical = software_channel.image_inventory(git_dir, commit)
    software_channel.verify_image_sources(git_dir, commit, critical)
    pins = dashboard.read_pins(root)
    source = re.search(r"sha-([a-f0-9]{40})@", pins["web"]).group(1)
    dashboard.verify_images(source, {component: value.split("@", 1)[1] for component, value in pins.items()})
    images = [{"component": component, "image": value, "sourceRevision": source,
               "platforms": ["linux/amd64", "linux/arm64"]} for component, value in pins.items()]
    operator = next(item["image"] for item in critical if item["name"] == "Operator runtime")
    for architecture in ("amd64", "arm64"):
        software_channel.registry_image(operator, architecture)
    images.append({"component": "operator", "image": operator, "sourceRevision": None, "platforms": ["linux/amd64", "linux/arm64"]})
    runtime = (root / "magic-cluster/apps/regression/runtime.yaml").read_text()
    runner = re.findall(r'^\s*image:\s*["\']?([^\s"\']+)', runtime, re.M)
    runner_source = re.findall(r'^\s*sourceRevision:\s*"([a-f0-9]{40})"', runtime, re.M)
    if len(runner) != 1 or len(runner_source) != 1:
        raise ReleaseFailure("The release must have exactly one tested runner pin/source.")
    verify_runner(runner[0], runner_source[0])
    images.append({"component": "runner", "image": runner[0], "sourceRevision": runner_source[0], "platforms": ["linux/amd64"]})
    return images


def prepare(root, version, commit, *, api=github, inspect_images=image_inventory):
    root = Path(root)
    catalog.version_key(version)
    if not catalog.SHA.fullmatch(commit) or git(root, "rev-parse", "HEAD") != commit:
        raise ReleaseFailure("Use a checkout of the exact full release commit, not a moving branch.")
    git(root, "merge-base", "--is-ancestor", commit, "origin/main")
    if git(root, "status", "--porcelain"):
        raise ReleaseFailure("Release qualification requires a clean checkout; no local edits are included.")
    notes = release_metadata.check(root, version)
    if license_audit.source_checks(root):
        raise ReleaseFailure("Source/license/reference consistency failed. No legal approval is fabricated.")
    checks, codeql = qualify_checks(commit, api)
    record = json.loads((root / "LICENSE-RELEASE.json").read_text())
    manifest = {"schemaVersion": 1, "repository": catalog.REPOSITORY, "version": version, "commit": commit,
                "managementContract": 1, "license": record, "images": inspect_images(root, commit),
                "checks": checks, "codeql": codeql}
    catalog.validate_manifest(manifest, version, commit)
    qualify_image_builds(manifest["images"], api)
    return manifest, notes


def publish(root, manifest, notes, directory, *, api=github, command=gh):
    version, commit = manifest["version"], manifest["commit"]
    catalog.validate_manifest(manifest, version, commit)
    settings = api(REPO + "/immutable-releases")
    if not isinstance(settings, dict) or settings.get("enabled") is not True:
        raise ReleaseFailure("Enable and verify immutable releases before publication. This requires repository administration read access; no release or tag was created.")
    # The exact latest attempts must still match; a newly started/failed check
    # after preparation is not bypassed by the earlier artifact.
    checks, gate = qualify_checks(commit, api)
    if checks != manifest["checks"] or gate != manifest["codeql"]:
        raise ReleaseFailure("Release checks changed after preparation. Qualify the exact latest evidence again.")
    qualify_image_builds(manifest["images"], api)
    refs = api(REPO + "/git/matching-refs/tags/" + version)
    existing = api(REPO + "/releases/tags/" + version, optional=True)
    if (not isinstance(refs, list) or existing is not None
            or any(r.get("ref") == "refs/tags/" + version for r in refs)
            ):
        raise ReleaseFailure("The version tag/release already exists or cannot be checked. It will not be moved, reused or replaced.")
    files = [directory / catalog.MANIFEST, directory / "release-notes.md", directory / "LICENSE",
             directory / "LICENSING.md", directory / "THIRD_PARTY_NOTICES.md", directory / "LICENSE-RELEASE.json"]
    if any(not p.is_file() or p.is_symlink() for p in files):
        raise ReleaseFailure("The reviewed release and mandatory license assets are missing or unsafe.")
    if catalog.strict_json(files[0].read_bytes()) != manifest or files[1].read_text() != notes:
        raise ReleaseFailure("The prepared release manifest or curated notes changed.")
    for name in ("LICENSE", "LICENSING.md", "THIRD_PARTY_NOTICES.md", "LICENSE-RELEASE.json"):
        if (directory / name).read_bytes() != (root / name).read_bytes():
            raise ReleaseFailure("Prepared license assets differ from the qualified Git source.")
    tag = api(REPO + "/git/tags", method="POST", payload={"tag": version, "message": "Magic Stick " + version,
        "object": commit, "type": "commit", "tagger": {"name": "Magic Stick release",
        "email": "41898282+github-actions[bot]@users.noreply.github.com", "date": dt.datetime.now(dt.timezone.utc).isoformat()}})
    if not isinstance(tag, dict) or not catalog.SHA.fullmatch(str(tag.get("sha", ""))):
        raise ReleaseFailure("The annotated release tag object was not confirmed. Inspect before any retry.")
    api(REPO + "/git/refs", method="POST", payload={"ref": "refs/tags/" + version, "sha": tag["sha"]})
    def verify_tag():
        current = api(REPO + "/git/ref/tags/" + version)
        if (not isinstance(current, dict) or current.get("ref") != "refs/tags/" + version
                or current.get("object") != {"type": "tag", "sha": tag["sha"], "url": "https://api.github.com/" + REPO + "/git/tags/" + tag["sha"]}):
            raise ReleaseFailure("The new annotated tag identity was not confirmed. Inspect before publishing or retrying.")
    verify_tag()
    draft = api(REPO + "/releases", method="POST", payload={"tag_name": version, "target_commitish": commit,
        "name": "Magic Stick " + version, "body": notes, "draft": True, "prerelease": bool(catalog.version_key(version)[4])})
    if not isinstance(draft, dict) or not catalog._integer(draft.get("id")) or draft.get("draft") is not True:
        raise ReleaseFailure("Draft creation was not confirmed. Inspect the existing tag/release; do not retry blindly.")
    command("release", "upload", version, *(str(p) for p in files), "--repo", catalog.REPOSITORY)
    uploaded = api(REPO + "/releases/" + str(draft["id"]))
    asset_list = uploaded.get("assets", [])
    assets = {a.get("name"): a for a in asset_list}
    if len(assets) != len(files) or len(asset_list) != len(files):
        raise ReleaseFailure("The draft does not contain exactly the reviewed release/license assets. It remains unpublished.")
    for path in files:
        asset = assets.get(path.name, {})
        if asset.get("size") != path.stat().st_size or asset.get("digest") != "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest():
            raise ReleaseFailure("A draft asset differs from its reviewed SHA-256/size. It remains unpublished.")
    verify_tag()
    result = api(REPO + "/releases/" + str(draft["id"]), method="PATCH", payload={"draft": False, "make_latest": "false" if bool(catalog.version_key(version)[4]) else "true"})
    if not isinstance(result, dict) or result.get("draft") is not False or result.get("immutable") is not True:
        raise ReleaseFailure("Immutable publication was not confirmed. Inspect release state; no replacement or deletion was attempted.")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true", help="Qualify and retain local evidence only; no remote writes")
    mode.add_argument("--publish", action="store_true", help="Create a new annotated tag and immutable product release after all checks")
    args = parser.parse_args()
    try:
        manifest, notes = prepare(ROOT, args.version, args.revision)
        directory = args.output_directory
        directory.mkdir(parents=True, exist_ok=True)
        outputs = {catalog.MANIFEST: (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode(),
                   "release-notes.md": notes.encode()}
        for name in ("LICENSE", "LICENSING.md", "THIRD_PARTY_NOTICES.md", "LICENSE-RELEASE.json"):
            outputs[name] = (ROOT / name).read_bytes()
        if any((directory / name).is_symlink() or (directory / name).exists() and (directory / name).read_bytes() != raw
               for name, raw in outputs.items()):
            raise ReleaseFailure("Prepared release evidence already exists with different bytes; it will not be overwritten.")
        for name, raw in outputs.items():
            if not (directory / name).exists():
                (directory / name).write_bytes(raw)
        for finding in license_audit.publication_checks(ROOT):
            print("REVIEW WARNING: " + finding, file=sys.stderr)
        if args.publish:
            result = publish(ROOT, manifest, notes, directory)
            print("Published " + args.version + " at " + result["html_url"] + ". Appliance rollout is separate.")
        else:
            print("Qualified " + args.version + " at " + args.revision + ". No tag, release or appliance was changed.")
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, (str(error) if isinstance(error, (ReleaseFailure, catalog.ReleaseError, dashboard.PromotionError)) else "Release qualification failed; inspect the exact source and CI evidence.") + "\n")


if __name__ == "__main__":
    main()
