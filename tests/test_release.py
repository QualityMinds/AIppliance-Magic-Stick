# SPDX-License-Identifier: BUSL-1.1
import json
from pathlib import Path
import tempfile
import unittest

from tools import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "LICENSE-RELEASE.json").write_text(json.dumps({
            "schemaVersion": 1, "version": "unreleased", "firstPublicDistribution": None,
            "changeDate": None, "changeLicense": "MIT"}))
        (self.root / "CHANGELOG.md").write_text("# Changelog\n\n## Unreleased\n\n- Pending work.\n")
        (self.root / "licenses").mkdir()
        (self.root / "licenses/release-review.json").write_text('{"gates": [{"status": "pending"}]}')
        self.notes = "### Fixed\n\n- Reviewed example fix."

    def prepare(self, **overrides):
        arguments = dict(version="v1.2.3", date="2024-02-29", notes=self.notes, write=True)
        arguments.update(overrides)
        return release.prepare(self.root, **arguments)

    def test_preview_does_not_write_and_apply_is_idempotent(self):
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(len(self.prepare(write=False)), 3)
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        self.assertEqual(len(self.prepare()), 3)
        self.assertEqual(self.prepare(), [])
        self.assertEqual(release.check(self.root, "v1.2.3"), self.notes)
        record = json.loads((self.root / "LICENSE-RELEASE.json").read_text())
        self.assertEqual(record["changeDate"], "2027-02-28")
        self.assertEqual((self.root / "licenses/release-review.json").read_bytes(),
                         before[self.root / "licenses/release-review.json"])

    def test_dates_and_published_notes_cannot_be_rewritten(self):
        self.prepare()
        for changes in ({"date": "2024-03-01"}, {"notes": "Changed story"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.prepare(**changes)
        self.assertEqual(release.check(self.root, "v1.2.3"), self.notes)

    def test_next_version_retains_prior_archive_and_notes(self):
        self.prepare()
        first = (self.root / "licenses/releases/v1.2.3.json").read_bytes()
        self.prepare(version="v1.2.4", date="2024-03-05", notes="### Changed\n\n- Second release.")
        self.assertEqual((self.root / "licenses/releases/v1.2.3.json").read_bytes(), first)
        self.assertIn("## v1.2.3 - 2024-02-29", (self.root / "CHANGELOG.md").read_text())
        self.assertIn("Pending work", (self.root / "CHANGELOG.md").read_text())
        with self.assertRaises(ValueError):
            release.check(self.root, "v1.2.3")

    def test_invalid_version_date_and_notes_fail_before_writing(self):
        for changes in ({"version": "latest"}, {"version": "../../escape"}, {"date": "2099-01-01"},
                        {"notes": ""}, {"notes": "## Duplicate release heading"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.prepare(**changes)
        self.assertFalse((self.root / "licenses/releases").exists())

    def test_archive_conflict_and_empty_notes_fail_closed(self):
        self.prepare()
        archive = self.root / "licenses/releases/v1.2.3.json"
        record = json.loads(archive.read_text())
        record["firstPublicDistribution"] = "2024-03-01"
        archive.write_text(json.dumps(record))
        with self.assertRaises(ValueError):
            self.prepare()
        with self.assertRaises(ValueError):
            release.check(self.root, "v1.2.3")
        with self.assertRaises(ValueError):
            release.release_notes("## v1.2.3 - 2024-02-29\n", "v1.2.3", "2024-02-29")
