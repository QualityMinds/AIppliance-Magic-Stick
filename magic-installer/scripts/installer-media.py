#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""Inspect installer media and reduce or remove its offline package pool.

The signed local metadata is retained byte-for-byte. Reduced mode disables its
restricted component; online mode disables the entire file:///cdrom source.
The online Ubuntu sources are not changed.
Run preparation under fakeroot to preserve SquashFS ownership and xattrs without
requiring a privileged container. No host devices are opened by this helper.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys

import yaml


GIB = 1024 ** 3
MIB = 1024 ** 2
SOURCE_FILE = "etc/apt/sources.list.d/cdrom.sources"
BASE_IMAGE = "casper/ubuntu-server-minimal.squashfs"
REMOVED_PREFIX = "pool/restricted/"


def removed_pool_file(name, mode):
    return ((mode == "reduced" and name.startswith(REMOVED_PREFIX))
            or (mode == "online" and name.startswith("pool/")))


def run(*args, capture=False):
    return subprocess.run(
        [str(arg) for arg in args], check=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    ).stdout


def hashes(path):
    sha = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(MIB), b""):
            sha.update(data)
            md5.update(data)
    return {"sha256": sha.hexdigest(), "md5": md5.hexdigest()}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def control_records(text):
    """Read Deb822 paragraphs, including embedded Signed-By armor."""
    records = []
    record = {}
    key = None
    for line in text.splitlines() + [""]:
        if not line:
            if record:
                records.append(record)
                record = {}
            key = None
        elif line[0].isspace() and key:
            record[key] += "\n" + line[1:]
        elif line.startswith("#"):
            continue
        elif ":" in line:
            key, value = line.split(":", 1)
            if key in record:
                raise ValueError(f"Duplicate repository field: {key}")
            record[key] = value.strip()
        else:
            raise ValueError(f"Invalid repository metadata line: {line[:80]}")
    return records


def safe_media_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\n" in value or "\\" in value:
        raise ValueError("Unsafe path in installer metadata")
    return path.as_posix()


