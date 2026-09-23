# SPDX-License-Identifier: BUSL-1.1
"""Collect repeatable license evidence; never turn scan results into legal approval."""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MAX_EVIDENCE_BYTES = 2 * 1024 * 1024
PERMISSIVE = {"MIT", "MIT-0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0",
              "0BSD", "Zlib", "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "PSF-2.0"}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def fetch(url):
    if not url.startswith("https://raw.githubusercontent.com/"):
        raise ValueError("Only public HTTPS GitHub source evidence is accepted")
    request = urllib.request.Request(url, headers={"User-Agent": "MagicStick-license-audit"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(MAX_EVIDENCE_BYTES + 1)
    if len(data) > MAX_EVIDENCE_BYTES:
        raise ValueError("Upstream evidence exceeds size limit")
    return data


def upstream_checks(root=ROOT, fetcher=fetch):
    manifest = json.loads((root / "licenses/upstream-evidence.json").read_text())
    if manifest.get("schemaVersion") != 1 or not manifest.get("components"):
        raise ValueError("Missing upstream evidence manifest")
    result = {"schemaVersion": 1, "status": "evidence-not-distribution-approval", "components": [], "errors": []}
    for item in manifest["components"]:
        component = {key: item[key] for key in ["id", "revision", "declaredLicense", "distributionReview"]}
        component["files"] = []
        result["components"].append(component)
        if not re.fullmatch(r"[0-9a-f]{40}", item["revision"]):
            raise ValueError("Source evidence must use an immutable commit")
        repo = item["repository"].removeprefix("https://github.com/")
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise ValueError("Invalid public upstream repository")
        binding = item["binding"]
        path = (root / binding["file"]).resolve()
        if not path.is_relative_to(root.resolve()) or binding["text"] not in path.read_text():
            result["errors"].append(item["id"] + ": build pin changed; refresh upstream evidence")
        for evidence in item["files"]:
            if not re.fullmatch(r"[\w./-]+", evidence["path"]) or ".." in evidence["path"].split("/"):
                raise ValueError("Invalid evidence path")
            url = f"https://raw.githubusercontent.com/{repo}/{item['revision']}/{evidence['path']}"
            try:
                data = fetcher(url)
                digest = hashlib.sha256(data).hexdigest()
                record = {"path": evidence["path"], "url": url, "bytes": len(data), "sha256": digest}
                component["files"].append(record)
                if digest != evidence["sha256"] or len(data) != evidence["bytes"]:
                    result["errors"].append(item["id"] + ": upstream evidence changed: " + evidence["path"])
                if evidence.get("requiredText") and evidence["requiredText"] not in data.decode("utf-8"):
                    result["errors"].append(item["id"] + ": license declaration missing: " + evidence["path"])
            except (OSError, ValueError) as error:
                result["errors"].append(item["id"] + ": cannot verify " + evidence["path"] + ": " + str(error))
        watch = item.get("noticeWatch")
        if watch:
            if not re.fullmatch(r"[\w.-]+", watch["ref"]) or not re.fullmatch(r"[\w.-]+", watch["path"]):
                raise ValueError("Invalid upstream notice watch")
            url = f"https://raw.githubusercontent.com/{repo}/{watch['ref']}/{watch['path']}"
            try:
                data = fetcher(url)
                digest = hashlib.sha256(data).hexdigest()
                component["noticeWatch"] = {"url": url, "sha256": digest, "bytes": len(data),
                                             "scope": "follow-up-only; not the pinned build source"}
                if digest != watch["sha256"] or len(data) != watch["bytes"]:
                    result["errors"].append(item["id"] + ": upstream notice changed; review it before updating evidence or build pins")
            except (OSError, ValueError) as error:
                result["errors"].append(item["id"] + ": cannot check upstream notice: " + str(error))
    return result


def license_category(expressions):
    """Conservative triage, not an SPDX evaluator or a compatibility decision.

    Do not choose one branch of OR or discard WITH exceptions. Keep the exact
    expression and send all compounds/unrecognized values to human review.
    """
    if not expressions or any(value.upper() in {"", "NONE", "NOASSERTION", "UNKNOWN"} for value in expressions):
        return "missing-license-evidence"
    text = " ".join(expressions)
    if re.search(r"SSPL|Elastic|Commons.?Clause|PolyForm|LicenseRef|BUSL|proprietary|commercial", text, re.I):
        return "restricted-or-custom-review"
    if re.search(r"AGPL|(?<!L)GPL|LGPL|MPL|EPL|CDDL", text, re.I):
        return "copyleft-review"
    if all(value in PERMISSIVE for value in expressions):
        return "notice-review"
    return "expression-review"


def summarize_sbom(document, target):
    if not isinstance(document, dict) or not isinstance(document.get("artifacts"), list):
        raise ValueError("Expected a Syft JSON document with an artifacts array")
    if not document["artifacts"]:
        raise ValueError("Empty SBOM is not evidence of an empty dependency closure")
    packages = []
    for item in document["artifacts"]:
        if not isinstance(item, dict) or not item.get("name") or not item.get("type"):
            raise ValueError("Malformed package in SBOM")
        expressions = sorted({str(license.get("spdxExpression") or license.get("value") or "UNKNOWN")
                              for license in item.get("licenses", [])})
        packages.append({"name": item["name"], "version": item.get("version", ""), "type": item["type"],
                         "purl": item.get("purl", ""), "licenses": expressions,
                         "review": license_category(expressions)})
    packages.sort(key=lambda item: (item["type"], item["name"], item["version"], item["purl"]))
    source = document.get("source", {})
    metadata = source.get("metadata", {})
    # Never copy layer history, environment or registry credentials into reports.
    identity = {key: metadata[key] for key in ["imageID", "manifestDigest", "architecture", "os"] if key in metadata}
    return {"schemaVersion": 1, "target": target, "status": "inventory-not-distribution-approval",
            "tool": {"name": document.get("descriptor", {}).get("name"),
                     "version": document.get("descriptor", {}).get("version")},
            "sourceIdentity": identity, "packageCount": len(packages),
            "reviewCounts": dict(sorted(Counter(item["review"] for item in packages).items())),
            "packages": packages,
            "limitations": ["SBOM license metadata is not permission to redistribute or proof of notices/source compliance.",
                            "Minified JS, proprietary drivers, model weights, assets and runtime downloads require separate evidence.",
                            "Source lockfiles do not prove the contents or linkage of final binaries."]}


def markdown_report(report):
    lines = ["# License audit: " + report["target"], "", "Inventory only — not distribution approval.", "",
             f"Packages: {report['packageCount']}", "", "| Review | Packages |", "|---|---:|"]
    lines.extend(f"| {key} | {value} |" for key, value in report["reviewCounts"].items())
    lines += ["", "Exact package/version/license expressions are in the accompanying JSON and SBOM.", ""]
    lines.extend("- " + value for value in report["limitations"])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    upstream = sub.add_parser("upstream")
    upstream.add_argument("--output", type=Path, required=True)
    sbom = sub.add_parser("sbom")
    sbom.add_argument("--input", type=Path, required=True)
    sbom.add_argument("--target", required=True)
    sbom.add_argument("--output", type=Path, required=True)
    sbom.add_argument("--markdown", type=Path)
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--inputs", type=Path, nargs="+", required=True)
    snapshot.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "upstream":
            report = upstream_checks()
            write_json(args.output, report)
            for error in report["errors"]:
                print(error, file=sys.stderr)
            return 1 if report["errors"] else 0
        if args.command == "snapshot":
            reports = [json.loads(path.read_text()) for path in args.inputs]
            if any(item.get("status") != "inventory-not-distribution-approval" or not item.get("sbomSha256")
                   for item in reports):
                raise ValueError("Snapshot requires completed SBOM review reports")
            write_json(args.output, {"schemaVersion": 1, "checkedAt": dt.date.today().isoformat(),
                                     "scope": "local-pre-publication-test-images; not release approval",
                                     "reports": sorted(reports, key=lambda item: item["target"])})
            return 0
        report = summarize_sbom(json.loads(args.input.read_text()), args.target)
        report["sbomSha256"] = hashlib.sha256(args.input.read_bytes()).hexdigest()
        write_json(args.output, report)
        if args.markdown:
            args.markdown.parent.mkdir(parents=True, exist_ok=True)
            args.markdown.write_text(markdown_report(report))
        print(f"{args.target}: {report['packageCount']} packages inventoried; distribution review remains separate.")
        return 0
    except (OSError, ValueError, TypeError, KeyError) as error:
        print("License audit failed: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
