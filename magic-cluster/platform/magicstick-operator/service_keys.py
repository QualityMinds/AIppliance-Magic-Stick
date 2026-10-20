# SPDX-License-Identifier: BUSL-1.1
"""Durable, owner-scoped LiteLLM service credentials. Never log key material."""
import base64
import copy
import hashlib
import json
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

PREFIX = "appliance.magicstick.dev/litellm-"
SOURCE = "magicstick-service-key"
KEY_FIELD = "LITELLM_API_KEY"
ROTATION_GRACE_SECONDS = 900


class KeyError(RuntimeError):
    pass


class ServiceKeys:
    def __init__(self, k8s_request, master_key, base_url="http://litellm.ai.svc.cluster.local:4000", clock=time.time):
        self.k8s_request = k8s_request
        self.master_key = master_key
        self.base_url = base_url.rstrip("/")
        self.clock = clock

    def api(self, method, path, body=None, missing_ok=False):
        try:
            request = urllib.request.Request(self.base_url + path,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"Authorization": "Bearer " + self.master_key(), "Content-Type": "application/json"},
                method=method)
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if missing_ok and error.code == 404:
                return None
            raise KeyError(f"LiteLLM service-key management unavailable (HTTP {error.code}); retry pending") from None
        except Exception:
            raise KeyError("LiteLLM service-key management unavailable; retry pending") from None

    def k8s(self, method, path, body=None, missing_ok=False):
        try:
            return self.k8s_request(method, path, body)
        except urllib.error.HTTPError as error:
            if missing_ok and error.code == 404:
                return None
            raise KeyError(f"Service-key Secret operation unavailable (HTTP {error.code}); retry pending") from None
        except Exception:
            raise KeyError("Service-key Secret operation unavailable; retry pending") from None

    @staticmethod
    def owner(owner):
        metadata = owner.get("metadata") or {}
        if not metadata.get("uid"):
            raise KeyError("Service-key owner has no Kubernetes UID")
        return {"magicstick_source": SOURCE, "magicstick_owner_uid": metadata["uid"],
                "magicstick_owner_name": metadata["name"],
                "magicstick_owner_namespace": metadata.get("namespace") or "ai-system",
                "magicstick_owner_kind": owner["kind"]}

    @staticmethod
    def check_secret(secret, identity):
        labels = (secret.get("metadata") or {}).get("labels") or {}
        if labels.get(PREFIX + "owner-uid") != identity["magicstick_owner_uid"] or labels.get(PREFIX + "managed") != "true":
            raise KeyError("Refusing to modify a foreign service-key Secret")

    @staticmethod
    def decode(secret, field):
        try:
            encoded = (secret.get("data") or {}).get(field)
            if not encoded:
                return ""
            key = base64.b64decode(encoded, validate=True).decode()
            if not key.startswith("sk-") or len(key) < 32:
                raise ValueError()
            return key
        except Exception:
            raise KeyError("Managed service-key Secret is invalid; repair pending") from None

    @staticmethod
    def key_id(key):
        return hashlib.sha256(key.encode()).hexdigest()

    def save(self, secret):
        metadata = secret["metadata"]
        path = f"/api/v1/namespaces/{metadata['namespace']}/secrets"
        if metadata.get("resourceVersion"):
            return self.k8s("PUT", path + "/" + metadata["name"], secret)
        return self.k8s("POST", path, secret)

    def owned_keys(self, identity):
        records = []
        for page in range(1, 101):
            payload = self.api("GET", f"/key/list?return_full_object=true&size=100&page={page}")
            if not isinstance(payload, dict) or type(payload.get("total_pages")) is not int or payload["total_pages"] < 0:
                raise KeyError("LiteLLM service-key inventory has invalid pagination")
            rows = payload.get("keys")
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise KeyError("LiteLLM service-key inventory is invalid")
            for row in rows:
                if all((row.get("metadata") or {}).get(key) == value for key, value in identity.items()):
                    token = row.get("token")
                    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
                        raise KeyError("LiteLLM service-key inventory has an invalid identifier")
                    records.append(row)
            if page >= payload["total_pages"]:
                return records
        raise KeyError("LiteLLM service-key inventory is incomplete; cleanup deferred")

    def info(self, token, identity):
        response = self.api("GET", "/key/info?" + urllib.parse.urlencode({"key": token}), missing_ok=True)
        if response is None:
            return None
        info = response.get("info")
        if not isinstance(info, dict) or not all((info.get("metadata") or {}).get(k) == v for k, v in identity.items()):
            raise KeyError("Refusing to modify a foreign LiteLLM service key")
        return info

    def block(self, key_id, identity, blocked):
        info = self.info(key_id, identity)
        if info is not None and bool(info.get("blocked")) != blocked:
            self.api("POST", "/key/update", {"key": key_id, "blocked": blocked})

    def ensure(self, owner, namespace, name, enabled=True):
        identity = self.owner(owner)
        requested = str((owner.get("metadata", {}).get("annotations") or {}).get(PREFIX + "key-revision", "initial"))
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", requested):
            raise KeyError("LiteLLM key revision must be a non-secret identifier of at most 64 characters")
        path = f"/api/v1/namespaces/{namespace}/secrets/{name}"
        secret = self.k8s("GET", path, missing_ok=True)
        if not secret and not enabled:
            for record in self.owned_keys(identity):
                self.block(record["token"], identity, True)
            return {"name": name, "key": KEY_FIELD, "revision": ""}
        if secret:
            self.check_secret(secret, identity)
            secret = copy.deepcopy(secret)
        else:
            # Revoke lost credentials before replacing a deleted Secret. Matching
            # an immutable owner UID never targets another instance with its name.
            for record in self.owned_keys(identity):
                self.remove_record_secret(record, identity)
                self.api("POST", "/key/delete", {"keys": [record["token"]]})
            secret = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": {
                "name": name, "namespace": namespace, "labels": {
                    PREFIX + "managed": "true", PREFIX + "owner-uid": identity["magicstick_owner_uid"],
                    "app.kubernetes.io/managed-by": "magicstick-operator"}, "annotations": {}}, "data": {}}
        annotations = secret["metadata"].setdefault("annotations", {})
        try:
            retiring = json.loads(annotations.get(PREFIX + "retiring", "[]"))
            if not isinstance(retiring, list) or any(not isinstance(r, dict) or
                    not re.fullmatch(r"[a-f0-9]{64}", str(r.get("id"))) or
                    type(r.get("until")) not in (int, float) for r in retiring):
                raise ValueError()
        except Exception:
            raise KeyError("Invalid retiring service-key metadata") from None
        keep = []
        for retired in retiring:
            if self.clock() >= retired["until"]:
                if self.info(retired["id"], identity):
                    self.api("POST", "/key/delete", {"keys": [retired["id"]]})
            else:
                keep.append(retired)
        if keep != retiring:
            annotations[PREFIX + "retiring"] = json.dumps(keep)
            secret = self.save(secret)
            annotations = secret["metadata"].setdefault("annotations", {})
        active = self.decode(secret, KEY_FIELD)
        pending = self.decode(secret, "PENDING_API_KEY")
        if not enabled:
            for key_id in [self.key_id(k) for k in [active, pending] if k] + [r["id"] for r in keep]:
                self.block(key_id, identity, True)
            return {"name": name, "key": KEY_FIELD, "revision": annotations.get(PREFIX + "revision", "")}
        if not pending and (not active or (annotations.get(PREFIX + "requested") != requested and not keep)):
            candidate = "sk-" + secrets.token_urlsafe(32)
            secret["data"]["PENDING_API_KEY"] = base64.b64encode(candidate.encode()).decode()
            annotations[PREFIX + "pending-requested"] = requested
            secret = self.save(secret)  # Persist intent before making an API key.
            annotations = secret["metadata"].setdefault("annotations", {})
            pending = candidate
        selected = pending or active
        key_id = self.key_id(selected)
        if self.info(key_id, identity) is None:
            self.api("POST", "/key/generate", {"key": selected, "key_type": "llm_api", "models": [],
                "key_alias": "magicstick-service-" + identity["magicstick_owner_name"][:63] + "-"
                             + identity["magicstick_owner_uid"][:8] + "-" + key_id[:8],
                "metadata": {**identity, "magicstick_secret_name": name, "magicstick_target_namespace": namespace}})
            # A successful HTTP response alone is not an ownership check.
            if self.info(key_id, identity) is None:
                raise KeyError("LiteLLM service key is not registered yet")
        self.block(key_id, identity, False)
        if pending:
            if active:
                keep.append({"id": self.key_id(active), "until": self.clock() + ROTATION_GRACE_SECONDS})
            secret["data"][KEY_FIELD] = secret["data"].pop("PENDING_API_KEY")
            annotations[PREFIX + "requested"] = annotations.pop(PREFIX + "pending-requested")
            annotations[PREFIX + "revision"] = secrets.token_hex(12)
            annotations[PREFIX + "retiring"] = json.dumps(keep)
            secret = self.save(secret)
            annotations = secret["metadata"].get("annotations") or {}
        return {"name": name, "key": KEY_FIELD, "revision": annotations.get(PREFIX + "revision", "")}

    def remove_record_secret(self, record, identity):
        metadata = record.get("metadata") or {}
        namespace, name = metadata.get("magicstick_target_namespace"), metadata.get("magicstick_secret_name")
        if not namespace or not name:
            return
        path = f"/api/v1/namespaces/{namespace}/secrets/{name}"
        secret = self.k8s("GET", path, missing_ok=True)
        if secret:
            self.check_secret(secret, identity)
            self.k8s("DELETE", path)

    def delete(self, owner, namespace, name):
        identity = self.owner(owner)
        secret_path = f"/api/v1/namespaces/{namespace}/secrets/{name}"
        secret = self.k8s("GET", secret_path, missing_ok=True)
        if secret:
            self.check_secret(secret, identity)
        records = self.owned_keys(identity)
        # Keep old namespace locations recoverable in backend metadata until
        # their Secrets are gone. A failed revoke retains the owner finalizer.
        for record in records:
            if ((record.get("metadata") or {}).get("magicstick_target_namespace"),
                    (record.get("metadata") or {}).get("magicstick_secret_name")) != (namespace, name):
                self.remove_record_secret(record, identity)
            self.api("POST", "/key/delete", {"keys": [record["token"]]})
        if secret:
            self.k8s("DELETE", secret_path)
