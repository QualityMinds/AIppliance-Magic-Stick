# SPDX-License-Identifier: BUSL-1.1
"""Small bootstrap web Pods must not scale workers to the host CPU count."""
from pathlib import Path
import re
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[4]
IDENTITY = ROOT / "magic-cluster/platform/identity"


class NginxWorkerContractTests(unittest.TestCase):
    def test_both_web_configs_bound_the_worker_pool(self):
        for path in (IDENTITY / "auth-pilot-nginx.conf", ROOT / "dashboard/apps/web/nginx.conf"):
            with self.subTest(config=path.name):
                directives = re.findall(r"^\s*worker_processes\s+([^;]+);", path.read_text(), re.MULTILINE)
                self.assertEqual(directives, ["1"])

    def test_pilot_consumes_the_generated_read_only_config(self):
        docs = list(yaml.safe_load_all((IDENTITY / "routes.yaml").read_text()))
        pod = next(item for item in docs if item["kind"] == "Deployment" and
                   item["metadata"]["name"] == "auth-pilot")["spec"]["template"]["spec"]
        container = pod["containers"][0]
        mount = next(item for item in container["volumeMounts"] if item["name"] == "nginx-config")
        self.assertEqual(mount, {"name": "nginx-config", "mountPath": "/etc/nginx/nginx.conf",
                                 "subPath": "nginx.conf", "readOnly": True})
        volume = next(item for item in pod["volumes"] if item["name"] == "nginx-config")
        self.assertEqual(volume["configMap"]["name"], "auth-pilot-nginx")
        base = yaml.safe_load((IDENTITY / "kustomization.yaml").read_text())
        generator = next(item for item in base["configMapGenerator"] if item["name"] == "auth-pilot-nginx")
        self.assertEqual(generator["namespace"], "identity-system")
        self.assertEqual(generator["files"], ["nginx.conf=auth-pilot-nginx.conf"])
        self.assertFalse(base.get("generatorOptions", {}).get("disableNameSuffixHash", False))

    def test_memory_cpu_and_readiness_are_preserved(self):
        docs = list(yaml.safe_load_all((IDENTITY / "routes.yaml").read_text()))
        pilot = next(item for item in docs if item["kind"] == "Deployment" and
                     item["metadata"]["name"] == "auth-pilot")["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(pilot["resources"]["limits"], {"cpu": "100m", "memory": "64Mi"})
        self.assertEqual(pilot["readinessProbe"]["httpGet"], {"path": "/", "port": "http"})
        dashboard = yaml.safe_load((ROOT / "magic-cluster/apps/dashboard/deployment.yaml").read_text())
        web = dashboard["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(web["resources"]["limits"], {"cpu": "200m", "memory": "128Mi"})
        self.assertTrue(web["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(web["readinessProbe"]["httpGet"], {"path": "/healthz", "port": "http"})

    def test_container_runtime_regression_is_enabled_in_ci(self):
        workflow = yaml.load((ROOT / ".github/workflows/public-release-checks.yml").read_text(),
                             Loader=yaml.BaseLoader)
        step = next(item for item in workflow["jobs"]["release-checks"]["steps"]
                    if item.get("name") == "Check nginx worker and memory bounds")
        self.assertEqual(step["env"]["MAGICSTICK_RUN_NGINX_CONTAINER_TESTS"], "1")
        self.assertIn("tests.test_nginx_runtime", step["run"])


if __name__ == "__main__":
    unittest.main()
