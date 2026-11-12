#!/usr/bin/env python3
"""Mouse support for the Magic Stick TUI on the attached monitor.

The Linux console never reports a mouse to the program it shows, and the TUI
runs in a Pod where the host's mouse is invisible. This helper runs the TUI
command behind a pseudo-terminal, reads the kernel's combined mouse device and
writes the same mouse reports a terminal emulator would send (SGR encoding)
into the TUI's input. It only does so while the TUI has asked for mouse
reports, so the keyboard-only waiting screens are never disturbed.

Usage: console-mouse.py [--device PATH] -- command [arguments...]

Without a usable mouse device or terminal the command is run directly, so the
keyboard always keeps working.
"""

import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import tty

DEFAULT_DEVICE = "/dev/input/mice"
# Mouse movement units per character cell; a cell is about twice as tall as wide.
UNITS_PER_COLUMN = 8.0
UNITS_PER_ROW = 16.0
# Switches the kernel's emulated mouse to the wheel-reporting protocol (four-byte packets).
WHEEL_PROTOCOL = bytes([0xF3, 200, 0xF3, 100, 0xF3, 80])
MODE_CHANGE = re.compile(rb"\x1b\[\?([0-9;]+)([hl])")
LEFT, MIDDLE, RIGHT = 0, 1, 2


class PacketDecoder:
    """Turns the byte stream of /dev/input/mice into (buttons, dx, dy, wheel) packets."""

    def __init__(self, wheel):
        self.size = 4 if wheel else 3
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        packets = []
        while True:
            # Bit 3 is set in every first byte: skip anything else to regain packet boundaries.
            while self.buffer and not self.buffer[0] & 0x08:
                del self.buffer[0]
            if len(self.buffer) < self.size:
                return packets
            first, dx, dy = self.buffer[0], self.buffer[1], self.buffer[2]
            wheel = self.buffer[3] if self.size == 4 else 0
            del self.buffer[: self.size]
            packets.append((
                first & 0x07,
                dx - 256 if first & 0x10 else dx,
                dy - 256 if first & 0x20 else dy,
                wheel - 256 if wheel > 127 else wheel,
            ))


class ModeTracker:
    """Follows which mouse reports the program asked for by watching its output."""

    def __init__(self):
        self.modes = set()
        self.tail = b""

    def feed(self, data):
        text = self.tail + data
        for match in MODE_CHANGE.finditer(text):
            for mode in match.group(1).split(b";"):
                if match.group(2) == b"h":
                    self.modes.add(mode)
                else:
                    self.modes.discard(mode)
        # A mode change may be split across two reads: keep an unfinished sequence.
        start = text.rfind(b"\x1b")
        self.tail = text[start:] if start >= 0 and not MODE_CHANGE.match(text, start) and len(text) - start < 32 else b""

    @property
    def clicks(self):
        """The program understands SGR reports and wants at least button events."""
        return b"1006" in self.modes and bool(self.modes & {b"1000", b"1002", b"1003"})

    @property
    def motion(self):
        return b"1006" in self.modes and b"1003" in self.modes


class Pointer:
    """Pointer position in character cells, moved by relative mouse packets."""

    def __init__(self, columns, rows):
        self.columns, self.rows = max(1, columns), max(1, rows)
        self.x = self.columns / 2.0
        self.y = self.rows / 2.0
        self.buttons = 0

    def resize(self, columns, rows):
        self.columns, self.rows = max(1, columns), max(1, rows)
        self.move(0, 0)

    def move(self, dx, dy):
        # The device reports upward movement as positive; rows grow downward.
        self.x = min(self.columns - 0.01, max(0.0, self.x + dx / UNITS_PER_COLUMN))
        self.y = min(self.rows - 0.01, max(0.0, self.y - dy / UNITS_PER_ROW))

    @property
    def cell(self):
        return int(self.x) + 1, int(self.y) + 1


def report(code, cell, pressed=True):
    return b"\x1b[<%d;%d;%d%s" % (code, cell[0], cell[1], b"M" if pressed else b"m")


