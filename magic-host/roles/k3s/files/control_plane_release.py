"""Join the managed network feature to an explicit, immutable pin promotion."""

import json
from pathlib import Path
import re
import subprocess
import sys

KDNS = Path("magic-cluster/platform/basis/kdns")
MARKER = KDNS / "link-independent-network.json"
API = Path("magic-cluster/apps/dashboard/api-deployment.yaml")
DIGEST = r"@sha256:[0-9a-f]{64}"
KDNS_IMAGE = r"ghcr\.io/qualityminds/magicstick-kdns(?::sha-[0-9a-f]{40})?" + DIGEST
API_IMAGE = r"ghcr\.io/qualityminds/magicstick-dashboard:api-sha-[0-9a-f]{40}" + DIGEST


def parse_marker(text):
    marker = json.loads(text)
    if (not isinstance(marker, dict) or marker.keys() != {"version", "kdns", "dashboardApi"} or type(marker["version"]) is not int
            or marker["version"] != 1 or not all(isinstance(marker[key], str) for key in ("kdns", "dashboardApi"))
            or not re.fullmatch(KDNS_IMAGE, marker["kdns"]) or not re.fullmatch(API_IMAGE, marker["dashboardApi"])):
        raise ValueError("Invalid link-independent network artifact declaration.")
    return marker


def rebind_api(text, old_image, new_image):
    """Reproduce the only allowed marker change in an ordinary API pin update."""
    marker = parse_marker(text)
    if marker["dashboardApi"] != old_image or not re.fullmatch(API_IMAGE, new_image):
        raise ValueError("Cannot rebind an unrelated link-independent network image.")
    if old_image == new_image:
        return text
    marker["dashboardApi"] = new_image
    return json.dumps(marker, indent=2, sort_keys=True) + "\n"


def qualified_pins(checkout, revision=None):
    if revision is None:
        if (checkout / MARKER).is_symlink():
            raise ValueError("The managed network artifact declaration cannot be a symbolic link.")
        if not (checkout / MARKER).exists():
            return None

        def read(path):
            return (checkout / path).read_text(encoding="utf-8")
    else:
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise ValueError("Expected the reviewed immutable Git revision.")

        def read(path):
            result = subprocess.run(["git", "-C", str(checkout), "show", revision + ":" + path.as_posix()],
                                    capture_output=True, text=True, timeout=10, check=False)
            if result.returncode:
                raise ValueError("The selected revision lacks the managed network artifact declaration.")
            return result.stdout

    marker = parse_marker(read(MARKER))
    try:
        import yaml
    except ImportError as error:
        raise ValueError("The promoted network profile requires system PyYAML.") from error
    try:
        kdns = yaml.safe_load(read(KDNS / "helmrelease.yaml"))
        patches = [item for renderer in kdns["spec"]["postRenderers"]
                   for item in renderer.get("kustomize", {}).get("patches", [])
                   if item.get("target") == {"kind": "Deployment", "name": "kdns-kdns"}]
        images = [change.get("value") for patch in patches for change in yaml.safe_load(patch["patch"])
                  if change.get("op") == "replace" and change.get("path") == "/spec/template/spec/containers/0/image"]
        api = yaml.safe_load(read(API))
    except yaml.YAMLError as error:
        raise ValueError("Invalid network image manifest.") from error
    api_images = [container.get("image") for container in api["spec"]["template"]["spec"]["containers"]
                  if container.get("name") == "api"]
    if images != [marker["kdns"]] or api_images != [marker["dashboardApi"]]:
        raise ValueError("Link-independent network artifacts do not match the GitOps pins.")
    return marker


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3):
            raise ValueError("Expected the owning GitOps checkout.")
        print("qualified" if qualified_pins(Path(sys.argv[1]), *sys.argv[2:]) else "unavailable")
    except (KeyError, AttributeError, TypeError, ValueError, OSError, subprocess.TimeoutExpired):
        print("Invalid or unavailable link-independent network pins.", file=sys.stderr)
        raise SystemExit(1)
