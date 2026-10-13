"""Promote only an already-tested immutable runner on its original channel.

Called by the trusted runner-build job after digest/source inspection. Never
rebase an old runner onto new source, force-push or dispatch another workflow.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import license_audit

PIN = "magic-cluster/apps/regression/runtime.yaml"
PROMOTIONS = {PIN, "licenses/dependency-inventory.json", "magic-cluster/apps/dashboard/api-deployment.yaml",
              "magic-cluster/apps/dashboard/deployment.yaml", "magic-host/roles/dashboard-console/defaults/main.yml"}


def source_advanced(paths):
    # The case catalogue is copied into the image and controls reporting. Other
    # handbook edits may advance without invalidating this tested runner.
    return any(path not in PROMOTIONS and (not path.startswith("docs/")
               or path == "docs/development/regression-test-catalog.md") for path in paths)


def image_reference(source, digest):
    if not re.fullmatch(r"[a-f0-9]{40}", source) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError("A full source commit and SHA-256 digest are required.")
    return "ghcr.io/qualityminds/magicstick-regression:sha-" + source + "@" + digest


def replacement(text, source, digest):
    image = image_reference(source, digest)
    if len(re.findall(r"^  image:", text, re.M)) != 1 or len(re.findall(r"^  sourceRevision:", text, re.M)) != 1:
        raise ValueError("Expected exactly one runner pin and source revision.")
    return re.sub(r'^  sourceRevision:.*$', '  sourceRevision: "' + source + '"',
        re.sub(r'^  image:.*$', '  image: "' + image + '"', text, flags=re.M), flags=re.M)


def git(*args):
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL, timeout=180).strip()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True)
    p.add_argument("--digest", required=True)
    p.add_argument("--branch", required=True, choices=["main", "develop"])
    args = p.parse_args()
    image_reference(args.source, args.digest)
    if git("status", "--porcelain"):
        raise ValueError("Promotion requires a clean dedicated CI checkout.")
    git("config", "user.name", "github-actions[bot]")
    git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
    # Dashboard and runner promotions may finish concurrently. Recompute a
    # scoped commit on the observed remote head, rather than pushing a stale tree.
    for _ in range(3):
        git("fetch", "--no-tags", "origin", "refs/heads/" + args.branch)
        head = git("rev-parse", "FETCH_HEAD")
        git("merge-base", "--is-ancestor", args.source, head)
        changed = git("diff", "--name-only", args.source, head).splitlines()
        if source_advanced(changed):
            print("A newer source revision superseded this runner; no promotion was made.")
            return
        git("checkout", "--detach", head)
        path = Path(PIN)
        before = path.read_text()
        after = replacement(before, args.source, args.digest)
        if after == before:
            print("Runner already pinned; no new commit.")
            return
        path.write_text(after)
        license_audit.refresh_references(Path.cwd())
        if license_audit.source_checks(Path.cwd()):
            raise ValueError("Promoted source/license references are inconsistent; nothing was pushed.")
        if set(git("diff", "--name-only").splitlines()) - {PIN, "licenses/dependency-inventory.json"}:
            raise ValueError("Runner promotion must not change other source files.")
        changed = set(git("diff", "--name-only").splitlines())
        git("add", "--", PIN, "licenses/dependency-inventory.json")
        if set(git("diff", "--cached", "--name-only").splitlines()) != changed:
            raise ValueError("Unexpected staged content; nothing was pushed.")
        git("commit", "-m", "chore(images): promote regression " + args.source[:12] + " on " + args.branch)
        result = subprocess.run(["git", "push", "origin", "HEAD:" + args.branch], capture_output=True, timeout=180)
        if result.returncode == 0:
            print("Tested runner promoted to " + args.branch + ": " + image_reference(args.source, args.digest))
            return
    raise ValueError("Channel advanced repeatedly; runner promotion was not force-pushed.")


if __name__ == "__main__":
    main()
