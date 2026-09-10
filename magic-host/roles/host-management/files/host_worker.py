#!/usr/bin/env python3
"""Node-local, root-owned executor for three bounded HostOperation actions.

No HTTP listener, shell execution, dashboard-supplied packages or executable paths.
Each timer tick is serialized with ordinary host convergence. Persist intent before
side effects; uncertain/interrupted execution never automatically repeats them.
"""

from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import sys
import time

from host_plan import TERMINAL, build_plan, digest, requested_plan, validate_request

BASE = Path("/usr/local/lib/magicstick/host-management")
STATE = Path("/var/lib/magicstick/host-management")
ANNOTATION = "appliance.magicstick.dev/host-management"
RESOURCE = "hostoperations.appliance.magicstick.dev"
NAMESPACE = "ai-system"
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8",
       "ANSIBLE_CONFIG": str(BASE / "ansible.cfg"), "ANSIBLE_ROLES_PATH": str(BASE / "roles"),
       "ANSIBLE_LOCAL_TEMP": str(STATE / "ansible-tmp"), "ANSIBLE_NOCOLOR": "1"}


def stamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(argv, data=None, timeout=30):
    result = subprocess.run(argv, input=json.dumps(data) if data is not None else None, text=True,
                            capture_output=True, timeout=timeout, env=ENV, cwd=BASE, check=False)
    if result.returncode:
        # Subprocess output is intentionally not exposed through Kubernetes/UI.
        raise RuntimeError("A local host command failed; inspect the host management journal before retrying.")
    return result.stdout


def kube(args, data=None):
    output = run(["/usr/local/bin/k3s", "kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml",
                  "--cache-dir=" + str(STATE / "kube-cache"), "--request-timeout=20s", *args], data)
    return json.loads(output) if output.strip() else None


def atomic_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def display_gpus(root=Path("/sys/bus/pci/devices")):
    try:
        if not root.is_dir():
            return None
        found = []
        for entry in sorted(root.iterdir()):
            if int((entry / "class").read_text().strip(), 16) >> 16 == 3:
                vendor = int((entry / "vendor").read_text().strip(), 16)
                device = int((entry / "device").read_text().strip(), 16)
                found.append(f"{vendor:04x}:{device:04x}")
        return found
    except (OSError, ValueError):
        return None


def installed_packages(catalog):
    packages = sorted({name for profile in catalog["profiles"] for name in profile["packages"]})
    result = {}
    for name in packages:
        try:
            value = run(["/usr/bin/dpkg-query", "-W", "-f=${db:Status-Status}\t${Version}", name]).strip()
            if value.startswith("installed\t"):
                result[name] = value.split("\t", 1)[1]
        except RuntimeError:
            pass  # A missing optional package is not a failed host.
    return result


def operation_name(node_uid):
    return "host-" + digest(node_uid)[:24]


def local_node_name():
    name = os.environ.get("MAGICSTICK_HOST_NODE_NAME", socket.gethostname().split(".")[0]).strip()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", name):
        raise RuntimeError("Invalid local Kubernetes node name.")
    return name


