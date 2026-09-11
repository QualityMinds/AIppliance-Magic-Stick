"""Read-only, fail-closed Strix Halo shared-memory planning and bounded UMA write.

Firmware option indices are discovered at runtime, never supplied as paths.
Dynamic GPU memory is a limit on shared Linux RAM, not another reservation.
"""

from pathlib import Path
import re

from host_plan import digest

MIB = 1024 * 1024
RESERVE_MI = 16384
STEP_MI = 1024
MANAGED_CONFIG = "/etc/modprobe.d/90-magicstick-ttm.conf"
PCI_PATTERN = r"[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]"


def parse_options(text):
    options = []
    for line in text.strip().splitlines():
        match = re.fullmatch(r"\s*(\d+):\s*([A-Za-z ]*)\((\d+)\s+(MB|GB)\)\s*", line)
        if not match:
            raise ValueError("Firmware memory options have an unsupported format.")
        index, name, size, unit = match.groups()
        size_mi = int(size) * (1024 if unit == "GB" else 1)
        if size_mi <= 0 or size_mi > 1048576 or int(index) > 255:
            raise ValueError("Firmware memory options are invalid.")
        options.append({"index": int(index), "label": f"{name.strip()} ({size} {unit})".strip(), "sizeMi": size_mi})
    if not options or len({option["index"] for option in options}) != len(options):
        raise ValueError("Firmware memory options are missing or ambiguous.")
    if len({option["sizeMi"] for option in options}) != len(options):
        raise ValueError("Firmware memory sizes are ambiguous.")
    return options


def configuration(root=Path("/")):
    """Reject competing effective or next-boot overrides, including GRUB sources."""
    def path(name):
        return root / name.lstrip("/")
    sources, conflicts, managed_pages = {}, False, None
    seen = set()
    for directory in ("/etc/modprobe.d", "/run/modprobe.d", "/usr/local/lib/modprobe.d", "/usr/lib/modprobe.d", "/lib/modprobe.d"):
        for entry in sorted(path(directory).glob("*.conf")):
            resolved = entry.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            body = entry.read_text()
            effective = "\n".join(line.split("#", 1)[0].strip() for line in body.splitlines())
            relevant = bool(re.search(r"\b(?:pages_limit|gttsize|gartsize|vramlimit)\s*=", effective))
            if entry == path(MANAGED_CONFIG):
                match = re.fullmatch(r"\s*options ttm pages_limit=(\d+)\s*", effective)
                if entry.is_symlink() or not match or int(match.group(1)) <= 0:
                    conflicts = True
                else:
                    managed_pages = int(match.group(1))
                sources[str(entry.relative_to(root))] = body
            elif relevant:
                conflicts = True
                sources[str(entry.relative_to(root))] = body
    # A symlink at our managed destination is never safe to replace implicitly.
    if path(MANAGED_CONFIG).is_symlink():
        conflicts = True
    boot_sources = [path("/proc/cmdline"), path("/etc/default/grub"), *sorted(path("/etc/default/grub.d").glob("*.cfg"))]
    for entry in boot_sources:
        if not entry.exists():
            continue
        body = entry.read_text()
        effective = "\n".join(line.split("#", 1)[0] for line in body.splitlines())
        if re.search(r"\b(?:(?:ttm|amdttm)\.pages_limit|amdgpu\.(?:gttsize|gartsize|vramlimit))\s*=", effective):
            conflicts = True
            sources[str(entry.relative_to(root))] = body
    return {"conflicts": conflicts, "managedPages": managed_pages, "id": digest(sources)}


