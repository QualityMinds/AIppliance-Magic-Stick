# SPDX-License-Identifier: LicenseRef-MagicStick-Enterprise
# Copyright (c) 2026 QualityMinds GmbH. All rights reserved.
# See enterprise/LICENSE for the scope and provisional licensing notice.
"""Validated Keycloak representations for dashboard-managed federation.

The dashboard never accepts a raw Keycloak representation.  This module keeps
the paid policy surface deliberately small: supported protocols, fields and
Magic Stick target roles are all explicit allowlists.
"""
from __future__ import annotations

import re
import urllib.parse


ALIAS = re.compile(r"^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$")
CLAIM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
MANAGED_MAPPER_PREFIX = "magicstick:"
MAX_MAPPINGS = 50
ACCESS_ROLES = {
    "user": "magicstick-user",
    "viewer": "magicstick-viewer",
    "operator": "magicstick-operator",
    "admin": "magicstick-admin",
}
OIDC_DISCOVERY_KEYS = {
    "authorizationUrl",
    "tokenUrl",
    "userInfoUrl",
    "logoutUrl",
    "jwksUrl",
    "issuer",
}
SAML_METADATA_KEYS = {
    "singleSignOnServiceUrl",
    "singleLogoutServiceUrl",
    "artifactResolutionServiceUrl",
    "idpEntityId",
    "signingCertificate",
    "nameIDPolicyFormat",
    "principalType",
    "principalAttribute",
    "signatureAlgorithm",
    "xmlSigKeyInfoKeyNameTransformer",
    "postBindingAuthnRequest",
    "postBindingResponse",
    "postBindingLogout",
    "artifactBindingResponse",
    "backchannelSupported",
    "enabledFromMetadata",
    "wantAuthnRequestsSigned",
}
URL_CONFIG_KEYS = {
    "authorizationUrl",
    "tokenUrl",
    "userInfoUrl",
    "logoutUrl",
    "jwksUrl",
    "issuer",
    "singleSignOnServiceUrl",
    "singleLogoutServiceUrl",
    "artifactResolutionServiceUrl",
}
BOOLEAN_CONFIG_KEYS = {
    "postBindingAuthnRequest",
    "postBindingResponse",
    "postBindingLogout",
    "artifactBindingResponse",
    "backchannelSupported",
    "enabledFromMetadata",
    "wantAuthnRequestsSigned",
}


def _text(value, label, *, maximum, required=True):
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    result = value.strip()
    if (required and not result) or len(result) > maximum or CONTROL.search(result):
        raise ValueError(f"{label} is invalid.")
    return result


def https_url(value, label="URL"):
    result = _text(value, label, maximum=2048)
    parsed = urllib.parse.urlsplit(result)
    if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{label} must be an HTTPS URL without embedded credentials.")
    if parsed.fragment:
        raise ValueError(f"{label} must not contain a fragment.")
    return urllib.parse.urlunsplit(parsed)


def validate_metadata_payload(payload):
    if not isinstance(payload, dict) or set(payload) - {"protocol", "metadataUrl"}:
        raise ValueError("Metadata validation contains unsupported fields.")
    protocol = str(payload.get("protocol") or "").lower()
    if protocol not in {"oidc", "saml"}:
        raise ValueError("Protocol must be OIDC or SAML.")
    return {
        "protocol": protocol,
        "metadataUrl": https_url(payload.get("metadataUrl"), "Metadata URL"),
    }


def validate_payload(payload, *, require_secret=True):
    allowed = {
        "alias", "displayName", "protocol", "metadataUrl", "clientId",
        "clientSecret", "scopes", "enabled", "trustEmail", "mappings",
        "expectedRevision",
    }
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValueError("Federation configuration contains unsupported fields.")
    alias = _text(payload.get("alias"), "Alias", maximum=63)
    if not ALIAS.fullmatch(alias):
        raise ValueError("Alias must be a lowercase DNS label.")
    display_name = _text(payload.get("displayName"), "Display name", maximum=80)
    protocol = str(payload.get("protocol") or "").lower()
    if protocol not in {"oidc", "saml"}:
        raise ValueError("Protocol must be OIDC or SAML.")
    metadata_url = https_url(payload.get("metadataUrl"), "Metadata URL")
    if type(payload.get("enabled", True)) is not bool or type(payload.get("trustEmail", False)) is not bool:
        raise ValueError("Enabled and trust-email values must be booleans.")
    result = {
        "alias": alias,
        "displayName": display_name,
        "protocol": protocol,
        "metadataUrl": metadata_url,
        "enabled": payload.get("enabled", True),
        "trustEmail": payload.get("trustEmail", False),
    }
    if protocol == "oidc":
        result["clientId"] = _text(payload.get("clientId"), "Client ID", maximum=200)
        secret = payload.get("clientSecret", "")
        if require_secret or secret:
            result["clientSecret"] = _text(secret, "Client secret", maximum=4096)
        scopes = _text(payload.get("scopes", "openid profile email"), "Scopes", maximum=512)
        scope_values = scopes.split()
        if "openid" not in scope_values or any(not CLAIM.fullmatch(scope) for scope in scope_values):
            raise ValueError("OIDC scopes must include openid and contain only safe scope names.")
        result["scopes"] = " ".join(dict.fromkeys(scope_values))
    elif any(payload.get(key) for key in ("clientId", "clientSecret", "scopes", "trustEmail")):
        raise ValueError("SAML providers cannot contain OIDC client fields.")

    mappings = payload.get("mappings")
    if not isinstance(mappings, list) or not mappings or len(mappings) > MAX_MAPPINGS:
        raise ValueError("Configure between 1 and 50 group or claim mappings.")
    normalized = []
    seen = set()
    for mapping in mappings:
        if not isinstance(mapping, dict) or set(mapping) != {"source", "value", "accessLevel"}:
            raise ValueError("Each mapping requires source, value and accessLevel.")
        source = _text(mapping.get("source"), "Claim or attribute", maximum=128)
        if not CLAIM.fullmatch(source):
            raise ValueError("Claim or attribute names contain unsupported characters.")
        value = _text(mapping.get("value"), "Claim or attribute value", maximum=256)
        access = mapping.get("accessLevel")
        if access not in ACCESS_ROLES:
            raise ValueError("Mapping access level is invalid.")
        key = (source, value, access)
        if key in seen:
            raise ValueError("Federation mappings cannot be duplicated.")
        seen.add(key)
        normalized.append({"source": source, "value": value, "accessLevel": access})
    result["mappings"] = normalized
    expected = payload.get("expectedRevision")
    if expected is not None:
        result["expectedRevision"] = _text(expected, "Expected revision", maximum=128)
    return result


