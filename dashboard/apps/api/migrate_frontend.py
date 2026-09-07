#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Remove retained legacy frontend fields after the React manifest is applied.

Administrator-only, opt-in upgrade tool; not part of the dashboard API image.
Requires an explicit Kubernetes context. Dry-run is the default. It never
deletes a Deployment, ConfigMap, namespace, or runtime resource.
"""
import argparse
import json
import shlex
import subprocess
import sys

DEPLOYMENT = "ai-appliance-dashboard"
LEGACY_CONTAINERS = {"nginx", "renderer"}
LEGACY_CONFIGMAPS = {"ai-appliance-dashboard-nginx", "ai-appliance-dashboard-renderer"}
LEGACY_EMPTY_DIRS = {"html", "nginx-cache", "nginx-run", "renderer-tmp"}
RELOAD_ANNOTATION = "configmap.reloader.stakater.com/reload"


def pointer(value):
    return value.replace("~", "~0").replace("/", "~1")


def migration_patch(document):
    if document.get("kind") != "Deployment" or document["metadata"]["name"] != DEPLOYMENT:
        raise ValueError("The primary dashboard Deployment is required.")
    pod = document["spec"]["template"]["spec"]
    containers = pod["containers"]
    web = next((item for item in containers if item["name"] == "web"), None)
    if (not web or not web.get("image", "").startswith("ghcr.io/qualityminds/magicstick-dashboard:")
            or web.get("volumeMounts") != [{"name": "tmp", "mountPath": "/tmp"}]):
        raise ValueError("Reconcile the standard React frontend before migrating; its web container must use only /tmp.")
    kept = [item for item in containers if item["name"] not in LEGACY_CONTAINERS]
    kept += pod.get("initContainers", [])
    used = {mount["name"] for item in kept for mount in item.get("volumeMounts", [])}
    patch = []
    for index in reversed(range(len(containers))):
        if containers[index]["name"] in LEGACY_CONTAINERS:
            patch.append({"op": "remove", "path": f"/spec/template/spec/containers/{index}"})
    volumes = pod.get("volumes", [])
    for index in reversed(range(len(volumes))):
        volume = volumes[index]
        legacy = (volume["name"] in LEGACY_EMPTY_DIRS and "emptyDir" in volume
                  or volume.get("configMap", {}).get("name") in LEGACY_CONFIGMAPS)
        if legacy and volume["name"] not in used:
            patch.append({"op": "remove", "path": f"/spec/template/spec/volumes/{index}"})
    annotations = document["metadata"].get("annotations", {})
    if RELOAD_ANNOTATION in annotations:
        original = annotations[RELOAD_ANNOTATION]
        names = [name.strip() for name in original.split(",") if name.strip()]
        retained = [name for name in names if name not in LEGACY_CONFIGMAPS]
        if names != retained:
            path = "/metadata/annotations/" + pointer(RELOAD_ANNOTATION)
            patch.append({"op": "replace", "path": path, "value": ",".join(retained)} if retained
                         else {"op": "remove", "path": path})
    old_revision = "appliance.magicstick.dev/dashboard-config-revision"
    if old_revision in document["spec"]["template"].get("metadata", {}).get("annotations", {}):
        patch.append({"op": "remove", "path": "/spec/template/metadata/annotations/" + pointer(old_revision)})
    if patch:
        patch.insert(0, {"op": "test", "path": "/metadata/resourceVersion", "value": document["metadata"]["resourceVersion"]})
    return patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--namespace", default="dashboard")
    parser.add_argument("--kubectl", default="kubectl", help="Command prefix, e.g. 'k3s kubectl'")
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed cleanup instead of a dry-run")
    args = parser.parse_args()
    command = shlex.split(args.kubectl) + ["--context", args.context, "-n", args.namespace]
    raw = subprocess.check_output(command + ["get", "deployment", DEPLOYMENT, "-o", "json"], text=True)
    patch = migration_patch(json.loads(raw))
    if not patch:
        print("No retained legacy frontend fields found.")
        return
    print(json.dumps(patch, indent=2), flush=True)
    if not args.apply:
        print("Dry-run only. Review the patch and repeat with --apply.")
        return
    subprocess.run(command + ["patch", "deployment", DEPLOYMENT, "--type=json", "-p", json.dumps(patch)], check=True)
    print("Legacy frontend fields removed; web container and unrelated resources preserved.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Migration stopped: {error}", file=sys.stderr)
        sys.exit(1)
