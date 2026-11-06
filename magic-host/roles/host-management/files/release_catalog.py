# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. All rights reserved.
"""Public product releases, exact Git identities and immutable license records.

Standard-library only: the API, host and bootstrap tools use this same module.
Reading the catalog never selects, installs or executes a software revision.
No publisher token, entitlement file or private appliance value is required.
"""
import datetime as dt
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "QualityMinds/AIppliance-Magic-Stick"
API = "https://api.github.com/repos/" + REPOSITORY
RELEASES = "https://github.com/" + REPOSITORY + "/releases/"
MANIFEST = "magicstick-release.json"
MAX_BYTES = 2 * 1024 * 1024
MAX_PAGES = 5
VERSION = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")
SHA = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
IMAGE = re.compile(r"[A-Za-z0-9][A-Za-z0-9./:_-]{0,450}@sha256:[a-f0-9]{64}")
REQUIRED_CHECKS = {"public-release-checks.yml", "dashboard-browser-smoke.yml",
                   "dependency-security.yml", "license-audit.yml", "regression-runner.yml"}


class ReleaseError(ValueError):
    """A fixed, public-safe failure, never an upstream response or signed URL."""


def version_key(version):
    match = VERSION.fullmatch(version) if isinstance(version, str) and len(version) <= 100 else None
    if not match:
        raise ReleaseError("Use a product version such as v1.2.3 or v1.2.3-rc.1.")
    major, minor, patch, pre = match.groups()
    identifiers = []
    for part in (pre or "").split(".") if pre else []:
        if part.isdigit() and len(part) > 1 and part.startswith("0"):
            raise ReleaseError("Numeric prerelease identifiers must not have leading zeroes.")
        identifiers.append((0, int(part)) if part.isdigit() else (1, part))
    return (int(major), int(minor), int(patch), int(pre is None), tuple(identifiers))


def is_product_version(value):
    try:
        version_key(value)
        return True
    except ReleaseError:
        return False


def change_date(first):
    date = dt.date.fromisoformat(first)
    try:
        return date.replace(year=date.year + 3).isoformat()
    except ValueError:
        if (date.month, date.day) == (2, 29):
            return date.replace(year=date.year + 3, day=28).isoformat()
        raise


def validate_license_record(record, *, release=False):
    fields = {"schemaVersion", "version", "firstPublicDistribution", "changeDate", "changeLicense"}
    if not isinstance(record, dict) or set(record) != fields or type(record["schemaVersion"]) is not int or record["schemaVersion"] != 1:
        raise ReleaseError("Invalid LICENSE-RELEASE.json schema.")
    if record["changeLicense"] != "MIT":
        raise ReleaseError("Change License must be MIT.")
    if not isinstance(record["version"], str) or not record["version"].strip():
        raise ReleaseError("A stable version identifier is required.")
    if record["version"] == "unreleased":
        if release or record["firstPublicDistribution"] is not None or record["changeDate"] is not None:
            raise ReleaseError("Publish an exact version and its actual first public distribution date before release.")
        return
    first = record["firstPublicDistribution"]
    if not isinstance(first, str) or not isinstance(record["changeDate"], str):
        raise ReleaseError("Publication and Change Dates must be ISO dates.")
    try:
        if dt.date.fromisoformat(first).isoformat() != first:
            raise ValueError()
        expected = change_date(first)
    except (ValueError, OverflowError):
        raise ReleaseError("Use YYYY-MM-DD publication dates.") from None
    if record["changeDate"] != expected:
        raise ReleaseError("Change Date must be exactly three years after first public distribution.")
    if release and dt.date.fromisoformat(first) > dt.date.today():
        raise ReleaseError("A future publication date cannot describe an already published release.")


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ReleaseError("Release metadata contains duplicate fields.")
            result[key] = value
        return result
    if not isinstance(data, bytes) or len(data) > MAX_BYTES:
        raise ReleaseError("Release metadata exceeds the inspection limit.")
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (UnicodeError, ValueError, RecursionError):
        raise ReleaseError("Release metadata is not valid unambiguous JSON.") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def public_bytes(url):
    """Only official project API/download URLs; bounded, credential-free redirects."""
    initial = urllib.parse.urlsplit(url)
    api = initial.netloc == "api.github.com" and initial.path.startswith("/repos/" + REPOSITORY + "/")
    asset = initial.netloc == "github.com" and initial.path.startswith("/" + REPOSITORY + "/releases/download/")
    if (initial.scheme != "https" or initial.username or initial.password or initial.fragment
            or not (api or asset) or asset and initial.query):
        raise ReleaseError("Release metadata must come from the official project repository.")
    opener = urllib.request.build_opener(NoRedirect)
    for _ in range(4):
        try:
            response = opener.open(urllib.request.Request(url, headers={
                "Accept": "application/vnd.github+json" if api else "application/octet-stream",
                **({"X-GitHub-Api-Version": "2026-03-10"} if api else {}),
                "User-Agent": "MagicStick-release-catalog"}), timeout=10)
            with response:
                data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ReleaseError("Release metadata exceeds the inspection limit.")
            return data
        except urllib.error.HTTPError as error:
            if not asset or error.code not in (301, 302, 303, 307, 308):
                raise ReleaseError("Public release metadata is unavailable (HTTP " + str(error.code) + "). Retry later; no software was selected.") from None
            target = urllib.parse.urlsplit(error.headers.get("Location", ""))
            if (target.scheme != "https" or target.netloc != "release-assets.githubusercontent.com"
                    or target.username or target.password or target.fragment):
                raise ReleaseError("The release download redirected outside the approved asset service.") from None
            url = target.geturl()
        except (OSError, ValueError):
            raise ReleaseError("Public release metadata is unavailable. Check Internet access and retry; no software was selected.") from None
    raise ReleaseError("The release download exceeded the redirect limit.")


