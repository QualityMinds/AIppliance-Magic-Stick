# SPDX-License-Identifier: BUSL-1.1
"""Resolve the small Odysseus image lock against public OCI registries.

The runtime always consumes digests. Moving supplier tags are checked only here;
updates become reviewed development PRs, never automatic appliance mutations.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "magic-cluster/apps/instances/odysseus/files/runtime-images.json"
REGISTRIES = {
    "docker.io": ("registry-1.docker.io", "https://auth.docker.io/token", "registry.docker.io"),
    "ghcr.io": ("ghcr.io", "https://ghcr.io/token", "ghcr.io"),
}
ACCEPT = ", ".join(("application/vnd.oci.image.index.v1+json",
                    "application/vnd.docker.distribution.manifest.list.v2+json",
                    "application/vnd.oci.image.manifest.v1+json",
                    "application/vnd.docker.distribution.manifest.v2+json"))


def fetch(url, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": "magicstick-image-review", **(headers or {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(), response.headers


def resolve(repository, tag, fetcher=fetch):
    registry, name = repository.split("/", 1)
    if registry not in REGISTRIES or not re.fullmatch(r"[a-z0-9._/-]+", name) or ".." in name:
        raise ValueError("Only named public Docker Hub/GHCR repositories are supported")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", tag):
        raise ValueError("Invalid supplier tag")
    host, auth, service = REGISTRIES[registry]
    query = urllib.parse.urlencode({"service": service, "scope": f"repository:{name}:pull"})
    token_body, _ = fetcher(f"{auth}?{query}")
    token_data = json.loads(token_body)
    token = token_data.get("token") or token_data.get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("Registry did not return a pull token")
    body, headers = fetcher(f"https://{host}/v2/{name}/manifests/{tag}",
                            {"Authorization": f"Bearer {token}", "Accept": ACCEPT})
    digest = "sha256:" + hashlib.sha256(body).hexdigest()
    if headers.get("Docker-Content-Digest", digest) != digest:
        raise ValueError("Registry digest does not match the received manifest")
    manifest = json.loads(body)
    if manifest.get("schemaVersion") != 2 or not ("manifests" in manifest or "config" in manifest):
        raise ValueError("Registry response is not an OCI/Docker v2 manifest")
    if "manifests" in manifest:
        platforms = {f"{p.get('platform', {}).get('os')}/{p.get('platform', {}).get('architecture')}"
                     for p in manifest["manifests"]}
    else:
        config_digest = manifest["config"].get("digest", "")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", config_digest):
            raise ValueError("Image config needs a valid immutable digest")
        config_body, _ = fetcher(f"https://{host}/v2/{name}/blobs/{config_digest}",
                                {"Authorization": f"Bearer {token}"})
        if "sha256:" + hashlib.sha256(config_body).hexdigest() != config_digest:
            raise ValueError("Image config digest mismatch")
        config = json.loads(config_body)
        platforms = {f"{config.get('os')}/{config.get('architecture')}"}
    if "linux/amd64" not in platforms:
        raise ValueError("Candidate has no linux/amd64 image")
    return digest


def updated_lock(record, resolver=resolve):
    if record.get("schemaVersion") != 1 or set(record.get("images", {})) != {"chroma", "ntfy", "odysseus"}:
        raise ValueError("Unexpected image-lock schema or image set")
    result = json.loads(json.dumps(record))
    changes = []
    for name, image in result["images"].items():
        digest = resolver(image["repository"], image["trackTag"])
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError("Invalid candidate digest")
        if image["digest"] != digest:
            changes.append({"image": name, "from": image["digest"], "to": digest})
            image["digest"] = digest
    return result, changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Update the lock after all lookups succeed")
    args = parser.parse_args()
    record, changes = updated_lock(json.loads(LOCK.read_text()))
    if args.write and changes:
        LOCK.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"changes": changes, "written": bool(args.write and changes)}, indent=2))


if __name__ == "__main__":
    main()
