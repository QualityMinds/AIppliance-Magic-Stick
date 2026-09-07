# SPDX-License-Identifier: MIT
"""Fail-closed integration for the commercial federated-SSO capability."""
from __future__ import annotations

import copy
import hashlib
import importlib
import json
import threading
import urllib.parse

from licensing import LicenseError


FEATURE = "federated-sso"
LOCK = threading.RLock()


def plugin():
    try:
        return importlib.import_module("magicstick_enterprise.federated_sso")
    except ImportError as error:
        raise LicenseError("not_implemented", "Federated SSO is not installed.", 503) from error


class FederatedSso:
    def __init__(self, *, license_service, admin, verify_admin, realm, issuer, audit=None):
        self.license = license_service
        self.admin = admin
        self.verify_admin = verify_admin
        self.realm = realm
        self.issuer = issuer.rstrip("/")
        self.audit = audit or (lambda **_event: None)

    def _path(self, suffix=""):
        return "/admin/realms/" + urllib.parse.quote(self.realm, safe="") + suffix

    def _provider_path(self, alias, suffix=""):
        return self._path(
            "/identity-provider/instances/" + urllib.parse.quote(alias, safe="") + suffix
        )

    def _feature(self):
        status = self.license.status()
        item = next(item for item in status["features"] if item["id"] == FEATURE)
        if status.get("state") == "trust_unavailable":
            return {**item, "available": False, "reason": "trust_unavailable"}
        return item

    def _feature_status(self):
        try:
            return self._feature()
        except (LicenseError, KeyError, StopIteration, TypeError) as error:
            try:
                plugin()
                implemented = True
            except LicenseError:
                implemented = False
            return {
                "id": FEATURE,
                "name": "Dashboard-managed federated SSO",
                "licensed": False,
                "implemented": implemented,
                "available": False,
                "reason": getattr(error, "code", "verification_unavailable"),
            }

    def _require_capability(self):
        self.license.require_capability(FEATURE, authorized=True)

    def _providers(self):
        values, _ = self.admin("GET", self._path("/identity-provider/instances"))
        if not isinstance(values, list):
            raise LicenseError("identity_unavailable", "Federation state is unavailable.", 503)
        return values

    def _provider(self, alias):
        for value in self._providers():
            if value.get("alias") == alias:
                return value
        return None

    def _mappers(self, alias):
        values, _ = self.admin("GET", self._provider_path(alias, "/mappers"))
        if not isinstance(values, list):
            raise LicenseError("identity_unavailable", "Federation mappings are unavailable.", 503)
        return values

    @staticmethod
    def _managed(provider):
        return isinstance(provider, dict) and (provider.get("config") or {}).get("magicstickManaged") == "true"

    def _describe(self, provider, mappers=None):
        extension = plugin()
        config = provider.get("config") or {}
        provider_id = str(provider.get("providerId") or "")
        summaries = []
        for mapper in (self._mappers(provider["alias"]) if mappers is None else mappers):
            summary = extension.mapping_summary(provider_id, mapper)
            if summary:
                summaries.append(summary)
        summaries.sort(key=lambda value: (value["source"], value["value"], value["accessLevel"]))
        item = {
            "alias": str(provider.get("alias") or ""),
            "displayName": str(provider.get("displayName") or provider.get("alias") or ""),
            "protocol": provider_id,
            "metadataUrl": str(config.get("magicstickMetadataUrl") or ""),
            "clientId": str(config.get("clientId") or "") if provider_id == "oidc" else "",
            "scopes": str(config.get("defaultScope") or "") if provider_id == "oidc" else "",
            "enabled": provider.get("enabled") is True,
            "trustEmail": provider.get("trustEmail") is True if provider_id == "oidc" else False,
            "secretConfigured": (
                config.get("magicstickSecretConfigured") == "true" or bool(config.get("clientSecret"))
            ) if provider_id == "oidc" else False,
            "mappings": summaries,
        }
        item["revision"] = hashlib.sha256(
            json.dumps(item, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return item

    def status(self, principal):
        self.verify_admin(principal)
        items = [self._describe(provider) for provider in self._providers() if self._managed(provider)]
        items.sort(key=lambda value: value["alias"])
        return {
            "feature": self._feature_status(),
            "issuer": self.issuer,
            "callbackUrl": self.issuer + "/broker/{alias}/endpoint",
            "providers": items,
        }

    def validate(self, principal, payload):
        self.verify_admin(principal)
        self._require_capability()
        extension = plugin()
        data = extension.validate_metadata_payload(payload)
        imported, _ = self.admin("POST", self._path("/identity-provider/import-config"), {
            "providerId": data["protocol"],
            "fromUrl": data["metadataUrl"],
        })
        return {
            "protocol": data["protocol"],
            "metadataUrl": data["metadataUrl"],
            "configuration": extension.metadata_preview(data["protocol"], imported),
        }

    def save(self, principal, payload, *, alias=None, request_id=""):
        self.verify_admin(principal)
        self._require_capability()
        extension = plugin()
        protocol = payload.get("protocol") if isinstance(payload, dict) else None
        data = extension.validate_payload(payload, require_secret=protocol == "oidc")
        if alias is not None and alias != data["alias"]:
            raise LicenseError("conflict", "A provider alias cannot be changed.", 409)
        with LOCK:
            existing = self._provider(data["alias"])
            if existing and not self._managed(existing):
                raise LicenseError("conflict", "This alias is managed outside the Magic Stick dashboard.", 409)
            expected = data.get("expectedRevision")
            if existing:
                if str(existing.get("providerId") or "") != data["protocol"]:
                    raise LicenseError("conflict", "A provider protocol cannot be changed.", 409)
                current_mappers = self._mappers(data["alias"])
                current = self._describe(existing, current_mappers)
                if not expected or expected != current["revision"]:
                    raise LicenseError("conflict", "Federation changed. Reload and review it again.", 409)
            elif expected not in {None, "new"}:
                raise LicenseError("conflict", "Federation already changed. Reload and retry.", 409)

            imported, _ = self.admin("POST", self._path("/identity-provider/import-config"), {
                "providerId": data["protocol"],
                "fromUrl": data["metadataUrl"],
            })
            provider, mappers = extension.build_provider(data, imported, issuer=self.issuer)
            requested_enabled = provider["enabled"]
            staged = copy.deepcopy(provider)
            staged["enabled"] = False
            created = existing is None
            created_in_request = False
            try:
                if created:
                    self.admin("POST", self._path("/identity-provider/instances"), staged)
                    created_in_request = True
                else:
                    self.admin("PUT", self._provider_path(data["alias"]), staged)
                    for mapper in current_mappers:
                        if str(mapper.get("name") or "").startswith(extension.MANAGED_MAPPER_PREFIX):
                            identifier = str(mapper.get("id") or "")
                            if not identifier:
                                raise LicenseError("identity_unavailable", "A federation mapping has no stable ID.", 503)
                            self.admin("DELETE", self._provider_path(
                                data["alias"], "/mappers/" + urllib.parse.quote(identifier, safe="")
                            ))
                for mapper in mappers:
                    self.admin("POST", self._provider_path(data["alias"], "/mappers"), mapper)
                provider["enabled"] = requested_enabled
                self.admin("PUT", self._provider_path(data["alias"]), provider)
            except Exception:
                if created_in_request:
                    try:
                        self.admin("DELETE", self._provider_path(data["alias"]))
                    except Exception:
                        pass
                # Existing providers remain disabled after any partial update.
                self.audit(principal=principal, action="save", target=data["alias"], result="failure", request_id=request_id)
                raise
            self.audit(principal=principal, action="create" if created else "update", target=data["alias"], result="success", request_id=request_id)
            return self.status(principal)

    def delete(self, principal, alias, expected_revision, request_id=""):
        self.verify_admin(principal)
        with LOCK:
            existing = self._provider(alias)
            if not existing or not self._managed(existing):
                raise LicenseError("not_found", "Federation provider was not found.", 404)
            current = self._describe(existing)
            if not isinstance(expected_revision, str) or expected_revision != current["revision"]:
                raise LicenseError("conflict", "Federation changed. Reload and review it again.", 409)
            self.admin("DELETE", self._provider_path(alias))
            self.audit(principal=principal, action="delete", target=alias, result="success", request_id=request_id)
            return {"deleted": alias}

    def enforce_entitlement(self):
        """Disable managed upstream login when entitlement is absent or invalid."""
        available = self._feature_status()["available"] is True
        if available:
            return 0
        disabled = 0
        with LOCK:
            for provider in self._providers():
                if self._managed(provider) and provider.get("enabled") is True:
                    replacement = copy.deepcopy(provider)
                    replacement["enabled"] = False
                    self.admin("PUT", self._provider_path(provider["alias"]), replacement)
                    disabled += 1
        return disabled
