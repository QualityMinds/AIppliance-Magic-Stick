# SPDX-License-Identifier: BUSL-1.1
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from license_release import change_date, validate


class ReleaseMetadataTests(unittest.TestCase):
    def record(self, **changes):
        return {"schemaVersion": 1, "version": "example-v1", "firstPublicDistribution": "2026-09-23",
                "changeDate": "2029-09-23", "changeLicense": "MIT", **changes}

    def test_per_version_three_year_period(self):
        self.assertEqual(change_date("2026-09-23"), "2029-09-23")
        validate(self.record())

    def test_leap_day(self):
        self.assertEqual(change_date("2028-02-29"), "2031-02-28")

    def test_unreleased_is_development_only(self):
        record = self.record(version="unreleased", firstPublicDistribution=None, changeDate=None)
        validate(record)
        with self.assertRaises(ValueError):
            validate(record, release=True)

    def test_no_silent_extension_or_invalid_schema(self):
        for changes in ({"changeDate": "2030-09-23"}, {"changeLicense": "GPL-3.0"},
                        {"schemaVersion": True}, {"version": ""}, {"firstPublicDistribution": "20260923"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate(self.record(**changes))


if __name__ == "__main__":
    unittest.main()
