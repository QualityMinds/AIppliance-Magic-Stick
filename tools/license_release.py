# SPDX-License-Identifier: BUSL-1.1
"""Validate the immutable, per-version BSL publication/change-date record."""
import argparse
import datetime as dt
import json
from pathlib import Path


def change_date(first_public_distribution):
    date = dt.date.fromisoformat(first_public_distribution)
    try:
        return date.replace(year=date.year + 3).isoformat()
    except ValueError:
        if date.month == 2 and date.day == 29:
            return date.replace(year=date.year + 3, day=28).isoformat()
        raise


def validate(record, *, release=False):
    fields = {"schemaVersion", "version", "firstPublicDistribution", "changeDate", "changeLicense"}
    if not isinstance(record, dict) or set(record) != fields or type(record["schemaVersion"]) is not int or record["schemaVersion"] != 1:
        raise ValueError("Invalid LICENSE-RELEASE.json schema")
    if record["changeLicense"] != "MIT":
        raise ValueError("Change License must be MIT")
    if not isinstance(record["version"], str) or not record["version"].strip():
        raise ValueError("A stable version identifier is required")
    if record["version"] == "unreleased":
        if release or record["firstPublicDistribution"] is not None or record["changeDate"] is not None:
            raise ValueError("Publish an exact version and its actual first public distribution date before release")
        return
    first = record["firstPublicDistribution"]
    if not isinstance(first, str) or not isinstance(record["changeDate"], str):
        raise ValueError("Publication and Change Dates must be ISO dates")
    if dt.date.fromisoformat(first).isoformat() != first:
        raise ValueError("Use YYYY-MM-DD publication dates")
    if record["changeDate"] != change_date(first):
        raise ValueError("Change Date must be exactly three years after first public distribution")
    if release and dt.date.fromisoformat(first) > dt.date.today():
        raise ValueError("A future publication date cannot describe an already published release")


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
