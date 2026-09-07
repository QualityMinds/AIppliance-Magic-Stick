"""MIT-licensed, offline license plumbing. No Enterprise business feature is enabled.

Only configured public Ed25519 keys are trusted. The issuer lives outside the
customer runtime. Kubernetes is the authoritative state; no entitlement cache.
"""
import base64
import json
import os
import re
import time
import urllib.error
import uuid
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

FORMAT = "magicstick-license/v1"
TOKEN_TYPE = "magicstick-license+jwt"
MAX_LICENSE_BYTES = 64 * 1024
SECRET_NAME = "magicstick-enterprise-license"
FEATURES = {
    "resource-sharing": "Targeted access",
    "team-administration": "Delegated team administration",
    "resource-budgets": "Resource budgets",
    "fleet-management": "Multi-appliance operations",
    "federated-sso": "Dashboard-managed federated SSO",
    "multi-gpu": "Multi-GPU management",
    "k3s-multi-node": "k3s multi-node management",
}
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class LicenseError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


def strict_json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = item
        return result
    def constant(_):
        raise ValueError("invalid JSON number")
    return json.loads(value, object_pairs_hook=pairs, parse_constant=constant)


def public_keys(document):
    """Parse a deployment-controlled trust store, never one supplied by an upload."""
    try:
        if not isinstance(document, dict) or set(document) != {"keys"}:
            raise ValueError()
        if not isinstance(document["keys"], dict) or len(document["keys"]) > 32:
            raise ValueError()
        result = {}
        for kid, pem in document["keys"].items():
            if not IDENTIFIER.fullmatch(kid) or not isinstance(pem, str):
                raise ValueError()
            key = serialization.load_pem_public_key(pem.encode("ascii"))
            if not isinstance(key, Ed25519PublicKey):
                raise ValueError()
            result[kid] = key
        return result
    except (ValueError, TypeError, UnicodeError) as error:
        raise LicenseError("trust_unavailable", "License verification keys are invalid.", 503) from error


def official_public_keys(document):
    """Release-owned public keys and retired IDs; never supplied by a license file."""
    if not isinstance(document, dict) or "keys" not in document or set(document) - {"keys", "retiredKeyIds"}:
        raise LicenseError("trust_unavailable", "Official license verification keys are invalid.", 503)
    keys = public_keys({"keys": document["keys"]})
    retired = document.get("retiredKeyIds", [])
    if (not isinstance(retired, list) or len(retired) > 256
            or any(not isinstance(kid, str) or not IDENTIFIER.fullmatch(kid) for kid in retired)
            or len(set(retired)) != len(retired) or set(retired) & set(keys)):
        raise LicenseError("trust_unavailable", "Official license key retirement policy is invalid.", 503)
    return keys, set(retired)


def combined_public_keys(local_document, official_document=None):
    """Preserve local trust without permitting it to override an official key ID."""
    local = public_keys(local_document)
    if official_document is None:
        return local
    official, retired = official_public_keys(official_document)
    result = {kid: key for kid, key in local.items() if kid not in retired}
    for kid, key in official.items():
        if kid in result:
            raw = lambda value: value.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            if raw(result[kid]) != raw(key):
                raise LicenseError("trust_unavailable", "Local and official license verification keys conflict.", 503)
        result[kid] = key
    return result


