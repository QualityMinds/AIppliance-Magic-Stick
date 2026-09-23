"""Shared public contract for bounded Ubuntu update operations."""
import hashlib
import json
import re

UPDATE_ACTIONS = {"configure-updates", "check-updates", "install-updates"}
DEFAULT_POLICY = {"mode": "security", "windowStart": "03:00", "windowMinutes": 120, "automaticReboot": False}
# These packages follow the reviewed hardware workflow, including dependencies
# on that stack. Held packages and third-party origins are also left alone.
PROTECTED = [r"^linux-", r"^firmware-", r"^nvidia-", r"^libnvidia-", r"^cuda-", r"^libcuda",
             r"^amdgpu", r"^rocm", r"^rocminfo$", r"^hip", r"^hsa-", r"^libhsa", r"^libamd",
             r"^(lib)?(rocblas|rocfft|rocrand|rocsolver|rocsparse|rocthrust|rocprim|rccl|miopen)",
             r"^intel-(media|opencl|level-zero|gpu)", r"^lib(igc|igdgmm|ze-)", r"^mesa-", r"^libdrm",
             r"^libgl[0-9x-].*-mesa", r"^libegl-mesa", r"^libgbm", r"^xserver-xorg-video-",
             r"^(amd64|intel)-microcode$", r"^dkms$"]


def protected(name):
    return any(re.search(pattern, name) for pattern in PROTECTED)


def policy_id(policy):
    return hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_policy(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_POLICY):
        raise ValueError("Supply an update mode, UTC window start, window duration and reboot setting.")
    if not isinstance(value["mode"], str) or value["mode"] not in {"manual", "security", "all"}:
        raise ValueError("Unknown update mode.")
    if not isinstance(value["windowStart"], str) or not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", value["windowStart"]):
        raise ValueError("Maintenance start must be a UTC time in HH:MM format.")
    if type(value["windowMinutes"]) is not int or not 15 <= value["windowMinutes"] <= 360:
        raise ValueError("Maintenance duration must be between 15 and 360 minutes.")
    if type(value["automaticReboot"]) is not bool:
        raise ValueError("Automatic restart must be an explicit boolean.")
    return dict(value)


def validate_update_request(action, payload, capability):
    if not capability or capability.get("supported") is not True:
        raise ValueError("Update management is unavailable on this computer.")
    if capability.get("busy"):
        raise ValueError("An update operation is already running.")
    if payload.get("planId") != capability.get("id") or not re.fullmatch(r"[a-f0-9]{64}", str(payload.get("planId", ""))):
        raise ValueError("Update settings changed. Refresh before trying again.")
    if payload.get("allowExperimental") or payload.get("experimentMode"):
        raise ValueError("Update operations do not accept hardware experiment settings.")
    if action == "configure-updates":
        if "updateScope" in payload:
            raise ValueError("Update scope belongs to an installation request.")
        return validate_policy(payload.get("updatePolicy"))
    if "updatePolicy" in payload:
        raise ValueError("Update policy belongs to a settings request.")
    if action == "install-updates":
        if not isinstance(payload.get("updateScope"), str) or payload["updateScope"] not in {"security", "all"}:
            raise ValueError("Choose security updates or all eligible Ubuntu updates.")
    elif action != "check-updates" or "updateScope" in payload:
        raise ValueError("Unsupported update request.")
    return None
