import pathlib
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]
USER_DATA = ROOT / "magic-installer" / "user-data"


class InstallerNetworkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.user_data = USER_DATA.read_text(encoding="utf-8")
        cls.cloud_config = yaml.safe_load(cls.user_data)
        cls.autoinstall = cls.cloud_config["autoinstall"]

    def test_network_configuration_remains_interactive(self):
        self.assertIn("network", self.autoinstall["interactive-sections"])
        self.assertIn("wpasupplicant", self.autoinstall["packages"])

    def test_installer_template_does_not_embed_wireless_credentials(self):
        self.assertNotIn("network", self.autoinstall)
        self.assertNotIn("wifis:", self.user_data)
        self.assertNotIn("access-points:", self.user_data)


if __name__ == "__main__":
    unittest.main()
