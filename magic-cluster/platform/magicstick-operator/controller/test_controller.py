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

    def test_catalog_routes_hermes_to_its_dashboard_port(self):
        manifest = yaml.safe_load((ROOT / "app-catalog.yaml").read_text(encoding="utf-8"))
        catalog = yaml.safe_load(manifest["data"]["applications.json"])

        self.assertEqual(catalog["applications"]["hermes"]["route"]["port"], 9119)
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
        definition = {"route": {"serviceName": "instance", "port": 9119, "stripCookies": True}}

        resources, _ = self.controller["app_instance_access_resources"](instance, definition)

        routes = [resource for resource in resources if resource["kind"] == "HTTPRoute"]
        application_routes = [
            route for route in routes if not route["metadata"]["name"].endswith("-callback")
        ]
        for route in application_routes:
            self.assertEqual(route["spec"]["rules"][0]["backendRefs"][0]["port"], 9119)
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
        self.assertEqual(
            resource_path("networking.k8s.io/v1", "NetworkPolicy", "paperclip-demo-company", "runtime-egress"),
            "/apis/networking.k8s.io/v1/namespaces/paperclip-demo-company/networkpolicies/runtime-egress",
        )

    def test_paperclip_tenant_runtime_resources_are_instance_scoped(self):
        company_id = "3c58fd1a-a31e-4947-97ab-e7a904915ad0"
        namespace = {
            "metadata": {
                "name": f"paperclip-demo-{company_id}",
                "labels": {
                    "paperclip.io/company-id": company_id,
                    "paperclip.io/managed-by": "paperclip-k8s-plugin",
                },
            },
        }
        instance = {
            "metadata": {"name": "paperclip-demo"},
            "spec": {
                "application": "paperclip",
                "targetNamespace": "ai",
                "values": {"agentExecution": {"maxConcurrentAgents": 2}},
            },
        }

        self.assertIs(
            self.controller["paperclip_tenant_instance"](namespace, [instance]),
            instance,
        )
        resources = self.controller["paperclip_tenant_resources"](namespace, instance)
        by_kind = {resource["kind"]: resource for resource in resources}
        policy = by_kind["NetworkPolicy"]
        self.assertEqual(policy["metadata"]["namespace"], namespace["metadata"]["name"])
        self.assertEqual(
            policy["spec"]["podSelector"],
            {"matchLabels": {"paperclip.io/role": "agent"}},
        )
        self.assertEqual(
            policy["spec"]["egress"],
            [
                {
                    "to": [{
                        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ai"}},
                        "podSelector": {"matchLabels": {"app": "litellm"}},
                    }],
                    "ports": [{"protocol": "TCP", "port": 4000}],
                },
                {
                    "to": [{
                        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ai"}},
                        "podSelector": {"matchLabels": {
                            "app.kubernetes.io/name": "paperclip",
                            "app.kubernetes.io/instance": "paperclip-demo",
                            "app.kubernetes.io/component": "server",
                        }},
                    }],
                    "ports": [{"protocol": "TCP", "port": 3100}],
                },
            ],
        )
        self.assertEqual(
            by_kind["ResourceQuota"]["spec"]["hard"],
            {
                "pods": "2",
                "requests.cpu": "1000m",
                "requests.memory": "2Gi",
                "limits.cpu": "4",
                "limits.memory": "8Gi",
            },
        )
        self.assertEqual(
            by_kind["LimitRange"]["spec"]["limits"][0]["max"],
            {"cpu": "2", "memory": "4Gi"},
        )

    def test_paperclip_tenant_matching_is_exact_and_requires_an_active_instance(self):
        company_id = "3c58fd1a-a31e-4947-97ab-e7a904915ad0"
        namespace = {
            "metadata": {
                "name": f"paperclip-demo-{company_id}",
                "labels": {
                    "paperclip.io/company-id": company_id,
                    "paperclip.io/managed-by": "paperclip-k8s-plugin",
                },
            },
        }
        unrelated = {
            "metadata": {"name": "paperclip-dem"},
            "spec": {"application": "paperclip"},
        }
        disabled = {
            "metadata": {"name": "paperclip-demo"},
            "spec": {"application": "paperclip", "enabled": False},
        }

        self.assertIsNone(
            self.controller["paperclip_tenant_instance"](namespace, [unrelated, disabled])
        )

    def test_operator_rbac_can_only_reconcile_required_tenant_resources(self):
        documents = list(yaml.safe_load_all((ROOT / "rbac.yaml").read_text(encoding="utf-8")))
        cluster_role = next(document for document in documents if document["kind"] == "ClusterRole")
        rules = cluster_role["rules"]

        namespace_rule = next(
            rule for rule in rules if rule["apiGroups"] == [""] and rule["resources"] == ["namespaces"]
        )
        quota_rule = next(
            rule
            for rule in rules
            if rule["apiGroups"] == [""] and rule["resources"] == ["resourcequotas", "limitranges"]
        )
        policy_rule = next(
            rule
            for rule in rules
            if rule["apiGroups"] == ["networking.k8s.io"]
            and rule["resources"] == ["networkpolicies"]
        )
        self.assertEqual(namespace_rule["verbs"], ["get", "list", "watch"])
        self.assertEqual(quota_rule["verbs"], ["get", "create", "update", "patch"])
        self.assertEqual(policy_rule["verbs"], ["get", "create", "update", "patch", "delete"])

    def test_default_appliance_is_gpu_neutral(self):
        appliance = yaml.safe_load((ROOT / "default-appliance.yaml").read_text(encoding="utf-8"))
        modules = appliance["spec"]["modules"]

        self.assertEqual(set(modules), {"basis", "dashboard", "litellm", "model-catalog"})
        self.assertNotIn("gpu", modules)
        self.assertNotIn("kubeai", modules)

    def test_controller_rollouts_never_run_competing_reconcilers(self):
        deployment = yaml.safe_load((ROOT / "deployment.yaml").read_text(encoding="utf-8"))

        self.assertEqual(deployment["spec"]["replicas"], 1)
        self.assertEqual(
            deployment["spec"]["strategy"],
            {
                "type": "RollingUpdate",
                "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1},
            },
        )

    def test_gpu_modules_are_on_demand_in_catalog(self):
        manifest = yaml.safe_load((ROOT / "module-catalog.yaml").read_text(encoding="utf-8"))
        catalog = yaml.safe_load(manifest["data"]["modules.json"])

        for name in ("gpu", "kubeai"):
            self.assertFalse(catalog["modules"][name]["default"])
            self.assertEqual(catalog["modules"][name]["activationPolicy"], "local-model")

    def test_waiting_module_suspends_kustomization_without_deleting_resources(self):
        names = (
            "ensure_module_finalizer",
            "ensure_module_activation",
            "missing_module_dependencies",
            "apply_resource",
            "delete_module_kustomization",
            "patch_module_status",
        )
        originals = {name: self.controller[name] for name in names}
        applied = []
        self.controller["ensure_module_finalizer"] = lambda _activation: None
        self.controller["ensure_module_activation"] = lambda _module, auto=False: None
        self.controller["missing_module_dependencies"] = lambda _spec, _catalog: ["litellm"]
        self.controller["apply_resource"] = applied.append
        self.controller["delete_module_kustomization"] = lambda *_args: self.fail(
            "transient dependency waits must not delete module resources"
        )
        self.controller["patch_module_status"] = lambda *_args, **_kwargs: None
        activation = {
            "metadata": {"name": "anything-llm", "generation": 3},
            "spec": {
                "module": "anything-llm",
                "enabled": True,
                "parameters": {"storage": "2Gi"},
            },
        }
        catalog = {
            "modules": {
                "anything-llm": {
                    "kustomizationName": "app-anything-llm",
                    "path": "magic-cluster/apps/ai/anything-llm/base",
                    "requires": ["litellm"],
                }
            }
        }
        source = {"kind": "GitRepository", "name": "flux-system"}

        try:
            phase, status = self.controller["reconcile_module"](
                "anything-llm", activation, catalog, source
            )
        finally:
            self.controller.update(originals)

        self.assertEqual(phase, "WaitingForModules")
        self.assertEqual(status["kustomization"], "app-anything-llm")
        self.assertEqual(len(applied), 1)
        self.assertTrue(applied[0]["spec"]["suspend"])
        self.assertTrue(applied[0]["spec"]["prune"])
        self.assertEqual(applied[0]["spec"]["deletionPolicy"], "Delete")

    def test_model_module_dependencies_separate_local_and_external_models(self):
        required = self.controller["model_required_modules"]

        self.assertEqual(required("external"), ["litellm", "model-catalog"])
        self.assertEqual(
            required("local", "nvidia-gpu"),
            ["gpu", "kubeai", "litellm", "model-catalog"],
        )
        self.assertEqual(
            required("local", "cpu"),
            ["kubeai", "litellm", "model-catalog"],
        )

    def test_qwen38_preset_generates_validated_single_gpu_runtime(self):
        manifest = yaml.safe_load((ROOT / "model-presets.yaml").read_text(encoding="utf-8"))
        presets = yaml.safe_load(manifest["data"]["presets.json"])["presets"]
        preset = presets["qwen3827b"]["variants"][0]
        activation = {
            "metadata": {"name": "qwen3827b"},
            "spec": {
                "targetNamespace": "ai",
                "local": {"preset": "qwen3827b"},
            },
        }

        resource, runtime = self.controller["kubeai_model_resource"](activation, presets)

        self.assertEqual(preset["url"], "hf://cyankiwi/Qwen3.8-27B-AWQ-INT4")
        self.assertEqual(preset["maxOutputTokens"], 8192)
        self.assertEqual(runtime["vramMi"], 24062)
        self.assertEqual(runtime["computeTarget"], "nvidia-gpu")
        self.assertEqual(runtime["engine"], "VLLM")
        self.assertEqual(runtime["resourceProfile"], "magicstick-nvidia-gpu:1")
        self.assertEqual(resource["metadata"]["annotations"]["ai-appliance.io/context-window"], "20000")
        self.assertEqual(resource["metadata"]["annotations"]["ai-appliance.io/max-output-tokens"], "8192")
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

    def test_cpu_preset_generates_cpu_runtime_without_gpu_requirements(self):
        manifest = yaml.safe_load((ROOT / "model-presets.yaml").read_text(encoding="utf-8"))
        presets = yaml.safe_load(manifest["data"]["presets.json"])["presets"]
        catalog_manifest = yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text(encoding="utf-8"))
        compute_catalog = yaml.safe_load(catalog_manifest["data"]["targets.json"])
        activation = {
            "metadata": {"name": "qwen2505bcpu"},
            "spec": {
                "targetNamespace": "ai",
                "local": {"preset": "qwen2505bcpu", "computeTarget": "cpu"},
            },
        }
        original = self.controller["cluster_architectures"]
        self.controller["cluster_architectures"] = lambda: {"arm64"}
        try:
            resource, runtime = self.controller["kubeai_model_resource"](
                activation,
                presets,
                compute_catalog,
            )
        finally:
            self.controller["cluster_architectures"] = original

        self.assertEqual(runtime["computeTarget"], "cpu")
        self.assertEqual(runtime["resourceProfile"], "magicstick-vllm-cpu:1")
        self.assertEqual(runtime["memoryMi"], 4096)
        self.assertEqual(runtime["vramMi"], 0)
        self.assertEqual(resource["spec"]["engine"], "VLLM")
        self.assertEqual(resource["spec"]["env"]["MAGICSTICK_COMPUTE_TARGET"], "cpu")
        self.assertNotIn("VLLM_CPU_KVCACHE_SPACE", resource["spec"]["env"])
        self.assertNotIn("MAGICSTICK_VLLM_VRAM_LIMIT", resource["spec"]["env"])
        self.assertIn("--kv-cache-memory-bytes=536870912", resource["spec"]["args"])
        self.assertEqual(
            resource["metadata"]["labels"]["appliance.magicstick.dev/compute-target"],
            "cpu",
        )

    def test_preset_variant_must_support_selected_compute_target(self):
        manifest = yaml.safe_load((ROOT / "model-presets.yaml").read_text(encoding="utf-8"))
        presets = yaml.safe_load(manifest["data"]["presets.json"])["presets"]
        catalog_manifest = yaml.safe_load((ROOT / "compute-target-catalog.yaml").read_text(encoding="utf-8"))
        compute_catalog = yaml.safe_load(catalog_manifest["data"]["targets.json"])
        activation = {
            "metadata": {"name": "qwen3827b"},
            "spec": {
                "targetNamespace": "ai",
                "local": {"preset": "qwen3827b", "computeTarget": "cpu"},
            },
        }
        original = self.controller["cluster_architectures"]
        self.controller["cluster_architectures"] = lambda: {"arm64"}
        try:
            with self.assertRaisesRegex(ValueError, "has no unique VLLM/cpu variant"):
                self.controller["kubeai_model_resource"](activation, presets, compute_catalog)
        finally:
            self.controller["cluster_architectures"] = original

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
        runtime = {
            "computeTarget": "nvidia-gpu",
            "engine": "VLLM",
            "resourceProfile": "magicstick-nvidia-gpu:1",
            "vramMi": 8192,
            "memoryMi": 0,
        }
        self.controller["kubeai_model_resource"] = lambda _activation, _presets: ({}, runtime)
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
        runtime = {
            "computeTarget": "nvidia-gpu",
            "engine": "VLLM",
            "resourceProfile": "magicstick-nvidia-gpu:1",
            "vramMi": 8192,
            "memoryMi": 0,
        }
        self.controller["kubeai_model_resource"] = lambda _activation, _presets: (resource, runtime)
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
        self.assertEqual(
            status["message"],
            "Waiting for KubeAI/VLLM on nvidia-gpu to become ready: 0/1 replicas ready.",
        )
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
        runtime = {
            "computeTarget": "nvidia-gpu",
            "engine": "VLLM",
            "resourceProfile": "magicstick-nvidia-gpu:1",
            "vramMi": 8192,
            "memoryMi": 0,
        }
        self.controller["kubeai_model_resource"] = lambda _activation, _presets: (resource, runtime)
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

    def test_cpu_model_never_requests_or_checks_nvidia_runtime(self):
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
        requested = []
        statuses = []
        resource = {
            "metadata": {"name": "local-cpu", "namespace": "ai"},
            "spec": {"minReplicas": 1},
            "status": {"replicas": {"all": 1, "ready": 1}},
        }
        runtime = {
            "computeTarget": "cpu",
            "engine": "VLLM",
            "resourceProfile": "magicstick-vllm-cpu:1",
            "vramMi": 0,
            "memoryMi": 4096,
        }
        self.controller["ensure_model_finalizer"] = lambda _activation: None
        self.controller["ensure_module_activation"] = lambda module, auto=False: requested.append((module, auto))
        self.controller["module_ready"] = lambda _module, _catalog: True
        self.controller["kubeai_model_resource"] = lambda _activation, _presets: (resource, runtime)
        self.controller["nvidia_gpu_capacity"] = lambda: self.fail("CPU models must not inspect NVIDIA capacity")
        self.controller["crd_exists"] = lambda _name: True
        self.controller["apply_resource"] = lambda _resource: resource
        self.controller["get_resource"] = lambda *_args: resource
        self.controller["catalog_contains_model"] = lambda *_args: True
        self.controller["patch_model_status"] = lambda *args, **kwargs: statuses.append((args, kwargs))
        activation = {
            "metadata": {"name": "local-cpu", "namespace": "ai-system", "generation": 1},
            "spec": {
                "type": "local",
                "targetNamespace": "ai",
                "local": {"computeTarget": "cpu"},
            },
        }
        try:
            phase, status = self.controller["reconcile_model_activation"](
                activation,
                {"modules": {}},
                {},
            )
        finally:
            self.controller.update(originals)

        self.assertEqual(phase, "Ready")
        self.assertEqual(status["computeTarget"], "cpu")
        self.assertEqual(status["memoryRequiredMi"], 4096)
        self.assertEqual(
            requested,
            [("kubeai", True), ("litellm", True), ("model-catalog", True)],
        )
        self.assertEqual(statuses[-1][1]["compute_target"], "cpu")


if __name__ == "__main__":
    unittest.main()
