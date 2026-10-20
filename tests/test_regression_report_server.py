import importlib.util
import http.client
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("report_server", ROOT / "magic-cluster/apps/regression/report_server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class RegressionReportServerTests(unittest.TestCase):
    def test_noncanonical_identity_and_hostile_names_are_rejected_before_filesystem_access(self):
        uid = "11111111-2222-3333-4444-555555555555"
        paths = ["/" + "a" * 36 + "/status.json", "/" + "-" * 36 + "/status.json",
                 "/" + uid.replace("-", "") + "/status.json", "/" + uid + "/../status.json",
                 "/" + uid + "/%2e%2e%2fstatus.json", "/" + uid + "/status.json?token=fixture",
                 "/" + uid + "/status.json#fragment", "/" + uid + "/password.txt"]
        with patch.object(server.os, "open", side_effect=AssertionError("must reject before opening a path")):
            for path in paths:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    server.report_file(Path("/unused-fixture"), path)

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
            (root / uid).unlink()
            (root / uid).mkdir()
            (root / uid / "summary.html").write_bytes(b"123456789")
            with patch.object(server, "MAX_BYTES", 8), self.assertRaises(ValueError):
                server.report_file(root, "/" + uid + "/summary.html")

    def test_directory_swap_does_not_redirect_the_already_open_report_directory(self):
        uid = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder, foreign = root / uid, root / "foreign"
            folder.mkdir(); foreign.mkdir()
            (folder / "status.json").write_bytes(b"owned report")
            (foreign / "status.json").write_bytes(b"must not be served")
            real_open = os.open

            def swap_before_file_open(name, flags, *args, **kwargs):
                if name == "status.json":
                    folder.rename(root / "retained")
                    folder.symlink_to(foreign, target_is_directory=True)
                return real_open(name, flags, *args, **kwargs)

            with patch.object(server.os, "open", side_effect=swap_before_file_open):
                fd, size, _ = server.report_file(root, "/" + uid + "/status.json")
            try:
                self.assertEqual(os.read(fd, size), b"owned report")
            finally:
                os.close(fd)

    def test_special_file_is_rejected_without_waiting_for_a_writer(self):
        uid = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / uid).mkdir()
            os.mkfifo(root / uid / "status.json")
            real_open = os.open

            def require_nonblocking(name, flags, *args, **kwargs):
                if name == "status.json":
                    self.assertTrue(flags & os.O_NONBLOCK, "opening a FIFO must never block the report worker")
                return real_open(name, flags, *args, **kwargs)

            with patch.object(server.os, "open", side_effect=require_nonblocking), self.assertRaises(ValueError):
                server.report_file(root, "/" + uid + "/status.json")

    def test_http_handler_serves_every_allowlisted_product_and_rejects_private_paths(self):
        uid = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / uid).mkdir()
            for filename in server.FILES:
                (root / uid / filename).write_bytes(b"synthetic public report")
            httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            with patch.object(server, "ROOT", root):
                thread.start()
                try:
                    for filename, mime in server.FILES.items():
                        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=3)
                        try:
                            connection.request("GET", "/" + uid + "/" + filename)
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200)
                            self.assertEqual(response.getheader("Content-Type"), mime)
                            self.assertEqual(response.getheader("Cache-Control"), "no-store")
                            self.assertEqual(response.read(), b"synthetic public report")
                        finally:
                            connection.close()
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=3)
                    try:
                        connection.request("GET", "/" + uid + "/journal.json")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 404)
                        response.read()
                    finally:
                        connection.close()
                finally:
                    httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)