def memory_gpu_inventory(display_gpus, root):
    """Bind memory writes to one AMD device and inspect additional GPU drivers.

    The UMA setting belongs to the Strix Halo PCI device, but ttm.pages_limit
    is global. NVIDIA's nvidia driver can coexist; nouveau, other vendors and
    additional AMD devices must not silently share this memory policy.
    """
    if (not isinstance(display_gpus, list) or not display_gpus
            or any(not isinstance(item, str) or not re.fullmatch(r"[0-9a-f]{4}:[0-9a-f]{4}", item) for item in display_gpus)):
        raise ValueError("Complete PCI display-device inventory is required for GPU memory configuration.")
    pci = root / "sys/bus/pci/devices"
    if not pci.is_dir():
        raise ValueError("Complete PCI display-device inventory is required for GPU memory configuration.")
    inventory = []
    for entry in sorted(pci.iterdir()):
        if int((entry / "class").read_text().strip(), 16) >> 16 != 3:
            continue
        if not re.fullmatch(PCI_PATTERN, entry.name):
            raise ValueError("GPU PCI identity is invalid.")
        vendor = int((entry / "vendor").read_text().strip(), 16)
        device = int((entry / "device").read_text().strip(), 16)
        driver = (entry / "driver").resolve(strict=True).name
        inventory.append({"pciAddress": entry.name, "pciId": f"{vendor:04x}:{device:04x}", "driver": driver})
    if sorted(item["pciId"] for item in inventory) != sorted(display_gpus):
        raise ValueError("PCI GPU inventory changed during inspection. Refresh before configuring memory.")
    strix = [item for item in inventory if item["pciId"] == "1002:1586"]
    if len(strix) != 1 or strix[0]["driver"] != "amdgpu":
        raise ValueError("Shared GPU memory controls require exactly one Strix Halo GPU bound to amdgpu.")
    if any(item != strix[0] and (not item["pciId"].startswith("10de:") or item["driver"] != "nvidia") for item in inventory):
        raise ValueError("Strix Halo memory can be managed alongside NVIDIA GPUs using the nvidia driver. Additional AMD GPUs, other vendors or drivers (including nouveau) are not supported by this memory workflow.")
    return inventory, strix[0]["pciAddress"]


