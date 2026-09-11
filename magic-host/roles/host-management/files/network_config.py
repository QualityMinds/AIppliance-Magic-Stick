"""MIT: bounded Netplan inventory and configuration, with no secret reporting."""
import copy
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess

from network_contract import validate_network

NETPLAN = Path("/etc/netplan")
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}


def private_fingerprint(value, state=Path("/var/lib/magicstick/host-management")):
    """Do not publish an unkeyed password/configuration hash as an offline oracle."""
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = state / "network-fingerprint.key"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "wb") as stream:
            stream.write(os.urandom(32)); stream.flush(); os.fsync(stream.fileno())
    key = path.read_bytes()
    if len(key) != 32:
        raise ValueError("Local network fingerprint key is invalid.")
    return hmac.new(key, json.dumps(value, sort_keys=True).encode(), hashlib.sha256).hexdigest()


def command(argv, timeout=20):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=ENV, check=False)
    if result.returncode:
        raise RuntimeError("Local network command failed. No command output or credentials are published.")
    return result.stdout


def configuration():
    import yaml
    files = sorted(NETPLAN.glob("*.yaml"))
    if len(files) > 32 or any(p.is_symlink() or p.stat().st_size > 262144 for p in files):
        raise ValueError("Unsupported Netplan file layout.")
    if any(list(Path(root).glob("*.yaml")) for root in ("/run/netplan", "/lib/netplan")):
        raise ValueError("Transient or vendor Netplan files require local administration.")
    snapshots = {p.name: p.read_text() for p in files}
    effective = yaml.safe_load(command(["netplan", "get"])) or {"network": {"version": 2}}
    network = effective.get("network", {})
    if not isinstance(network, dict) or set(network) - {"version", "renderer", "ethernets", "wifis"}:
        raise ValueError("Bridges, bonds, VLANs and advanced network stacks require local administration.")
    fingerprint = hashlib.sha256(json.dumps(snapshots, sort_keys=True).encode()).hexdigest()
    return effective, snapshots, fingerprint


def profile_for(network, name, mac, kind):
    section = "wifis" if kind == "wifi" else "ethernets"
    matches = []
    for key, value in network.get(section, {}).items():
        match = value.get("match", {})
        if key == name and not match or value.get("set-name") == name or mac and match.get("macaddress", "").lower() == mac.lower() or match.get("name") == name:
            matches.append((key, value))
        elif match and (set(match) - {"name", "macaddress"} or any(c in str(match.get("name", "")) for c in "*?[]")):
            raise ValueError("Wildcard or driver-matched interfaces require local administration.")
    if len(matches) > 1:
        raise ValueError("Multiple Netplan definitions match this interface.")
    return matches[0] if matches else (name, {})


def collect(node, root=Path("/sys/class/net")):
    result = {"supported": False, "message": "Network inventory is unavailable.", "interfaces": []}
    try:
        addresses = json.loads(command(["ip", "-j", "address", "show"]))
        routes = json.loads(command(["ip", "-j", "-4", "route", "show", "default"]))
        try:
            effective, _, fingerprint = configuration()
            result.update(supported=True, message="Netplan configuration is available.")
        except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired):
            effective = {"network": {}}
            result["message"] = "Configuration is read-only: unsupported Netplan layout or unavailable backend. Use the local console."
        protected = [a["address"] for a in node.get("status", {}).get("addresses", []) if a.get("type") == "InternalIP"]
        for value in addresses:
            name = value.get("ifname", "")
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}", name) or not (root / name / "device").exists():
                continue
            kind = "wifi" if (root / name / "wireless").is_dir() else "ethernet"
            ips = [f'{a["local"]}/{a["prefixlen"]}' for a in value.get("addr_info", []) if a.get("family") in {"inet", "inet6"}]
            item = {"name": name, "kind": kind, "mac": value.get("address", ""), "state": value.get("operstate", "UNKNOWN"),
                    "addresses": ips, "editable": result["supported"], "scanSupported": kind == "wifi" and "UP" in value.get("flags", []) and Path("/usr/sbin/iw").exists(),
                    "clusterAddresses": [a for a in protected if a in [ip.split('/')[0] for ip in ips]],
                    "gateway": next((r.get("gateway", "") for r in routes if r.get("dev") == name), "")}
            try:
                _, config = profile_for(effective["network"], name, item["mac"], kind)
                if (any(not isinstance(a, str) for a in config.get("addresses", []))
                        or sum(":" not in a for a in config.get("addresses", []) if isinstance(a, str)) > 1
                        or any(":" not in r.get("to", "") and r.get("to") not in {"default", "0.0.0.0/0"} for r in config.get("routes", []))
                        or any(key in config for key in ("routing-policy", "auth", "networkmanager", "openvswitch"))):
                    item["editable"] = False
                aps = config.get("access-points", {})
                ssid = next(iter(aps), "") if len(aps) == 1 else ""
                ap = aps.get(ssid, {})
                item.update(configuredMode="dhcp" if config.get("dhcp4", not config.get("addresses")) else "static",
                            configuredAddress=next((ip for ip in config.get("addresses", []) if isinstance(ip, str) and ":" not in ip), ""),
                            configuredGateway=config.get("gateway4", next((r.get("via", "") for r in config.get("routes", []) if r.get("to") in {"default", "0.0.0.0/0"} and ":" not in r.get("via", "")), "")),
                            dns=config.get("nameservers", {}).get("addresses", []),
                            metric=config.get("dhcp4-overrides", {}).get("route-metric", next((r.get("metric", 100) for r in config.get("routes", []) if r.get("to") in {"default", "0.0.0.0/0"}), 600 if kind == "wifi" else 100)))
                if kind == "wifi":
                    item.update(configuredSsid=ssid, hasPassword=bool(ap.get("password") or ap.get("auth", {}).get("password")),
                                security="wpa-psk" if ap.get("password") or ap.get("auth") else "open", hidden=bool(ap.get("hidden")))
                    if ap.get("auth", {}).get("key-management") not in {None, "psk"}:
                        item["editable"] = False
                    try:
                        link = command(["iw", "dev", name, "link"], timeout=5)
                        item["connectedSsid"] = next((line.strip()[6:] for line in link.splitlines() if line.strip().startswith("SSID: ")), "")
                    except (RuntimeError, OSError, subprocess.TimeoutExpired):
                        item["connectedSsid"] = ""
            except (ValueError, TypeError, AttributeError):
                item["editable"] = False
            result["interfaces"].append(item)
        result["interfaces"] = result["interfaces"][:32]
        if result["supported"]:
            result["id"] = private_fingerprint({"config": fingerprint, "devices": [{k: i[k] for k in ("name", "mac", "kind", "clusterAddresses")} for i in result["interfaces"]]})
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired):
        result.update(supported=False, message="Network inventory is unavailable. No network change can be requested.")
        result.pop("id", None)
    return result


