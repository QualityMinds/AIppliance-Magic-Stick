#!/usr/bin/env python3
"""Read Ubuntu's NVIDIA recommendation without installing or pinning packages."""
import json
import os
import re
import subprocess
import sys


DRIVER = re.compile(r"nvidia-driver-[0-9]+(?:-server)?(?:-open)?")
INSTALLED_DRIVER = re.compile(r"nvidia-(?:driver|headless(?:-no-dkms)?)-([0-9]+(?:-server)?(?:-open)?)")


def read_command(argv):
    return subprocess.run(
        argv, check=True, capture_output=True, text=True,
        env={**os.environ, "LC_ALL": "C.UTF-8"}, timeout=120,
    ).stdout


def installed_drivers(output):
    """Do not turn normal convergence into a driver update or branch migration."""
    packages = []
    branches = set()
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) != 2 or fields[1].strip() != "ii":
            continue
        package = fields[0].removesuffix(":amd64")
        match = INSTALLED_DRIVER.fullmatch(package)
        if match:
            packages.append(package)
            branches.add(match.group(1))
    if len(branches) > 1:
        raise ValueError("Multiple NVIDIA driver series are installed. Review the host packages before convergence.")
    return sorted(set(packages))


def recommended_driver(output):
    """Require one distro recommendation shared by every NVIDIA device."""
    recommendations = set()
    devices = re.split(r"(?m)^== .+ ==\s*$", output)
    count = 0
    for device in devices:
        nvidia = bool(re.search(r"(?im)^modalias\s*:\s*pci:v000010de", device)
                      or re.search(r"(?im)^vendor\s*:\s*.*nvidia", device))
        if not nvidia:
            continue
        count += 1
        matches = []
        for line in device.splitlines():
            match = re.fullmatch(r"driver\s*:\s*(\S+)\s+-\s+(.+)", line.strip())
            if not match or not DRIVER.fullmatch(match.group(1)):
                continue
            flags = match.group(2).split()
            if "recommended" in flags:
                if "distro" not in flags or "third-party" in flags:
                    raise ValueError("Ubuntu recommended a third-party NVIDIA driver; no repository is authorized automatically.")
                matches.append(match.group(1))
        if len(set(matches)) != 1:
            raise ValueError("Ubuntu did not report one recommended NVIDIA driver for every GPU. Check the enabled Ubuntu repositories and hardware.")
        recommendations.update(matches)
    if not count or len(recommendations) != 1:
        raise ValueError("Ubuntu did not report one common NVIDIA driver recommendation. Review the GPU inventory before installing.")
    return recommendations.pop()


def recommended_packages(driver, output):
    """Keep Ubuntu's matching prebuilt module/DKMS choice with the metapackage."""
    branch = driver.removeprefix("nvidia-driver-")
    candidates = []
    for line in output.splitlines():
        fields = line.split()
        if not fields or fields[0] != driver:
            continue
        if len(fields) not in {1, 2}:
            raise ValueError("Unsupported Ubuntu NVIDIA recommendation format; no packages were installed.")
        if len(fields) == 2:
            module = fields[1]
            if not (module == "nvidia-dkms-" + branch
                    or re.fullmatch(r"linux-modules-nvidia-" + re.escape(branch) + r"-[a-z0-9.+-]+", module)):
                raise ValueError("Ubuntu's kernel-module recommendation does not match the NVIDIA driver.")
        candidates.append(fields)
    if len(candidates) != 1:
        raise ValueError("Ubuntu did not provide the recommended NVIDIA package set. Check kernel support and Ubuntu repositories.")
    return candidates[0]


def plan(reader=read_command):
    installed = installed_drivers(reader([
        "/usr/bin/dpkg-query", "-W", "-f=${Package}\t${db:Status-Abbrev}\n",
    ]))
    if installed:
        return {"selection": "installed", "driverPackages": installed, "packages": []}
    driver = recommended_driver(reader(["/usr/bin/ubuntu-drivers", "devices"]))
    packages = recommended_packages(driver, reader([
        "/usr/bin/ubuntu-drivers", "list", "--recommended", "--include-dkms",
    ]))
    return {"selection": "ubuntu-recommended", "driverPackages": [driver], "packages": packages}


if __name__ == "__main__":
    try:
        print(json.dumps(plan(), sort_keys=True))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, ValueError) else "Could not read Ubuntu's NVIDIA recommendation. Check ubuntu-drivers-common and the local package-manager logs."
        print(message, file=sys.stderr)
        sys.exit(1)
