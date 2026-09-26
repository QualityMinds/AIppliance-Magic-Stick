# SPDX-License-Identifier: BUSL-1.1
"""Shared, side-effect-free software channel request validation."""
import hashlib
import json
import re
import time

SOFTWARE_ACTIONS = {"check-software-channel", "apply-software-channel"}
PREVIEW_TTL = 900


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def selection(value):
    if not isinstance(value, dict) or set(value) != {"kind", "value"}:
        raise ValueError("Choose a branch, tag or full commit.")
    kind, ref = value.get("kind"), value.get("value")
    if kind not in ("branch", "tag", "commit") or not isinstance(ref, str) or not 1 <= len(ref) <= 200:
        raise ValueError("Choose a branch, tag or full commit.")
    if kind == "commit":
        if not re.fullmatch(r"[a-fA-F0-9]{40}", ref):
            raise ValueError("A commit must contain all 40 hexadecimal characters.")
        return {"kind": kind, "value": ref.lower()}
    # Git ref syntax, deliberately restricted to printable names and no revision
    # expressions. Slash-separated feature branches are ordinary branches.
    if (not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._/-]*", ref) or ".." in ref or "//" in ref
            or ref.endswith(("/", ".")) or any(p.startswith(".") or p.endswith(".lock") for p in ref.split("/"))
            or ref.startswith("refs/")):
        raise ValueError("Use the branch or tag name, for example feature/my-change; revision expressions are not accepted.")
    return {"kind": kind, "value": ref}


def validate_request(action, payload, capability, now=None):
    if (not isinstance(capability, dict) or capability.get("supported") is not True
            or capability.get("busy") or payload.get("planId") != capability.get("id")):
        raise ValueError("Software configuration changed or the host is busy. Refresh before continuing.")
    if action not in SOFTWARE_ACTIONS:
        raise ValueError("Unsupported software operation.")
    if payload.get("allowExperimental") or payload.get("experimentMode"):
        raise ValueError("Software channel changes do not accept hardware overrides.")
    selected = selection(payload.get("softwareChannel"))
    if action == "check-software-channel":
        if payload.get("softwarePreviewId"):
            raise ValueError("A check cannot carry an earlier preview.")
    else:
        preview = capability.get("preview") or {}
        if (preview.get("id") != payload.get("softwarePreviewId") or preview.get("channel") != selected
                or preview.get("configurationId") != capability["id"] or preview.get("ready") is not True
                or not 0 <= (time.time() if now is None else now) - preview.get("checkedAtEpoch", 0) <= PREVIEW_TTL):
            raise ValueError("Check this exact channel again before applying it; the preview is missing, changed or expired.")
        if selected == capability.get("channel") and preview.get("commit") == capability.get("hostCommit") and not capability.get("blocked"):
            raise ValueError("This software configuration is already active.")
    return selected
