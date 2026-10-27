# SPDX-License-Identifier: BUSL-1.1
"""AUTH-09 real API upgrade counterexample; isolated namespace, zero running Pods."""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import sys
import uuid
from unittest.mock import patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "files"))
import setup_strategy

ROOT = Path(__file__).resolve().parents[4]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", choices=["rancher-desktop", "kind-magicstick-identity-upgrade"], required=True)
    args = parser.parse_args()
    namespace = "setup-upgrade-" + uuid.uuid4().hex[:12]
    namespace_uid = None

    def execute(arguments, body=None, ok=True):
        result = subprocess.run(["kubectl", "--context", args.context, "--request-timeout=20s", *arguments],
                                input=json.dumps(body) if body is not None else None,
                                capture_output=True, text=True, timeout=30, check=False)
        if ok and result.returncode:
            raise RuntimeError("Isolated setup API check failed: " + result.stderr[:2000])
        return result

    def command(arguments, body=None):
        result = execute(["--namespace", namespace, *arguments], body)
        return json.loads(result.stdout) if result.stdout.strip() else None

    try:
        created = json.loads(execute(["create", "namespace", namespace, "-o", "json"]).stdout)
        namespace_uid = created["metadata"]["uid"]
        desired = next(d for d in yaml.safe_load_all((ROOT / "magic-cluster/platform/identity/setup-app.yaml").read_text())
                       if d["kind"] == "Deployment")
        desired["metadata"].update(namespace=namespace, labels=dict(setup_strategy.OWNER))
        desired["spec"]["replicas"] = 0  # Exercise admission/defaulting/SSA, never start setup.
        old = copy.deepcopy(desired)
        old["spec"]["strategy"] = {}
        original = command(["apply", "--server-side", "--field-manager=kustomize-controller", "-f", "-", "-o", "json"], old)
        assert original["spec"]["strategy"]["type"] == "RollingUpdate"
        assert original["spec"]["strategy"]["rollingUpdate"]
        for explicit_null in (False, True):
            candidate = copy.deepcopy(desired)
            if explicit_null:
                candidate["spec"]["strategy"]["rollingUpdate"] = None
            bad = execute(["-n", namespace, "apply", "--server-side", "--field-manager=kustomize-controller",
                           "--force-conflicts", "--dry-run=server", "-f", "-"], candidate, ok=False)
            assert bad.returncode != 0 and "rollingUpdate" in bad.stderr and "Forbidden" in bad.stderr, bad.stderr
        unchanged = command(["get", "deployment", setup_strategy.NAME, "-o", "json"])
        assert unchanged["spec"] == original["spec"]

        with patch.object(setup_strategy, "NAMESPACE", namespace):
            # Kubernetes itself rejects a stale resourceVersion; no fake merge engine.
            stale = setup_strategy.migration_patch(unchanged)
            command(["annotate", "deployment", setup_strategy.NAME, "setup-test-revision=changed", "-o", "json"])
            rejected = execute(["-n", namespace, "patch", "deployment", setup_strategy.NAME, "--type=json",
                                "--patch-file=/dev/stdin"], stale, ok=False)
            assert rejected.returncode != 0
            assert command(["get", "deployment", setup_strategy.NAME, "-o", "json"])["spec"] == original["spec"]
            assert setup_strategy.migrate(command)
            assert not setup_strategy.migrate(command)
        applied = command(["apply", "--server-side", "--field-manager=kustomize-controller", "--force-conflicts",
                           "-f", "-", "-o", "json"], desired)
        assert applied["metadata"]["uid"] == original["metadata"]["uid"]
        assert applied["spec"] == {**original["spec"], "strategy": {"type": "Recreate"}}
        command(["apply", "--server-side", "--field-manager=kustomize-controller", "-f", "-", "-o", "json"], desired)
        assert not command(["get", "pods", "-o", "json"])["items"]
        print("AUTH-09 setup upgrade: legacy SSA failure (including null), stale-write rejection, migration, repeated migration and Flux-like apply passed; no Pods started.")
    finally:
        if namespace_uid:
            execute(["delete", "--raw", "/api/v1/namespaces/" + namespace, "-f", "-"],
                    {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": namespace_uid}})


if __name__ == "__main__":
    main()
