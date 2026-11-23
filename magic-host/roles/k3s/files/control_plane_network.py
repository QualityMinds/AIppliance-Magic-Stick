#!/usr/bin/env python3
"""Own the link-independent IPv4 endpoint of the bundled single-node K3s."""

import ipaddress
import json
import subprocess
import sys


INTERFACE = "magicstick-int"
OWNER = "magicstick-control-plane-v1"
# The first address in the stock ServiceCIDR is not allocatable by K3s.
# Using it avoids taking another private address range from the site's LAN.
ADDRESS = ipaddress.IPv4Interface("10.43.0.0/32")
IP = "/usr/sbin/ip"


class NetworkConflict(ValueError):
    pass


def inspect(links, addresses, routes):
    """Reject collisions before mutating the host. Return the owned link state."""
    link = next((item for item in links if item.get("ifname") == INTERFACE), None)
    if link is not None and (
        link.get("ifalias") != OWNER
        or (link.get("linkinfo") or {}).get("info_kind") != "dummy"
        or link.get("master")
    ):
        raise NetworkConflict("internal interface name is already in use")

    configured = False
    for interface in addresses:
        own = link is not None and interface.get("ifindex") == link.get("ifindex")
        for item in interface.get("addr_info", []):
            if item.get("family") != "inet":
                continue
            ip = ipaddress.IPv4Interface((item["local"], item["prefixlen"]))
            if own:
                if ip != ADDRESS:
                    raise NetworkConflict("internal interface has unexpected IPv4 configuration")
                configured = True
            elif ADDRESS.ip in ip.network:
                raise NetworkConflict("internal IPv4 overlaps an existing interface")

    for route in routes:
        dst = route.get("dst")
        if not dst or dst in {"default", "0.0.0.0/0"}:
            continue
        prefix = ipaddress.IPv4Network(dst, strict=False)
        if ADDRESS.ip not in prefix:
            continue
        if link is not None and route.get("dev") == INTERFACE and prefix == ADDRESS.network:
            continue
        raise NetworkConflict("internal IPv4 overlaps an existing route")

    if link is None:
        return "absent"
    if not configured:
        return "unconfigured"
    return "ready" if "UP" in link.get("flags", []) else "down"


def read_state():
    def get(*args):
        return json.loads(subprocess.check_output(
            [IP, "-json", *args], stderr=subprocess.DEVNULL, timeout=10,
        ))

    return inspect(
        get("-details", "link", "show"),
        get("-4", "address", "show"),
        get("-4", "route", "show", "table", "all"),
    )


def ensure(state, change):
    if state == "ready":
        return
    if state == "absent":
        change("link", "add", "name", INTERFACE, "type", "dummy")
        # Set the alias explicitly: older iproute2 accepts but ignores an
        # alias on "link add". Check ownership again before returning ready.
        change("link", "set", "dev", INTERFACE, "alias", OWNER)
    if state in {"absent", "unconfigured"}:
        change("address", "add", str(ADDRESS), "dev", INTERFACE)
    change("link", "set", "dev", INTERFACE, "up")


def main(args):
    if args not in ([], ["--check"]):
        return 2

    def change(*argv):
        subprocess.run([IP, *argv], check=True, timeout=10,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        state = read_state()
        if not args:
            ensure(state, change)
            if read_state() != "ready":
                raise NetworkConflict("internal IPv4 is not ready")
    except NetworkConflict as error:
        print(f"MagicStick control-plane network: {error}", file=sys.stderr)
        return 1
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print("MagicStick control-plane network: address inspection or setup failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
