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
            {"nginx", "renderer"},
        )
        self.assertNotIn("api", {volume["name"] for volume in pod["volumes"]})

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
            env["DASHBOARD_ALLOWED_ORIGINS"],
            "https://${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local},"
            "https://${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}",
        )
        self.assertNotIn("KEYCLOAK_USER_ADMIN_CLIENT_SECRET", env)

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

    def test_nginx_proxies_to_the_api_service_instead_of_a_sidecar(self):
        config = load_documents("nginx-config.yaml")[0]["data"]["default.conf"]

        self.assertNotIn("127.0.0.1:8080", config)
        self.assertIn(
            "ai-appliance-dashboard-api.identity-system.svc.cluster.local:8080",
            config,
        )

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
        ):
            self.assertIn(resource, kustomization["resources"])


if __name__ == "__main__":
    unittest.main()
