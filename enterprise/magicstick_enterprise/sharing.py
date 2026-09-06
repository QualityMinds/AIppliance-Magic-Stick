# SPDX-License-Identifier: LicenseRef-MagicStick-Enterprise
# Copyright (c) 2026 QualityMinds GmbH. All rights reserved.
# See enterprise/LICENSE for the scope and provisional licensing notice.
"""Targeted instance sharing. Identifiers, never display names, grant access."""
import re

IDENTIFIER = re.compile(r"[A-Za-z0-9._:-]{1,160}")
MAX_PRINCIPALS = 100


def validate_policy(policy):
    if not isinstance(policy, dict) or set(policy) - {"mode", "users", "groups"}:
        raise ValueError("Sharing must contain only mode, users and groups.")
    mode = policy.get("mode")
    if mode not in {"all", "selected"}:
        raise ValueError("Sharing mode must be all or selected.")
    result = {"mode": mode}
    for kind in ("users", "groups"):
        values = policy.get(kind, [])
        if not isinstance(values, list) or len(values) > MAX_PRINCIPALS:
            raise ValueError("At most 100 users and 100 groups can be selected.")
        if any(not isinstance(value, str) or not IDENTIFIER.fullmatch(value) for value in values):
            raise ValueError("Sharing requires stable Keycloak user or group IDs.")
        if len(values) != len(set(values)):
            raise ValueError("Sharing cannot contain duplicate IDs.")
        if mode == "all" and values:
            raise ValueError("All-users sharing cannot contain selected principals.")
        result[kind] = sorted(values)
    # An empty selected policy deliberately denies every user.
    return result


def permits(policy, user, groups):
    policy = validate_policy(policy)
    if user.get("enabled") is not True or user.get("serviceAccountClientId"):
        return False
    subject = user.get("id")
    if not isinstance(subject, str) or not subject:
        return False
    if policy["mode"] == "all":
        return True
    return subject in policy["users"] or bool(set(policy["groups"]) & set(groups))