def build_configuration(effective, inventory, settings):
    settings = validate_network(settings, inventory)
    interface = next(i for i in inventory["interfaces"] if i["name"] == settings["interface"])
    result = copy.deepcopy(effective)
    network = result.setdefault("network", {"version": 2})
    key, previous = profile_for(network, interface["name"], interface["mac"], interface["kind"])
    config = copy.deepcopy(previous)
    # Preserve the backend, matching rules and IPv6; change only reviewed IPv4/WLAN settings.
    config.update(dhcp4=settings["mode"] == "dhcp", optional=True)
    config.pop("gateway4", None)
    config["addresses"] = [v for v in config.get("addresses", []) if isinstance(v, str) and ":" in v]
    config["routes"] = [r for r in config.get("routes", []) if ":" in r.get("via", "") or ":" in r.get("to", "")]
    config.setdefault("dhcp4-overrides", {}).update({"route-metric": settings["metric"], "use-dns": not bool(settings["dns"])})
    if config.get("dhcp6") and config["dhcp4"] and config.get("renderer", network.get("renderer", "networkd")) == "networkd":
        config["dhcp6-overrides"] = copy.deepcopy(config["dhcp4-overrides"])
    config.setdefault("nameservers", {})["addresses"] = settings["dns"]
    if settings["mode"] == "static":
        config["addresses"].append(settings["address"])
        if settings["gateway"]:
            config["routes"].append({"to": "default", "via": settings["gateway"], "metric": settings["metric"]})
    if interface["kind"] == "wifi":
        ap = {"hidden": settings["hidden"]}
        if settings["security"] == "wpa-psk":
            old = previous.get("access-points", {}).get(settings["ssid"], {})
            ap["password"] = settings["password"] or old.get("password") or old.get("auth", {}).get("password")
            if not ap["password"]:
                raise ValueError("No saved password exists for this Wi-Fi network.")
        config["access-points"] = {settings["ssid"]: ap}
    network.setdefault("wifis" if interface["kind"] == "wifi" else "ethernets", {})[key] = config
    return result


def scan_wifi(name):
    # Fixed argv; arbitrary driver commands or interface paths cannot be submitted.
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}", name):
        raise ValueError("Invalid Wi-Fi interface.")
    output = command(["iw", "dev", name, "scan"], timeout=25)
    found, current = {}, {}
    for line in (output + "\nBSS end").splitlines():
        value = line.strip()
        if value.startswith("BSS "):
            if current.get("ssid") and (current["ssid"] not in found or current.get("signal", -100) > found[current["ssid"]].get("signal", -100)):
                found[current["ssid"]] = current
            current = {"security": "open"}
        elif value.startswith("SSID: "):
            ssid = value[6:]
            if 1 <= len(ssid.encode()) <= 32 and not any(ord(c) < 32 for c in ssid):
                current["ssid"] = ssid
        elif value.startswith("signal: "):
            try:
                current["signal"] = round(float(value.split()[1]))
            except ValueError:
                pass
        elif value.startswith(("RSN:", "WPA:")):
            current["security"] = "secured"
    return sorted(found.values(), key=lambda x: x.get("signal", -100), reverse=True)[:32]
