#!/usr/bin/env python3
"""Explicit local maintenance command for an installed MagicStick node."""

import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

import yaml

import control_plane_migration as migration
import control_plane_network as network
import control_plane_release as release


ROOT = Path("/usr/local/lib/magicstick/k3s")
HOST_WORKER = Path("/usr/local/lib/magicstick/host-management")
STATE = Path("/var/lib/magicstick/host-management")
JOURNAL = STATE / "control-plane-network-migration.json"
TARGETS = {
    "k3s": Path("/etc/rancher/k3s/config.yaml.d") / migration.FILES["k3s"],
    "systemd": Path("/etc/systemd/system/k3s.service.d") / migration.FILES["systemd"],
}
NAMES = {"kdns": ("kdns", "kdns-kdns"), "dashboardApi": ("identity-system", "ai-appliance-dashboard-api")}
# A planned restart can include the Kubelet's default five-minute unchanged
# status publication interval. K3s waits for a fresh Ready heartbeat before
# starting network policy; do not replace this with stale API readiness.
POLICY_START_SECONDS = 365
RESERVATION_SECONDS = 1800
UID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
NVIDIA_DISPLAY_DROPIN = "90-magicstick-nvidia-display.yaml"
NVIDIA_DISPLAY_POLICY = (b"# The host owns NVIDIA DRM so the local setup/TUI console remains visible.\n"
                         b"node-label:\n  - nvidia.com/gpu.deploy.driver=false\n")


def local(argv, timeout=30):
    proc = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
    if proc.returncode:
        raise migration.MigrationError("A local command failed during the network maintenance.")
    return proc.stdout


def identity():
    return Path("/etc/machine-id").read_text().strip()


def verify_stock_dropins(directory):
    # Keep the role-generated NVIDIA label policy byte-for-byte intact. A
    # matching filename alone cannot exempt custom network-bearing settings.
    for path in directory.glob("*.yaml"):
        info = path.lstat()
        if (path.name != NVIDIA_DISPLAY_DROPIN or not stat.S_ISREG(info.st_mode)
                or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o644
                or info.st_size > len(NVIDIA_DISPLAY_POLICY) + 64
                or path.read_bytes() not in (NVIDIA_DISPLAY_POLICY, NVIDIA_DISPLAY_POLICY +
                                            b"  - nvidia.com/gpu.deploy.operands=false\n")):
            raise migration.MigrationError("Additional K3s configuration needs local review.")


def verify_stock(node):
    info = node["status"]["nodeInfo"]
    if (info.get("kubeletVersion") != "v1.36.4+k3s1"
            or info.get("bootID") != Path("/proc/sys/kernel/random/boot_id").read_text().strip()):
        raise migration.MigrationError("The local node boot or supported K3s version could not be verified.")
    config = yaml.safe_load(Path("/etc/rancher/k3s/config.yaml").read_text(encoding="utf-8"))
    if set(config) - {"node-name", "tls-san", "write-kubeconfig-mode", "kube-apiserver-arg", "disable", "kubelet-arg"}:
        raise migration.MigrationError("A custom K3s configuration needs local review.")
    if config.get("disable") != ["traefik"]:
        raise migration.MigrationError("Additional K3s configuration needs local review.")
    verify_stock_dropins(TARGETS["k3s"].parent)
    start = local(["systemctl", "show", "k3s.service", "--property=ExecStart", "--value"])
    if "argv[]=/usr/local/bin/k3s server ;" not in start:
        raise migration.MigrationError("The K3s service does not use the stock server entry point.")
    if network.read_state() != "absent":
        raise migration.MigrationError("An internal interface already exists; no files were changed.")
    routes = json.loads(local([network.IP, "-json", "-4", "route", "show", "default"]))
    if not routes:
        raise migration.MigrationError("No active route can restore the previous K3s address.")
    metric = min(item.get("metric", 0) for item in routes)
    preferred = [item.get("prefsrc") for item in routes if item.get("metric", 0) == metric]
    if preferred != [migration.ipv4_node_address(node)]:
        raise migration.MigrationError("The current preferred route would not restore the original node address.")


