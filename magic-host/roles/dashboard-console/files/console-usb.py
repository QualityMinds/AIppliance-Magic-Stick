#!/usr/bin/env python3
"""USB sticks for the Magic Stick TUI on the attached monitor.

The TUI on the monitor runs in the console Pod, which cannot reach the host's
devices, so it cannot save a download where a person can take it away or read
a file they brought. When a signed-in user saves to or opens from a USB stick,
the TUI writes a small request into the console transfer folder, and a systemd
path unit runs this helper as root:

- ``scan`` mounts every attached USB stick formatted as FAT32 or exFAT below
  ``<root>/usb/<name>`` for the console user only (no programs, device files
  or set-user-ID files, private permissions). The console Pod sees these mounts
  through mount propagation.
- ``eject`` flushes and unmounts one of those sticks so it can be unplugged.

Nothing is mounted without a request. A disk with a mounted system filesystem,
active swap or the EFI system partition is never touched, and the helper only
ever unmounts what it mounted itself. Sticks that were unplugged without
``eject`` are cleaned up on the next request. The answer is written to
``<root>/status/status.json``, which the Pod can read but not change.

Usage: console-usb.py process --root DIR --uid UID --gid GID [--filesystems vfat,exfat]
"""

import argparse
import datetime
import json
import os
import re
import stat
import subprocess
import sys
import tempfile

DEFAULT_ROOT = "/var/lib/magicstick/console-transfer"
REQUEST_LIMIT = 4096
REQUEST_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
STICK_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
EFI_SYSTEM_PARTITION = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
LSBLK_COLUMNS = "NAME,KNAME,PATH,TYPE,TRAN,FSTYPE,LABEL,UUID,PARTTYPE,MOUNTPOINTS,SIZE"


class CommandError(Exception):
    """A system command failed."""


class HelperError(Exception):
    """A request could not be carried out; the message is shown in the TUI."""


