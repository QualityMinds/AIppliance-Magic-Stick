import copy
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "files"))
from regression_guard import Reservation


class RegressionGuardTests(unittest.TestCase):
    def setUp(self):
        label = {"regression.magicstick.dev/appliance-uid": "fixture-appliance"}
        self.marker = {"immutable": True, "metadata": {"labels": label}, "data": {"kind": "disposable-regression-lab"}}
        self.lease = {"metadata": {"uid": "fixture-lease", "resourceVersion": "1", "labels": label,
                                   "annotations": {"regression.magicstick.dev/run-id": "reg-original"}}, "spec": {"holderIdentity": ""}}
        self.runs, self.writes = [], []
        self.reservation = Reservation(self.kube)

    def kube(self, args, value=None):
        if args[:2] == ["get", "configmap"]:
            return copy.deepcopy(self.marker)
        if args[:2] == ["get", "lease"]:
            return copy.deepcopy(self.lease)
        if args[0] == "replace":
            self.assertEqual(value["metadata"]["resourceVersion"], self.lease["metadata"]["resourceVersion"])
            self.lease = copy.deepcopy(value)
            self.lease["metadata"]["resourceVersion"] = str(int(self.lease["metadata"]["resourceVersion"]) + 1)
            self.writes.append(copy.deepcopy(value))
            return copy.deepcopy(self.lease)
        if "regressionruns.appliance.magicstick.dev" in args:
            return {"items": copy.deepcopy(self.runs)}
        if "gitrepository" in args:
            return {"spec": {"ref": {"commit": "current"}}, "status": {"artifact": {"revision": "sha1:current"}}}
        if "kustomizations.kustomize.toolkit.fluxcd.io" in args:
            return {"items": [{"metadata": {"generation": 2}, "spec": {"sourceRef": {"name": "flux-system"}},
                               "status": {"lastAppliedRevision": "sha1:current", "conditions": [
                                   {"type": "Ready", "status": "True", "observedGeneration": self.generation}]}}]}
        raise AssertionError(args)

    def test_active_intent_and_even_expired_test_holders_defer_without_writes(self):
        for phase in ("Queued", "Preparing", "Running", "Recovering", "Cancelling"):
            self.runs = [{"status": {"phase": phase}}]
            with self.assertRaisesRegex(RuntimeError, "active"):
                self.reservation.acquire()
            self.assertEqual(self.writes, [])
        self.runs = []
        self.lease["spec"].update(holderIdentity="reg-old", renewTime="2000-01-01T00:00:00Z", leaseDurationSeconds=1)
        with self.assertRaisesRegex(RuntimeError, "needs recovery"):
            self.reservation.acquire()
        self.assertEqual(self.writes, [])

    def test_idle_reservation_renews_and_releases_only_its_exact_owner_preserving_journals(self):
        self.assertTrue(self.reservation.acquire())
        self.assertEqual(self.lease["spec"]["holderIdentity"], self.reservation.owner)
        self.reservation.renew(); self.reservation.release()
        self.assertEqual(self.lease["spec"]["holderIdentity"], "")
        self.assertEqual(self.lease["metadata"]["annotations"]["regression.magicstick.dev/run-id"], "reg-original")

    def test_changed_owner_is_never_released_and_loss_stops_renewal(self):
        self.reservation.acquire()
        self.lease["spec"]["holderIdentity"] = "reg-concurrent"
        with self.assertRaisesRegex(RuntimeError, "lost"):
            self.reservation.renew()
        before = copy.deepcopy(self.lease); self.reservation.release()
        self.assertEqual(self.lease, before)

    def test_registration_absence_skips_without_manufacturing_a_test_lease(self):
        self.marker = None
        self.assertFalse(self.reservation.acquire())
        self.assertEqual(self.writes, [])

    def test_unverified_rollout_retains_its_reservation_instead_of_opening_the_lab(self):
        self.reservation.acquire(); self.reservation.preserve = True
        self.reservation.release()
        self.assertEqual(self.lease["spec"]["holderIdentity"], self.reservation.owner)
        self.assertEqual(self.lease["metadata"]["annotations"]["regression.magicstick.dev/host-maintenance"], "true")

    def test_only_same_host_expired_maintenance_can_retry_never_a_test_or_foreign_host(self):
        self.reservation.acquire()
        self.lease["spec"].update(renewTime="2000-01-01T00:00:00Z", leaseDurationSeconds=60)
        other = Reservation(self.kube)
        self.assertTrue(other.acquire())
        self.lease["spec"]["renewTime"] = "2000-01-01T00:00:00Z"
        self.lease["metadata"]["annotations"]["regression.magicstick.dev/maintenance-host"] = "different-host"
        before = copy.deepcopy(self.lease)
        with self.assertRaisesRegex(RuntimeError, "reserved"):
            Reservation(self.kube).acquire()
        self.assertEqual(self.lease, before)

    def test_flux_ready_condition_must_observe_the_actual_generation(self):
        self.generation = 1
        with patch("regression_guard.time.sleep"), patch("regression_guard.time.monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(RuntimeError, "Flux has not finished"):
                self.reservation.wait_converged(timeout=1)
        self.generation = 2
        self.reservation.wait_converged(timeout=1)