def assert_models_idle(kube):
    activations = kube(["get", "modelactivations.appliance.magicstick.dev", "-n", "ai-system", "-o", "json"])["items"]
    if any(item["spec"].get("type") != "external" and (
            item["spec"].get("enabled") is not False
            or item.get("status", {}).get("phase") not in {"Stopped", "Disabled"}
    ) for item in activations):
        raise migration.MigrationError("Stop the local models normally before this maintenance.")


def verify_ready_image(kube, namespace, name, image):
    deployment = kube(["get", "deployment", name, "-n", namespace, "-o", "json"])
    spec, status = deployment["spec"], deployment["status"]
    containers = [item["name"] for item in spec["template"]["spec"]["containers"] if item.get("image") == image]
    if (status.get("observedGeneration") != deployment["metadata"]["generation"]
            or spec.get("replicas", 1) != 1 or status.get("readyReplicas") != 1
            or status.get("updatedReplicas") != 1 or status.get("replicas") != 1
            or len(containers) != 1):
        raise migration.MigrationError("A qualified image deployment is not ready.")
    labels = spec["selector"]["matchLabels"]
    if not labels:
        raise migration.MigrationError("Cannot identify the owned image workload.")
    selector = ",".join(f"{key}={value}" for key, value in sorted(labels.items()))
    replicas = kube(["get", "replicasets", "-n", namespace, "-l", selector, "-o", "json"])["items"]
    owners = {item["metadata"]["uid"] for item in replicas if any(
        ref.get("controller") and ref.get("kind") == "Deployment"
        and ref.get("uid") == deployment["metadata"]["uid"] for ref in item["metadata"].get("ownerReferences", [])
    )}
    pods = kube(["get", "pods", "-n", namespace, "-l", selector, "-o", "json"])["items"]
    digest = image.split("@", 1)[1]
    matches = [pod for pod in pods if not pod["metadata"].get("deletionTimestamp") and migration.ready(pod)
               and any(ref.get("controller") and ref.get("kind") == "ReplicaSet" and ref.get("uid") in owners
                       for ref in pod["metadata"].get("ownerReferences", []))
               and any(item.get("name") == containers[0] and item.get("image") == image
                       for item in pod["spec"]["containers"])
               and any(item.get("name") == containers[0] and item.get("ready") is True
                       and (item.get("imageID") == digest or str(item.get("imageID", "")).endswith("@" + digest))
                       for item in pod.get("status", {}).get("containerStatuses", []))]
    if len(matches) != 1:
        raise migration.MigrationError("Cannot match a ready running container to the promoted image.")


def remove_owned_interface():
    if network.read_state() != "absent":
        local([network.IP, "link", "delete", "dev", network.INTERFACE, "type", "dummy"])


def stop():
    local(["systemctl", "stop", "k3s.service"], timeout=70)


def restart():
    local(["systemctl", "daemon-reload"])
    before = local(["systemctl", "show", "k3s.service", "--property=InvocationID", "--value"]).strip()
    local(["systemctl", "restart", "--no-block", "k3s.service"])
    deadline = time.monotonic() + POLICY_START_SECONDS
    while time.monotonic() < deadline:
        values = dict(line.split("=", 1) for line in local([
            "systemctl", "show", "k3s.service", "--property=InvocationID", "--property=ActiveState",
        ]).splitlines() if "=" in line)
        after = values.get("InvocationID")
        if after and after != before and values.get("ActiveState") == "active":
            policy = subprocess.run([
                "journalctl", "--quiet", "--output=cat", "--lines=1",
                "--grep=Starting network policy controller version", "_SYSTEMD_INVOCATION_ID=" + after,
            ], text=True, capture_output=True, timeout=8, check=False)
            if policy.returncode == 0 and "Starting network policy controller version" in policy.stdout:
                return
        if values.get("ActiveState") == "failed":
            break
        time.sleep(1)
    raise migration.MigrationError("The next K3s service invocation and network policy controller did not start.")


