"""Opt-in real Kubernetes check, isolated to a new namespace in Rancher Desktop."""
import json
import pathlib
import subprocess
import uuid

import yaml


def main():
    namespace = "magicstick-offload-check-" + uuid.uuid4().hex[:10]
    command = ["kubectl", "--context", "rancher-desktop", "--request-timeout=10s"]

    def run(*args, body=None, check=True):
        result = subprocess.run(command + list(args), input=json.dumps(body) if body else None,
                                capture_output=True, text=True, timeout=45)
        if check and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    run("create", "namespace", namespace)
    try:
        account = "magicstick-operator"
        objects = [{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {"name": account, "namespace": namespace}}]
        source = pathlib.Path(__file__).resolve().parents[1] / "rbac.yaml"
        for obj in yaml.safe_load_all(source.read_text()):
            if obj and obj["kind"] in ("Role", "RoleBinding") and obj["metadata"]["name"] == "magicstick-offloading-profiles":
                obj["metadata"]["namespace"] = namespace
                if obj["kind"] == "RoleBinding":
                    obj["subjects"][0]["namespace"] = namespace
                objects.append(obj)
        assert len(objects) == 3, "Expected the two narrowly scoped RBAC objects"
        for obj in objects:
            run("apply", "-f", "-", body=obj)
        identity = "--as=system:serviceaccount:" + namespace + ":" + account
        bootstrap = yaml.safe_load((source.parents[1] / "ai/kubeai/base/offloading-profiles-configmap.yaml").read_text())
        bootstrap["metadata"]["namespace"] = namespace
        assert bootstrap["metadata"]["annotations"]["kustomize.toolkit.fluxcd.io/ssa"] == "IfNotPresent"
        assert json.loads(bootstrap["data"]["values.json"]) == {"resourceProfiles": {}}
        run("apply", "--server-side", "--field-manager=flux-bootstrap-check", "-f", "-", body=bootstrap)
        config = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {
            "name": "magicstick-offloading-profiles", "namespace": namespace},
            "data": {"values.json": '{"resourceProfiles":{}}'}}
        run(identity, "apply", "--server-side", "--force-conflicts", "--field-manager=offloading-check", "-f", "-", body=config)
        config["data"]["values.json"] = '{"resourceProfiles":{"test":{"requests":{"memory":"8000Mi"}}}}'
        run(identity, "apply", "--server-side", "--force-conflicts", "--field-manager=offloading-check", "-f", "-", body=config)
        saved = json.loads(run(identity, "get", "configmap", "magicstick-offloading-profiles", "-n", namespace, "-o", "json").stdout)
        assert saved["data"] == config["data"]
        config["metadata"]["name"] = "unrelated"
        denied = run(identity, "apply", "--server-side", "-f", "-", body=config, check=False)
        assert denied.returncode and "forbidden" in denied.stderr.lower(), denied.stderr
        print("PASS: valid IfNotPresent bootstrap; named ConfigMap update/read allowed; unrelated ConfigMap denied")
    finally:
        run("delete", "namespace", namespace, "--wait=false")
        run("wait", "--for=delete", "namespace/" + namespace, "--timeout=30s")
        print("PASS: isolated Rancher test namespace removed")


if __name__ == "__main__":
    main()
