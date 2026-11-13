# SPDX-License-Identifier: BUSL-1.1
"""Version- and hash-bound xDS notice fallback stays fail closed."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import collect_python_notices as notices


class Distribution:
    def __init__(self, name, version, files=()):
        self.metadata = {"Name": name}
        self.version = version
        self.files = list(files)

    def locate_file(self, file):
        return file


class PythonNoticeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.license = Path(self.temp.name) / "LICENSE"
        self.license.write_text("synthetic-license")
        self.xds = Distribution("xds-protos", "1.76.0")
        self.grpc = Distribution("grpcio", "1.76.0", [self.license])

    def distribution(self, name):
        return {"xds-protos": self.xds, "grpcio": self.grpc}[name]

    def digest(self, value):
        class Digest:
            def hexdigest(self):
                return "590198e3f305f2c347fde64d637c65492bbef554db6c8364e149cd375e3797ee" if value == b"synthetic-license" else "different"
        return Digest()

    def test_matching_original_is_explicitly_included(self):
        with (patch.object(notices.metadata, "distribution", side_effect=self.distribution),
              patch.object(notices.hashlib, "sha256", side_effect=self.digest)):
            output = notices.collect(["xds-protos"])
        self.assertIn("grpc/grpc v1.76.0 LICENSE", output)
        self.assertIn("synthetic-license", output)

    def test_modified_hash_wrong_version_and_missing_original_fail(self):
        with (patch.object(notices.metadata, "distribution", side_effect=self.distribution),
              patch.object(notices.hashlib, "sha256", side_effect=self.digest)):
            self.license.write_text("tampered")
            with self.assertRaises(ValueError):
                notices.collect(["xds-protos"])
            self.license.write_text("synthetic-license")
            self.grpc.version = "1.75.0"
            with self.assertRaises(ValueError):
                notices.collect(["xds-protos"])
            self.grpc.version = "1.76.0"
            self.license.unlink()
            with self.assertRaises(ValueError):
                notices.collect(["xds-protos"])
            self.xds.version = "1.76.1"
            with self.assertRaises(ValueError):
                notices.collect(["xds-protos"])

    def test_other_packages_remain_strict(self):
        with patch.object(notices.metadata, "distribution", return_value=Distribution("other", "1.0")):
            with self.assertRaisesRegex(ValueError, "No installed license files"):
                notices.collect(["other"])
