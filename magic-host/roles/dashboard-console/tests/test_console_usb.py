import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

HELPER = pathlib.Path(__file__).resolve().parents[1] / "files" / "console-usb.py"
spec = importlib.util.spec_from_file_location("console_usb", HELPER)
console_usb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(console_usb)

ESP = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"


def devices(usb_dir):
    """A system disk, USB sticks and USB disks that must stay untouched (synthetic lsblk output)."""
    return [
        {"name": "nvme0n1", "type": "disk", "tran": "nvme", "children": [
            {"name": "nvme0n1p1", "path": "/dev/nvme0n1p1", "type": "part", "fstype": "vfat", "parttype": ESP, "mountpoints": ["/boot/efi"]},
            {"name": "nvme0n1p2", "path": "/dev/nvme0n1p2", "type": "part", "fstype": "ext4", "mountpoints": ["/"]},
        ]},
        {"name": "sdb", "type": "disk", "tran": "usb", "size": 8000000000, "children": [
            {"name": "sdb1", "kname": "sdb1", "path": "/dev/sdb1", "type": "part", "fstype": "vfat", "label": "BACKUP KEY", "size": 7999000000, "mountpoints": [None]},
        ]},
        # A whole-disk exFAT stick without a partition table.
        {"name": "sdc", "kname": "sdc", "path": "/dev/sdc", "type": "disk", "tran": "usb", "fstype": "exfat", "label": "", "size": 64000000000, "mountpoints": [None]},
        # A USB system disk: its root filesystem is mounted through LVM, so even its FAT ESP stays out of reach.
        {"name": "sdd", "type": "disk", "tran": "usb", "children": [
            {"name": "sdd1", "path": "/dev/sdd1", "type": "part", "fstype": "vfat", "label": "EFI", "mountpoints": [None]},
            {"name": "sdd2", "path": "/dev/sdd2", "type": "part", "fstype": "LVM2_member", "children": [
                {"name": "vg-root", "path": "/dev/mapper/vg-root", "type": "lvm", "fstype": "ext4", "mountpoints": ["/"]},
            ]},
        ]},
        # USB disk with active swap, and one with an unmounted EFI partition and NTFS.
        {"name": "sde", "type": "disk", "tran": "usb", "children": [
            {"name": "sde1", "path": "/dev/sde1", "type": "part", "fstype": "vfat", "mountpoints": [None]},
            {"name": "sde2", "path": "/dev/sde2", "type": "part", "fstype": "swap", "mountpoints": ["[SWAP]"]},
        ]},
        {"name": "sdf", "type": "disk", "tran": "usb", "children": [
            {"name": "sdf1", "path": "/dev/sdf1", "type": "part", "fstype": "vfat", "parttype": ESP.upper(), "mountpoints": [None]},
            {"name": "sdf2", "path": "/dev/sdf2", "type": "part", "fstype": "ntfs", "mountpoints": [None]},
        ]},
        # A SATA disk is never offered, even with FAT.
        {"name": "sdg", "type": "disk", "tran": "sata", "children": [
            {"name": "sdg1", "path": "/dev/sdg1", "type": "part", "fstype": "vfat", "mountpoints": [None]},
        ]},
    ]


class FakeHost:
    """Records commands and keeps a mount table like /proc/self/mountinfo."""

    def __init__(self, root, busy=()):
        self.usb_dir = os.path.join(root, "usb")
        self.mountinfo = os.path.join(root, "mountinfo")
        self.commands = []
        self.busy = set(busy)
        self.mounts = {}
        self.write()

    def write(self):
        lines = ["22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw"]
        lines += [f"{100 + index} 22 8:17 / {point.replace(' ', chr(92) + '040')} rw,nosuid - vfat {source} rw" for index, (point, source) in enumerate(self.mounts.items())]
        pathlib.Path(self.mountinfo).write_text("\n".join(lines) + "\n", encoding="utf-8")

    def run(self, argv):
        self.commands.append(argv)
        if argv[0] == "lsblk":
            tree = devices(self.usb_dir)
            for disk in tree:
                for node in console_usb.descendants(disk):
                    for point, source in self.mounts.items():
                        if node.get("path") == source:
                            node["mountpoints"] = [point]
            return json.dumps({"blockdevices": tree})
        if argv[0] == "mount":
            self.mounts[argv[-1]] = argv[-2]
        if argv[0] == "umount":
            if argv[-1] in self.busy:
                raise console_usb.CommandError("target is busy")
            self.mounts.pop(argv[-1], None)
        self.write()
        return ""


class ConsoleUsbTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name
        for name in ("requests", "status", "usb"):
            os.mkdir(os.path.join(self.root, name))
        self.uid, self.gid = os.getuid(), os.getgid()

    def tearDown(self):
        self.directory.cleanup()

    def request(self, **values):
        pathlib.Path(self.root, "requests", "request").write_text(json.dumps({"version": 1, "id": "request-0001", **values}), encoding="utf-8")

    def process(self, host, exists=lambda path: True):
        return console_usb.process(self.root, self.uid, self.gid, {"vfat", "exfat"}, run=host.run, mountinfo_path=host.mountinfo, exists=exists)

    def status(self):
        return json.loads(pathlib.Path(self.root, "status", "status.json").read_text(encoding="utf-8"))

    def test_offers_only_fat_and_exfat_usb_filesystems_on_disks_that_are_otherwise_unused(self):
        usb_dir = os.path.join(self.root, "usb")
        offered = [node["name"] for node in console_usb.candidates(devices(usb_dir), usb_dir, {"vfat", "exfat"})]
        self.assertEqual(offered, ["sdb1", "sdc"])

    def test_scan_mounts_sticks_privately_without_programs_or_devices(self):
        host = FakeHost(self.root)
        self.request(action="scan")
        self.assertEqual(self.process(host), 0)
        # The request is consumed, so a repeated trigger does nothing.
        self.assertFalse(os.path.exists(os.path.join(self.root, "requests", "request")))
        mounts = [command for command in host.commands if command[0] == "mount"]
        self.assertEqual([command[-2:] for command in mounts], [
            ["/dev/sdb1", os.path.join(self.root, "usb", "BACKUP-KEY")],
            ["/dev/sdc", os.path.join(self.root, "usb", "usb-sdc")],
        ])
        vfat_options = mounts[0][4].split(",")
        for option in ("nosuid", "nodev", "noexec", f"uid={self.uid}", f"gid={self.gid}", "umask=0077", "flush"):
            self.assertIn(option, vfat_options)
        self.assertEqual(mounts[1][2], "exfat")
        self.assertNotIn("flush", mounts[1][4])
        status = self.status()
        self.assertEqual(status["requestId"], "request-0001")
        self.assertIs(status["error"], False)
        self.assertEqual([stick["name"] for stick in status["sticks"]], ["BACKUP-KEY", "usb-sdc"])
        self.assertEqual(status["sticks"][0], {"name": "BACKUP-KEY", "label": "BACKUP KEY", "filesystem": "vfat", "sizeBytes": 7999000000})
        self.assertEqual(oct(os.stat(os.path.join(self.root, "status", "status.json")).st_mode & 0o777), "0o644")
        # A second scan keeps existing mounts and mounts nothing twice.
        host.commands.clear()
        self.request(action="scan")
        self.process(host)
        self.assertEqual([command for command in host.commands if command[0] == "mount"], [])

    def test_eject_flushes_and_unmounts_only_its_own_sticks(self):
        host = FakeHost(self.root)
        self.request(action="scan")
        self.process(host)
        host.commands.clear()
        self.request(action="eject", name="BACKUP-KEY")
        self.process(host)
        self.assertEqual(host.commands[:2], [["sync"], ["umount", os.path.join(self.root, "usb", "BACKUP-KEY")]])
        self.assertFalse(os.path.exists(os.path.join(self.root, "usb", "BACKUP-KEY")))
        status = self.status()
        self.assertIs(status["error"], False)
        self.assertIn("You can unplug it", status["message"])
        self.assertEqual([stick["name"] for stick in status["sticks"]], ["usb-sdc"])
        # Names outside the console's mounts are rejected before any command runs.
        host.commands.clear()
        self.request(action="eject", name="../../etc")
        self.process(host)
        self.assertIs(self.status()["error"], True)
        self.assertNotIn(["sync"], host.commands)

    def test_a_stick_in_use_stays_mounted_and_the_error_is_reported(self):
        target = os.path.join(self.root, "usb", "BACKUP-KEY")
        host = FakeHost(self.root, busy=[target])
        self.request(action="scan")
        self.process(host)
        self.request(action="eject", name="BACKUP-KEY")
        self.process(host)
        status = self.status()
        self.assertIs(status["error"], True)
        self.assertIn("still in use", status["message"])
        self.assertTrue(os.path.isdir(target))

    def test_unplugged_sticks_are_detached_on_the_next_request(self):
        host = FakeHost(self.root)
        self.request(action="scan")
        self.process(host)
        os.mkdir(os.path.join(self.root, "usb", "stale-empty"))
        host.commands.clear()
        self.request(action="scan")
        self.process(host, exists=lambda path: path != "/dev/sdb1")
        self.assertIn(["umount", "--lazy", os.path.join(self.root, "usb", "BACKUP-KEY")], host.commands)
        self.assertFalse(os.path.exists(os.path.join(self.root, "usb", "stale-empty")))

    def test_requests_from_other_users_or_malformed_requests_get_no_answer(self):
        host = FakeHost(self.root)
        self.request(action="scan")
        console_usb.process(self.root, self.uid + 1, self.gid, {"vfat"}, run=host.run, mountinfo_path=host.mountinfo)
        self.assertEqual(host.commands, [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "status", "status.json")))
        pathlib.Path(self.root, "requests", "request").write_text("{not json", encoding="utf-8")
        self.process(host)
        self.assertEqual(host.commands, [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "status", "status.json")))
        # Without a request the triggered service does nothing.
        self.assertEqual(self.process(host), 0)
        self.request(action="format")
        self.process(host)
        self.assertIs(self.status()["error"], True)
        self.assertNotIn("mount", [command[0] for command in host.commands])


if __name__ == "__main__":
    unittest.main()
