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

    def test_catalog_routes_hermes_to_its_gateway_port(self):
        manifest = yaml.safe_load((ROOT / "app-catalog.yaml").read_text(encoding="utf-8"))
        catalog = yaml.safe_load(manifest["data"]["applications.json"])

        self.assertEqual(catalog["applications"]["hermes"]["route"]["port"], 8443)
        self.assertTrue(catalog["applications"]["hermes"]["route"]["stripCookies"])

    def test_catalog_disables_request_timeout_for_all_streaming_applications(self):
        manifest = yaml.safe_load((ROOT / "app-catalog.yaml").read_text(encoding="utf-8"))
        catalog = yaml.safe_load(manifest["data"]["applications.json"])

        self.assertEqual(
            {
                name: definition["route"].get("requestTimeout")
                for name, definition in catalog["applications"].items()
            },
            {
                "openclaw": "0s",
                "hermes": "0s",
                "paperclip": "0s",
                "kubeopencode": "0s",
                "odysseus": "0s",
            },
        )

    def test_hermes_route_strips_edge_session_cookies_before_upstream(self):
        instance = {
            "metadata": {"name": "hermes-demo"},
            "spec": {"application": "hermes", "targetNamespace": "ai", "values": {}},
        }
        definition = {"route": {"serviceName": "instance", "port": 8443, "stripCookies": True}}

        resources, _ = self.controller["app_instance_access_resources"](instance, definition)

        routes = [resource for resource in resources if resource["kind"] == "HTTPRoute"]
        application_routes = [
            route for route in routes if not route["metadata"]["name"].endswith("-callback")
        ]
        for route in application_routes:
            self.assertEqual(
                route["spec"]["rules"][0]["filters"],
                [{"type": "RequestHeaderModifier", "requestHeaderModifier": {"remove": ["Cookie"]}}],
            )

    def test_generates_sso_protected_local_and_public_routes_by_default(self):
        instance = {
            "metadata": {"name": "kubeopencode-demo"},
            "spec": {"application": "kubeopencode", "targetNamespace": "ai", "values": {"name": "demo"}},
        }
        definition = {
            "route": {"serviceName": "shortName", "port": 4096, "requestTimeout": "0s"}
        }

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
        self.assertEqual(local_route["spec"]["rules"][0]["timeouts"], {"request": "0s"})
        local_callback = next(route for route in routes if route["metadata"]["name"].endswith("-local-callback"))
        self.assertEqual(local_callback["spec"]["hostnames"], ["magicstick.local"])
        self.assertNotIn("timeouts", local_callback["spec"]["rules"][0])
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

    def test_rejects_unsupported_application_route_timeout(self):
        instance = {
            "metadata": {"name": "kubeopencode-demo"},
            "spec": {"application": "kubeopencode", "targetNamespace": "ai", "values": {}},
        }
        definition = {
            "route": {"serviceName": "shortName", "port": 4096, "requestTimeout": "30s"}
        }

        with self.assertRaisesRegex(ValueError, "route.requestTimeout must be 0s"):
            self.controller["app_instance_access_resources"](instance, definition)

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

    def test_default_appliance_is_gpu_neutral(self):
        appliance = yaml.safe_load((ROOT / "default-appliance.yaml").read_text(encoding="utf-8"))
        modules = appliance["spec"]["modules"]

        self.assertEqual(set(modules), {"basis", "dashboard", "litellm", "model-catalog"})
        self.assertNotIn("gpu", modules)
        self.assertNotIn("kubeai", modules)

    def test_gpu_modules_are_on_demand_in_catalog(self):
        manifest = yaml.safe_load((ROOT / "module-catalog.yaml").read_text(encoding="utf-8"))
        catalog = yaml.safe_load(manifest["data"]["modules.json"])

        for name in ("gpu", "kubeai"):
            self.assertFalse(catalog["modules"][name]["default"])
            self.assertEqual(catalog["modules"][name]["activationPolicy"], "local-model")

    def test_model_module_dependencies_separate_local_and_external_models(self):
        required = self.controller["model_required_modules"]

        self.assertEqual(required("external"), ["litellm", "model-catalog"])
        self.assertEqual(required("local"), ["gpu", "kubeai", "litellm", "model-catalog"])

    def test_qwen38_preset_generates_validated_single_gpu_runtime(self):
        manifest = yaml.safe_load((ROOT / "model-presets.yaml").read_text(encoding="utf-8"))
        presets = yaml.safe_load(manifest["data"]["presets.json"])["presets"]
        preset = presets["qwen3827b"]
        activation = {
            "metadata": {"name": "qwen3827b"},
            "spec": {
                "targetNamespace": "ai",
                "local": {"preset": "qwen3827b"},
            },
        }

        resource, vram_mi = self.controller["kubeai_model_resource"](activation, presets)

        self.assertEqual(preset["url"], "hf://cyankiwi/Qwen3.8-27B-AWQ-INT4")
        self.assertEqual(vram_mi, 24062)
        self.assertEqual(resource["metadata"]["annotations"]["ai-appliance.io/context-window"], "20000")
        self.assertEqual(resource["spec"]["env"]["MAGICSTICK_VLLM_VRAM_LIMIT"], "24062Mi")
        self.assertEqual(
            resource["spec"]["args"],
            [
                "--tensor-parallel-size=1",
                "--reasoning-parser=qwen3",
                "--enable-auto-tool-choice",
                "--tool-call-parser=qwen3_coder",
                "--max-model-len=20000",
                "--max-num-seqs=1",
            ],
        )

    def test_nvidia_capacity_uses_allocatable_resources(self):
        original = self.controller["list_items"]
        self.controller["list_items"] = lambda _path: [
            {"status": {"allocatable": {"nvidia.com/gpu": "2"}}},
            {"status": {"capacity": {"nvidia.com/gpu": "1"}}},
            {"status": {"allocatable": {}}},
        ]
        try:
            self.assertEqual(self.controller["nvidia_gpu_capacity"](), 3)
        finally:
            self.controller["list_items"] = original

    def test_external_model_reconciliation_never_requests_gpu_runtime(self):
        names = (
            "ensure_model_finalizer",
            "ensure_module_activation",
            "module_ready",
            "catalog_contains_model",
            "patch_model_status",
            "nvidia_gpu_capacity",
        )
        originals = {name: self.controller[name] for name in names}
        requested = []
        statuses = []
        self.controller["ensure_model_finalizer"] = lambda _activation: None
        self.controller["ensure_module_activation"] = lambda module, auto=False: requested.append((module, auto))
        self.controller["module_ready"] = lambda _module, _catalog: True
        self.controller["catalog_contains_model"] = lambda _namespace, _name: True
        self.controller["patch_model_status"] = lambda *args, **kwargs: statuses.append((args, kwargs))
        self.controller["nvidia_gpu_capacity"] = lambda: self.fail("external models must not inspect GPU capacity")
        activation = {
            "metadata": {"name": "remote-chat", "namespace": "ai-system", "generation": 1},
            "spec": {"type": "external", "targetNamespace": "ai", "external": {"model": "openai/example"}},
        }
        try:
            phase, _status = self.controller["reconcile_model_activation"](activation, {"modules": {}}, {})
        finally:
            self.controller.update(originals)

        self.assertEqual(phase, "Ready")
        self.assertEqual(requested, [("litellm", True), ("model-catalog", True)])
        self.assertEqual(statuses[-1][0][1], "Ready")

    def test_local_model_waits_for_gpu_before_creating_kubeai_model(self):
        names = (
            "ensure_model_finalizer",
            "ensure_module_activation",
            "module_ready",
            "kubeai_model_resource",
            "nvidia_gpu_capacity",
            "patch_model_status",
            "apply_resource",
        )
        originals = {name: self.controller[name] for name in names}
        requested = []
        statuses = []
        self.controller["ensure_model_finalizer"] = lambda _activation: None
        self.controller["ensure_module_activation"] = lambda module, auto=False: requested.append((module, auto))
        self.controller["module_ready"] = lambda _module, _catalog: True
        self.controller["kubeai_model_resource"] = lambda _activation, _presets: ({}, 8192)
        self.controller["nvidia_gpu_capacity"] = lambda: 0
        self.controller["patch_model_status"] = lambda *args, **kwargs: statuses.append((args, kwargs))
        self.controller["apply_resource"] = lambda _resource: self.fail("KubeAI Model must not be created without a GPU")
        activation = {
            "metadata": {"name": "local-chat", "namespace": "ai-system", "generation": 1},
            "spec": {"type": "local", "targetNamespace": "ai", "local": {}},
        }
        try:
            phase, status = self.controller["reconcile_model_activation"](activation, {"modules": {}}, {})
        finally:
            self.controller.update(originals)

        self.assertEqual(phase, "WaitingForGPU")
        self.assertEqual(status["vramRequiredMi"], 8192)
        self.assertEqual(
            requested,
            [("gpu", True), ("kubeai", True), ("litellm", True), ("model-catalog", True)],
        )
        self.assertEqual(statuses[-1][0][1], "WaitingForGPU")

    def test_local_model_stays_starting_until_kubeai_has_a_ready_replica(self):
        names = (
            "ensure_model_finalizer",
            "ensure_module_activation",
            "module_ready",
            "kubeai_model_resource",
            "nvidia_gpu_capacity",
            "crd_exists",
            "apply_resource",
            "get_resource",
            "catalog_contains_model",
            "patch_model_status",
        )
        originals = {name: self.controller[name] for name in names}
        statuses = []
        resource = {
            "metadata": {"name": "local-chat", "namespace": "ai"},
            "spec": {"minReplicas": 1},
            "status": {"replicas": {"all": 1, "ready": 0}},
        }
        self.controller["ensure_model_finalizer"] = lambda _activation: None
        self.controller["ensure_module_activation"] = lambda _module, auto=False: None
        self.controller["module_ready"] = lambda _module, _catalog: True
        self.controller["kubeai_model_resource"] = lambda _activation, _presets: (resource, 8192)
        self.controller["nvidia_gpu_capacity"] = lambda: 1
        self.controller["crd_exists"] = lambda _name: True
        self.controller["apply_resource"] = lambda _resource: resource
        self.controller["get_resource"] = lambda *_args: resource
        self.controller["catalog_contains_model"] = lambda *_args: self.fail(
            "an unready KubeAI model must not be accepted from the catalog"
        )
        self.controller["patch_model_status"] = lambda *args, **kwargs: statuses.append((args, kwargs))
        activation = {
            "metadata": {"name": "local-chat", "namespace": "ai-system", "generation": 1},
            "spec": {"type": "local", "targetNamespace": "ai", "local": {}},
        }
        try:
            phase, status = self.controller["reconcile_model_activation"](activation, {"modules": {}}, {})
        finally:
            self.controller.update(originals)

        self.assertEqual(phase, "Starting")
        self.assertEqual(status["message"], "Waiting for KubeAI/vLLM to become ready: 0/1 replicas ready.")
        self.assertEqual(statuses[-1][0][1], "Starting")
        self.assertEqual(statuses[-1][0][2], "WaitingForReadyReplica")

    def test_local_model_is_ready_only_after_kubeai_and_catalog_are_ready(self):
        names = (
            "ensure_model_finalizer",
            "ensure_module_activation",
            "module_ready",
            "kubeai_model_resource",
            "nvidia_gpu_capacity",
            "crd_exists",
            "apply_resource",
            "get_resource",
            "catalog_contains_model",
            "patch_model_status",
        )
        originals = {name: self.controller[name] for name in names}
        statuses = []
        resource = {
            "metadata": {"name": "local-chat", "namespace": "ai"},
            "spec": {"minReplicas": 1},
            "status": {"replicas": {"all": 1, "ready": 1}},
        }
        self.controller["ensure_model_finalizer"] = lambda _activation: None
        self.controller["ensure_module_activation"] = lambda _module, auto=False: None
        self.controller["module_ready"] = lambda _module, _catalog: True
        self.controller["kubeai_model_resource"] = lambda _activation, _presets: (resource, 8192)
        self.controller["nvidia_gpu_capacity"] = lambda: 1
        self.controller["crd_exists"] = lambda _name: True
        self.controller["apply_resource"] = lambda _resource: resource
        self.controller["get_resource"] = lambda *_args: resource
        self.controller["catalog_contains_model"] = lambda *_args: True
        self.controller["patch_model_status"] = lambda *args, **kwargs: statuses.append((args, kwargs))
        activation = {
            "metadata": {"name": "local-chat", "namespace": "ai-system", "generation": 1},
            "spec": {"type": "local", "targetNamespace": "ai", "local": {}},
        }
        try:
            phase, _status = self.controller["reconcile_model_activation"](activation, {"modules": {}}, {})
        finally:
            self.controller.update(originals)

        self.assertEqual(phase, "Ready")
        self.assertEqual(statuses[-1][0][1], "Ready")


if __name__ == "__main__":
    unittest.main()
