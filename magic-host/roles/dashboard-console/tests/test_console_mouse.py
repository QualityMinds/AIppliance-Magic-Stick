import importlib.util
import os
import pathlib
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = pathlib.Path(__file__).resolve().parents[1] / "files" / "console-mouse.py"
SPEC = importlib.util.spec_from_file_location("console_mouse", HELPER)
console_mouse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(console_mouse)

# Device packets: first byte carries buttons (left 1, right 2, middle 4), bit 3 and the sign bits.
LEFT_DOWN = bytes([0x09, 0, 0])
RELEASED = bytes([0x08, 0, 0])


def packet(dx=0, dy=0, buttons=0, wheel=None):
    first = 0x08 | buttons | (0x10 if dx < 0 else 0) | (0x20 if dy < 0 else 0)
    data = [first, dx & 0xFF, dy & 0xFF]
    return bytes(data + ([wheel & 0xFF] if wheel is not None else []))


class PacketDecoderTests(unittest.TestCase):
    def test_decodes_signed_movement_buttons_and_split_packets(self):
        decoder = console_mouse.PacketDecoder(wheel=False)
        self.assertEqual(decoder.feed(packet(5, -3, buttons=1)[:2]), [])
        self.assertEqual(decoder.feed(packet(5, -3, buttons=1)[2:] + packet(-8, 16)), [(1, 5, -3, 0), (0, -8, 16, 0)])

    def test_resynchronises_on_a_stray_byte_and_reads_the_wheel(self):
        decoder = console_mouse.PacketDecoder(wheel=True)
        self.assertEqual(decoder.feed(b"\x00" + packet(1, 1, wheel=-1) + packet(0, 0, wheel=2)), [(0, 1, 1, -1), (0, 0, 0, 2)])


class ModeTrackerTests(unittest.TestCase):
    def test_reports_only_while_the_program_asked_for_them(self):
        modes = console_mouse.ModeTracker()
        self.assertFalse(modes.clicks)
        modes.feed(b"\x1b[2J\x1b[?1000h")
        self.assertFalse(modes.clicks)  # SGR encoding not requested yet
        modes.feed(b"\x1b[?1006h")
        self.assertTrue(modes.clicks)
        self.assertFalse(modes.motion)
        modes.feed(b"text\x1b[?10")
        modes.feed(b"03h more")  # split across two reads
        self.assertTrue(modes.motion)
        modes.feed(b"\x1b[?1006l\x1b[?1003l\x1b[?1000l")
        self.assertFalse(modes.clicks)
        self.assertFalse(modes.motion)


class TranslationTests(unittest.TestCase):
    def pointer(self):
        pointer = console_mouse.Pointer(120, 40)
        pointer.x, pointer.y = 10.0, 5.0
        return pointer

    def test_moves_by_cells_and_stays_on_screen(self):
        pointer = self.pointer()
        pointer.move(16, -32)  # right two columns, down two rows
        self.assertEqual(pointer.cell, (13, 8))
        pointer.move(-100000, 100000)
        self.assertEqual(pointer.cell, (1, 1))
        pointer.move(100000, -100000)
        self.assertEqual(pointer.cell, (120, 40))
        pointer.resize(80, 25)
        self.assertEqual(pointer.cell, (80, 25))

    def test_reports_clicks_at_the_pointer_cell_in_sgr_encoding(self):
        pointer = self.pointer()
        reports = console_mouse.translate(pointer, [(1, 0, 0, 0), (0, 0, 0, 0)], clicks=True, motion=False)
        self.assertEqual(reports, b"\x1b[<0;11;6M\x1b[<0;11;6m")
        right = console_mouse.translate(pointer, [(2, 0, 0, 0)], clicks=True, motion=False)
        self.assertEqual(right, b"\x1b[<2;11;6M")

    def test_reports_movement_once_per_cell_and_before_a_click(self):
        pointer = self.pointer()
        small = console_mouse.translate(pointer, [(0, 2, 0, 0)], clicks=True, motion=True)
        self.assertEqual(small, b"")  # still the same cell
        batch = console_mouse.translate(pointer, [(0, 8, 0, 0), (0, 8, 0, 0), (0, 8, 0, 0)], clicks=True, motion=True)
        self.assertEqual(batch, b"\x1b[<35;14;6M")
        moved_click = console_mouse.translate(pointer, [(1, 16, 0, 0)], clicks=True, motion=True)
        self.assertEqual(moved_click, b"\x1b[<35;16;6M\x1b[<0;16;6M")

    def test_wheel_scrolls_and_nothing_is_sent_without_a_request(self):
        pointer = self.pointer()
        self.assertEqual(console_mouse.translate(pointer, [(0, 0, 0, -1)], clicks=True, motion=False), b"\x1b[<64;11;6M")
        self.assertEqual(console_mouse.translate(pointer, [(0, 0, 0, 1)], clicks=True, motion=False), b"\x1b[<65;11;6M")
        silent = console_mouse.translate(pointer, [(1, 80, 0, -1), (0, 0, 0, 0)], clicks=False, motion=False)
        self.assertEqual(silent, b"")
        self.assertEqual(pointer.cell, (21, 6))  # the position is still tracked


