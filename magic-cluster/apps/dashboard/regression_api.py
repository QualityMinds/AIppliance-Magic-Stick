"""Administrator-only regression intent and allowlisted report downloads.

Workloads belong to the operator. No user-supplied image, command, URL, Secret
name or Kubernetes manifest crosses this API. Private inputs never leave it.
The runner lifecycle is a core function: never gate it on license status or
activate a license here. Individual suite cases verify their own prerequisites.
"""
import base64
import ipaddress
import json
import re
import secrets
import threading
import urllib.parse
from datetime import datetime, timezone

NAMESPACE = "magicstick-regression"
RUNS = "/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/regressionruns"
CORE = "/api/v1/namespaces/" + NAMESPACE
OWNER = "regression.magicstick.dev/run-uid"
TERMINAL = {"Passed", "Failed", "Blocked", "Cancelled"}
MUTATION_LOCK = threading.RLock()
ARTIFACTS = {"archive": ("report-artifacts.tar.gz", "application/gzip"),
             "html": ("summary.html", "text/html; charset=utf-8"),
             "junit": ("junit.xml", "application/xml")}
LEASE = "/apis/coordination.k8s.io/v1/namespaces/" + NAMESPACE + "/leases/lab-lock"


def credential_owner(run):
    spec, meta = run.get("spec", {}), run["metadata"]
    return spec.get("accountRunName", meta["name"]), spec.get("accountRunUid", meta["uid"])


