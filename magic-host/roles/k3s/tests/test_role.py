from pathlib import Path
import unittest
import tomllib

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

    def test_nvidia_runtime_is_predeclared_before_install_without_changing_cpu_default(self):
        config = tomllib.loads((ROLE / 'files/90-magicstick-nvidia.toml').read_text())
        cri = config['plugins']['io.containerd.cri.v1.runtime']
        self.assertTrue(cri['enable_cdi'])
        self.assertNotIn('default_runtime_name', cri['containerd'])
        self.assertEqual(set(cri['containerd']['runtimes']), {'nvidia', 'nvidia-cdi', 'nvidia-legacy'})
        for runtime in cri['containerd']['runtimes'].values():
            self.assertTrue(runtime['options']['BinaryName'].startswith('/usr/local/nvidia/toolkit/'))
            self.assertTrue(runtime['options']['SystemdCgroup'])
        preseed = next(task for task in self.tasks if task.get('ansible.builtin.copy', {}).get('src') == '90-magicstick-nvidia.toml')
        self.assertLess(self.tasks.index(preseed), self.tasks.index(self.install))

    def test_toolkit_does_not_signal_k3s_managed_containerd(self):
        root = ROLE.parents[2]
        release = yaml.safe_load((root / 'magic-cluster/platform/gpu/nvidia-gpu-operator/helmrelease.yaml').read_text())
        env = {entry['name']: entry['value'] for entry in release['spec']['values']['toolkit']['env']}
        self.assertEqual(env['RUNTIME_RESTART_MODE'], 'none')
        self.assertEqual(env['NVIDIA_RUNTIME_SET_AS_DEFAULT'], 'false')

    def test_existing_cluster_is_not_upgraded_by_host_convergence(self):
        self.assertEqual(self.install["args"]["creates"], "/usr/local/bin/k3s")
        install_commands = [task for task in self.tasks if "https://get.k3s.io" in task.get("ansible.builtin.shell", "")]
        self.assertEqual(install_commands, [self.install])

    def test_version_is_passed_as_environment_not_shell_interpolation(self):
        self.assertNotIn("{{ k3s_version", self.install["ansible.builtin.shell"])
        self.assertIn("https://get.k3s.io", self.install["ansible.builtin.shell"])

    def test_bootstrap_checks_for_existing_config_before_rendering(self):
        check = next(task for task in self.tasks if task.get("register") == "k3s_existing_config")
        configure = next(task for task in self.tasks if task.get("ansible.builtin.import_tasks") == "configure.yml")
        self.assertEqual(check["ansible.builtin.stat"]["path"], "/etc/rancher/k3s/config.yaml")
        self.assertLess(self.tasks.index(check), self.tasks.index(configure))

    def test_bootstrap_never_rewrites_an_existing_identity_aware_config(self):
        configure = next(task for task in self.tasks if task.get("ansible.builtin.import_tasks") == "configure.yml")
        self.assertEqual(configure["when"], "not k3s_existing_config.stat.exists")

    def test_identity_stage_remains_the_steady_state_config_writer(self):
        tasks = yaml.safe_load((ROLE.parent / "kubernetes-oidc/tasks/main.yml").read_text())
        configure = next(task for task in tasks if task.get("ansible.builtin.include_role", {}).get("name") == "k3s")
        self.assertEqual(configure["ansible.builtin.include_role"]["tasks_from"], "configure")
        self.assertNotIn("when", configure)
        self.assertEqual(configure["vars"]["k3s_tls_sans"], [
            "{{ kubernetes_oidc_mdns_domain }}", "{{ kubernetes_oidc_host_address }}",
        ])
        self.assertEqual(configure["vars"]["k3s_oidc_issuer_url"], "{{ kubernetes_oidc_issuer_url }}")
        trust_check = next(task for task in tasks if task.get("register") == "kubernetes_oidc_discovery")
        flush = next(task for task in tasks if task.get("ansible.builtin.meta") == "flush_handlers")
        self.assertLess(tasks.index(trust_check), tasks.index(configure))
        self.assertLess(tasks.index(configure), tasks.index(flush))


if __name__ == "__main__":
    unittest.main()
