from pathlib import Path
import unittest

import yaml


ROLE = Path(__file__).resolve().parents[1]


class K3sInstallationContractTests(unittest.TestCase):
    def setUp(self):
        self.defaults = yaml.safe_load((ROLE / "defaults/main.yml").read_text())
        self.tasks = yaml.safe_load((ROLE / "tasks/main.yml").read_text())
        self.install = next(task for task in self.tasks if task.get("name") == "Install K3s (skip if already installed)")

    def test_fresh_install_uses_explicit_release_not_rolling_channel(self):
        self.assertEqual(self.defaults["k3s_version"], "v1.36.4+k3s1")
        self.assertEqual(self.install["environment"]["INSTALL_K3S_VERSION"], "{{ k3s_version }}")
        self.assertNotIn("INSTALL_K3S_CHANNEL", self.install["environment"])

    def test_existing_cluster_is_not_upgraded_by_host_convergence(self):
        self.assertEqual(self.install["args"]["creates"], "/usr/local/bin/k3s")
        install_commands = [task for task in self.tasks if "https://get.k3s.io" in task.get("ansible.builtin.shell", "")]
        self.assertEqual(install_commands, [self.install])

    def test_version_is_passed_as_environment_not_shell_interpolation(self):
        self.assertNotIn("{{ k3s_version", self.install["ansible.builtin.shell"])
        self.assertIn("https://get.k3s.io", self.install["ansible.builtin.shell"])


if __name__ == "__main__":
    unittest.main()
