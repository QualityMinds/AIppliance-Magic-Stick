#!/usr/bin/env python3
# SPDX-License-Identifier: BUSL-1.1
"""Host-owned software channel inspection, bounded execution and local recovery.

The API supplies a ref, never a repository URL, executable or filesystem path.
Registry checks fetch manifests/configuration only, not model or image layers.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from software_contract import PREVIEW_TTL, digest, selection, validate_request

STATE = Path("/var/lib/magicstick/host-management")
METADATA = Path("/etc/default/ai-appliance-repo")
BASE = Path("/usr/local/lib/magicstick/host-management")
RUNNER = Path("/usr/local/sbin/ai-appliance-converge")
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8",
       "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1"}
CRITICAL = {
    "Dashboard": ("magic-cluster/apps/dashboard/deployment.yaml", "image"),
    "Dashboard API": ("magic-cluster/apps/dashboard/api-deployment.yaml", "image"),
    "Console": ("magic-host/roles/dashboard-console/defaults/main.yml", "dashboard_console_image"),
    "Operator runtime": ("magic-cluster/platform/magicstick-operator/deployment.yaml", "image"),
}
TERMINAL = {"Succeeded", "Failed", "Interrupted"}


def atomic(path, text):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    atomic(path, json.dumps(value, sort_keys=True))


def read_json(path):
    return json.loads(path.read_text()) if path.is_file() else {}


def command(args, timeout=60, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, env=ENV, check=False, **kwargs)
    if result.returncode:
        print(result.stderr[-8192:], file=sys.stderr)
        raise ValueError("A software command failed. Inspect the magicstick-software-channel journal for details.")
    return result.stdout.strip()


def metadata(path=None):
    values = {}
    for line in (path or METADATA).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        key, sep, raw = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
            raise ValueError("Repository metadata must contain literal KEY=value assignments.")
        parts = shlex.split(raw, comments=True)
        if len(parts) > 1:
            raise ValueError("Repository metadata contains an invalid value.")
        values[key] = parts[0] if parts else ""
    return values


def config(values=None):
    values = metadata() if values is None else values
    mode = values.get("FLUX_BOOTSTRAP_MODE", "readonly-public")
    selected = selection({"kind": values.get("MAGICSTICK_PUBLIC_REF_KIND", "branch"),
                          "value": values.get("MAGICSTICK_PUBLIC_REF", "main")})
    repo = values.get("MAGICSTICK_PUBLIC_REPO", "https://github.com/QualityMinds/AIppliance-Magic-Stick.git")
    url = urllib.parse.urlsplit(repo)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Managed channels require a public HTTPS repository without embedded credentials.")
    checkout = values.get("MAGICSTICK_PUBLIC_CHECKOUT", "/opt/ai-appliance/magicstick")
    if not Path(checkout).is_absolute():
        raise ValueError("The host checkout must be an absolute local path.")
    result = {"mode": mode, "repository": repo, "checkout": checkout, "channel": selected,
              "syncPath": values.get("FLUX_PUBLIC_SYNC_PATH", "magic-cluster/flux/entrypoints/single-node")}
    result["id"] = digest(result)
    return result


def save_selection(selected):
    selected = selection(selected)
    replacements = {"MAGICSTICK_PUBLIC_REF": selected["value"], "MAGICSTICK_PUBLIC_REF_KIND": selected["kind"]}
    lines, seen = [], set()
    for line in METADATA.read_text().splitlines():
        match = re.match(r"\s*(?:export\s+)?(MAGICSTICK_PUBLIC_REF(?:_KIND)?)=", line)
        if match:
            key = match.group(1)
            if key not in seen:
                lines.append(key + "=" + shlex.quote(replacements[key]))
                seen.add(key)
        else:
            lines.append(line)
    lines.extend(key + "=" + shlex.quote(value) for key, value in replacements.items() if key not in seen)
    atomic(METADATA, "\n".join(lines) + "\n")


def git_commit(checkout):
    try:
        return command(["git", "-C", str(checkout), "rev-parse", "HEAD"])
    except (ValueError, OSError):
        return ""


def operation_status():
    result = read_json(STATE / "software-operation.json")
    if result and result.get("phase") not in TERMINAL:
        try:
            same = Path(f"/proc/{result['pid']}/stat").read_text().split(")", 1)[1].split()[19] == result.get("processStart")
        except (OSError, KeyError):
            same = False
        if not same:
            result.update(phase="Interrupted", message="Software operation stopped. Review the journal and use the saved recovery command if needed.")
    return result


def status():
    try:
        current = config()
        if current["mode"] != "readonly-public":
            return {"supported": False, "message": "This installation is managed by an external GitOps repository."}
        operation = operation_status()
        return {"supported": True, "id": current["id"], "channel": current["channel"],
                "hostCommit": git_commit(current["checkout"]),
                "busy": bool(operation and operation.get("phase") not in TERMINAL),
                "blocked": (STATE / "software-blocked.json").exists(),
                "preview": read_json(STATE / "software-preview.json"),
                "operation": operation,
                "previousCommit": read_json(STATE / "software-previous.json").get("commit", ""),
                "observed": read_json(STATE / "software-observed.json")}
    except (OSError, ValueError):
        return {"supported": False, "message": "Software channel management requires valid local repository metadata."}


def resolve(repository, selected, git_dir):
    selected = selection(selected)
    git_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not (git_dir / "HEAD").exists():
        command(["git", "init", "--bare", str(git_dir)])
    ref = selected["value"] if selected["kind"] == "commit" else "refs/" + ("heads/" if selected["kind"] == "branch" else "tags/") + selected["value"]
    try:
        command(["git", "--git-dir=" + str(git_dir), "-c", "http.version=HTTP/1.1", "fetch", "--force", "--no-tags", "--depth=1", "--", repository, ref], timeout=180)
        commit = command(["git", "--git-dir=" + str(git_dir), "rev-parse", "FETCH_HEAD^{commit}"])
    except ValueError:
        raise ValueError("The selected branch, tag or commit could not be fetched from the configured repository.") from None
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or selected["kind"] == "commit" and selected["value"] != commit:
        raise ValueError("Git returned a different commit than requested.")
    return commit


def source(git_dir, commit, path):
    return command(["git", "--git-dir=" + str(git_dir), "show", commit + ":" + path])


def image_inventory(git_dir, commit):
    try:
        contract = json.loads(source(git_dir, commit, "magic-host/software-channel.json"))
        if contract != {"schemaVersion": 1, "managementContract": 1}:
            raise ValueError("Unsupported software management contract.")
    except (ValueError, json.JSONDecodeError):
        raise ValueError("This revision predates compatible channel management. Install a channel-capable revision first; older releases require local recovery.") from None
    images = []
    for name, (path, key) in CRITICAL.items():
        found = re.findall(r"^\s*" + key + r":\s*([^\s#]+)", source(git_dir, commit, path), re.M)
        if len(found) != 1 or not re.fullmatch(r"[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}", found[0]):
            raise ValueError(name + " must have one published immutable image digest in the selected revision.")
        images.append({"name": name, "image": found[0]})
    revisions = [re.search(r"(?:api-|cli-)?sha-([a-f0-9]{40})@", item["image"]) for item in images[:3]]
    if any(item is None for item in revisions) or len({item.group(1) for item in revisions}) != 1:
        raise ValueError("Dashboard, API and console images must come from the same build.")
    return images


def registry_image(image, architecture):
    name, expected = image.split("@", 1)
    first, _, rest = name.partition("/")
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        host, repository = first, rest
    else:
        host, repository = "registry-1.docker.io", name if "/" in name else "library/" + name
    repository = re.sub(r":[^/]+$", "", repository)
    if host == "docker.io":
        host = "registry-1.docker.io"
    root = "https://" + host + "/v2/" + repository
    headers = {"Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"}

    def fetch(url):
        try:
            response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25)
        except urllib.error.HTTPError as error:
            if error.code != 401 or "Authorization" in headers:
                raise
            challenge = error.headers.get("WWW-Authenticate", "")
            fields = dict(re.findall(r'(\w+)="([^"\r\n]+)"', challenge))
            realm = fields.pop("realm", "")
            auth = urllib.parse.urlsplit(realm)
            if not challenge.lower().startswith("bearer ") or auth.scheme != "https" or not auth.hostname or auth.username:
                raise ValueError("Registry authentication is unsupported.")
            fields["scope"] = "repository:" + repository + ":pull"
            token_url = realm + ("&" if "?" in realm else "?") + urllib.parse.urlencode(fields)
            with urllib.request.urlopen(token_url, timeout=25) as token_response:
                token_data = json.loads(token_response.read(1024 * 1024))
                token = token_data.get("token") or token_data.get("access_token")
            if not isinstance(token, str) or not token:
                raise ValueError("Registry did not grant public image access.")
            headers["Authorization"] = "Bearer " + token
            response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25)
        with response:
            body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                raise ValueError("Registry manifest exceeds the inspection limit.")
            return body
    try:
        raw = fetch(root + "/manifests/" + expected)
        if "sha256:" + hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError("Registry returned an unexpected image digest.")
        manifest = json.loads(raw)
        if "manifests" in manifest:
            supported = any(item.get("platform", {}).get("os") == "linux" and item.get("platform", {}).get("architecture") == architecture for item in manifest["manifests"])
        else:
            image_config = json.loads(fetch(root + "/blobs/" + manifest["config"]["digest"]))
            supported = image_config.get("os") == "linux" and image_config.get("architecture") == architecture
        if not supported:
            raise ValueError("The image does not support Linux/" + architecture + ".")
    except (OSError, KeyError, ValueError) as error:
        raise ValueError("Image unavailable or incompatible: " + image + ". " + (str(error) if isinstance(error, ValueError) else "Check registry connectivity and image publication.")) from None


def inspect(git_dir, commit, architecture=None):
    architecture = architecture or {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
    images = image_inventory(git_dir, commit)
    for item in images:
        registry_image(item["image"], architecture)
        item["available"] = True
    return images


def preview(selected):
    current = config()
    if current["mode"] != "readonly-public":
        raise ValueError("The external GitOps repository owns this installation.")
    git_dir = STATE / "software-git"
    commit = resolve(current["repository"], selected, git_dir)
    images = inspect(git_dir, commit)
    result = {"channel": selection(selected), "commit": commit, "configurationId": current["id"],
              "images": images, "ready": True, "checkedAtEpoch": int(time.time())}
    result["id"] = digest(result)
    write_json(STATE / "software-preview.json", result)
    return result


def observe(kube):
    resources = kube(["get", "gitrepository/flux-system", "kustomization/flux-system", "-n", "flux-system", "-o", "json"]) or {}
    items = resources.get("items", [resources])
    source_item = next((item for item in items if item.get("kind") == "GitRepository"), {})
    applied = next((item for item in items if item.get("kind") == "Kustomization"), {})
    pods = kube(["get", "pods", "-A", "-o", "json"]) or {}
    images = []
    for pod in pods.get("items", []):
        meta = pod.get("metadata", {})
        labels = meta.get("labels", {})
        if labels.get("app") not in {"ai-appliance-dashboard", "ai-appliance-dashboard-api"} and labels.get("app.kubernetes.io/name") not in {"magicstick-dashboard-console", "magicstick-operator"}:
            continue
        if meta.get("deletionTimestamp"):
            continue
        for container in pod.get("status", {}).get("containerStatuses", []):
            desired_image = next((item.get("image", "") for item in pod.get("spec", {}).get("containers", []) if item["name"] == container["name"]), "")
            images.append({"name": meta.get("name", "") + "/" + container["name"], "image": desired_image or container.get("image", ""),
                           "imageId": container.get("imageID", ""), "ready": container.get("ready", False)})
    result = {"sourceRevision": source_item.get("status", {}).get("artifact", {}).get("revision", ""),
              "appliedRevision": applied.get("status", {}).get("lastAppliedRevision", ""),
              "ready": any(c.get("type") == "Ready" and c.get("status") == "True" for c in applied.get("status", {}).get("conditions", [])),
              "images": images, "checkedAtEpoch": int(time.time())}
    write_json(STATE / "software-observed.json", result)
    return result


def backup(current):
    previous = {"commit": git_commit(current["checkout"]), "channel": current["channel"]}
    if not re.fullmatch(r"[a-f0-9]{40}", previous["commit"]):
        raise ValueError("The current host revision is unavailable; a recoverable switch cannot be started.")
    recovery = STATE / "software-recovery"
    recovery.mkdir(mode=0o700, parents=True, exist_ok=True)
    for filename in ("software_channel.py", "software_contract.py"):
        shutil.copyfile(BASE / filename, recovery / filename)
    shutil.copyfile(RUNNER, recovery / "ai-appliance-converge")
    atomic(recovery / "metadata.env", METADATA.read_text())
    write_json(STATE / "software-previous.json", previous)
    return previous


def converge(commit, lock, recovery=False):
    env = {**os.environ, **ENV, "MAGICSTICK_CONVERGE_LOCK_FD": str(lock.fileno()), "MAGICSTICK_EXPECTED_COMMIT": commit,
           "MAGICSTICK_SOFTWARE_OPERATION": "1", "MAGICSTICK_SOFTWARE_RECOVERY": "1" if recovery else "0"}
    runner = STATE / "software-recovery/ai-appliance-converge" if recovery else RUNNER
    subprocess.run(["/bin/bash", str(runner)], env=env, pass_fds=(lock.fileno(),), check=True, timeout=2700)


def verify(commit, kube, timeout=900, expected_images=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            evidence = observe(kube)
            all_flux = kube(["get", "kustomizations", "-n", "flux-system", "-o", "json"]) or {}
            managed = [item for item in all_flux.get("items", []) if item.get("spec", {}).get("sourceRef", {}).get("name") == "flux-system" and not item.get("spec", {}).get("suspend")]
            converged = managed and all(item.get("status", {}).get("lastAppliedRevision", "").endswith(commit)
                and any(c.get("type") == "Ready" and c.get("status") == "True" for c in item.get("status", {}).get("conditions", [])) for item in managed)
            image_matches = not expected_images or set(expected_images) <= {item["image"] for item in evidence["images"] if item["ready"] and item["imageId"]}
            if evidence["sourceRevision"].endswith(commit) and evidence["appliedRevision"].endswith(commit) and converged and image_matches and evidence["images"] and all(item["ready"] for item in evidence["images"]):
                return evidence
        except (ValueError, RuntimeError, OSError):
            pass
        time.sleep(5)
    raise ValueError("Host changes were applied, but Flux and dashboard readiness did not converge within 15 minutes. Automatic convergence is paused; inspect status before recovery.")


def execute(request, lock, kube):
    current = config()
    capability = status()
    capability["busy"] = False  # This operation owns the shared maintenance lock.
    selected = validate_request(request["action"], request, capability)
    if request["action"] == "check-software-channel":
        (STATE / "software-preview.json").unlink(missing_ok=True)
        preview(selected)
        return "Channel and published dashboard images checked. Review and apply the preview."
    reviewed = read_json(STATE / "software-preview.json")
    checked = preview(selected)
    if checked["commit"] != reviewed["commit"]:
        raise ValueError("The branch or tag changed after review. Review the new preview before applying it.")
    # A retry must retain the recovery snapshot from before the failed switch.
    if not (STATE / "software-blocked.json").exists():
        backup(current)
    elif not read_json(STATE / "software-previous.json").get("commit"):
        raise ValueError("The recovery snapshot is missing. Inspect the host before retrying.")
    write_json(STATE / "software-blocked.json", {"commit": checked["commit"], "requestId": request["requestId"]})
    save_selection(selected)
    converge(checked["commit"], lock)
    verify(checked["commit"], kube, expected_images=[item["image"] for item in checked["images"]])
    (STATE / "software-blocked.json").unlink(missing_ok=True)
    return "Software channel saved. Host, Flux and dashboard are ready at " + checked["commit"][:12] + "."


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["run", "rollback", "verify-commit", "environment"])
    parser.add_argument("arguments", nargs="*")
    args = parser.parse_args()
    if args.action == "environment":
        # Strict literal parsing replaces root shell evaluation of bootstrap data.
        values = metadata(Path(args.arguments[0]) if args.arguments else None)
        for key, value in values.items():
            print("export " + key + "=" + shlex.quote(value))
        return
    if os.geteuid() != 0:
        raise ValueError("This command requires the local root account.")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.action == "verify-commit":
        checkout, commit = args.arguments
        key = digest({"commit": commit, "architecture": platform.machine()})
        if read_json(STATE / "software-verified.json").get("id") != key:
            inspect(Path(checkout) / ".git", commit)
            write_json(STATE / "software-verified.json", {"id": key})
        return
    def kube(arguments):
        output = command(["/usr/local/bin/k3s", "kubectl", "--kubeconfig=/etc/rancher/k3s/k3s.yaml", "--request-timeout=20s", *arguments])
        return json.loads(output) if output else None
    with (STATE / "maintenance.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == "rollback":
            previous = read_json(STATE / "software-previous.json")
            selected = selection({"kind": "commit", "value": previous.get("commit", "")})
            saved_metadata = STATE / "software-recovery/metadata.env"
            config(metadata(saved_metadata))
            write_json(STATE / "software-blocked.json", {"commit": selected["value"], "recovery": True})
            atomic(METADATA, saved_metadata.read_text())
            save_selection(selected)
            converge(selected["value"], lock, recovery=True)
            verify(selected["value"], kube)
            (STATE / "software-blocked.json").unlink(missing_ok=True)
            print("Previous revision restored and pinned. Select a branch again when ready.")
            return
        request = read_json(STATE / "approved-software.json")
        if not request or not 0 <= time.time() - request.get("approvedAt", 0) <= 300:
            raise ValueError("Software request is missing or expired.")
        old = read_json(STATE / "software-operation.json")
        if old.get("requestId") == request.get("requestId"):
            raise ValueError("This software request was already processed; it will not be replayed.")
        result = {"requestId": request["requestId"], "phase": "Applying", "message": "Checking software revision and published images.",
                  "pid": os.getpid(), "processStart": Path("/proc/self/stat").read_text().split(")", 1)[1].split()[19]}
        # validate_request above must see the pre-operation state, not our own busy flag.
        capability = status()
        validate_request(request["action"], request, capability)
        write_json(STATE / "software-operation.json", result)
        try:
            # The shared maintenance lock has independently serialized the request.
            result.update(phase="Succeeded", message=execute(request, lock, kube))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            result.update(phase="Failed", message=str(error) if isinstance(error, ValueError) else "Software operation failed. Inspect the local service journal; recovery is available on the host.")
        write_json(STATE / "software-operation.json", result)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
