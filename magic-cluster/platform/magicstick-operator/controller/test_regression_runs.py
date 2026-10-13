import base64
import copy
import json
import unittest
from unittest.mock import patch

from test_controller import load_controller, ROOT
from regression_runs import RegressionRuns, JOBS, RUNS, NS, OWNER
import yaml

UID = "11111111-2222-3333-4444-555555555555"
NODE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class RegressionRunsTests(unittest.TestCase):
    def setUp(self):
        self.run = {"metadata": {"name": "regression-" + "1"*32, "uid": UID,
            "annotations": {"regression.magicstick.dev/credentials-ready": UID}}, "spec": {
            "applianceUid": UID, "nodeUids": [NODE], "phases": list(range(9)), "sourceRevision": "a"*40,
            "image": "ghcr.io/qualityminds/magicstick-regression:sha-" + "a"*40 + "@sha256:" + "b"*64}, "status": {}}
        self.account = {"runUid": UID, "registration": {"dashboardUrl": "https://example.local"}, "gatewayIp": "192.0.2.10"}
        self.objects = {"/api/v1/namespaces/" + NS + "/configmaps/registered-lab": {"immutable": True,
            "metadata": {"labels": {"regression.magicstick.dev/appliance-uid": UID}},
            "data": {"kind": "disposable-regression-lab", "nodeUids": NODE}},
            "/api/v1/namespaces/" + NS + "/secrets/" + self.run["metadata"]["name"]: {
                "metadata": {"labels": {OWNER: UID}}, "data": {"account.json": base64.b64encode(json.dumps(self.account).encode()).decode()}}}
        self.writes = []
        self.f = {"get_json": lambda path: copy.deepcopy(self.objects.get(path)), "list_items": self.list,
            "request_json": self.write, "patch_json": self.status, "delete_json": self.delete,
            "appliance": lambda: {"metadata": {"uid": UID}}, "now": lambda: "2026-10-13T12:00:00Z"}
        self.controller = RegressionRuns(self.f)
        self.controller.report = lambda _uid: None

    def list(self, path):
        if path == "/api/v1/nodes":
            return [{"metadata": {"uid": NODE}}]
        if "/pods" in path:
            return getattr(self, "pods", [])
        return [self.run]

    def status(self, path, data):
        if "status" in data:
            self.run["status"].update(data["status"])
        else:
            self.run["metadata"].setdefault("annotations", {}).update(data["metadata"]["annotations"])

    def write(self, method, path, data):
        self.writes.append((method, path, copy.deepcopy(data)))
        data = copy.deepcopy(data)
        data["metadata"]["uid"] = "job-uid"
        self.objects[path + "/" + data["metadata"]["name"]] = data
        return data

    def delete(self, path, data):
        self.writes.append(("DELETE", path, data))
        del self.objects[path]

    def test_exact_job_uses_existing_runner_no_gpu_host_docker_or_sa(self):
        self.assertTrue(self.controller.reconcile(self.run))
        job = self.writes[0][2]
        self.assertEqual(job["spec"]["backoffLimit"], 0)
        pod = job["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["containers"][0]["command"], ["node", "regression/kubernetes.mjs"])
        self.assertEqual(pod["securityContext"]["seccompProfile"]["type"], "RuntimeDefault")
        self.assertEqual(pod["securityContext"]["fsGroupChangePolicy"], "OnRootMismatch")
        self.assertFalse(any("hostPath" in v for v in pod["volumes"]))
        self.assertNotIn("nvidia.com/gpu", json.dumps(job))
        self.assertNotIn("password", json.dumps(job))
        self.assertIn("requiredDuringSchedulingIgnoredDuringExecution", pod["affinity"]["podAffinity"])
        self.assertEqual(job["metadata"]["labels"][OWNER], UID)

    def test_repeated_reconciliation_never_restarts_a_destructive_job(self):
        self.controller.reconcile(self.run)
        with patch.object(self.controller, "report", return_value=None):
            self.controller.reconcile(self.run)
        self.assertEqual(len(self.writes), 1)

    def test_lost_job_is_failed_not_recreated_even_after_operator_restart(self):
        self.controller.reconcile(self.run)
        del self.objects[JOBS + "/" + self.run["metadata"]["name"]]
        self.controller.reconcile(self.run)
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(self.run["status"]["phase"], "Failed")
        self.assertTrue(self.run["status"]["credentialRecoveryRequired"])
        self.run["status"]["phase"] = "Failed"
        self.controller.reconcile(self.run)
        self.assertEqual(len(self.writes), 1)

    def test_foreign_job_is_not_adopted_or_deleted(self):
        self.objects[JOBS + "/" + self.run["metadata"]["name"]] = {"metadata": {"labels": {OWNER: "foreign"}}}
        self.run["spec"]["cancelRequested"] = True
        self.controller.reconcile(self.run)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.run["status"]["phase"], "Failed")

    def test_wrong_installation_blocks_before_job_creation(self):
        self.run["spec"]["nodeUids"] = ["replacement-node"]
        self.controller.reconcile(self.run)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.run["status"]["phase"], "Blocked")

    def test_cancel_has_uid_preconditions_and_waits_for_pods(self):
        self.controller.reconcile(self.run)
        self.run["spec"]["cancelRequested"] = True
        self.controller.reconcile(self.run)
        self.assertEqual(self.writes[-1][2]["preconditions"], {"uid": "job-uid"})
        self.assertEqual(self.run["status"]["phase"], "Cancelling")
        self.pods = [{"metadata": {"labels": {OWNER: UID}}}]
        self.controller.reconcile(self.run)
        self.assertEqual(self.run["status"]["phase"], "Cancelling")
        self.pods = []
        self.controller.reconcile(self.run)
        self.assertEqual(self.run["status"]["phase"], "Cancelled")

    def test_result_and_report_are_not_kubernetes_success_inferences(self):
        self.controller.reconcile(self.run)
        job = self.objects[JOBS + "/" + self.run["metadata"]["name"]]
        job["status"] = {"conditions": [{"type": "Complete", "status": "True"}]}
        report = {"runUid": UID, "outcome": "Blocked", "progress": {"percent": 100}, "result": {"counts": {"Blocked": 4}}, "reportAvailable": True}
        with patch.object(self.controller, "report", return_value=report):
            self.controller.reconcile(self.run)
        self.assertEqual(self.run["status"]["phase"], "Blocked")
        self.assertTrue(self.run["status"]["reportAvailable"])
        self.assertEqual(self.run["status"]["result"], report["result"])

    def test_status_outage_keeps_reservation_and_credentials_until_recovery(self):
        self.controller.reconcile(self.run)
        with patch.object(self.controller, "report", side_effect=OSError("synthetic-secret")):
            self.controller.reconcile_all()
        self.assertEqual(self.run["status"]["phase"], "Recovering")
        self.assertNotIn("synthetic-secret", json.dumps(self.run["status"]))

    def test_controller_is_wired_and_rbac_never_grants_api_job_writes(self):
        controller = load_controller()
        self.assertIn("RegressionRuns", controller["reconcile_once"].__code__.co_names)
        role = yaml.safe_load_all((ROOT.parents[1] / "apps/regression/rbac.yaml").read_text())
        docs = list(role)
        api_role = next(d for d in docs if d["kind"] == "Role" and d["metadata"]["name"] == "dashboard-regression-credentials")
        self.assertFalse(any("jobs" in r["resources"] for r in api_role["rules"]))

    def test_setup_identity_is_protected_before_job_creation_and_hard_failure(self):
        self.controller.reconcile(self.run)
        self.assertEqual(self.run["metadata"]["annotations"]["regression.magicstick.dev/credentials-used"], UID)
        job = self.objects[JOBS + "/" + self.run["metadata"]["name"]]
        job["status"] = {"conditions": [{"type": "Failed", "status": "True"}]}
        self.controller.reconcile(self.run)
        self.assertEqual(self.run["status"]["phase"], "Failed")
        self.assertTrue(self.run["status"]["credentialRecoveryRequired"])

    def test_recovery_job_uses_only_original_uid_bound_secret(self):
        self.run["spec"].update(accountRunName=self.run["metadata"]["name"], accountRunUid=UID)
        self.run["metadata"]["name"] = "regression-" + "2"*32
        self.controller.reconcile(self.run)
        pod = self.writes[0][2]["spec"]["template"]["spec"]
        self.assertEqual(next(v for v in pod["volumes"] if v["name"] == "account")["secret"]["secretName"], "regression-" + "1"*32)
        self.assertEqual(next(e for e in pod["containers"][0]["env"] if e["name"] == "REGRESSION_ACCOUNT_RUN_UID")["value"], UID)

    def test_finished_report_explicitly_confirms_setup_access_restoration(self):
        self.controller.reconcile(self.run)
        job = self.objects[JOBS + "/" + self.run["metadata"]["name"]]
        job["status"] = {"conditions": [{"type": "Complete", "status": "True"}]}
        self.controller.report = lambda _: {"runUid": UID, "outcome": "Passed", "credentialRecoveryRequired": False}
        self.controller.reconcile(self.run)
        self.assertFalse(self.run["status"]["credentialRecoveryRequired"])

    def test_separately_accepted_intent_waits_for_previous_account_cleanup(self):
        predecessor = copy.deepcopy(self.run)
        predecessor["status"] = {"phase": "Passed", "credentialsCleaned": False}
        predecessor["metadata"]["creationTimestamp"] = "2026-10-13T10:00:00Z"
        self.run["metadata"].update(name="regression-" + "2"*32, creationTimestamp="2026-10-13T11:00:00Z")
        self.f["list_items"] = lambda path: [predecessor, self.run] if path == RUNS else self.list(path)
        self.controller.reconcile_all()
        self.assertEqual(self.writes, [])
        self.assertEqual(self.run["status"]["phase"], "Queued")

    def test_abandoned_credential_provisioning_is_bounded_without_deleting_recovery_identity(self):
        self.run["metadata"]["annotations"] = {}
        self.run["metadata"]["creationTimestamp"] = "2026-10-13T11:00:00Z"
        self.controller.reconcile(self.run)
        self.assertEqual(self.run["status"]["phase"], "Failed")
        self.assertFalse(self.run["status"]["credentialRecoveryRequired"])
        self.assertEqual(self.writes, [])
        self.run["status"] = {}
        self.run["spec"].update(accountRunName="regression-"+"2"*32,accountRunUid=UID,cancelRequested=True)
        self.controller.reconcile(self.run)
        self.assertEqual(self.run["status"]["phase"], "Cancelled")
        self.assertTrue(self.run["status"]["credentialRecoveryRequired"])
