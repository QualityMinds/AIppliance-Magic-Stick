import pathlib
import unittest

import yaml


ROLE_DIR = pathlib.Path(__file__).resolve().parents[1]
HOST_DIR = ROLE_DIR.parents[1]


class KubernetesOidcRoleTests(unittest.TestCase):
    def test_role_installs_only_public_ca_and_publishes_non_secret_discovery(self):
        tasks = (ROLE_DIR / "tasks" / "main.yml").read_text(encoding="utf-8")
        defaults = (ROLE_DIR / "defaults" / "main.yml").read_text(encoding="utf-8")
        template = (ROLE_DIR / "templates" / "access-info.yaml.j2").read_text(encoding="utf-8")

        self.assertIn("identity-pilot-ca", defaults)
        self.assertIn("['tls.crt']", tasks)
        self.assertIn("/.well-known/openid-configuration", tasks)
        self.assertIn("--cacert", tasks)
        self.assertIn("MAGICSTICK KUBERNETES OIDC", tasks)
        self.assertIn("ai-appliance-settings", tasks)
        self.assertIn("AI_APPLIANCE_MDNS_DOMAIN", tasks)
        self.assertNotIn("tls.key", tasks)
        self.assertIn('mode: "0644"', tasks)
        self.assertIn("issuer-url:", template)
        self.assertIn("api-server:", template)
        self.assertIn("oidc-ca.crt:", template)
        self.assertNotIn("token", template.lower())
        self.assertNotIn("password", template.lower())
        self.assertNotIn("client-secret", template.lower())
        self.assertNotIn("tls.key", template.lower())

    def test_k3s_template_enables_expected_oidc_claim_contract_only_after_ca_exists(self):
        template = (HOST_DIR / "roles" / "k3s" / "templates" / "config.yaml.j2").read_text(encoding="utf-8")

        self.assertIn("k3s_oidc_ca.stat.exists", template)
        self.assertIn("oidc-issuer-url=", template)
        self.assertIn("oidc-client-id=", template)
        self.assertIn("oidc-username-claim=", template)
        self.assertIn("oidc-username-prefix=", template)
        self.assertIn("oidc-groups-claim=", template)
        self.assertIn("oidc-groups-prefix=", template)
        self.assertIn("oidc-ca-file=", template)
        self.assertIn("tls-san:", template)

    def test_playbook_runs_oidc_after_flux_and_before_first_run_console(self):
        playbook = yaml.safe_load((HOST_DIR / "playbooks" / "local.yml").read_text(encoding="utf-8"))[0]
        roles = playbook["roles"]

        self.assertLess(roles.index("flux-bootstrap"), roles.index("kubernetes-oidc"))
        self.assertLess(roles.index("kubernetes-oidc"), roles.index("first-run-setup"))


if __name__ == "__main__":
    unittest.main()
