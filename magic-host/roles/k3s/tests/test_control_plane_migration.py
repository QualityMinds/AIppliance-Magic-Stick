from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


FILES = Path(__file__).resolve().parents[1] / "files"
with patch.object(sys, "path", [str(FILES), *sys.path]):
    import control_plane_migration as migration


PREVIOUS = "192.0.2.17"
NODE = "18c383c1-0b87-419a-bfe9-9c72801981dc"


class TransitionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.targets = {key: root / name for key, name in migration.FILES.items()}
        self.journal = root / "migration.json"
        self.calls = []
        self.fail_reconcile = False
        self.fail_first_start = False
        self.conflict = False
        self.internal_present = False
        self.deny_rollback = False
        self.identity = "local-machine"
        self.transition = migration.Transition(
            self.journal, self.targets, FILES, kube=self,
            check_reservation=lambda: self.calls.append("guard"),
            stop=lambda: self.calls.append("stop"),
            restart=self.restart, reconcile=self.reconcile,
            identity=lambda: self.identity,
            remove_interface=lambda: self.calls.append("remove-owned-interface"),
            has_interface=lambda: self.internal_present,
            authorize_restore=self.authorize_restore,
        )

    def authorize_restore(self):
        if self.deny_rollback:
            raise migration.MigrationError("Different active owner")

    def snapshot(self, uid):
        self.calls.append(("snapshot", uid))
        return {"nodeUid": uid, "previousIp": PREVIOUS, "loadBalancers": [{"daemonsetUid": "test-lb"}]}

    def refresh(self, plan, address, check_reservation):
        self.assertEqual(plan["nodeUid"], NODE)
        self.assertTrue(self.journal.exists())
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
        self.assertEqual([path.exists() for path in self.targets.values()],
                         [address == migration.TARGET_IP] * 2)
        self.calls.append(("verified-api-and-lb", address))
        check_reservation()

    def wait_control_plane(self, plan, address):
        self.assertEqual(plan["nodeUid"], NODE)
        self.calls.append(("settled-control-plane", address))

    def restart(self):
        self.calls.append("start")
        if self.fail_first_start and self.calls.count("start") == 1:
            raise RuntimeError("test start failure")

    def reconcile(self, enabled):
        self.calls.append(("reconcile", enabled))
        if self.conflict and enabled:
            self.targets["k3s"].write_text("administrator edit")
        if self.fail_reconcile and enabled:
            raise RuntimeError("test gateway readiness failure")

    def test_success_requires_verified_endpoints_and_reconciliation_before_clear(self):
        self.transition.apply(NODE)
        self.assertFalse(self.journal.exists())
        self.assertTrue(all(path.exists() for path in self.targets.values()))
        self.assertIn(("verified-api-and-lb", migration.TARGET_IP), self.calls)
        self.assertIn(("reconcile", True), self.calls)
        self.assertNotIn("stop", self.calls)

    def test_failed_k3s_start_restores_original_network_and_clears_journal_only_after_verified(self):
        self.fail_first_start = True
        with self.assertRaisesRegex(migration.MigrationError, "previous API.*verified"):
            self.transition.apply(NODE)
        self.assertFalse(any(path.exists() for path in self.targets.values()))
        self.assertEqual(self.calls.count("start"), 2)
        self.assertIn(("verified-api-and-lb", PREVIOUS), self.calls)
        self.assertIn(("reconcile", False), self.calls)
        self.assertFalse(self.journal.exists())

    def test_late_failure_restores_only_own_files_and_reconciles_both_directions(self):
        self.fail_reconcile = True
        self.internal_present = True
        with self.assertRaisesRegex(migration.MigrationError, "previous API.*verified"):
            self.transition.apply(NODE)
        self.assertFalse(self.journal.exists())
        self.assertEqual([item for item in self.calls if isinstance(item, tuple) and item[0] == "reconcile"],
                         [("reconcile", True), ("reconcile", False)])
        self.assertLess(self.calls.index("stop"), self.calls.index("remove-owned-interface"))
        self.assertLess(self.calls.index(("settled-control-plane", PREVIOUS)),
                        self.calls.index("remove-owned-interface"))
        self.assertEqual(self.calls.count("start"), 4)

    def test_concurrent_edit_preserves_both_files_and_journal(self):
        self.fail_reconcile = self.conflict = True
        with self.assertRaisesRegex(migration.MigrationError, "local recovery"):
            self.transition.apply(NODE)
        self.assertEqual(self.targets["k3s"].read_text(), "administrator edit")
        self.assertTrue(self.targets["systemd"].exists())
        self.assertEqual(json.loads(self.journal.read_text())["phase"], "applying")
        self.assertNotIn("stop", self.calls)
        with self.assertRaisesRegex(migration.MigrationError, "pending"):
            self.transition.apply(NODE)

    def test_recovery_never_accepts_different_host_identity(self):
        self.transition.write_journal({"version": 1, "host": "different host"})
        with self.assertRaisesRegex(migration.MigrationError, "does not belong"):
            self.transition.recover()
        self.assertEqual(self.calls, [])
        self.assertTrue(self.journal.exists())

    def test_existing_target_is_not_overwritten_even_with_matching_content(self):
        self.targets["k3s"].write_bytes((FILES / migration.FILES["k3s"]).read_bytes())
        with self.assertRaisesRegex(migration.MigrationError, "not be overwritten"):
            self.transition.apply(NODE)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.journal.exists())

    def test_hardware_acceptance_keeps_recovery_until_explicit_confirmation(self):
        self.transition.apply(NODE, require_confirmation=True)
        self.assertEqual(json.loads(self.journal.read_text())["phase"], "awaiting-verification")
        self.control_plane_ready = lambda uid, address: True
        self.lb_ready = lambda lb, address: False
        with self.assertRaisesRegex(migration.MigrationError, "no longer verify"):
            self.transition.confirm()
        self.assertTrue(self.journal.exists())
        self.lb_ready = lambda lb, address: address == migration.TARGET_IP
        self.transition.confirm()
        self.assertFalse(self.journal.exists())

    def test_recovery_can_be_used_after_internal_checks_pass(self):
        self.transition.apply(NODE, require_confirmation=True)
        self.transition.recover()
        self.assertFalse(self.journal.exists())
        self.assertFalse(any(path.exists() for path in self.targets.values()))
        self.assertIn(("verified-api-and-lb", PREVIOUS), self.calls)

    def test_recovery_preserves_journal_if_the_live_owner_cannot_be_verified(self):
        self.transition.apply(NODE, require_confirmation=True)
        self.deny_rollback = True
        with self.assertRaisesRegex(migration.MigrationError, "Different active owner"):
            self.transition.recover()
        self.assertTrue(self.journal.exists())
        self.assertTrue(all(path.exists() for path in self.targets.values()))
        self.assertNotIn("stop", self.calls)


