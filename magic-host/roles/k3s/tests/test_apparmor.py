# SPDX-License-Identifier: BUSL-1.1
"""Owning bootstrap/policy tests; these are not fresh-VM acceptance."""

import configparser
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import yaml
from jinja2 import Environment


ROLE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("k3s_apparmor", ROLE / "files/apparmor_profile.py")
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)
PROFILE_TEXT = (ROLE / "files/cri-containerd.apparmor.d").read_text()


class AppArmorLoaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ("PROFILE", "OWNER", "LOADED", "ENABLED", "PROFILES", "SIGNAL_FEATURE", "OS_RELEASE", "K3S"):
            path = self.root / name
            patcher = patch.object(policy, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        policy.OS_RELEASE.write_text('ID=ubuntu\nVERSION_ID="26.04"\n')
        policy.ENABLED.write_text("Y\n")
        policy.SIGNAL_FEATURE.write_text("hup int kill urg term\n")
        policy.PROFILES.write_text("")
        # Unit tests run without root. File-trust rejection has separate tests.
        trusted = patch.object(policy, "trusted_file", side_effect=lambda path: path.read_bytes())
        trusted.start()
        self.addCleanup(trusted.stop)
        self.save = patch.object(policy, "save_owner", side_effect=self.save_owner)
        self.save.start()
        self.addCleanup(self.save.stop)
        records = patch.object(policy, "save_record", side_effect=lambda path: path.write_text(json.dumps(policy.expected_owner())))
        records.start()
        self.addCleanup(records.stop)
        runner = patch.object(policy.subprocess, "run", side_effect=self.command)
        self.run = runner.start()
        self.addCleanup(runner.stop)

    def save_owner(self):
        policy.OWNER.write_text(json.dumps(policy.expected_owner()))

    def command(self, argv, **kwargs):
        if argv == [str(policy.K3S), "--version"]:
            return subprocess.CompletedProcess(argv, 0, "k3s version v1.36.4+k3s1 (example)\n", "")
        self.assertEqual(argv, [policy.PARSER, "--skip-cache", "--replace", str(policy.PROFILE)])
        self.assertEqual(kwargs["timeout"], 15)
        self.assertTrue(kwargs["check"])
        policy.PROFILES.write_text(policy.PROFILE_NAME + " (enforce)\n")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def managed(self, *, loaded=True, binary=True):
        self.save_owner()
        policy.PROFILE.write_text(PROFILE_TEXT)
        if loaded:
            policy.PROFILES.write_text(policy.PROFILE_NAME + " (enforce)\n")
            policy.LOADED.write_text(json.dumps(policy.expected_owner()))
        if binary:
            policy.K3S.touch()

    def assert_rejected(self, reason, action=policy.load):
        with self.assertRaisesRegex(policy.PolicyError, reason):
            action()
        self.assertFalse(any(call.args[0][0] == policy.PARSER for call in self.run.call_args_list))

    def test_first_boot_prepares_then_loads_before_k3s_exists(self):
        self.assertFalse(policy.preflight())
        self.assertTrue(policy.prepare())
        self.assertTrue(policy.owned())
        policy.PROFILE.write_text(PROFILE_TEXT)
        self.assertTrue(policy.load())
        policy.check()
        self.assertFalse(policy.K3S.exists())
        self.assertEqual(self.run.call_count, 1)

    def test_interrupted_bootstrap_can_resume_after_ownership_before_copy(self):
        self.assertTrue(policy.prepare())
        self.assertTrue(policy.preflight())
        self.assertFalse(policy.prepare())
        policy.PROFILE.write_text(PROFILE_TEXT)
        self.assertTrue(policy.load())

    def test_repeated_convergence_never_reloads_a_running_owned_policy(self):
        self.managed()
        self.assertFalse(policy.load())
        policy.check()
        self.assertEqual(self.run.call_count, 2)  # version reads only

    def test_reboot_reloads_the_owned_profile_and_rechecks_enforcement(self):
        self.managed(loaded=False)
        self.assertTrue(policy.load())
        policy.check()
        self.assertTrue(any(call.args[0][0] == policy.PARSER for call in self.run.call_args_list))

    def test_read_only_check_cannot_repair_an_unloaded_profile(self):
        self.managed(loaded=False)
        self.assert_rejected("profile-not-loaded", policy.check)

    def test_an_old_enforcing_profile_is_recompiled_before_being_credited(self):
        self.managed()
        policy.LOADED.unlink()
        self.assert_rejected("current-boot-load-not-attested", policy.check)
        self.assertTrue(policy.load())
        policy.check()

    def test_dropped_rules_do_not_get_a_load_attestation(self):
        self.managed(loaded=False, binary=False)

        def dropping_parser(argv, **kwargs):
            policy.PROFILES.write_text(policy.PROFILE_NAME + " (enforce)\n")
            return subprocess.CompletedProcess(argv, 0, "", "signal rules not enforced")

        self.run.side_effect = dropping_parser
        with self.assertRaisesRegex(policy.PolicyError, "rules-not-enforced"):
            policy.load()
        self.run.reset_mock()
        self.assert_rejected("current-boot-load-not-attested", policy.check)

    def test_existing_unowned_cluster_is_never_adopted(self):
        policy.K3S.touch()
        self.assert_rejected("not-owned", policy.prepare)
        self.assertFalse(policy.OWNER.exists())

    def test_existing_unowned_profile_file_is_not_overwritten(self):
        policy.PROFILE.write_text("foreign policy")
        self.assert_rejected("not-owned", policy.preflight)
        self.assertEqual(policy.PROFILE.read_text(), "foreign policy")

    def test_existing_loaded_unowned_profile_is_not_adopted(self):
        policy.PROFILES.write_text(policy.PROFILE_NAME + " (enforce)\n")
        self.assert_rejected("not-owned", policy.prepare)

    def test_custom_profile_name_is_not_mistaken_for_this_profile(self):
        policy.PROFILES.write_text(policy.PROFILE_NAME + "-foreign (enforce)\n")
        self.assertEqual(policy.profile_mode(), "absent")

    def test_disabled_apparmor_fails_without_touching_sysctl(self):
        policy.ENABLED.write_text("N\n")
        self.assert_rejected("not-enabled", policy.prepare)
        self.assertEqual(policy.ENABLED.read_text(), "N\n")

    def test_missing_signal_mediation_fails_before_parser(self):
        policy.SIGNAL_FEATURE.write_text("")
        self.assert_rejected("signal-mediation", policy.prepare)

    def test_other_os_is_not_silently_added_to_support(self):
        policy.OS_RELEASE.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        self.assert_rejected("unreviewed-host", policy.prepare)

    def test_unknown_actual_k3s_version_stops_a_managed_host(self):
        self.managed()
        self.run.side_effect = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "k3s version v1.37.0+k3s1\n", "")
        self.assert_rejected("unreviewed-k3s", policy.check)

    def test_tampered_or_previous_owner_does_not_authorize_loading(self):
        self.managed(loaded=False)
        owner = policy.expected_owner()
        owner["sha256"] = "0" * 64
        policy.OWNER.write_text(json.dumps(owner))
        self.assert_rejected("unreviewed-policy-owner")

    def test_modified_profile_cannot_be_loaded_or_credited(self):
        self.managed(loaded=False)
        policy.PROFILE.write_text(PROFILE_TEXT + "\n# unexpected modification\n")
        self.assert_rejected("unreviewed-profile-content")

    def test_convergence_does_not_overwrite_a_locally_changed_owned_profile(self):
        self.managed()
        policy.PROFILE.write_text("locally changed policy")
        self.assert_rejected("unreviewed-profile-content", policy.preflight)
        self.assertEqual(policy.PROFILE.read_text(), "locally changed policy")

    def test_complain_mode_is_not_a_success_and_is_not_silently_replaced(self):
        self.managed()
        policy.PROFILES.write_text(policy.PROFILE_NAME + " (complain)\n")
        self.assert_rejected("not-enforcing")

    def test_parser_failure_remains_a_failure(self):
        self.managed(loaded=False, binary=False)
        self.run.side_effect = subprocess.CalledProcessError(1, "parser", stderr="private parser detail")
        with self.assertRaises(subprocess.CalledProcessError):
            policy.load()
        with self.assertRaisesRegex(policy.PolicyError, "profile-not-loaded"):
            policy.check()

    def test_parser_exit_zero_without_enforcing_profile_is_not_success(self):
        self.managed(loaded=False, binary=False)
        self.run.side_effect = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0)
        with self.assertRaisesRegex(policy.PolicyError, "load-not-verified"):
            policy.load()

    def test_symlink_owner_is_rejected(self):
        target = self.root / "other-owner"
        target.write_text(json.dumps(policy.expected_owner()))
        policy.OWNER.symlink_to(target)
        self.assert_rejected("unsafe-owned-file", policy.prepare)