class RegressionApi:
    def __init__(self, functions):
        self.f = functions

    def error(self, status, message):
        raise self.f["RequestError"](status, message)

    def get(self, path):
        return self.f["get_resource"](path)

    def write(self, method, path, value):
        return self.f["request_json"](method, path, value)

    def target(self):
        appliance = self.f["get_resource"]("/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/appliances/local")
        nodes = self.f["list_resource"]("/api/v1/nodes")
        uid = (appliance or {}).get("metadata", {}).get("uid")
        node_uids = sorted(n.get("metadata", {}).get("uid", "") for n in nodes)
        if not uid or not node_uids or not all(node_uids):
            self.error(503, "The Appliance and Node identities are not available.")
        return uid, node_uids

    def registration(self):
        uid, nodes = self.target()
        marker = self.get(CORE + "/configmaps/registered-lab")
        if not marker:
            return None
        data = marker.get("data", {})
        if (marker.get("immutable") is not True or data.get("kind") != "disposable-regression-lab"
                or data.get("policyVersion") != "1" or data.get("nodeUids") != ",".join(nodes)
                or marker.get("metadata", {}).get("labels", {}).get("regression.magicstick.dev/appliance-uid") != uid):
            self.error(409, "The test registration belongs to a different Appliance or Node installation.")
        # Older CLI registrations have no origin fields. Discovery is still
        # installation-owned; never trust a URL submitted by the browser.
        return {"version": 1, "kind": data["kind"], "policyVersion": 1,
                "id": data["registrationId"], "applianceUid": uid, "nodeUids": nodes,
                "createdAt": data.get("createdAt", marker["metadata"].get("creationTimestamp")),
                **self.endpoints()}

    def endpoints(self):
        settings = self.f["settings_response"]()
        domain = settings.get("mdnsDomain", "")
        if not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?", domain):
            self.error(503, "The configured dashboard hostname is invalid.")
        return {"dashboardUrl": "https://" + domain, "identityUrl": "https://id." + domain}

    def runtime(self):
        config = self.get(CORE + "/configmaps/magicstick-regression-runtime") or {}
        data = config.get("data", {})
        image, revision = data.get("image", ""), data.get("sourceRevision", "")
        available = bool(re.fullmatch(r"ghcr.io/qualityminds/magicstick-regression:[a-z0-9-]+@sha256:[a-f0-9]{64}", image)
                         and re.fullmatch(r"[a-f0-9]{40}", revision))
        if available:
            activation = self.get("/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/moduleactivations/regression") or {}
            if activation.get("spec", {}).get("enabled") is not True:
                available = False
            else:
                deployment = self.get("/apis/apps/v1/namespaces/" + NAMESPACE + "/deployments/regression-reports") or {}
                status, spec = deployment.get("status", {}), deployment.get("spec", {})
                available = bool(status.get("observedGeneration", 0) >= deployment.get("metadata", {}).get("generation", 1)
                                 and status.get("availableReplicas", 0) == spec.get("replicas", 1)
                                 and status.get("updatedReplicas", 0) == spec.get("replicas", 1))
        return available, image, revision

    def view(self, run):
        meta, spec, status = run.get("metadata", {}), run.get("spec", {}), run.get("status", {})
        result = {"id": meta.get("name"), "uid": meta.get("uid"), "createdAt": meta.get("creationTimestamp"),
                  "operation": spec.get("operation", "tests"),
                  "phases": spec.get("phases", list(range(9))), "phase": status.get("phase", "Queued"),
                  "message": status.get("message", "Waiting for the operator."),
                  "sourceRevision": spec.get("sourceRevision", ""), "progress": status.get("progress", {}),
                  "result": status.get("result"), "reportAvailable": status.get("reportAvailable", False),
                  "startedAt": status.get("startedAt"), "finishedAt": status.get("finishedAt"),
                  "credentialsCleaned": status.get("credentialsCleaned", False)}
        return result

    def recovery_candidate(self, runs):
        pending = [r for r in runs if not r.get("status", {}).get("credentialsCleaned", False)]
        if not pending or any(r.get("status", {}).get("phase") not in TERMINAL for r in pending):
            return None
        latest = self.latest_family(pending)
        # A failed setup needs the very same generated identity to restore its
        # durable access receipt. Never substitute the human's credentials or
        # a new user, and never delete the original account while recovery waits.
        if len({credential_owner(r) for r in pending}) != 1 or latest.get("status", {}).get("credentialRecoveryRequired") is not True:
            return None
        return latest

    def latest_family(self, runs):
        if not runs:
            return None
        name, uid = credential_owner(runs[0])
        original = next((r for r in runs if r["metadata"]["name"] == name and r["metadata"]["uid"] == uid), {})
        consumer = original.get("metadata", {}).get("annotations", {}).get("regression.magicstick.dev/credential-consumer")
        matches = [r for r in runs if r["metadata"]["uid"] == consumer]
        return matches[0] if len(matches) == 1 else max(runs, key=lambda r: (r.get("metadata", {}).get("creationTimestamp", ""), "accountRunName" in r.get("spec", {}), r["metadata"]["name"]))

    def list(self):
        registration = self.registration()
        available, _, revision = self.runtime()
        runs = self.f["list_resource"](RUNS)
        runs = sorted(runs, key=lambda r: r.get("metadata", {}).get("creationTimestamp", ""), reverse=True)
        lock = self.lock_status(runs, registration)
        return {"registered": registration is not None, "applianceUid": self.target()[0],
                "runtimeAvailable": available, "sourceRevision": revision,
                "message": "" if available else "Enable the regression runner and wait for a CI-published, digest-pinned image.",
                "runs": [self.view(r) for r in runs[:30]],
                "recoveryAvailable": self.recovery_candidate(runs) is not None,
                "lock": lock, "cleanup": self.cleanup_status(runs, registration, lock),
                "executionLocation": "appliance-kubernetes", "externalRunnerRequired": ["reboot", "power-off", "network-loss"]}

    def cleanup_status(self, runs, registration, lock):
        """A released Lease is not proof that retained setup access was restored."""
        if any(r.get("status", {}).get("phase") not in TERMINAL for r in runs):
            return {"available": False, "message": "A test or cleanup run is active. Wait for it to finish."}
        if lock["state"] != "free":
            return {**lock, "available": lock["canRecover"]}
        candidate = self.recovery_candidate(runs)
        if not candidate:
            pending = any(not r.get("status", {}).get("credentialsCleaned", False) for r in runs)
            return {"available": False, "message": "The previous account cleanup or its ownership verification is still pending." if pending
                    else "No previous test run needs cleanup. New tests will verify the starting state."}
        lease = self.get(LEASE) or {}
        if lease.get("spec", {}).get("holderIdentity"):
            return {"available": False, "message": "The test reservation changed while checking cleanup. Refresh before trying again."}
        meta = lease.get("metadata", {})
        owner = meta.get("annotations", {}).get("regression.magicstick.dev/run-id")
        family = [r for r in runs if credential_owner(r) == credential_owner(candidate)]
        if (not registration or candidate.get("spec", {}).get("applianceUid") != registration["applianceUid"]
                or sorted(candidate.get("spec", {}).get("nodeUids", [])) != registration["nodeUids"]
                or meta.get("labels", {}).get("regression.magicstick.dev/appliance-uid") != registration["applianceUid"]
                or not re.fullmatch(r"[a-f0-9-]{36}", str(meta.get("uid", "")))
                or not re.fullmatch(r"\d{1,32}", str(meta.get("resourceVersion", "")))
                or not re.fullmatch(r"reg-[a-f0-9-]{36}", str(owner or ""))
                or not any(owner in r.get("status", {}).get("progress", {}).get("ownedRunIds", []) for r in family)):
            return {"available": False, "message": "Retained setup access needs cleanup, but its exact journal and released lock could not be linked to this run. Inspect the private recovery receipt."}
        try:
            for previous in family:
                self.pods_terminated(previous)
        except self.f["RequestError"]:
            return {"available": False, "message": "The previous run still has active Pods. Wait for their termination before cleanup."}
        return {"available": True, "revision": meta["uid"] + ":" + meta["resourceVersion"],
                "runId": owner, "released": True,
                "message": "The test lock is free, but retained setup access still needs cleanup. Clean up the previous run without starting tests."}

    def lock_status(self, runs, registration, lease=None):
        lease = self.get(LEASE) if lease is None else lease
        if not lease or not lease.get("spec", {}).get("holderIdentity"):
            return {"state": "free", "canRecover": False, "message": "No regression lock is held."}
        meta, spec = lease.get("metadata", {}), lease.get("spec", {})
        blocked = {"state": "blocked", "canRecover": False}
        if (not registration or meta.get("labels", {}).get("regression.magicstick.dev/appliance-uid") != registration["applianceUid"]
                or not re.fullmatch(r"[a-f0-9-]{36}", str(meta.get("uid", "")))
                or not re.fullmatch(r"\d{1,32}", str(meta.get("resourceVersion", "")))):
            return {**blocked, "message": "Lock identity or test registration could not be verified; recovery was refused."}
        revision = meta["uid"] + ":" + meta["resourceVersion"]
        if meta.get("annotations", {}).get("regression.magicstick.dev/host-maintenance") == "true":
            return {**blocked, "revision": revision,
                    "message": "Host software convergence reserves this test lab through Flux readiness. Wait for the update; if it failed, inspect ansible-pull.service before recovering host maintenance. Test cleanup cannot clear this reservation."}
        try:
            renewed = datetime.fromisoformat(spec["renewTime"].replace("Z", "+00:00"))
            duration = spec["leaseDurationSeconds"]
            if renewed.tzinfo is None or type(duration) is not int or not 1 <= duration <= 86400:
                raise ValueError("Invalid lease time")
            expires = renewed.timestamp() + duration + 60
        except (KeyError, ValueError, TypeError, OverflowError):
            return {**blocked, "revision": revision, "message": "Lock expiry is unknown; it was not cleared."}
        if expires > datetime.now(timezone.utc).timestamp():
            return {"state": "active", "canRecover": False, "revision": revision,
                    "message": "The lock is still active or its recovery drain has not finished. Wait or cancel its active run."}
        annotations = meta.get("annotations", {})
        owner = annotations.get("regression.magicstick.dev/run-id", spec["holderIdentity"])
        job_uid = annotations.get("regression.magicstick.dev/kubernetes-run-uid")
        known = [r for r in runs if job_uid and r.get("metadata", {}).get("uid") == job_uid
                 or owner in r.get("status", {}).get("progress", {}).get("ownedRunIds", [])]
        if not re.fullmatch(r"reg-[a-f0-9-]{36}", str(owner)) or not known:
            return {"state": "stale", "canRecover": False, "revision": revision,
                    "message": "This stale lock belongs to an external runner. Recover it from that runner's exact private journal; the Dashboard cannot access that journal."}
        if any(r.get("status", {}).get("phase") not in TERMINAL for r in runs):
            return {**blocked, "revision": revision, "message": "A regression run is still active; cancel it and wait for its Pods to terminate before recovery."}
        if any(not r.get("status", {}).get("credentialsCleaned", False) for r in runs) and not self.recovery_candidate(runs):
            return {**blocked, "revision": revision, "message": "The previous test account is still being cleaned up or its exact recovery identity is unavailable. Wait for account cleanup before recovery."}
        for run in known:
            if (run.get("spec", {}).get("applianceUid") != registration["applianceUid"]
                    or sorted(run.get("spec", {}).get("nodeUids", [])) != registration["nodeUids"]):
                return {**blocked, "revision": revision, "message": "The old run belongs to a different installation; recovery was refused."}
            try:
                self.pods_terminated(run)
            except self.f["RequestError"]:
                return {**blocked, "revision": revision, "message": "The old run still has active Pods. Recovery will not steal their lock."}
        return {"state": "stale", "canRecover": True, "revision": revision,
                "runId": owner, "message": "The old run has terminated. Recover its exact private journal and verify cleanup before releasing this lock; no test suite will start."}

    def register(self, principal, payload):
        self.f["live_admin_actor"](principal)
        if set(payload) != {"confirmation", "acknowledgeDisruption"} or payload.get("confirmation") != "DISPOSABLE TEST SERVER" or payload.get("acknowledgeDisruption") is not True:
            self.error(400, "Confirm DISPOSABLE TEST SERVER before enabling destructive regression tests.")
        with MUTATION_LOCK:
            if self.registration():
                return self.list()
            uid, nodes = self.target()
            self.write("POST", CORE + "/configmaps", {"apiVersion": "v1", "kind": "ConfigMap",
                "metadata": {"name": "registered-lab", "namespace": NAMESPACE,
                    "labels": {"regression.magicstick.dev/appliance-uid": uid}}, "immutable": True,
                "data": {"registrationId": secrets.token_hex(16)[:8] + "-" + secrets.token_hex(2) + "-" + secrets.token_hex(2) + "-" + secrets.token_hex(2) + "-" + secrets.token_hex(6),
                    "policyVersion": "1", "kind": "disposable-regression-lab", "nodeUids": ",".join(nodes),
                    "createdAt": datetime.now(timezone.utc).isoformat()}})
        return self.list()

    def run(self, name):
        if not re.fullmatch(r"regression-[a-f0-9]{32}", name):
            self.error(400, "Invalid regression run ID.")
        run = self.get(RUNS + "/" + name)
        if not run:
            self.error(404, "Regression run not found.")
        return run

    def start(self, principal, payload):
        self.f["live_admin_actor"](principal)
        if (not {"requestId", "acknowledgeDisruption"} <= set(payload) <= {"requestId", "acknowledgeDisruption", "phases"}
                or payload.get("acknowledgeDisruption") is not True
                or not re.fullmatch(r"[a-f0-9]{32}", str(payload.get("requestId", "")))):
            self.error(400, "A unique request and disruption confirmation are required.")
        phases = payload.get("phases", list(range(9)))
        if (not isinstance(phases, list) or not 1 <= len(phases) <= 9
                or any(type(phase) is not int or not 0 <= phase <= 8 for phase in phases)
                or len(set(phases)) != len(phases)):
            self.error(400, "Select one or more distinct test phases from 0 to 8.")
        return self.enqueue(principal, {**payload, "phases": sorted(phases)}, "tests")

    def recover_lock(self, principal, payload):
        self.f["live_admin_actor"](principal)
        if (set(payload) != {"requestId", "expectedLockRevision", "acknowledgeCleanup"}
                or payload.get("acknowledgeCleanup") is not True
                or not re.fullmatch(r"[a-f0-9]{32}", str(payload.get("requestId", "")))
                or not re.fullmatch(r"[a-f0-9-]{36}:\d{1,32}", str(payload.get("expectedLockRevision", "")))):
            self.error(400, "Confirm cleanup of the reviewed stale lock with a unique request and its exact revision.")
        return self.enqueue(principal, payload, "recover-lock")

    def enqueue(self, principal, payload, operation):
        registration = self.registration()
        available, image, revision = self.runtime()
        if not registration or not available:
            self.error(409, "Register this dedicated test Appliance and enable a published runner first.")
        name = "regression-" + payload["requestId"]
        with MUTATION_LOCK:
            existing = self.get(RUNS + "/" + name)
            if existing:
                if (existing.get("spec", {}).get("requestedBy") != principal.get("subject")
                        or existing.get("spec", {}).get("operation", "tests") != operation
                        or operation == "recover-lock" and existing["spec"]["lockRecovery"]["uid"] + ":" + existing["spec"]["lockRecovery"]["resourceVersion"] != payload["expectedLockRevision"]):
                    self.error(409, "This request ID is already owned by another administrator.")
                if operation == "tests" and existing.get("spec", {}).get("phases") != payload["phases"]:
                    self.error(409, "This request ID already selects different phases. Use a new request ID for a new run.")
                return self.view(existing)
            runs = self.f["list_resource"](RUNS)
            recovery = self.recovery_candidate(runs)
            if any(r.get("status", {}).get("phase") not in TERMINAL or not r.get("status", {}).get("credentialsCleaned", False) for r in runs) and not recovery:
                self.error(409, "Another regression run is still queued, running or cleaning up.")
            recovery_spec = {}
            if operation == "recover-lock":
                lock = self.cleanup_status(runs, registration, self.lock_status(runs, registration))
                if not lock["available"] or lock.get("revision") != payload["expectedLockRevision"]:
                    self.error(409, lock["message"] if not lock["available"] else "The lock changed after review. Refresh before requesting recovery.")
                lock_uid, version = lock["revision"].split(":")
                recovery_spec = {"operation": operation, "lockRecovery": {
                    "uid": lock_uid, "resourceVersion": version, "runId": lock["runId"],
                    **({"released": True} if lock.get("released") else {})}}
            if recovery:
                if recovery.get("spec", {}).get("applianceUid") != registration["applianceUid"] or sorted(recovery.get("spec", {}).get("nodeUids", [])) != registration["nodeUids"]:
                    self.error(409, "Retained setup credentials belong to a different installation.")
                for previous in runs:
                    if credential_owner(previous) == credential_owner(recovery):
                        self.pods_terminated(previous)
                name_ref, uid_ref = credential_owner(recovery)
                recovery_spec.update(accountRunName=name_ref, accountRunUid=uid_ref)
            lease = self.get(LEASE)
            if operation == "recover-lock" and (not lease or lease.get("metadata", {}).get("uid") != recovery_spec["lockRecovery"]["uid"]
                    or lease.get("metadata", {}).get("resourceVersion") != recovery_spec["lockRecovery"]["resourceVersion"]):
                self.error(409, "The lock changed while preparing recovery. Refresh before trying again.")
            if lease and lease.get("spec", {}).get("holderIdentity"):
                spec = lease.get("spec", {})
                owner = lease.get("metadata", {}).get("annotations", {}).get("regression.magicstick.dev/run-id", spec["holderIdentity"])
                try:
                    expires = datetime.fromisoformat(spec["renewTime"].replace("Z", "+00:00")).timestamp() + int(spec["leaseDurationSeconds"]) + 60
                except (KeyError, ValueError, TypeError):
                    expires = float("inf")
                job_uid = lease.get("metadata", {}).get("annotations", {}).get("regression.magicstick.dev/kubernetes-run-uid")
                known = any(r.get("metadata", {}).get("uid") == job_uid or owner in r.get("status", {}).get("progress", {}).get("ownedRunIds", []) for r in runs)
                if not known or expires > datetime.now(timezone.utc).timestamp():
                    self.error(409, "The lab is owned by an external or interrupted run, or its recovery drain is still active. Its exact private journal is required; the Lease was not cleared.")
                # Starting a recovery-capable Job is not stealing the Lease.
                # Existing setup verifies PVC journal/session/UID evidence and
                # acquires the exact expired holder through its normal CAS path.
            run = self.write("POST", RUNS, {"apiVersion": "appliance.magicstick.dev/v1alpha1", "kind": "RegressionRun",
                "metadata": {"name": name, "namespace": "ai-system"},
                "spec": {"applianceUid": registration["applianceUid"], "nodeUids": registration["nodeUids"],
                    "phases": [] if operation == "recover-lock" else payload["phases"], "requestedBy": principal["subject"], "image": image,
                    "sourceRevision": revision, "cancelRequested": False, **recovery_spec}})
            try:
                if recovery:
                    original_name = credential_owner(recovery)[0]
                    self.f["patch_json"](RUNS + "/" + original_name, {"metadata": {"annotations": {
                        "regression.magicstick.dev/credential-consumer": run["metadata"]["uid"]}}})
                self.provision(run, registration)
                # Old operators must not interpret recovery intent as a test
                # suite during a rolling upgrade: only the new reconciler
                # understands this distinct readiness key/entrypoint.
                ready = "recovery-credentials-ready" if operation == "recover-lock" else "credentials-ready"
                self.f["patch_json"](RUNS + "/" + name, {"metadata": {"annotations": {"regression.magicstick.dev/" + ready: run["metadata"]["uid"]}}})
            except Exception:
                self.f["patch_json"](RUNS + "/" + name + "/status", {"status": {"phase": "Failed", "message": "Automatic test-account provisioning failed; no tests were started."}})
                self.cleanup(run)
                self.error(503, "Automatic regression setup failed. Inspect the run status before retrying.")
        return self.view(self.run(name))

    def provision(self, run, registration):
        name, uid = run["metadata"]["name"], run["metadata"]["uid"]
        if "accountRunName" in run.get("spec", {}):
            _, account = self.owned_account(run)
            if not account:
                self.error(409, "The retained setup credentials are missing; automatic recovery cannot restore the private receipt.")
            if account.get("registration") != registration or not account.get("caPem") or not account.get("gatewayIp"):
                self.error(409, "The retained setup account does not match this registered lab.")
            self.owned_user(account, credential_owner(run)[1], required=True)
            return
        username, password = "regression-" + uid.replace("-", ""), secrets.token_urlsafe(36)
        # Persist the intended identity before contacting Keycloak. Cleanup can
        # resolve a lost create response, without adopting a same-name user.
        account = {"username": username, "password": password, "runUid": uid,
                   "registration": registration, "completionToken": secrets.token_urlsafe(32)}
        self.write("POST", CORE + "/secrets", {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": name, "namespace": NAMESPACE, "labels": {OWNER: uid}},
            "stringData": {"account.json": json.dumps(account)}})
        _, headers = self.f["keycloak_admin_request"]("POST", self.f["_realm_path"]("/users"), {
            "username": username, "enabled": True, "firstName": "Regression", "lastName": "Runner",
            "email": username + "@example.invalid", "emailVerified": True,
            "requiredActions": [], "attributes": {"magicstickRegressionRun": [uid]},
            "credentials": [{"type": "password", "value": password, "temporary": False}]})
        user_id = str(headers.get("Location", "")).rstrip("/").split("/")[-1]
        if not user_id:
            # Keycloak normally returns Location for a created user.  Treat a
            # missing header as a recoverable lost-create response instead of
            # leaving a generated identity without its durable receipt.  The
            # exact generated username binds the lookup to this run.  Keycloak
            # installations can reject arbitrary profile attributes, so the
            # durable binding is the UUID-derived username persisted in the
            # run-owned Secret before the create request.  The resolved ID is
            # stored immediately and all later cleanup requires that exact ID.
            matches = self.f["_exact_user_matches"]("username", username)
            if len(matches) != 1:
                self.error(503, "Test identity could not be resolved.")
            candidate = matches[0]
            if candidate.get("username") != username:
                self.error(409, "The generated test identity could not be verified.")
            user_id = str(candidate.get("id") or "")
            if not user_id:
                self.error(503, "Test identity could not be resolved.")
        account["userId"] = user_id
        self.f["patch_json"](CORE + "/secrets/" + name, {"stringData": {"account.json": json.dumps(account)}})
        self.f["_replace_managed_roles"](user_id, self.f["ACCESS_LEVEL_ROLES"]["admin"])
        # The existing setup temporarily grants and independently restores
        # Kubernetes access; ordinary tests never retain an admin kubeconfig.
        access = self.f["kubernetes_access_info"](required=True)
        account["caPem"] = access["oidcCa"]
        # Advertised mDNS hosts need a current Gateway address inside the pod.
        routes = self.f["list_resource"]("/apis/gateway.networking.k8s.io/v1/httproutes")
        parents = {(p.get("namespace", r.get("metadata", {}).get("namespace", "identity-system")), p["name"])
            for r in routes if registration["dashboardUrl"].split("//")[1] in r.get("spec", {}).get("hostnames", [])
            for p in r.get("spec", {}).get("parentRefs", []) if p.get("name") and p.get("kind", "Gateway") == "Gateway"}
        if len(parents) != 1:
            self.error(503, "The dashboard Gateway is not unambiguous.")
        namespace, gateway_name = next(iter(parents))
        gateway = self.get("/apis/gateway.networking.k8s.io/v1/namespaces/" + namespace + "/gateways/" + gateway_name)
        addresses = [a["value"] for a in (gateway or {}).get("status", {}).get("addresses", []) if a.get("type", "IPAddress") == "IPAddress"]
        if len(addresses) != 1:
            self.error(503, "The dashboard Gateway has no unique address.")
        address = ipaddress.ip_address(addresses[0])
        if address.is_loopback or address.is_unspecified or address.is_multicast or address.is_link_local:
            self.error(503, "The advertised Gateway address is not routable from a test Pod.")
        account["gatewayIp"] = str(address)
        self.f["patch_json"](CORE + "/secrets/" + name, {"stringData": {"account.json": json.dumps(account)}})

    def cancel(self, principal, name, payload):
        self.f["live_admin_actor"](principal)
        if payload != {"acknowledgeDisruption": True}:
            self.error(400, "Cancellation must acknowledge test cleanup.")
        run = self.run(name)
        if run.get("status", {}).get("phase") not in TERMINAL:
            self.f["patch_json"](RUNS + "/" + name, {"spec": {"cancelRequested": True}})
        return self.view(self.run(name))

    def artifact(self, name, kind):
        run = self.run(name)
        if kind not in ARTIFACTS or not run.get("status", {}).get("reportAvailable"):
            self.error(409, "The sanitized report is not available yet.")
        filename, content_type = ARTIFACTS[kind]
        uid = run["metadata"]["uid"]
        data = self.f["regression_report_bytes"](uid, filename)
        return data, "magicstick-" + name + "-" + filename, content_type

    def pods_terminated(self, run):
        name, uid = run["metadata"]["name"], run["metadata"]["uid"]
        pods = self.f["list_resource"](CORE + "/pods?labelSelector=" + OWNER + "%3D" + uid)
        if any(p.get("metadata", {}).get("labels", {}).get(OWNER) == uid and p.get("status", {}).get("phase") in {"Pending", "Running", "Unknown"} for p in pods):
            self.error(409, "The run-owned Pod has not terminated; test credentials remain protected.")

    def owned_account(self, run):
        name, uid = credential_owner(run)
        if not re.fullmatch(r"regression-[a-f0-9]{32}", name) or not re.fullmatch(r"[a-f0-9-]{36}", uid):
            self.error(409, "The retained credential reference is invalid.")
        secret = self.get(CORE + "/secrets/" + name)
        if secret and secret.get("metadata", {}).get("labels", {}).get(OWNER) != uid:
            self.error(409, "Test credential ownership changed; cleanup was refused.")
        account = json.loads(base64.b64decode(secret["data"]["account.json"])) if secret else None
        if account and (account.get("runUid") != uid or account.get("username") != "regression-" + uid.replace("-", "")):
            self.error(409, "The retained setup identity does not match its original run.")
        return secret, account

    def owned_user(self, account, uid, required=False):
        users = self.f["_exact_user_matches"]("username", account["username"])
        if len(users) > 1 or (required and not users):
            self.error(409, "The test identity is missing or ambiguous; automatic recovery was refused.")
        user = users[0] if users else None
        # A create response can be lost after Keycloak has created the bound
        # identity but before its ID is persisted.  Keycloak may discard
        # arbitrary profile attributes, therefore the UUID-derived username
        # in the pre-existing run-owned Secret is the recovery binding. Treat
        # only a missing or empty recorded ID as recoverable. A different
        # non-empty ID remains a hard ownership failure.
        recorded_id = account.get("userId")
        if user and (user.get("username") != account["username"]
                     or (recorded_id and recorded_id != user["id"])):
            self.error(409, "The test identity was replaced; cleanup was refused.")
        return user

    def cleanup(self, run):
        name, uid = credential_owner(run)
        family = [r for r in self.f["list_resource"](RUNS) if credential_owner(r) == (name, uid)]
        for member in family:
            self.pods_terminated(member)
            if member["metadata"]["uid"] != run["metadata"]["uid"] and member.get("status", {}).get("phase") not in TERMINAL:
                self.error(409, "A recovery run still uses the retained setup account.")
        used = any(r.get("metadata", {}).get("annotations", {}).get("regression.magicstick.dev/credentials-used") == r["metadata"]["uid"] for r in family)
        if used and run.get("status", {}).get("credentialRecoveryRequired") is not False:
            self.f["patch_json"](RUNS + "/" + run["metadata"]["name"] + "/status", {"status": {
                "credentialRecoveryRequired": True, "message": "Setup recovery is required. Start the next run to restore the retained access receipt with the same generated test identity."}})
            self.error(409, "Setup recovery has not been verified; the generated identity and private receipts were retained.")
        secret, account = self.owned_account(run)
        if not secret:
            users = self.f["_exact_user_matches"]("username", "regression-" + uid.replace("-", ""))
            if users:
                self.error(409, "Test account credentials are missing; automatic cleanup cannot prove ownership.")
            for member in family:
                self.f["patch_json"](RUNS + "/" + member["metadata"]["name"] + "/status", {"status": {"credentialsCleaned": True}})
            return
        user = self.owned_user(account, uid)
        if user:
            self.f["keycloak_admin_request"]("DELETE", self.f["_user_path"](user["id"]))
        self.write("DELETE", CORE + "/secrets/" + name, {"apiVersion": "v1", "kind": "DeleteOptions",
            "preconditions": {"uid": secret["metadata"]["uid"], "resourceVersion": secret["metadata"]["resourceVersion"]}})
        for member in family:
            self.f["patch_json"](RUNS + "/" + member["metadata"]["name"] + "/status", {"status": {"credentialsCleaned": True, "credentialRecoveryRequired": False}})

    def cleanup_finished(self):
        with MUTATION_LOCK:
            runs = self.f["list_resource"](RUNS)
            for owner in {credential_owner(run) for run in runs}:
                run = self.latest_family([r for r in runs if credential_owner(r) == owner])
                if run.get("status", {}).get("phase") in TERMINAL and not run.get("status", {}).get("credentialsCleaned"):
                    try:
                        self.cleanup(run)
                    except Exception:
                        current = self.run(run["metadata"]["name"])
                        if current.get("status", {}).get("credentialRecoveryRequired") is not True:
                            self.f["patch_json"](RUNS + "/" + run["metadata"]["name"] + "/status", {"status": {
                                "message": "The test account could not yet be cleaned up. Waiting for Pod termination, identity ownership or API recovery."}})
