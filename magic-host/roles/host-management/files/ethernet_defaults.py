#!/usr/bin/env python3
"""Give unconfigured physical Ethernet ports DHCP on first installation only."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import network_config as network

FIRST_INSTALL = Path("/var/lib/magicstick/setup/new-install")
INSTALLED_K3S = (Path("/usr/local/bin/k3s"), Path("/etc/rancher/k3s/config.yaml"))
OVERLAY = "90-magicstick-ethernet-defaults.yaml"
STRUCTURAL_KEYS = {"match", "set-name", "renderer", "optional"}


def physical_ethernet(root=Path("/sys/class/net")):
    for device in sorted(root.iterdir()):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}", device.name):
            continue
        if not (device / "device").exists() or any(
            (device / name).exists() for name in ("wireless", "phy80211")
        ):
            continue
        try:
            kind = (device / "type").read_text().strip()
            uevent = (device / "uevent").read_text().splitlines()
            mac = (device / "address").read_text().strip()
        except OSError:
            continue
        if kind == "1" and not any(line.startswith("DEVTYPE=") for line in uevent):
            yield device.name, mac


def ethernet_overlay(effective, devices, default_routes):
    config = effective.get("network", {})
    if (config.get("renderer", "networkd") != "networkd"
            or set(config) - {"version", "renderer", "ethernets", "wifis"}):
        return {}

    # Retain the link that is already carrying first boot, even when a new
    # Ethernet lease arrives as provisioning continues.
    metric = 100
    if default_routes:
        metric = max(600, max(route.get("metric", 0) for route in default_routes)) + 100
    if metric > 65535:
        return {}

    ports = {}
    for name, mac in devices:
        try:
            key, profile = network.profile_for(config, name, mac, "ethernet")
        except ValueError:
            continue
        if (set(profile) - STRUCTURAL_KEYS
                or profile.get("renderer", "networkd") != "networkd"
                or set(profile.get("match", {})) - {"name", "macaddress"}
                or any(char in profile.get("match", {}).get("name", "") for char in "*?[]")):
            continue
        ports[key] = {
            "dhcp4": True,
            "dhcp-identifier": "mac",
            "optional": profile.get("optional", True),
            "dhcp4-overrides": {"route-metric": metric},
        }
    return {"network": {"version": 2, "ethernets": ports}} if ports else {}


def apply_defaults():
    if not FIRST_INSTALL.is_file() or any(path.exists() for path in INSTALLED_K3S):
        return "unchanged"
    if os.geteuid() != 0:
        raise RuntimeError("First-install network configuration requires root.")

    output = network.NETPLAN / OVERLAY
    if output.exists():
        return "unchanged"
    import yaml

    try:
        if network.command(["systemctl", "is-active", "systemd-networkd"]).strip() != "active":
            return "unchanged"
        effective, _, _ = network.configuration()
        routes = json.loads(network.command(["ip", "-j", "-4", "route", "show", "default"]))
        overlay = ethernet_overlay(effective, physical_ethernet(), routes)
    except (OSError, RuntimeError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired, yaml.YAMLError):
        return "unchanged"
    if not overlay:
        return "unchanged"

    # Publish a new 0600 overlay without overwriting the installer's files.
    with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, encoding="utf-8") as staging:
        yaml.safe_dump(overlay, staging, sort_keys=False)
        staging.flush()
        os.fsync(staging.fileno())
        try:
            os.link(staging.name, output)
        except FileExistsError:
            return "unchanged"
        try:
            network.command(["netplan", "generate"], timeout=30)
            # Only newly matched or changed links are reconfigured. Do not
            # run a global netplan apply that stops unrelated Wi-Fi supplicants.
            network.command(["networkctl", "reload"], timeout=30)
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            if not os.path.samefile(staging.name, output):
                raise RuntimeError("Network files changed during first-install preparation.") from None
            output.unlink()
            network.command(["netplan", "generate"], timeout=30)
            network.command(["networkctl", "reload"], timeout=30)
            return "rolled-back"
    return "configured"


if __name__ == "__main__":
    print(apply_defaults())
