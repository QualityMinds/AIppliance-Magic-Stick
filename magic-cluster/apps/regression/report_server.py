"""Serve only completed public-safe report products and sanitized progress.

The PVC's private inputs/journals are not mounted here. No directory listings,
redirects, query strings, symlinks, raw logs or arbitrary filenames are served.
"""
import os
import re
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import UUID

ROOT = Path("/reports")
FILES = {"status.json": "application/json", "summary.html": "text/html; charset=utf-8",
         "junit.xml": "application/xml", "report-artifacts.tar.gz": "application/gzip"}
MAX_BYTES = 64 * 1024 * 1024


def report_file(root, path):
    match = re.fullmatch(r"/([a-f0-9-]{36})/(status[.]json|summary[.]html|junit[.]xml|report-artifacts[.]tar[.]gz)", path)
    if not match:
        raise ValueError("Invalid report path")
    # Reconstruct the directory from a parsed UUID, and select a literal key
    # from the existing allowlist. Neither filesystem component is copied from
    # the request, including requests which fit the broad lexical expression.
    run_id = str(UUID(match[1]))
    if run_id != match[1]:
        raise ValueError("Invalid report identity")
    filename = next((name for name in FILES if name == match[2]), None)
    if filename is None:
        raise ValueError("Invalid report product")
    # Directory and final file are bound by open descriptors, including when a
    # writer swaps an entry between validation and opening it.
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        directory_fd = os.open(run_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    finally:
        os.close(root_fd)
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    finally:
        os.close(directory_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ValueError("Invalid report file")
    except BaseException:
        os.close(fd)
        raise
    return fd, info.st_size, FILES[filename]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        try:
            fd, size, content_type = report_file(ROOT, self.path)
        except (OSError, ValueError):
            self.send_error(404, "Report not available")
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            with os.fdopen(fd, "rb") as stream:
                while chunk := stream.read(64 * 1024):
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
