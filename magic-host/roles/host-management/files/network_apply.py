#!/usr/bin/env python3
"""MIT: local network trial, rollback supervisor and pre-network boot recovery.

No HTTP listener. Only root-owned requests created by host_worker are consumed.
The service keeps rollback state on disk before touching Netplan. ExecStopPost
and an early-boot service recover unconfirmed trials even after worker loss.
"""
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import time

import network_config as network
from host_worker import STATE, RESOURCE, NAMESPACE, atomic_json, kube, stamp

TRIAL = STATE / "network-trial.json"
APPROVED = STATE / "approved-network.json"
MANAGED = "90-magicstick-network.yaml"
CONFIRM = "appliance.magicstick.dev/network-confirmed"
SECONDS = 180


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def write_text(path, text):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        os.chmod(temporary, 0o600)
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def restore(trial, apply=True):
    if trial.get("phase") in {"Succeeded", "RolledBack", "Failed"}:
        return
    if not trial.get("changed"):
        trial.update(phase="Failed", message="Network trial stopped before any configuration was changed.")
        trial.pop("backup", None)
        atomic_json(TRIAL, trial)
        return
    # Never remove files created by another administrator during the trial.
    extra = {p.name for p in network.NETPLAN.glob("*.yaml")} - set(trial["backup"]) - {MANAGED}
    if extra:
        raise RuntimeError("Concurrent local Netplan changes require local recovery.")
    (network.NETPLAN / MANAGED).unlink(missing_ok=True)
    for name, contents in trial["backup"].items():
        if Path(name).name != name or not name.endswith(".yaml"):
            raise RuntimeError("Invalid local rollback state.")
        write_text(network.NETPLAN / name, contents)
    # systemd generators may already have read the trial files during boot.
    # Regenerate backend files before the network services are allowed to start.
    network.command(["netplan", "generate"], timeout=30)
    if apply:
        network.command(["netplan", "apply"], timeout=45)
    trial.update(phase="RolledBack", message="Previous Netplan files restored; verify link reachability. The network change was not confirmed.")
    trial.pop("backup", None)
    atomic_json(TRIAL, trial)


def publish(trial):
    status = {"phase": trial["phase"], "requestId": trial["requestId"], "message": trial["message"], "updatedAt": stamp()}
    if trial.get("deadline"):
        status["confirmationDeadline"] = trial["deadline"]
    kube(["patch", RESOURCE, trial["operationName"], "-n", NAMESPACE, "--type=merge", "--subresource=status", "--patch-file=/dev/stdin", "-o", "json"],
         {"metadata": {"uid": trial["operationUid"]}, "status": status})


def recover(boot=False):
    if TRIAL.exists():
        trial = json.loads(TRIAL.read_text())
        if trial.get("phase") not in {"Succeeded", "RolledBack", "Failed"}:
            restore(trial, apply=not boot)
        if not boot:
            try:
                publish(trial)
            except Exception:
                pass  # Persistent local result is republished by host_worker.
    APPROVED.unlink(missing_ok=True)


def apply():
    if not APPROVED.exists():
        return
    approved = json.loads(APPROVED.read_text())
    if time.time() - approved["approvedAt"] > 60:
        raise RuntimeError("The local network approval expired.")
    node = kube(["get", "node", approved["nodeName"], "-o", "json"])
    if (node["metadata"]["uid"] != approved["nodeUid"] or node["status"]["nodeInfo"]["bootID"] != approved["bootId"]
            or boot_id() != approved["bootId"]):
        raise RuntimeError("The approved host identity changed.")
    operation = kube(["get", RESOURCE, approved["operationName"], "-n", NAMESPACE, "-o", "json"])
    if operation["metadata"]["uid"] != approved["operationUid"] or operation.get("status", {}).get("phase") != "Applying":
        raise RuntimeError("The network operation is no longer awaiting application.")
    inventory = network.collect(node)
    if inventory.get("id") != approved["planId"]:
        raise RuntimeError("Network configuration changed after approval.")
    effective, backup, _ = network.configuration()
    desired = network.build_configuration(effective, inventory, approved["settings"])
    import yaml
    body = yaml.safe_dump(desired, sort_keys=False)
    trial = {key: approved[key] for key in ("requestId", "operationName", "operationUid", "nodeUid", "bootId")}
    trial.update(phase="Applying", message="Applying the reviewed network configuration with local rollback protection.", backup=backup)
    atomic_json(TRIAL, trial)
    try:
        publish(trial)  # Acknowledge the trial before any host side effect.
        trial["changed"] = True
        atomic_json(TRIAL, trial)
        write_text(network.NETPLAN / MANAGED, body)
        for name in backup:
            if name != MANAGED:
                (network.NETPLAN / name).unlink()
        network.command(["netplan", "generate"], timeout=30)
        # The timeout is local, not dependent on Kubernetes or the browser.
        deadline = time.monotonic() + SECONDS
        network.command(["netplan", "apply"], timeout=45)
        from datetime import datetime, timezone
        trial.update(phase="AwaitingConfirmation", message="Confirm the working connection before the deadline; otherwise the previous network is restored.",
                     deadline=datetime.fromtimestamp(time.time() + max(0, deadline - time.monotonic()), timezone.utc).isoformat().replace("+00:00", "Z"))
        atomic_json(TRIAL, trial)
        while time.monotonic() < deadline:
            try:
                publish(trial)
                operation = kube(["get", RESOURCE, trial["operationName"], "-n", NAMESPACE, "-o", "json"])
                if operation["metadata"]["uid"] != trial["operationUid"]:
                    break
                if operation["metadata"].get("annotations", {}).get(CONFIRM) == trial["requestId"]:
                    current = network.collect(node)
                    interface = next(i for i in current["interfaces"] if i["name"] == approved["settings"]["interface"])
                    addresses = [a.split('/')[0] for a in interface["addresses"] if ":" not in a]
                    original = next(i for i in inventory["interfaces"] if i["name"] == interface["name"])
                    desired_address = approved["settings"].get("address", "").split('/')[0]
                    target_ready = ((approved["settings"]["mode"] != "static" or desired_address in addresses)
                                    and (interface["kind"] != "wifi" or interface.get("connectedSsid") == approved["settings"].get("ssid")))
                    if (addresses and all(a in addresses for a in original["clusterAddresses"])
                            and target_ready and (network.NETPLAN / MANAGED).read_text() == body and time.monotonic() < deadline):
                        trial.update(phase="Succeeded", message="Network configuration confirmed and saved.")
                        trial.pop("backup", None)
                        atomic_json(TRIAL, trial)
                        break
            except Exception:
                pass  # Loss of API/network never disables the rollback deadline.
            time.sleep(2)
    finally:
        restore(trial)
        APPROVED.unlink(missing_ok=True)
        try:
            publish(trial)
        except Exception:
            pass


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Network changes require the root-owned host service.")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / "maintenance.lock").open("a") as maintenance:
        fcntl.flock(maintenance, fcntl.LOCK_EX)
        if sys.argv[1:] == ["apply"]:
            signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError("Network service stopped.")))
            apply()
        elif sys.argv[1:] in (["recover"], ["recover", "--boot"]):
            recover(boot="--boot" in sys.argv)
        else:
            raise RuntimeError("Unknown bounded network action.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Network trial could not complete. Local rollback state is retained; inspect the network service and local console.", file=sys.stderr)
        raise SystemExit(1)
