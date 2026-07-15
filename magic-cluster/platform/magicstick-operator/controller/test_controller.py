import pathlib
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_controller():
    manifest = yaml.safe_load((ROOT / "controller-configmap.yaml").read_text(encoding="utf-8"))
    source = manifest["data"]["controller.py"].replace(
        "SSL_CONTEXT = ssl.create_default_context(cafile=SA_CA_PATH)",
        "SSL_CONTEXT = None",
    )
    namespace = {"__name__": "magicstick_controller_test"}
    exec(compile(source, "controller.py", "exec"), namespace)
    namespace["mdns_domain"] = lambda: "magicstick.local"
    return namespace


class HelmAppInstanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.controller = load_controller()

    def test_generates_helmrelease_from_app_definition(self):
        instance = {
            "metadata": {"name": "kubeopencode-demo"},
            "spec": {
                "application": "kubeopencode",
                "targetNamespace": "ai",
                "values": {
                    "name": "demo",
                    "model": "qwen3635b",
                    "server": {"ingress": {"host": "demo.example.local"}},
                },
            },
        }
        definition = {"chartPath": "magic-cluster/apps/instances/kubeopencode"}
        source = {"kind": "GitRepository", "name": "magicstick-public", "namespace": "flux-system"}

        release, url = self.controller["app_instance_helmrelease"](instance, definition, source)

        self.assertEqual(release["apiVersion"], "helm.toolkit.fluxcd.io/v2")
        self.assertEqual(release["metadata"]["namespace"], "ai-system")
        self.assertEqual(
            release["spec"]["chart"]["spec"]["chart"],
            "./magic-cluster/apps/instances/kubeopencode",
        )
        self.assertEqual(release["spec"]["chart"]["spec"]["sourceRef"]["name"], "magicstick-public")
        self.assertEqual(release["spec"]["targetNamespace"], "ai")
        self.assertEqual(
            release["spec"]["values"]["instance"]["values"]["ingress"]["host"],
            "demo.example.local",
        )
        self.assertEqual(url, "http://demo.example.local/")

    def test_resource_paths_cover_core_and_flux_resources(self):
        resource_path = self.controller["resource_path"]
        self.assertEqual(
            resource_path("v1", "ConfigMap", "ai-system", "catalog"),
            "/api/v1/namespaces/ai-system/configmaps/catalog",
        )
        self.assertEqual(
            resource_path("helm.toolkit.fluxcd.io/v2", "HelmRelease", "ai-system", "demo"),
            "/apis/helm.toolkit.fluxcd.io/v2/namespaces/ai-system/helmreleases/demo",
        )


if __name__ == "__main__":
    unittest.main()
