import pathlib
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parents[1]


def gateway_documents():
    return [
        document
        for document in yaml.safe_load_all((ROOT / "base" / "gateway.yaml").read_text(encoding="utf-8"))
        if document
    ]


class LiteLlmGatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.documents = gateway_documents()
        cls.policies = {
            document["metadata"]["name"]: document
            for document in cls.documents
            if document.get("kind") == "SecurityPolicy"
        }

    def test_local_and_public_oidc_do_not_replace_litellm_authorization(self):
        for name in ("static-litellm-local-sso", "static-litellm-public-sso"):
            with self.subTest(policy=name):
                oidc = self.policies[name]["spec"]["oidc"]
                self.assertIs(oidc["forwardAccessToken"], False)
                self.assertEqual(oidc["clientID"], "magicstick-human-gateway-local")
                self.assertIn("issuer", oidc["provider"])
                self.assertIn("redirectURL", oidc)

    def test_litellm_routes_remain_sso_and_role_protected(self):
        for name in ("static-litellm-local-sso", "static-litellm-public-sso"):
            with self.subTest(policy=name):
                policy = self.policies[name]["spec"]
                self.assertIn("oidc", policy)
                self.assertEqual(
                    policy["jwt"]["providers"][0]["extractFrom"]["cookies"],
                    ["MagicStickAccessToken"],
                )
                roles = policy["authorization"]["rules"][0]["principal"]["jwt"]["claims"][0]["values"]
                self.assertEqual(
                    roles,
                    [
                        "magicstick-user",
                        "magicstick-viewer",
                        "magicstick-operator",
                        "magicstick-admin",
                    ],
                )


if __name__ == "__main__":
    unittest.main()
