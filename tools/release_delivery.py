# SPDX-License-Identifier: BUSL-1.1
"""Complete an immutable product release with verified fixed-version USB media.

No new credential, product-tag/asset replacement, CI rerun or appliance action.
The product must already be public: media bootstrap verifies that same identity.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools import installer_artifact as installer
from tools import product_release as product
from tools import release_bootstrap

REPO = product.REPO
WORKFLOW = "build-installer-image.yml"
CONTRACT = "  INSTALLER_DELIVERY_CONTRACT: '1'"


class DeliveryFailure(ValueError):
    pass


class Pending(DeliveryFailure):
    def __init__(self, run_id):
        super().__init__("The installer publication run is still active; delivery is not complete.")
        self.run_id = run_id


def plan(root, version, commit, resolve=release_bootstrap.resolve):
    root = Path(root)
    if (not product.catalog.is_product_version(version) or not product.catalog.SHA.fullmatch(commit)
            or product.git(root, "rev-parse", "HEAD") != commit
            or product.git(root, "status", "--porcelain")):
        raise DeliveryFailure("Installer delivery requires a clean checkout of the exact product commit.")
    proof = resolve(version, commit)
    identity = {key: proof[key] for key in ("version", "commit", "tagObject", "manifestDigest", "license")}
    return installer.plan(root, "main", commit, identity)


def public_digest(url, expected_size):
    """Stream bounded public bytes; never forward credentials or print CDN URLs."""
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "github.com" or parsed.query
            or parsed.username or parsed.password or parsed.fragment
            or not parsed.path.startswith("/" + installer.REPOSITORY + "/releases/download/")
            or type(expected_size) is not int or not 0 < expected_size < 2 * installer.GIB):
        raise DeliveryFailure("Installer downloads must be bounded official project assets.")
    opener = urllib.request.build_opener(product.catalog.NoRedirect)
    for _ in range(4):
        try:
            response = opener.open(urllib.request.Request(url, headers={
                "User-Agent": "MagicStick-release-delivery", "Accept": "application/octet-stream"}), timeout=60)
            with response:
                digest, count = hashlib.sha256(), 0
                while True:
                    chunk = response.read(min(1024 * 1024, expected_size - count + 1))
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > expected_size:
                        raise DeliveryFailure("A public installer download exceeds its verified size.")
                    digest.update(chunk)
            if count != expected_size:
                raise DeliveryFailure("A public installer download is incomplete.")
            return "sha256:" + digest.hexdigest()
        except urllib.error.HTTPError as error:
            target = urllib.parse.urlsplit(error.headers.get("Location", ""))
            error.close()
            if (error.code not in (301, 302, 303, 307, 308) or target.scheme != "https"
                    or target.netloc != "release-assets.githubusercontent.com"
                    or target.username or target.password or target.fragment):
                raise DeliveryFailure("The public installer download is unavailable or redirected outside the approved service.") from None
            url = target.geturl()
        except (OSError, ValueError) as error:
            if isinstance(error, DeliveryFailure):
                raise
            raise DeliveryFailure("Public installer bytes could not be verified; no delivery success was inferred.") from None
    raise DeliveryFailure("The public installer download exceeded the redirect limit.")


def completed_jobs(run, api, *, reused=False):
    if (not product.catalog._integer(run.get("id"))
            or not product.catalog._integer(run.get("run_attempt"))):
        raise DeliveryFailure("Installer workflow identity is invalid.")
    data = api(REPO + "/actions/runs/" + str(run["id"]) + "/jobs?filter=latest&per_page=100")
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if (not isinstance(jobs, list) or type(data.get("total_count")) is not int or data["total_count"] != len(jobs)
            or len(jobs) != 2 or {job.get("name") for job in jobs} != {"build", "publish"}
            or any(job.get("status") != "completed" for job in jobs)):
        raise DeliveryFailure("Installer jobs are missing, active or incompletely inspected.")
    build = next(job for job in jobs if job["name"] == "build")
    publication = next(job for job in jobs if job["name"] == "publish")
    if build.get("conclusion") != "success":
        raise DeliveryFailure("The latest installer build job is unsuccessful.")
    if publication.get("conclusion") == "success":
        return
    steps = {step.get("name"): step.get("conclusion") for step in build.get("steps", [])}
    if (not reused or publication.get("conclusion") != "skipped"
            or steps.get("Reuse an identical published installer") != "success"
            or steps.get("Report reused download") != "success"
            or steps.get("Build reduced media") != "skipped"):
        raise DeliveryFailure("Installer publication was skipped without verified identical-media reuse.")


def verify(value, *, api=product.github, fetch=product.catalog.public_bytes, download=public_digest):
    release = api(REPO + "/releases/tags/" + value["tag"], optional=True)
    if release is None:
        return None
    url = "https://github.com/" + installer.REPOSITORY + "/releases/tag/" + value["tag"]
    if (not product.catalog._integer(release.get("id"))
            or release.get("tag_name") != value["tag"] or release.get("html_url") != url
            or release.get("draft") is not False or release.get("immutable") is not True
            or release.get("prerelease") is not True):
        raise DeliveryFailure("The fixed installer is not one complete immutable public component release.")
    assets = installer.asset_map(release)
    if set(assets) != installer.asset_names(value):
        raise DeliveryFailure("The fixed installer download is incomplete; recover its original publication, not a new build.")
    prefix = product.catalog.RELEASES + "download/" + value["tag"] + "/"
    for name, asset in assets.items():
        if (asset.get("browser_download_url") != prefix + name or asset.get("state") != "uploaded"
                or type(asset.get("size")) is not int or not 0 < asset["size"] < 2 * installer.GIB
                or not product.catalog.DIGEST.fullmatch(str(asset.get("digest", "")))):
            raise DeliveryFailure("An installer asset has an invalid URL, size, state or checksum.")
    metadata = assets[value["stem"] + ".build.json"]
    if metadata["size"] > 1024 * 1024:
        raise DeliveryFailure("Installer build metadata exceeds the inspection limit.")
    raw = fetch(metadata["browser_download_url"])
    if len(raw) != metadata["size"] or "sha256:" + hashlib.sha256(raw).hexdigest() != metadata["digest"]:
        raise DeliveryFailure("Public installer build metadata differs from its reviewed checksum.")
    info = product.catalog.strict_json(raw)
    installer.check_manifest(info, value)
    installer.check_remote_assets(release, info, value)
    checksum = assets[value["imageName"] + ".sha256"]
    expected_checksum = (info["assets"][value["imageName"]]["sha256"] + "  " + value["imageName"] + "\n").encode()
    if checksum["size"] != len(expected_checksum):
        raise DeliveryFailure("The public checksum file does not describe the selected image.")
    checksum_raw = fetch(checksum["browser_download_url"])
    if (checksum_raw != expected_checksum
            or "sha256:" + hashlib.sha256(checksum_raw).hexdigest() != checksum["digest"]):
        raise DeliveryFailure("The public checksum file does not match the verified image/hash.")
    if info["sourceRevision"] != value["sourceRevision"]:
        raise DeliveryFailure("Fixed product media must be built from that exact product commit.")
    tag = api(REPO + "/git/ref/tags/" + value["tag"])
    if (tag.get("object", {}).get("type") != "commit"
            or tag["object"].get("sha") != info["sourceRevision"]):
        raise DeliveryFailure("The installer source tag changed; no replacement is allowed.")
    run = api(REPO + "/actions/runs/" + info["sourceRunId"])
    if (str(run.get("id")) != info["sourceRunId"] or run.get("path") != installer.WORKFLOW
            or run.get("head_sha") != info["sourceRevision"]
            or (run.get("head_repository") or {}).get("full_name") != installer.REPOSITORY
            or run.get("event") not in {"push", "workflow_dispatch"}
            or run.get("head_branch") not in {"main", value["productRelease"]["version"]}
            or run.get("head_branch") != "main" and (run.get("event") != "workflow_dispatch"
                or run.get("head_sha") != value["productRelease"]["commit"])):
        raise DeliveryFailure("The installer source/run identity differs from the selected product or official workflow.")
    if run.get("status") != "completed":
        raise Pending(run["id"])
    if run.get("conclusion") != "success":
        raise DeliveryFailure("The latest installer attempt is unsuccessful; no older green result or automatic rerun is allowed.")
    completed_jobs(run, api)
    for name, asset in assets.items():
        if name not in {metadata["name"], checksum["name"]} and download(asset["browser_download_url"], asset["size"]) != asset["digest"]:
            raise DeliveryFailure("Public installer bytes differ from their verified SHA-256.")
    return {"url": url, "tag": value["tag"], "image": prefix + value["imageName"],
            "checksum": prefix + value["imageName"] + ".sha256", "sourceRunId": info["sourceRunId"],
            "evidence": prefix + value["stem"] + ".evidence.tar.gz",
            "sha256": info["assets"][value["imageName"]]["sha256"],
            "bytes": info["assets"][value["imageName"]]["bytes"],
            "productRelease": value["productRelease"],
            "fingerprint": value["fingerprint"], "physicalInstallation": False}


def link_download(version, receipt, *, api=product.github):
    """Append verified links to editable release notes; never replace locked assets."""
    path = REPO + "/releases/tags/" + version
    before = api(path)
    url = product.catalog.RELEASES + "tag/" + version
    if (not product.catalog._integer(before.get("id")) or before.get("tag_name") != version
            or before.get("html_url") != url or before.get("draft") is not False
            or before.get("immutable") is not True or not isinstance(before.get("body"), str)):
        raise DeliveryFailure("The immutable product release identity cannot be confirmed for its download links.")
    marker = "<!-- magicstick-verified-installer -->"
    section = (marker + "\n## Installer download\n\n"
               "- [AMD64 USB installer](" + receipt["image"] + ")\n"
               "- [SHA-256 checksum](" + receipt["checksum"] + ")\n"
               "- [Build and media evidence](" + receipt["evidence"] + ")\n\n"
               "Public download bytes and fixed product identity verified. "
               "This is reduced, network-required installation media; physical installation "
               "and hardware acceptance remain separate.\n")
    if marker in before["body"]:
        if not before["body"].endswith(section):
            raise DeliveryFailure("Existing installer notes differ; they were not overwritten.")
        return
    body = before["body"].rstrip() + "\n\n" + section
    # Preserve any human-authored notes and detect edits since our first read.
    current = api(path)
    if any(current.get(key) != before.get(key) for key in ("id", "tag_name", "body", "assets", "immutable", "draft")):
        raise DeliveryFailure("Product release notes changed concurrently; no note was overwritten.")
    api(REPO + "/releases/" + str(before["id"]), method="PATCH", payload={"body": body})
    after = api(path)
    if (after.get("body") != body
            or any(after.get(key) != before.get(key) for key in ("id", "tag_name", "assets", "immutable", "draft"))):
        raise DeliveryFailure("The installer links were not confirmed; product tag/assets were not replaced.")


def complete(root, version, commit, *, api=product.github, resolve=release_bootstrap.resolve,
             verify_download=verify, announce=link_download,
             sleep=time.sleep, now=time.monotonic, timeout=5400):
    value = plan(root, version, commit, resolve)
    deadline, dispatched = now() + timeout, False
    while now() <= deadline:
        query = urllib.parse.urlencode({"head_sha": commit, "branch": version,
                                        "event": "workflow_dispatch", "per_page": 100})
        data = api(REPO + "/actions/workflows/" + WORKFLOW + "/runs?" + query)
        runs = data.get("workflow_runs") if isinstance(data, dict) else None
        if (not isinstance(runs, list) or type(data.get("total_count")) is not int
                or data["total_count"] != len(runs)):
            raise DeliveryFailure("Installer workflow lookup is incomplete; no duplicate build was dispatched.")
        matching = [run for run in runs if run.get("head_sha") == commit and run.get("head_branch") == version
                    and run.get("event") == "workflow_dispatch" and run.get("path") == installer.WORKFLOW
                    and (run.get("head_repository") or {}).get("full_name") == installer.REPOSITORY]
        if len(matching) != len(runs) or any(not product.catalog._integer(run.get("id"))
                or not product.catalog._integer(run.get("run_attempt")) for run in matching):
            raise DeliveryFailure("Installer workflow lookup returned an unexpected identity; no duplicate build was dispatched.")
        if matching:
            run = max(matching, key=lambda item: (item.get("id", 0), item.get("run_attempt", 0)))
            if run.get("status") != "completed":
                sleep(15)
                continue
            if run.get("conclusion") != "success":
                raise DeliveryFailure("The latest installer attempt failed, was cancelled or needs action. "
                                      "No automatic rerun, older green fallback or replacement was attempted.")
        try:
            receipt = verify_download(value, api=api)
        except Pending:
            sleep(15)
            continue
        if receipt:
            if matching:
                completed_jobs(run, api, reused=str(run["id"]) != receipt["sourceRunId"])
            announce(version, receipt, api=api)
            return receipt
        if matching:
            raise DeliveryFailure("The successful installer workflow has no verified public media. "
                                  "Inspect its original publication; no replacement was attempted.")
        if not dispatched:
            # Never let a failed/missing lookup become an unaudited retry. A
            # legacy published version can be verified, but is not redispatched
            # through a tag whose old workflow only accepted the main branch.
            if CONTRACT not in (Path(root) / installer.WORKFLOW).read_text():
                raise DeliveryFailure("This older version needs the reviewed manual main installer build; no unsupported tag dispatch was attempted.")
            if api(REPO + "/git/ref/tags/" + value["tag"], optional=True) is not None:
                raise DeliveryFailure("An installer tag exists without complete public media. Inspect the original publication; no replacement was dispatched.")
            api(REPO + "/actions/workflows/" + WORKFLOW + "/dispatches", method="POST",
                payload={"ref": version, "inputs": {"product_version": version}})
            dispatched = True
        sleep(15)
    raise DeliveryFailure("Installer observation timed out, not the build. Product publication remains intact; inspect the original run before continuing.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("verify", "complete"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        if args.operation == "complete":
            receipt = complete(args.root, args.version, args.revision)
        else:
            receipt = verify(plan(args.root, args.version, args.revision))
            if receipt is None:
                raise DeliveryFailure("No verified fixed-version installer is available yet.")
        print(json.dumps(receipt, sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, (str(error) if isinstance(error, DeliveryFailure)
                       else "Installer delivery verification failed; no success or fallback was inferred.") + "\n")


if __name__ == "__main__":
    main()
