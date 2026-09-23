import pathlib
import unittest

import yaml


AI_ROOT = pathlib.Path(__file__).resolve().parents[1]


def gateway_routes(application):
    path = AI_ROOT / application / "base" / "gateway.yaml"
    return {
        document["metadata"]["name"]: document
        for document in yaml.safe_load_all(path.read_text(encoding="utf-8"))
        if document and document.get("kind") == "HTTPRoute"
    }


class StreamingGatewayTimeoutTests(unittest.TestCase):
    def test_static_ai_application_routes_disable_request_timeout(self):
        cases = {
            "anything-llm": "static-anything-llm",
            "kubeopencode": "static-kubeopencode",
            "litellm": "static-litellm",
        }

        for application, route_prefix in cases.items():
            routes = gateway_routes(application)
            for exposure in ("local", "public"):
                name = f"{route_prefix}-{exposure}"
                with self.subTest(application=application, route=name):
                    self.assertEqual(
                        routes[name]["spec"]["rules"][0]["timeouts"],
                        {"request": "0s"},
                    )

    def test_static_ai_callback_routes_keep_default_timeout(self):
        cases = {
            "anything-llm": "static-anything-llm",
            "kubeopencode": "static-kubeopencode",
            "litellm": "static-litellm",
        }

        for application, route_prefix in cases.items():
            routes = gateway_routes(application)
            for exposure in ("local", "public"):
                name = f"{route_prefix}-{exposure}-callback"
                with self.subTest(application=application, route=name):
                    self.assertNotIn("timeouts", routes[name]["spec"]["rules"][0])


if __name__ == "__main__":
    unittest.main()
