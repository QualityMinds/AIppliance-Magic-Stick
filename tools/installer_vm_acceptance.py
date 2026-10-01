# SPDX-License-Identifier: BUSL-1.1
"""Boot a published Magic Stick USB image in a disposable UEFI/KVM VM.

The only media change is a test-only CIDATA answer file. The source image is
checksum-verified and never written. No generated credentials or raw guest logs
are included in the machine-readable report.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import time

import yaml


TARGET_SERIAL = "MAGICSTICK_CI_TARGET"
USERNAME = "ciinstaller"
REVISION = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
DEFAULT_OVMF_CODE = (
    "/usr/share/OVMF/OVMF_CODE_4M.fd",
    "/usr/share/OVMF/OVMF_CODE.fd",
)
DEFAULT_OVMF_VARS = (
    "/usr/share/OVMF/OVMF_VARS_4M.fd",
    "/usr/share/OVMF/OVMF_VARS.fd",
)


def command(*args, input_text=None, timeout=120):
    return subprocess.run(
        [str(arg) for arg in args], input=input_text, text=True,
        capture_output=True, check=True, timeout=timeout,
    ).stdout


def image_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cidata_offset(image):
    with image.open("rb") as stream:
        stream.seek(512)
        header = stream.read(512)
        if header[:8] != b"EFI PART":
            raise ValueError("USB image has no GPT")
        entries_lba = struct.unpack_from("<Q", header, 72)[0]
        count, entry_size = struct.unpack_from("<II", header, 80)
        if count < 3 or not 128 <= entry_size <= 4096:
            raise ValueError("Unexpected GPT layout")
        stream.seek(entries_lba * 512 + 2 * entry_size)
        entry = stream.read(entry_size)
        first, last = struct.unpack_from("<QQ", entry, 32)
        if not first or last < first or (last + 1) * 512 > image.stat().st_size:
            raise ValueError("CIDATA partition is outside the image")
        return first * 512


def ensure_public_template(raw_user_data, raw_meta_data):
    config = yaml.safe_load(raw_user_data)
    metadata = yaml.safe_load(raw_meta_data)
    if metadata != {"instance-id": "example-host-01", "local-hostname": "example-host-01"}:
        raise ValueError("Only the public placeholder installer media may be tested")
    if not isinstance(config, dict) or not isinstance(config.get("autoinstall"), dict):
        raise ValueError("Missing autoinstall configuration on CIDATA")
    autoinstall = config["autoinstall"]
    if autoinstall.get("version") != 1 or not isinstance(autoinstall.get("user-data"), dict):
        raise ValueError("Unexpected installer configuration")
    files = autoinstall["user-data"].get("write_files", [])
    repo = next((item.get("content", "") for item in files
                 if item.get("path") == "/etc/default/ai-appliance-repo"), "")
    if ("FLUX_BOOTSTRAP_MODE=readonly-public" not in repo
            or "MAGICSTICK_PUBLIC_REPO=https://github.com/QualityMinds/AIppliance-Magic-Stick.git" not in repo
            or "FLUX_GITHUB_TOKEN=" in repo):
        raise ValueError("CIDATA does not contain the token-free public bootstrap")
    if any(key in autoinstall for key in ("identity", "ssh", "storage", "network")):
        raise ValueError("Installer media already contain machine-specific answers")
    return config


def test_user_data(config, *, public_key, password_hash, revision):
    """Add only disposable VM answers; retain the installed package/host path."""
    if not REVISION.fullmatch(revision):
        raise ValueError("A full source commit is required")
    if not public_key.startswith("ssh-ed25519 ") or "\n" in public_key:
        raise ValueError("An ed25519 public key is required")
    if not password_hash.startswith("$6$") or "\n" in password_hash:
        raise ValueError("A SHA-512 crypt password hash is required")
    autoinstall = config["autoinstall"]
    autoinstall["interactive-sections"] = []
    autoinstall["shutdown"] = "poweroff"
    autoinstall["identity"] = {
        "hostname": "magicstick-ci", "username": USERNAME, "password": password_hash,
    }
    autoinstall["ssh"] = {
        "install-server": True, "authorized-keys": [public_key], "allow-pw": False,
    }
    autoinstall["storage"] = {
        "layout": {"name": "direct", "match": {"serial": f"*{TARGET_SERIAL}*"}},
    }
    autoinstall["network"] = {
        "version": 2, "ethernets": {"vm": {"match": {"name": "en*"}, "dhcp4": True}},
    }
    apt = autoinstall["apt"]
    if apt.get("fallback") != "abort":
        raise ValueError("The reduced installer must fail without an online mirror")
    apt["geoip"] = False
    apt["mirror-selection"]["primary"] = [
        {"uri": "http://archive.ubuntu.com/ubuntu", "arches": ["amd64"]},
    ]
    user_data = autoinstall["user-data"]
    files = user_data["write_files"]
    repo = next(item for item in files if item["path"] == "/etc/default/ai-appliance-repo")
    content = repo["content"]
    current_refs = [line for line in ("MAGICSTICK_PUBLIC_REF=main", "MAGICSTICK_PUBLIC_REF=develop")
                    if content.count(line) == 1]
    if len(current_refs) != 1 or content.count("MAGICSTICK_PUBLIC_REF_KIND=branch") != 1:
        raise ValueError("Unexpected public checkout metadata")
    content = content.replace(current_refs[0], f"MAGICSTICK_PUBLIC_REF={revision}", 1)
    content = content.replace("MAGICSTICK_PUBLIC_REF_KIND=branch", "MAGICSTICK_PUBLIC_REF_KIND=commit", 1)
    if f"MAGICSTICK_PUBLIC_REF={revision}" not in content or "MAGICSTICK_PUBLIC_REF_KIND=commit" not in content:
        raise ValueError("Unable to pin the first-boot source revision")
    repo["content"] = content
    files.append({
        "path": "/etc/sudoers.d/90-magicstick-vm-ci", "owner": "root:root",
        "permissions": "0440", "content": f"{USERNAME} ALL=(ALL) NOPASSWD:ALL\n",
    })
    return "#cloud-config\n" + yaml.safe_dump(config, sort_keys=False)


def choose_ovmf(candidates):
    return next((Path(path) for path in candidates if Path(path).is_file()), None)


def qemu_args(*, image, target, vars_file, code_file, ssh_port, setup_port,
              memory_mib, cpus, serial_log, installer):
    args = [
        "qemu-system-x86_64", "-machine", "q35,accel=kvm", "-cpu", "host",
        "-m", str(memory_mib), "-smp", str(cpus), "-display", "none",
        "-serial", f"file:{serial_log}", "-monitor", "none", "-no-reboot",
        "-drive", f"if=pflash,unit=0,format=raw,readonly=on,file={code_file}",
        "-drive", f"if=pflash,unit=1,format=raw,file={vars_file}",
        "-netdev", ("user,id=net0,hostfwd=tcp:127.0.0.1:"
                    f"{ssh_port}-:22,hostfwd=tcp:127.0.0.1:{setup_port}-:9443"),
        "-device", "virtio-net-pci,netdev=net0",
        "-drive", f"if=none,id=target,file={target},format=qcow2,cache=none",
        "-device", ("virtio-blk-pci,drive=target,"
                    f"serial={TARGET_SERIAL},bootindex={2 if installer else 1}"),
    ]
    if installer:
        args += [
            "-device", "qemu-xhci,id=xhci",
            "-drive", f"if=none,id=installer,file={image},format=raw,readonly=on",
            "-device", "usb-storage,drive=installer,bootindex=1",
        ]
    return args


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def ssh_args(work, port, *remote):
    return [
        "ssh", "-i", str(work / "ssh_key"), "-p", str(port),
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={work / 'known_hosts'}",
        "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
        f"{USERNAME}@127.0.0.1", *remote,
    ]


def wait_for_ssh(work, port, vm, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if vm.poll() is not None:
            raise RuntimeError("Target VM stopped before SSH became available")
        result = subprocess.run(ssh_args(work, port, "true"), capture_output=True,
                                text=True, timeout=20)
        if result.returncode == 0:
            return
        time.sleep(10)
    raise TimeoutError("Installed system did not offer SSH in time")


def wait_for_guest(work, port, vm, command_text, timeout, label):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if vm.poll() is not None:
            raise RuntimeError(f"Target VM stopped while waiting for {label}")
        result = subprocess.run(ssh_args(work, port, command_text), capture_output=True,
                                text=True, timeout=40)
        if result.returncode == 0:
            return result.stdout.strip()
        time.sleep(20)
    raise TimeoutError(f"Timed out waiting for {label}")


def terminate(vm):
    if vm is None or vm.poll() is not None:
        return
    vm.terminate()
    try:
        vm.wait(timeout=15)
    except subprocess.TimeoutExpired:
        vm.kill()
        vm.wait(timeout=15)


def report(work, value):
    (work / "report.json").write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def run(args):
    image = args.image.resolve(strict=True)
    if args.image.is_symlink() or not image.is_file() or not SHA256.fullmatch(args.expected_sha256):
        raise ValueError("A regular source image and exact SHA-256 are required")
    if not REVISION.fullmatch(args.source_revision):
        raise ValueError("A full source commit is required")
    if args.memory_mib < 16384 or args.cpus < 4 or args.disk_gb < 100:
        raise ValueError("VM requires at least 16 GiB RAM, four vCPUs and a 100 GiB target disk")
    if not Path("/dev/kvm").exists():
        raise RuntimeError("/dev/kvm is missing; use a nested-virtualization-capable Linux host")
    code_file = choose_ovmf(DEFAULT_OVMF_CODE)
    vars_template = choose_ovmf(DEFAULT_OVMF_VARS)
    if code_file is None or vars_template is None:
        raise RuntimeError("OVMF UEFI firmware is missing")
    for executable in ("qemu-system-x86_64", "qemu-img", "mtype", "mcopy", "openssl", "ssh-keygen", "ssh", "curl"):
        if shutil.which(executable) is None:
            raise RuntimeError(f"Required test-host tool missing: {executable}")
    if args.work.exists():
        raise ValueError("Work directory must not already exist")
    args.work.mkdir(mode=0o700, parents=True)
    work = args.work.resolve()
    status = {"schemaVersion": 1, "sourceRevision": args.source_revision,
              "sourceImageSha256": args.expected_sha256, "status": "running", "stages": []}
    report(work, status)
    vm = None
    try:
        print("[media] verifying the immutable source image", flush=True)
        if image_digest(image) != args.expected_sha256:
            raise ValueError("Installer image SHA-256 does not match the published asset")
        prepared = work / "installer-test.img"
        shutil.copyfile(image, prepared)
        offset = cidata_offset(prepared)
        current = command("mtype", "-i", f"{prepared}@@{offset}", "::user-data")
        metadata = command("mtype", "-i", f"{prepared}@@{offset}", "::meta-data")
        config = ensure_public_template(current, metadata)
        key = work / "ssh_key"
        command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key)
        public_key = key.with_suffix(".pub").read_text().strip()
        password = secrets.token_urlsafe(32)
        password_hash = command("openssl", "passwd", "-6", "-stdin", input_text=password + "\n").strip()
        del password
        seed = work / "user-data"
        seed.write_text(test_user_data(config, public_key=public_key,
                                       password_hash=password_hash,
                                       revision=args.source_revision))
        (work / "meta-data").write_text(
            f"instance-id: magicstick-ci-{secrets.token_hex(8)}\nlocal-hostname: magicstick-ci\n")
        command("mcopy", "-o", "-i", f"{prepared}@@{offset}", seed, "::user-data")
        command("mcopy", "-o", "-i", f"{prepared}@@{offset}", work / "meta-data", "::meta-data")
        if command("mtype", "-i", f"{prepared}@@{offset}", "::user-data") != seed.read_text():
            raise RuntimeError("Test CIDATA answer file was not written correctly")
        if command("mtype", "-i", f"{prepared}@@{offset}", "::meta-data") != (work / "meta-data").read_text():
            raise RuntimeError("Test CIDATA metadata were not written correctly")
        status["stages"].append("source image verified; test CIDATA prepared")
        report(work, status)
        target = work / "target.qcow2"
        command("qemu-img", "create", "-f", "qcow2", target, f"{args.disk_gb}G")
        vars_file = work / "OVMF_VARS.fd"
        shutil.copyfile(vars_template, vars_file)
        ssh_port, setup_port = free_port(), free_port()
        if ssh_port == setup_port:
            setup_port = free_port()
        base = dict(image=prepared, target=target, vars_file=vars_file,
                    code_file=code_file, ssh_port=ssh_port, setup_port=setup_port,
                    memory_mib=args.memory_mib, cpus=args.cpus)
        print("[install] booting the USB image under UEFI", flush=True)
        with (work / "qemu-install.err").open("w") as errors:
            vm = subprocess.Popen(qemu_args(**base, serial_log=work / "install-serial.log", installer=True),
                                  stdout=subprocess.DEVNULL, stderr=errors)
            try:
                vm.wait(timeout=args.install_timeout)
            except subprocess.TimeoutExpired as exc:
                raise TimeoutError("Installer did not power off in time") from exc
        if vm.returncode != 0:
            raise RuntimeError(f"Installer VM exited with status {vm.returncode}")
        vm = None
        status["stages"].append("installer powered off")
        report(work, status)
        print("[first boot] starting installed target without the USB image", flush=True)
        with (work / "qemu-first-boot.err").open("w") as errors:
            vm = subprocess.Popen(qemu_args(**base, serial_log=work / "first-boot-serial.log", installer=False),
                                  stdout=subprocess.DEVNULL, stderr=errors)
        wait_for_ssh(work, ssh_port, vm, args.boot_timeout)
        status["stages"].append("installed target booted and SSH is ready")
        report(work, status)
        print("[bootstrap] waiting for cloud-init and host convergence", flush=True)
        command(*ssh_args(work, ssh_port, "sudo cloud-init status --wait"), timeout=args.bootstrap_timeout)
        os_release = command(*ssh_args(work, ssh_port, "grep '^VERSION_ID=' /etc/os-release"), timeout=30).strip()
        if os_release != 'VERSION_ID="26.04"' and os_release != "VERSION_ID=26.04":
            raise RuntimeError("Installed system is not Ubuntu 26.04")
        command(*ssh_args(work, ssh_port, "sudo systemctl is-active --quiet k3s"), timeout=30)
        status["stages"].append("cloud-init complete; Ubuntu 26.04 and K3s active")
        report(work, status)
        print("[platform] waiting for Node, Flux and first-run setup", flush=True)
        wait_for_guest(work, ssh_port, vm,
                       "sudo k3s kubectl wait node --all --for=condition=Ready --timeout=15s",
                       args.platform_timeout, "Kubernetes Node Ready")
        wait_for_guest(work, ssh_port, vm,
                       "sudo k3s kubectl -n flux-system wait kustomization/first-run-bootstrap --for=condition=Ready --timeout=15s",
                       args.platform_timeout, "first-run Flux bootstrap")
        wait_for_guest(work, ssh_port, vm,
                       "test \"$(sudo k3s kubectl -n identity-system get appliancesetup local -o jsonpath='{.status.phase}')\" = Pending",
                       args.platform_timeout, "ApplianceSetup Pending")
        status["stages"].append("Node Ready; first-run Flux ready; setup Pending")
        report(work, status)
        url = f"https://magicstick.local:{setup_port}/setup"
        deadline = time.monotonic() + args.platform_timeout
        while time.monotonic() < deadline:
            if vm.poll() is not None:
                raise RuntimeError("Target VM stopped before setup page was available")
            check = subprocess.run([
                "curl", "--insecure", "--noproxy", "*", "--silent", "--show-error", "--output", "/dev/null",
                "--write-out", "%{http_code}", "--connect-timeout", "5", "--max-time", "15",
                "--resolve", f"magicstick.local:{setup_port}:127.0.0.1", url,
            ], capture_output=True, text=True, timeout=20)
            if check.returncode == 0 and check.stdout in {"200", "301", "302"}:
                break
            time.sleep(20)
        else:
            raise TimeoutError("Private first-run setup page did not become available")
        status["stages"].append("private first-run setup page reachable")
        status["status"] = "passed"
        report(work, status)
        print("[pass] USB installation and first-run readiness verified", flush=True)
    except Exception as exc:
        status["status"] = "failed"
        status["failure"] = str(exc).splitlines()[0][:240]
        report(work, status)
        raise
    finally:
        terminate(vm)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--memory-mib", type=int, default=16384)
    parser.add_argument("--cpus", type=int, default=4)
    parser.add_argument("--disk-gb", type=int, default=100)
    parser.add_argument("--install-timeout", type=int, default=7200)
    parser.add_argument("--boot-timeout", type=int, default=900)
    parser.add_argument("--bootstrap-timeout", type=int, default=7200)
    parser.add_argument("--platform-timeout", type=int, default=1200)
    args = parser.parse_args()
    try:
        run(args)
    except Exception as exc:
        print(f"[fail] {str(exc).splitlines()[0][:240]}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