def run_command(argv):
    result = subprocess.run(argv, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode != 0:
        raise CommandError((result.stderr or result.stdout).strip() or f"{argv[0]} exited with {result.returncode}")
    return result.stdout


def read_request(path, uid):
    """Reads and consumes the console's request. Returns None when there is none."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(descriptor)
        data = os.read(descriptor, REQUEST_LIMIT + 1)
    finally:
        os.close(descriptor)
    os.unlink(path)
    # Only the console runtime user may ask; anything else is ignored without an answer.
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or len(data) > REQUEST_LIMIT:
        raise HelperError("Ignoring a request that was not written by the console.")
    try:
        request = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise HelperError("Ignoring a malformed request.") from error
    if not isinstance(request, dict) or request.get("version") != 1 or not REQUEST_ID.match(str(request.get("id", ""))):
        raise HelperError("Ignoring a malformed request.")
    return request


def unescape(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def owned_mounts(mountinfo, usb_dir):
    """Mounts directly below the console's usb folder, by name: {name: source device}."""
    result = {}
    for line in mountinfo.splitlines():
        left, separator, right = line.partition(" - ")
        fields = left.split()
        if not separator or len(fields) < 5:
            continue
        mount_point = unescape(fields[4])
        if os.path.dirname(mount_point) == usb_dir:
            source = right.split()
            result[os.path.basename(mount_point)] = unescape(source[1]) if len(source) > 1 else ""
    return result


def descendants(node):
    yield node
    for child in node.get("children") or []:
        yield from descendants(child)


def mountpoints(node):
    values = node.get("mountpoints")
    if values is None:
        values = [node.get("mountpoint")]
    return [value for value in values if value]


def inside(path, directory):
    return path == directory or path.startswith(directory + "/")


def candidates(devices, usb_dir, filesystems):
    """USB filesystems that may be offered: never on a disk that is otherwise in use."""
    for disk in devices:
        if disk.get("type") != "disk" or str(disk.get("tran") or "").lower() != "usb":
            continue
        nodes = list(descendants(disk))
        # A mounted system filesystem, active swap ("[SWAP]") or an LVM/LUKS volume in use
        # anywhere on the disk keeps the whole disk out of reach.
        if any(not inside(point, usb_dir) for node in nodes for point in mountpoints(node)):
            continue
        for node in nodes:
            if node.get("type") not in ("disk", "part"):
                continue
            if str(node.get("fstype") or "").lower() not in filesystems:
                continue
            if str(node.get("parttype") or "").lower() == EFI_SYSTEM_PARTITION:
                continue
            yield node


def device_path(node):
    return node.get("path") or f"/dev/{node.get('kname') or node.get('name')}"


def stick_name(node, taken):
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", str(node.get("label") or "").strip()).strip(".-_")[:48]
    base = label if STICK_NAME.match(label) else f"usb-{re.sub(r'[^A-Za-z0-9]', '', str(node.get('kname') or node.get('name') or 'stick'))}"
    name, number = base, 2
    while name in taken:
        name = f"{base}-{number}"
        number += 1
    return name


def mount_options(filesystem, uid, gid):
    options = ["nosuid", "nodev", "noexec", "noatime", f"uid={uid}", f"gid={gid}", "umask=0077", "iocharset=utf8"]
    if filesystem == "vfat":
        # Write data when a file is closed, so a saved file is on the stick right away.
        options.append("flush")
    return ",".join(options)


def remove_leftovers(usb_dir, mounts, run, messages, exists=os.path.exists):
    """Lazily unmounts sticks that were unplugged without eject and removes empty mount points."""
    for name, source in list(mounts.items()):
        if source and not exists(source):
            try:
                run(["umount", "--lazy", os.path.join(usb_dir, name)])
                del mounts[name]
            except CommandError as error:
                messages.append(f"{name} was unplugged but could not be detached: {error}")
    for entry in os.listdir(usb_dir):
        path = os.path.join(usb_dir, entry)
        if entry not in mounts and os.path.isdir(path) and not os.path.islink(path):
            try:
                os.rmdir(path)
            except OSError:
                pass


def mount_sticks(usb_dir, mounts, devices, uid, gid, filesystems, run, messages):
    in_use = set(mounts.values())
    taken = set(mounts) | set(os.listdir(usb_dir))
    for node in candidates(devices, usb_dir, filesystems):
        source = device_path(node)
        if source in in_use:
            continue
        name = stick_name(node, taken)
        taken.add(name)
        target = os.path.join(usb_dir, name)
        os.mkdir(target, 0o755)
        filesystem = str(node.get("fstype")).lower()
        try:
            run(["mount", "-t", filesystem, "-o", mount_options(filesystem, uid, gid), source, target])
        except CommandError as error:
            os.rmdir(target)
            messages.append(f"{node.get('label') or source} could not be mounted: {error}")


def eject(usb_dir, mounts, name, run):
    if not STICK_NAME.match(str(name or "")):
        raise HelperError("This USB stick name is not valid.")
    if name not in mounts:
        return f"{name} is no longer mounted. You can unplug it."
    target = os.path.join(usb_dir, name)
    run(["sync"])
    try:
        run(["umount", target])
    except CommandError as error:
        raise HelperError(f"{name} is still in use and was not removed: {error}") from error
    os.rmdir(target)
    return f"{name} was unmounted. You can unplug it."


def describe(mounts, devices):
    nodes = {device_path(node): node for disk in devices for node in descendants(disk)}
    sticks = []
    for name, source in sorted(mounts.items()):
        node = nodes.get(source, {})
        size = int(node.get("size") or 0)
        sticks.append({
            "name": name, "label": str(node.get("label") or name), "filesystem": str(node.get("fstype") or ""),
            **({"sizeBytes": size} if size else {}),
        })
    return sticks


def write_status(status_dir, status):
    descriptor, temporary = tempfile.mkstemp(dir=status_dir, prefix=".status-")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(status, handle)
        os.chmod(temporary, 0o644)
        os.replace(temporary, os.path.join(status_dir, "status.json"))
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def block_devices(run):
    return json.loads(run(["lsblk", "--json", "--bytes", "--output", LSBLK_COLUMNS])).get("blockdevices") or []


def process(root, uid, gid, filesystems, run=run_command, mountinfo_path="/proc/self/mountinfo", exists=os.path.exists):
    usb_dir = os.path.join(root, "usb")
    status_dir = os.path.join(root, "status")
    try:
        request = read_request(os.path.join(root, "requests", "request"), uid)
    except HelperError as error:
        print(error, file=sys.stderr)
        return 0
    if request is None:
        return 0
    def read_mounts():
        with open(mountinfo_path, encoding="utf-8") as handle:
            return owned_mounts(handle.read(), usb_dir)

    messages, failed = [], False
    try:
        mounts = read_mounts()
        remove_leftovers(usb_dir, mounts, run, messages, exists)
        action = request.get("action")
        if action == "scan":
            mount_sticks(usb_dir, mounts, block_devices(run), uid, gid, filesystems, run, messages)
        elif action == "eject":
            messages.append(eject(usb_dir, mounts, request.get("name"), run))
        else:
            raise HelperError("Unknown USB request.")
    except (HelperError, CommandError, OSError, ValueError) as error:
        failed = True
        messages.append(str(error))
    try:
        sticks = describe(read_mounts(), block_devices(run))
    except (CommandError, OSError, ValueError) as error:
        sticks, failed = [], True
        messages.append(f"The USB sticks could not be listed: {error}")
    status = {
        "version": 1, "requestId": request["id"],
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "sticks": sticks, "message": " ".join(messages), "error": failed,
    }
    write_status(status_dir, status)
    print(f"{request.get('action')}: {'failed' if failed else 'done'} {status['message']}".strip())
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    handle = commands.add_parser("process", help="Carry out the pending request of the console.")
    handle.add_argument("--root", default=DEFAULT_ROOT)
    handle.add_argument("--uid", type=int, required=True)
    handle.add_argument("--gid", type=int, required=True)
    handle.add_argument("--filesystems", default="vfat,exfat")
    arguments = parser.parse_args(argv)
    filesystems = {item.strip().lower() for item in arguments.filesystems.split(",") if item.strip()}
    return process(os.path.abspath(arguments.root), arguments.uid, arguments.gid, filesystems)


if __name__ == "__main__":
    sys.exit(main())
