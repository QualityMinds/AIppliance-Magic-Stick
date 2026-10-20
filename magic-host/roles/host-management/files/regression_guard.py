#!/usr/bin/env python3
"""Serialize host software convergence with the registered regression lab.

Uses the existing lab Lease, never clears an expired test owner, and retains
the reservation until Flux has actually applied the source and workloads.
"""
from copy import deepcopy
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid
import json
import socket
import re

NS = "magicstick-regression"
TERMINAL = {"Passed", "Failed", "Blocked", "Cancelled"}
K3S = "/usr/local/bin/k3s"
CONFIG = Path("/etc/rancher/k3s/k3s.yaml")


def kube(args, value=None):
    result = subprocess.run([K3S, "kubectl", "--kubeconfig=" + str(CONFIG), "--request-timeout=20s", *args],
                            input=json.dumps(value) if value is not None else None, text=True,
                            capture_output=True, timeout=25, check=False)
    if result.returncode:
        raise RuntimeError("Regression safety state is unavailable; software convergence was deferred.")
    return json.loads(result.stdout) if result.stdout.strip() else None


def assert_idle(command=kube):
    runs = command(["get", "regressionruns.appliance.magicstick.dev", "-n", "ai-system", "-o", "json"])
    if any(r.get("status", {}).get("phase") not in TERMINAL for r in runs.get("items", [])):
        raise RuntimeError("A regression or cleanup run is active; software convergence was deferred.")


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Reservation:
    def __init__(self, command=kube):
        self.command, self.owner = command, "host-converge-" + str(uuid.uuid4())
        self.uid = None
        self.stopped, self.lost = threading.Event(), threading.Event()
        self.thread = None
        self.preserve = False

    def read(self):
        return self.command(["get", "lease", "lab-lock", "-n", NS, "-o", "json"])

    def replace(self, value):
        return self.command(["replace", "-f", "-", "-o", "json"], value)

    def acquire(self):
        marker = self.command(["get", "configmap", "registered-lab", "-n", NS, "--ignore-not-found", "-o", "json"])
        if not marker:
            return False  # Ordinary first installation / unregistered appliance.
        assert_idle(self.command)
        lease = self.read()
        if (marker.get("immutable") is not True or marker.get("data", {}).get("kind") != "disposable-regression-lab"
                or not marker.get("metadata", {}).get("labels", {}).get("regression.magicstick.dev/appliance-uid")
                or lease["metadata"].get("labels", {}).get("regression.magicstick.dev/appliance-uid") !=
                marker["metadata"]["labels"]["regression.magicstick.dev/appliance-uid"]):
            raise RuntimeError("Regression registration and Lease identities differ; convergence was deferred.")
        spec, annotations = lease.get("spec", {}), lease["metadata"].get("annotations", {})
        own_expired = False
        try:
            renewed = datetime.fromisoformat(spec["renewTime"].replace("Z", "+00:00"))
            duration = spec["leaseDurationSeconds"]
            own_expired = (annotations.get("regression.magicstick.dev/host-maintenance") == "true"
                and annotations.get("regression.magicstick.dev/maintenance-host") == socket.gethostname()
                and re.fullmatch(r"host-converge-[a-f0-9-]{36}", str(spec.get("holderIdentity", ""))) is not None
                and renewed.tzinfo is not None and type(duration) is int and 1 <= duration <= 86400
                and time.time() >= renewed.timestamp() + duration + 60)
        except (KeyError, ValueError, TypeError):
            pass
        if spec.get("holderIdentity") and not own_expired:
            raise RuntimeError("The regression Lease is reserved or needs recovery; software convergence was deferred.")
        self.uid = lease["metadata"]["uid"]
        changed = deepcopy(lease)
        changed["metadata"].setdefault("annotations", {})["regression.magicstick.dev/host-maintenance"] = "true"
        changed["metadata"]["annotations"]["regression.magicstick.dev/maintenance-host"] = socket.gethostname()
        changed.setdefault("spec", {}).update(holderIdentity=self.owner, renewTime=stamp(), leaseDurationSeconds=60)
        self.replace(changed)  # resourceVersion CAS closes concurrent runner acquisition.
        assert_idle(self.command)  # Also catch an intent created during acquisition.
        return True

    def renew(self):
        current = self.read()
        if current["metadata"]["uid"] != self.uid or current.get("spec", {}).get("holderIdentity") != self.owner:
            raise RuntimeError("Software convergence lost its regression reservation.")
        current["spec"].update(renewTime=stamp(), leaseDurationSeconds=60)
        self.replace(current)

    def heartbeat(self):
        while not self.stopped.wait(15):
            try:
                self.renew()
            except Exception:
                self.lost.set()
                return

    def release(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=30)
        if self.uid and not self.preserve:
            current = self.read()
            if current["metadata"]["uid"] == self.uid and current.get("spec", {}).get("holderIdentity") == self.owner:
                current["spec"].update(holderIdentity="", renewTime=stamp())
                current["metadata"].setdefault("annotations", {})["regression.magicstick.dev/host-maintenance"] = "false"
                self.replace(current)

    def wait_converged(self, timeout=900):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.lost.is_set():
                raise RuntimeError("Software convergence lost its regression reservation.")
            source = self.command(["get", "gitrepository", "flux-system", "-n", "flux-system", "-o", "json"])
            revision = source.get("status", {}).get("artifact", {}).get("revision")
            commit = source.get("spec", {}).get("ref", {}).get("commit")
            items = self.command(["get", "kustomizations.kustomize.toolkit.fluxcd.io", "-A", "-o", "json"])["items"]
            selected = [x for x in items if x.get("spec", {}).get("sourceRef", {}).get("name") == "flux-system"
                        and not x.get("spec", {}).get("suspend")]
            if (revision and (not commit or revision.endswith(commit)) and selected and all(
                    x.get("status", {}).get("lastAppliedRevision") == revision and any(
                        c.get("type") == "Ready" and c.get("status") == "True" and
                        c.get("observedGeneration", x.get("status", {}).get("observedGeneration")) == x["metadata"].get("generation")
                        for c in x.get("status", {}).get("conditions", [])) for x in selected)):
                return
            time.sleep(5)
        raise RuntimeError("Flux has not finished software convergence; retry only after inspecting its readiness.")


