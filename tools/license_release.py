# SPDX-License-Identifier: BUSL-1.1
"""Validate the immutable, per-version BSL publication/change-date record."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "magic-host/roles/host-management/files"))
from release_catalog import change_date, validate_license_record


def validate(record, *, release=False):
    validate_license_record(record, release=release)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", type=Path, default=Path(__file__).resolve().parents[1] / "LICENSE-RELEASE.json")
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    try:
        validate(json.loads(args.record.read_text()), release=args.release)
    except (ValueError, TypeError, OSError) as error:
        parser.exit(1, str(error) + "\n")
    print("License release metadata is valid" + (" for publication." if args.release else " (development check)."))


if __name__ == "__main__":
    main()
