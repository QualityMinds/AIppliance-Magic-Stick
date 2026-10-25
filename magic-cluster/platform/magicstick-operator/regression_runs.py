"""Reconcile durable RegressionRun intent through the existing operator.

One serialized job, a pinned existing harness, no Docker socket, GPU claim,
host mount, elevated pod or arbitrary browser-supplied command.
"""
import base64
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone

NS = "magicstick-regression"
RUNS = "/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/regressionruns"
JOBS = "/apis/batch/v1/namespaces/" + NS + "/jobs"
OWNER = "regression.magicstick.dev/run-uid"
TERMINAL = {"Passed", "Failed", "Blocked", "Cancelled"}


class RegressionRuns:
    def __init__(self, functions):
        self.f = functions

    def get(self, path):
        try:
            return self.f["get_json"](path)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise

    def status(self, run, **values):
        self.f["patch_json"](RUNS + "/" + run["metadata"]["name"] + "/status", {"status": {
            "observedGeneration": run["metadata"].get("generation", 1), **values}})

    def job(self, run, account):
        name, uid = run["metadata"]["name"], run["metadata"]["uid"]
        spec = run["spec"]
        recovery = spec.get("operation", "tests") == "recover-lock"
        non_destructive = spec.get("testMode", "full") == "non-destructive"
        recovery_env = [{"name": "REGRESSION_RECOVERY_LOCK", "value": json.dumps(spec["lockRecovery"])}] if recovery else []
        domain = account["registration"]["dashboardUrl"].split("//")[1]
        return {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "namespace": NS,
            "labels": {OWNER: uid, "app.kubernetes.io/name": "magicstick-regression"}}, "spec": {
            "backoffLimit": 0, "activeDeadlineSeconds": 86400, "ttlSecondsAfterFinished": 604800,
            "template": {"metadata": {"labels": {OWNER: uid, "app.kubernetes.io/name": "magicstick-regression"}},
                "spec": {"restartPolicy": "Never", "automountServiceAccountToken": False,
                    "terminationGracePeriodSeconds": 900,
                    "nodeSelector": {"kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64"},
                    "affinity": {"podAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": [{
                        "labelSelector": {"matchLabels": {"app": "magicstick-regression-reports"}},
                        "topologyKey": "kubernetes.io/hostname", "namespaces": [NS]}]}},
                    "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000,
                        "fsGroupChangePolicy": "OnRootMismatch", "seccompProfile": {"type": "RuntimeDefault"}},
                    "hostAliases": [{"ip": account["gatewayIp"], "hostnames": [domain, "id." + domain, "api." + domain, "litellm." + domain, "kubernetes." + domain]}],
                    "containers": [{"name": "runner", "image": spec["image"], "imagePullPolicy": "IfNotPresent",
                        "command": ["node", "regression/kubernetes-recovery.mjs" if recovery else "regression/kubernetes-diagnostic.mjs" if "diagnosticSelection" in spec else "regression/kubernetes-nondestructive.mjs" if non_destructive else "regression/kubernetes.mjs"],
                        "env": [{"name": "REGRESSION_RUN_UID", "value": uid},
                                {"name": "REGRESSION_ACCOUNT_RUN_UID", "value": spec.get("accountRunUid", uid)},
                                {"name": "REGRESSION_APPLIANCE_UID", "value": spec["applianceUid"]},
                                {"name": "REGRESSION_SOURCE_REVISION", "value": spec["sourceRevision"]},
                                {"name": "REGRESSION_TEST_MODE", "value": spec.get("testMode", "full")},
                                {"name": "REGRESSION_PHASES", "value": ",".join(map(str, spec["phases"]))},
                                *([{"name": "REGRESSION_DIAGNOSTIC_SELECTION", "value": spec["diagnosticSelection"]}] if "diagnosticSelection" in spec else []), *recovery_env],
                        "resources": {"requests": {"cpu": "500m", "memory": "2Gi"}, "limits": {"cpu": "4", "memory": "6Gi"}},
                        "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                        "volumeMounts": ([{"name": "state", "mountPath": "/state/reports", "subPath": "reports"}] if non_destructive else [{"name": "state", "mountPath": "/state"},
                                         {"name": "state", "mountPath": "/inputs", "subPath": "inputs"},
                                         {"name": "state", "mountPath": "/private", "subPath": "private"}]) + [{"name": "account", "mountPath": "/account", "readOnly": True},
                                         {"name": "tmp", "mountPath": "/tmp"}, {"name": "shm", "mountPath": "/dev/shm"}]}],
                    "volumes": [{"name": "state", "persistentVolumeClaim": {"claimName": "magicstick-regression-state"}},
                                {"name": "account", "secret": {"secretName": spec.get("accountRunName", name), "defaultMode": 288}},
                                {"name": "tmp", "emptyDir": {}}, {"name": "shm", "emptyDir": {"medium": "Memory", "sizeLimit": "1Gi"}}]}}}}

    def reconcile(self, run, busy=False):
        metadata, spec, status = run["metadata"], run.get("spec", {}), run.get("status", {})
        name, uid = metadata["name"], metadata["uid"]
        recovery = spec.get("operation", "tests") == "recover-lock"
        non_destructive = spec.get("testMode", "full") == "non-destructive"
        diagnostic = spec.get("diagnosticSelection")
        ready_key = "regression.magicstick.dev/" + ("recovery-credentials-ready" if recovery else "diagnostic-credentials-ready" if "diagnosticSelection" in spec else "non-destructive-credentials-ready" if non_destructive else "credentials-ready")
        lock = spec.get("lockRecovery", {})
        if (spec.get("operation", "tests") not in {"tests", "recover-lock"}
                or spec.get("testMode", "full") not in ("full", "non-destructive")
                or "diagnosticSelection" in spec and (not isinstance(diagnostic, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", diagnostic)
                    or recovery or non_destructive or spec.get("phases") not in ([2], [3], [4]))
                or non_destructive and (recovery or "accountRunName" in spec or "accountRunUid" in spec)
                or recovery and (spec.get("phases") != [] or not isinstance(lock, dict) or set(lock) not in ({"uid", "resourceVersion", "runId"}, {"uid", "resourceVersion", "runId", "released"})
                    or "released" in lock and lock["released"] is not True
                    or not all(isinstance(lock.get(key), str) for key in ("uid", "resourceVersion", "runId"))
                    or not re.fullmatch(r"[a-f0-9-]{36}", str(lock.get("uid", "")))
                    or not re.fullmatch(r"\d{1,32}", str(lock.get("resourceVersion", "")))
                    or not re.fullmatch(r"reg-[a-f0-9-]{36}", str(lock.get("runId", ""))))
                or not recovery and (not spec.get("phases") or "lockRecovery" in spec)):
            self.status(run, phase="Blocked", message="The regression operation and selection are invalid; no Job was started.")
            return False
        job = self.get(JOBS + "/" + name)
        if job and job.get("metadata", {}).get("labels", {}).get(OWNER) != uid:
            self.status(run, phase="Failed", message="A foreign Job has this name; it was not adopted or deleted.")
            return False
        if status.get("phase") in TERMINAL:
            return False
        if not job and metadata.get("annotations", {}).get(ready_key) != uid:
            try:
                age = (datetime.fromisoformat(self.f["now"]().replace("Z", "+00:00"))
                       - datetime.fromisoformat(metadata["creationTimestamp"].replace("Z", "+00:00"))).total_seconds()
            except (KeyError, ValueError, TypeError):
                age = 0
            if age > 600:
                self.status(run, phase="Cancelled" if spec.get("cancelRequested") else "Failed", finishedAt=self.f["now"](),
                    credentialRecoveryRequired="accountRunName" in spec,
                    message="Automatic credential provisioning did not finish within 10 minutes. No Job was started; owned credential cleanup/recovery is required before retrying.")
                return False
        if spec.get("cancelRequested"):
            if not job and metadata.get("annotations", {}).get(ready_key) != uid:
                self.status(run, phase="Cancelling", message="Waiting for automatic credential provisioning to finish before cancelling.")
                return True
            if job:
                self.f["delete_json"](JOBS + "/" + name, {"apiVersion": "v1", "kind": "DeleteOptions",
                    "propagationPolicy": "Foreground", "preconditions": {"uid": job["metadata"]["uid"]}})
                self.status(run, phase="Cancelling", message="Stopping the runner; bounded teardown is in progress.")
                return True
            pods = self.f["list_items"]("/api/v1/namespaces/" + NS + "/pods?labelSelector=" + OWNER + "%3D" + uid)
            if pods:
                self.status(run, phase="Cancelling", message="Waiting for the exact run-owned Pods to terminate.")
                return True
            try:
                report = self.report(uid) or {}
            except (OSError, ValueError):
                report = {}
            self.status(run, phase="Cancelled", message="Cancelled. The next run rechecks durable recovery journals before any mutations.",
                progress=report.get("progress", status.get("progress", {})),result=report.get("result", status.get("result")),
                credentialRecoveryRequired=not non_destructive and ("accountRunName" in spec or metadata.get("annotations", {}).get("regression.magicstick.dev/credentials-used") == uid),
                reportAvailable=bool(report.get("reportAvailable", status.get("reportAvailable", False))),finishedAt=self.f["now"]())
            return False
        if busy and not job:
            self.status(run, phase="Queued", message="Waiting for the other run and its cleanup.")
            return False
        current = self.f["appliance"]() or {}
        nodes = self.f["list_items"]("/api/v1/nodes")
        if (spec.get("applianceUid") != current.get("metadata", {}).get("uid")
                or sorted(spec.get("nodeUids", [])) != sorted(n["metadata"]["uid"] for n in nodes)):
            self.status(run, phase="Blocked", message="The registered Appliance or Node identities changed; no test was started.")
            return False
        marker = self.get("/api/v1/namespaces/" + NS + "/configmaps/registered-lab") or {}
        if (marker.get("immutable") is not True or marker.get("data", {}).get("kind") != "disposable-regression-lab"
                or marker.get("metadata", {}).get("labels", {}).get("regression.magicstick.dev/appliance-uid") != spec["applianceUid"]
                or marker.get("data", {}).get("nodeUids") != ",".join(sorted(spec["nodeUids"]))):
            self.status(run, phase="Blocked", message="This installation is not registered as a disposable regression lab.")
            return False
        if not job:
            if "diagnosticSelection" in spec:
                runtime = (self.get("/api/v1/namespaces/" + NS + "/configmaps/magicstick-regression-runtime") or {}).get("data", {})
                try:
                    catalog = json.loads((self.get("/api/v1/namespaces/" + NS + "/configmaps/magicstick-regression-diagnostics") or {}).get("data", {})["diagnostics.json"])
                    supported = catalog["version"] == 2 and any(p["id"] == diagnostic and
                        type(p.get("phase")) is int and spec.get("phases") == [p["phase"]] and
                        p["phase"] in (2, 3, 4) and p.get("grep") == "|".join(p["caseIds"]) for p in catalog["profiles"])
                except (KeyError, ValueError, TypeError):
                    supported = False
                if (not supported or runtime.get("diagnosticSelectionVersion") != "2"
                        or runtime.get("image") != spec.get("image") or runtime.get("sourceRevision") != spec.get("sourceRevision")):
                    self.status(run, phase="Blocked", message="The pinned runner does not support this diagnostic selection; no Job was started.")
                    return False
            if metadata.get("annotations", {}).get("regression.magicstick.dev/credentials-used") == uid:
                self.status(run, phase="Failed", credentialRecoveryRequired=not non_destructive, finishedAt=self.f["now"](),
                    message="The run-owned Job disappeared or its creation could not be verified. It was not retried; start a new recovery-capable run.")
                return False
            if metadata.get("annotations", {}).get(ready_key) != uid:
                self.status(run, phase="Preparing", message="Automatically provisioning test credentials.")
                return True
            if not re.fullmatch(r"ghcr.io/qualityminds/magicstick-regression:[a-z0-9-]+@sha256:[a-f0-9]{64}", spec.get("image", "")):
                self.status(run, phase="Blocked", message="A verified digest-pinned runner image is required.")
                return False
            account_name, account_uid = spec.get("accountRunName", name), spec.get("accountRunUid", uid)
            secret = self.get("/api/v1/namespaces/" + NS + "/secrets/" + account_name) or {}
            if secret.get("metadata", {}).get("labels", {}).get(OWNER) != account_uid:
                self.status(run, phase="Failed", message="Run credential ownership could not be verified.")
                return False
            account = json.loads(base64.b64decode(secret["data"]["account.json"]))
            if account.get("runUid") != account_uid:
                raise ValueError("Regression account ownership changed")
            if account.get("testMode", "full") != spec.get("testMode", "full"):
                self.status(run, phase="Failed", credentialRecoveryRequired=not non_destructive,
                    message="The test account mode does not match the immutable run selection. No Job was started.")
                return False
            # Persist use before Job creation, so an API/Pod crash can never
            # delete the account needed by an interrupted setup access receipt.
            self.f["patch_json"](RUNS + "/" + name, {"metadata": {"annotations": {"regression.magicstick.dev/credentials-used": uid}}})
            self.f["request_json"]("POST", JOBS, self.job(run, account))
            self.status(run, phase="Starting", credentialRecoveryRequired=not non_destructive,
                message="Scheduling exact stale-lock recovery; no test suite will start." if recovery else "Scheduling the existing regression suite on this Appliance.", startedAt=self.f["now"]())
            return True
        progress = None
        try:
            progress = self.report(uid)
        except urllib.error.HTTPError as error:
            if error.code not in (404, 503):
                raise
        if progress and progress.get("runUid") != uid:
            raise ValueError("Regression report ownership changed")
        if progress and progress.get("testMode", "full") != spec.get("testMode", "full"):
            raise ValueError("Regression report test mode changed")
        if progress and progress.get("diagnosticSelection") != diagnostic:
            raise ValueError("Regression report diagnostic selection changed")
        complete = any(c.get("status") == "True" and c.get("type") in {"Complete", "Failed"} for c in job.get("status", {}).get("conditions", []))
        if complete:
            outcome = (progress or {}).get("outcome")
            job_failed = any(c.get("status") == "True" and c.get("type") == "Failed" for c in job.get("status", {}).get("conditions", []))
            if job_failed or outcome not in {"Passed", "Failed", "Blocked"}:
                outcome = "Failed"
            export_failed = any(case.get("reason") == "REPORT_EXPORT" and case.get("stage") == "report-export"
                                for case in ((progress or {}).get("result") or {}).get("cases", []))
            message = ("Execution finished, but report export failed. Recorded test results were retained; inspect HAR-10 at report-export."
                       if export_failed else "Regression execution finished." if progress else
                       "Runner failed before publishing its report. Check scheduling, storage and image availability.")
            self.status(run, phase=outcome, message=message,
                progress=(progress or {}).get("progress", {}), result=(progress or {}).get("result"),
                cleanup=(progress or {}).get("cleanup", {"state": "unknown"}),
                credentialRecoveryRequired=False if non_destructive else True if job_failed else
                    (progress or {}).get("credentialRecoveryRequired", status.get("credentialRecoveryRequired", True)) or
                    (progress or {}).get("cleanup", {}).get("state") != "verified",
                reportAvailable=bool((progress or {}).get("reportAvailable")), finishedAt=self.f["now"]())
            return False
        self.status(run, phase="Running" if progress else "Starting", message=(progress or {}).get("message", "Waiting for the runner Pod to start."),
            cleanup=(progress or {}).get("cleanup", {"state": "unknown"}),
            credentialRecoveryRequired=False if non_destructive else (progress or {}).get("credentialRecoveryRequired", status.get("credentialRecoveryRequired", True)),
            progress=(progress or {}).get("progress", {}), result=(progress or {}).get("result"), reportAvailable=bool((progress or {}).get("reportAvailable")))
        return True

    def report(self, uid):
        if not re.fullmatch(r"[a-f0-9-]{36}", uid):
            raise ValueError("Invalid run UID")
        # Fixed, unexposed ClusterIP endpoint, restricted by NetworkPolicy to
        # this operator and the authenticated Dashboard API; no user URL.
        with urllib.request.urlopen("http://regression-reports.magicstick-regression.svc:8080/" + uid + "/status.json", timeout=5) as response:
            data = response.read(512 * 1024 + 1)
        if len(data) > 512 * 1024:
            raise ValueError("Regression progress exceeds its bound")
        return json.loads(data)

    def reconcile_all(self):
        runs = self.f["list_items"](RUNS)
        runs.sort(key=lambda r: r.get("metadata", {}).get("creationTimestamp", ""))
        busy = False
        unsettled = set()
        for run in runs:
            try:
                spec, meta = run.get("spec", {}), run["metadata"]
                owner = (spec.get("accountRunName", meta["name"]), spec.get("accountRunUid", meta["uid"]))
                other_account = bool(unsettled - {owner})
                busy = self.reconcile(run, busy or other_account) or busy
                if not run.get("status", {}).get("credentialsCleaned", False):
                    # Concurrent API replicas can accept separate intents. The
                    # controller still waits for predecessor identity cleanup;
                    # only exact same-account recovery may bypass that wait.
                    unsettled.add(owner)
            except Exception:
                # A transient report/API error cannot revoke credentials from
                # a still-running Job or open the lab to another writer.
                self.status(run, phase="Recovering", message="Regression status is temporarily unavailable; the run remains reserved.")
                busy = True
