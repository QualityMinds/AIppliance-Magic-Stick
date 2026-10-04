# SPDX-License-Identifier: BUSL-1.1
"""Promote one tested dashboard build on its own channel, without force-pushes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "magic-host/roles/host-management/files"))
import license_audit
from software_channel import image_source_path

REPOSITORY = "QualityMinds/AIppliance-Magic-Stick"
IMAGE = "ghcr.io/qualityminds/magicstick-dashboard"
REGISTRY = "https://ghcr.io/v2/qualityminds/magicstick-dashboard"
CHECKS = ("public-release-checks.yml", "dashboard-browser-smoke.yml")
FILES = {
    "web": ("magic-cluster/apps/dashboard/deployment.yaml", "image", "sha-"),
    "api": ("magic-cluster/apps/dashboard/api-deployment.yaml", "image", "api-sha-"),
    "cli": ("magic-host/roles/dashboard-console/defaults/main.yml", "dashboard_console_image", "cli-sha-"),
}
INVENTORY = "licenses/dependency-inventory.json"
ALLOWED = {item[0] for item in FILES.values()} | {INVENTORY}
AUTOMATION = {"tools/promote_dashboard_images.py", "tests/test_dashboard_image_promotion.py",
              ".github/workflows/build-dashboard-image.yml", ".github/workflows/dashboard-browser-smoke.yml",
              ".github/workflows/public-release-checks.yml"}
LIMIT = 4 * 1024 * 1024
TITLES = {"web": "MagicStick React dashboard", "api": "MagicStick dashboard API",
          "cli": "MagicStick CLI and TUI runtime"}


class PromotionError(ValueError):
    pass


class Superseded(PromotionError):
    """A newer runtime build owns promotion; nothing has been changed."""


def validate(branch, source, digests):
    if not isinstance(branch, str) or branch not in {"main", "develop"} or \
            not isinstance(source, str) or not re.fullmatch(r"[a-f0-9]{40}", source):
        raise PromotionError("Only a full source commit on main or develop may be promoted.")
    if not isinstance(digests, dict) or set(digests) != set(FILES) or any(not isinstance(value, str) or
                                         not re.fullmatch(r"sha256:[a-f0-9]{64}", value)
                                         for value in digests.values()):
        raise PromotionError("All three published SHA-256 image-index digests are required.")


def git(root, *args):
    result = subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, timeout=180)
    if result.returncode:
        # Do not print credential-bearing remotes, Git headers or command stderr.
        raise PromotionError("Git " + args[0] + " failed; no force-push or automatic conflict overwrite is allowed.")
    return result.stdout.strip()


def github(path):
    result = subprocess.run(["gh", "api", "--method", "GET", path], text=True,
                            capture_output=True, timeout=40)
    if result.returncode or len(result.stdout.encode()) > LIMIT:
        raise PromotionError("Required GitHub CI status could not be read.")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise PromotionError("GitHub returned invalid CI status.") from None


def check_state(payload, branch, source):
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        raise PromotionError("GitHub returned an invalid workflow-run list.")
    if any(not isinstance(run, dict) or not isinstance(run.get("head_repository"), dict) for run in runs):
        raise PromotionError("GitHub returned invalid workflow-run metadata.")
    matches = [run for run in runs if run.get("head_sha") == source and run.get("head_branch") == branch
               and run.get("event") == "push" and
               run["head_repository"].get("full_name") == REPOSITORY]
    if not matches:
        return "pending"
    if any(type(run.get("id")) is not int or run["id"] <= 0 or
           type(run.get("run_attempt", 1)) is not int or run.get("run_attempt", 1) <= 0 for run in matches):
        raise PromotionError("GitHub returned an invalid workflow-run identity.")
    run = max(matches, key=lambda item: (item["id"], item.get("run_attempt", 1)))
    if run.get("status") != "completed":
        return "pending"
    if run.get("conclusion") != "success":
        raise PromotionError("Required CI is not successful (" + str(run.get("conclusion")) + ").")
    return "success"


def wait_for_checks(branch, source, checks=CHECKS, fetch=github, clock=time.monotonic, sleep=time.sleep,
                    timeout=1200):
    deadline = clock() + timeout
    pending = set(checks)
    while pending:
        for workflow in sorted(pending):
            query = urllib.parse.urlencode({"head_sha": source, "branch": branch, "event": "push", "per_page": 100})
            payload = fetch(f"repos/{REPOSITORY}/actions/workflows/{workflow}/runs?{query}")
            if check_state(payload, branch, source) == "success":
                pending.remove(workflow)
        if not pending:
            return
        if clock() >= deadline:
            raise PromotionError("Required CI did not complete successfully within the 20-minute promotion deadline.")
        sleep(min(15, max(0, deadline - clock())))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def registry_fetch(url, headers=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "ghcr.io" or parsed.username or parsed.password or parsed.fragment:
        raise PromotionError("Only the approved HTTPS registry may be inspected.")
    try:
        request = urllib.request.Request(url, headers=headers or {})
        opener = urllib.request.build_opener(NoRedirect)
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            # GHCR serves hash-addressed configuration blobs through its CDN.
            # Permit just this one HTTPS hop, never copy Authorization, never
            # accept arbitrary redirects or log the signed CDN query string.
            location = error.headers.get("Location", "")
            target = urllib.parse.urlsplit(location)
            if error.code != 307 or not re.fullmatch(
                    r"/v2/qualityminds/magicstick-dashboard/blobs/sha256:[a-f0-9]{64}", parsed.path) or \
                    target.scheme != "https" or target.netloc != "pkg-containers.githubusercontent.com" or \
                    target.username or target.password or target.fragment:
                raise PromotionError("Registry returned an unapproved metadata redirect.") from None
            response = opener.open(urllib.request.Request(location), timeout=30)
        with response:
            body = response.read(LIMIT + 1)
    except (OSError, urllib.error.HTTPError):
        raise PromotionError("Published dashboard image metadata could not be read.") from None
    if len(body) > LIMIT:
        raise PromotionError("Registry metadata exceeds the inspection limit.")
    return body


def verified_json(raw, digest):
    if "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
        raise PromotionError("Registry metadata does not match its immutable digest.")
    try:
        value = json.loads(raw)
    except ValueError:
        raise PromotionError("Registry returned invalid image metadata.") from None
    if not isinstance(value, dict):
        raise PromotionError("Registry image metadata must be an object.")
    return value


def verify_images(source, digests, fetch=registry_fetch):
    auth = "https://ghcr.io/token?" + urllib.parse.urlencode({
        "service": "ghcr.io", "scope": "repository:qualityminds/magicstick-dashboard:pull"})
    try:
        authorization = json.loads(fetch(auth))
    except ValueError:
        raise PromotionError("Registry did not return valid public pull authorization.") from None
    token = authorization.get("token") if isinstance(authorization, dict) else None
    if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
        raise PromotionError("Registry did not grant public pull authorization.")
    headers = {"Authorization": "Bearer " + token,
               "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, "
                         "application/vnd.docker.distribution.manifest.list.v2+json, "
                         "application/vnd.docker.distribution.manifest.v2+json"}
    for component in FILES:
        index = verified_json(fetch(REGISTRY + "/manifests/" + digests[component], headers), digests[component])
        entries = index.get("manifests") if isinstance(index, dict) else None
        if index.get("schemaVersion") != 2 or not isinstance(entries, list) or any(
                not isinstance(entry, dict) or not isinstance(entry.get("platform"), dict) for entry in entries):
            raise PromotionError("Each dashboard component requires a multi-architecture image index.")
        for architecture in ("amd64", "arm64"):
            selected = [entry for entry in entries if entry.get("platform", {}).get("os") == "linux" and
                        entry.get("platform", {}).get("architecture") == architecture]
            if len(selected) != 1:
                raise PromotionError(component + " requires exactly one Linux/" + architecture + " manifest.")
            digest = selected[0].get("digest", "")
            if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
                raise PromotionError("Platform manifest is not SHA-256 pinned.")
            manifest = verified_json(fetch(REGISTRY + "/manifests/" + digest, headers), digest)
            descriptor = manifest.get("config")
            config_digest = descriptor.get("digest") if isinstance(descriptor, dict) else None
            if manifest.get("schemaVersion") != 2 or not isinstance(config_digest, str) or \
                    not re.fullmatch(r"sha256:[a-f0-9]{64}", config_digest):
                raise PromotionError("Platform image configuration is not SHA-256 pinned.")
            config = verified_json(fetch(REGISTRY + "/blobs/" + config_digest, headers), config_digest)
            runtime = config.get("config")
            labels = runtime.get("Labels") if isinstance(runtime, dict) else None
            if not isinstance(labels, dict) or config.get("os") != "linux" or config.get("architecture") != architecture or \
                    labels.get("org.opencontainers.image.revision") != source or \
                    labels.get("org.opencontainers.image.title") != TITLES[component] or \
                    labels.get("org.opencontainers.image.source") != "https://github.com/" + REPOSITORY:
                raise PromotionError(component + " platform/source provenance does not match the tested build.")


def read_pins(root):
    pins = {}
    for component, (path, key, prefix) in FILES.items():
        matches = re.findall(r"^\s*" + key + r":\s*([^\s#]+)", (root / path).read_text(), re.M)
        pattern = re.escape(IMAGE + ":" + prefix) + r"([a-f0-9]{40})@(sha256:[a-f0-9]{64})"
        if len(matches) != 1 or not re.fullmatch(pattern, matches[0]):
            raise PromotionError("Expected exactly one immutable " + component + " pin.")
        pins[component] = matches[0]
    return pins


def replacements(source, digests):
    return {component: IMAGE + ":" + item[2] + source + "@" + digests[component]
            for component, item in FILES.items()}


def candidate_head(root, branch, source):
    git(root, "fetch", "--no-tags", "origin", "refs/heads/" + branch + ":refs/remotes/origin/" + branch)
    head = git(root, "rev-parse", "refs/remotes/origin/" + branch)
    git(root, "merge-base", "--is-ancestor", source, head)
    if head != source:
        changed = git(root, "diff", "--name-only", source, head, "--").splitlines()
        if any(image_source_path(path) or path in AUTOMATION or path in ALLOWED - {INVENTORY}
               for path in changed):
            raise Superseded("A newer runtime or promotion revision owns this channel; the older build was not applied.")
    return head


def rewrite_pins(root, source, digests):
    old, new = read_pins(root), replacements(source, digests)
    # Validate and prepare every edit before writing any component.
    texts = {FILES[component][0]: re.sub(r"(^[ \t]*" + FILES[component][1] + r":[ \t]*)" +
                                       re.escape(old[component]) + r"(?=[ \t\r\n#]|$)",
                                       lambda match, component=component: match[1] + new[component],
                                       (root / FILES[component][0]).read_text(), flags=re.M)
             for component in FILES}
    for path, text in texts.items():
        if text != (root / path).read_text():
            (root / path).write_text(text)
    return old != new


def publish(root, branch, source, digests, head):
    if git(root, "status", "--porcelain"):
        raise PromotionError("Promotion requires its own clean CI checkout; existing changes will not be included.")
    if git(root, "rev-parse", "refs/remotes/origin/" + branch) != head:
        raise PromotionError("The reviewed channel head changed.")
    git(root, "checkout", "--detach", head)
    if read_pins(root) == replacements(source, digests):
        print("This exact dashboard build is already promoted; no commit was created.")
        return None
    rewrite_pins(root, source, digests)
    license_audit.refresh_references(root)
    errors = license_audit.source_checks(root)
    if errors:
        raise PromotionError("Promoted source/license inventory failed consistency checks; nothing was pushed.")
    changed = set(git(root, "diff", "--name-only").splitlines())
    if not changed or not changed <= ALLOWED:
        raise PromotionError("Promotion must change only the three image pins and deployment inventory.")
    git(root, "add", "--", *sorted(changed))
    if set(git(root, "diff", "--cached", "--name-only").splitlines()) != changed:
        raise PromotionError("Unexpected staged content; nothing was pushed.")
    git(root, "-c", "user.name=github-actions[bot]", "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "-m",
        "chore(images): promote dashboard " + source[:12] + " on " + branch)
    # A normal fast-forward push is the final atomic race guard. Never force,
    # rebase over a human edit, change branch protection or fall back to a PAT.
    git(root, "push", "origin", "HEAD:refs/heads/" + branch)
    return git(root, "rev-parse", "HEAD")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--source", required=True)
    for component in FILES:
        parser.add_argument("--" + component + "-digest", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-only", action="store_true", help="Verify CI/provenance without editing or pushing")
    mode.add_argument("--push", action="store_true", help="Write a scoped promotion commit using the CI token")
    args = parser.parse_args(argv)
    digests = {component: getattr(args, component + "_digest") for component in FILES}
    try:
        validate(args.branch, args.source, digests)
        wait_for_checks(args.branch, args.source)
        verify_images(args.source, digests)
        head = candidate_head(ROOT, args.branch, args.source)
        if head != args.source:
            # Host/ConfigMap/docs-only advances need their own source checks,
            # while the unchanged image build retains its exact browser proof.
            wait_for_checks(args.branch, head, checks=(CHECKS[0],))
        if args.check_only:
            print("CI, both Linux architectures and image/source provenance verified. No files were edited or pushed.")
            return 0
        commit = publish(ROOT, args.branch, args.source, digests, head)
        if commit:
            print("Promoted " + args.source + " to " + args.branch + " at " + commit + ". Appliance convergence is separate.")
        return 0
    except Superseded as error:
        print(str(error))
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, PromotionError) else "Promotion verification failed; nothing was pushed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
