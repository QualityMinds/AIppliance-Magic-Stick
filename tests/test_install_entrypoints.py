import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
LINUX_INSTALLER = ROOT / "install-from-linux.sh"
KUBERNETES_INSTALLER = ROOT / "deploy-on-k8s.sh"
POWERSHELL_INSTALLER = ROOT / "deploy-on-k8s.ps1"


class InstallerEntrypointTests(unittest.TestCase):
    def run_command(self, *args, env=None):
        return subprocess.run(
            args,
            cwd=ROOT,
            env=env,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_shell_entrypoints_parse_and_show_help(self):
        for script in (LINUX_INSTALLER, KUBERNETES_INSTALLER):
            with self.subTest(script=script.name):
                syntax = self.run_command("bash", "-n", str(script))
                self.assertEqual(syntax.returncode, 0, syntax.stderr)

                help_result = self.run_command("bash", str(script), "--help")
                self.assertEqual(help_result.returncode, 0, help_result.stderr)
                self.assertIn("--preflight-only", help_result.stdout)
                self.assertIn("--yes", help_result.stdout)

    def test_kubernetes_preflight_is_read_only(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            fake_bin = pathlib.Path(temporary_directory)
            command_log = fake_bin / "commands.log"
            kubectl = fake_bin / "kubectl"
            kubectl.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -eu
                    printf '%s\\n' "$*" >>"$FAKE_COMMAND_LOG"
                    args=" $* "
                    case "$args" in
                      *" config current-context "*) printf '%s\\n' fake-context ;;
                      *" config get-contexts "*) exit 0 ;;
                      *" get --raw=/readyz "*) printf '%s\\n' ok ;;
                      *" auth can-i "*) printf '%s\\n' yes ;;
                      *" get storageclass "*) printf '%s\\n' default ;;
                      *" get appliancesetup local "*) exit 1 ;;
                      *" get appliance local "*) exit 1 ;;
                      *" get gitrepository flux-system "*) exit 1 ;;
                      *" get kustomization flux-system "*) exit 1 ;;
                      *) exit 1 ;;
                    esac
                    """
                ),
                encoding="utf-8",
            )
            kubectl.chmod(0o755)
            for command in ("helm", "flux"):
                executable = fake_bin / command
                executable.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
                executable.chmod(0o755)

            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            environment["FAKE_COMMAND_LOG"] = str(command_log)
            result = self.run_command(
                "bash",
                str(KUBERNETES_INSTALLER),
                "--context",
                "fake-context",
                "--preflight-only",
                "--yes",
                env=environment,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Preflight-only mode completed", result.stdout)
            commands = command_log.read_text(encoding="utf-8")
            for mutation in (" apply ", " create ", " patch ", " delete "):
                self.assertNotIn(mutation, f" {commands} ")

    def test_kubernetes_preflight_refuses_existing_setup(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            fake_bin = pathlib.Path(temporary_directory)
            kubectl = fake_bin / "kubectl"
            kubectl.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -eu
                    args=" $* "
                    case "$args" in
                      *" config get-contexts "*) exit 0 ;;
                      *" get --raw=/readyz "*) printf '%s\\n' ok ;;
                      *" auth can-i "*) printf '%s\\n' yes ;;
                      *" get storageclass "*) printf '%s\\n' default ;;
                      *" get appliancesetup local "*) exit 0 ;;
                      *) exit 1 ;;
                    esac
                    """
                ),
                encoding="utf-8",
            )
            kubectl.chmod(0o755)
            for command in ("helm", "flux"):
                executable = fake_bin / command
                executable.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
                executable.chmod(0o755)

            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            result = self.run_command(
                "bash",
                str(KUBERNETES_INSTALLER),
                "--context",
                "fake-context",
                "--preflight-only",
                "--yes",
                env=environment,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("never resets an existing appliance", result.stderr)

    def test_kubernetes_bootstrap_reaches_pending_without_storing_plain_claim(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            fake_bin = pathlib.Path(temporary_directory)
            command_log = fake_bin / "commands.log"
            kubectl = fake_bin / "kubectl"
            kubectl.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -eu
                    printf '%s\\n' "$*" >>"$FAKE_COMMAND_LOG"
                    args=" $* "
                    case "$args" in
                      *" config get-contexts "*) exit 0 ;;
                      *" config view "*) printf '%s\\n' https://cluster.example.invalid ;;
                      *" get --raw=/readyz "*) printf '%s\\n' ok ;;
                      *" auth can-i "*) printf '%s\\n' yes ;;
                      *" get storageclass "*) printf '%s\\n' default ;;
                      *" get appliancesetup local "*) exit 1 ;;
                      *" get appliance local "*) exit 1 ;;
                      *" get configmap magicstick-installer-state "*) exit 1 ;;
                      *" get gitrepository flux-system "*) exit 1 ;;
                      *" get kustomization flux-system "*) exit 1 ;;
                      *" get deployment source-controller "*) exit 1 ;;
                      *" get deployment kustomize-controller "*) exit 1 ;;
                      *" create namespace flux-system "*)
                        printf '%s\\n' 'apiVersion: v1' 'kind: Namespace' 'metadata:' '  name: flux-system'
                        ;;
                      *" create configmap magicstick-installer-state "*|*" create configmap ai-appliance-settings "*)
                        printf '%s\\n' 'apiVersion: v1' 'kind: ConfigMap' 'metadata:' '  name: generated'
                        ;;
                      *" create secret generic magicstick-setup-claim "*)
                        printf '%s\\n' 'apiVersion: v1' 'kind: Secret' 'metadata:' '  name: magicstick-setup-claim'
                        ;;
                      *" get namespace identity-system "*) exit 0 ;;
                      *" wait --for=condition=Established "*) exit 0 ;;
                      *" apply "*) cat >/dev/null; exit 0 ;;
                      *" patch appliancesetup local "*|*" delete configmap magicstick-installer-state "*) exit 0 ;;
                      *) exit 1 ;;
                    esac
                    """
                ),
                encoding="utf-8",
            )
            kubectl.chmod(0o755)

            helm = fake_bin / "helm"
            helm.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' 'apiVersion: apiextensions.k8s.io/v1' 'kind: CustomResourceDefinition'\n",
                encoding="utf-8",
            )
            helm.chmod(0o755)
            flux = fake_bin / "flux"
            flux.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            flux.chmod(0o755)

            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            environment["FAKE_COMMAND_LOG"] = str(command_log)
            result = self.run_command(
                "bash",
                str(KUBERNETES_INSTALLER),
                "--context",
                "fake-context",
                "--yes",
                env=environment,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            claim_match = re.search(r"Einrichtungscode: ([0-9a-z]{8})", result.stdout)
            self.assertIsNotNone(claim_match, result.stdout)
            claim = claim_match.group(1)
            commands = command_log.read_text(encoding="utf-8")
            self.assertNotIn(claim, commands)
            self.assertIn("claim-sha256=", commands)
            self.assertIn('status', commands)
            self.assertIn('Pending', commands)
            self.assertIn("delete configmap magicstick-installer-state", commands)

    def test_installers_keep_human_secrets_out_of_manifests(self):
        kubernetes_source = KUBERNETES_INSTALLER.read_text(encoding="utf-8")
        powershell_source = POWERSHELL_INSTALLER.read_text(encoding="utf-8")
        linux_source = LINUX_INSTALLER.read_text(encoding="utf-8")

        for source in (kubernetes_source, powershell_source):
            self.assertIn("claim-sha256", source)
            self.assertNotIn("from-literal=claim=", source)
            self.assertNotIn("password", source.lower())
        self.assertNotIn("FLUX_GITHUB_TOKEN", linux_source)
        self.assertIn("MAGICSTICK_PUBLIC_REF_KIND", linux_source)
        self.assertIn("commit", linux_source)

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell is not installed")
    def test_powershell_entrypoint_parses(self):
        command = (
            "[scriptblock]::Create([IO.File]::ReadAllText('"
            + str(POWERSHELL_INSTALLER).replace("'", "''")
            + "')) | Out-Null"
        )
        result = self.run_command("pwsh", "-NoProfile", "-Command", command)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
