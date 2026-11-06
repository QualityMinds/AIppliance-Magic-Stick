# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. All rights reserved.
"""Resolve a public release once, then bind fresh host/Flux bootstrap to its SHA.

No appliance reset, entitlement change, mutable-tag fallback or host convergence.
The caller remains responsible for authorizing installation on a dedicated host.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "magic-host/roles/host-management/files"))
import release_catalog as catalog


def host_software():
    # Public resolution also runs on Windows. Import the Linux host worker
    # (fcntl/host recovery) only when actually binding a local host checkout.
    import software_channel
    return software_channel


def resolve(version, expected=None, *, client=None):
    client = client or catalog.ReleaseClient()
    proof = client.latest_stable() if version == "stable" else client.resolve(version, expected_commit=expected)
    if expected and proof["commit"] != expected:
        raise catalog.ReleaseError("The installer release no longer matches its embedded approved commit.")
    return proof


def git(root, *args):
    try:
        return subprocess.check_output(["git", "-C", str(root), *args], text=True,
            stderr=subprocess.PIPE, timeout=180).strip()
    except (OSError, subprocess.SubprocessError):
        raise catalog.ReleaseError("The release Git identity could not be verified; installation was not started.") from None


def checkout(root, proof):
    root = Path(root)
    software = host_software()
    if git(root, "remote", "get-url", "origin") != "https://github.com/" + catalog.REPOSITORY + ".git":
        raise catalog.ReleaseError("Product releases must use the official public repository.")
    if git(root, "status", "--porcelain"):
        raise catalog.ReleaseError("Release bootstrap requires a clean fresh checkout; existing work was preserved.")
    git(root, "fetch", "--no-tags", "--depth=1", "origin", "refs/tags/" + proof["version"])
    if git(root, "rev-parse", "FETCH_HEAD^{commit}") != proof["commit"] or git(root, "rev-parse", "FETCH_HEAD") != proof["tagObject"]:
        raise catalog.ReleaseError("The fetched tag differs from the published immutable release.")
    read = lambda path: git(root, "show", proof["commit"] + ":" + path)
    for path in ("LICENSE-RELEASE.json", "licenses/releases/" + proof["version"] + ".json"):
        if catalog.strict_json(read(path).encode()) != proof["license"]:
            raise catalog.ReleaseError("The release license dates differ from its exact source/archive.")
    inventory = software.image_inventory(root / ".git", proof["commit"])
    expected = {item["component"]: item["image"] for item in proof["images"]}
    if [item["image"] for item in inventory] != [expected[name] for name in ("web", "api", "cli", "operator")]:
        raise catalog.ReleaseError("Release images differ from the approved source pins.")
    runtime = read("magic-cluster/apps/regression/runtime.yaml")
    if ('  image: "' + expected["runner"] + '"') not in runtime:
        raise catalog.ReleaseError("The release runner pin differs from its published manifest.")
    git(root, "checkout", "--detach", proof["commit"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="stable")
    parser.add_argument("--expected-commit")
    parser.add_argument("--resolve-only", action="store_true")
    parser.add_argument("--checkout", type=Path, default=ROOT)
    parser.add_argument("--metadata", type=Path)
    parser.add_argument("--format", choices=("json", "tsv"), default="json")
    args = parser.parse_args()
    try:
        version, expected = args.version, args.expected_commit
        if args.metadata:
            software = host_software()
            values = software.metadata(args.metadata)
            version = values.get("MAGICSTICK_PUBLIC_REF", "stable")
            expected = values.get("MAGICSTICK_PUBLIC_REF_COMMIT") or None
            if values.get("MAGICSTICK_PUBLIC_REF_KIND") not in {"release", "tag"} or version != "stable" and not catalog.is_product_version(version):
                return  # Explicit branch/commit/custom tag: retain the advanced path.
        proof = resolve(version, expected)
        if not args.resolve_only:
            checkout(args.checkout, proof)
            if args.metadata:
                software.METADATA = args.metadata
                software.save_selection({"kind": "tag", "value": proof["version"]}, proof["commit"], proof["tagObject"])
        if args.format == "tsv":
            print("\t".join(proof[key] for key in ("version", "commit", "tagObject")))
        else:
            print(json.dumps(proof, sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, (str(error) if isinstance(error, catalog.ReleaseError) else "Release bootstrap verification failed; no installation fallback was selected.") + "\n")


if __name__ == "__main__":
    main()
