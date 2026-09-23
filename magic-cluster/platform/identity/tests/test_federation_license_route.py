# SPDX-License-Identifier: BUSL-1.1
"""The entitlement boundary is external brokering, not local authentication."""
from pathlib import Path
import unittest

import yaml


class FederationRouteTests(unittest.TestCase):
    def setUp(self):
        self.docs = list(yaml.safe_load_all((Path(__file__).parents[1] / "routes.yaml").read_text()))

    def resource(self, kind, name):
        return next(item for item in self.docs if item["kind"] == kind and item["metadata"]["name"] == name)

    def test_only_broker_paths_select_the_licensed_route(self):
        local = self.resource("HTTPRoute", "keycloak")["spec"]
        broker = self.resource("HTTPRoute", "keycloak-federation")["spec"]
        self.assertEqual(local["hostnames"], broker["hostnames"])
        self.assertEqual(local["parentRefs"], broker["parentRefs"])
        self.assertEqual(broker["rules"][0]["matches"], [{"path": {"type": "PathPrefix", "value": "/realms/magicstick/broker"}}])
        self.assertEqual(local["rules"], [{"backendRefs": [{"name": "keycloak", "port": 8080}]}])
        self.assertEqual(broker["rules"][0]["backendRefs"], local["rules"][0]["backendRefs"])

    def test_broker_policy_is_fail_closed_without_affecting_local_route(self):
        policy = self.resource("SecurityPolicy", "keycloak-federation-license")["spec"]
        self.assertEqual(policy["targetRefs"], [{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "name": "keycloak-federation"}])
        self.assertIs(policy["extAuth"]["failOpen"], False)
        self.assertEqual(policy["extAuth"]["http"], {
            "backendRefs": [{"name": "ai-appliance-dashboard-api", "port": 8080}],
            "path": "/internal/federation-license",
        })
        self.assertNotIn("bodyToExtAuth", policy["extAuth"])
        self.assertNotIn("jwt", policy)
        self.assertNotIn("oidc", policy)


if __name__ == "__main__":
    unittest.main()
