"""Administrator-only regression intent and allowlisted report downloads.

Workloads belong to the operator. No user-supplied image, command, URL, Secret
name or Kubernetes manifest crosses this API. Private inputs never leave it.
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
        return {"registered": registration is not None, "applianceUid": self.target()[0],
                "runtimeAvailable": available, "sourceRevision": revision,
                "message": "" if available else "Enable the regression runner and wait for a CI-published, digest-pinned image.",
                "runs": [self.view(r) for r in runs[:30]],
                "recoveryAvailable": self.recovery_candidate(runs) is not None,
                "executionLocation": "appliance-kubernetes", "externalRunnerRequired": ["reboot", "power-off", "network-loss"]}

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
        if set(payload) != {"requestId", "acknowledgeDisruption"} or payload.get("acknowledgeDisruption") is not True or not re.fullmatch(r"[a-f0-9]{32}", str(payload.get("requestId", ""))):
            self.error(400, "A unique request and disruption confirmation are required.")
        registration = self.registration()
        available, image, revision = self.runtime()
        if not registration or not available:
            self.error(409, "Register this dedicated test Appliance and enable a published runner first.")
        name = "regression-" + payload["requestId"]
        with MUTATION_LOCK:
            existing = self.get(RUNS + "/" + name)
            if existing:
                if existing.get("spec", {}).get("requestedBy") != principal.get("subject"):
                    self.error(409, "This request ID is already owned by another administrator.")
                return self.view(existing)
            runs = self.f["list_resource"](RUNS)
            recovery = self.recovery_candidate(runs)
            if any(r.get("status", {}).get("phase") not in TERMINAL or not r.get("status", {}).get("credentialsCleaned", False) for r in runs) and not recovery:
                self.error(409, "Another regression run is still queued, running or cleaning up.")
            recovery_spec = {}
            if recovery:
                if recovery.get("spec", {}).get("applianceUid") != registration["applianceUid"] or sorted(recovery.get("spec", {}).get("nodeUids", [])) != registration["nodeUids"]:
                    self.error(409, "Retained setup credentials belong to a different installation.")
                for previous in runs:
                    if credential_owner(previous) == credential_owner(recovery):
                        self.pods_terminated(previous)
                name_ref, uid_ref = credential_owner(recovery)
                recovery_spec = {"accountRunName": name_ref, "accountRunUid": uid_ref}
            lease = self.get("/apis/coordination.k8s.io/v1/namespaces/" + NAMESPACE + "/leases/lab-lock")
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
                    "phases": list(range(9)), "requestedBy": principal["subject"], "image": image,
                    "sourceRevision": revision, "cancelRequested": False, **recovery_spec}})
            try:
                if recovery:
                    original_name = credential_owner(recovery)[0]
                    self.f["patch_json"](RUNS + "/" + original_name, {"metadata": {"annotations": {
                        "regression.magicstick.dev/credential-consumer": run["metadata"]["uid"]}}})
                self.provision(run, registration)
                self.f["patch_json"](RUNS + "/" + name, {"metadata": {"annotations": {"regression.magicstick.dev/credentials-ready": run["metadata"]["uid"]}}})
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
        if user and (user.get("attributes", {}).get("magicstickRegressionRun") != [uid] or account.get("userId", user["id"]) != user["id"]):
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
