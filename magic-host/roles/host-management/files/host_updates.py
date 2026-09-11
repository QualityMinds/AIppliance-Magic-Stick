#!/usr/bin/env python3
"""Ubuntu update scheduling and execution under the shared host maintenance lock."""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time

from updates_contract import DEFAULT_POLICY, PROTECTED, policy_id, protected, validate_policy

STATE = Path("/var/lib/magicstick/host-management")
POLICY = STATE / "update-policy.json"
STATUS = STATE / "update-status.json"
APT_CONFIG = Path("/etc/apt/apt.conf.d/99magicstick-updates")
PERIODIC_CONFIG = Path("/etc/apt/apt.conf.d/20auto-upgrades")
TIMER_CONFIG = Path("/etc/systemd/system/apt-daily-upgrade.timer.d/magicstick.conf")
REBOOT_REQUIRED = Path("/run/reboot-required")
SHUTDOWN_SCHEDULED = Path("/run/systemd/shutdown/scheduled")
CLOUD_INSTANCE = Path("/var/lib/cloud/instance")
TERMINAL = {"Succeeded", "PreparedUnverified", "Failed", "Rejected", "Interrupted", "RolledBack"}


def stamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def write(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as handle:
        os.chmod(temporary, mode)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(value):
    write(STATUS, json.dumps(value, sort_keys=True))


def policy():
    return validate_policy(read_json(POLICY, DEFAULT_POLICY))


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def window(policy, now):
    hour, minute = map(int, policy["windowStart"].split(":"))
    start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if now < start:
        start -= timedelta(days=1)
    return start, start <= now < start + timedelta(minutes=policy["windowMinutes"])


def os_release():
    return {key: value.strip('"') for key, value in
            (line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)}


def apt_config(scope):
    suites = ['"${distro_id}:${distro_codename}"', '"${distro_id}:${distro_codename}-security"',
              '"${distro_id}ESMApps:${distro_codename}-apps-security"', '"${distro_id}ESM:${distro_codename}-infra-security"']
    if scope == "all":
        suites.append('"${distro_id}:${distro_codename}-updates"')
    # Clear origin patterns too: a vendor/local wildcard must not broaden the
    # dashboard's promise. Do not clear administrator package exclusions.
    return ('// Managed by Magic Stick. Configure in System / Updates.\n'
            '#clear Unattended-Upgrade::Allowed-Origins;\n#clear Unattended-Upgrade::Origins-Pattern;\n'
            'Unattended-Upgrade::Allowed-Origins { ' + "; ".join(suites) + '; };\n'
            'Unattended-Upgrade::Package-Blacklist { ' + "; ".join(json.dumps(p) for p in PROTECTED) + '; };\n'
            'Unattended-Upgrade::Automatic-Reboot "false";\n'
            'Unattended-Upgrade::Remove-Unused-Dependencies "false";\n'
            'Unattended-Upgrade::Remove-New-Unused-Dependencies "false";\n'
            'Unattended-Upgrade::Remove-Unused-Kernel-Packages "false";\n'
            'Dpkg::Options { "--force-confdef"; "--force-confold"; };\n')


def command(argv):
    # Native APT/dpkg keep their locks and signatures. Never remove lock files
    # or turn off verification; output remains in the local service journal.
    subprocess.run(argv, check=True, env={**os.environ, "DEBIAN_FRONTEND": "noninteractive", "LC_ALL": "C.UTF-8"})


def configure(value):
    value = validate_policy(value)
    files = {APT_CONFIG: apt_config(value["mode"]),
        PERIODIC_CONFIG: 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
        TIMER_CONFIG:
          '[Timer]\nOnCalendar=\nOnCalendar=*-*-* ' + value["windowStart"] + ':00 UTC\n'
          'OnCalendar=*-*-* *:0/15:00 UTC\n'
          'RandomizedDelaySec=0\nAccuracySec=1min\nPersistent=false\n'}
    previous = {path: path.read_text() if path.exists() else None for path in files}
    try:
        for path, content in files.items():
            if previous[path] != content:
                write(path, content, 0o644)
        command(["/usr/bin/systemctl", "daemon-reload"])
        command(["/usr/bin/systemctl", "enable", "--now", "apt-daily.timer", "apt-daily-upgrade.timer"])
        if previous[TIMER_CONFIG] != files[TIMER_CONFIG]:
            command(["/usr/bin/systemctl", "restart", "apt-daily-upgrade.timer"])
        write(POLICY, json.dumps(value, sort_keys=True))
    except (OSError, subprocess.CalledProcessError):
        for path, content in previous.items():
            if content is None:
                path.unlink(missing_ok=True)
            else:
                write(path, content, 0o644)
        # Best-effort reload; preserve the original exception and saved policy.
        try:
            command(["/usr/bin/systemctl", "daemon-reload"])
            command(["/usr/bin/systemctl", "restart", "apt-daily-upgrade.timer"])
        except (OSError, subprocess.CalledProcessError):
            pass
        raise


def eligible_origin(origin, codename):
    return ((origin.origin == "Ubuntu" and origin.archive in {codename, codename + "-security", codename + "-updates"})
            or (origin.origin == "UbuntuESMApps" and origin.archive == codename + "-apps-security")
            or (origin.origin == "UbuntuESM" and origin.archive == codename + "-infra-security"))


def packages():
    import apt
    import apt_pkg
    codename = os_release()["VERSION_CODENAME"]
    cache = apt.Cache()
    result = []
    for package in cache:
        if not package.is_installed or not package.candidate:
            continue
        versions = [version for version in package.versions
                    if apt_pkg.version_compare(version.version, package.installed.version) > 0
                    and any(eligible_origin(origin, codename) for origin in version.origins)]
        if not versions:
            continue
        security = any(origin.archive.endswith("-security") for version in versions for origin in version.origins
                       if eligible_origin(origin, codename))
        held = package._pkg.selected_state == apt_pkg.SELSTATE_HOLD
        blocked = "Hardware preparation" if protected(package.name) else "Package hold" if held else ""
        # A third-party candidate is never silently presented as an Ubuntu update.
        if not blocked and not any(eligible_origin(origin, codename) for origin in package.candidate.origins):
            blocked = "External package candidate"
        result.append({"name": package.name, "installed": package.installed.version,
                       "candidate": versions[0].version, "security": security, "blocked": blocked})
    result.sort(key=lambda item: (not item["security"], item["name"]))
    return {"pendingCount": len(result), "securityCount": sum(item["security"] for item in result),
            "blockedCount": sum(bool(item["blocked"]) for item in result),
            "packages": [{**item, "name": item["name"][:128], "installed": item["installed"][:96], "candidate": item["candidate"][:96]}
                         for item in result[:50]], "truncated": len(result) > 50, "checkedAt": stamp()}


def process_start(pid):
    # /proc starttime distinguishes a still-running process from a reused PID.
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def status():
    release = os_release()
    supported = release.get("ID") == "ubuntu" and release.get("VERSION_ID") in {"24.04", "26.04"} and POLICY.exists()
    value = policy()
    state = read_json(STATUS, {})
    busy = (state.get("phase") == "Running" and state.get("bootId") == boot_id()
            and type(state.get("pid")) is int and state["pid"] > 0
            and bool(state.get("processStart")) and process_start(state["pid"]) == state["processStart"])
    if state.get("phase") == "Running" and not busy:
        state = {**state, "phase": "Interrupted", "message": "Update execution was interrupted; inspect the local APT logs before retrying."}
    return {"supported": supported, "id": policy_id(value), "policy": value, "busy": busy,
            "rebootRequired": REBOOT_REQUIRED.exists(),
            **{key: state[key] for key in ("phase", "message", "checkedAt", "lastSuccessAt", "lastAttemptAt", "pendingCount",
                                           "securityCount", "blockedCount", "packages", "truncated", "requestId") if key in state}}


def execute(scope, request_id="", check_only=False, automatic=False):
    value = policy()
    previous = read_json(STATUS, {})
    state = {**previous, "phase": "Running", "message": "Checking Ubuntu package updates." if check_only else "Installing eligible Ubuntu updates.",
             "pid": os.getpid(), "processStart": process_start(os.getpid()), "bootId": boot_id(), "requestId": request_id, "lastAttemptAt": stamp()}
    if automatic:
        state["windowAttempt"] = window(value, datetime.now(timezone.utc))[0].isoformat()
    save(state)
    try:
        command(["/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=120", "-o", "APT::Update::Error-Mode=any", "update"])
        state.update(packages())
        save(state)
        if automatic and not check_only and not window(value, datetime.now(timezone.utc))[1]:
            state.update(phase="Succeeded", message="Package check completed; installation deferred because the maintenance window ended.")
            save(state)
            return
        if not check_only:
            write(APT_CONFIG, apt_config(scope), 0o644)
            command(["/usr/bin/unattended-upgrade", "--verbose"])
            state.update(packages(), lastSuccessAt=stamp())
        state.update(phase="Succeeded", message="Package check completed." if check_only else "Eligible Ubuntu updates installed. Held and hardware packages remain listed.")
        save(state)
        if (automatic and not check_only and value["automaticReboot"] and REBOOT_REQUIRED.exists()
                and window(value, datetime.now(timezone.utc) + timedelta(minutes=1))[1]):
            if state.get("rebootScheduledBootId") != boot_id() and not SHUTDOWN_SCHEDULED.exists():
                state.update(rebootScheduledBootId=boot_id(), message="Updates completed; automatic restart scheduled in one minute.")
                save(state)
                command(["/usr/sbin/shutdown", "-r", "+1", "Magic Stick update maintenance window."])
    except (OSError, ValueError, subprocess.CalledProcessError):
        state.update(phase="Failed", message="Update operation failed. Inspect the local APT and unattended-upgrades logs.")
        save(state)
        raise
    finally:
        write(APT_CONFIG, apt_config(policy()["mode"]), 0o644)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["configure", "automatic", "requested"])
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Updates require the local root service.")
    if args.action == "configure":
        configure(policy())
        return
    if CLOUD_INSTANCE.exists() and not (CLOUD_INSTANCE / "boot-finished").exists():
        return
    with (STATE / "maintenance.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if args.action == "automatic" else 0))
        except BlockingIOError:
            return
        if SHUTDOWN_SCHEDULED.exists():
            return
        current = read_json(STATE / "state.json", {}).get("current") or {}
        value = policy()
        if args.action == "automatic":
            start, inside = window(value, datetime.now(timezone.utc))
            if (not inside or current and current.get("phase") not in TERMINAL
                    or read_json(STATUS, {}).get("windowAttempt") == start.isoformat()):
                return
            execute(value["mode"], automatic=True, check_only=value["mode"] == "manual")
        else:
            request = read_json(STATE / "approved-updates.json", {})
            if (not request or current.get("requestId") != request.get("requestId") or current.get("phase") != "Applying"
                    or current.get("operationUid") != request.get("operationUid") or current.get("initialBootId") != boot_id()
                    or not 0 <= time.time() - request.get("approvedAt", 0) <= 300
                    or request.get("action") not in {"check-updates", "install-updates"}
                    or request.get("scope") not in {"security", "all"}):
                raise RuntimeError("The local update request is stale or no longer active.")
            if read_json(STATUS, {}).get("requestId") == request["requestId"]:
                return  # An interrupted execution is not automatically replayed.
            execute(request["scope"], request["requestId"], check_only=request["action"] == "check-updates")


if __name__ == "__main__":
    main()
