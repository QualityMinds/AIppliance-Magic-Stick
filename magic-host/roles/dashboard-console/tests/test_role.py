import pathlib
import shlex
import subprocess
import tempfile
import unittest

import yaml


ROLE_DIR = pathlib.Path(__file__).resolve().parents[1]
TASKS = (ROLE_DIR / "tasks" / "main.yml").read_text(encoding="utf-8")
LAUNCHER = (ROLE_DIR / "templates" / "launcher.j2").read_text(encoding="utf-8")
RUNTIME = (ROLE_DIR / "templates" / "runtime.yaml.j2").read_text(encoding="utf-8")


class DashboardConsoleRoleTests(unittest.TestCase):
    def test_templates_render_as_shell_and_kubernetes_yaml(self):
        values = {
            "{{ dashboard_console_k3s_binary | quote }}": shlex.quote("/usr/local/bin/k3s"),
            "{{ dashboard_console_kubeconfig | quote }}": shlex.quote("/etc/rancher/k3s/k3s.yaml"),
            "{{ dashboard_console_namespace | quote }}": shlex.quote("identity-system"),
            "{{ dashboard_console_deployment | quote }}": shlex.quote("magicstick-dashboard-console-runtime"),
            "{{ dashboard_console_label | quote }}": shlex.quote("app.kubernetes.io/name=magicstick-dashboard-console"),
            "{{ dashboard_console_api_url | quote }}": shlex.quote("http://dashboard-api:8080"),
            "{{ dashboard_console_oidc_network_url | quote }}": shlex.quote("http://keycloak:8080/realms/magicstick"),
            "{{ dashboard_console_default_mdns_domain | quote }}": shlex.quote("magicstick.local"),
            "{{ dashboard_console_refresh_seconds | quote }}": shlex.quote("15"),
            "{{ dashboard_console_retry_seconds | quote }}": shlex.quote("5"),
            "{{ dashboard_console_setup_namespace | quote }}": shlex.quote("identity-system"),
            "{{ dashboard_console_setup_resource | quote }}": shlex.quote("local"),
            "{{ (dashboard_console_client_secret_directory ~ '/client-secret') | quote }}":
                shlex.quote("/var/run/magicstick-console-client/client-secret"),
        }
        rendered_launcher = LAUNCHER
        for source, target in values.items():
            rendered_launcher = rendered_launcher.replace(source, target)
        self.assertNotIn("{{", rendered_launcher)
        with tempfile.TemporaryDirectory() as directory:
            launcher = pathlib.Path(directory) / "launcher"
            launcher.write_text(rendered_launcher, encoding="utf-8")
            result = subprocess.run(
                ["bash", "-n", str(launcher)],
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        self.assertEqual(result.returncode, 0, result.stderr)

        rendered_runtime = RUNTIME
        for source, target in {
            "{{ dashboard_console_deployment }}": "magicstick-dashboard-console-runtime",
            "{{ dashboard_console_namespace }}": "identity-system",
            "{{ dashboard_console_node_name }}": "magicstick",
            "{{ dashboard_console_runtime_uid }}": "65532",
            "{{ dashboard_console_runtime_gid }}": "65532",
            "{{ dashboard_console_image }}": "ghcr.io/example/magicstick-dashboard:console",
            "{{ dashboard_console_state_directory }}": "/var/lib/magicstick/dashboard-console",
            "{{ dashboard_console_client_secret_directory }}": "/var/run/magicstick-console-client",
            "{{ dashboard_console_client_secret }}": "magicstick-console-client",
        }.items():
            rendered_runtime = rendered_runtime.replace(source, target)
        self.assertNotIn("{{", rendered_runtime)
        manifest = yaml.safe_load(rendered_runtime)
        self.assertEqual(manifest["kind"], "Deployment")
        pod = manifest["spec"]["template"]["spec"]
        self.assertEqual(pod["nodeName"], "magicstick")
        # Automatic sign-in: only the generated secret value is mounted, read-only,
        # and a not-yet-provisioned Secret must not keep the console from starting.
        secret = next(volume for volume in pod["volumes"] if volume["name"] == "console-client")["secret"]
        self.assertEqual(secret["secretName"], "magicstick-console-client")
        self.assertIs(secret["optional"], True)
        self.assertEqual(secret["items"], [{"key": "client-secret", "path": "client-secret"}])
        self.assertEqual(secret["defaultMode"], 0o440)
        mount = next(item for item in pod["containers"][0]["volumeMounts"] if item["name"] == "console-client")
        self.assertEqual(mount, {
            "name": "console-client", "mountPath": "/var/run/magicstick-console-client", "readOnly": True,
        })
        # A digest-pinned image must restart from the local store while offline.
        self.assertEqual(pod["containers"][0]["imagePullPolicy"], "IfNotPresent")
        self.assertIn("@sha256:", (ROLE_DIR / "defaults" / "main.yml").read_text(encoding="utf-8").split("dashboard_console_image:")[1].splitlines()[0])

    def test_runtime_is_private_unprivileged_and_persists_only_console_state(self):
        self.assertIn("automountServiceAccountToken: false", RUNTIME)
        self.assertIn("runAsNonRoot: true", RUNTIME)
        self.assertIn("readOnlyRootFilesystem: true", RUNTIME)
        self.assertIn("drop: [\"ALL\"]", RUNTIME)
        self.assertIn("hostPath:", RUNTIME)
        self.assertIn("nodeName: {{ dashboard_console_node_name }}", RUNTIME)
        self.assertNotIn("kind: Service", RUNTIME)
        self.assertIn("test -x /usr/local/bin/magicstick-dashboard", RUNTIME)

    def test_launcher_uses_internal_transport_but_keeps_external_issuer(self):
        self.assertIn("MAGICSTICK_API_URL=\"$API_URL\"", LAUNCHER)
        self.assertIn("MAGICSTICK_OIDC_NETWORK_URL=\"$OIDC_NETWORK_URL\"", LAUNCHER)
        self.assertIn('issuer="https://id.${domain}/realms/magicstick"', LAUNCHER)
        self.assertIn("magicstick-dashboard console --no-open", LAUNCHER)
        # The launcher hands over a file path only; the secret value never
        # appears on a command line or in the host process list.
        self.assertIn('MAGICSTICK_CONSOLE_CLIENT_SECRET_FILE="$CONSOLE_SECRET_FILE"', LAUNCHER)
        self.assertNotIn("get secret", LAUNCHER)
        self.assertIn("kubectl", LAUNCHER)
        self.assertIn("exec -i -t", LAUNCHER)
        self.assertIn('current_phase="$(setup_phase)"', LAUNCHER)
        self.assertIn('"$current_phase" != "Completed"', LAUNCHER)

    def test_systemd_owns_tty9_only_after_the_claim_is_removed(self):
        self.assertIn("ConditionPathExists=!{{ dashboard_console_setup_claim_file }}", TASKS)
        self.assertIn("ConditionPathExists={{ dashboard_console_tty_path }}", TASKS)
        self.assertNotIn("Conflicts=magicstick-setup-console.service", TASKS)
        self.assertIn("ExecStartPre=-/usr/bin/chvt {{ dashboard_console_virtual_terminal }}", TASKS)
        self.assertIn("TTYPath={{ dashboard_console_tty_path }}", TASKS)
        self.assertIn("Restart=always", TASKS)
        self.assertIn("(dashboard_console_setup_phase.stdout | trim) in ['Completed', 'CompletedLegacy']", TASKS)


if __name__ == "__main__":
    unittest.main()
