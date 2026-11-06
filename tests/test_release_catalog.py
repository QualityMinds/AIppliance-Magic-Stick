# SPDX-License-Identifier: BUSL-1.1
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "magic-host/roles/host-management/files"))
import release_catalog as catalog

COMMIT = "a" * 40
TAG = "b" * 40


def manifest(version="v1.2.3", commit=COMMIT):
    return {"schemaVersion": 1, "repository": catalog.REPOSITORY, "version": version, "commit": commit,
            "managementContract": 1,
            "codeql": {"commit": commit, "checkId": 12345},
            "license": {"schemaVersion": 1, "version": version, "firstPublicDistribution": "2024-02-29",
                        "changeDate": "2027-02-28", "changeLicense": "MIT"},
            "images": [{"component": component, "image": "registry.example.com/" + component + "@sha256:" + "1" * 64,
                        "sourceRevision": None if component == "operator" else "c" * 40,
                        "platforms": ["linux/amd64"] if component == "runner" else ["linux/amd64", "linux/arm64"]}
                       for component in ("web", "api", "cli", "operator", "runner")],
            "checks": [{"workflow": name, "commit": commit, "runId": index + 1, "attempt": 1}
                       for index, name in enumerate(sorted(catalog.REQUIRED_CHECKS))]}


def release(version="v1.2.3", *, immutable=True):
    raw = json.dumps(manifest(version), sort_keys=True).encode()
    return {"id": 123, "tag_name": version, "draft": False, "prerelease": "-" in version,
            "immutable": immutable, "published_at": "2024-02-29T12:00:00Z",
            "html_url": catalog.RELEASES + "tag/" + version,
            "assets": [{"name": catalog.MANIFEST, "size": len(raw),
                        "browser_download_url": catalog.RELEASES + "download/" + version + "/" + catalog.MANIFEST,
                        "digest": "sha256:" + hashlib.sha256(raw).hexdigest()}]}


