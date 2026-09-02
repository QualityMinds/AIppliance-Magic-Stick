import os
import pathlib
import shlex
import subprocess
import tempfile
import textwrap
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]
CONVERGE = ROOT / "magic-host/roles/ansible-pull-timer/files/ai-appliance-converge"
USER_DATA = ROOT / "magic-installer/user-data"
LINUX_INSTALLER = ROOT / "install-from-linux.sh"


class GitHttpFallbackTests(unittest.TestCase):
    def test_cloud_init_command_parses_and_contains_transport_fallback(self):
        cloud_config = yaml.safe_load(USER_DATA.read_text(encoding="utf-8"))
        command = cloud_config["autoinstall"]["user-data"]["runcmd"][-1]
        command_parts = shlex.split(command)

        self.assertEqual(command_parts[:2], ["/bin/bash", "-lc"])
        syntax = subprocess.run(
            ["bash", "-n", "-c", command_parts[2]],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        self.assertIn("GIT_TERMINAL_PROMPT=0", command_parts[2])
        self.assertIn("http.version=HTTP/1.1", command_parts[2])

    def test_linux_installer_contains_noninteractive_http11_fallback(self):
        source = LINUX_INSTALLER.read_text(encoding="utf-8")

        self.assertIn("GIT_TERMINAL_PROMPT=0 git", source)
        self.assertIn("git -c http.version=HTTP/1.1", source)
        self.assertIn("git_with_http11_fallback -C", source)

    def test_converge_retries_clone_and_fetch_with_http11(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary = pathlib.Path(temporary_directory)
            fake_bin = temporary / "bin"
            fake_bin.mkdir()
            checkout = temporary / "checkout"
            git_log = temporary / "git.log"
            ansible_log = temporary / "ansible.log"
            metadata = temporary / "ai-appliance-repo"
            metadata.write_text(
                textwrap.dedent(
                    f"""\
                    FLUX_BOOTSTRAP_MODE=readonly-public
                    MAGICSTICK_PUBLIC_REPO=https://github.example.invalid/public.git
                    MAGICSTICK_PUBLIC_REF=main
                    MAGICSTICK_PUBLIC_REF_KIND=branch
                    MAGICSTICK_PUBLIC_CHECKOUT={shlex.quote(str(checkout))}
                    FLUX_PUBLIC_SYNC_PATH=magic-cluster/flux/entrypoints/single-node
                    AI_APPLIANCE_DOMAIN=magicstick.example.com
                    AI_APPLIANCE_DASHBOARD_HOST=magicstick.example.com
                    AI_APPLIANCE_MDNS_DOMAIN=magicstick.local
                    AI_APPLIANCE_MDNS_NAME=magicstick
                    AI_APPLIANCE_DASHBOARD_MDNS_NAME=magicstick
                    """
                ),
                encoding="utf-8",
            )

            fake_git = fake_bin / "git"
            fake_git.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -u
                    printf '%s\n' "$*" >>"$FAKE_GIT_LOG"
                    args=" $* "

                    if [[ "$args" == *" clone --no-checkout "* ]]; then
                      checkout="${!#}"
                      if [[ "${1:-}" != "-c" ]]; then
                        mkdir -p "$checkout/partial"
                        exit 86
                      fi
                      [[ "${2:-}" == "http.version=HTTP/1.1" ]] || exit 91
                      [[ ! -e "$checkout/partial" ]] || exit 92
                      mkdir -p "$checkout/.git" "$checkout/magic-host/inventory" "$checkout/magic-host/playbooks"
                      : >"$checkout/magic-host/inventory/localhost.yml"
                      : >"$checkout/magic-host/playbooks/local.yml"
                      exit 0
                    fi

                    if [[ "$args" == *" fetch --tags --prune origin "* ]]; then
                      [[ "${1:-}" == "-c" && "${2:-}" == "http.version=HTTP/1.1" ]]
                      exit $?
                    fi

                    if [[ "$args" == *" show-ref --verify --quiet "* ]]; then
                      exit 0
                    fi

                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_git.chmod(0o755)

            fake_ansible = fake_bin / "ansible-playbook"
            fake_ansible.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >\"$FAKE_ANSIBLE_LOG\"\n",
                encoding="utf-8",
            )
            fake_ansible.chmod(0o755)

            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}:{environment['PATH']}"
            environment["REPO_METADATA_ENV_FILE"] = str(metadata)
            environment["FAKE_GIT_LOG"] = str(git_log)
            environment["FAKE_ANSIBLE_LOG"] = str(ansible_log)
            result = subprocess.run(
                ["bash", str(CONVERGE)],
                cwd=ROOT,
                env=environment,
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Git clone failed; retrying with HTTP/1.1", result.stderr)
            self.assertIn("Git transport failed; retrying with HTTP/1.1", result.stderr)
            calls = git_log.read_text(encoding="utf-8")
            self.assertIn("clone --no-checkout https://github.example.invalid/public.git", calls)
            self.assertIn("-c http.version=HTTP/1.1 clone --no-checkout", calls)
            self.assertIn("-C", calls)
            self.assertIn("-c http.version=HTTP/1.1 -C", calls)
            self.assertTrue(ansible_log.read_text(encoding="utf-8").strip())


if __name__ == "__main__":
    unittest.main()