def _imported_config(protocol, imported):
    if not isinstance(imported, dict):
        raise ValueError("Identity metadata did not return a configuration.")
    allowed = OIDC_DISCOVERY_KEYS if protocol == "oidc" else SAML_METADATA_KEYS
    result = {}
    for key in allowed:
        value = imported.get(key)
        if value is None or value == "":
            continue
        if not isinstance(value, (str, bool, int)):
            raise ValueError("Identity metadata contains an unsupported value.")
        text = str(value).strip()
        if len(text) > 16384 or CONTROL.search(text):
            raise ValueError("Identity metadata contains an invalid value.")
        if key in BOOLEAN_CONFIG_KEYS:
            text = text.lower()
            if text not in {"true", "false"}:
                raise ValueError("Identity metadata contains an invalid boolean value.")
        result[key] = https_url(text, key) if key in URL_CONFIG_KEYS else text
    required = ({"authorizationUrl", "tokenUrl", "issuer"} if protocol == "oidc"
                else {"singleSignOnServiceUrl", "idpEntityId", "signingCertificate"})
    if not required <= set(result):
        raise ValueError("Identity metadata is missing required endpoints or identifiers.")
    if protocol == "saml" and result.get("enabledFromMetadata") == "false":
        raise ValueError("SAML metadata is expired or not active yet.")
    return result


def build_provider(payload, imported, *, issuer):
    protocol = payload.get("protocol") if isinstance(payload, dict) else None
    data = validate_payload(payload, require_secret=protocol == "oidc")
    config = _imported_config(data["protocol"], imported)
    config.update({
        "syncMode": "FORCE",
        "magicstickManaged": "true",
        "magicstickMetadataUrl": data["metadataUrl"],
    })
    if data["protocol"] == "oidc":
        config.update({
            "clientId": data["clientId"],
            "clientSecret": data["clientSecret"],
            "magicstickSecretConfigured": "true",
            "defaultScope": data["scopes"],
            "useJwksUrl": "true",
            "validateSignature": "true",
        })
        provider_id = "oidc"
    else:
        config.update({
            "entityId": https_url(issuer, "Magic Stick issuer"),
            "validateSignature": "true",
            "wantAssertionsSigned": "true",
        })
        provider_id = "saml"
    provider = {
        "alias": data["alias"],
        "displayName": data["displayName"],
        "providerId": provider_id,
        "enabled": data["enabled"],
        "trustEmail": data["trustEmail"] if provider_id == "oidc" else False,
        "storeToken": False,
        "linkOnly": False,
        "hideOnLogin": False,
        "firstBrokerLoginFlowAlias": "first broker login",
        "config": config,
    }
    mapper_id = "oidc-role-idp-mapper" if provider_id == "oidc" else "saml-role-idp-mapper"
    source_key = "claim" if provider_id == "oidc" else "attribute.name"
    value_key = "claim.value" if provider_id == "oidc" else "attribute.value"
    mappers = []
    for index, mapping in enumerate(data["mappings"]):
        mappers.append({
            "name": f"{MANAGED_MAPPER_PREFIX}{index + 1}:{mapping['accessLevel']}",
            "identityProviderAlias": data["alias"],
            "identityProviderMapper": mapper_id,
            "config": {
                "syncMode": "FORCE",
                source_key: mapping["source"],
                value_key: mapping["value"],
                "role": ACCESS_ROLES[mapping["accessLevel"]],
            },
        })
    return provider, mappers


def metadata_preview(protocol, imported):
    """Return only non-secret endpoints that an administrator can review."""
    config = _imported_config(protocol, imported)
    keys = (["issuer", "authorizationUrl", "tokenUrl", "userInfoUrl", "jwksUrl"]
            if protocol == "oidc" else [
                "idpEntityId", "singleSignOnServiceUrl", "singleLogoutServiceUrl",
                "postBindingAuthnRequest", "postBindingResponse", "postBindingLogout",
            ])
    return {key: config[key] for key in keys if key in config}


def mapping_summary(provider_id, mapper):
    if not isinstance(mapper, dict) or not str(mapper.get("name") or "").startswith(MANAGED_MAPPER_PREFIX):
        return None
    config = mapper.get("config") or {}
    source_key = "claim" if provider_id == "oidc" else "attribute.name"
    value_key = "claim.value" if provider_id == "oidc" else "attribute.value"
    reverse = {role: access for access, role in ACCESS_ROLES.items()}
    access = reverse.get(config.get("role"))
    source, value = config.get(source_key), config.get(value_key)
    if access is None or not isinstance(source, str) or not isinstance(value, str):
        return None
    return {"source": source, "value": value, "accessLevel": access}
