import pathlib
import subprocess
import textwrap
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
PAPERCLIP_CHART = (
    REPO_ROOT
    / "magic-cluster"
    / "apps"
    / "instances"
    / "paperclip"
)


class PaperclipKubernetesProviderChartTests(unittest.TestCase):
    def test_gateway_bootstraps_the_pinned_provider_before_becoming_ready(self):
        template = (PAPERCLIP_CHART / "templates" / "instance.yaml").read_text(
            encoding="utf-8"
        )

        self.assertIn('const pluginPackage = "@paperclipai/plugin-kubernetes";', template)
        self.assertIn('const pluginPackageVersion = "2026.707.0";', template)
        self.assertIn('const paperclipBaseSkill = "paperclipai/paperclip/paperclip";', template)
        self.assertIn('apiRequest("POST", "/api/plugins/install"', template)
        self.assertIn('path === "/api/plugins/install" ? 120000 : 5000', template)
        self.assertIn('plugin?.status !== "ready"', template)
        self.assertIn("server.listen(listenPort, listenHost", template)
        self.assertIn("marker?.key", template)
        self.assertIn("selectedAdapter?.disabled === true", template)
        self.assertIn("hasConfiguredModel", template)
        self.assertIn("desiredSkills: [...desiredSkills, paperclipBaseSkill]", template)
        self.assertIn('updates.adapterType = "opencode_local"', template)
        self.assertIn("PAPERCLIP_DEFAULT_OPENCODE_MODEL", template)

        script = template.split("        - |\n", 1)[1].split("\n      env:", 1)[0]
        syntax_check = subprocess.run(
            ["node", "--check", "-"],
            input=textwrap.dedent(script),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(syntax_check.returncode, 0, syntax_check.stderr)

    def test_managed_environment_uses_the_registered_opencode_adapter(self):
        template = (PAPERCLIP_CHART / "templates" / "instance.yaml").read_text(
            encoding="utf-8"
        )

        self.assertIn("- name: PAPERCLIP_K8S_ADAPTER_TYPE\n      value: opencode_local", template)
        self.assertIn("- adapterType: opencode_local", template)
        self.assertIn("key: paperclip-opencode-providers.json", template)
        self.assertNotIn("key: opencode-providers.json", template)

    def test_control_plane_egress_and_rancher_psa_access_are_explicit_and_narrow(self):
        template = (PAPERCLIP_CHART / "templates" / "kubernetes-access.yaml").read_text(
            encoding="utf-8"
        )

        self.assertIn("kind: NetworkPolicy", template)
        self.assertIn("port: 6443", template)
        self.assertIn(
            "    - to:\n"
            "        - podSelector:\n"
            "            matchLabels:\n"
            "              app: litellm\n"
            "      ports:\n"
            "        - protocol: TCP\n"
            "          port: 4000\n",
            template,
        )
        self.assertIn("kind: ClusterRole", template)
        self.assertIn("- management.cattle.io", template)
        self.assertIn("- projects", template)
        self.assertIn("- updatepsa", template)
        self.assertNotIn("system:masters", template)


if __name__ == "__main__":
    unittest.main()
