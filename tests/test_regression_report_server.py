import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("report_server", ROOT / "magic-cluster/apps/regression/report_server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class RegressionReportServerTests(unittest.TestCase):
    def test_only_bounded_allowlisted_regular_report_files_can_be_read(self):
        uid = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / uid
            folder.mkdir()
            (folder / "status.json").write_text('{"progress": 10}')
            fd, size, content_type = server.report_file(root, "/" + uid + "/status.json")
            self.assertEqual(content_type, "application/json")
            self.assertEqual(os.read(fd, size), b'{"progress": 10}')
            os.close(fd)
            for path in ("/", "/../account.json", "/" + uid + "/password.txt", "/" + uid + "/journal.json", "/" + uid + "/status.json?x=1"):
                with self.assertRaises((OSError, ValueError)):
                    server.report_file(root, path)
            (folder / "status.json").unlink()
            (folder / "status.json").symlink_to(ROOT / "LICENSE")
            with self.assertRaises((OSError, ValueError)):
                server.report_file(root, "/" + uid + "/status.json")

    def test_directory_symlink_and_large_artifacts_are_rejected(self):
        uid = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / uid).symlink_to(ROOT, target_is_directory=True)
            with self.assertRaises((OSError, ValueError)):
                server.report_file(root, "/" + uid + "/status.json")
