"""MIT: shared, side-effect-free validation for dashboard and root host worker."""
import ipaddress
import re


def validate_network(settings, inventory, scan=False):
    fields = {"interface", "mode", "address", "gateway", "dns", "metric", "ssid", "security", "password", "hidden"}
    if not isinstance(settings, dict) or set(settings) - fields:
        raise ValueError("Unsupported network settings.")
    name = settings.get("interface")
    if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}", name):
        raise ValueError("Select a detected physical network interface.")
    interface = next((item for item in inventory.get("interfaces", []) if item.get("name") == name), None)
    if not interface:
        raise ValueError("The selected network interface is no longer present.")
    if scan:
        if set(settings) != {"interface"} or interface.get("kind") != "wifi" or not interface.get("scanSupported"):
            raise ValueError("Wi-Fi scanning is unavailable for this interface.")
        return {"interface": name}
    if not inventory.get("supported") or not interface.get("editable"):
        raise ValueError("This network configuration cannot be edited safely in the dashboard.")
    mode, metric = settings.get("mode"), settings.get("metric")
    if mode not in {"dhcp", "static"} or type(metric) is not int or not 1 <= metric <= 65535:
        raise ValueError("Choose DHCP or static IPv4 and a route metric from 1 to 65535.")
    result = {"interface": name, "mode": mode, "metric": metric}
    dns = settings.get("dns", [])
    if not isinstance(dns, list) or len(dns) > 4 or any(not isinstance(value, str) for value in dns):
        raise ValueError("Supply at most four DNS server addresses.")
    try:
        result["dns"] = [str(ipaddress.ip_address(value)) for value in dns]
        address, gateway = settings.get("address", ""), settings.get("gateway", "")
        if mode == "static":
            if not isinstance(address, str) or "/" not in address:
                raise ValueError()
            parsed = ipaddress.IPv4Interface(address)
            if (parsed.ip.is_unspecified or parsed.ip.is_multicast or parsed.ip.is_loopback or parsed.network.prefixlen == 0
                    or parsed.network.prefixlen < 31 and parsed.ip in {parsed.network.network_address, parsed.network.broadcast_address}):
                raise ValueError()
            result["address"] = str(parsed)
            result["gateway"] = str(ipaddress.IPv4Address(gateway)) if gateway else ""
            if gateway:
                next_hop = ipaddress.IPv4Address(gateway)
                if next_hop not in parsed.network or next_hop == parsed.ip or next_hop.is_unspecified or next_hop.is_multicast or next_hop.is_loopback:
                    raise ValueError()
        elif address or gateway:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("Check the IPv4 address/prefix, same-subnet gateway and DNS addresses.") from None
    if interface.get("kind") == "wifi":
        ssid, security, password = settings.get("ssid"), settings.get("security"), settings.get("password", "")
        if (not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32
                or any(ord(c) < 32 or ord(c) == 127 for c in ssid)
                or security not in {"open", "wpa-psk"} or not isinstance(password, str)
                or type(settings.get("hidden", False)) is not bool):
            raise ValueError("Enter a valid SSID and choose open or WPA personal security.")
        reuse = interface.get("configuredSsid") == ssid and interface.get("hasPassword") is True
        valid_password = (8 <= len(password) <= 63 and all(32 <= ord(c) <= 126 for c in password)) or bool(re.fullmatch(r"[a-fA-F0-9]{64}", password))
        if security == "open" and password or security == "wpa-psk" and not (valid_password or not password and reuse):
            raise ValueError("WPA personal requires an 8–63 character password or a 64-digit hexadecimal key; leave empty only to keep the saved key for the same SSID.")
        result.update(ssid=ssid, security=security, password=password, hidden=settings.get("hidden", False))
    elif any(key in settings for key in ("ssid", "security", "password", "hidden")):
        raise ValueError("Wi-Fi credentials cannot be supplied for Ethernet.")
    protected = interface.get("clusterAddresses", [])
    if protected:
        current = interface.get("configuredMode")
        same_address = mode == "static" and str(ipaddress.IPv4Interface(result["address"]).ip) in protected
        if not (same_address or mode == current == "dhcp") or (interface.get("kind") == "wifi" and result["ssid"] != interface.get("configuredSsid")):
            raise ValueError("Changing the Kubernetes management address or its Wi-Fi network requires local cluster migration; this dashboard only preserves that address.")
    return result