class CatalogTests(unittest.TestCase):
    def client(self, entries=None, record=None, raw=None, commit=COMMIT, annotated=True):
        record = release() if record is None else record
        version = record["tag_name"]
        raw = json.dumps(manifest(version), sort_keys=True).encode() if raw is None else raw
        responses = {
            catalog.API + "/releases?per_page=100&page=1": [record] if entries is None else entries,
            catalog.API + "/releases/tags/" + version: record,
            catalog.API + "/git/ref/tags/" + version: {"ref": "refs/tags/" + version,
                "object": {"type": "tag" if annotated else "commit", "sha": TAG if annotated else commit}},
            catalog.API + "/git/tags/" + TAG: {"sha": TAG, "object": {"type": "commit", "sha": commit}},
            catalog.RELEASES + "download/" + version + "/" + catalog.MANIFEST: raw,
        }
        calls = []
        def fetch(url):
            calls.append(url)
            value = responses[url]
            return value if isinstance(value, bytes) else json.dumps(value).encode()
        client = catalog.ReleaseClient(fetch)
        client.calls, client.responses = calls, responses
        return client

    def test_product_versions_are_sorted_semantically_not_lexically(self):
        entries = [release(v) for v in ("v1.9.0", "v1.10.0-rc.2", "v1.10.0", "v1.10.0-rc.10", "v1.10.0-rc")]
        result = self.client(entries).catalog()
        self.assertEqual([r["version"] for r in result["releases"]],
                         ["v1.10.0", "v1.10.0-rc.10", "v1.10.0-rc.2", "v1.10.0-rc", "v1.9.0"])
        self.assertFalse(result["stale"])

    def test_component_tags_drafts_and_invalid_semver_are_not_product_versions(self):
        entries = [release(), {**release(), "tag_name": "installer-main-example"},
                   {**release(), "tag_name": "mesh-client-123"}, {**release(), "tag_name": "v1.02.3"},
                   {**release(), "tag_name": "v1.2.3-rc.01"}, {**release(), "tag_name": "v1.2.4", "draft": True}]
        self.assertEqual([r["version"] for r in self.client(entries).catalog()["releases"]], ["v1.2.3"])

    def test_reading_catalog_does_not_resolve_or_download_each_release(self):
        client = self.client()
        self.assertTrue(client.catalog()["releases"][0]["selectable"])
        self.assertEqual(client.calls, [catalog.API + "/releases?per_page=100&page=1"])

    def test_legacy_nonimmutable_and_missing_manifests_are_visible_but_disabled(self):
        for changes in ({"immutable": False}, {"assets": []}, {"assets": release()["assets"] * 2}):
            with self.subTest(changes=changes):
                item = self.client(record={**release(), **changes}).catalog()["releases"][0]
                self.assertFalse(item["selectable"])
                self.assertTrue(item["reason"])

    def test_resolve_binds_annotated_tag_manifest_hash_commit_and_license(self):
        resolved = self.client().resolve("v1.2.3", expected_commit=COMMIT)
        self.assertEqual(resolved["tagObject"], TAG)
        self.assertEqual(resolved["commit"], COMMIT)
        self.assertEqual(resolved["license"]["changeDate"], "2027-02-28")
        self.assertEqual(len(resolved["images"]), 5)
        self.assertEqual(self.client(annotated=False).resolve("v1.2.3")["tagObject"], COMMIT)

    def test_moved_tag_and_manifest_for_another_commit_are_rejected(self):
        with self.assertRaisesRegex(catalog.ReleaseError, "moved"):
            self.client(commit="d" * 40).resolve("v1.2.3", expected_commit=COMMIT)
        with self.assertRaisesRegex(catalog.ReleaseError, "manifest does not match"):
            self.client(commit="d" * 40).resolve("v1.2.3")

    def test_corrupt_size_digest_and_manifest_content_fail_closed(self):
        for raw in (b"{}", b"x" * release()["assets"][0]["size"]):
            with self.subTest(raw=raw[:4]), self.assertRaisesRegex(catalog.ReleaseError, "SHA-256"):
                self.client(raw=raw).resolve("v1.2.3")
        for changes in ({"digest": "sha256:" + "f" * 64}, {"digest": None}, {"size": catalog.MAX_BYTES + 1},
                        {"browser_download_url": "https://unrelated.example.com/private"}):
            item = release(); item["assets"][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(catalog.ReleaseError):
                self.client(record=item).resolve("v1.2.3")

    def test_no_stable_release_never_falls_back_to_main_or_old_legacy(self):
        for entries in ([], [release("v2.0.0-rc.1")], [release(immutable=False)]):
            with self.subTest(entries=entries), self.assertRaisesRegex(catalog.ReleaseError, "No verified stable"):
                self.client(entries).latest_stable()

    def test_latest_stable_ignores_prereleases_even_if_published_later(self):
        client = self.client([release("v9.0.0-rc.1"), release()])
        self.assertEqual(client.latest_stable()["version"], "v1.2.3")
        with self.assertRaisesRegex(catalog.ReleaseError, "prerelease"):
            self.client(record=release("v2.0.0-rc.1")).resolve("v2.0.0-rc.1", allow_prerelease=False)

    def test_duplicate_versions_bad_identity_and_ambiguous_tag_objects_are_rejected(self):
        with self.assertRaisesRegex(catalog.ReleaseError, "duplicate"):
            self.client([release(), release()]).catalog()
        for changes in ({"html_url": "https://unrelated.example.com"}, {"id": True}, {"published_at": "unknown"}):
            with self.subTest(changes=changes), self.assertRaises(catalog.ReleaseError):
                self.client(record={**release(), **changes}).catalog()
        client = self.client()
        client.responses[catalog.API + "/git/tags/" + TAG]["object"] = {"type": "tree", "sha": COMMIT}
        with self.assertRaisesRegex(catalog.ReleaseError, "exact commit"):
            client.resolve("v1.2.3")

    def test_catalog_pagination_is_bounded_and_never_returns_a_partial_catalog(self):
        calls = []
        def fetch(url):
            calls.append(url)
            return json.dumps([{"draft": True}] * 100).encode()
        with self.assertRaisesRegex(catalog.ReleaseError, "limit"):
            catalog.ReleaseClient(fetch).catalog()
        self.assertEqual(len(calls), catalog.MAX_PAGES)

    def test_manifest_requires_actual_immutable_license_dates_and_all_critical_images(self):
        base = manifest()
        changes = []
        for key, value in (("version", "v1.2.4"), ("changeDate", "2035-01-01"), ("firstPublicDistribution", "2099-01-01"),
                           ("changeLicense", "BUSL-1.1")):
            record = copy.deepcopy(base); record["license"][key] = value; changes.append(record)
        for name, value in (("managementContract", True), ("checks", base["checks"][:-1]),
                            ("images", base["images"][:-1]), ("version", "v9.9.9"), ("repository", "example/repo")):
            changes.append({**base, name: value})
        for value in changes:
            with self.subTest(value=value), self.assertRaises(catalog.ReleaseError):
                catalog.validate_manifest(value, "v1.2.3", COMMIT)
        self.assertEqual(catalog.validate_manifest(base, "v1.2.3", COMMIT), base)

    def test_manifest_rejects_mismatched_builds_mutable_images_missing_architectures_and_forged_checks(self):
        for change in (lambda v: v["images"][1].update(sourceRevision="d" * 40),
                       lambda v: v["images"][0].update(image="registry.example.com/web:latest"),
                       lambda v: v["images"][0].update(platforms=["linux/amd64"]),
                       lambda v: v["images"][0].update(platforms=["linux/amd64", "linux/amd64"]),
                       lambda v: v["checks"][0].update(commit="d" * 40),
                       lambda v: v["checks"][0].update(attempt=0),
                       lambda v: v["checks"].append(v["checks"][0])):
            value = manifest(); change(value)
            with self.subTest(value=value), self.assertRaises(catalog.ReleaseError):
                catalog.validate_manifest(value, "v1.2.3", COMMIT)

    def test_json_and_network_errors_do_not_leak_upstream_bodies_or_signed_urls(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'not-json', b'x' * (catalog.MAX_BYTES + 1)):
            with self.assertRaises(catalog.ReleaseError): catalog.strict_json(raw)
        for url in ("http://api.github.com/repos/" + catalog.REPOSITORY + "/releases",
                    "https://api.github.com.evil.example.com/releases", "https://github.com/unrelated/repo/releases/download/x/y",
                    catalog.API + "/releases#secret", "https://user:secret@api.github.com/repos/" + catalog.REPOSITORY + "/releases"):
            with self.subTest(url=url), self.assertRaises(catalog.ReleaseError): catalog.public_bytes(url)
        opener = unittest.mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError(catalog.API, 403, "SYNTHETIC_PRIVATE_TOKEN", {}, io.BytesIO(b"SYNTHETIC_PRIVATE_TOKEN"))
        with patch.object(catalog.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(catalog.ReleaseError) as caught: catalog.public_bytes(catalog.API + "/releases")
        self.assertIn("HTTP 403", str(caught.exception))
        self.assertNotIn("SYNTHETIC_PRIVATE_TOKEN", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