def translate(pointer, packets, clicks, motion):
    """Mouse reports for a batch of packets. Movement is reported once, and only when the cell changed."""
    output = []
    before = pointer.cell
    for buttons, dx, dy, wheel in packets:
        pointer.move(dx, dy)
        if clicks:
            # Device bits: left, right, middle. Terminal codes: left 0, middle 1, right 2.
            for bit, code in ((0x01, LEFT), (0x04, MIDDLE), (0x02, RIGHT)):
                if (buttons ^ pointer.buttons) & bit:
                    if motion and pointer.cell != before:
                        output.append(report(35, pointer.cell))
                        before = pointer.cell
                    output.append(report(code, pointer.cell, bool(buttons & bit)))
            if wheel:
                # The device reports scrolling away from the user as negative.
                output.extend([report(64 if wheel < 0 else 65, pointer.cell)] * min(abs(wheel), 5))
        pointer.buttons = buttons
    if motion and pointer.cell != before:
        output.append(report(35, pointer.cell))
    return b"".join(output)


def window_size(descriptor):
    rows, columns, _, _ = struct.unpack("HHHH", fcntl.ioctl(descriptor, termios.TIOCGWINSZ, b"\0" * 8))
    return columns or 80, rows or 25


def open_mouse(path):
    """Opens the mouse device, with wheel reports when the device accepts the protocol switch."""
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        try:
            return os.open(path, os.O_RDONLY | os.O_NONBLOCK), False
        except OSError:
            return None, False
    try:
        os.write(descriptor, WHEEL_PROTOCOL)
        # The device acknowledges every byte; those acknowledgements are not mouse packets.
        select.select([descriptor], [], [], 0.2)
        try:
            os.read(descriptor, 64)
        except OSError:
            pass
        return descriptor, True
    except OSError:
        return descriptor, False


def write_all(descriptor, data):
    while data:
        data = data[os.write(descriptor, data):]


def run(command, device):
    terminal = sys.stdin.fileno()
    mouse, wheel = open_mouse(device) if os.isatty(terminal) else (None, False)
    if mouse is None:
        os.execvp(command[0], command)

    child, master = pty.fork()
    if child == 0:
        os.execvp(command[0], command)

    columns, rows = window_size(terminal)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    pointer, decoder, modes = Pointer(columns, rows), PacketDecoder(wheel), ModeTracker()

    def resized(*_):
        size = window_size(terminal)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", size[1], size[0], 0, 0))
        pointer.resize(*size)

    signal.signal(signal.SIGWINCH, resized)
    saved = termios.tcgetattr(terminal)
    tty.setraw(terminal)
    sources = [terminal, master, mouse]
    try:
        while True:
            try:
                ready, _, _ = select.select(sources, [], [])
            except InterruptedError:
                continue
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                modes.feed(data)
                write_all(sys.stdout.fileno(), data)
            if terminal in ready:
                data = os.read(terminal, 4096)
                if not data:
                    break
                write_all(master, data)
            if mouse in ready:
                try:
                    data = os.read(mouse, 4096)
                except BlockingIOError:
                    data = b""
                except OSError:
                    # The mouse disappeared (for example the last one was unplugged): keep the keyboard working.
                    sources.remove(mouse)
                    continue
                reports = translate(pointer, decoder.feed(data), modes.clicks, modes.motion)
                if reports:
                    write_all(master, reports)
    finally:
        termios.tcsetattr(terminal, termios.TCSADRAIN, saved)
    _, status = os.waitpid(child, 0)
    return os.waitstatus_to_exitcode(status)


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--device", default=os.environ.get("MAGICSTICK_CONSOLE_MOUSE_DEVICE", DEFAULT_DEVICE))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args(arguments)
    command = options.command[1:] if options.command[:1] == ["--"] else options.command
    if not command:
        parser.error("a command to run is required")
    return run(command, options.device)


if __name__ == "__main__":
    sys.exit(main())
