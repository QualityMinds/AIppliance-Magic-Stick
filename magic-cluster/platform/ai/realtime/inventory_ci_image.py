# SPDX-License-Identifier: BUSL-1.1
"""Inventory an already tested image without exporting another image archive.

The pinned Syft binary reads the final, read-only container filesystem. The
scanner and its bounded scratch space are not part of the resulting inventory.
No image entrypoint, Docker socket, registry credentials or GPU is exposed.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def scan_command(image_id, platform, scanner, source_version, config):
    return [
        "docker", "run", "--rm", "--pull", "never", "--platform", platform,
        "--network", "none", "--read-only", "--user", "0:0", "--workdir", "/",
        "--memory", "6g", "--cpus", "2", "--pids-limit", "512", "--ulimit", "core=0",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/run/magicstick-syft:rw,noexec,nosuid,size=1g",
        "--mount", f"type=bind,source={scanner},target=/magicstick-ci-tools/syft,readonly",
        "--mount", f"type=bind,source={config},target=/magicstick-ci-tools/syft.yaml,readonly",
        "--env", "TMPDIR=/run/magicstick-syft",
        "--env", "XDG_CACHE_HOME=/run/magicstick-syft",
        "--env", "SYFT_CHECK_FOR_APP_UPDATE=false", "--env", "SYFT_LICENSE_CONTENT=all",
        "--entrypoint", "/magicstick-ci-tools/syft", image_id,
        "scan", "dir:/", "--config", "/magicstick-ci-tools/syft.yaml", "--parallelism", "2",
        # Directory defaults also scan declarations; keep image/installed-package semantics.
        "--override-default-catalogers", "image,file",
        "--exclude", "./magicstick-ci-tools/**", "--exclude", "./run/magicstick-syft/**",
        "--exclude", "./proc/**", "--exclude", "./sys/**", "--exclude", "./dev/**",
        "--source-name", "magicstick-omni-rocm", "--source-version", source_version,
        "-o", "syft-json",
    ]


def inventory(image, source_version, output, scanner=None):
    host_scanner = shutil.which("syft")
    if not host_scanner:
        raise ValueError("Install the checksum-verified Syft from setup-license-scanner first")
    scanner = Path(scanner or host_scanner).resolve(strict=True)
    inspected = json.loads(subprocess.run(
        ["docker", "image", "inspect", image, "--format", "{{json .}}"],
        check=True, text=True, capture_output=True,
    ).stdout)
    image_id = inspected.get("Id", "")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Docker did not return an immutable tested image ID")
    if inspected.get("Os") != "linux" or inspected.get("Architecture") not in {"amd64", "arm64"}:
        raise ValueError("The filesystem inventory requires a native Linux image/scanner")
    if inspected.get("Config", {}).get("Volumes"):
        raise ValueError("Declared image volumes could hide filesystem contents during inventory")
    platform = f"{inspected['Os']}/{inspected['Architecture']}"
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    # A failed repeat run must not leave a previous success report looking current.
    for name in ("image-identity.json", "image.syft.json", "image.spdx.json", "image.cdx.json"):
        (output / name).unlink(missing_ok=True)
    (output / "tested-image-id.txt").write_text(image_id + "\n")
    config = (output / "syft-config.yaml").resolve()
    # Use an explicit YAML config so neither image nor runner dotfiles alter the scan.
    config.write_text("check-for-app-update: false\n")
    partial = output / "image.syft.json.partial"
    with partial.open("w") as stream:
        subprocess.run(scan_command(image_id, platform, scanner, source_version, config),
                       check=True, text=True, stdout=stream)
    document = json.loads(partial.read_text())
    if document.get("source", {}).get("type") != "directory" or not document.get("artifacts"):
        raise ValueError("Expected a nonempty inventory of the tested image's final filesystem")
    sbom = output / "image.syft.json"
    partial.replace(sbom)
    # Convert the small inventory, not the multi-gigabyte image, into both release formats.
    subprocess.run([
        host_scanner, "convert", str(sbom), "--config", str(config),
        "-o", f"spdx-json={output / 'image.spdx.json'}",
        "-o", f"cyclonedx-json={output / 'image.cdx.json'}",
    ], check=True)
    identity = {
        "imageID": image_id, "architecture": inspected["Architecture"], "os": inspected["Os"],
        "sourceRevision": source_version, "scanSource": "read-only-container-filesystem",
        "catalogers": ["image", "file"], "sbomSha256": hashlib.sha256(sbom.read_bytes()).hexdigest(),
    }
    # Keep identity explicit without pretending a directory SBOM contains layer metadata.
    # Never copy image environment variables or layer history into public evidence.
    (output / "image-identity.json").write_text(json.dumps(identity, indent=2) + "\n")
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--syft-linux-binary", type=Path,
                        help="Linux scanner matching the image architecture (for local macOS tests)")
    args = parser.parse_args()
    inventory(args.image, args.source_version, args.output, args.syft_linux_binary)


if __name__ == "__main__":
    main()
