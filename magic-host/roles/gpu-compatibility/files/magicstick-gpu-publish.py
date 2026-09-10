#!/usr/bin/env python3
"""Publish bounded host evidence to the local K3s Node, never GPU eligibility."""

import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys


ANNOTATION = "appliance.magicstick.dev/gpu-host-preflight"
K3S = "/usr/local/bin/k3s"
PREFLIGHT = "/usr/local/sbin/magicstick-gpu-preflight"


def execute(argv, stdin=None, timeout=25):
    result = subprocess.run(argv, input=stdin, text=True, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError("Host evidence collection or local Kubernetes request failed")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def evidence_patch(report, node):
    info = node.get("status", {}).get("nodeInfo", {})
    if report.get("kernel", {}).get("release") != info.get("kernelVersion"):
        raise RuntimeError("Node kernel metadata does not match this host")
    if not report.get("bootId") or report["bootId"] != info.get("bootID"):
        raise RuntimeError("Node boot identity does not match this host")
    annotation = report.get("nodeAnnotation")
    if annotation is not None:
        if not node.get("metadata", {}).get("uid"):
            raise RuntimeError("Node UID is unavailable")
        annotation = {**annotation, "nodeUid": node["metadata"]["uid"]}
        annotation = json.dumps(annotation, sort_keys=True, separators=(",", ":"))
    existing = node.get("metadata", {}).get("annotations", {})
    if annotation is None and ANNOTATION not in existing:
        return None
    return {"metadata": {"annotations": {ANNOTATION: annotation}}}


def main():
    if not Path(K3S).is_file() or not Path("/etc/rancher/k3s/k3s.yaml").is_file():
        print("GPU host evidence: local K3s is not ready; retry on next timer run.")
        return 0
    node_name = os.environ.get("MAGICSTICK_GPU_NODE_NAME", socket.gethostname().split(".")[0]).strip()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", node_name):
        print("GPU host evidence: invalid local Kubernetes node name.", file=sys.stderr)
        return 1
    try:
        report = execute([PREFLIGHT, "--json"], timeout=60)
        node = execute([K3S, "kubectl", "--cache-dir=/tmp/magicstick-gpu-kube-cache", "--request-timeout=20s", "get", "node", node_name, "-o", "json"])
        patch = evidence_patch(report, node)
        if patch is not None:
            execute([K3S, "kubectl", "--cache-dir=/tmp/magicstick-gpu-kube-cache", "--request-timeout=20s", "patch", "node", node_name, "--type=merge", "--patch-file=/dev/stdin", "-o", "json"], stdin=json.dumps(patch))
        print("GPU host evidence refreshed; no eligibility labels changed.")
        return 0
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        # Keep raw subprocess output, kubeconfig contents and environment private.
        message = str(error) if isinstance(error, RuntimeError) else "Preflight publication failed; retry on next timer run"
        print(f"GPU host evidence: {message}.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