def _integer(value):
    return type(value) is int and 0 < value < 2 ** 63


def _manifest_asset(release):
    assets = release.get("assets")
    if not isinstance(assets, list) or len(assets) > 100:
        raise ReleaseError("The release asset list is invalid or too large.")
    found = [a for a in assets if isinstance(a, dict) and a.get("name") == MANIFEST]
    if len(found) != 1:
        raise ReleaseError("This release has no unique verified software manifest; use a supported release.")
    asset = found[0]
    expected = RELEASES + "download/" + release["tag_name"] + "/" + MANIFEST
    if (asset.get("browser_download_url") != expected or not _integer(asset.get("size"))
            or asset["size"] > MAX_BYTES or not DIGEST.fullmatch(str(asset.get("digest", "")))):
        raise ReleaseError("The release manifest has no valid project URL, size or SHA-256 evidence.")
    return asset


def release_summary(release):
    if not isinstance(release, dict) or release.get("draft") is not False or not is_product_version(release.get("tag_name")):
        return None
    version = release["tag_name"]
    url = RELEASES + "tag/" + version
    if release.get("html_url") != url or not _integer(release.get("id")):
        raise ReleaseError("The product release identity does not match the official repository.")
    published = release.get("published_at")
    try:
        date = dt.datetime.fromisoformat(published.replace("Z", "+00:00")) if isinstance(published, str) else None
        if date is None or date.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ReleaseError("The release publication timestamp is missing or invalid.") from None
    prerelease = bool(version_key(version)[4]) or release.get("prerelease") is True
    result = {"version": version, "releaseId": release["id"], "url": url, "publishedAt": published,
              "prerelease": prerelease, "selectable": False}
    if type(release.get("prerelease")) is not bool:
        result["reason"] = "The release channel is unknown."
    elif release.get("immutable") is not True:
        result["reason"] = "This legacy release is not immutable; use a verified product release."
    else:
        try:
            _manifest_asset(release)
            result["selectable"] = True
        except ReleaseError as error:
            result["reason"] = str(error)
    return result


def validate_manifest(value, version, commit):
    fields = {"schemaVersion", "repository", "version", "commit", "managementContract", "license", "images", "checks", "codeql"}
    if (not isinstance(value, dict) or set(value) != fields or type(value.get("schemaVersion")) is not int
            or value["schemaVersion"] != 1 or value.get("repository") != REPOSITORY
            or value.get("version") != version or value.get("commit") != commit
            or not SHA.fullmatch(str(commit)) or type(value.get("managementContract")) is not int
            or value["managementContract"] != 1):
        raise ReleaseError("The release manifest does not match the version, commit or supported management contract.")
    version_key(version)
    validate_license_record(value["license"], release=True)
    if value["license"]["version"] != version:
        raise ReleaseError("The release version and immutable license record differ.")
    images = value["images"]
    if not isinstance(images, list) or len(images) != 5:
        raise ReleaseError("The release must identify the coordinated Web/API/CLI, operator and regression runner images.")
    components = set()
    for image in images:
        if (not isinstance(image, dict) or set(image) != {"component", "image", "sourceRevision", "platforms"}
                or not isinstance(image.get("component"), str)
                or image["component"] not in {"web", "api", "cli", "operator", "runner"}
                or image["component"] in components or not IMAGE.fullmatch(str(image.get("image", "")))
                or image.get("sourceRevision") is not None and not SHA.fullmatch(str(image["sourceRevision"]))
                or not isinstance(image.get("platforms"), list) or not image["platforms"]
                or any(not isinstance(p, str) for p in image["platforms"])
                or len(set(image["platforms"])) != len(image["platforms"])
                or any(p not in {"linux/amd64", "linux/arm64"} for p in image["platforms"])):
            raise ReleaseError("The release image inventory is incomplete, ambiguous or not digest-pinned.")
        if image["component"] != "operator" and image["sourceRevision"] is None:
            raise ReleaseError("Built release images must identify their exact source revision.")
        if image["component"] in {"web", "api", "cli"} and set(image["platforms"]) != {"linux/amd64", "linux/arm64"}:
            raise ReleaseError("Dashboard release images require Linux AMD64 and ARM64.")
        if image["component"] == "runner" and "linux/amd64" not in image["platforms"]:
            raise ReleaseError("The regression runner requires Linux AMD64.")
        components.add(image["component"])
    if len({i["sourceRevision"] for i in images if i["component"] in {"web", "api", "cli"}}) != 1:
        raise ReleaseError("Web, API and CLI release images must belong to the same tested source.")
    checks = value["checks"]
    if not isinstance(checks, list) or not 5 <= len(checks) <= 20:
        raise ReleaseError("The release is missing exact-commit CI evidence.")
    workflows = set()
    for check in checks:
        if (not isinstance(check, dict) or set(check) != {"workflow", "commit", "runId", "attempt"}
                or not isinstance(check.get("workflow"), str)
                or not re.fullmatch(r"[a-z0-9-]+\.yml", check["workflow"])
                or check["workflow"] in workflows or check.get("commit") != commit
                or not _integer(check.get("runId")) or not _integer(check.get("attempt"))):
            raise ReleaseError("The release CI identity is incomplete or ambiguous.")
        workflows.add(check["workflow"])
    if not REQUIRED_CHECKS <= workflows:
        raise ReleaseError("The release is missing required source, browser, security, license or runner checks.")
    gate = value["codeql"]
    if (not isinstance(gate, dict) or set(gate) != {"commit", "checkId"}
            or gate.get("commit") != commit or not _integer(gate.get("checkId"))):
        raise ReleaseError("The release is missing the separate exact-commit CodeQL gate.")
    return value


