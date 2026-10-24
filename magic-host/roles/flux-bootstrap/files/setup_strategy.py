# SPDX-License-Identifier: BUSL-1.1
"""Migrate only the Flux-owned setup Deployment before identity reconciliation.

SSA does not remove legacy server-defaulted rollingUpdate fields when switching
to Recreate. A UID/resourceVersion-bound JSON patch clears the whole strategy
atomically, without replacing the Deployment or changing its Pod template.
"""
import argparse
import json
import subprocess


NAME = "magicstick-setup"
NAMESPACE = "identity-system"
TARGET = {"type": "Recreate"}
OWNER = {"kustomize.toolkit.fluxcd.io/name": "identity-pilot",
         "kustomize.toolkit.fluxcd.io/namespace": "flux-system"}


def migration_patch(deployment):
    if not deployment:
        return None  # New installation: Flux creates the canonical Deployment.
    meta, spec = deployment.get("metadata", {}), deployment.get("spec", {})
    if (deployment.get("apiVersion") != "apps/v1" or deployment.get("kind") != "Deployment"
            or meta.get("name") != NAME or meta.get("namespace") != NAMESPACE
            or not meta.get("uid") or not meta.get("resourceVersion")
            or meta.get("deletionTimestamp")
            or any(meta.get("labels", {}).get(k) != v for k, v in OWNER.items())
            or spec.get("selector") != {"matchLabels": {"app.kubernetes.io/name": NAME}}
            or type(spec.get("replicas")) is not int or spec["replicas"] not in (0, 1)):
        raise ValueError("Setup strategy migration refused an unexpected Deployment identity or shape.")
    strategy = spec.get("strategy", {})
    if strategy == TARGET:
        return None
    if strategy.get("type") != "RollingUpdate" or set(strategy) - {"type", "rollingUpdate"}:
        raise ValueError("Setup strategy migration refused an unexpected rollout strategy.")
    return [
        {"op": "test", "path": "/metadata/uid", "value": meta["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": meta["resourceVersion"]},
        {"op": "test", "path": "/spec/strategy", "value": strategy},
        {"op": "replace", "path": "/spec/strategy", "value": TARGET},
    ]


def migrate(command):
    before = command(["get", "deployment", NAME, "--ignore-not-found", "-o", "json"])
    patch = migration_patch(before)
    if patch is None:
        return False
    command(["patch", "deployment", NAME, "--type=json", "--patch-file=/dev/stdin", "-o", "json"], patch)
    after = command(["get", "deployment", NAME, "-o", "json"])
    if (after.get("metadata", {}).get("uid") != before["metadata"]["uid"]
            or after.get("spec") != {**before["spec"], "strategy": TARGET}):
        raise ValueError("Setup strategy migration could not verify the unchanged Deployment and Recreate strategy.")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubectl", required=True)
    parser.add_argument("--subcommand", default="kubectl")
    parser.add_argument("--kubeconfig", required=True)
    args = parser.parse_args()

    def command(arguments, body=None):
        result = subprocess.run([args.kubectl, *([args.subcommand] if args.subcommand else []),
                                 "--kubeconfig", args.kubeconfig, "--request-timeout=20s",
                                 "--namespace", NAMESPACE, *arguments],
                                input=json.dumps(body) if body is not None else None,
                                capture_output=True, text=True, timeout=30, check=False)
        if result.returncode:
            # Never include Kubernetes payloads or credentials in public logs.
            raise ValueError("Setup strategy migration Kubernetes " + arguments[0] + " failed; no automatic retry of a stale patch.")
        return json.loads(result.stdout) if result.stdout.strip() else None

    try:
        changed = migrate(command)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, (str(error) if isinstance(error, ValueError)
                        else "Setup strategy migration could not contact Kubernetes.") + "\n")
    print("setup-strategy: " + ("changed" if changed else "unchanged"))


if __name__ == "__main__":
    main()