class AppArmorPolicyContractTests(unittest.TestCase):
    def test_profile_is_hash_bound_and_enforcing_not_unconfined_or_complain(self):
        self.assertEqual(hashlib.sha256(PROFILE_TEXT.encode()).hexdigest(), policy.PROFILE_SHA256)
        self.assertIn("abi <abi/3.0>,", PROFILE_TEXT)
        self.assertNotRegex(PROFILE_TEXT, r"flags=.*(?:complain|unconfined)")
        self.assertNotIn("change_profile", PROFILE_TEXT)

    def test_only_exact_container_signal_peers_gain_send_permission(self):
        rules = re.findall(r"^\s*signal \(send,receive\) peer=([^,]+),", PROFILE_TEXT, re.M)
        self.assertEqual(rules, [policy.PROFILE_NAME, '"' + policy.PROFILE_NAME + '//&unconfined"'])
        self.assertNotIn("*", "".join(rules))
        ptrace = re.findall(r"^\s*ptrace .*", PROFILE_TEXT, re.M)
        self.assertEqual(len(ptrace), 1)
        self.assertNotIn("//&", ptrace[0])
        for denial in ("deny mount,", "deny /sys/kernel/security/** rwklx,",
                       "deny @{PROC}/sysrq-trigger rwklx,", "deny @{PROC}/kcore rwklx,"):
            self.assertIn(denial, PROFILE_TEXT)

    def test_unit_orders_profile_before_k3s_and_rechecks_every_k3s_start(self):
        loader = configparser.ConfigParser(interpolation=None)
        loader.read(ROLE / "files/magicstick-k3s-apparmor.service")
        dropin = configparser.ConfigParser(interpolation=None)
        dropin.read(ROLE / "files/10-magicstick-apparmor.conf")
        self.assertEqual(loader["Unit"]["Requires"], "apparmor.service")
        self.assertEqual(loader["Unit"]["After"], "apparmor.service")
        self.assertEqual(loader["Unit"]["Before"], "k3s.service")
        self.assertIn("--load", loader["Service"]["ExecStart"])
        self.assertEqual(dropin["Unit"]["Requires"], "magicstick-k3s-apparmor.service")
        self.assertEqual(dropin["Unit"]["After"], "magicstick-k3s-apparmor.service")
        self.assertIn("--check", dropin["Service"]["ExecStartPre"])

    def test_ansible_prepares_before_install_and_never_adopts_existing_cluster(self):
        tasks = yaml.safe_load((ROLE / "tasks/main.yml").read_text())
        self.assertEqual(tasks[0]["ansible.builtin.import_tasks"], "apparmor.yml")
        security = yaml.safe_load((ROLE / "tasks/apparmor.yml").read_text())
        block = next(task for task in security if "block" in task)
        self.assertIn("not k3s_apparmor_binary.stat.exists", block["when"])
        self.assertIn("k3s_apparmor_owner.stat.exists", block["when"])
        names = [task["name"] for task in block["block"]]
        self.assertLess(names.index("Check initial policy ownership before writing any profile"),
                        names.index("Install the reviewed containerd profile"))
        self.assertLess(names.index("Record ownership before interruptible profile installation"),
                        names.index("Install the reviewed containerd profile"))
        text = (ROLE / "tasks/apparmor.yml").read_text()
        self.assertNotIn("state: restarted", text)
        self.assertNotIn("sysctl", text)

    def test_role_condition_keeps_existing_and_older_hosts_untouched(self):
        tasks = yaml.safe_load((ROLE / "tasks/apparmor.yml").read_text())
        expression = Environment().compile_expression(next(task["when"] for task in tasks if "block" in task))
        for installed, owned, version, expected in (
            (False, False, "26.04", True), (True, False, "26.04", False),
            (False, False, "24.04", False), (True, False, "24.04", False),
            (True, True, "26.04", True), (True, True, "24.04", True),
        ):
            with self.subTest(installed=installed, owned=owned, version=version):
                self.assertEqual(expression(
                    k3s_apparmor_binary={"stat": {"exists": installed}},
                    k3s_apparmor_owner={"stat": {"exists": owned}},
                    ansible_facts={"distribution": "Ubuntu", "distribution_version": version},
                ), expected)
        # Previously managed hosts still enter the block after an OS change,
        # where the strict baseline assertion rejects the unreviewed upgrade.

    def test_native_parser_is_required_by_the_existing_public_release_job(self):
        workflow = yaml.safe_load((ROLE.parents[2] / ".github/workflows/public-release-checks.yml").read_text())
        steps = workflow["jobs"]["release-checks"]["steps"]
        step = next(item for item in steps if item.get("name") == "Check appliance consoles and host management")
        self.assertEqual(step["env"]["MAGICSTICK_REQUIRE_APPARMOR_PARSER"], "1")
        self.assertIn("magic-host/roles/k3s/tests", step["run"])

    def test_native_parser_compiles_the_signal_rule_instead_of_dropping_it(self):
        parser = shutil.which("apparmor_parser")
        if not parser:
            if os.environ.get("MAGICSTICK_REQUIRE_APPARMOR_PARSER") == "1":
                self.fail("Native AppArmor parser is required in this CI job")
            self.skipTest("AppArmor parser is unavailable on this host; native CI must run this check")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            inputs = (PROFILE_TEXT, PROFILE_TEXT.replace(
                '  signal (send,receive) peer="cri-containerd.apparmor.d//&unconfined",\n', ""))
            binaries = []
            for index, source in enumerate(inputs):
                profile, compiled = directory / f"policy-{index}", directory / f"compiled-{index}"
                profile.write_text(source)
                result = subprocess.run([
                    parser, "--skip-cache", "--skip-kernel-load",
                    "--kernel-features", "/etc/apparmor.d/abi/3.0",
                    "--ofile", str(compiled), str(profile),
                ], capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("not enforced", result.stderr)
                binaries.append(compiled.read_bytes())
            self.assertGreater(len(binaries[0]), 100)
            self.assertNotEqual(binaries[0], binaries[1], "The stacked signal rule must survive compilation")


class AppArmorTrustedFileTests(unittest.TestCase):
    def test_trusted_root_owned_regular_file_is_read(self):
        with tempfile.NamedTemporaryFile() as source:
            source.write(b"reviewed data")
            source.flush()
            values = list(os.fstat(source.fileno()))
            values[4], values[0] = 0, 0o100644
            with patch.object(policy.os, "fstat", return_value=os.stat_result(values)):
                self.assertEqual(policy.trusted_file(Path(source.name)), b"reviewed data")

    def test_writable_and_non_root_files_are_rejected(self):
        with tempfile.NamedTemporaryFile() as source:
            info = os.fstat(source.fileno())
            for uid, mode in ((1, 0o100644), (0, 0o100666)):
                changed = list(info)
                changed[4], changed[0] = uid, mode
                with self.subTest(uid=uid, mode=mode), patch.object(policy.os, "fstat", return_value=os.stat_result(changed)):
                    with self.assertRaisesRegex(policy.PolicyError, "unsafe-owned-file"):
                        policy.trusted_file(Path(source.name))

    def test_symlink_policy_is_not_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "target"
            target.write_text("untrusted")
            link = Path(temporary) / "link"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                policy.trusted_file(link)

    def test_owned_records_are_atomic_private_and_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary) / "private" / "owner.json"
            original_lstat = Path.lstat

            def root_metadata(path, *args, **kwargs):
                values = list(original_lstat(path, *args, **kwargs))
                values[4] = 0  # simulate the production root-owned directory
                return os.stat_result(values)

            with patch.object(Path, "lstat", root_metadata):
                policy.save_record(record)
            self.assertEqual(json.loads(record.read_text()), policy.expected_owner())
            self.assertEqual(record.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(record.parent.glob(".record-*")), [])

    def test_cli_never_exports_parser_or_transport_stderr(self):
        output = io.StringIO()
        error = subprocess.CalledProcessError(1, "parser", stderr="private detail must not escape")
        with patch.object(policy.sys, "argv", ["apparmor_profile.py", "--load"]), \
             patch.object(policy.os, "geteuid", return_value=0), \
             patch.object(policy, "load", side_effect=error), contextlib.redirect_stderr(output):
            self.assertEqual(policy.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {
            "status": "failed", "reason": "profile-observation-or-command-failed"})


if __name__ == "__main__":
    unittest.main()
