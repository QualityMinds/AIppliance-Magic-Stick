import importlib.util
from pathlib import Path
import unittest

import yaml
from jinja2 import Environment


ROLE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "control_plane_network", ROLE / "files/control_plane_network.py",
)
network = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(network)


def addresses(index, ip, prefix):
    return {
        "ifindex": index,
        "addr_info": [{"family": "inet", "local": ip, "prefixlen": prefix}],
    }


def owned_link(*flags):
    return {
        "ifname": network.INTERFACE,
        "ifindex": 7,
        "ifalias": network.OWNER,
        "linkinfo": {"info_kind": "dummy"},
        "flags": list(flags),
    }


class ControlPlaneNetworkTests(unittest.TestCase):
    def test_internal_address_is_not_the_gateway_or_a_new_site_subnet(self):
        config = yaml.safe_load((ROLE / "files/20-magicstick-control-plane-network.yaml").read_text())
        self.assertEqual(config["node-ip"], str(network.ADDRESS.ip))
        self.assertEqual(config["advertise-address"], str(network.ADDRESS.ip))
        self.assertEqual(config["flannel-iface"], network.INTERFACE)
        self.assertEqual(network.ADDRESS.network.prefixlen, 32)
        self.assertEqual(
            network.inspect([], [addresses(5, "192.0.2.17", 24)],
                            [{"dst": "default", "dev": "ethernet"}]),
            "absent",
        )

    def test_create_owned_alias_then_assign_and_bring_up(self):
        commands = []
        network.ensure("absent", lambda *args: commands.append(args))
        self.assertEqual(commands, [
            ("link", "add", "name", network.INTERFACE, "type", "dummy"),
            ("link", "set", "dev", network.INTERFACE, "alias", network.OWNER),
            ("address", "add", str(network.ADDRESS), "dev", network.INTERFACE),
            ("link", "set", "dev", network.INTERFACE, "up"),
        ])

    def test_normal_restart_never_behaves_like_an_interface_migration(self):
        address = addresses(7, str(network.ADDRESS.ip), 32)
        routes = [{"dst": str(network.ADDRESS.ip), "dev": network.INTERFACE, "table": "local"}]
        self.assertEqual(network.inspect([owned_link("UP")], [address], routes), "ready")
        network.ensure("ready", lambda *args: self.fail(f"unexpected mutation: {args}"))
        self.assertEqual(network.inspect([owned_link()], [address], routes), "down")
        self.assertEqual(network.inspect([owned_link()], [], []), "unconfigured")

    def test_wrong_owner_kind_bridge_or_interface_address_cannot_be_adopted(self):
        for mutation in (
            {"ifalias": "external"},
            {"linkinfo": {"info_kind": "veth"}},
            {"master": "external-bridge"},
        ):
            with self.subTest(mutation=mutation), self.assertRaises(network.NetworkConflict):
                network.inspect([owned_link("UP") | mutation], [], [])
        with self.assertRaisesRegex(network.NetworkConflict, "unexpected IPv4"):
            network.inspect([owned_link("UP")], [addresses(7, "192.0.2.8", 24)], [])

    def test_existing_interface_and_route_conflicts_fail_before_changes(self):
        with self.assertRaisesRegex(network.NetworkConflict, "overlaps an existing interface"):
            network.inspect([], [addresses(5, "10.43.0.8", 24)], [])
        with self.assertRaisesRegex(network.NetworkConflict, "overlaps an existing route"):
            network.inspect([], [], [{"dst": "10.43.0.0/16", "dev": "external"}])

    def test_feature_gate_is_only_for_new_managed_installations(self):
        tasks = yaml.safe_load((ROLE / "tasks/control-plane-network.yml").read_text())
        task = next(task for task in tasks if "magicstick_link_independent_network" in task.get("ansible.builtin.set_fact", {}))
        expression = task["ansible.builtin.set_fact"]["magicstick_link_independent_network"]
        template = Environment().from_string(expression)
        for qualified, binary, config, mode, expected in [
            (False, False, False, "readonly-public", "False"),
            (True, False, False, "readonly-public", "True"),
            (True, True, False, "readonly-public", "False"),
            (True, False, True, "readonly-public", "False"),
            (True, False, False, "github", "False"),
        ]:
            with self.subTest(qualified=qualified, binary=binary, config=config, mode=mode):
                self.assertEqual(template.render(
                    k3s_managed_link_config={"stat": {"exists": False}},
                    k3s_link_release={"stdout": "qualified" if qualified else "unavailable"},
                    flux_bootstrap_mode=mode, k3s_version="v1.36.4+k3s1",
                    k3s_existing_config={"stat": {"exists": config}},
                    k3s_link_existing_binary={"stat": {"exists": binary}},
                ).strip(), expected)
        unit = (ROLE / "files/20-magicstick-control-plane-network.conf").read_text()
        self.assertIn("ExecStartPre=/usr/bin/python3 /usr/local/lib/magicstick/k3s/control_plane_network.py", unit)
