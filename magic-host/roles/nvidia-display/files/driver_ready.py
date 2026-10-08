#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""Coordinate the first-boot NVIDIA handoff without probing a Nouveau-bound GPU."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess

GATE = "appliance.magicstick.dev/nvidia-startup-gate"
PENDING = "waiting-for-host-driver"
OPERANDS = "nvidia.com/gpu.deploy.operands"
DRIVER = "nvidia.com/gpu.deploy.driver"
KUBECTL = ["/usr/local/bin/k3s", "kubectl"]
NEW_INSTALL = Path("/var/lib/magicstick/setup/new-install")
LOCK = Path("/var/lib/magicstick/host-management/maintenance.lock")
SHUTDOWN = Path("/run/systemd/shutdown/scheduled")


def readiness(root=Path("/")):
    """Read only PCI sysfs; never run nvidia-smi, modprobe or a driver installer."""
    devices = []
    complete = True
    directory = root / "sys/bus/pci/devices"
    if not directory.exists():
        return {"ready": False, "inventoryComplete": True, "devices": []}
    for device in sorted(directory.iterdir()):
        try:
            vendor = int((device / "vendor").read_text().strip(), 16)
            kind = int((device / "class").read_text().strip(), 16)
        except (OSError, ValueError):
            complete = False
            continue
        if vendor != 0x10DE or kind >> 16 != 0x03:
            continue
        try:
            driver = (device / "driver").resolve(strict=True).name
        except FileNotFoundError:
            driver = "unbound"
        except OSError:
            complete = False
            driver = "unknown"
        devices.append({"pciAddress": device.name, "driver": driver})
    return {"ready": complete and bool(devices) and all(item["driver"] == "nvidia" for item in devices),
            "inventoryComplete": complete, "devices": devices}


def command(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=10).stdout


def bootstrap_config(fresh, ready):
    config = ("# The host owns NVIDIA DRM so the local setup/TUI console remains visible.\n"
              "node-label:\n  - nvidia.com/gpu.deploy.driver=false\n")
    if fresh and not ready:
        config += "  - nvidia.com/gpu.deploy.operands=false\n"
    return config


def read_node(name, run):
    node = json.loads(run([*KUBECTL, "get", "node", name, "-o", "json"]))
    metadata = node["metadata"]
    if metadata.get("name") != name or not metadata.get("uid") or not metadata.get("resourceVersion"):
        raise ValueError("Incomplete local Node identity")
    return node


def escaped(key):
    return key.replace("~", "~0").replace("/", "~1")


def patch_node(node, operations, run):
    metadata = node["metadata"]
    # The version check also prevents overwriting a concurrent settings/label change.
    patch = [{"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
             {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
             *operations]
    run([*KUBECTL, "patch", "node", metadata["name"], "--type=json", "-p", json.dumps(patch)])


def arm_gate(name, run=command):
    node = read_node(name, run)
    metadata = node["metadata"]
    annotations = metadata.get("annotations") or {}
    labels = metadata.get("labels") or {}
    if annotations.get(GATE) not in (None, PENDING):
        raise ValueError("A different startup-gate owner exists")
    if annotations.get(GATE) == PENDING and labels.get(OPERANDS) == "false":
        return {"state": PENDING, "changed": False}
    operations = []
    for field in ("annotations", "labels"):
        if metadata.get(field) is None:
            operations.append({"op": "add", "path": "/metadata/" + field, "value": {}})
    operations += [{"op": "add", "path": "/metadata/annotations/" + escaped(GATE), "value": PENDING},
                   {"op": "add", "path": "/metadata/labels/" + escaped(OPERANDS), "value": "false"}]
    patch_node(node, operations, run)
    return {"state": PENDING, "changed": True}


def release_gate(name, run=command, root=Path("/")):
    state = readiness(root)
    if not state["ready"]:
        return {"state": PENDING, "changed": False,
                "message": "Waiting for the host driver handoff; NVIDIA services remain deferred."}
    node = read_node(name, run)
    metadata = node["metadata"]
    annotations = metadata.get("annotations") or {}
    labels = metadata.get("labels") or {}
    # Never enable an administrator's disabled operands or a foreign gate.
    if annotations.get(GATE) != PENDING:
        return {"state": "unmanaged", "changed": False}
    if labels.get(OPERANDS) != "false":
        raise ValueError("The managed startup gate was changed; refusing to overwrite it")
    run(["/usr/bin/nvidia-smi", "-L"])
    run(["/usr/bin/systemctl", "start", "nvidia-persistenced.service"])
    socket = root / "run/nvidia-persistenced/socket"
    if not socket.exists() or not stat.S_ISSOCK(socket.stat().st_mode):
        raise ValueError("NVIDIA persistence socket is not ready")
    patch_node(node, [
        {"op": "test", "path": "/metadata/annotations/" + escaped(GATE), "value": PENDING},
        {"op": "test", "path": "/metadata/labels/" + escaped(OPERANDS), "value": "false"},
        # Operator v26.7.0 removes individual deploy labels while operands=false.
        # Restore host ownership atomically with release, before any operand can start.
        {"op": "add", "path": "/metadata/labels/" + escaped(DRIVER), "value": "false"},
        {"op": "replace", "path": "/metadata/labels/" + escaped(OPERANDS), "value": "true"},
        {"op": "remove", "path": "/metadata/annotations/" + escaped(GATE)},
    ], run)
    return {"state": "ready", "changed": True,
            "message": "Host NVIDIA driver and persistence are ready; Operator operands released."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    for option in ("status", "ready", "arm", "release"):
        mode.add_argument("--" + option, action="store_true")
    parser.add_argument("--node")
    parser.add_argument("--root", type=Path, default=Path("/"))
    parser.add_argument("--fresh-install", action="store_true")
    args = parser.parse_args()
    if args.status or args.ready:
        state = readiness(args.root)
        if args.ready:
            return 0 if state["ready"] else 1
        state["bootstrapConfig"] = bootstrap_config(args.fresh_install, state["ready"])
        print(json.dumps(state, sort_keys=True))
        return 0
    if os.geteuid() != 0 or args.root != Path("/"):
        parser.error("Node handoff requires root and the real host filesystem")
    if not args.node or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", args.node):
        parser.error("A valid local Node name is required")
    if args.arm:
        if not NEW_INSTALL.is_file():
            parser.error("Only an installer-created first boot may arm this gate")
        result = arm_gate(args.node)
    else:
        LOCK.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(json.dumps({"state": "maintenance-active", "changed": False}))
                return 0
            if SHUTDOWN.exists():
                result = {"state": "reboot-pending", "changed": False}
            else:
                result = release_gate(args.node)
        finally:
            os.close(descriptor)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        # Do not expose command output, Node annotations or local credentials.
        print(json.dumps({"state": "failed", "changed": False,
                          "message": "NVIDIA startup handoff failed; gate remains closed."}))
        raise SystemExit(1)