class ReleaseClient:
    def __init__(self, fetch=None):
        self.fetch = fetch or public_bytes

    def json(self, url):
        return strict_json(self.fetch(url))

    def catalog(self):
        summaries, seen = [], set()
        for page in range(1, MAX_PAGES + 1):
            entries = self.json(API + "/releases?per_page=100&page=" + str(page))
            if not isinstance(entries, list) or len(entries) > 100:
                raise ReleaseError("The release catalog response is invalid.")
            for entry in entries:
                summary = release_summary(entry)
                if summary is None:
                    continue
                if summary["version"] in seen:
                    raise ReleaseError("The release catalog contains duplicate product versions.")
                seen.add(summary["version"])
                summaries.append(summary)
            if len(entries) < 100:
                break
        else:
            raise ReleaseError("The release catalog exceeds the inspection limit; no partial version selection was made.")
        summaries.sort(key=lambda item: version_key(item["version"]), reverse=True)
        return {"releases": summaries, "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "stale": False}

    def tag_identity(self, version):
        version_key(version)
        ref = self.json(API + "/git/ref/tags/" + version)
        if not isinstance(ref, dict) or ref.get("ref") != "refs/tags/" + version:
            raise ReleaseError("The Git tag identity does not match the requested release.")
        obj = ref.get("object")
        first = obj.get("sha") if isinstance(obj, dict) else None
        for _ in range(4):
            if not isinstance(obj, dict) or not SHA.fullmatch(str(obj.get("sha", ""))):
                break
            if obj.get("type") == "commit":
                return {"tagObject": first, "commit": obj["sha"]}
            if obj.get("type") != "tag":
                break
            tag = self.json(API + "/git/tags/" + obj["sha"])
            if not isinstance(tag, dict) or tag.get("sha") != obj["sha"]:
                break
            obj = tag.get("object")
        raise ReleaseError("The release tag does not resolve to one exact commit within the inspection limit.")

    def resolve(self, version, *, expected_commit=None, allow_prerelease=True):
        version_key(version)
        release = self.json(API + "/releases/tags/" + version)
        summary = release_summary(release)
        if summary is None or summary["version"] != version or not summary["selectable"]:
            raise ReleaseError((summary or {}).get("reason", "This product release is not published and verified."))
        if summary["prerelease"] and not allow_prerelease:
            raise ReleaseError("A prerelease cannot be installed as the stable default.")
        identity = self.tag_identity(version)
        if expected_commit is not None and identity["commit"] != expected_commit:
            raise ReleaseError("The release tag moved or differs from the reviewed commit. No software was selected.")
        asset = _manifest_asset(release)
        raw = self.fetch(asset["browser_download_url"])
        if not isinstance(raw, bytes) or len(raw) != asset["size"] or "sha256:" + hashlib.sha256(raw).hexdigest() != asset["digest"]:
            raise ReleaseError("The release manifest does not match its published SHA-256 and size.")
        manifest = validate_manifest(strict_json(raw), version, identity["commit"])
        return {**summary, **identity, "manifestDigest": asset["digest"], "license": manifest["license"],
                "images": manifest["images"], "managementContract": manifest["managementContract"]}

    def latest_stable(self):
        versions = [item for item in self.catalog()["releases"] if not item["prerelease"] and item["selectable"]]
        if not versions:
            raise ReleaseError("No verified stable product release is published. Choose an explicit reviewed prerelease or development ref; main is never an automatic fallback.")
        return self.resolve(versions[0]["version"], allow_prerelease=False)
