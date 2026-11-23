"""Bounded, journalled transition of the managed single-node K3s network.

The owning host maintenance worker supplies the maintenance reservation,
artifact checks and trusted application reconciliation. This module does not
expose a command or run from periodic host convergence.
"""

import ipaddress
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import uuid

from control_plane_network import ADDRESS


FILES = {
    "k3s": "20-magicstick-control-plane-network.yaml",
    "systemd": "20-magicstick-control-plane-network.conf",
}
LABEL_SERVICE = "svccontroller.k3s.cattle.io/svcname"
LABEL_NAMESPACE = "svccontroller.k3s.cattle.io/svcnamespace"
ROLLOUT = "magicstick.dev/control-plane-network-transition"
TARGET_IP = str(ADDRESS.ip)


class MigrationError(RuntimeError):
    pass


def atomic_write(path, text, mode, exclusive=False):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
            if exclusive:
                os.link(temporary, path)
            else:
                os.replace(temporary, path)
            sync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def sync_directory(path):
    directory = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def ready(resource):
    return any(condition.get("type") == "Ready" and condition.get("status") == "True"
               for condition in resource.get("status", {}).get("conditions", []))


def ipv4_node_address(node):
    ips = [
        str(ipaddress.IPv4Address(item["address"]))
        for item in node["status"]["addresses"]
        if item.get("type") == "InternalIP" and ":" not in item["address"]
    ]
    if len(ips) != 1:
        raise MigrationError("Expected one managed IPv4 node address.")
    return ips[0]


def stock_load_balancers(services, daemonsets):
    """Find only the stock ServiceLB workloads whose DNAT uses the host IP."""
    selected = []
    for service in services:
        spec, meta = service["spec"], service["metadata"]
        if (spec.get("type") != "LoadBalancer" or spec.get("loadBalancerClass")
                or spec.get("externalTrafficPolicy") != "Local"):
            continue
        matches = [
            item for item in daemonsets
            if item["metadata"].get("labels", {}).get(LABEL_SERVICE) == meta["name"]
            and item["metadata"].get("labels", {}).get(LABEL_NAMESPACE) == meta["namespace"]
        ]
        if len(matches) != 1 or not stock_daemonset(matches[0]):
            raise MigrationError("An owned single-node K3s ServiceLB could not be verified.")
        ds = matches[0]["metadata"]
        selected.append({
            "namespace": meta["namespace"], "service": meta["name"], "serviceUid": meta["uid"],
            "daemonset": ds["name"], "daemonsetUid": ds["uid"],
        })
    return sorted(selected, key=lambda item: (item["namespace"], item["service"]))


def stock_daemonset(ds):
    metadata = ds["metadata"]
    containers = ds["spec"]["template"]["spec"]["containers"]
    return (metadata["namespace"] == "kube-system" and metadata["name"].startswith("svclb-")
            and bool(containers) and all(
                str(container.get("image", "")).startswith((
                    "rancher/klipper-lb:", "docker.io/rancher/klipper-lb:",
                )) and any(
                    item.get("name") == "DEST_IPS"
                    and item.get("valueFrom", {}).get("fieldRef", {}).get("fieldPath") == "status.hostIPs"
                    for item in container.get("env", [])
                ) for container in containers
            ))


