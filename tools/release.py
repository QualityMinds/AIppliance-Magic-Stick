# SPDX-License-Identifier: BUSL-1.1
"""Prepare explicit release metadata locally; never commit, publish or deploy."""
import argparse
import json
from pathlib import Path
import re

if __package__:
    from .license_release import change_date, validate
else:
    from license_release import change_date, validate

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?")


def valid_version(version):
    if not VERSION.fullmatch(version):
        raise ValueError("Use an explicit version such as v1.2.3 or v1.2.3-rc.1")


def release_notes(changelog, version, date):
    heading = f"## {version} - {date}"
    matches = list(re.finditer(r"^## .+$", changelog, re.M))
    selected = [i for i, match in enumerate(matches) if match.group() == heading]
    if len(selected) != 1:
        raise ValueError(f"Expected exactly one changelog heading: {heading}")
    index = selected[0]
    end = matches[index + 1].start() if index + 1 < len(matches) else len(changelog)
    content = changelog[matches[index].end():end].strip()
    if not content:
        raise ValueError("Release notes must not be empty")
    return content


def prepare(root, version, date, notes, *, write=False):
    root = Path(root)
    valid_version(version)
    record = {"schemaVersion": 1, "version": version, "firstPublicDistribution": date,
              "changeDate": change_date(date), "changeLicense": "MIT"}
    validate(record, release=True)
    notes = notes.strip()
    if not notes or re.search(r"^#{1,2}(?:\s|$)", notes, re.M):
        raise ValueError("Provide nonempty release notes; use level-three headings inside them")
    current = json.loads((root / "LICENSE-RELEASE.json").read_text())
    validate(current)
    changelog = (root / "CHANGELOG.md").read_text()
    if len(re.findall(r"^## Unreleased$", changelog, re.M)) != 1:
        raise ValueError("Changelog must have exactly one Unreleased section")
    archive = root / "licenses/releases"
    updates = {}

    def retain(value):
        valid_version(value["version"])
        path = archive / (value["version"] + ".json")
        if path.exists() and json.loads(path.read_text()) != value:
            raise ValueError(f"Refusing to alter the archived dates for {value['version']}")
        updates[path] = json.dumps(value, indent=2) + "\n"

    if current["version"] != "unreleased":
        retain(current)
        if current["version"] == version and current != record:
            raise ValueError("A version's existing publication and change dates are immutable")
    retain(record)
    if re.search(r"^## " + re.escape(version) + r"(?:\s|$)", changelog, re.M):
        if release_notes(changelog, version, date) != notes:
            raise ValueError("Existing versioned release notes must not be overwritten")
    else:
        # Keep uncurated development notes separate; the release owner supplies
        # the reviewed public summary instead of automatically claiming them all.
        next_release = re.search(r"^## (?!Unreleased$).+$", changelog, re.M)
        position = next_release.start() if next_release else len(changelog)
        entry = f"## {version} - {date}\n\n{notes}\n\n"
        changelog = changelog[:position].rstrip() + "\n\n" + entry + changelog[position:]
    updates[root / "LICENSE-RELEASE.json"] = json.dumps(record, indent=2) + "\n"
    updates[root / "CHANGELOG.md"] = changelog
    changed = [str(path.relative_to(root)) for path, value in updates.items()
               if not path.exists() or path.read_text() != value]
    if write:
        for path, value in updates.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists() or path.read_text() != value:
                path.write_text(value)
    return changed


def check(root, version):
    root = Path(root)
    valid_version(version)
    record = json.loads((root / "LICENSE-RELEASE.json").read_text())
    validate(record, release=True)
    if record["version"] != version:
        raise ValueError("Requested tag and LICENSE-RELEASE.json version differ")
    archived = json.loads((root / "licenses/releases" / (version + ".json")).read_text())
    if archived != record:
        raise ValueError("Release record differs from its immutable archive")
    return release_notes((root / "CHANGELOG.md").read_text(), version, record["firstPublicDistribution"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    preparation = commands.add_parser("prepare", help="Preview metadata edits; --write applies them locally")
    preparation.add_argument("--version", required=True)
    preparation.add_argument("--date", required=True, help="Actual first public distribution date, YYYY-MM-DD")
    preparation.add_argument("--notes", type=Path, required=True)
    preparation.add_argument("--write", action="store_true")
    inspection = commands.add_parser("check", help="Validate a version and print its release notes")
    inspection.add_argument("--version", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            changes = prepare(args.root, args.version, args.date, args.notes.read_text(), write=args.write)
            print(json.dumps({"mode": "written" if args.write else "preview", "changedFiles": changes}, indent=2))
        else:
            print(check(args.root, args.version))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
