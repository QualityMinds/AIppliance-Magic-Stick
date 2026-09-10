"""Pure, fail-closed host preparation planning. No installation side effects."""

import hashlib
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def build_plan(report, display_gpus, installed, catalog, architecture):
    plan = {"state": "not-required", "message": "No additional host preparation profile is required. Existing vendor operators remain unchanged.",
            "profileId": "", "profileVersion": "", "gpuProfile": "", "experimental": False,
            "packages": {}, "targetKernel": "", "rebootRequired": False}
    strix = any(gpu == "1002:1586" for gpu in display_gpus or [])
    if display_gpus is None:
        plan.update(state="blocked", message="Complete PCI display-device inventory is unavailable; no kernel change is permitted.")
    elif strix and display_gpus != ["1002:1586"] and not (
        sum(gpu.startswith("1002:") for gpu in display_gpus) == 1
        and (report.get("nodeAnnotation") or {}).get("hostDriverReady") is True
        and report.get("kernel", {}).get("strixHaloFixes") == "present"
    ):
        plan.update(state="blocked", message="Mixed or multiple GPUs need a jointly reviewed host profile. No kernel change is permitted.")
    elif strix:
        profile = next((p for p in catalog.get("profiles", []) if p["pciDevices"] == ["1002:1586"]
                        and p["os"] == report.get("os") and p["architecture"] == architecture), None)
        if not profile:
            plan.update(state="blocked", message="No reviewed host package profile matches this GPU, OS and architecture.")
        else:
            plan.update(profileId=profile["id"], profileVersion=profile["version"], gpuProfile=profile["gpuProfile"],
                        experimental=profile["experimental"], targetKernel=profile["targetKernel"])
            evidence = report.get("nodeAnnotation") or {}
            if evidence.get("hostDriverReady") is True and report.get("kernel", {}).get("strixHaloFixes") == "present":
                plan.update(state="ready", message="Host driver is ready. The same preparation workflow can enable the experimental profile and validate both GPU engines; no package change or reboot is needed.")
            elif report.get("kernel", {}).get("release") == profile["targetKernel"]:
                plan.update(state="blocked", message="The reviewed kernel is already running but the GPU driver is not ready. Inspect hardware diagnostics; repeating installation or reboot is not a repair.")
            elif report.get("kernel", {}).get("strixHaloFixes") == "present":
                plan.update(state="blocked", message="This kernel already contains the required fixes. Driver readiness needs diagnosis, not an automatic kernel replacement.")
            else:
                plan.update(state="available", packages={name: version for name, version in profile["packages"].items()
                                                         if installed.get(name) != version}, rebootRequired=True,
                            message="The reviewed host kernel is required. Approval allows only the listed packages, one orderly restart, and separate GPU engine validation.")
    plan["displayGpus"] = display_gpus or []
    identity = {"os": report.get("os"), "kernel": report.get("kernel", {}).get("release"),
                         "bootId": report.get("bootId"), "fingerprint": report.get("hardwareFingerprint"),
                         "displayGpus": display_gpus, "installed": installed}
    # Only a shipped profile can be tested. This is not an arbitrary package or
    # driver installer escape hatch. Unknown OS/architecture stays blocked.
    profile = next((p for p in catalog.get("profiles", []) if strix and p["os"] == report.get("os")
                    and p["architecture"] == architecture and p["gpuProfile"] == "strix-halo"), None)
    if plan["state"] == "blocked" and display_gpus is not None and profile:
        release = report.get("kernel", {}).get("release")
        host_ready = (report.get("nodeAnnotation") or {}).get("hostDriverReady") is True
        fixes_missing = report.get("kernel", {}).get("strixHaloFixes") != "present"
        # Do not offer a downgrade or reboot as a repair for a failing driver on
        # an already suitable kernel, even when opting into an experiment.
        if host_ready or (fixes_missing and release != profile["targetKernel"]):
            experiment = {"state": "ready" if host_ready else "available", "profileId": profile["id"],
                          "profileVersion": profile["version"], "gpuProfile": profile["gpuProfile"], "experimental": True,
                          "experimentMode": True, "displayGpus": display_gpus, "targetKernel": profile["targetKernel"],
                          "engineValidationAvailable": sum(gpu.startswith("1002:") for gpu in display_gpus) == 1,
                          "packages": {} if host_ready else {key: val for key, val in profile["packages"].items() if installed.get(key) != val},
                          "rebootRequired": not host_ready,
                          "message": "Unreviewed GPU combination: test the shipped host profile at your own risk. Other GPUs may stop working. Keep local console access and the previous kernel available. This never certifies the combination."}
            experiment["id"] = digest({"plan": experiment, **identity})
            plan["experiment"] = experiment
    plan["id"] = digest({"plan": plan, **identity})
    return plan


TERMINAL = {"Succeeded", "PreparedUnverified", "Failed", "Rejected", "Interrupted"}
SPEC_FIELDS = {"action", "nodeName", "nodeUid", "bootId", "requestId", "planId", "allowExperimental", "experimentMode", "acknowledgeDisruption", "actorHash"}


def requested_plan(plan, spec):
    return (plan.get("experiment") or {}) if spec.get("experimentMode") is True else plan


def validate_request(operation, node, report, plan, now):
    """Recheck all API promises at the privilege boundary, including identity/time."""
    from datetime import datetime
    import re
    spec = operation.get("spec") or {}
    meta = operation.get("metadata") or {}
    if set(spec) - SPEC_FIELDS or spec.get("action") not in {"prepare-gpu", "reboot", "poweroff"}:
        raise ValueError("Unknown host operation or unsupported fields.")
    if meta.get("deletionTimestamp") or not meta.get("uid"):
        raise ValueError("Host operation is not a live Kubernetes request.")
    if not re.fullmatch(r"[a-f0-9]{32}", str(spec.get("requestId", ""))):
        raise ValueError("Invalid request identity.")
    if spec.get("nodeName") != node["metadata"]["name"] or spec.get("nodeUid") != node["metadata"]["uid"]:
        raise ValueError("This request belongs to a different host.")
    if not report.get("bootId") or spec.get("bootId") != report["bootId"]:
        raise ValueError("Host boot changed. Refresh and confirm a new request.")
    try:
        age = now - datetime.fromisoformat(meta["creationTimestamp"].replace("Z", "+00:00")).timestamp()
    except (KeyError, TypeError, ValueError):
        raise ValueError("Host request creation time is invalid.") from None
    if not -30 <= age <= 300:
        raise ValueError("Host request expired; no action was executed.")
    if spec.get("acknowledgeDisruption") is not True:
        raise ValueError("Explicit disruption acknowledgement is required.")
    if type(spec.get("experimentMode", False)) is not bool or type(spec.get("allowExperimental", False)) is not bool:
        raise ValueError("Experiment mode and experimental consent must be explicit booleans.")
    if spec["action"] == "prepare-gpu":
        plan = requested_plan(plan, spec)
        if plan.get("state") not in {"available", "ready"} or spec.get("planId") != plan.get("id"):
            raise ValueError("Hardware plan changed or is blocked. Review the current plan.")
        if plan.get("experimental") and spec.get("allowExperimental") is not True:
            raise ValueError("Experimental hardware acknowledgement is required.")
    elif spec.get("planId") or spec.get("allowExperimental") is True or spec.get("experimentMode") is True:
        raise ValueError("Power operations cannot carry hardware preparation settings.")
    return spec
