# SPDX-License-Identifier: BUSL-1.1
"""AUTH-01/09 owning callback reconciliation and fail-closed startup tests."""
import copy
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "keycloak-callback-policy.sh"
REDIRECTS = ["https://auth-pilot.renamed.example.local/oauth2/callback",
             "https://renamed.example.local/oauth2/callback",
             "https://renamed.example.local/oauth2/callback/*",
             "https://dashboard.example.com/oauth2/callback",
             "https://dashboard.example.com/oauth2/callback/*"]
ORIGINS = ["https://auth-pilot.renamed.example.local", "https://renamed.example.local",
           "https://dashboard.example.com"]
LOGOUT = "https://renamed.example.local/##https://dashboard.example.com/"

FAKE_CLI = r'''
import json,os,sys,time
from pathlib import Path
path=Path(os.environ["CALLBACK_FIXTURE"]); state=json.loads(path.read_text()); args=sys.argv[1:]
def flag(key): return args[args.index(key)+1]
def save(): path.write_text(json.dumps(state))
def fail(code=1):
    print("HTTP "+str(code)+" private-fixture-credential",file=sys.stderr); save(); sys.exit(1)
operation=args[0]; resource=args[1] if len(args)>1 else ""
field=flag("--fields") if "--fields" in args else ""
state.setdefault("calls",[]).append({"operation":operation,"resource":resource,"field":field})
failure=state.get("failure"); client=state["client"]
if state.get("roleFixture"):
    roles=state["roles"]
    if operation=="get" and resource=="clients":
        print("realm-fixture" if flag("--query")=="clientId=realm-management" else client["id"])
    elif operation=="get" and resource=="users": print("service-fixture")
    elif operation=="get" and resource.startswith("users/service-fixture/role-mappings/"):
        if failure=="role-read": fail(403)
        print("\n".join(state["originalRoles"] if state.get("staleRoleReadback") and state.get("roleWrites") else roles))
    elif operation=="update" and resource=="clients/"+client["id"]:
        state["clientUpdates"]=state.get("clientUpdates",0)+1
    elif operation in ("add-roles","remove-roles"):
        role=flag("--rolename")
        state.setdefault("roleWrites",[]).append({"operation":operation,"role":role})
        # Reproduce a denied redundant role mapping without granting authority.
        # All writes occur only in this synthetic fixture, never in Keycloak.
        if state.get("denyRoleWrites") or (operation=="add-roles" and role in roles): fail(403)
        if operation=="add-roles": roles.append(role)
        else: roles.remove(role)
    elif operation=="config": Path(flag("--config")).write_text("private-fixture-token")
    elif operation=="get" and (resource=="roles/magicstick-user" or resource=="identity-provider/instances"): print("{}")
    else: fail()
    save(); sys.exit(0)
if operation=="config":
    if flag("--realm")=="master": fail(401)
    if os.environ.get("BLOCK_CONFIG")=="1":
        gate=Path(os.environ["CALLBACK_GATE"]); gate.with_suffix(".entered").touch()
        deadline=time.monotonic()+8
        while not gate.exists():
            if time.monotonic()>deadline: fail(408)
            time.sleep(.02)
    Path(flag("--config")).write_text("private-fixture-token")
elif operation=="get" and resource=="clients":
    print(client["id"])
elif operation=="get" and resource=="clients/"+client["id"]:
    if failure=="read": fail(403)
    if field=="id,clientId":
        current="foreign-client" if failure=="foreign" or (failure=="identity-change" and state.get("updates")) else client["clientId"]
        print(client["id"]+","+current)
    elif field in ("redirectUris","webOrigins"):
        value=client[field]
        if failure=="stale" and field=="redirectUris": value=["https://example.local/oauth2/callback"]
        if failure=="extra-origin" and field=="webOrigins": value=value+["https://unrelated.example.com"]
        if state.get("rawField")==field: print(state["rawProjection"])
        else: print(json.dumps({field:value},indent=2))
    else: fail()
elif operation=="update" and resource=="clients/"+client["id"]:
    if failure in ("write","permission","auth"):
        fail(403 if failure=="permission" else 401 if failure=="auth" else 500)
    updates=[args[i+1] for i,v in enumerate(args) if v=="-s"]
    state.setdefault("updates",[]).append(updates)
    for update in updates:
        key,value=update.split("=",1)
        if key in ("redirectUris","webOrigins"):
            client[key]=list(dict.fromkeys(json.loads(value)))[::-1] # native Set order/dedup
        elif key=='attributes."post.logout.redirect.uris"': client["attributes"]["post.logout.redirect.uris"]=value
        else: fail()
else: fail()
save()
'''


class CallbackPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="magicstick-callbacks-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.state_path = self.directory / "state.json"
        self.cli = self.directory / "kcadm"
        self.cli.write_text("#!" + sys.executable + "\n" + FAKE_CLI)
        self.cli.chmod(0o700)
        self.initial = {"id": "client-fixture", "clientId": "magicstick-human-gateway-local",
                        "redirectUris": ["https://example.local/oauth2/callback"],
                        "webOrigins": ["https://example.local"], "enabled": True,
                        "secret": "private-fixture-credential", "attributes": {"unrelated": "keep"}}
        self.env = {**os.environ, "KCADM": str(self.cli), "CALLBACK_FIXTURE": str(self.state_path)}

    def invoke(self, *, failure=None, raw=None, reset=True, redirects=REDIRECTS, origins=ORIGINS):
        if reset:
            state = {"client": copy.deepcopy(self.initial), "failure": failure}
            if raw is not None:
                state.update(rawField="redirectUris", rawProjection=raw)
            self.state_path.write_text(json.dumps(state))
        result = subprocess.run(["/bin/sh", str(SCRIPT), str(self.directory / "reader.config"),
                                 self.initial["id"], json.dumps(redirects), json.dumps(origins), LOGOUT],
                                env=self.env, text=True, capture_output=True, timeout=15)
        state = json.loads(self.state_path.read_text())
        self.assertNotIn("private-fixture", result.stdout + result.stderr)
        return result, state

    def test_rename_replaces_old_urls_and_preserves_other_client_state(self):
        result, state = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified existing human gateway client", result.stdout)
        self.assertEqual(set(state["client"]["redirectUris"]), set(REDIRECTS))
        self.assertEqual(set(state["client"]["webOrigins"]), set(ORIGINS))
        self.assertEqual(state["client"]["attributes"], {"unrelated": "keep", "post.logout.redirect.uris": LOGOUT})
        for field in ("id", "clientId", "enabled", "secret"):
            self.assertEqual(state["client"][field], self.initial[field])
        self.assertEqual([c["operation"] for c in state["calls"]], ["get", "update", "get", "get", "get"])

    def test_repeat_is_idempotent_and_does_not_create_or_grant_anything(self):
        result, first = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        result, second = self.invoke(reset=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first["client"], second["client"])
        self.assertTrue(all(c["operation"] in {"get", "update"} for c in second["calls"]))

    def test_equal_local_public_hosts_accept_keycloaks_set_deduplication(self):
        result, _ = self.invoke(redirects=REDIRECTS + [REDIRECTS[0]], origins=ORIGINS + [ORIGINS[0]])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_errors_and_stale_readback_never_attest_success(self):
        for failure, reason in (("foreign", "IDENTITY"), ("identity-change", "IDENTITY"),
                                ("read", "IDENTITY"), ("write", "WRITE"),
                                ("permission", "WRITE_PERMISSION"), ("auth", "WRITE_AUTH"),
                                ("stale", "VERIFY_REDIRECTS"), ("extra-origin", "VERIFY_ORIGINS")):
            with self.subTest(failure=failure):
                result, state = self.invoke(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("sync: " + reason + ";", result.stderr)
                self.assertNotIn("verified existing", result.stdout)
                if failure in {"foreign", "read", "permission", "auth", "write"}:
                    self.assertNotIn("updates", state)

    def test_strict_readback_rejects_malformed_or_wider_projection(self):
        malformed = [
            "{}", "[]", "null", '{"redirectUris":"https://renamed.example.local/oauth2/callback"}',
            json.dumps({"redirectUris": REDIRECTS, "unexpected": "value"}),
            json.dumps({"wrongField": REDIRECTS}),
            json.dumps({"redirectUris": REDIRECTS + ["https://*.example.local/*"]}),
            json.dumps({"redirectUris": [",".join(REDIRECTS)]}),
            json.dumps({"redirectUris": [value.replace("/oauth2", " /oauth2") for value in REDIRECTS]}),
            json.dumps({"redirectUris": REDIRECTS}).replace("https://", "https:\\/\\/"),
            json.dumps({"redirectUris": REDIRECTS}) + " trailing",
            '{"redirectUris":[' + ",".join(json.dumps(x) for x in REDIRECTS) + ",]}",
            "x" * 8193,
        ]
        for raw in malformed:
            with self.subTest(raw=raw[:60]):
                result, _ = self.invoke(raw=raw)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("VERIFY_REDIRECTS", result.stderr)

    def test_expected_unknown_protocol_or_wildcard_authority_fails_before_write(self):
        for redirects in (["*"], ["http://example.local/oauth2/callback"],
                          ["https://*.example.local/oauth2/callback"], []):
            with self.subTest(redirects=redirects):
                result, state = self.invoke(redirects=redirects)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("CONFIG", result.stderr)
                self.assertEqual(state.get("calls", []), [])

    def hook(self, failed_helper=""):
        deployment = next(x for x in yaml.safe_load_all((ROOT / "keycloak.yaml").read_text()) if x["kind"] == "Deployment")
        script = deployment["spec"]["template"]["spec"]["containers"][0]["lifecycle"]["postStart"]["exec"]["command"][-1]
        self.assertNotIn("/proc/1/fd/", script)
        self.assertFalse(re.search(r"\)\s*&\s*$", script))
        script = script.replace("/opt/keycloak/bin/kcadm.sh", str(self.cli))
        script = script.replace("/opt/magicstick/keycloak-callback-policy.sh", str(SCRIPT))
        session = self.directory / "session-policy.sh"
        session.write_text("#!/bin/sh\nexit 0\n")
        script = script.replace("/opt/magicstick/keycloak-session-policy.sh", str(session))
        script = script.replace("/tmp/kcadm-client-sync.config", str(self.directory / "sync.config"))
        script = script.replace("${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}", "renamed.example.local")
        script = script.replace("${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}", "dashboard.example.com")
        helpers = ("sync_user_admin_client", "sync_federation_admin_client", "sync_kubernetes_client_and_groups", "sync_dashboard_cli_client", "sync_console_client")
        stubs = "\n".join(name + "() { return " + ("1" if name == failed_helper else "0") + "; }" for name in helpers)
        script = script.replace("attempt=0", stubs + "\nattempt=0", 1)
        script = script.replace('while [ "$attempt" -lt 120 ]', 'while [ "$attempt" -lt 2 ]').replace("sleep 5", "sleep 0")
        return script

    def test_whole_hook_propagates_each_helper_failure(self):
        for failed in ("sync_user_admin_client", "sync_federation_admin_client", "sync_kubernetes_client_and_groups", "sync_dashboard_cli_client", "sync_console_client"):
            with self.subTest(failed=failed):
                self.state_path.write_text(json.dumps({"client": self.initial}))
                result = subprocess.run(["/bin/sh", "-ec", self.hook(failed)],
                                        env={**self.env, "MAGICSTICK_SETUP_CLIENT_SECRET": "CHANGEME"},
                                        text=True, capture_output=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Synchronized scoped", result.stdout)
                self.assertIn("did not complete", result.stderr)
                stage = {"sync_user_admin_client": "USER_ADMIN",
                         "sync_federation_admin_client": "FEDERATION_ADMIN",
                         "sync_kubernetes_client_and_groups": "KUBERNETES",
                         "sync_dashboard_cli_client": "DASHBOARD_CLI",
                         "sync_console_client": "CONSOLE"}[failed]
                self.assertIn("Keycloak client sync: " + stage + " failed", result.stderr)
                self.assertFalse((self.directory / "sync.config").exists())

    def test_whole_hook_stops_retrying_after_elapsed_budget(self):
        self.state_path.write_text(json.dumps({"client": self.initial}))
        clock = self.directory / "clock"
        clock.write_text("#!" + sys.executable + "\nfrom pathlib import Path\n"
                         "p=Path(__file__).with_suffix('.count')\n"
                         "n=int(p.read_text()) if p.exists() else 0\n"
                         "p.write_text(str(n+1))\nprint(0 if n<2 else 601)\n")
        clock.chmod(0o700)
        source = self.hook("sync_user_admin_client").replace("date +%s", str(clock))
        result = subprocess.run(["/bin/sh", "-ec", source],
                                env={**self.env, "MAGICSTICK_SETUP_CLIENT_SECRET": "CHANGEME"},
                                text=True, capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not complete", result.stderr)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(len(state["updates"]), 1, "Elapsed budget must prevent the next otherwise allowed retry")

    def test_whole_hook_rejects_failed_or_unverified_callback_sync(self):
        for failure in ("permission", "stale", "identity-change"):
            with self.subTest(failure=failure):
                self.state_path.write_text(json.dumps({"client": self.initial, "failure": failure}))
                result = subprocess.run(["/bin/sh", "-ec", self.hook()],
                                        env={**self.env, "MAGICSTICK_SETUP_CLIENT_SECRET": "CHANGEME"},
                                        text=True, capture_output=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Synchronized scoped", result.stdout)
                self.assertNotIn("private-fixture", result.stdout + result.stderr)
                self.assertIn("did not complete", result.stderr)
                self.assertFalse((self.directory / "sync.config").exists())

    def test_whole_hook_waits_for_completion_instead_of_background_success(self):
        self.state_path.write_text(json.dumps({"client": self.initial}))
        gate = self.directory / "release"
        process = subprocess.Popen(["/bin/sh", "-ec", self.hook()],
                                   env={**self.env, "BLOCK_CONFIG": "1", "CALLBACK_GATE": str(gate),
                                        "MAGICSTICK_SETUP_CLIENT_SECRET": "CHANGEME"},
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not gate.with_suffix(".entered").exists() and time.monotonic() < deadline:
                if process.poll() is not None:
                    self.fail("PostStart returned before the real client sync started")
                time.sleep(.02)
            self.assertTrue(gate.with_suffix(".entered").exists())
            self.assertIsNone(process.poll(), "Container start must wait for sync completion")
            gate.touch()
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertIn("Synchronized scoped Keycloak clients", stdout)
            self.assertFalse((self.directory / "sync.config").exists())
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)

    def role_helper(self, *, federation=False, roles=None, denied=False, stale=False, failure=None):
        allowed = (["manage-identity-providers", "view-identity-providers", "view-realm"]
                   if federation else ["manage-users", "query-users", "view-users", "view-realm"])
        roles = list(allowed if roles is None else roles)
        self.state_path.write_text(json.dumps({"client": self.initial, "roleFixture": True,
            "roles": roles, "originalRoles": roles, "denyRoleWrites": denied,
            "staleRoleReadback": stale, "failure": failure}))
        deployment = next(x for x in yaml.safe_load_all((ROOT / "keycloak.yaml").read_text()) if x["kind"] == "Deployment")
        source = deployment["spec"]["template"]["spec"]["containers"][0]["lifecycle"]["postStart"]["exec"]["command"][-1]
        source = source.split("attempt=0", 1)[0]
        source = source.replace("/opt/keycloak/bin/kcadm.sh", str(self.cli))
        paths = {"/tmp/kcadm-client-sync.config": "sync.config",
                 "/tmp/kcadm-user-admin-check.config": "user.config",
                 "/tmp/kcadm-federation-admin-check.config": "federation.config"}
        for old, name in paths.items():
            source = source.replace(old, str(self.directory / name))
        (self.directory / "sync.config").write_text("private-fixture-token")
        helper = "sync_federation_admin_client" if federation else "sync_user_admin_client"
        # Execute the real helper bodies, role reads and final equality checks;
        # do not stub these helpers as the independent whole-hook tests do.
        source += f"\nif {helper}; then exit 0; else exit 1; fi\n)\n"
        result = subprocess.run(["/bin/sh", "-ec", source], env={**self.env,
            "MAGICSTICK_USER_ADMIN_CLIENT_SECRET": "CHANGEME",
            "MAGICSTICK_FEDERATION_ADMIN_CLIENT_SECRET": "CHANGEME"},
            capture_output=True, text=True, timeout=15)
        self.assertNotIn("private-fixture", result.stdout + result.stderr)
        for name in paths.values():
            self.assertFalse((self.directory / name).exists())
        return result, json.loads(self.state_path.read_text()), allowed

    def test_real_role_helpers_preserve_correct_mappings_without_role_writes(self):
        for federation in (False, True):
            with self.subTest(federation=federation):
                result, state, allowed = self.role_helper(federation=federation, denied=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(state["roles"], allowed)
                self.assertEqual(state.get("roleWrites", []), [])

    def test_real_role_helpers_write_only_differences_and_verify_exact_result(self):
        for federation in (False, True):
            allowed = (["manage-identity-providers", "view-identity-providers", "view-realm"]
                       if federation else ["manage-users", "query-users", "view-users", "view-realm"])
            for roles, expected in ((allowed[1:], [{"operation": "add-roles", "role": allowed[0]}]),
                                    (allowed + ["unexpected-admin"], [{"operation": "remove-roles", "role": "unexpected-admin"}])):
                with self.subTest(federation=federation, roles=roles):
                    result, state, _ = self.role_helper(federation=federation, roles=roles)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(state["roleWrites"], expected)
                    self.assertEqual(set(state["roles"]), set(allowed))

    def test_real_role_helpers_fail_on_denied_differences_or_failed_readback(self):
        for federation in (False, True):
            allowed = (["manage-identity-providers", "view-identity-providers", "view-realm"]
                       if federation else ["manage-users", "query-users", "view-users", "view-realm"])
            for options in ({"roles": allowed[1:], "denied": True},
                            {"roles": allowed + ["unexpected-admin"], "denied": True},
                            {"roles": allowed[1:], "stale": True}, {"failure": "role-read"}):
                with self.subTest(federation=federation, options=options):
                    result, _, _ = self.role_helper(federation=federation, **options)
                    self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