class Worker:
    def __init__(self, node, report, plan, state_dir=STATE):
        self.node, self.report, self.plan, self.root = node, report, plan, state_dir
        self.path = state_dir / "state.json"
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {"completed": [], "current": None}

    def save(self):
        atomic_json(self.path, self.state)

    def update(self, operation, phase, message):
        current = self.state["current"]
        current.update(phase=phase, message=message, updatedAt=stamp())
        if phase in TERMINAL:
            self.state["completed"] = (self.state["completed"] + [current["requestId"]])[-256:]
        self.save()
        # Commit local state first, then acknowledge it before any side effect.
        kube(["patch", RESOURCE, operation["metadata"]["name"], "-n", NAMESPACE, "--type=merge", "--subresource=status",
              "--patch-file=/dev/stdin", "-o", "json"], {"metadata": {"uid": operation["metadata"]["uid"]}, "status": {
                  "phase": phase, "message": message, "requestId": current["requestId"], "updatedAt": current["updatedAt"],
                  "startedAt": current["startedAt"], "bootId": self.report["bootId"]}})
        print(json.dumps({"event": "host-operation", "action": current["action"], "requestId": current["requestId"], "phase": phase}), flush=True)

    def schedule_power(self, operation, action):
        if Path("/run/systemd/shutdown/scheduled").exists():
            raise RuntimeError("A system shutdown is already scheduled; it will not be replaced.")
        self.state["current"]["scheduledAt"] = time.time()
        phase = "RebootScheduled" if action == "reboot" else "PoweroffScheduled"
        self.update(operation, phase, "An orderly " + action + " is scheduled in one minute. Services on this computer will be interrupted.")
        run(["/usr/sbin/shutdown", "-r" if action == "reboot" else "-P", "+1", "Magic Stick administrator requested host maintenance."])

    def activation(self):
        return kube(["get", "moduleactivations.appliance.magicstick.dev", "amd-gpu", "-n", NAMESPACE, "--ignore-not-found", "-o", "json"]) or {}

    @staticmethod
    def activation_identity(activation):
        return digest({"uid": activation.get("metadata", {}).get("uid"), "spec": activation.get("spec") or {}})

    def request_validation(self, operation):
        current = self.state["current"]
        if current["plan"].get("engineValidationAvailable") is False:
            self.update(operation, "PreparedUnverified", "Experimental host preparation finished. GPU engine validation is unavailable for this multi-AMD layout; no GPU eligibility or support certification was granted.")
            return
        existing = self.activation()
        if self.activation_identity(existing) != current.get("activationBefore"):
            self.update(operation, "Interrupted", "GPU module configuration changed during host preparation. That decision was not overwritten; review and request validation explicitly.")
            return
        # Refresh node evidence before asking the controller to trust this boot.
        run(["/usr/local/sbin/magicstick-gpu-publish"], timeout=90)
        activation = {"apiVersion": "appliance.magicstick.dev/v1alpha1", "kind": "ModuleActivation",
                      "metadata": {"name": "amd-gpu", "namespace": NAMESPACE}, "spec": {"module": "amd-gpu", "enabled": True,
                      "applianceRef": {"name": "local", "namespace": NAMESPACE}, "parameters": {
                          "compatibilityProfile": current["plan"]["gpuProfile"], "allowExperimental": "true",
                          "validationRequest": "host-" + current["requestId"]}}}
        if existing:
            kube(["patch", "moduleactivations.appliance.magicstick.dev", "amd-gpu", "-n", NAMESPACE, "--type=merge", "--patch-file=/dev/stdin", "-o", "json"],
                 {"metadata": {"resourceVersion": existing["metadata"]["resourceVersion"]}, "spec": activation["spec"]})
        else:
            kube(["create", "-f", "-", "-o", "json"], activation)
        current["validationStartedAt"] = time.time()
        current["validationBootId"] = self.report["bootId"]
        self.update(operation, "Validating", "Host is ready. Waiting for Kubernetes GPU registration and separate Ollama/vLLM GPU smoke tests.")

    def reconcile(self, operation):
        if not operation:
            return
        spec, meta = operation.get("spec") or {}, operation["metadata"]
        current = self.state.get("current")
        if not current or current.get("operationUid") != meta.get("uid"):
            if current and current.get("phase") not in TERMINAL:
                raise RuntimeError("A previous local host operation is still active. No second operation will run.")
            if spec.get("requestId") in self.state["completed"]:
                # Replay is acknowledged as rejected, never executed a second time.
                error = "This request identity was already processed. No action was repeated."
            elif operation.get("status", {}).get("phase"):
                error = "Execution state was lost or replaced. Confirm a new operation after reviewing the host."
            else:
                try:
                    validate_request(operation, self.node, self.report, self.plan, time.time())
                    error = ""
                except ValueError as invalid:
                    error = str(invalid)
            self.state["current"] = {"operationUid": meta.get("uid"), "requestId": spec.get("requestId", ""),
                                     "action": spec.get("action", "unknown"), "nodeUid": spec.get("nodeUid"),
                                     "actorHash": spec.get("actorHash", ""),
                                     "initialBootId": self.report["bootId"], "startedAt": stamp(), "plan": requested_plan(self.plan, spec),
                                     "phase": "Accepted", "message": "Host operation accepted."}
            self.save()
            if error:
                self.update(operation, "Rejected", error)
                return
            try:
                if Path("/run/systemd/shutdown/scheduled").exists():
                    raise RuntimeError("A shutdown is already scheduled; host preparation was not started.")
                if spec["action"] in {"reboot", "poweroff"}:
                    self.schedule_power(operation, spec["action"])
                    return
                self.update(operation, "Preparing", "Applying the administrator-approved host profile through Ansible.")
                self.state["current"]["activationBefore"] = self.activation_identity(self.activation())
                self.save()
                approved = self.state["current"]["plan"]
                if approved["packages"]:
                    extra = self.root / "approved-vars.json"
                    atomic_json(extra, {"gpu_compatibility_prepare_host": True, "gpu_compatibility_profile": approved["gpuProfile"],
                                        "gpu_compatibility_package_versions": approved["packages"], "gpu_compatibility_update_cache": True})
                    run(["/usr/bin/ansible-playbook", "-i", "localhost,", "--connection=local", str(BASE / "prepare.yml"), "--extra-vars", "@" + str(extra)], timeout=2400)
                if approved["rebootRequired"]:
                    target = approved["targetKernel"]
                    if not all(Path("/boot", prefix + target).is_file() for prefix in ("vmlinuz-", "initrd.img-")):
                        raise RuntimeError("The reviewed kernel and initramfs were not both installed; reboot was not scheduled.")
                    self.schedule_power(operation, "reboot")
                else:
                    self.request_validation(operation)
            except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
                print(json.dumps({"event": "host-operation-error", "requestId": spec["requestId"], "type": type(error).__name__,
                                  "message": str(error) if isinstance(error, RuntimeError) else "Local execution or timeout failure; no automatic retry."}), file=sys.stderr)
                self.update(operation, "Failed", "Host preparation or power scheduling failed. No automatic retry or reboot will occur. Inspect journalctl -u magicstick-host-management before retrying.")
            return

        phase = current["phase"]
        if phase in TERMINAL:
            if operation.get("status", {}).get("phase") != phase:
                self.update(operation, phase, current["message"])
            return
        if current["nodeUid"] != self.node["metadata"]["uid"]:
            self.update(operation, "Interrupted", "Kubernetes host identity changed. No further action will run.")
            return
        new_boot = current["initialBootId"] != self.report["bootId"]
        if phase in {"Accepted", "Preparing"}:
            self.update(operation, "Interrupted", "Host preparation was interrupted. Review the host and confirm a new request; it will not be retried automatically.")
        elif phase in {"RebootScheduled", "PoweroffScheduled"}:
            if new_boot:
                if current["action"] != "prepare-gpu":
                    self.update(operation, "Succeeded", "A new host boot was observed. The power request will never be repeated; physical power-off cannot be independently confirmed by this host.")
                elif self.report["kernel"]["release"] != current["plan"]["targetKernel"]:
                    self.update(operation, "Failed", "The computer returned with a different kernel. No reboot loop: inspect the bootloader or use the retained previous kernel.")
                else:
                    current["verifyStartedAt"] = time.time()
                    self.update(operation, "Verifying", "Restart detected. Waiting for the GPU host driver to become ready.")
            elif time.time() - current.get("scheduledAt", 0) > 600:
                self.update(operation, "Failed", "No new boot was observed after the scheduled operation. It will not be repeated automatically.")
        elif phase == "Verifying":
            if (self.report.get("nodeAnnotation") or {}).get("hostDriverReady") is True:
                self.request_validation(operation)
            elif time.time() - current.get("verifyStartedAt", 0) > 300:
                self.update(operation, "Failed", "The new kernel started, but GPU host checks did not pass. Inspect hardware diagnostics.")
        elif phase == "Validating":
            self.verify_engines(operation)

    def verify_engines(self, operation):
        current = self.state["current"]
        if current.get("validationBootId") != self.report["bootId"]:
            self.update(operation, "Interrupted", "The host restarted during GPU validation. Confirm a new validation request after inspecting the host.")
            return
        activation = kube(["get", "moduleactivations.appliance.magicstick.dev", "amd-gpu", "-n", NAMESPACE, "--ignore-not-found", "-o", "json"]) or {}
        parameters = activation.get("spec", {}).get("parameters", {})
        if (parameters.get("validationRequest") != "host-" + current["requestId"] or activation.get("spec", {}).get("enabled") is False
                or parameters.get("compatibilityProfile") != current["plan"]["gpuProfile"] or parameters.get("allowExperimental") != "true"):
            self.update(operation, "Interrupted", "GPU profile or validation request changed. The host workflow will not overwrite that decision.")
            return
        appliance = kube(["get", "appliances.appliance.magicstick.dev", "local", "-n", NAMESPACE, "-o", "json"])
        nodes = appliance.get("status", {}).get("hardwareOperators", {}).get("amd-gpu", {}).get("compatibility", {}).get("nodes", [])
        evidence = next((node for node in nodes if node.get("nodeUid") == self.node["metadata"]["uid"]), {})
        validations = evidence.get("validation", {})
        fresh = evidence.get("hostFingerprint") == self.report.get("hardwareFingerprint")
        states = []
        for engine in ("OLlama", "VLLM"):
            item = validations.get(engine, {})
            try:
                timestamp = datetime.fromisoformat(item.get("validatedAt", "").replace("Z", "+00:00")).timestamp()
            except ValueError:
                timestamp = 0
            states.append(item.get("state") if fresh and timestamp >= current["validationStartedAt"] - 1 else "pending")
        if states == ["passed", "passed"] and evidence.get("hostDriverReady") and evidence.get("resourceRegistered"):
            self.update(operation, "Succeeded", "Host preparation and both tiny-model AMD GPU smoke tests passed. Other GPU vendors, mixed-system certification, production runtime adoption and model-specific acceptance remain separate checks.")
        elif "failed" in states or time.time() - current["validationStartedAt"] > 3600:
            self.update(operation, "Failed", "GPU engine validation failed or exceeded one hour. See System / Hardware for per-engine details. Host preparation will not be repeated.")

    def publish(self):
        current = self.state.get("current") or {}
        report = {"schemaVersion": 1, "observedAt": stamp(), "nodeUid": self.node["metadata"]["uid"],
                  "bootId": self.report["bootId"], "kernel": self.report["kernel"]["release"],
                  "plan": self.plan, "actions": ["reboot", "poweroff", "prepare-gpu"],
                  "operation": {key: current[key] for key in ("requestId", "action", "phase", "message", "updatedAt") if key in current}}
        kube(["patch", "node", self.node["metadata"]["name"], "--type=merge", "--patch-file=/dev/stdin", "-o", "json"],
             {"metadata": {"uid": self.node["metadata"]["uid"], "annotations": {ANNOTATION: json.dumps(report, sort_keys=True)}}})


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Host management requires the local root system service.")
    if not Path("/etc/rancher/k3s/k3s.yaml").is_file():
        return 0  # No standalone worker credentials are manufactured here.
    if Path("/var/lib/cloud/instance").exists() and not Path("/var/lib/cloud/instance/boot-finished").exists():
        return 0  # Never disrupt initial cloud-init / base installation.
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / "maintenance.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        node = kube(["get", "node", local_node_name(), "-o", "json"])
        report = json.loads(run(["/usr/local/sbin/magicstick-gpu-preflight", "--json"], timeout=90))
        info = node.get("status", {}).get("nodeInfo", {})
        if info.get("bootID") != report.get("bootId") or info.get("kernelVersion") != report.get("kernel", {}).get("release"):
            return 0  # Kubelet has not yet published this boot; no trusted identity.
        catalog = json.loads((BASE / "profiles.json").read_text())
        plan = build_plan(report, display_gpus(), installed_packages(catalog), catalog, platform.machine())
        worker = Worker(node, report, plan)
        # Publishing a plan must not depend on the CRD already having reconciled.
        worker.publish()
        operation = kube(["get", RESOURCE, operation_name(node["metadata"]["uid"]), "-n", NAMESPACE, "--ignore-not-found", "-o", "json"])
        worker.reconcile(operation)
        worker.publish()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        print("Host management check failed; no unacknowledged action will be retried. Inspect local service state.", file=sys.stderr)
        raise SystemExit(1)