def read_until(descriptor, marker, timeout=5.0):
    data = b""
    end = time.time() + timeout
    while marker not in data and time.time() < end:
        ready, _, _ = select.select([descriptor], [], [], 0.1)
        if ready:
            try:
                data += os.read(descriptor, 65536)
            except OSError:
                break
    return data


class ProxyTests(unittest.TestCase):
    """Runs the helper on a pseudo-terminal with a FIFO standing in for the mouse device."""

    CHILD = (
        "import os, sys, tty\n"
        "tty.setraw(0)\n"
        "os.write(1, b'\\x1b[?1000h\\x1b[?1006h\\x1b[?1003hREADY')\n"
        "data = b''\n"
        "while not data.endswith(b'q'):\n"
        "    data += os.read(0, 1024)\n"
        "os.write(1, b'GOT:' + data.hex().encode() + b':END')\n"
    )

    def test_merges_mouse_reports_into_keyboard_input_and_passes_output_through(self):
        with tempfile.TemporaryDirectory() as directory:
            device = os.path.join(directory, "mice")
            os.mkfifo(device)
            keep_open = os.open(device, os.O_RDWR | os.O_NONBLOCK)  # a FIFO needs a writer to stay readable
            pid, master = pty.fork()
            if pid == 0:
                os.execv(sys.executable, [sys.executable, str(HELPER), "--device", device, "--", sys.executable, "-c", self.CHILD])
            try:
                self.assertIn(b"READY", read_until(master, b"READY"))
                time.sleep(0.4)  # the helper drains the protocol switch it wrote to the stand-in device
                while select.select([keep_open], [], [], 0)[0]:
                    os.read(keep_open, 64)
                os.write(master, b"a")
                os.write(keep_open, packet(40, 0, wheel=0) + packet(0, 0, buttons=1, wheel=0) + packet(0, 0, wheel=0))
                time.sleep(0.4)
                os.write(master, b"q")
                output = read_until(master, b":END")
                received = bytes.fromhex(output.split(b"GOT:")[1].split(b":END")[0].decode())
            finally:
                os.close(keep_open)
                os.waitpid(pid, 0)
        self.assertTrue(received.startswith(b"a"))
        self.assertTrue(received.endswith(b"q"))
        reports = received[1:-1]
        # One movement report (five columns right of the centre), then press and release at that cell.
        self.assertRegex(reports, rb"^\x1b\[<35;(\d+);(\d+)M\x1b\[<0;\1;\2M\x1b\[<0;\1;\2m$")

    def test_runs_the_command_directly_without_a_mouse_device(self):
        result = subprocess.run(
            [sys.executable, str(HELPER), "--device", "/nonexistent/mice", "--", sys.executable, "-c", "print('direct')"],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "direct"))

    def test_returns_the_exit_status_of_the_command(self):
        with tempfile.TemporaryDirectory() as directory:
            device = os.path.join(directory, "mice")
            os.mkfifo(device)
            keep_open = os.open(device, os.O_RDWR | os.O_NONBLOCK)
            pid, master = pty.fork()
            if pid == 0:
                os.execv(sys.executable, [sys.executable, str(HELPER), "--device", device, "--", sys.executable, "-c", "raise SystemExit(7)"])
            read_until(master, b"\0never", timeout=1.5)
            os.close(keep_open)
            _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 7)


if __name__ == "__main__":
    unittest.main()
