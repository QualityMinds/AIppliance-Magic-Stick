#!/usr/bin/env python3
"""Read-only, dependency-free AMD host evidence; never labels or prepares a node."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess


PROFILE_ID = "strix-halo"
SOURCE = "https://rocm.docs.amd.com/en/docs-7.2.0/how-to/system-optimization/strixhalo.html"


def read(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:262144].strip()
    except OSError:
        return ""


def number(value):
    try:
        return int(value.strip(), 0)
    except (ValueError, AttributeError):
        return None


def hex_id(value):
    parsed = number(value)
    return format(parsed, "04x") if parsed is not None else ""


def command(argv, live=True):
    if not live:
        return {"status": "not-run", "reason": "offline-root"}, ""
    executable = shutil.which(argv[0])
    if not executable and argv[0] == "rocminfo" and Path("/opt/rocm/bin/rocminfo").is_file():
        executable = "/opt/rocm/bin/rocminfo"
    if not executable:
        return {"status": "unavailable", "reason": "command-not-found"}, ""
    try:
        result = subprocess.run([executable, *argv[1:]], capture_output=True, text=True, timeout=20, check=False)
        # Raw command output can contain host details. Return parsed evidence only.
        status = {"status": "ok" if result.returncode == 0 else "failed", "exitCode": result.returncode}
        return status, result.stdout
    except subprocess.TimeoutExpired:
        return {"status": "failed", "reason": "timeout"}, ""
    except OSError:
        return {"status": "failed", "reason": "execution-error"}, ""


def device_status(path):
    try:
        mode = path.stat().st_mode
        return {"present": True, "charDevice": stat.S_ISCHR(mode), "readable": os.access(path, os.R_OK), "writable": os.access(path, os.W_OK)}
    except OSError:
        return {"present": False, "charDevice": False, "readable": False, "writable": False}


def kernel_evidence(release):
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", release)
    version = tuple(map(int, match.groups())) if match else None
    oem = re.match(r"^6\.14\.0-(\d+)-oem", release)
    # AMD documents required upstream fixes and a specific Ubuntu OEM backport.
    # A known version does NOT certify the separate userspace ROCm combination.
    if version and (version >= (6, 18, 4) or (oem and int(oem.group(1)) >= 1018)):
        fixes = "present"
    elif version and version < (6, 14, 0):
        fixes = "missing"
    else:
        fixes = "unknown"
    return {"release": release, "strixHaloFixes": fixes, "source": SOURCE, "runtimeCompatibility": "not-validated"}


def installed_memory_bytes(output):
    """Sum populated SMBIOS devices, never array maximum capacity or partial data."""
    sizes = re.findall(r"^\s*Size:\s*(.+?)\s*$", output, re.M)
    total = 0
    for size in sizes:
        if size == "No Module Installed":
            continue
        match = re.fullmatch(r"(\d+) (kB|MB|GB|TB)", size)
        if not match or int(match[1]) <= 0:
            return None
        total += int(match[1]) * {"kB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}[match[2]]
    return total or None


def firmware_reserved_mi(device_path, vram_bytes):
    """Only label VRAM as a carve-out when the current firmware option agrees."""
    index = number(read(device_path / "uma/carveout"))
    if index is None:
        return None
    for line in read(device_path / "uma/carveout_options").splitlines():
        match = re.fullmatch(r"\s*(\d+):.*\((\d+) (MB|GB)\)\s*", line)
        if match and int(match[1]) == index:
            size_mi = int(match[2]) * (1024 if match[3] == "GB" else 1)
            return size_mi if size_mi > 0 and size_mi * 1024**2 == vram_bytes else None
    return None


def gpu_allocation_capacity(device, fixed_mi, ttm_bytes, linux_bytes):
    """Corroborate the active KFD allocation domain, never sum VRAM and GTT.

    On this APU amdgpu uses GTT for ordinary device allocations only when GTT
    is larger than real VRAM. Require the PCI-matched KFD heap to agree, rather
    than infer engine capacity from a firmware option or mapping limit alone.
    This is driver capacity, not a successful engine allocation/limit test.
    """
    unknown = {"gpuAllocationMode": "unknown", "gpuCapacityMi": None, "gpuCapacitySource": "unavailable"}
    nodes = device["kfdNodes"]
    if len(nodes) != 1 or device.get("gfxArchitectures") != ["gfx1151"]:
        return unknown
    reported = nodes[0].get("localMemoryBytes")
    vram, gtt = device["memory"]["vramTotalBytes"], device["memory"]["gttTotalBytes"]
    if not all(isinstance(value, int) and value > 0 for value in (reported, vram, gtt, ttm_bytes, linux_bytes)):
        return unknown
    if gtt <= vram and reported == vram and fixed_mi and fixed_mi * 1024**2 == vram:
        mode, capacity = "firmware-reserved", vram
    elif gtt > vram and reported == ttm_bytes:
        mode, capacity = "shared-gtt", min(reported, gtt, linux_bytes)
    else:
        return unknown
    return {"gpuAllocationMode": mode, "gpuCapacityMi": capacity // 1024**2, "gpuCapacitySource": "kfd-topology"}


def collect_memory(root=Path("/")):
    """Cheap live counters only: no ROCm probes, package queries or mutations."""
    def path(value):
        return root / value.lstrip("/")

    memory = dict(re.findall(r"^(MemTotal|MemAvailable):\s+(\d+)\s+kB$", read(path("/proc/meminfo")), re.M))
    release = read(path("/proc/sys/kernel/osrelease"))
    boot = read(path("/proc/sys/kernel/random/boot_id"))
    generated = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    devices = []
    for entry in sorted(path("/sys/bus/pci/devices").glob("*")):
        cls = number(read(entry / "class"))
        if hex_id(read(entry / "vendor")) != "1002" or cls is None or cls >> 16 != 0x03:
            continue
        try:
            driver = (entry / "driver").resolve(strict=True).name
        except OSError:
            driver = None
        if driver != "amdgpu":
            continue
        counters = {field: number(read(entry / filename)) for field, filename in (
            ("vramTotalBytes", "mem_info_vram_total"), ("vramUsedBytes", "mem_info_vram_used"),
            ("gttTotalBytes", "mem_info_gtt_total"), ("gttUsedBytes", "mem_info_gtt_used"))}
        devices.append({"pciAddress": entry.name, **counters})
    return {"kernel": {"release": release}, "bootId": boot, "nodeAnnotation": {
        "schemaVersion": 1, "source": "proc-meminfo-amdgpu-sysfs", "generatedAt": generated,
        "bootId": boot, "kernelVersion": release,
        "totalBytes": int(memory["MemTotal"]) * 1024 if "MemTotal" in memory else None,
        "availableBytes": int(memory["MemAvailable"]) * 1024 if "MemAvailable" in memory else None,
        "devices": devices,
    }}


def collect(root=Path("/"), live=True):
    def path(value):
        return root / value.lstrip("/")

    os_fields = {}
    for line in read(path("/etc/os-release")).splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_fields[key] = value.strip('"\'')
    memory = {}
    for line in read(path("/proc/meminfo")).splitlines():
        match = re.match(r"^(MemTotal|MemAvailable):\s+(\d+)\s+kB$", line)
        if match:
            memory[match.group(1)] = int(match.group(2)) * 1024
    page_size = os.sysconf("SC_PAGE_SIZE") if live else 4096
    ttm_pages = number(read(path("/sys/module/ttm/parameters/pages_limit")))
    if ttm_pages is None:
        ttm_pages = number(read(path("/sys/module/amdttm/parameters/pages_limit")))
    # Resolute splits GPU firmware into a leaf package. Its version, not the
    # metapackage version, must invalidate stale GPU validation evidence.
    firmware_package = "linux-firmware-amd-graphics" if os_fields.get("ID") == "ubuntu" and os_fields.get("VERSION_ID") == "26.04" else "linux-firmware"
    package_status, firmware_version = command(["dpkg-query", "-W", "-f=${Version}", firmware_package], live)
    firmware_version = firmware_version.strip() if package_status.get("status") == "ok" else None
    firmware_dirs = [path("/lib/firmware/amdgpu"), path("/usr/lib/firmware/amdgpu")]
    firmware_files = set()
    for directory in firmware_dirs:
        if directory.is_dir():
            firmware_files.update(p.name for p in directory.iterdir() if p.is_file())
    rocminfo_status, rocminfo_output = command(["rocminfo"], live)
    architectures = sorted(set(re.findall(r"\bgfx[0-9a-f]+\b", rocminfo_output)) - {"gfx000"})
    rocminfo_status["architectures"] = architectures
    # KFD topology binds gfx evidence to individual PCI devices, unlike global rocminfo output.
    kfd_nodes = []
    topology = path("/sys/class/kfd/kfd/topology/nodes")
    if topology.is_dir():
        for node in sorted(topology.iterdir()):
            properties = dict(re.findall(r"^(\w+)\s+(\d+)$", read(node / "properties"), re.M))
            if int(properties.get("vendor_id", "0")) != 0x1002:
                continue
            target = int(properties.get("gfx_target_version", "0"))
            gfx = f"gfx{target // 10000}{(target // 100) % 100:x}{target % 100:x}" if target else ""
            banks = [dict(re.findall(r"^(\w+)\s+(\d+)$", read(bank), re.M)) for bank in sorted((node / "mem_banks").glob("*/properties"))]
            # FB_PUBLIC=1, FB_PRIVATE=2 are parts of the same KFD local heap.
            valid_banks = bool(banks) and all(bank.get("heap_type") in ("1", "2") and int(bank.get("size_in_bytes", "0")) > 0 for bank in banks)
            local_bytes = sum(int(bank["size_in_bytes"]) for bank in banks) if valid_banks else None
            kfd_nodes.append({"node": node.name, "deviceId": format(int(properties.get("device_id", "0")), "04x"), "renderMinor": int(properties.get("drm_render_minor", "0")), "gfxArchitecture": gfx, "localMemoryBytes": local_bytes})
    devices = []
    pci = path("/sys/bus/pci/devices")
    if pci.is_dir():
        for entry in sorted(pci.iterdir()):
            vendor = hex_id(read(entry / "vendor"))
            device = hex_id(read(entry / "device"))
            class_id = number(read(entry / "class"))
            if vendor != "1002" or class_id is None or class_id >> 16 != 0x03:
                continue
            try:
                driver = (entry / "driver").resolve(strict=True).name
            except OSError:
                driver = None
            render_names = sorted(item.name for item in (entry / "drm").glob("renderD*"))
            matched_kfd = [node for node in kfd_nodes if node["deviceId"] == device and f"renderD{node['renderMinor']}" in render_names]
            matched_architectures = sorted({node["gfxArchitecture"] for node in matched_kfd if node["gfxArchitecture"]})
            device_memory = {}
            for field, filename in [("vramTotalBytes", "mem_info_vram_total"), ("vramUsedBytes", "mem_info_vram_used"), ("gttTotalBytes", "mem_info_gtt_total"), ("gttUsedBytes", "mem_info_gtt_used")]:
                device_memory[field] = number(read(entry / filename))
            devices.append({"pciAddress": entry.name, "vendorId": vendor, "deviceId": device, "driver": driver,
                            "profileId": PROFILE_ID if device == "1586" else None,
                            "memoryTopology": "shared" if device == "1586" else "unknown",
                            "renderNodes": [{"path": f"/dev/dri/{name}", **device_status(path(f"/dev/dri/{name}"))} for name in render_names],
                            "kfdNodes": matched_kfd, "gfxArchitectures": matched_architectures,
                            "memory": device_memory, "computeValidated": False})
    release = read(path("/proc/sys/kernel/osrelease")) or (platform.release() if live else "unknown")
    report = {
        "schemaVersion": 1, "readOnly": True,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "bootId": read(path("/proc/sys/kernel/random/boot_id")) or None,
        "os": {"id": os_fields.get("ID", "unknown"), "versionId": os_fields.get("VERSION_ID", "unknown")},
        "kernel": kernel_evidence(release),
        "driver": {"amdgpuLoaded": path("/sys/module/amdgpu").is_dir(), "version": read(path("/sys/module/amdgpu/version")) or f"inbox-{release}", "kfd": device_status(path("/dev/kfd")),
                   "firmware": {"packageName": firmware_package, "packageVersion": firmware_version, "fileCount": len(firmware_files), "packageQuery": package_status}},
        "devices": devices,
        "systemMemory": {"totalBytes": memory.get("MemTotal"), "availableBytes": memory.get("MemAvailable"), "pageSizeBytes": page_size,
                         "ttmPagesLimit": ttm_pages, "ttmLimitBytes": ttm_pages * page_size if ttm_pages is not None else None,
                         "accounting": "shared GPU mappings are not an additional physical RAM pool"},
        "rocminfo": rocminfo_status, "warnings": [],
    }
    if not os_fields.get("ID"):
        report["kernel"]["strixHaloFixes"] = "unknown"
    if any(device["profileId"] == PROFILE_ID for device in devices):
        if report["kernel"]["strixHaloFixes"] != "present":
            report["warnings"].append("Strix Halo kernel fixes are not confirmed; do not enable compute based on PCI detection alone.")
        report["warnings"].append("Matching PCI hardware is not a successful HIP or inference test; engine validation is an optional separate diagnostic.")
    if not report["driver"]["kfd"]["present"]:
        report["warnings"].append("/dev/kfd is absent; ROCm compute cannot be assumed available.")
    if rocminfo_status["status"] != "ok":
        report["warnings"].append("Host rocminfo evidence is unavailable; probe the pinned ROCm container separately.")
    fingerprint_data = {"os": report["os"], "kernel": release, "driverVersion": report["driver"]["version"], "firmwarePackage": firmware_version,
                        "devices": [{key: device[key] for key in ("pciAddress", "vendorId", "deviceId", "driver", "gfxArchitectures")} for device in devices]}
    report["hardwareFingerprint"] = hashlib.sha256(json.dumps(fingerprint_data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    profile_devices = [device for device in devices if device["profileId"] == PROFILE_ID]
    if len(profile_devices) == 1:
        device = profile_devices[0]
        inventory_status, inventory_output = command(["dmidecode", "--type", "17"], live)
        installed_bytes = installed_memory_bytes(inventory_output) if inventory_status["status"] == "ok" else None
        report["systemMemory"]["installedBytes"] = installed_bytes
        report["systemMemory"]["inventoryQuery"] = inventory_status
        fixed_mi = firmware_reserved_mi(path("/sys/bus/pci/devices") / device["pciAddress"], device["memory"]["vramTotalBytes"])
        gfx = device["gfxArchitectures"][0] if len(device["gfxArchitectures"]) == 1 else None
        limits = [value for value in [device["memory"]["gttTotalBytes"], report["systemMemory"]["ttmLimitBytes"], memory.get("MemTotal")] if value is not None and value > 0]
        accessible_bytes = min(limits) if device["memory"]["gttTotalBytes"] and memory.get("MemTotal") else None
        report["nodeAnnotation"] = {
            "fingerprint": report["hardwareFingerprint"], "profileId": PROFILE_ID,
            "generatedAt": report["generatedAt"], "generationTimestamp": report["generatedAt"],
            "bootId": report["bootId"], "memoryArchitecture": "unified",
            "expectedArchitecture": "gfx1151", "detectedArchitecture": gfx,
            "gpuPciAddress": device["pciAddress"],
            "gpuAccessibleMi": accessible_bytes // (1024 * 1024) if accessible_bytes is not None else None,
            # MemTotal is OS-visible physical memory, deliberately excludes BIOS carve-out.
            "physicalMemoryMi": memory["MemTotal"] // (1024 * 1024) if memory.get("MemTotal") else None,
            # Inventory alone never enlarges budgets; KFD must corroborate the domain.
            "installedMemoryMi": installed_bytes // (1024 * 1024) if installed_bytes else None,
            "firmwareReservedMi": fixed_mi,
            **gpu_allocation_capacity(device, fixed_mi, report["systemMemory"]["ttmLimitBytes"], memory.get("MemTotal")),
            "memoryAccountingVerified": False,
            "driverVersion": report["driver"]["version"], "kernelVersion": release,
            "hostDriverReady": bool(device["driver"] == "amdgpu" and report["driver"]["kfd"]["charDevice"] and any(node["charDevice"] for node in device["renderNodes"]) and gfx == "gfx1151" and report["kernel"]["strixHaloFixes"] == "present"),
            "firmwareVersion": firmware_version,
        }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit compact JSON (default: indented JSON)")
    parser.add_argument("--memory-only", action="store_true", help="Read only live procfs/sysfs memory counters; no engine or package probes")
    parser.add_argument("--root", type=Path, help="Existing absolute filesystem snapshot root; disables every subprocess")
    parser.add_argument("--require-profile", choices=[PROFILE_ID], help="Exit 2 unless this exact hardware profile is detected; not a compute validation")
    args = parser.parse_args()
    if args.root is not None and (not args.root.is_absolute() or not args.root.is_dir()):
        parser.error("--root must be an existing absolute directory")
    if args.memory_only and args.require_profile:
        parser.error("--memory-only cannot be combined with --require-profile")
    report = collect_memory(args.root or Path("/")) if args.memory_only else collect(args.root or Path("/"), live=args.root is None)
    print(json.dumps(report, indent=None if args.json else 2, sort_keys=True))
    return 2 if args.require_profile and not any(device["profileId"] == args.require_profile for device in report["devices"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