class ServiceLBTests(unittest.TestCase):
    def setUp(self):
        self.svc = {
            "metadata": {"name": "test-gateway", "namespace": "test", "uid": "owned-service"},
            "spec": {"type": "LoadBalancer", "externalTrafficPolicy": "Local"},
            "status": {"loadBalancer": {"ingress": [{"ip": migration.TARGET_IP}]}},
        }
        self.ds = {
            "metadata": {
                "name": "svclb-test-gateway", "namespace": "kube-system", "uid": "owned-lb",
                "resourceVersion": "321", "generation": 4, "labels": {
                    migration.LABEL_SERVICE: "test-gateway",
                    migration.LABEL_NAMESPACE: "test",
                },
            },
            "spec": {"template": {"spec": {"containers": [{
                "image": "docker.io/rancher/klipper-lb:v0.4.17",
                "env": [{"name": "DEST_IPS", "valueFrom": {"fieldRef": {"fieldPath": "status.hostIPs"}}}],
            }]}}},
            "status": {
                "observedGeneration": 4, "desiredNumberScheduled": 1,
                "numberReady": 1, "updatedNumberScheduled": 1,
            },
        }
        self.pod = {
            "metadata": {
                "uid": "old-pod", "ownerReferences": [{"uid": "owned-lb", "kind": "DaemonSet", "controller": True}],
            },
            "status": {"conditions": [{"type": "Ready", "status": "True"}], "hostIP": migration.TARGET_IP},
        }
        self.patches = []

    def command(self, args, value=None):
        if args[:2] == ["get", "service"]:
            return deepcopy(self.svc)
        if args[:2] == ["get", "daemonset"]:
            return deepcopy(self.ds)
        if args[:2] == ["get", "pods"]:
            return {"items": [deepcopy(self.pod)]}
        if args[:2] == ["patch", "daemonset"]:
            self.patches.append((args, value))
            self.pod["metadata"]["uid"] = "new-pod"
            return {}
        self.fail(f"unexpected call {args}")

    def test_a_reported_address_cannot_substitute_for_a_fresh_service_lb_pod(self):
        lbs = migration.stock_load_balancers([self.svc], [self.ds])
        cluster = migration.Kube(self.command)
        self.assertFalse(cluster.lb_ready(lbs[0], migration.TARGET_IP, {"old-pod"}))
        cluster.control_plane_ready = lambda uid, address: uid == NODE and address == migration.TARGET_IP
        cluster.refresh({"id": "test-plan", "nodeUid": NODE, "loadBalancers": lbs},
                        migration.TARGET_IP, lambda: None)
        self.assertEqual(len(self.patches), 1)
        command, patch_body = self.patches[0]
        self.assertIn("svclb-test-gateway", command)
        self.assertEqual(patch_body["metadata"], {"uid": "owned-lb", "resourceVersion": "321"})

    def test_unrelated_or_replaced_owners_stop_refresh(self):
        lbs = migration.stock_load_balancers([self.svc], [self.ds])
        cluster = migration.Kube(self.command)
        self.ds["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(migration.MigrationError, "identity changed"):
            cluster.lb_ready(lbs[0], migration.TARGET_IP)
        self.assertEqual(self.patches, [])

    def test_non_stock_local_service_is_rejected_before_any_write(self):
        self.ds["spec"]["template"]["spec"]["containers"][0]["image"] = "unrelated"
        with self.assertRaisesRegex(migration.MigrationError, "could not be verified"):
            migration.stock_load_balancers([self.svc], [self.ds])

    def test_external_lb_classes_and_non_local_load_balancers_are_not_targeted(self):
        external = deepcopy(self.svc)
        external["spec"]["loadBalancerClass"] = "other.example/test"
        cluster_policy = deepcopy(self.svc)
        cluster_policy["spec"]["externalTrafficPolicy"] = "Cluster"
        self.assertEqual(migration.stock_load_balancers([external, cluster_policy], []), [])
