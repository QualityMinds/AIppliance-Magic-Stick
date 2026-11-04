#!/usr/bin/python3
# SPDX-License-Identifier: BUSL-1.1
"""Load/check one hash-bound profile on appliance-owned Ubuntu 26.04 K3s hosts.

No commands, paths, profile names or security overrides are accepted as input.
An existing unowned policy/cluster is never adopted. --check is read-only.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


PROFILE_NAME = "cri-containerd.apparmor.d"
PROFILE = Path("/etc/apparmor.d/cri-containerd.apparmor.d")
PROFILE_SHA256 = "09cc1782e9d11f18533df0eb412f12fafca5ecc5900691821c351ce1b8995d05"
OWNER = Path("/var/lib/magicstick/k3s-apparmor/owner.json")
LOADED = Path("/run/magicstick-k3s-apparmor/loaded.json")
ENABLED = Path("/sys/module/apparmor/parameters/enabled")
PROFILES = Path("/sys/kernel/security/apparmor/profiles")
SIGNAL_FEATURE = Path("/sys/kernel/security/apparmor/features/signal/mask")
OS_RELEASE = Path("/etc/os-release")
K3S = Path("/usr/local/bin/k3s")
K3S_VERSION = "v1.36.4+k3s1"
PARSER = "/usr/sbin/apparmor_parser"


class PolicyError(RuntimeError):
    pass


def trusted_file(path):
    """Do not follow symlinks or consume group/other-writable policy/state."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PolicyError("unsafe-owned-file")
        return stream.read(65537)


def expected_owner():
    return {"version": 1, "profile": PROFILE_NAME,
            "sha256": PROFILE_SHA256, "k3s": K3S_VERSION}


def baseline():
    release = dict(re.findall(r'^([A-Z_]+)=[\"\']?([^\"\'\n]+)', OS_RELEASE.read_text(), re.M))
    if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != "26.04":
        raise PolicyError("unreviewed-host-baseline")
    if ENABLED.read_text().strip() != "Y":
        raise PolicyError("apparmor-not-enabled")
    if not {"kill", "urg"}.issubset(set(SIGNAL_FEATURE.read_text().split())):
        raise PolicyError("apparmor-signal-mediation-unavailable")
    if K3S.exists():
        result = subprocess.run([str(K3S), "--version"], capture_output=True,
                                text=True, timeout=10, check=True)
        if not re.search(r"^k3s version " + re.escape(K3S_VERSION) + r"(?:\s|$)", result.stdout, re.M):
            raise PolicyError("unreviewed-k3s-baseline")


def profile_mode():
    entries = [line for line in PROFILES.read_text().splitlines()
               if line.split(" ", 1)[0] == PROFILE_NAME]
    if not entries:
        return "absent"
    if entries == [PROFILE_NAME + " (enforce)"]:
        return "enforce"
    raise PolicyError("profile-not-enforcing")


def owned():
    if OWNER.is_symlink():
        raise PolicyError("unsafe-owned-file")
    if not OWNER.exists():
        return False
    if json.loads(trusted_file(OWNER)) != expected_owner():
        raise PolicyError("unreviewed-policy-owner")
    return True


def preflight():
    baseline()
    managed = owned()
    if not managed and (K3S.exists() or PROFILE.exists() or PROFILE.is_symlink()
                        or profile_mode() != "absent"):
        raise PolicyError("existing-policy-or-cluster-not-owned")
    if managed and (PROFILE.exists() or PROFILE.is_symlink()):
        verify_source()  # do not overwrite a locally changed policy on convergence
    return managed


def verify_source():
    if hashlib.sha256(trusted_file(PROFILE)).hexdigest() != PROFILE_SHA256:
        raise PolicyError("unreviewed-profile-content")


def prepare():
    if preflight():
        return False
    # This records management, not successful loading. A failed/interrupted
    # bootstrap can resume; only --check attests an enforcing loaded profile.
    save_owner()
    return True


def save_owner():
    save_record(OWNER)


def save_record(path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise PolicyError("unsafe-owner-directory")
    descriptor, temporary = tempfile.mkstemp(prefix=".record-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(expected_owner(), stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load():
    baseline()
    managed = owned()
    mode = profile_mode()
    if not managed:
        raise PolicyError("policy-owner-missing")
    verify_source()
    # /run is cleared at boot. Do not credit an old/default profile merely
    # because a profile of the same name is loaded. Compile once each boot;
    # repeated convergence must not reload a verified running cluster's policy.
    if mode == "enforce" and load_attested():
        return False
    result = subprocess.run([PARSER, "--skip-cache", "--replace", str(PROFILE)],
                            capture_output=True, text=True, timeout=15, check=True)
    if "not enforced" in (result.stderr or "").lower():
        raise PolicyError("profile-rules-not-enforced")
    if profile_mode() != "enforce":
        raise PolicyError("profile-load-not-verified")
    save_record(LOADED)
    return True


def load_attested():
    if LOADED.is_symlink():
        raise PolicyError("unsafe-owned-file")
    return LOADED.exists() and json.loads(trusted_file(LOADED)) == expected_owner()


def check():
    baseline()
    if not owned():
        raise PolicyError("policy-owner-missing")
    verify_source()
    if profile_mode() != "enforce":
        raise PolicyError("profile-not-loaded")
    if not load_attested():
        raise PolicyError("current-boot-load-not-attested")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--preflight", action="store_true")
    modes.add_argument("--prepare", action="store_true")
    modes.add_argument("--load", action="store_true")
    modes.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise PolicyError("root-required")
        changed = False
        if args.preflight:
            preflight()
        elif args.prepare:
            changed = prepare()
        elif args.load:
            changed = load()
        else:
            check()
        print(json.dumps({"status": "passed", "changed": changed, "profile": PROFILE_NAME}))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError, PolicyError) as exc:
        # Parser/subprocess output can contain host-specific details. Fixed reasons only.
        reason = str(exc) if isinstance(exc, PolicyError) else "profile-observation-or-command-failed"
        print(json.dumps({"status": "failed", "reason": reason}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