def converge(software, lock, commit):
    env = {**software.ENV, "MAGICSTICK_CONVERGE_LOCK_FD": str(lock.fileno()),
           "MAGICSTICK_EXPECTED_COMMIT": commit, "MAGICSTICK_REGRESSION_GUARDED": "1",
           "MAGICSTICK_CONTROL_PLANE_TRANSITION": "1"}
    with subprocess.Popen(["/bin/bash", str(software.RUNNER)], env=env, pass_fds=(lock.fileno(),),
                          start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as proc:
        try:
            if proc.wait(timeout=360):
                raise migration.MigrationError("The normal host convergence did not complete.")
        except BaseException:
            # Do not race a timed-out Ansible child against local rollback.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            raise


def verify_gateway(kube, enabled, legacy_ip):
    mode = "host-link-ipv4" if enabled else "gateway-status"
    settings = kube(["get", "configmap", "ai-appliance-settings", "-n", "flux-system", "-o", "json"])["data"]
    domain = settings.get("AI_APPLIANCE_MDNS_DOMAIN", "")
    if (not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,240}\.local", domain)
            or settings.get("AI_APPLIANCE_MDNS_ADDRESS_MODE") != mode):
        return False
    gateway = kube(["get", "gateway", "identity-pilot", "-n", "identity-system", "-o", "json"])
    expected_ip = migration.TARGET_IP if enabled else legacy_ip
    if ([item.get("value") for item in gateway.get("status", {}).get("addresses", [])] != [expected_ip]
            or gateway["metadata"].get("annotations", {}).get("magicstick.dev/mdns-address-mode") != mode
            or not any(c.get("type") == "Programmed" and c.get("status") == "True"
                       and c.get("observedGeneration") == gateway["metadata"]["generation"]
                       for c in gateway.get("status", {}).get("conditions", []))):
        return False
    issuer_host = "id." + domain
    issuer = f"https://{issuer_host}/realms/magicstick"
    address = "127.0.0.1" if enabled else legacy_ip
    try:
        output = local(["/usr/bin/curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "5",
                        "--cacert", "/etc/rancher/k3s/magicstick-oidc-ca.crt",
                        "--resolve", f"{issuer_host}:443:{address}", issuer + "/.well-known/openid-configuration"])
        return json.loads(output).get("issuer") == issuer
    except (migration.MigrationError, ValueError, subprocess.SubprocessError):
        return False


