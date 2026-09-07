import json
import pathlib
import unittest

import yaml


DASHBOARD_DIR = pathlib.Path(__file__).resolve().parent


def load_documents(name):
    return list(yaml.safe_load_all((DASHBOARD_DIR / name).read_text(encoding="utf-8")))


class UserAdminDeploymentTests(unittest.TestCase):
    def test_frontend_pod_has_no_service_account_token_or_api_container(self):
        deployment = load_documents("deployment.yaml")[0]
        pod = deployment["spec"]["template"]["spec"]

        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["serviceAccountName"], "default")
        self.assertEqual(
            {container["name"] for container in pod["containers"]},
            {"web"},
        )
        self.assertNotIn("api", {volume["name"] for volume in pod["volumes"]})

    def test_react_is_the_primary_unprivileged_frontend(self):
        deployment = load_documents("deployment.yaml")[0]
        pod = deployment["spec"]["template"]["spec"]

        self.assertEqual(deployment["metadata"]["name"], "ai-appliance-dashboard")
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["serviceAccountName"], "default")
        self.assertEqual([container["name"] for container in pod["containers"]], ["web"])
        self.assertTrue(pod["containers"][0]["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(pod["containers"][0]["ports"][0]["containerPort"], 8080)
        self.assertEqual(pod["containers"][0]["readinessProbe"]["httpGet"]["path"], "/healthz")
        service = load_documents("service.yaml")[0]
        self.assertEqual(service["spec"]["selector"], deployment["spec"]["selector"]["matchLabels"])
        self.assertEqual(service["spec"]["ports"][0], {"name": "http", "port": 80, "targetPort": "http"})

    def test_primary_react_dashboard_keeps_mdns_and_both_oidc_routes(self):
        grant, route, policy, public_route, public_policy = load_documents("gateway.yaml")

        self.assertEqual(grant["kind"], "ReferenceGrant")
        self.assertEqual(grant["metadata"]["name"], "allow-identity-gateway")
        self.assertEqual(grant["spec"]["to"][0]["name"], "ai-appliance-dashboard")
        self.assertEqual(route["kind"], "HTTPRoute")
        self.assertEqual(route["metadata"]["annotations"]["lab42.io/mdns.enabled"], "true")
        self.assertEqual(
            route["spec"]["hostnames"],
            ["${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}"],
        )
        self.assertEqual(
            route["spec"]["rules"][0]["backendRefs"][0]["name"],
            "ai-appliance-dashboard",
        )
        self.assertEqual(public_route["spec"]["hostnames"], ["${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}"])
        for protected_route, protected_policy in ((route, policy), (public_route, public_policy)):
            self.assertEqual(protected_route["spec"]["rules"][0]["backendRefs"], [{"name": "ai-appliance-dashboard", "namespace": "dashboard", "port": 80}])
            self.assertEqual(protected_policy["spec"]["targetRefs"][0]["name"], protected_route["metadata"]["name"])
            self.assertEqual(protected_policy["spec"]["oidc"]["cookieNames"]["accessToken"], "MagicStickAccessToken")
            self.assertEqual(protected_policy["spec"]["oidc"]["logoutPath"], "/logout")
            self.assertTrue(protected_policy["spec"]["oidc"]["forwardAccessToken"])

    def test_api_has_a_dedicated_single_pod_identity_boundary(self):
        deployment = load_documents("api-deployment.yaml")[0]
        pod = deployment["spec"]["template"]["spec"]

        self.assertEqual(deployment["metadata"]["namespace"], "identity-system")
        self.assertEqual(deployment["spec"]["replicas"], 1)
        self.assertEqual(deployment["spec"]["strategy"], {"type": "Recreate"})
        self.assertEqual(pod["serviceAccountName"], "ai-appliance-dashboard-api")
        self.assertTrue(pod["automountServiceAccountToken"])
        self.assertEqual([container["name"] for container in pod["containers"]], ["api"])

        api = pod["containers"][0]
        env = {entry["name"]: entry.get("value") for entry in api["env"]}
        self.assertEqual(env["IDENTITY_MANAGEMENT_MODE"], "keycloak")
        self.assertEqual(env["KEYCLOAK_REALM"], "magicstick")
        self.assertEqual(env["KEYCLOAK_USER_ADMIN_SECRET_NAMESPACE"], "identity-system")
        self.assertEqual(env["KEYCLOAK_USER_ADMIN_SECRET_NAME"], "magicstick-user-admin-client")
        self.assertEqual(env["KUBERNETES_ACCESS_INFO_NAMESPACE"], "identity-system")
        self.assertEqual(env["KUBERNETES_ACCESS_INFO_NAME"], "magicstick-kubernetes-access-info")
        self.assertEqual(env["KUBERNETES_OIDC_CLIENT_ID"], "magicstick-kubernetes")
        self.assertEqual(
            env["OIDC_EXPECTED_CLIENT_IDS"],
            "magicstick-human-gateway-local,magicstick-cli",
        )
        self.assertEqual(
            env["DASHBOARD_ALLOWED_ORIGINS"],
            "https://${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local},"
            "https://${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}",
        )
        self.assertNotIn("KEYCLOAK_USER_ADMIN_CLIENT_SECRET", env)

    def test_cli_api_has_an_mdns_jwt_route(self):
        route, policy = load_documents("cli-gateway.yaml")

        self.assertEqual(route["metadata"]["namespace"], "identity-system")
        self.assertEqual(route["metadata"]["annotations"]["lab42.io/mdns.enabled"], "true")
        self.assertEqual(
            route["spec"]["hostnames"],
            ["api.${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}"],
        )
        self.assertEqual(route["spec"]["rules"][0]["backendRefs"][0], {
            "name": "ai-appliance-dashboard-api",
            "port": 8080,
        })
        self.assertEqual(policy["spec"]["jwt"]["providers"][0]["name"], "keycloak")
        claims = policy["spec"]["authorization"]["rules"][0]["principal"]["jwt"]["claims"]
        self.assertIn("magicstick-admin", claims[0]["values"])

    def test_api_configmap_and_service_share_the_identity_namespace(self):
        configmap = load_documents("dashboard-api.yaml")[0]
        service = load_documents("api-service.yaml")[0]
        deployment = load_documents("api-deployment.yaml")[0]

        self.assertEqual(configmap["metadata"]["namespace"], "identity-system")
        self.assertEqual(service["metadata"]["namespace"], "identity-system")
        self.assertEqual(service["metadata"]["name"], "ai-appliance-dashboard-api")
        self.assertEqual(
            service["spec"]["selector"],
            deployment["spec"]["selector"]["matchLabels"],
        )

    def test_official_trust_is_git_updated_and_local_trust_is_preserved(self):
        official = load_documents("license-official-trust.yaml")[0]
        local = load_documents("license-trust.yaml")[0]
        self.assertEqual(official["metadata"]["name"], "magicstick-license-official-trust")
        self.assertEqual(official["metadata"]["namespace"], "identity-system")
        self.assertNotIn("kustomize.toolkit.fluxcd.io/ssa", official["metadata"]["annotations"])
        bundle = json.loads(official["data"]["trusted-keys.json"])
        self.assertTrue(bundle["keys"], "Official installations must ship public verification keys")
        self.assertFalse(set(bundle["keys"]) & set(bundle["retiredKeyIds"]))
        self.assertEqual(local["metadata"]["annotations"]["kustomize.toolkit.fluxcd.io/ssa"], "IfNotPresent")
        self.assertEqual(json.loads(local["data"]["trusted-keys.json"]), {"keys": {}})
        deployment = load_documents("api-deployment.yaml")[0]
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item.get("value") for item in container["env"]}
        self.assertEqual(env["LICENSE_OFFICIAL_TRUST_STORE"], "/etc/magicstick-license-official/trusted-keys.json")
        mounts = {mount["name"]: mount for mount in container["volumeMounts"]}
        self.assertTrue(mounts["license-official-trust"]["readOnly"])
        self.assertNotIn("subPath", mounts["license-official-trust"])
        self.assertIn("magicstick-license-official-trust", deployment["metadata"]["annotations"]["configmap.reloader.stakater.com/reload"])
        self.assertIn("license-official-trust.yaml", load_documents("kustomization.yaml")[0]["resources"])

    def test_nginx_proxies_to_the_api_service_instead_of_a_sidecar(self):
        config = (DASHBOARD_DIR.parents[2] / "dashboard/apps/web/nginx.conf").read_text(encoding="utf-8")

        self.assertNotIn("127.0.0.1:8080", config)
        self.assertIn(
            "ai-appliance-dashboard-api.identity-system.svc.cluster.local:8080",
            config,
        )
        self.assertIn("listen 8080;", config)
        self.assertIn('add_header Cache-Control "no-store" always;', config)
        self.assertIn("location /assets/", config)
        self.assertIn("try_files $uri =404;", config)
        self.assertIn("try_files $uri $uri/ /index.html;", config)

    def test_removed_frontends_cannot_be_reintroduced_by_the_base(self):
        resources = load_documents("kustomization.yaml")[0]["resources"]
        for filename in ("configmap.yaml", "nginx-config.yaml", "react-deployment.yaml", "react-service.yaml", "react-gateway.yaml", "test_dashboard_ui.py"):
            self.assertNotIn(filename, resources)
            self.assertFalse((DASHBOARD_DIR / filename).exists(), filename)
        deployments = [doc for filename in resources for doc in load_documents(filename) if doc and doc["kind"] == "Deployment"]
        self.assertEqual({doc["metadata"]["name"] for doc in deployments}, {"ai-appliance-dashboard", "ai-appliance-dashboard-api"})

    def test_all_api_rbac_bindings_use_only_the_dedicated_service_account(self):
        binding_files = (
            "clusterrolebinding.yaml",
            "settings-rbac.yaml",
            "model-secrets-rbac.yaml",
            "user-admin-rbac.yaml",
        )
        for filename in binding_files:
            bindings = [
                document
                for document in load_documents(filename)
                if document["kind"] in {"RoleBinding", "ClusterRoleBinding"}
            ]
            self.assertTrue(bindings, filename)
            for binding in bindings:
                self.assertEqual(binding["subjects"], [{
                    "kind": "ServiceAccount",
                    "name": "ai-appliance-dashboard-api",
                    "namespace": "identity-system",
                }], filename)

    def test_frontend_and_default_service_accounts_have_no_dashboard_rbac(self):
        forbidden = {
            ("dashboard", "ai-appliance-dashboard"),
            ("dashboard", "default"),
        }
        binding_files = ["clusterrolebinding.yaml"] + [
            path.name for path in DASHBOARD_DIR.glob("*-rbac.yaml")
        ]
        for filename in binding_files:
            for document in load_documents(filename):
                if document["kind"] not in {"RoleBinding", "ClusterRoleBinding"}:
                    continue
                subjects = {
                    (subject.get("namespace", document["metadata"].get("namespace")), subject.get("name"))
                    for subject in document.get("subjects", [])
                    if subject.get("kind") == "ServiceAccount"
                }
                self.assertTrue(subjects.isdisjoint(forbidden), filename)

    def test_dashboard_can_read_only_the_scoped_identity_secret(self):
        role, binding = load_documents("user-admin-rbac.yaml")

        self.assertEqual(role["metadata"]["namespace"], "identity-system")
        self.assertEqual(role["rules"], [{
            "apiGroups": [""],
            "resources": ["secrets"],
            "resourceNames": ["magicstick-user-admin-client"],
            "verbs": ["get"],
        }])
        self.assertEqual(binding["metadata"]["namespace"], "identity-system")

        cluster_role = load_documents("clusterrole.yaml")[0]
        self.assertFalse(any(
            "secrets" in rule.get("resources", [])
            for rule in cluster_role.get("rules", [])
        ))

    def test_split_api_resources_are_part_of_the_dashboard_render(self):
        kustomization = yaml.safe_load(
            (DASHBOARD_DIR / "kustomization.yaml").read_text(encoding="utf-8")
        )

        for resource in (
            "user-admin-rbac.yaml",
            "dashboard-api.yaml",
            "api-deployment.yaml",
            "api-service.yaml",
            "deployment.yaml",
            "service.yaml",
            "gateway.yaml",
            "cli-gateway.yaml",
        ):
            self.assertIn(resource, kustomization["resources"])


if __name__ == "__main__":
    unittest.main()
