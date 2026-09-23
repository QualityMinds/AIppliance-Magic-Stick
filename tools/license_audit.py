# SPDX-License-Identifier: BUSL-1.1
"""Reproducible source/license inventory. A passing source check is not legal approval."""
import argparse
import ast
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import re
import subprocess
import sys

from license_release import validate as validate_release

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".md", ".json", ".yml", ".yaml", ".html", ".css", ".sh", ".toml", ".ps1"}
REQUIRED_GATES = {"legal-grant", "ownership", "kdns", "artifact-sboms", "marketing-assets", "physical-acceptance"}
REQUIRED_NOTICES = ("LICENSE", "LICENSING.md", "THIRD_PARTY_NOTICES.md")


def files(root=ROOT):
    output = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root)
    return [root / name for name in sorted(set(output.decode().split("\0"))) if name and (root / name).is_file()]


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def notice_checks(root=ROOT):
    return [name + ": required license/notice file is missing or empty"
            for name in REQUIRED_NOTICES
            if not (root / name).is_file() or not (root / name).read_text().strip()]


def source_checks(root=ROOT):
    errors = notice_checks(root)
    for path in files(root):
        name = path.relative_to(root).as_posix()
        if name.startswith("enterprise/"):
            errors.append(name + ": separate paid source package is not allowed")
        if name.startswith(("licenses/third-party/", "tests/test_license_")) or name == "tools/license_audit.py":
            continue
        if path.suffix not in TEXT_SUFFIXES and not path.name.startswith("Dockerfile"):
            continue
        text = path.read_text(errors="replace")
        if re.search(r"(?:magicstick_enterprise|LicenseRef-MagicStick-Enterprise|magicstick-enterprise-license)", text):
            errors.append(name + ": obsolete Magic Stick licensing reference")
        if re.search(r"SPDX-License-Identifier:\s*MIT\b", text):
            errors.append(name + ": inspect owned-code MIT header")
        if re.search(r'"enterpriseFeature"\s*:', text):
            errors.append(name + ": module-level paid-feature marker is not allowed")
        if re.search(r'require_feature\(["\'](?:private-mesh|resource-sharing)["\']', text):
            errors.append(name + ": Core function must not require a license entitlement")
        if path.name == "package.json" and name.startswith("dashboard/"):
            package = json.loads(text)
            if package.get("name", "").startswith("@magicstick/") and package.get("license") != "BUSL-1.1":
                errors.append(name + ": missing BUSL-1.1 package metadata")
    licensing = ast.parse((root / "dashboard/apps/api/licensing.py").read_text())
    features = next(ast.literal_eval(node.value) for node in licensing.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == "FEATURES" for target in node.targets))
    if set(features) != {"federated-sso", "commercial-production"}:
        errors.append("Unexpected signed entitlement registry")
    try:
        validate_release(json.loads((root / "LICENSE-RELEASE.json").read_text()))
    except (ValueError, TypeError, OSError) as error:
        errors.append(str(error))
    inventory_path = root / "licenses/dependency-inventory.json"
    if inventory_path.is_file():
        try:
            saved = json.loads(inventory_path.read_text())
            if saved.get("pnpmLockSha256") != checksum(root / "dashboard/pnpm-lock.yaml"):
                errors.append("Dependency inventory is stale: regenerate it from the frozen pnpm lockfile")
            if saved.get("deploymentReferencesSha256") != references_checksum(deployment_references(root)):
                errors.append("Deployment/build inventory is stale: regenerate it after dependency reference changes")
        except (ValueError, TypeError, OSError) as error:
            errors.append("Invalid dependency inventory: " + str(error))
    else:
        errors.append("Missing dependency inventory: generate licenses/dependency-inventory.json")
    return errors


def publication_checks(root=ROOT):
    errors = []
    record = {}
    try:
        record = json.loads((root / "LICENSE-RELEASE.json").read_text())
        validate_release(record, release=True)
    except (ValueError, TypeError, OSError) as error:
        errors.append(str(error))
        if not isinstance(record, dict):
            record = {}
    try:
        review = json.loads((root / "licenses/release-review.json").read_text())
        if review.get("schemaVersion") != 1 or not isinstance(review.get("gates"), list):
            raise ValueError("Invalid release-review schema")
        if {item.get("id") for item in review["gates"]} != REQUIRED_GATES or len(review["gates"]) != len(REQUIRED_GATES):
            raise ValueError("Release review must contain every required gate exactly once")
        if review.get("version") != record.get("version"):
            errors.append("Release review does not describe the exact publication version")
        for item in review["gates"]:
            if item.get("status") != "approved" or not item.get("evidence") or not item.get("approvedBy") or not item.get("approvedAt"):
                errors.append("Unresolved review: " + item["id"] + " - " + item.get("description", "Approval missing"))
                continue
            evidence = (root / item["evidence"]).resolve()
            if not evidence.is_relative_to(root.resolve()) or not evidence.is_file() or not evidence.stat().st_size:
                errors.append("Missing local approval evidence for " + item["id"])
    except (ValueError, TypeError, OSError, AttributeError, KeyError) as error:
        errors.append("Invalid release review: " + str(error))
    return errors


