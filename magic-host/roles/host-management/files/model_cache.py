"""Fixed-scope model cache inventory and deletion. No caller-supplied paths."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time

CACHES = (
    ("huggingface", "Hugging Face / vLLM", "/root/.cache/huggingface/hub"),
    ("ollama", "Ollama", "/root/.ollama/models"),
)


def validate_cleanup(payload, capability):
    if not capability or capability.get("supported") is not True:
        raise ValueError("Model cache management requires the current host worker.")
    if capability.get("blocked") is not False:
        raise ValueError(capability.get("message") or "Stop local models before clearing the cache.")
    if not re.fullmatch(r"[a-f0-9]{64}", str(payload.get("planId", ""))) or payload["planId"] != capability.get("id"):
        raise ValueError("Cache inventory changed. Refresh before clearing it.")
    if payload.get("allowExperimental") or payload.get("experimentMode") or any(
            field in payload for field in ("gpuMemory", "network", "networkRef", "updateScope", "updatePolicy")):
        raise ValueError("Cache cleanup does not accept other host settings.")
    if not capability.get("reclaimableBytes", 0):
        raise ValueError("The model cache is already empty.")


@contextmanager
def directory(path):
    """Open each component without following symlinks, including cache parents."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        yield fd
    finally:
        os.close(fd)


def entries(kind, fd):
    return sorted(name for name in os.listdir(fd) if
                  (kind == "huggingface" and re.fullmatch(r"models--[A-Za-z0-9_.-]+", name))
                  or (kind == "ollama" and name in {"blobs", "manifests"}))


def check_mounts(path):
    mountinfo = Path("/proc/self/mountinfo")
    if not mountinfo.exists():
        return
    prefix = str(path).rstrip("/") + "/"
    for line in mountinfo.read_text().splitlines():
        mount = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), line.split()[4])
        if mount.startswith(prefix):
            raise ValueError("A nested mount in the model cache needs manual review.")


def allocated(fd, name, device, seen, deadline=None):
    if len(seen) >= 100000 or (deadline is not None and time.monotonic() > deadline):
        raise ValueError("Cache inspection exceeded its safety limit; no cleanup was started.")
    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if info.st_dev != device:
        raise ValueError("A nested filesystem in the model cache needs manual review.")
    identity = (info.st_dev, info.st_ino)
    if identity in seen:
        return 0
    seen.add(identity)
    result = info.st_blocks * 512
    if stat.S_ISDIR(info.st_mode):
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            result += sum(allocated(child, item, device, seen, deadline) for item in os.listdir(child))
        finally:
            os.close(child)
    return result


def cache_path_overlap(path):
    if not isinstance(path, str) or not path.startswith("/"):
        return False
    path = os.path.normpath(path)
    return any(path == root or path.startswith(root + "/") or root.startswith(path.rstrip("/") + "/")
               for _kind, _label, root in CACHES)


def blockers(kube, node_name):
    # Enabled unpinned models can be scheduled on this node later, including
    # scale-to-zero KubeAI models. Conservatively keep their shared cache.
    activations = kube(["get", "modelactivations.appliance.magicstick.dev", "-A", "-o", "json"])
    pods = kube(["get", "pods", "-A", "-o", "json"])
    models = kube(["get", "models.kubeai.org", "-A", "-o", "json"])
    if any(not isinstance(value, dict) or not isinstance(value.get("items"), list) for value in (activations, pods, models)):
        raise ValueError("Model workload inventory is unavailable.")
    busy = False
    for model in activations["items"]:
        spec = model.get("spec", {})
        if spec.get("enabled", True) is False or spec.get("type", "local") != "local":
            continue
        pinned = spec.get("local", {}).get("freetoken", {}).get("gpuDevice", "")
        if not pinned.startswith("node:") or pinned == "node:" + node_name:
            busy = True
    # KubeAI resources may still create Pods after an activation was stopped.
    busy = busy or bool(models["items"])
    for pod in pods["items"]:
        spec, meta = pod.get("spec", {}), pod.get("metadata", {})
        if spec.get("nodeName") not in (None, "", node_name):
            continue
        labels = meta.get("labels", {})
        uses_cache = any(cache_path_overlap(v.get("hostPath", {}).get("path", ""))
                         for v in spec.get("volumes", []))
        if labels.get("app") == "model" or labels.get("app.kubernetes.io/name") == "freetoken" or uses_cache:
            # Terminated Pods are kept protected until Kubernetes removes them.
            busy = True
    return busy, pods["items"]


def collect(node, kube):
    result = {"supported": False, "blocked": True, "reclaimableBytes": 0, "caches": []}
    try:
        busy, pods = blockers(kube, node["metadata"]["name"])
        disk = shutil.disk_usage("/")
        result.update(totalBytes=disk.total, freeBytes=disk.free)
        identities = []
        deadline = time.monotonic() + 10
        for kind, label, path in CACHES:
            used = 0
            try:
                with directory(path) as fd:
                    check_mounts(path)
                    info = os.fstat(fd)
                    identities.append([kind, info.st_dev, info.st_ino])
                    seen = set()
                    used = sum(allocated(fd, name, info.st_dev, seen, deadline) for name in entries(kind, fd))
            except FileNotFoundError:
                identities.append([kind, None])
            result["caches"].append({"id": kind, "name": label, "usedBytes": used, "clearable": True})
            result["reclaimableBytes"] += used
        temporary = 0
        for pod in pods:
            meta, spec = pod.get("metadata", {}), pod.get("spec", {})
            if (spec.get("nodeName") != node["metadata"]["name"]
                    or meta.get("labels", {}).get("app.kubernetes.io/name") != "freetoken"
                    or not re.fullmatch(r"[a-f0-9-]{36}", str(meta.get("uid", "")))
                    or not any(v.get("name") == "runtime-cache" and v.get("emptyDir") == {} for v in spec.get("volumes", []))):
                continue
            path = "/var/lib/kubelet/pods/" + meta["uid"] + "/volumes/kubernetes.io~empty-dir/runtime-cache"
            try:
                with directory(path) as fd:
                    seen = set()
                    temporary += sum(allocated(fd, name, os.fstat(fd).st_dev, seen, deadline) for name in os.listdir(fd))
            except FileNotFoundError:
                pass
        result["caches"].append({"id": "freetoken", "name": "FreeToken (temporary)", "usedBytes": temporary, "clearable": False})
        result.update(supported=True, blocked=busy, message="Stop local model deployments before clearing shared caches." if busy else "",
                      id=hashlib.sha256(json.dumps([1, node["metadata"]["uid"], identities], sort_keys=True).encode()).hexdigest())
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        result.update(supported=False, blocked=True, message="Cache or workload inventory is unavailable. No cleanup is allowed.")
    return result


def clear(node, kube, payload):
    """Called under the host maintenance lock; recheck live workload evidence."""
    before = collect(node, kube)
    validate_cleanup(payload, before)
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ValueError("Safe cache deletion is unavailable on this host.")
    for kind, _label, path in CACHES:
        # Never clear FreeToken's live emptyDir or entire HOME/cache directories.
        try:
            with directory(path) as fd:
                for name in entries(kind, fd):
                    check_mounts(path)
                    if blockers(kube, node["metadata"]["name"])[0]:
                        raise ValueError("A model started during cleanup. Remaining cache files were kept.")
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    allocated(fd, name, os.fstat(fd).st_dev, set(), time.monotonic() + 10)
                    if stat.S_ISDIR(info.st_mode):
                        shutil.rmtree(name, dir_fd=fd)
                    else:
                        os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            continue
    return collect(node, kube)
