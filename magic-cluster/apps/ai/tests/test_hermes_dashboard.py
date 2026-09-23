import pathlib
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
HERMES_TEMPLATE = (
    REPO_ROOT
    / "magic-cluster"
    / "apps"
    / "instances"
    / "hermes"
    / "templates"
    / "instance.yaml"
)


class HermesDashboardChartTests(unittest.TestCase):
    def test_chart_enables_dashboard_behind_cluster_service(self):
        template = HERMES_TEMPLATE.read_text(encoding="utf-8")

        for variable, value in (
            ("HERMES_DASHBOARD", '"true"'),
            ("HERMES_DASHBOARD_HOST", '"0.0.0.0"'),
            ("HERMES_DASHBOARD_PORT", '"9119"'),
            ("HERMES_DASHBOARD_INSECURE", '"true"'),
        ):
            with self.subTest(variable=variable):
                self.assertIn(f"- name: {variable}\n      value: {value}", template)

        self.assertIn("- name: gateway\n          port: 8443", template)
        self.assertIn("- name: dashboard\n          port: 9119", template)
        self.assertIn("type: ClusterIP", template)
        self.assertIn("ingress:\n      enabled: false", template)


if __name__ == "__main__":
    unittest.main()