def inventory(media):
    files = {}
    for path in sorted(media.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(media).as_posix()
        files[relative] = {"bytes": path.stat().st_size, **hashes(path)}
    packages = []
    seen = set()
    for index in sorted((media / "dists").glob("*/**/Packages")):
        for record in control_records(index.read_text()):
            filename = safe_media_path(record["Filename"])
            if not filename.startswith("pool/"):
                raise ValueError(f"Package outside pool: {filename}")
            if filename in seen:
                continue
            seen.add(filename)
            actual = files.get(filename)
            if not actual or actual["bytes"] != int(record["Size"]) or actual["sha256"] != record["SHA256"]:
                raise ValueError(f"ISO package does not match its index: {filename}")
            packages.append({
                "name": record["Package"], "version": record["Version"],
                "architecture": record["Architecture"], "path": filename,
                "bytes": actual["bytes"], "sha256": actual["sha256"],
                "depends": record.get("Pre-Depends", "") + "," + record.get("Depends", ""),
                "provides": record.get("Provides", ""),
            })
    disk_packages = {name for name in files if name.startswith("pool/") and name.endswith(".deb")}
    if disk_packages != seen:
        raise ValueError("The ISO contains unindexed packages; review this media before reducing it")
    return {"files": files, "packages": packages, "sizes": summarize(files, packages)}


def summarize(files, packages):
    groups = {name: 0 for name in ("pool", "dists", "casper", "other")}
    for name, info in files.items():
        group = name.split("/", 1)[0]
        groups[group if group in groups else "other"] += info["bytes"]
    return {**groups, "poolPackageCount": len(packages)}


def configure_local_source(text, mode):
    records = control_records(text)
    if len(records) != 1:
        raise ValueError("Expected exactly one local CD-ROM source")
    source = records[0]
    if (source.get("Types") != "deb" or source.get("URIs") != "file:///cdrom"
            or source.get("Components") != "main restricted"
            or "Enabled" in source
            or not source.get("Signed-By", "").lstrip().startswith("-----BEGIN PGP PUBLIC KEY BLOCK-----")):
        raise ValueError("Unsupported ISO APT source; refusing an unreviewed trust/layout change")
    if mode == "online":
        # Retain the file: Subiquity 26.04 creates a new, enabled CD-ROM source
        # when it is absent. APT's standard Enabled field disables the stanza.
        return "Enabled: no\n" + text, source
    if mode != "reduced":
        raise ValueError("Only reduced or online media modifies the local source")
    patched, count = re.subn(r"(?m)^Components: main restricted$", "Components: main", text)
    if count != 1:
        raise ValueError("Could not restrict the local CD-ROM source to main")
    return patched, source


def verify_repository(media, source, work):
    suite = safe_media_path(source["Suites"])
    if "/" in suite or not re.fullmatch(r"[a-z][a-z0-9-]*", suite):
        raise ValueError("Unsupported ISO suite")
    release_dir = media / "dists" / suite
    # The key is already anchored by the caller's verified original ISO SHA256.
    armor = source["Signed-By"]
    encoded = "".join(line for line in armor.splitlines()
                      if line and line != "." and not line.startswith(("-----", "=")))
    keyring = work / "iso-signing-key.gpg"
    keyring.write_bytes(base64.b64decode(encoded, validate=True))
    run("gpgv", "--keyring", keyring, release_dir / "Release.gpg", release_dir / "Release")
    release = control_records((release_dir / "Release").read_text())[0]
    for line in release["SHA256"].splitlines():
        if not line.strip():
            continue
        digest, size, relative = line.split()
        target = release_dir / safe_media_path(relative)
        if target.stat().st_size != int(size) or hashes(target)["sha256"] != digest:
            raise ValueError(f"Invalid signed repository index: {relative}")


def dependency_names(value):
    return {match.group(1) for match in re.finditer(r"(?:^|[,|])\s*([a-z0-9][a-z0-9+.-]*)", value)}


def validate_selection(before, media, template, mode="reduced"):
    removed = [pkg for pkg in before["packages"] if removed_pool_file(pkg["path"], mode)]
    if not removed:
        raise ValueError("No matching offline pool found")
    config = yaml.safe_load(template.read_text())["autoinstall"]
    if config.get("apt", {}).get("fallback") != "abort":
        raise ValueError("Reduced/online media requires apt.fallback: abort and an online installation")
    if mode == "online":
        # Nothing remains in the local pool. Dependencies and requested packages
        # must be resolved against the chosen online mirror, not ISO versions.
        # Removing an archive is not removing an already installed rootfs package.
        return removed
    removed_names = {pkg["name"] for pkg in removed}
    removed_providers = removed_names | set().union(*(dependency_names(pkg["provides"]) for pkg in removed))
    # Keep all of main, not a guessed list of kernel/GRUB/SSH dependencies.
    for pkg in before["packages"]:
        if not pkg["path"].startswith(REMOVED_PREFIX):
            for group in pkg["depends"].split(","):
                names = dependency_names(group)
                if names and names.issubset(removed_providers):
                    raise ValueError(f"Retained package requires restricted pool: {pkg['name']}")
    installed = set()
    for manifest in (media / "casper").glob("*.manifest"):
        for line in manifest.read_text().splitlines():
            if line and not line.startswith("-"):
                installed.add(line.split()[0].lstrip("+").split(":", 1)[0])
    if removed_names & installed:
        raise ValueError("A restricted pool package is part of an installed ISO filesystem")
    interactive = set(config.get("interactive-sections", []))
    if interactive & {"*", "drivers", "packages", "oem"}:
        raise ValueError("Use full media for interactive third-party driver/package selection")
    if config.get("drivers", {}).get("install", False) or config.get("oem", {}).get("install") is True:
        raise ValueError("Use full media for automatic third-party/OEM driver installation")
    for requested in config.get("packages", []):
        if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?(?:=[^\s]+)?", requested):
            raise ValueError("Use full media for task or complex package selections")
        if requested.split("=", 1)[0].split(":", 1)[0] in removed_names:
            raise ValueError("An explicitly requested package is in the restricted pool")
    return removed


def filesystem_manifest(root):
    """Logical content/metadata, independent of SquashFS inode/block ordering."""
    result = {}
    for path in [root, *sorted(root.rglob("*"))]:
        st = path.lstat()
        item = {"mode": st.st_mode, "uid": st.st_uid, "gid": st.st_gid,
                "mtime": int(st.st_mtime), "rdev": st.st_rdev,
                "xattrs": {key: os.getxattr(path, key, follow_symlinks=False).hex()
                           for key in os.listxattr(path, follow_symlinks=False)}}
        if stat.S_ISREG(st.st_mode):
            item.update({"bytes": st.st_size, "sha256": hashes(path)["sha256"], "links": st.st_nlink})
        elif stat.S_ISLNK(st.st_mode):
            item["target"] = os.readlink(path)
        result[path.relative_to(root).as_posix()] = item
    return result


def patch_squashfs(media, replacements, work, new_source):
    source = media / BASE_IMAGE
    description = run("unsquashfs", "-s", source, capture=True).decode()
    if "Compression xz\n" not in description or "Block size 131072\n" not in description:
        raise ValueError("Unreviewed SquashFS compression; use full media")
    root = work / "rootfs"
    run("unsquashfs", "-no-progress", "-strict-errors", "-processors", "2", "-d", root, source)
    before = filesystem_manifest(root)
    target = root / SOURCE_FILE
    original_stat = target.stat()
    target.write_text(new_source)
    os.utime(target, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    output = replacements / BASE_IMAGE
    output.parent.mkdir(parents=True, exist_ok=True)
    timestamp = run("unsquashfs", "-mkfs-time", source, capture=True).decode().strip()
    # Match the original codec and block size, rather than changing compression
    # to claim additional savings. Preserve uid/gid, links, devices and xattrs.
    run("mksquashfs", root, output, "-noappend", "-no-progress", "-exit-on-error",
        "-comp", "xz", "-b", "131072", "-processors", "2", "-mem", "512M",
        "-mkfs-time", timestamp)
    verified_root = work / "verified-rootfs"
    run("unsquashfs", "-no-progress", "-strict-errors", "-processors", "2", "-d", verified_root, output)
    after = filesystem_manifest(verified_root)
    changed = [name for name in before.keys() | after.keys() if before.get(name) != after.get(name)]
    if changed != [SOURCE_FILE]:
        raise ValueError(f"Unexpected filesystem changes: {changed[:20]}")
    if (verified_root / SOURCE_FILE).read_text() != new_source:
        raise ValueError("The replacement CD-ROM source was not preserved")
    return {"image": BASE_IMAGE, "changedFiles": changed, "verifiedEntries": len(before),
            "sourceSha256": hashes(source)["sha256"], "resultSha256": hashes(output)["sha256"]}


def prepare(args):
    media = args.work / "media"
    replacements = args.work / "replacements"
    replacements.mkdir(parents=True)
    run("xorriso", "-report_about", "SORRY", "-osirrox", "on", "-indev", args.iso,
        "-extract", "/", media)
    before = inventory(media)
    before["iso"] = {"bytes": args.iso.stat().st_size, "sha256": hashes(args.iso)["sha256"]}
    write_json(args.work / "pool-before.json", before)
    report = {"mode": args.mode, "removedPackages": [], "filesystemChanges": [],
              "policy": "Full offline pool retained", "installationTested": False}
    if args.mode in ("reduced", "online"):
        current = run("unsquashfs", "-cat", media / BASE_IMAGE, SOURCE_FILE, capture=True).decode()
        new_source, source = configure_local_source(current, args.mode)
        # A later layer must not re-enable a source after the base is patched.
        for layer in (media / "casper").glob("*.squashfs"):
            if layer == media / BASE_IMAGE:
                continue
            listing = run("unsquashfs", "-l", layer, capture=True).decode()
            if "squashfs-root/" + SOURCE_FILE in listing.splitlines():
                raise ValueError("An upper SquashFS layer overrides the CD-ROM source")
        verify_repository(media, source, args.work)
        report["removedPackages"] = validate_selection(before, media, args.template, args.mode)
        report["filesystemChanges"] = [patch_squashfs(media, replacements, args.work, new_source)]
        report["policy"] = (
            "Remove the entire pool. Retain original signed indices as inactive metadata. "
            "Disable local cdrom.sources with Enabled: no; remote sources unchanged. "
            "All additional packages require an online mirror. Installed rootfs packages, "
            "live kernel and firmware are unchanged; old ISO archive versions are not pinned."
        ) if args.mode == "online" else (
            "Retain every main package and original signed index. Remove only pool/restricted; "
            "change only local cdrom.sources Components to main. Remote sources unchanged. "
            "The unchanged restricted index is inactive. Old optional driver versions are not "
            "promised online; third-party/OEM installs require full media."
        )
    write_json(args.work / "preparation.json", report)


def metadata(args):
    before = json.loads((args.work / "pool-before.json").read_text())
    report = json.loads((args.work / "preparation.json").read_text())
    files = {name: info.copy() for name, info in before["files"].items()
             if not removed_pool_file(name, report["mode"])}
    for path in (args.work / "replacements").rglob("*"):
        if path.is_file():
            files[path.relative_to(args.work / "replacements").as_posix()] = {
                "bytes": path.stat().st_size, **hashes(path)}
    # Preserve upstream's exclusions (e.g. the boot catalog / El Torito image,
    # which xorriso can regenerate); update every remaining checked file.
    entries = []
    for line in (args.work / "media/md5sum.txt").read_text().splitlines():
        _, relative = line.split(None, 1)
        name = safe_media_path(relative.removeprefix("./"))
        if removed_pool_file(name, report["mode"]):
            continue
        if name not in files:
            raise ValueError(f"Missing media integrity entry: {name}")
        entries.append(f"{files[name]['md5']}  ./{name}\n")
    checksum_path = args.work / "replacements/md5sum.txt"
    checksum_path.write_text("".join(entries))
    files["md5sum.txt"] = {"bytes": checksum_path.stat().st_size, **hashes(checksum_path)}
    packages = [pkg for pkg in before["packages"] if pkg["path"] in files]
    after = {"files": files, "packages": packages, "sizes": summarize(files, packages)}
    write_json(args.work / "pool-after.json", after)


def size_metrics(size):
    return {"bytes": size, "MiB": size / MIB, "GiB": size / GIB,
            "under2GiB": size < 2 * GIB, "bytesBelow2GiB": 2 * GIB - size}


def finish(args):
    report = json.loads((args.work / "preparation.json").read_text())
    before = json.loads((args.work / "pool-before.json").read_text())
    after = json.loads((args.work / "pool-after.json").read_text())
    report["sourceIso"] = before["iso"]
    report["image"] = {**size_metrics(args.image.stat().st_size), **hashes(args.image)}
    report["poolBefore"] = before["sizes"]
    report["poolAfter"] = after["sizes"]
    output = Path(str(args.image) + ".report")
    output.mkdir()
    write_json(output / "size-report.json", report)
    write_json(output / "pool-before.json", before)
    write_json(output / "pool-after.json", after)
    Path(str(args.image) + ".sha256").write_text(f"{report['image']['sha256']}  {args.image.name}\n")
    print(f"Image: {report['image']['MiB']:.2f} MiB; below 2 GiB: {report['image']['under2GiB']}")
    print(f"Offline pool: {before['sizes']['pool'] / MIB:.2f} -> {after['sizes']['pool'] / MIB:.2f} MiB")
    print(f"Report: {output}/size-report.json")


def cidata_offset(image, partition=3):
    with image.open("rb") as stream:
        stream.seek(512)
        header = stream.read(512)
        if header[:8] != b"EFI PART":
            raise ValueError("USB image has no GPT")
        entries_lba = struct.unpack_from("<Q", header, 72)[0]
        count, entry_size = struct.unpack_from("<II", header, 80)
        if partition < 1 or count < partition or entry_size < 128 or entry_size > 4096:
            raise ValueError("Unexpected GPT layout")
        stream.seek(entries_lba * 512 + (partition - 1) * entry_size)
        entry = stream.read(entry_size)
        first, last = struct.unpack_from("<QQ", entry, 32)
        if not first or last < first or (last + 1) * 512 > image.stat().st_size:
            raise ValueError("CIDATA partition is outside the image")
        return first * 512


def verify_public_bootstrap(config, metadata, channel):
    """Fail closed before publishing media containing deployment-specific metadata."""
    if channel not in {"main", "develop"}:
        raise ValueError("Public installer channel must be main or develop")
    if metadata != {"instance-id": "example-host-01", "local-hostname": "example-host-01"}:
        raise ValueError("Public CI images require placeholder host metadata")
    if any(key in config for key in ("identity", "ssh", "proxy")):
        raise ValueError("Public CI images must not contain preset identities, SSH access or proxies")
    user = config.get("user-data", {})
    if set(user) != {"manage_etc_hosts", "write_files", "runcmd"}:
        raise ValueError("Unexpected public CI cloud-init configuration")
    files = user.get("write_files", [])
    if len(files) != 1 or files[0].get("path") != "/etc/default/ai-appliance-repo":
        raise ValueError("Unexpected files in public CI bootstrap metadata")
    expected = {
        "FLUX_BOOTSTRAP_MODE": "readonly-public",
        "MAGICSTICK_PUBLIC_REPO": "https://github.com/QualityMinds/AIppliance-Magic-Stick.git",
        "MAGICSTICK_PUBLIC_REF": channel,
        "MAGICSTICK_PUBLIC_REF_KIND": "branch",
        "FLUX_PUBLIC_SYNC_PATH": "magic-cluster/flux/entrypoints/single-node",
        "AI_APPLIANCE_DOMAIN": "magicstick.example.com",
        "AI_APPLIANCE_DASHBOARD_HOST": "magicstick.example.com",
        "AI_APPLIANCE_MDNS_DOMAIN": "magicstick.local",
        "AI_APPLIANCE_MDNS_NAME": "magicstick",
        "AI_APPLIANCE_DASHBOARD_MDNS_NAME": "magicstick",
        "AI_APPLIANCE_ENVOY_CRDS_POLICY": "CreateReplace",
    }
    actual = {}
    for line in files[0].get("content", "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key in actual:
            raise ValueError("Invalid public bootstrap setting")
        actual[key] = value
    if actual != expected:
        raise ValueError("Public installer contains non-default, private or incorrect channel settings")


def verify(args):
    report_dir = Path(str(args.image) + ".report")
    before = json.loads((report_dir / "pool-before.json").read_text())
    expected = json.loads((report_dir / "pool-after.json").read_text())
    report = json.loads((report_dir / "size-report.json").read_text())
    if hashes(args.image)["sha256"] != report["image"]["sha256"]:
        raise ValueError("USB image does not match its build report")
    extracted = args.work / "verified-media"
    run("xorriso", "-report_about", "SORRY", "-osirrox", "on", "-indev", args.image,
        "-extract", "/", extracted)
    checked = 0
    for line in (extracted / "md5sum.txt").read_text().splitlines():
        md5, relative = line.split(None, 1)
        name = safe_media_path(relative.removeprefix("./"))
        actual = hashes(extracted / name)
        if actual["md5"] != md5 or actual["sha256"] != expected["files"][name]["sha256"]:
            raise ValueError(f"Final media integrity failure: {name}")
        checked += 1
    protected = {name: info for name, info in before["files"].items()
                 if name.startswith(("casper/", "EFI/", "dists/"))
                 and not (report["mode"] in ("reduced", "online") and name == BASE_IMAGE)}
    for name, info in protected.items():
        if hashes(extracted / name)["sha256"] != info["sha256"]:
            raise ValueError(f"Protected boot/installer file changed: {name}")
    if report["mode"] == "reduced" and (extracted / "pool/restricted").exists():
        raise ValueError("Restricted pool is still present")
    if report["mode"] == "online" and (extracted / "pool").exists():
        raise ValueError("Offline pool is still present in online-only media")
    offset = cidata_offset(args.image, args.cidata_partition)
    user_data = run("mtype", "-i", f"{args.image}@@{offset}", "::user-data", capture=True)
    meta_data = run("mtype", "-i", f"{args.image}@@{offset}", "::meta-data", capture=True)
    config = yaml.safe_load(user_data)["autoinstall"]
    metadata_config = yaml.safe_load(meta_data)
    if "network" not in config["interactive-sections"] or "apt" not in config["interactive-sections"]:
        raise ValueError("Expected interactive installer sections are missing")
    if not metadata_config.get("instance-id") or not metadata_config.get("local-hostname"):
        raise ValueError("CIDATA metadata is incomplete")
    if args.public_channel:
        verify_public_bootstrap(config, metadata_config, args.public_channel)
    boot = run("xorriso", "-indev", args.image, "-report_el_torito", "plain", capture=True).decode()
    if not re.search(r"El Torito boot img\s*:.*BIOS", boot) or not re.search(r"El Torito boot img\s*:.*UEFI", boot):
        raise ValueError("BIOS or UEFI boot entry is missing")
    result = {"checkedIntegrityEntries": checked, "protectedFilesUnchanged": len(protected),
              "biosBootEntry": True, "uefiBootEntry": True, "cidataOffset": offset,
              "userDataSha256": hashlib.sha256(user_data).hexdigest(),
              "metaDataSha256": hashlib.sha256(meta_data).hexdigest(),
              "imageSha256": report["image"]["sha256"],
              "installationTested": False}
    if args.public_channel:
        result["publicBootstrapChannel"] = args.public_channel
    write_json(report_dir / "verification.json", result)
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "metadata", "finish", "verify"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--mode", choices=("full", "reduced", "online"), default="full")
    parser.add_argument("--iso", type=Path)
    parser.add_argument("--template", type=Path)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--cidata-partition", type=int, default=3)
    parser.add_argument("--public-channel", choices=("main", "develop"),
                        help="Also verify token-free public CI bootstrap metadata")
    args = parser.parse_args()
    if args.operation == "prepare" and (not args.iso or not args.template):
        parser.error("prepare requires --iso and --template")
    if args.operation in ("finish", "verify") and not args.image:
        parser.error(f"{args.operation} requires --image")
    try:
        {"prepare": prepare, "metadata": metadata, "finish": finish, "verify": verify}[args.operation](args)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: Installer media check failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