class Kube:
    def __init__(self, command, clock=time.monotonic, sleep=time.sleep):
        self.command, self.clock, self.sleep = command, clock, sleep

    def node(self, uid):
        nodes = self.command(["get", "nodes", "-o", "json"])["items"]
        if len(nodes) != 1 or nodes[0]["metadata"]["uid"] != uid:
            raise MigrationError("The expected single node no longer owns this cluster.")
        return nodes[0]

    def snapshot(self, uid):
        node = self.node(uid)
        if not ready(node):
            raise MigrationError("The expected node is not ready for maintenance.")
        previous_ip = ipv4_node_address(node)
        if previous_ip == TARGET_IP:
            raise MigrationError("The internal network is already configured.")
        cidrs = self.command(["get", "servicecidrs", "-o", "json"])["items"]
        if (len(cidrs) != 1 or cidrs[0]["metadata"]["name"] != "kubernetes"
                or cidrs[0]["spec"]["cidrs"] != ["10.43.0.0/16"]):
            raise MigrationError("The ServiceCIDR is not the supported stock IPv4 range.")
        lbs = stock_load_balancers(
            self.command(["get", "services", "-A", "-o", "json"])["items"],
            self.command(["get", "daemonsets", "-n", "kube-system", "-o", "json"])["items"],
        )
        if not lbs:
            raise MigrationError("No owned local ServiceLB exists to verify before migration.")
        if not self.control_plane_ready(uid, previous_ip) or not all(self.lb_ready(lb, previous_ip) for lb in lbs):
            raise MigrationError("The previous API and load-balancer state is not healthy.")
        return {"nodeUid": uid, "previousIp": previous_ip, "loadBalancers": lbs}

    def control_plane_ready(self, uid, address):
        node = self.node(uid)
        if not ready(node) or ipv4_node_address(node) != address:
            return False
        slices = self.command([
            "get", "endpointslices", "-n", "default",
            "-l", "kubernetes.io/service-name=kubernetes", "-o", "json",
        ])["items"]
        endpoints = {ip for item in slices for endpoint in item.get("endpoints", [])
                     if endpoint.get("conditions", {}).get("ready") is not False
                     for ip in endpoint["addresses"]}
        return endpoints == {address}

    def objects(self, lb):
        service = self.command(["get", "service", lb["service"], "-n", lb["namespace"], "-o", "json"])
        ds = self.command(["get", "daemonset", lb["daemonset"], "-n", "kube-system", "-o", "json"])
        if stock_load_balancers([service], [ds]) != [lb]:
            raise MigrationError("The ServiceLB identity changed during maintenance.")
        return service, ds

    def lb_pods(self, lb):
        selector = f"{LABEL_NAMESPACE}={lb['namespace']},{LABEL_SERVICE}={lb['service']}"
        pods = self.command(["get", "pods", "-n", "kube-system", "-l", selector, "-o", "json"])["items"]
        if any(not any(
            ref.get("uid") == lb["daemonsetUid"] and ref.get("kind") == "DaemonSet" and ref.get("controller")
            for ref in pod["metadata"].get("ownerReferences", [])
        ) for pod in pods):
            raise MigrationError("A load-balancer pod has a different owner.")
        return pods

    def lb_ready(self, lb, address, previous_pods=()):
        service, ds = self.objects(lb)
        status = ds.get("status", {})
        if (status.get("observedGeneration") != ds["metadata"]["generation"]
                or status.get("desiredNumberScheduled") != 1 or status.get("numberReady") != 1
                or status.get("updatedNumberScheduled") != 1):
            return False
        ingress = service.get("status", {}).get("loadBalancer", {}).get("ingress", [])
        if [item.get("ip") for item in ingress] != [address]:
            return False
        pods = self.lb_pods(lb)
        return (len(pods) == 1 and pods[0]["metadata"]["uid"] not in previous_pods
                and not pods[0]["metadata"].get("deletionTimestamp")
                and ready(pods[0]) and pods[0].get("status", {}).get("hostIP") == address)

    def wait(self, predicate, seconds, reason):
        deadline = self.clock() + seconds
        while True:
            try:
                if predicate():
                    return
            except MigrationError:
                raise  # Superseded identity is not a temporary readiness error.
            except (RuntimeError, OSError, subprocess.SubprocessError):
                pass  # The API can be briefly unavailable during its planned restart.
            if self.clock() >= deadline:
                raise MigrationError(reason)
            self.sleep(2)

    def wait_control_plane(self, plan, address):
        self.wait(lambda: self.control_plane_ready(plan["nodeUid"], address), 90,
                  "The K3s API endpoint did not settle on the expected address.")

    def refresh(self, plan, address, check_reservation):
        self.wait_control_plane(plan, address)
        check_reservation()
        previous = {}
        for lb in plan["loadBalancers"]:
            _, ds = self.objects(lb)
            metadata = ds["metadata"]
            # A Pod's reported hostIP may change without recreating Klipper's
            # DNAT. Require a new UID, not just a new status address.
            previous[lb["daemonsetUid"]] = {pod["metadata"]["uid"] for pod in self.lb_pods(lb)}
            patch = {
                "metadata": {"uid": metadata["uid"], "resourceVersion": metadata["resourceVersion"]},
                "spec": {"template": {"metadata": {"annotations": {ROLLOUT: f"{plan['id']}/{uuid.uuid4()}"}}}},
            }
            check_reservation()
            self.command(["patch", "daemonset", lb["daemonset"], "-n", "kube-system",
                          "--type=merge", "--patch-file=/dev/stdin", "-o", "json"], patch)
        self.wait(lambda: self.control_plane_ready(plan["nodeUid"], address)
                  and all(self.lb_ready(lb, address, previous[lb["daemonsetUid"]]) for lb in plan["loadBalancers"]),
                  90, "The owned load balancers did not return on the expected address.")
        check_reservation()


