"""Catalogued host labels change access, never the native agent identity."""
import copy
import hashlib
import json
import shutil
import subprocess
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import yaml

from test_controller import CLUSTER_ROOT, ROOT, load_controller


class AppHostnameTests(unittest.TestCase):
    def setUp(self):
        self.controller = load_controller()
        self.controller["mdns_domain"] = lambda: "ai.example.local"
        self.controller["public_domain"] = lambda: "ai.example.com"
        self.catalog = json.loads(yaml.safe_load((ROOT / "app-catalog.yaml").read_text())["data"]["applications.json"])
        self.definition = self.catalog["applications"]["kubeopencode"]
        self.instance = {"metadata": {"name": "kubeopencode-demo", "uid": "instance-uid", "generation": 1},
                         "spec": {"application": "kubeopencode", "targetNamespace": "ai", "values": {"name": "demo"}}}

    def test_official_opencode_ui_uses_origin_instead_of_false_official_domain_match(self):
        self.assertEqual(self.definition["route"]["hostnameLabel"], "oc")
        old_host = self.controller["app_instance_local_host"](self.instance, "kubeopencode")
        new_host = self.controller["app_instance_local_host"](self.instance, "kubeopencode", self.definition)
        # OpenCode 1.17.11 treats any occurrence of this string as its own site.
        self.assertIn("opencode.ai", old_host)
        self.assertNotIn("opencode.ai", new_host)
        self.assertEqual(new_host, "demo.oc.ai.example.local")

    def test_routes_callbacks_and_status_share_exact_hosts_and_unchanged_guards(self):
        resources, status = self.controller["app_instance_access_resources"](self.instance, self.definition)
        for item in resources:
            if item["kind"] == "HTTPRoute":
                local = "-local" in item["metadata"]["name"]
                self.assertEqual(item["spec"]["hostnames"], ["demo.oc.ai.example.local" if local else "demo.oc.ai.example.com"])
                self.assertEqual(item["spec"]["rules"][0]["backendRefs"][0]["name"], "demo")
            if item["kind"] == "SecurityPolicy":
                self.assertFalse(item["spec"]["extAuth"]["failOpen"])
                self.assertNotIn("cookieDomain", item["spec"]["oidc"])
                self.assertIn("/internal/instance-access/kubeopencode-demo/instance-uid", item["spec"]["extAuth"]["http"]["path"])
                self.assertIn("demo.oc.ai.example.", item["spec"]["oidc"]["redirectURL"])
        self.assertEqual(status["localURL"], "https://demo.oc.ai.example.local/")
        self.assertEqual(status["publicURL"], "https://demo.oc.ai.example.com/")

    def test_native_release_identity_and_saved_values_are_preserved(self):
        before = copy.deepcopy(self.instance)
        old_definition = copy.deepcopy(self.definition)
        old_definition["route"].pop("hostnameLabel")
        source = {"name": "magicstick-public", "namespace": "flux-system"}
        old, _ = self.controller["app_instance_helmrelease"](self.instance, old_definition, source)
        new, url = self.controller["app_instance_helmrelease"](self.instance, self.definition, source)
        values = new["spec"]["values"]["instance"]
        self.assertEqual(values["application"], "kubeopencode")
        self.assertEqual(values["name"], "kubeopencode-demo")
        self.assertEqual(values["localHost"], "demo.oc.ai.example.local")
        self.assertEqual(url, "https://demo.oc.ai.example.local/")
        # The instance chart renders native Agent/Template data, not these
        # access-only host fields. No name, image, workspace or model is replaced.
        old_values = old["spec"]["values"]["instance"]
        for key in ("localHost", "localName", "publicHost"):
            values[key] = old_values[key]
        for key in ("ingress", "server"):
            values["values"][key] = old_values["values"][key]
        self.assertEqual(new, old)
        self.assertEqual(self.instance, before)

    def test_saved_values_cannot_choose_another_hostname_label(self):
        self.instance["spec"]["values"].update(hostnameLabel="foreign", ingress={"host": "foreign.example.com"})
        self.assertEqual(self.controller["app_instance_local_host"](self.instance, "kubeopencode", self.definition),
                         "demo.oc.ai.example.local")

    @unittest.skipUnless(shutil.which("helm"), "Helm is required for the actual native workload render")
    def test_address_update_renders_identical_native_agent_and_template(self):
        old_definition = copy.deepcopy(self.definition)
        old_definition["route"].pop("hostnameLabel")
        rendered = []
        for definition in (old_definition, self.definition):
            release, _ = self.controller["app_instance_helmrelease"](
                self.instance, definition, {"name": "magicstick-public", "namespace": "flux-system"})
            result = subprocess.run(["helm", "template", "kubeopencode-demo",
                str(CLUSTER_ROOT / "apps/instances/kubeopencode"), "--values", "-"],
                input=yaml.safe_dump(release["spec"]["values"]), text=True, capture_output=True, check=True, timeout=30)
            rendered.append(list(yaml.safe_load_all(result.stdout)))
        self.assertEqual(rendered[0], rendered[1], "changing the URL must not change native workload input")
        self.assertEqual({item["kind"] for item in rendered[1]}, {"Agent", "AgentTemplate"})
        template = next(item for item in rendered[1] if item["kind"] == "AgentTemplate")
        for key in ("agentImage", "executorImage", "attachImage"):
            self.assertTrue(template["spec"][key].startswith("ghcr.io/kubeopencode/"))
            self.assertIn("@sha256:", template["spec"][key])

    def test_invalid_catalog_host_labels_are_rejected_not_normalized(self):
        for label in ("", "OC", "*.oc", "oc.other", "https://oc", "-oc", "oc-", "x" * 64, None, [], {}):
            with self.subTest(label=label):
                definition = {"route": {"hostnameLabel": label}}
                with self.assertRaises(ValueError):
                    self.controller["app_instance_local_host"](self.instance, "kubeopencode", definition)

    def test_other_application_names_stay_unchanged_and_labels_do_not_collide(self):
        labels = []
        for application, definition in self.catalog["applications"].items():
            label = self.controller["app_instance_hostname_label"](application, definition)
            labels.append(label)
            if application != "kubeopencode":
                self.assertEqual(label, application)
        self.assertEqual(len(labels), len(set(labels)))

    def test_old_callback_ack_cannot_admit_new_hostname(self):
        current = {"metadata": {"resourceVersion": "1"}, "data": {}}
        status = {"data": {}}
        def read(path):
            return status if path.endswith("-status") else current
        def write(path, body):
            current["data"].update(body["data"])
        def acknowledge():
            raw = current["data"]["callbacks.json"]
            digest = hashlib.sha256(raw.encode()).hexdigest()
            status["data"] = {"version": "1", "client-id": "magicstick-human-gateway-local",
                              "desired-sha256": digest, "verified-sha256": digest, "verified-registry": raw,
                              "verified-at": datetime.now(timezone.utc).isoformat()}
        with patch.dict(self.controller, {"get_json": read, "patch_json": write}):
            self.assertFalse(self.controller["reconcile_callback_registry"]([self.instance]))
            acknowledge()
            self.assertTrue(self.controller["reconcile_callback_registry"]([self.instance], self.catalog))
            self.assertNotIn("instance-uid", self.controller["CALLBACK_ADMITTED_UIDS"])
            entry = json.loads(current["data"]["callbacks.json"])["entries"][0]
            self.assertEqual(entry["local"], "https://demo.oc.ai.example.local/oauth2/callback/kubeopencode-demo-local")
            self.assertEqual(entry["application"], "kubeopencode")
            acknowledge()
            self.assertTrue(self.controller["reconcile_callback_registry"]([self.instance], self.catalog))
            self.assertIn("instance-uid", self.controller["CALLBACK_ADMITTED_UIDS"])

    def test_uncatalogued_request_cannot_poison_other_application_callbacks(self):
        unknown = {"metadata": {"name": "unknown-demo", "uid": "unknown-uid"},
                   "spec": {"application": "unknown"}}
        current = {"metadata": {"resourceVersion": "1"}, "data": {}}
        def read(path):
            return {"data": {}} if path.endswith("-status") else current
        with patch.dict(self.controller, {"get_json": read, "patch_json": lambda path, body: current["data"].update(body["data"])}):
            self.controller["reconcile_callback_registry"]([unknown, self.instance], self.catalog)
            self.assertNotIn("unknown-uid", self.controller["CALLBACK_ADMITTED_UIDS"])
        entries = json.loads(current["data"]["callbacks.json"])["entries"]
        self.assertEqual([entry["uid"] for entry in entries], ["instance-uid"])


if __name__ == "__main__":
    unittest.main()