def run(command):
    fd = os.environ.get("MAGICSTICK_CONVERGE_LOCK_FD", "")
    if CONFIG.is_file() and (not fd.isdigit() or not Path("/proc/self/fd/" + fd).exists()
            or not os.path.samefile("/proc/self/fd/" + fd, "/var/lib/magicstick/host-management/maintenance.lock")):
        print("The host maintenance lock is required before regression reservation.", file=sys.stderr)
        return 1
    reservation = Reservation()
    try:
        guarded = CONFIG.is_file() and reservation.acquire()
        if guarded:
            reservation.thread = threading.Thread(target=reservation.heartbeat, daemon=True)
            reservation.thread.start()
        env = {**os.environ, "MAGICSTICK_REGRESSION_GUARDED": "1"}
        child = subprocess.Popen(command, env=env, pass_fds=(int(fd),) if fd.isdigit() else ())
        # A failed/partly applied Ansible run can still have a pending Flux
        # rollout. Do not open the lab until convergence was actually proved.
        reservation.preserve = bool(guarded)
        while child.poll() is None:
            if reservation.lost.wait(1):
                child.terminate()
                try:
                    child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    child.kill(); child.wait()
                raise RuntimeError("Software convergence stopped after losing its regression reservation.")
        if child.returncode:
            return child.returncode
        if guarded:
            reservation.wait_converged()
            reservation.preserve = False
        return 0
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Regression guard could not verify safety; convergence was deferred.", file=sys.stderr)
        return 1
    finally:
        reservation.release()


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