def collect(report, display_gpus, root=Path("/")):
    result = {"supported": False, "message": "Shared GPU memory controls require one supported Strix Halo GPU with complete firmware and memory evidence; NVIDIA GPUs using the nvidia driver may coexist.",
              "systemReserveMi": RESERVE_MI, "stepMi": STEP_MI, "minDynamicLimitMi": STEP_MI}
    identity = {"bootId": report.get("bootId"), "kernel": report.get("kernel"),
                "hardwareFingerprint": report.get("hardwareFingerprint"), "displayGpus": display_gpus}
    try:
        if report.get("os") not in (
            {"id": "ubuntu", "versionId": "24.04"}, {"id": "ubuntu", "versionId": "26.04"}
        ):
            raise ValueError(result["message"])
        inventory, address = memory_gpu_inventory(display_gpus, root)
        result["pciIdentity"] = digest(inventory)
        devices = report.get("devices") or []  # Preflight reports AMD GPUs only.
        if (len(devices) != 1 or devices[0].get("vendorId") != "1002"
                or devices[0].get("deviceId") != "1586" or devices[0].get("driver") != "amdgpu"
                or devices[0].get("pciAddress") != address):
            raise ValueError(result["message"])
        device = devices[0]
        base = root / "sys/bus/pci/devices" / address
        options = parse_options((base / "uma/carveout_options").read_text())
        raw_index = (base / "uma/carveout").read_text().strip()
        if not re.fullmatch(r"\d+", raw_index):
            raise ValueError("Firmware reservation cannot be read safely.")
        index = int(raw_index)
        current = next((item for item in options if item["index"] == index), None)
        if not current:
            raise ValueError("Current firmware reservation is not one of the advertised options.")
        memory = report.get("systemMemory") or {}
        total, dynamic = memory.get("totalBytes"), memory.get("ttmLimitBytes")
        vram = (device.get("memory") or {}).get("vramTotalBytes")
        if (memory.get("pageSizeBytes") != 4096 or type(total) is not int or total <= 0
                or type(dynamic) is not int or dynamic <= 0 or type(vram) is not int):
            raise ValueError("Linux memory, TTM limit or page size evidence is unavailable.")
        result.update(pciAddress=address, options=options, currentCarveoutIndex=index,
                      currentCarveoutMi=current["sizeMi"], currentDynamicLimitMi=dynamic // MIB,
                      systemMemoryMi=total // MIB)
        identity["dynamicLimitBytes"] = dynamic
        identity["vramBytes"] = vram
        # The preparation role configures inbox ttm, not AMD's alternative
        # out-of-tree amdttm module or a manually capped GTT allocation.
        if (root / "sys/module/amdttm").exists():
            raise ValueError("The out-of-tree AMD TTM driver is not supported by this memory workflow.")
        active_pages = (root / "sys/module/ttm/parameters/pages_limit").read_text().strip()
        if not re.fullmatch(r"\d+", active_pages) or int(active_pages) * 4096 != dynamic:
            raise ValueError("The active inbox TTM limit does not match the memory evidence.")
        gtt_override = root / "sys/module/amdgpu/parameters/gttsize"
        if gtt_override.exists() and gtt_override.read_text().strip() != "-1":
            raise ValueError("An active AMDGPU GTT override must be removed through local maintenance first.")
        config = configuration(root)
        identity["configuration"] = config
        if vram != current["sizeMi"] * MIB:
            raise ValueError("Firmware reservation differs from active GPU memory. Finish or diagnose the pending firmware reboot first.")
        if config["conflicts"]:
            raise ValueError("A competing TTM/AMDGPU memory override exists. Review local boot and modprobe settings before using the dashboard.")
        if config["managedPages"] is not None and config["managedPages"] * 4096 != dynamic:
            raise ValueError("The managed dynamic limit is not active. Finish or diagnose its pending reboot first.")
        if report.get("kernel", {}).get("strixHaloFixes") != "present":
            raise ValueError("The current kernel does not have confirmed Strix Halo fixes. Memory configuration will not change the kernel.")
        result.update(supported=True, message="Firmware reservation is fixed at boot. The dynamic GPU limit uses shared Linux RAM on demand; CPU and GPU still compete for the same memory.")
    except (OSError, ValueError) as error:
        result["message"] = str(error) if isinstance(error, ValueError) else "Memory firmware or local boot configuration could not be read completely."
    result["id"] = digest({"capability": result, **identity})
    return result


def validate_selection(capability, value):
    if not capability.get("supported"):
        raise ValueError("GPU memory configuration is unavailable on this host.")
    if not isinstance(value, dict) or set(value) != {"carveoutIndex", "dynamicLimitMi"}:
        raise ValueError("Only firmware reservation index and dynamic memory limit are accepted.")
    if any(type(item) is not int for item in value.values()):
        raise ValueError("Memory selections must be integers.")
    option = next((item for item in capability["options"] if item["index"] == value["carveoutIndex"]), None)
    if not option:
        raise ValueError("Choose a currently advertised firmware memory option.")
    maximum = ((capability["systemMemoryMi"] + capability["currentCarveoutMi"] - option["sizeMi"] - RESERVE_MI) // STEP_MI) * STEP_MI
    if value["dynamicLimitMi"] < STEP_MI or value["dynamicLimitMi"] > 1048576 or value["dynamicLimitMi"] % STEP_MI or value["dynamicLimitMi"] > maximum:
        raise ValueError("Dynamic GPU memory must use 1 GiB steps and leave at least 16 GiB of projected Linux RAM outside its limit.")
    if value == {"carveoutIndex": capability["currentCarveoutIndex"], "dynamicLimitMi": capability["currentDynamicLimitMi"]}:
        raise ValueError("GPU memory settings are already active; no maintenance is needed.")
    return {**value, "carveoutMi": option["sizeMi"], "projectedSystemMemoryMi": capability["systemMemoryMi"] + capability["currentCarveoutMi"] - option["sizeMi"],
            "systemReserveMi": RESERVE_MI, "pciAddress": capability["pciAddress"]}


def write_carveout(address, index, root=Path("/"), expected_index=None, expected_options=None):
    """The only direct firmware write; identity/options are rechecked at use."""
    if not re.fullmatch(PCI_PATTERN, address) or type(index) is not int:
        raise ValueError("Invalid firmware memory selection.")
    base = root / "sys/bus/pci/devices" / address
    if ((base / "vendor").read_text().strip() != "0x1002" or (base / "device").read_text().strip() != "0x1586"
            or int((base / "class").read_text().strip(), 16) >> 16 != 3):
        raise ValueError("GPU identity changed before firmware configuration.")
    options = parse_options((base / "uma/carveout_options").read_text())
    if index not in {item["index"] for item in options} or (expected_options is not None and options != expected_options):
        raise ValueError("Firmware memory options changed before configuration.")
    if expected_index is not None and (base / "uma/carveout").read_text().strip() != str(expected_index):
        raise ValueError("A different firmware memory reservation is pending; it will not be overwritten.")
    (base / "uma/carveout").write_text(str(index) + "\n")
