import os
import pathlib
import re
import shlex
import subprocess
import tempfile
import textwrap
import unittest


ROLE_DIR = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = ROLE_DIR / "templates" / "magicstick.j2"
TASKS = ROLE_DIR / "tasks" / "main.yml"


class FirstRunConsoleTests(unittest.TestCase):
    def render_console_script(self, temporary_directory):
        temporary_path = pathlib.Path(temporary_directory)
        fake_bin = temporary_path / "bin"
        fake_bin.mkdir()
        claim_file = temporary_path / "claim"
        claim_file.write_text("abc234xy\n", encoding="utf-8")

        fake_kubectl = fake_bin / "fake-k3s"
        fake_kubectl.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                args=" $* "
                case "$args" in
                  *" get appliancesetup local "*) printf '%s' "${FAKE_PHASE:-Pending}" ;;
                  *" get configmap ai-appliance-settings "*) printf '%s' magicstick.local ;;
                  *" get secret magicstick-setup-tls "*) printf '%s' ZHVtbXk= ;;
                  *) exit 1 ;;
                esac
                """
            ),
            encoding="utf-8",
        )
        fake_kubectl.chmod(0o755)

        fake_ip = fake_bin / "ip"
        fake_ip.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                case "$*" in
                  "-4 route get 1.1.1.1")
                    echo "1.1.1.1 via 192.168.77.1 dev enp1s0 src 192.168.77.42 uid 0"
                    ;;
                  "-o -4 addr show scope global")
                    echo "2: enp1s0 inet 192.168.77.42/24 brd 192.168.77.255 scope global enp1s0"
                    echo "3: cni0 inet 10.42.0.1/24 brd 10.42.0.255 scope global cni0"
                    echo "4: veth1234 inet 169.254.10.5/16 scope global veth1234"
                    ;;
                  "-6 route get 2001:4860:4860::8888") exit 1 ;;
                  "-o -6 addr show scope global")
                    echo "4: veth1234 inet6 fd00::42/64 scope global"
                    ;;
                  *) exit 1 ;;
                esac
                """
            ),
            encoding="utf-8",
        )
        fake_ip.chmod(0o755)

        for name, content in {
            "id": '#!/usr/bin/env bash\n[[ "${1:-}" == "-u" ]] && echo 0\n',
            "openssl": '#!/usr/bin/env bash\ncat >/dev/null\necho "sha256 Fingerprint=AA:BB:CC:DD"\n',
            "systemctl": "#!/usr/bin/env bash\nexit 0\n",
        }.items():
            executable = fake_bin / name
            executable.write_text(content, encoding="utf-8")
            executable.chmod(0o755)

        rendered = TEMPLATE.read_text(encoding="utf-8")
        replacements = {
            "{{ setup_kubectl_binary | quote }}": shlex.quote(str(fake_kubectl)),
            "{{ setup_kubeconfig_path | quote }}": shlex.quote(str(temporary_path / "kubeconfig")),
            "{{ setup_namespace | quote }}": shlex.quote("identity-system"),
            "{{ setup_state_directory | quote }}": shlex.quote(str(temporary_path)),
            "{{ setup_claim_file | quote }}": shlex.quote(str(claim_file)),
            "{{ setup_claim_length | quote }}": shlex.quote("8"),
            "{{ setup_claim_alphabet | quote }}": shlex.quote("0123456789abcdefghjkmnpqrstvwxyz"),
            "{{ setup_resource_name | quote }}": shlex.quote("local"),
            "{{ setup_dashboard_console_service | quote }}": shlex.quote("magicstick-dashboard-console.service"),
        }
        for source, target in replacements.items():
            rendered = rendered.replace(source, target)
        self.assertNotIn("{{", rendered)

        rendered_script = temporary_path / "magicstick"
        rendered_script.write_text(rendered, encoding="utf-8")
        rendered_script.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
        return rendered_script, environment

    def run_script(self, script, environment, *arguments):
        return subprocess.run(
            ["bash", str(script), *arguments],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )

    def test_rendered_script_parses_and_shows_only_primary_lan_address(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            script, environment = self.render_console_script(temporary_directory)
            syntax = subprocess.run(
                ["bash", "-n", str(script)],
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(syntax.returncode, 0, syntax.stderr)

            result = self.run_script(script, environment, "setup", "show")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("https://magicstick.local/", result.stdout)
            self.assertIn("https://192.168.77.42:9443/setup", result.stdout)
            self.assertNotIn("10.42.0.1", result.stdout)
            self.assertNotIn("169.254.10.5", result.stdout)
            self.assertNotIn("fd00::42", result.stdout)
            self.assertIn("abc234xy", result.stdout)
            self.assertIn("AA:BB:CC:DD", result.stdout)

    def test_console_mode_clears_screen_and_removes_completed_claim(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            script, environment = self.render_console_script(temporary_directory)
            pending = self.run_script(script, environment, "setup", "console")
            self.assertEqual(pending.returncode, 0, pending.stderr)
            self.assertTrue(pending.stdout.startswith("\x1b[2J\x1b[H"))
            self.assertIn("EINRICHTUNGSCODE", pending.stdout)
            self.assertIn("SICHERE ERSTEINRICHTUNG", pending.stdout)
            self.assertIn("\x1b[1;95m", pending.stdout)
            visible_output = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", pending.stdout)
            self.assertLessEqual(len(visible_output.splitlines()), 25, visible_output)
            self.assertTrue(
                all(len(line) <= 80 for line in visible_output.splitlines()),
                visible_output,
            )

            completed_environment = environment.copy()
            completed_environment["FAKE_PHASE"] = "Completed"
            completed = self.run_script(script, completed_environment, "setup", "console")
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("EINRICHTUNG ABGESCHLOSSEN", completed.stdout)
            self.assertNotIn("abc234xy", completed.stdout)
            self.assertNotIn("EINRICHTUNGSCODE", completed.stdout)

            completed_hold = self.run_script(
                script, completed_environment, "setup", "console", "--hold"
            )
            self.assertEqual(completed_hold.returncode, 0, completed_hold.stderr)

    def test_systemd_console_is_deferred_until_cloud_final(self):
        tasks = TASKS.read_text(encoding="utf-8")
        self.assertIn("After=cloud-final.service k3s.service network-online.target", tasks)
        self.assertIn("Conflicts={{ setup_dashboard_console_service }}", tasks)
        self.assertIn("ConditionPathExists={{ setup_claim_file }}", tasks)
        self.assertIn("ExecStartPre=-/usr/bin/chvt 9", tasks)
        self.assertIn("ExecStart=/usr/local/sbin/magicstick setup console --hold", tasks)
        self.assertIn("ExecStopPost=-/usr/bin/chvt 1", tasks)
        self.assertIn("StandardInput=tty-force", tasks)
        self.assertIn("TTYPath=/dev/tty9", tasks)
        self.assertIn("TTYReset=yes", tasks)
        self.assertIn("TTYVHangup=yes", tasks)
        self.assertIn("TTYVTDisallocate=yes", tasks)
        self.assertIn("no_block: true", tasks)
        self.assertNotIn("ExecStart=/usr/local/sbin/magicstick setup show", tasks)

        template = TEMPLATE.read_text(encoding="utf-8")
        self.assertNotIn("{#", template)
        self.assertIn("CONSOLE_REFRESH_SECONDS=30", template)
        self.assertIn("render_console_setup || true", template)
        self.assertIn("SICHERE ERSTEINRICHTUNG", template)
        self.assertIn('systemctl start --no-block "$SETUP_CLEANUP_SERVICE"', template)
        self.assertIn('systemctl start --no-block "$DASHBOARD_CONSOLE_SERVICE"', template)


if __name__ == "__main__":
    unittest.main()