def validate_claims(claims):
    required = {"version", "product", "issuer", "licenseId", "customer", "issuedAt", "notBefore", "expiresAt", "features"}
    if not isinstance(claims, dict) or not required <= set(claims) or set(claims) - required - {"installationId"}:
        raise LicenseError("invalid_claims", "License fields do not match the v1 contract.")
    if type(claims["version"]) is not int or claims["version"] != 1 or claims["product"] != "magicstick" or claims["issuer"] != "magicstick":
        raise LicenseError("invalid_claims", "Unsupported license version, product or issuer.")
    if not isinstance(claims["licenseId"], str) or not IDENTIFIER.fullmatch(claims["licenseId"]):
        raise LicenseError("invalid_claims", "Invalid license identifier.")
    customer = claims["customer"]
    if not isinstance(customer, str) or not customer.strip() or len(customer) > 160 or any(ord(c) < 32 or ord(c) == 127 for c in customer):
        raise LicenseError("invalid_claims", "Invalid license customer reference.")
    dates = [claims[k] for k in ("issuedAt", "notBefore", "expiresAt")]
    if any(type(v) is not int or v < 0 or v > 253402300799 for v in dates) or not dates[0] <= dates[1] < dates[2]:
        raise LicenseError("invalid_claims", "Invalid license validity interval.")
    features = claims["features"]
    if not isinstance(features, list) or any(not isinstance(f, str) or f not in FEATURES for f in features) or len(set(features)) != len(features):
        raise LicenseError("unknown_feature", "License contains unknown or duplicate capabilities.")
    if "installationId" in claims:
        try:
            if str(uuid.UUID(claims["installationId"])) != claims["installationId"]:
                raise ValueError()
        except (ValueError, AttributeError, TypeError) as error:
            raise LicenseError("invalid_claims", "Invalid installation binding.") from error
    return claims


def verify_document(document, keys, installation_id, now=None):
    """Return only signed, trusted claims; never expose unverified upload contents."""
    now = int(time.time()) if now is None else now
    try:
        if not isinstance(document, str) or len(document.encode("utf-8")) > MAX_LICENSE_BYTES:
            raise LicenseError("too_large", "License file exceeds 64 KiB.", 413)
        envelope = strict_json(document)
        if not isinstance(envelope, dict) or set(envelope) != {"format", "token"} or envelope["format"] != FORMAT or not isinstance(envelope["token"], str):
            raise ValueError()
        token = envelope["token"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token):
            raise ValueError()
        encoded_header = token.split(".")[0]
        header = strict_json(base64.urlsafe_b64decode(encoded_header + "=" * (-len(encoded_header) % 4)))
        if not isinstance(header, dict) or set(header) != {"alg", "typ", "kid"} or header["alg"] != "EdDSA" or header["typ"] != TOKEN_TYPE or not isinstance(header["kid"], str):
            raise ValueError()
        key = keys.get(header["kid"])
        if key is None:
            raise LicenseError("untrusted_key", "License signing key is not trusted on this installation.")
        verified = jwt.api_jws.decode_complete(token, key=key, algorithms=["EdDSA"])
        claims = validate_claims(strict_json(verified["payload"]))
    except LicenseError:
        raise
    except (ValueError, TypeError, UnicodeError, jwt.PyJWTError, RecursionError) as error:
        raise LicenseError("invalid_signature", "License format or signature is invalid.") from error
    state = "valid"
    message = "License signature and validity verified offline."
    if claims.get("installationId") and claims["installationId"] != installation_id:
        state, message = "wrong_installation", "License belongs to a different installation."
    elif now < claims["notBefore"]:
        state, message = "not_yet_valid", "License is not yet valid."
    elif now >= claims["expiresAt"]:
        state, message = "expired", "License has expired. Community and existing protective policies remain unchanged."
    return {"state": state, "message": message, "valid": state == "valid", "claims": claims, "keyId": header["kid"]}


