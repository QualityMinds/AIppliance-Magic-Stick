#!/usr/bin/env python3
"""Explicit local Rancher contract test. Never installs a host worker or runs power commands.

Creates a unique namespace and, only if absent, the HostOperation CRD. Uses real
Kubernetes schema/RBAC/status with a temporary local worker state and a fake power
executor. Deletes only objects created by this test. No Node is patched.
"""

import argparse
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid
from unittest.mock import patch

ROLE = Path(__file__).resolve().parents[1]
REPO = ROLE.parents[2]
sys.path.insert(0, str(ROLE / "files"))
import host_worker
import gpu_memory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", choices=["rancher-desktop"], required=True)
    args = parser.parse_args()
    namespace = "magicstick-host-contract-" + uuid.uuid4().hex[:10]
    crd_name = "hostoperations.appliance.magicstick.dev"
    crd_file = REPO / "magic-cluster/platform/magicstick-operator/crds" / (crd_name + ".yaml")
    created_crd = False
    created_namespace = False
    checks = 0

    def execute(arguments, body=None, ok=True, actor=False):
        command = ["kubectl", "--context", args.context, "--request-timeout=20s"]
        if actor:
            command.append(f"--as=system:serviceaccount:{namespace}:dashboard-test")
        result = subprocess.run(command + arguments, input=json.dumps(body) if body is not None else None,
                                text=True, capture_output=True, check=False, timeout=30)
        if ok and result.returncode:
            raise RuntimeError("Local Kubernetes test failed: " + result.stderr[:2000])
        return result

    def kube(arguments, data=None):
        result = execute(arguments, data)
        return json.loads(result.stdout) if result.stdout.strip() else None

    try:
        existing = execute(["get", "crd", crd_name, "--ignore-not-found", "-o", "name"]).stdout.strip()
        if not existing:
            execute(["create", "-f", str(crd_file)])
            created_crd = True
            execute(["wait", "--for=condition=Established", "crd/" + crd_name, "--timeout=20s"])
        execute(["create", "namespace", namespace])
        created_namespace = True
        role = {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role", "metadata": {"name": "host-test", "namespace": namespace},
                "rules": [{"apiGroups": ["appliance.magicstick.dev"], "resources": ["hostoperations"], "verbs": ["get", "list", "create", "delete"]}]}
        kube(["create", "-f", "-", "-o", "json"], role)
        kube(["create", "-f", "-", "-o", "json"], {"apiVersion": role["apiVersion"], "kind": "RoleBinding", "metadata": role["metadata"],
             "subjects": [{"kind": "ServiceAccount", "name": "dashboard-test", "namespace": namespace}],
             "roleRef": {"kind": "Role", "name": "host-test", "apiGroup": "rbac.authorization.k8s.io"}})
        for verb, resource, expected in [("create", "hostoperations", "yes"), ("patch", "hostoperations/status", "no"), ("patch", "nodes", "no"), ("create", "pods", "no")]:
            result = execute(["auth", "can-i", verb, resource, "-n", namespace], actor=True, ok=False)
            assert result.stdout.strip() == expected, (verb, resource, result.stdout)
            checks += 1

        spec = {"action": "reboot", "nodeName": "example-node", "nodeUid": "example-node-uid", "bootId": "boot-a", "requestId": uuid.uuid4().hex,
                "planId": "", "allowExperimental": False, "experimentMode": False, "acknowledgeDisruption": True, "actorHash": "a" * 64}
        document = {"apiVersion": "appliance.magicstick.dev/v1alpha1", "kind": "HostOperation",
                    "metadata": {"name": host_worker.operation_name(spec["nodeUid"]), "namespace": namespace}, "spec": spec}
        operation = json.loads(execute(["create", "-f", "-", "-o", "json"], document, actor=True).stdout)
        checks += 1
        immutable = execute(["patch", crd_name, operation["metadata"]["name"], "-n", namespace, "--type=merge", "--patch-file=/dev/stdin"],
                            {"spec": {"action": "poweroff"}}, ok=False)
        assert immutable.returncode != 0 and "immutable" in immutable.stderr
        checks += 1
        for changes in ({"action": "shell"}, {"acknowledgeDisruption": False}, {"experimentMode": True}, {"requestId": "unsafe/id"},
                        {"action": "prepare-gpu", "allowExperimental": True, "planId": ""}):
            bad = copy.deepcopy(document); bad["metadata"]["name"] = "invalid-" + uuid.uuid4().hex[:12]; bad["spec"].update(changes)
            rejected = execute(["create", "--dry-run=server", "-f", "-"], bad, ok=False)
            assert rejected.returncode != 0, changes
            checks += 1

        report = {"bootId": "boot-a", "kernel": {"release": "test-kernel"}}
        node = {"metadata": {"name": spec["nodeName"], "uid": spec["nodeUid"]}}
        power_commands = []
        def fake_run(command, **kwargs):
            power_commands.append(command)
            return ""
        with tempfile.TemporaryDirectory() as state, patch.object(host_worker, "NAMESPACE", namespace), patch.object(host_worker, "kube", side_effect=kube), patch.object(host_worker, "run", side_effect=fake_run):
            first = host_worker.Worker(node, report, {}, Path(state))
            first.reconcile(operation)
            observed = kube(["get", crd_name, operation["metadata"]["name"], "-n", namespace, "-o", "json"])
            assert observed["status"]["phase"] == "RebootScheduled"
            checks += 1
            host_worker.Worker(node, report, {}, Path(state)).reconcile(observed)
            assert len(power_commands) == 1
            checks += 1
            report["bootId"] = "boot-b"
            host_worker.Worker(node, report, {}, Path(state)).reconcile(observed)
            completed = kube(["get", crd_name, operation["metadata"]["name"], "-n", namespace, "-o", "json"])
            assert completed["status"]["phase"] == "Succeeded" and len(power_commands) == 1
            assert power_commands[0][0] == "/usr/sbin/shutdown"
            checks += 1
        # Real CRD admission/status, entirely fake host/firmware/Ansible execution.
        memory_document = copy.deepcopy(document)
        memory_document["metadata"]["name"] = "memory-" + uuid.uuid4().hex[:12]
        memory_document["spec"].update(action="configure-gpu-memory", requestId=uuid.uuid4().hex,
                                       allowExperimental=True, planId="b" * 64,
                                       gpuMemory={"carveoutIndex": 0, "dynamicLimitMi": 65536})
        memory_operation = json.loads(execute(["create", "-f", "-", "-o", "json"], memory_document, actor=True).stdout)
        assert memory_operation["spec"]["gpuMemory"] == {"carveoutIndex": 0, "dynamicLimitMi": 65536}
        checks += 1
        for changes in ({"gpuMemory": {}}, {"gpuMemory": {"carveoutIndex": True, "dynamicLimitMi": 1024}},
                        {"gpuMemory": {"carveoutIndex": 0, "dynamicLimitMi": 0}}, {"allowExperimental": False}, {"experimentMode": True}):
            bad = copy.deepcopy(memory_document); bad["metadata"]["name"] = "invalid-memory-" + uuid.uuid4().hex[:8]
            bad["spec"].update(changes)
            rejected = execute(["create", "--dry-run=server", "-f", "-"], bad, ok=False)
            assert rejected.returncode != 0, changes
            checks += 1
        memory_report = {"bootId": "boot-a", "kernel": {"release": "test-kernel"}, "os": {"id": "ubuntu", "versionId": "24.04"},
                         "hardwareFingerprint": "f" * 64,
                         "systemMemory": {"totalBytes": 64000 * gpu_memory.MIB, "ttmLimitBytes": 32768 * gpu_memory.MIB}}
        memory_capability = {"id": "b" * 64, "supported": True, "pciAddress": "0000:01:00.0", "currentCarveoutIndex": 1,
                             "currentCarveoutMi": 32768, "systemMemoryMi": 64000, "currentDynamicLimitMi": 32768,
                             "options": [{"index": 0, "label": "Minimum (512 MB)", "sizeMi": 512}, {"index": 1, "label": "High (32 GB)", "sizeMi": 32768}]}
        configuration = {"id": "initial", "conflicts": False, "managedPages": None}
        with tempfile.TemporaryDirectory() as state:
            memory_commands, firmware_writes = [], []
            def fake_memory_run(command, **kwargs):
                memory_commands.append(command)
                if command[0] == "/usr/bin/ansible-playbook":
                    approved = json.loads((Path(state) / "approved-memory-vars.json").read_text())
                    assert approved["gpu_compatibility_package_versions"] == {}
                    assert approved["gpu_compatibility_update_cache"] is False
                    configuration.update(id="managed", managedPages=approved["gpu_compatibility_ttm_limit_mib"] * 256)
                return ""
            with patch.object(host_worker, "NAMESPACE", namespace), patch.object(host_worker, "kube", side_effect=kube), \
                    patch.object(host_worker, "run", side_effect=fake_memory_run), \
                    patch.object(host_worker, "display_gpus", return_value=["1002:1586"]), \
                    patch.object(gpu_memory, "collect", side_effect=lambda *args: copy.deepcopy(memory_capability)), \
                    patch.object(gpu_memory, "configuration", side_effect=lambda: dict(configuration)), \
                    patch.object(gpu_memory, "write_carveout", side_effect=lambda *args, **kwargs: firmware_writes.append(args)):
                def reconcile_memory():
                    observed = kube(["get", crd_name, memory_operation["metadata"]["name"], "-n", namespace, "-o", "json"])
                    worker = host_worker.Worker(node, memory_report, {}, Path(state), memory=memory_capability)
                    worker.reconcile(observed)
                    return worker.state["current"]["phase"]
                assert reconcile_memory() == "RebootScheduled"
                assert len(firmware_writes) == 1 and len(memory_commands) == 1
                checks += 1
                assert reconcile_memory() == "RebootScheduled" and len(memory_commands) == 1
                checks += 1
                memory_report.update(bootId="boot-b", systemMemory={"totalBytes": 96000 * gpu_memory.MIB, "ttmLimitBytes": 48000 * gpu_memory.MIB})
                memory_capability.update(currentCarveoutIndex=0, currentCarveoutMi=512, systemMemoryMi=96000, currentDynamicLimitMi=48000)
                assert reconcile_memory() == "Verifying"
                assert reconcile_memory() == "RebootScheduled"
                assert len(memory_commands) == 3 and len(firmware_writes) == 1
                checks += 1
                memory_report.update(bootId="boot-c", systemMemory={"totalBytes": 96000 * gpu_memory.MIB, "ttmLimitBytes": 65536 * gpu_memory.MIB})
                memory_capability.update(currentDynamicLimitMi=65536)
                assert reconcile_memory() == "Verifying"
                assert reconcile_memory() == "Succeeded"
                assert len(memory_commands) == 3 and len(firmware_writes) == 1
                checks += 1
                assert reconcile_memory() == "Succeeded" and len(memory_commands) == 3
                checks += 1
        print(json.dumps({"passed": checks, "realPowerCommands": 0, "realFirmwareWrites": 0, "nodesModified": 0, "context": args.context}))
    finally:
        if created_namespace:
            execute(["delete", "namespace", namespace, "--wait=false"])
        if created_crd:
            execute(["delete", "crd", crd_name, "--wait=false"])


if __name__ == "__main__":
    main()
