#!/usr/bin/env python3
"""Detect NVIDIA PCI display controllers without requiring a graphics driver."""

import argparse
import json
from pathlib import Path


def detect(root: Path) -> dict[str, object]:
    pci_devices = root / "sys/bus/pci/devices"
    if not pci_devices.is_dir():
        # Some CPU-only ARM systems expose no PCI bus at all.
        return {"displayCount": 0, "nvidiaDisplayCount": 0, "nvidiaDisplay": False}

    display_count = 0
    nvidia_display_count = 0
    for device in pci_devices.iterdir():
        try:
            class_code = int((device / "class").read_text().strip(), 16)
            vendor_id = int((device / "vendor").read_text().strip(), 16)
        except (OSError, ValueError):
            continue
        if class_code >> 16 != 0x03:
            continue
        display_count += 1
        if vendor_id == 0x10DE:
            nvidia_display_count += 1

    return {
        "displayCount": display_count,
        "nvidiaDisplayCount": nvidia_display_count,
        "nvidiaDisplay": nvidia_display_count > 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/"))
    args = parser.parse_args()
    print(json.dumps(detect(args.root), sort_keys=True))


if __name__ == "__main__":
    main()
