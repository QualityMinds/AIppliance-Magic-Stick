# SPDX-License-Identifier: BUSL-1.1
"""AUTH-09 setup upgrade counterexamples; Kubernetes API coverage is separate."""
import copy
import importlib.util
from pathlib import Path
import unittest

import yaml

ROLE = Path(__file__).resolve().parents[1]
ROOT = ROLE.parents[2]
loader = importlib.util.spec_from_file_location("setup_strategy", ROLE / "files/setup_strategy.py")
migration = importlib.util.module_from_spec(loader)
loader.loader.exec_module(migration)


def deployment():
    value = next(d for d in yaml.safe_load_all((ROOT / "magic-cluster/platform/identity/setup-app.yaml").read_text())
                 if d["kind"] == "Deployment")
    value["metadata"].update(uid="fixture-uid", resourceVersion="7", labels=dict(migration.OWNER))
    value["spec"]["strategy"] = {"type": "RollingUpdate", "rollingUpdate": {"maxSurge": "25%", "maxUnavailable": "25%"}}
    return value


class SetupStrategyTests(unittest.TestCase):
    def test_clears_legacy_fields_atomically_without_touching_other_spec_fields(self):
        original = deployment()
        current = copy.deepcopy(original)
        writes = []

        def command(args, body=None):
            if args[0] == "get":
                return copy.deepcopy(current)
            self.assertEqual(args[:4], ["patch", "deployment", migration.NAME, "--type=json"])
            writes.append(body)
            for item in body:
                key, field = item["path"].strip("/").split("/")
                if item["op"] == "test":
                    self.assertEqual(current[key][field], item["value"])
                else:
                    current[key][field] = copy.deepcopy(item["value"])
            current["metadata"]["resourceVersion"] = "8"

        self.assertTrue(migration.migrate(command))
        self.assertEqual(current["spec"], {**original["spec"], "strategy": {"type": "Recreate"}})
        self.assertEqual([x["path"] for x in writes[0] if x["op"] == "test"],
                         ["/metadata/uid", "/metadata/resourceVersion", "/spec/strategy"])
        self.assertFalse(migration.migrate(command))
        self.assertEqual(len(writes), 1)

    def test_new_installation_has_nothing_to_migrate(self):
        calls = []
        self.assertFalse(migration.migrate(lambda args, body=None: calls.append(args)))
        self.assertEqual(len(calls), 1)

    def test_foreign_or_modified_identity_is_not_patched(self):
        for mutate in (lambda d: d["metadata"].update(uid=""),
                       lambda d: d["metadata"].update(resourceVersion=""),
                       lambda d: d["metadata"].update(namespace="other"),
                       lambda d: d["metadata"].update(labels={}),
                       lambda d: d["metadata"].update(deletionTimestamp="2026-01-01T00:00:00Z"),
                       lambda d: d["spec"].update(replicas=2),
                       lambda d: d["spec"].update(selector={"matchLabels": {"app": "other"}}),
                       lambda d: d["spec"].update(strategy={"type": "Unknown"})):
            value = deployment()
            mutate(value)
            with self.subTest(value=value["metadata"]):
                with self.assertRaises(ValueError):
                    migration.migration_patch(value)

    def test_conflict_and_lost_ack_do_not_retry_or_claim_success(self):
        for message in ("Conflict", "Lost response"):
            calls = []

            def command(args, body=None):
                calls.append(args)
                if args[0] == "patch":
                    raise ValueError(message)
                return deployment()

            with self.assertRaisesRegex(ValueError, message):
                migration.migrate(command)
            self.assertEqual([a[0] for a in calls], ["get", "patch"])

    def test_unverified_write_and_replaced_uid_are_errors(self):
        for confirmed, change in ((False, lambda d: None),
                                  (True, lambda d: d["metadata"].update(uid="foreign-uid")),
                                  (True, lambda d: d["spec"].update(replicas=0))):
            value = deployment()

            def command(args, body=None):
                if args[0] == "patch":
                    if confirmed:
                        value["spec"]["strategy"] = dict(migration.TARGET)
                    change(value)
                return copy.deepcopy(value)

            with self.assertRaises(ValueError):
                migration.migrate(command)

    def test_role_runs_migration_before_any_flux_reconcile(self):
        tasks = yaml.safe_load((ROLE / "tasks/main.yml").read_text())
        index = next(i for i, t in enumerate(tasks) if "setup_strategy.py" in str(t))
        task = tasks[index]
        self.assertIn("setup-strategy: changed", task["changed_when"])
        self.assertLess(index, next(i for i, t in enumerate(tasks) if t["name"].startswith("Bootstrap Flux")))
        self.assertIn("{{ flux_kubeconfig_path }}", task["ansible.builtin.command"]["argv"])
