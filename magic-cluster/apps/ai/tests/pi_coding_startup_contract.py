# SPDX-License-Identifier: BUSL-1.1
"""APP-02 Pi bootstrap through real ConfigMap symlinks, only in disposable CI."""
import argparse
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[4]
NAME = "pi-coding-contract"
NAMESPACE = "ai"  # The production chart deliberately requires the catalog namespace.
MODEL = "synthetic-coder"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", choices=["kind-magicstick-identity-upgrade"], required=True)
    args = parser.parse_args()
    namespace_uid = None

    def execute(arguments, body=None, timeout=40, ok=True):
        result = subprocess.run(["kubectl", "--context", args.context, "--request-timeout=30s", *arguments],
                                input=body if isinstance(body, str) else json.dumps(body) if body is not None else None,
                                capture_output=True, text=True, timeout=timeout, check=False)
        if ok and result.returncode:
            # Never dump manifests, Secrets, Pod environments or application output.
            raise RuntimeError("Isolated Pi Kubernetes operation failed: " + arguments[0])
        return result

    def command(arguments, body=None, **kwargs):
        result = execute(["-n", NAMESPACE, *arguments], body, **kwargs)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def pods():
        return command(["get", "pods", "-l", "app.kubernetes.io/instance=" + NAME, "-o", "json"])["items"]

    def ready_pod():
        execute(["-n", NAMESPACE, "rollout", "status", "deployment/" + NAME, "--timeout=360s"], timeout=400)
        current = [p for p in pods() if not p["metadata"].get("deletionTimestamp")]
        assert len(current) == 1
        pod = current[0]
        assert not pod["metadata"].get("deletionTimestamp")
        init = next(s for s in pod["status"]["initContainerStatuses"] if s["name"] == "install-runtime")
        assert init["state"]["terminated"]["exitCode"] == 0
        assert init["restartCount"] == 0
        assert all(s["ready"] and s["restartCount"] == 0 for s in pod["status"]["containerStatuses"])
        return pod

    def node(pod, program):
        result = execute(["-n", NAMESPACE, "exec", pod["metadata"]["name"], "-c", "pi-coding", "--",
                          "node", "--input-type=module", "-e", program])
        assert result.stdout.strip() == "passed"

    def restart(deployment_uid, revision):
        command(["patch", "deployment", NAME, "--type=json", "--patch-file=/dev/stdin", "-o", "json"], [
            {"op": "test", "path": "/metadata/uid", "value": deployment_uid},
            {"op": "add", "path": "/spec/template/metadata/annotations/pi-startup-contract", "value": revision},
        ])

    inspection = """
import assert from 'node:assert/strict';
import {lstat, readFile, readlink} from 'node:fs/promises';
for (const name of ['install-cli.mjs', 'prepare-cli.mjs']) {
  assert.equal((await lstat('/bootstrap/' + name)).isSymbolicLink(), true);
}
for (const path of ['/runtime/ttyd', '/runtime/pi/pi']) {
  const entry = await lstat(path);
  assert(entry.isFile() && (entry.mode & 0o111));
}
const settings = JSON.parse(await readFile('/home/node/.pi/agent/settings.json', 'utf8'));
assert.equal(settings.defaultProvider, 'litellm');
assert.equal(settings.defaultModel, 'synthetic-coder');
assert.equal(settings.compaction.reserveTokens, 512);
assert.equal(await readlink('/home/node/.pi/agent/models.json'), '/catalog/pi-models.json');
const models = await readFile('/home/node/.pi/agent/models.json', 'utf8');
assert(models.includes('${LITELLM_API_KEY}') && !models.includes(process.env.LITELLM_API_KEY));
assert.equal((await fetch('http://127.0.0.1:7681/token')).status, 200);
const page = await fetch('http://127.0.0.1:7681/');
assert.equal(page.status, 200);
assert.match(await page.text(), /<html/i);
console.log('passed');
"""

    try:
        server = execute(["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"]).stdout
        assert urlsplit(server).hostname in {"127.0.0.1", "localhost", "::1"}, "Disposable loopback API required"
        namespace = json.loads(execute(["create", "namespace", NAMESPACE, "-o", "json"]).stdout)
        namespace_uid = namespace["metadata"]["uid"]
        command(["label", "namespace", NAMESPACE, "pod-security.kubernetes.io/enforce=restricted", "-o", "json"])
        catalog = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "ai-model-catalog"}, "data": {
            "pi-models.json": json.dumps({"providers": {"litellm": {"baseUrl": "http://127.0.0.1:9/v1",
                "api": "openai-completions", "apiKey": "${LITELLM_API_KEY}", "models": [
                    {"id": MODEL, "name": "Synthetic coder", "contextWindow": 4096, "maxTokens": 512}]}}}),
            "catalog.json": json.dumps({"models": [{"id": MODEL, "capabilities": {"tools": False}}]}),
        }}
        command(["create", "-f", "-", "-o", "json"], catalog)
        command(["create", "-f", "-", "-o", "json"], {"apiVersion": "v1", "kind": "Secret", "metadata": {
            "name": NAME + "-litellm"}, "stringData": {"LITELLM_API_KEY": "synthetic-pi-ci-key"}})
        values = {"instance": {"name": NAME, "namespace": NAMESPACE, "application": "pi-coding",
            "localHost": "example.pi-coding.example.local", "localName": "example",
            "values": {"model": MODEL, "storage": {"size": "64Mi"}}}}
        rendered = subprocess.run(["helm", "template", NAME, str(ROOT / "magic-cluster/apps/instances/pi-coding"),
                                   "-f", "-"], input=yaml.safe_dump(values), capture_output=True, text=True,
                                  timeout=30, check=True).stdout
        execute(["-n", NAMESPACE, "apply", "-f", "-"], rendered)
        deployment = command(["get", "deployment", NAME, "-o", "json"])
        deployment_uid = deployment["metadata"]["uid"]
        first = ready_pod()
        pvc_uid = command(["get", "pvc", NAME + "-data", "-o", "json"])["metadata"]["uid"]
        node(first, inspection)
        print("APP-02 isolated Kubernetes: cold ConfigMap-projected bootstrap, executable versions and terminal HTTP passed.", flush=True)

        node(first, """
import {mkdir, readFile, writeFile} from 'node:fs/promises';
const root = '/home/node/.pi/agent';
const settings = JSON.parse(await readFile(root + '/settings.json', 'utf8'));
settings.theme = 'synthetic-preserved-theme';
await writeFile(root + '/settings.json', JSON.stringify(settings));
await writeFile(root + '/auth.json', 'synthetic-saved-auth');
await mkdir(root + '/sessions', {recursive: true});
await writeFile(root + '/sessions/saved.jsonl', 'synthetic-saved-session');
console.log('passed');
""")
        restart(deployment_uid, "retained-data")
        second = ready_pod()
        assert second["metadata"]["uid"] != first["metadata"]["uid"]
        assert command(["get", "pvc", NAME + "-data", "-o", "json"])["metadata"]["uid"] == pvc_uid
        node(second, inspection)
        node(second, """
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root = '/home/node/.pi/agent';
assert.equal(JSON.parse(await readFile(root + '/settings.json', 'utf8')).theme, 'synthetic-preserved-theme');
assert.equal(await readFile(root + '/auth.json', 'utf8'), 'synthetic-saved-auth');
assert.equal(await readFile(root + '/sessions/saved.jsonl', 'utf8'), 'synthetic-saved-session');
console.log('passed');
""")
        print("APP-02 isolated Kubernetes: new Pod/cold runtime with retained PVC, settings, auth and session passed.", flush=True)

        catalog["data"]["pi-models.json"] = json.dumps({"providers": {"litellm": {"models": []}}})
        command(["patch", "configmap", "ai-model-catalog", "--type=merge", "--patch-file=/dev/stdin", "-o", "json"],
                {"data": catalog["data"]})
        restart(deployment_uid, "missing-model")
        deadline = time.monotonic() + 360
        while time.monotonic() < deadline:
            candidates = [p for p in pods() if p["metadata"]["uid"] not in {first["metadata"]["uid"], second["metadata"]["uid"]}]
            if len(candidates) == 1:
                failed = candidates[0]
                for status in failed.get("status", {}).get("containerStatuses", []):
                    previous = status.get("lastState", {}).get("terminated", {})
                    current = status.get("state", {}).get("terminated", {})
                    if previous.get("exitCode") == 1 or current.get("exitCode") == 1:
                        log_args = ["-n", NAMESPACE, "logs", failed["metadata"]["name"], "-c", "pi-coding", "--tail=10"]
                        if previous.get("exitCode") == 1:
                            log_args.append("--previous")
                        output = execute(log_args).stdout
                        assert "The selected chat model is unavailable." in output
                        assert not status["ready"]
                        assert command(["get", "pvc", NAME + "-data", "-o", "json"])["metadata"]["uid"] == pvc_uid
                        print("APP-02/11 isolated Kubernetes: unavailable selected model blocks terminal startup, without fallback or data deletion.", flush=True)
                        return
            time.sleep(2)
        raise RuntimeError("Missing-model startup rejection was not observed")
    except Exception:
        # Status-only diagnostics keep credentials and arbitrary child output out of CI.
        result = execute(["-n", NAMESPACE, "get", "pods", "-l", "app.kubernetes.io/instance=" + NAME,
                          "-o", "json"], ok=False)
        if result.returncode == 0:
            for pod in json.loads(result.stdout)["items"]:
                status = pod.get("status", {})
                containers = [*status.get("initContainerStatuses", []), *status.get("containerStatuses", [])]
                print(json.dumps({"phase": status.get("phase"), "containers": [{
                    "name": c["name"], "ready": c["ready"], "restarts": c["restartCount"],
                    "waiting": c.get("state", {}).get("waiting", {}).get("reason"),
                    "exitCode": c.get("state", {}).get("terminated", {}).get("exitCode"),
                    "previousExitCode": c.get("lastState", {}).get("terminated", {}).get("exitCode"),
                } for c in containers]}), flush=True)
        raise
    finally:
        if namespace_uid:
            execute(["delete", "--raw", "/api/v1/namespaces/" + NAMESPACE, "-f", "-"],
                    {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": namespace_uid}})


if __name__ == "__main__":
    main()
