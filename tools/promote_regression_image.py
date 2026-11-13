# SPDX-License-Identifier: BUSL-1.1
"""Render canonical tested runner pins. Publish through normal trunk PRs only."""
import argparse
import re

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
    updated = re.sub(r'^  sourceRevision:.*$', '  sourceRevision: "' + source + '"',
        re.sub(r'^  image:.*$', '  image: "' + image + '"', text, flags=re.M), flags=re.M)
    capability = '  diagnosticSelectionVersion: "3"'
    if re.search(r'^  diagnosticSelectionVersion:', updated, re.M):
        return re.sub(r'^  diagnosticSelectionVersion:.*$', capability, updated, flags=re.M)
    return updated.rstrip() + '\n' + capability + '\n'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True)
    p.add_argument("--digest", required=True)
    p.add_argument("--branch", required=True, choices=["main", "develop"])
    args = p.parse_args()
    image_reference(args.source, args.digest)
    p.error("Direct channel promotion is retired. Use tools/trunk_promotion.py --propose for a normal main PR; replacement() remains the canonical pin renderer.")


if __name__ == "__main__":
    main()