class LicenseService:
    def __init__(self, request, namespace, trust_path, official_trust_path=None):
        self.request = request
        self.collection = f"/api/v1/namespaces/{namespace}/secrets"
        self.path = self.collection + "/" + SECRET_NAME
        self.namespace = namespace
        self.trust_path = Path(trust_path)
        # Older deployments/issuer tests can still supply only the local store.
        # New official installs always configure the separate release-owned file.
        official_trust_path = official_trust_path or os.environ.get("LICENSE_OFFICIAL_TRUST_STORE")
        self.official_trust_path = Path(official_trust_path) if official_trust_path else None

    def _request(self, method, path, body=None):
        try:
            return self.request(method, path, body)
        except urllib.error.HTTPError as error:
            if error.code == 409:
                raise LicenseError("conflict", "License changed concurrently. Refresh and review again.", 409) from error
            if error.code == 404 and method == "GET":
                return None
            raise LicenseError("storage_unavailable", "License storage is unavailable; no change was confirmed.", 503) from error
        except (OSError, TimeoutError, ValueError) as error:
            raise LicenseError("storage_unavailable", "License storage is unavailable; no change was confirmed.", 503) from error

    def state(self):
        secret = self._request("GET", self.path)
        if secret is None:
            # A runtime object, not Git-owned or owned by a Pod. Create races are safe.
            resource = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": {
                "name": SECRET_NAME, "namespace": self.namespace,
                "labels": {"app.kubernetes.io/managed-by": "ai-appliance-dashboard"},
            }, "stringData": {"installationId": str(uuid.uuid4())}}
            try:
                secret = self._request("POST", self.collection, resource)
            except LicenseError as error:
                if error.code != "conflict":
                    raise
                secret = self._request("GET", self.path)
        try:
            data = {k: base64.b64decode(v, validate=True).decode("utf-8") for k, v in secret.get("data", {}).items()}
            installation_id = data["installationId"]
            if str(uuid.UUID(installation_id)) != installation_id:
                raise ValueError()
            return secret, data, installation_id
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            raise LicenseError("storage_invalid", "License state is damaged; restore its backup before importing.", 503) from error

    def keys(self):
        try:
            local = strict_json(self.trust_path.read_text(encoding="utf-8"))
            official = strict_json(self.official_trust_path.read_text(encoding="utf-8")) if self.official_trust_path else None
            return combined_public_keys(local, official)
        except (OSError, ValueError, RecursionError) as error:
            raise LicenseError("trust_unavailable", "License verification keys are unavailable.", 503) from error

    def _result(self, document, installation_id):
        try:
            return verify_document(document, self.keys(), installation_id)
        except LicenseError as error:
            return {"state": error.code, "message": str(error), "valid": False}

    def status(self, state=None):
        secret, data, installation_id = state or self.state()
        result = self._result(data["license.json"], installation_id) if data.get("license.json") else {
            "state": "missing", "message": "Community mode. No license has been imported.", "valid": False,
        }
        licensed = set(result.get("claims", {}).get("features", [])) if result["valid"] else set()
        try:
            trusted = sorted(self.keys())
        except LicenseError:
            trusted = []
        return {**result, "installationId": installation_id, "revision": secret["metadata"]["resourceVersion"],
                "checkedAt": int(time.time()), "trustedKeyIds": trusted, "hasDocument": bool(data.get("license.json")),
                "features": [{"id": key, "name": name, "licensed": key in licensed,
                              "implemented": False, "available": False,
                              "reason": "not_implemented" if key in licensed else "unlicensed"} for key, name in FEATURES.items()]}

    def inspect(self, document):
        state = self.state()
        return {"candidate": self._result(document, state[2]), "current": self.status(state)}

    def activate(self, document, expected_revision):
        state = self.state()
        secret, data, installation_id = state
        if not isinstance(expected_revision, str) or expected_revision != secret["metadata"]["resourceVersion"]:
            raise LicenseError("conflict", "License changed concurrently. Refresh and review again.", 409)
        candidate = verify_document(document, self.keys(), installation_id)
        if not candidate["valid"]:
            raise LicenseError(candidate["state"], candidate["message"])
        resource = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": {
            "name": SECRET_NAME, "namespace": self.namespace, "resourceVersion": expected_revision,
            "labels": {"app.kubernetes.io/managed-by": "ai-appliance-dashboard"},
        }, "stringData": {"installationId": installation_id, "license.json": document}}
        self._request("PUT", self.path, resource)
        return self.status()  # Read authoritative persisted state, not an optimistic UI state.

    def export(self):
        _, data, _ = self.state()
        if not data.get("license.json"):
            raise LicenseError("missing", "No license has been imported.", 404)
        return {"filename": "magicstick-license.json", "content": data["license.json"]}

    def require_capability(self, feature, *, authorized):
        """Integration hook. All seven planned business capabilities are absent."""
        if not authorized:
            raise LicenseError("forbidden", "User is not authorized for this operation.", 403)
        status = self.status()
        item = next((f for f in status["features"] if f["id"] == feature), None)
        if not item or not item["licensed"]:
            raise LicenseError("unlicensed", "A valid license entitlement is required.", 403)
        if not item["implemented"] or not item["available"]:
            raise LicenseError("not_implemented", "This Enterprise capability is not implemented.", 409)
