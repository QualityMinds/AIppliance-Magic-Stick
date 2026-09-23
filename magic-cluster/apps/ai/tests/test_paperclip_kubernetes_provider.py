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
        self.assertIn("PAPERCLIP_INSTANCE_NAME", template)
        self.assertIn("PAPERCLIP_SANDBOX_CLEANUP_GRACE_SECONDS", template)
        self.assertIn('terminalRunStatuses.has(run?.status)', template)
        self.assertIn('Date.parse(run?.finishedAt || "")', template)
        self.assertIn('Date.now() - finishedAt < sandboxCleanupGraceMs', template)
        self.assertIn(
            '`/apis/agents.x-k8s.io/v1alpha1/namespaces/${namespace}/sandboxes/${sandboxName}`',
            template,
        )
        self.assertIn('"paperclip.io/run-id"', template)
        self.assertNotIn("deleteNamespacedNamespace", template)

        sidecar_marker = '        - |\n          const fs = require("fs");\n'
        script = (
            'const fs = require("fs");\n'
            + template.split(sidecar_marker, 1)[1].split("\n      env:", 1)[0]
        )
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

    def test_official_runtime_supports_skill_search_and_remote_instruction_contract(self):
        template = (PAPERCLIP_CHART / "templates" / "instance.yaml").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "ghcr.io/paperclipai/agent-runtime-opencode@sha256:1511797b21856fb3ce4b6b1ce5b0209a0a1c55ef227a21d4024bf4681a0fa49d",
            template,
        )
        self.assertNotIn("magicstick-paperclip-opencode-runtime", template)
        self.assertIn("prepare-paperclip-adapter-patch", template)
        self.assertIn(
            "Do not attempt to read their control-plane source path from the sandbox.",
            template,
        )
        self.assertIn(
            'discoveredExecutionTarget.providerKey === \\"kubernetes\\"',
            template,
        )
        self.assertIn(
            'overrideAdapterExecutionTargetRemoteCwd(discoveredExecutionTarget, "/workspace")',
            template,
        )
        self.assertIn("Pinned OpenCode adapter workspace source no longer matches exactly", template)
        self.assertIn("[MagicStick Paperclip heartbeat v2]", template)
        self.assertIn('call the skill tool to load the \\"paperclip\\" skill', template)
        self.assertIn('build every Paperclip request from \\"$PAPERCLIP_API_URL\\"', template)
        self.assertIn("never use a literal localhost or 127.0.0.1 port", template)
        self.assertIn('paragraph.startsWith("[MagicStick Paperclip heartbeat")', template)
        self.assertIn("create task documents through the Paperclip API", template)
        self.assertIn("set a final task disposition before exiting", template)
        self.assertNotIn("MAX_RPC_TIMEOUT_MS = 60 * 60 * 1_000", template)
        self.assertNotIn("plugin-worker-manager.js", template)
        self.assertIn(
            "adapter_source_dir=/app/cli/node_modules/@paperclipai/adapter-opencode-local/src/server",
            template,
        )
        self.assertIn(
            "mountPath: /app/packages/adapters/opencode-local/src/server",
            template,
        )
        self.assertNotIn("subPath: opencode-execute.ts", template)

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
        self.assertIn("sandbox-reconciler", template)
        self.assertIn("- agents.x-k8s.io", template)
        self.assertIn("- sandboxes", template)
        self.assertIn("    verbs:\n      - list\n", template)
        self.assertNotIn("    verbs:\n      - list\n      - delete\n", template)
        self.assertNotIn("system:masters", template)


if __name__ == "__main__":
    unittest.main()