def maintenance(action, node_uid, lock):
    sys.path.insert(0, str(HOST_WORKER))
    import regression_guard as guard
    import software_channel as software

    kube = guard.kube
    cluster = migration.Kube(kube)
    current = software.config()
    commit = software.git_commit(current["checkout"])
    if (current["mode"] != "readonly-public" or not re.fullmatch(r"[0-9a-f]{40}", commit)
            or current["syncPath"] != "magic-cluster/flux/entrypoints/single-node"):
        raise migration.MigrationError("The managed single-node source could not be verified.")
    if local(["/usr/bin/git", "-C", current["checkout"], "status", "--porcelain"]).strip():
        raise migration.MigrationError("The installed source contains unreviewed local changes.")
    pins = release.qualified_pins(Path(current["checkout"]))
    if not pins:
        raise migration.MigrationError("The matched link-independent images have not been promoted.")
    reservation = guard.Reservation(kube, duration=RESERVATION_SECONDS)
    if action in {"recover", "confirm"}:
        plan = migration.read_journal(JOURNAL)
        context = plan["context"]
        if (plan["host"] != identity() or plan["nodeUid"] != node_uid or context["commit"] != commit):
            raise migration.MigrationError("Recovery does not match the recorded host and source.")
        if context.get("leaseUid"):
            if not re.fullmatch(UID, context["leaseUid"]) or not re.fullmatch("host-converge-" + UID, context["leaseOwner"]):
                raise migration.MigrationError("The local reservation identity is invalid.")
            reservation.uid, reservation.owner = context["leaseUid"], context["leaseOwner"]
        previous_ip = plan["previousIp"]
    else:
        if os.path.lexists(JOURNAL):
            raise migration.MigrationError("A pending migration requires local recovery.")
        status = software.status()
        if status.get("blocked") or status.get("busy"):
            raise migration.MigrationError("Another software operation is unfinished.")
        node = cluster.node(node_uid)
        verify_stock(node)
        previous_ip = migration.ipv4_node_address(node)
        from host_plan import TERMINAL as host_terminal
        operations = kube(["get", "hostoperations.appliance.magicstick.dev", "-n", "ai-system", "-o", "json"])["items"]
        if any(item.get("status", {}).get("phase") not in host_terminal for item in operations):
            raise migration.MigrationError("Another host operation is unfinished.")
        assert_models_idle(kube)
        guard.assert_idle(kube)
        software.verify(commit, kube, timeout=45)
        for key, (namespace, name) in NAMES.items():
            verify_ready_image(kube, namespace, name, pins[key])
        try:
            reservation.acquire()
        except Exception:
            reservation.release()
            raise
        context = {"commit": commit, "leaseUid": reservation.uid, "leaseOwner": reservation.owner}

    def check_reservation():
        cluster.node(node_uid)
        if reservation.uid:
            reservation.renew()
        guard.assert_idle(kube)

    def authorize_restore():
        try:
            cluster.node(node_uid)
        except migration.MigrationError:
            raise  # Different node identity is not an unavailable API.
        except (RuntimeError, OSError, subprocess.SubprocessError):
            state = local(["systemctl", "show", "k3s.service", "--property=ActiveState", "--value"]).strip()
            if state not in {"inactive", "failed", "activating", "deactivating"}:
                raise migration.MigrationError("Cannot verify the owning cluster before restoring its network.")
            # Only the private, host-bound journal allows recovery with the API
            # down. Post-start changes still require the exact reservation.
        else:
            check_reservation()
            assert_models_idle(kube)

    def reconcile(enabled):
        check_reservation()
        converge(software, lock, commit)
        cluster.wait(lambda: verify_gateway(kube, enabled, previous_ip), 100,
                     "The identity gateway did not verify on the expected network.")
        for key, (namespace, name) in NAMES.items():
            verify_ready_image(kube, namespace, name, pins[key])
        check_reservation()

    transition = migration.Transition(
        JOURNAL, TARGETS, ROOT, cluster, check_reservation, stop, restart, reconcile,
        identity, remove_owned_interface, context,
        has_interface=lambda: network.read_state() != "absent",
        authorize_restore=authorize_restore,
    )
    try:
        if action == "recover":
            transition.recover()
        elif action == "confirm":
            if not verify_gateway(kube, True, previous_ip):
                raise migration.MigrationError("The network cannot be confirmed while the identity gateway is unhealthy.")
            for key, (namespace, name) in NAMES.items():
                verify_ready_image(kube, namespace, name, pins[key])
            transition.confirm()
        else:
            assert_models_idle(kube)
            transition.apply(node_uid, require_confirmation=True)
            print("Internal routing verified. Verify both physical paths and sign-in before confirming.")
    finally:
        reservation.preserve = os.path.lexists(JOURNAL)
        reservation.release()


def main(args):
    if (os.geteuid() != 0 or len(args) != 2 or args[0] not in {"apply", "confirm", "recover"}
            or not re.fullmatch(UID, args[1])):
        raise migration.MigrationError("Usage as local root: control_plane_maintenance.py {apply|confirm|recover} NODE_UID")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / "maintenance.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise migration.MigrationError("There is already a host maintenance operation.") from None
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, interrupted)
        maintenance(*args, lock)


def interrupted(*_args):
    raise migration.MigrationError("The local maintenance was interrupted.")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except migration.MigrationError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError, yaml.YAMLError):
        print("Network maintenance could not be verified. Inspect local recovery state before retrying.", file=sys.stderr)
        raise SystemExit(1)
