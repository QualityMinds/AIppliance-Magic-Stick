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
    namespace["public_domain"] = lambda: "magicstick.example.com"
    namespace["dashboard_public_host"] = lambda: "magicstick.example.com"
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
        definition = {
            "chartPath": "magic-cluster/apps/instances/kubeopencode",
            "route": {"serviceName": "shortName", "port": 4096},
        }
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
            "demo.kubeopencode.magicstick.example.com",
        )
        self.assertFalse(release["spec"]["values"]["instance"]["values"]["ingress"]["enabled"])
        self.assertEqual(url, "https://demo.kubeopencode.magicstick.local/")

    def test_generates_sso_protected_local_and_public_routes_by_default(self):
        instance = {
            "metadata": {"name": "kubeopencode-demo"},
            "spec": {"application": "kubeopencode", "targetNamespace": "ai", "values": {"name": "demo"}},
        }
        definition = {"route": {"serviceName": "shortName", "port": 4096}}

        resources, access = self.controller["app_instance_access_resources"](instance, definition)

        routes = [resource for resource in resources if resource["kind"] == "HTTPRoute"]
        policies = [resource for resource in resources if resource["kind"] == "SecurityPolicy"]
        grants = [resource for resource in resources if resource["kind"] == "ReferenceGrant"]
        self.assertEqual(len(routes), 4)
        self.assertEqual(len(policies), 2)
        self.assertEqual(len(grants), 1)
        local_route = next(route for route in routes if route["metadata"]["name"].endswith("-local"))
        self.assertEqual(local_route["metadata"]["annotations"]["lab42.io/mdns.enabled"], "true")
        self.assertEqual(local_route["spec"]["hostnames"], ["demo.kubeopencode.magicstick.local"])
        self.assertEqual(local_route["spec"]["rules"][0]["backendRefs"][0], {"name": "demo", "namespace": "ai", "port": 4096})
        local_callback = next(route for route in routes if route["metadata"]["name"].endswith("-local-callback"))
        self.assertEqual(local_callback["spec"]["hostnames"], ["magicstick.local"])
        self.assertEqual(
            local_callback["spec"]["rules"][0]["matches"][0]["path"],
            {"type": "Exact", "value": "/oauth2/callback/kubeopencode-demo-local"},
        )
        self.assertEqual(access["authentication"], "sso")
        self.assertEqual(access["requiredRole"], "user")
        self.assertEqual(access["publicURL"], "https://demo.kubeopencode.magicstick.example.com/")
        policy = policies[0]
        self.assertEqual(len(policy["spec"]["targetRefs"]), 2)
        self.assertEqual(policy["spec"]["oidc"]["redirectURL"], "https://magicstick.local/oauth2/callback/kubeopencode-demo-local")
        self.assertEqual(policy["spec"]["jwt"]["providers"][0]["extractFrom"]["cookies"], ["MagicStickAccessToken"])
        self.assertIn("magicstick-admin", policy["spec"]["authorization"]["rules"][0]["principal"]["jwt"]["claims"][0]["values"])

    def test_explicit_public_local_instance_omits_security_policy(self):
        instance = {
            "metadata": {"name": "odysseus-demo"},
            "spec": {
                "application": "odysseus",
                "targetNamespace": "ai",
                "access": {"authentication": "none", "exposure": "local"},
                "values": {"name": "demo"},
            },
        }
        definition = {"route": {"serviceName": "instance", "port": 7000}}

        resources, access = self.controller["app_instance_access_resources"](instance, definition)

        self.assertEqual(len([resource for resource in resources if resource["kind"] == "HTTPRoute"]), 1)
        self.assertEqual(len([resource for resource in resources if resource["kind"] == "SecurityPolicy"]), 0)
        self.assertEqual(access["authentication"], "none")
        self.assertEqual(access["publicURL"], "")

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
        self.assertEqual(
            resource_path("gateway.networking.k8s.io/v1", "HTTPRoute", "identity-system", "demo-local"),
            "/apis/gateway.networking.k8s.io/v1/namespaces/identity-system/httproutes/demo-local",
        )


if __name__ == "__main__":
    unittest.main()