class Transition:
    def __init__(self, journal, targets, source, kube, check_reservation, stop, restart, reconcile,
                 identity, remove_interface, context=None, has_interface=lambda: False, authorize_restore=lambda: None):
        self.journal, self.targets, self.source = Path(journal), targets, Path(source)
        self.kube, self.check_reservation = kube, check_reservation
        self.stop, self.restart, self.reconcile = stop, restart, reconcile
        self.identity, self.remove_interface = identity, remove_interface
        self.has_interface = has_interface
        self.authorize_restore = authorize_restore
        self.context = context or {}
        if targets.keys() != FILES.keys():
            raise MigrationError("Invalid control-plane configuration targets.")

    def write_journal(self, plan):
        atomic_write(self.journal, json.dumps(plan, sort_keys=True) + "\n", 0o600)

    def clear(self):
        self.journal.unlink()
        sync_directory(self.journal.parent)

    def owned_file(self, kind):
        path = self.targets[kind]
        try:
            info = path.lstat()
        except FileNotFoundError:
            return False
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or path.read_bytes() != (self.source / FILES[kind]).read_bytes()):
            raise MigrationError("A local configuration file changed; it was not overwritten or removed.")
        return True

    def apply(self, uid, require_confirmation=False):
        if os.path.lexists(self.journal):
            raise MigrationError("A pending control-plane migration needs local recovery.")
        if any(os.path.lexists(path) for path in self.targets.values()):
            raise MigrationError("The existing control-plane configuration must not be overwritten.")
        self.check_reservation()
        plan = self.kube.snapshot(uid)
        plan.update(version=1, id=str(uuid.uuid4()), host=self.identity(), phase="applying", context=self.context)
        atomic_write(self.journal, json.dumps(plan, sort_keys=True) + "\n", 0o600, exclusive=True)
        try:
            # Install startup ordering first, then set the address in K3s.
            for kind in ("systemd", "k3s"):
                path = self.targets[kind]
                if os.path.lexists(path):
                    raise MigrationError("A file appeared during the migration; it was not replaced.")
                atomic_write(path, (self.source / FILES[kind]).read_text(), 0o644, exclusive=True)
            self.check_reservation()
            self.restart()
            self.kube.wait_control_plane(plan, TARGET_IP)
            self.check_reservation()
            # K3s' network-policy notifier can initialize before the persisted
            # node address changes. Start once more against the settled address,
            # without switching off its network-policy controller.
            self.restart()
            self.kube.refresh(plan, TARGET_IP, self.check_reservation)
            self.reconcile(True)
            self.check_reservation()
            if require_confirmation:
                plan["phase"] = "awaiting-verification"
                self.write_journal(plan)
        except Exception as original:
            try:
                self.restore(plan)
            except Exception as failure:
                raise MigrationError("Automatic rollback needs local recovery; the journal was retained.") from failure
            raise MigrationError("The migration failed; the previous API and load-balancer path was verified.") from original
        if not require_confirmation:
            self.clear()

    def confirm(self):
        plan = read_journal(self.journal)
        if (plan.get("phase") != "awaiting-verification" or plan.get("version") != 1
                or plan.get("host") != self.identity()):
            raise MigrationError("There is no verified local transition awaiting confirmation.")
        if not all(self.owned_file(kind) for kind in FILES):
            raise MigrationError("The proposed control-plane configuration is no longer intact.")
        self.check_reservation()
        if (not self.kube.control_plane_ready(plan["nodeUid"], TARGET_IP)
                or not all(self.kube.lb_ready(lb, TARGET_IP) for lb in plan["loadBalancers"])):
            raise MigrationError("The changed API or load balancers no longer verify.")
        self.clear()

    def recover(self):
        self.restore(read_journal(self.journal))

    def restore(self, plan):
        if plan.get("version") != 1 or plan.get("host") != self.identity():
            raise MigrationError("Recovery journal does not belong to this host.")
        # Validate both before removing either. No silent adoption on conflict.
        owned = [kind for kind in FILES if self.owned_file(kind)]
        self.authorize_restore()
        plan["phase"] = "rolling-back"
        self.write_journal(plan)
        self.stop()
        # Kubernetes configuration must be gone before the ExecStartPre hook.
        for kind in ("k3s", "systemd"):
            if kind in owned and self.owned_file(kind):
                self.targets[kind].unlink()
                sync_directory(self.targets[kind].parent)
        if self.has_interface():
            # A legacy K3s start can still read the saved internal IP. Keep
            # its interface until the node and API publish the previous IP.
            self.restart()
            self.kube.wait_control_plane(plan, plan["previousIp"])
            self.check_reservation()
            self.stop()
        self.remove_interface()
        self.restart()
        self.kube.refresh(plan, plan["previousIp"], self.check_reservation)
        self.reconcile(False)
        self.check_reservation()
        self.clear()


def read_journal(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise MigrationError("The migration journal is not a private, locally owned file.")
    return json.loads(path.read_text())