def npm_inventory(root=ROOT):
    import yaml  # Audit environment only, not part of the product runtime.
    lock = yaml.safe_load((root / "dashboard/pnpm-lock.yaml").read_text())
    installed = {}
    store = root / "dashboard/node_modules/.pnpm"
    if store.is_dir():
        for path in store.glob("*/node_modules/*/package.json"):
            value = json.loads(path.read_text())
            installed[(value.get("name"), value.get("version"))] = (value, path.parent)
        for path in store.glob("*/node_modules/@*/*/package.json"):
            value = json.loads(path.read_text())
            installed[(value.get("name"), value.get("version"))] = (value, path.parent)
    result = []
    for key, value in sorted(lock.get("packages", {}).items()):
        name, version = key.rsplit("@", 1)
        package, directory = installed.get((name, version), ({}, None))
        texts = []
        if directory:
            for path in sorted(directory.iterdir()):
                if path.is_file() and re.match(r"(?i)^(licen[sc]e|copying|notice)(?:[.-]|$)", path.name):
                    texts.append({"file": path.name, "sha256": checksum(path)})
        license_value = package.get("license") or package.get("licenses")
        result.append({"name": name, "version": version, "declaredLicense": license_value,
                       "evidence": "installed-package" if directory else "lock-only",
                       "integrity": value.get("resolution", {}).get("integrity"), "licenseFiles": texts})
    return result


def deployment_references(root=ROOT):
    refs = []
    for path in files(root):
        name = path.relative_to(root).as_posix()
        if not name.startswith(("magic-cluster/", "magic-host/", "magic-installer/", ".github/")):
            continue
        if path.suffix not in {".yaml", ".yml", ".sh", ".py", ".toml"} and not path.name.startswith("Dockerfile"):
            continue
        for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            if re.search(r"(?:^FROM |\bimage:|\brepository:|\bchart:|\bversion:|\btag:|https://github.com/|ansible-galaxy|pip install|apt-get install)", line):
                refs.append({"file": name, "line": number, "reference": line.strip()})
    return refs


def references_checksum(refs):
    # Line numbers are navigation aids, not dependency identity. Moving a comment
    # must not invalidate the inventory; changing an image/chart/build input must.
    values = sorted({(item["file"], item["reference"]) for item in refs})
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


def inventory(root=ROOT):
    refs = deployment_references(root)
    python = []
    for dist in metadata.distributions():
        if dist.metadata["Name"].lower() in {"pip", "setuptools"}:
            continue
        python.append({"name": dist.metadata["Name"], "version": dist.version,
                       "declaredLicense": dist.metadata.get("License-Expression") or dist.metadata.get("License"),
                       "licenseFiles": dist.metadata.get_all("License-File") or [],
                       "scope": "audit-environment; product requirements must be checked separately"})
    return {"schemaVersion": 1, "status": "inventory-not-legal-clearance",
            "pnpmLockSha256": checksum(root / "dashboard/pnpm-lock.yaml"),
            "deploymentReferencesSha256": references_checksum(refs),
            "npm": npm_inventory(root), "python": sorted(python, key=lambda v: v["name"].lower()),
            "deploymentReferences": refs,
            "limitations": ["References and top-level license metadata are not full container/chart SBOMs.",
                            "Uninstalled platform-specific packages require release-platform inspection.",
                            "Rust/Go transitive binaries, model terms, assets and commercial EULAs require artifact review."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--review", action="store_true",
                      help="Report open release-review items without blocking otherwise valid builds")
    mode.add_argument("--release", action="store_true",
                      help="Explicit strict review: require every publication approval and date record")
    parser.add_argument("--inventory", type=Path)
    args = parser.parse_args(argv)
    if args.inventory:
        args.inventory.parent.mkdir(parents=True, exist_ok=True)
        value = inventory()
        args.inventory.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
        print(f"Inventory: {len(value['npm'])} locked npm packages, {len(value['deploymentReferences'])} deployment references")
    errors = source_checks()
    if args.review or args.release:
        reviews = publication_checks()
        if args.release:
            errors.extend(reviews)
        else:
            print(f"License review: {len(reviews)} open item(s), advisory only; not publication approval.")
            for item in reviews:
                print("REVIEW WARNING: " + item, file=sys.stderr)
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    print("Source license checks passed. Artifact/legal release approval is separate.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
