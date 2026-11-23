import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_user_admin_identity import keycloak_container, load_documents, realm_import


CONSOLE_CLIENT_ID = "magicstick-console"
CONSOLE_ACCOUNT = "service-account-magicstick-console"


def sync_script():
    return keycloak_container()["lifecycle"]["postStart"]["exec"]["command"][-1]


def console_sync_function():
    script = sync_script()
    start = script.index("sync_console_client() {")
    return script[start:script.index("sync_callbacks() {", start)]


FAKE_KCADM = r'''
import json,os,sys
from pathlib import Path
path=Path(os.environ["CONSOLE_FIXTURE"]); state=json.loads(path.read_text()); args=sys.argv[1:]
def flag(key): return args[args.index(key)+1]
def done(code=0): path.write_text(json.dumps(state)); sys.exit(code)
operation,resource=args[0],(args[1] if len(args)>1 and not args[1].startswith("-") else "")
settings=dict(item.split("=",1) for index,item in enumerate(args) if index and args[index-1]=="-s")
client=state.get("client")
if operation=="get" and resource=="clients":
    if client: print(client["id"])
elif operation=="get" and resource=="users":
    if client: print("console-account")
elif operation=="create" and resource=="clients":
    state["client"]={"id":"console-client","settings":settings,"attributes":{}}
elif operation=="update" and client and resource=="clients/"+client["id"]:
    for key,value in settings.items():
        if key.startswith("attributes."): client["attributes"][key.split(".",1)[1].strip('"')]=value
        else: client["settings"][key]=value
elif operation=="get" and client and resource=="clients/"+client["id"]:
    print(json.dumps({"id":client["id"],"attributes":client["attributes"]},indent=2))
elif operation=="add-roles":
    if state.get("denyGrant"): done(1)
    state["roles"]=sorted(set(state.get("roles",[]))|{args[i+1] for i,v in enumerate(args) if v=="--rolename"})
    state["grants"]=state.get("grants",0)+1
else: done(1)
done()
'''


class ConsoleSyncBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="magicstick-console-sync-")
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name)
        self.state_path = directory / "state.json"
        self.state_path.write_text("{}")
        cli = directory / "kcadm"
        cli.write_text("#!" + sys.executable + "\n" + FAKE_KCADM)
        cli.chmod(0o700)
        script = sync_script()
        helpers = script[script.index("client_uuid() {"):script.index("group_uuid() {")]
        self.script = (
            "config=" + str(directory / "sync.config") + "\n" + helpers + console_sync_function() + "sync_console_client\n"
        ).replace("/opt/keycloak/bin/kcadm.sh", str(cli))
        self.env = {**os.environ, "CONSOLE_FIXTURE": str(self.state_path), "MAGICSTICK_CONSOLE_CLIENT_SECRET": "CHANGEME"}

    def sync(self, **changes):
        state = json.loads(self.state_path.read_text())
        state.update(changes)
        self.state_path.write_text(json.dumps(state))
        result = subprocess.run(["/bin/sh", "-ec", self.script], env=self.env, text=True, capture_output=True, timeout=15)
        return result.returncode, json.loads(self.state_path.read_text())

    def test_upgrade_creates_the_client_and_grants_administrator_once(self):
        code, state = self.sync()

        self.assertEqual(code, 0)
        self.assertEqual(state["client"]["settings"]["serviceAccountsEnabled"], "true")
        self.assertEqual(state["client"]["settings"]["secret"], "CHANGEME")
        self.assertEqual(state["roles"], ["magicstick-admin", "magicstick-user"])
        self.assertEqual(state["client"]["attributes"], {"magicstick.console.defaultAccessApplied": "true"})

    def test_restart_keeps_an_administrators_opt_out(self):
        self.sync()

        code, state = self.sync(roles=[])  # An administrator switched automatic sign-in off.

        self.assertEqual(code, 0)
        self.assertEqual(state["roles"], [])
        self.assertEqual(state["grants"], 1)

    def test_failed_default_grant_is_reported_and_retried(self):
        code, state = self.sync(denyGrant=True)
        self.assertNotEqual(code, 0)
        self.assertEqual(state["client"]["attributes"], {})

        code, state = self.sync(denyGrant=False)
        self.assertEqual(code, 0)
        self.assertEqual(state["roles"], ["magicstick-admin", "magicstick-user"])


class ConsoleIdentityTests(unittest.TestCase):
    def test_fresh_realm_has_a_confidential_service_account_console_client(self):
        client = next(item for item in realm_import()["clients"] if item["clientId"] == CONSOLE_CLIENT_ID)

        self.assertFalse(client["publicClient"])
        self.assertTrue(client["serviceAccountsEnabled"])
        self.assertEqual(client["clientAuthenticatorType"], "client-secret")
        # "$$" keeps the placeholder away from Flux so Keycloak resolves it.
        self.assertEqual(client["secret"], "$${MAGICSTICK_CONSOLE_CLIENT_SECRET}")
        for flow in ("standardFlowEnabled", "implicitFlowEnabled", "directAccessGrantsEnabled"):
            self.assertFalse(client[flow], flow)
        self.assertEqual(client["redirectUris"], [])
        self.assertEqual(client["attributes"], {"magicstick.console.defaultAccessApplied": "true"})

    def test_fresh_console_account_defaults_to_dashboard_administrator_only(self):
        account = next(item for item in realm_import()["users"] if item["username"] == CONSOLE_ACCOUNT)

        self.assertEqual(account["serviceAccountClientId"], CONSOLE_CLIENT_ID)
        self.assertEqual(set(account["realmRoles"]), {"magicstick-user", "magicstick-admin"})
        # Dashboard roles only: no Keycloak administration and no Kubernetes groups.
        self.assertNotIn("clientRoles", account)
        self.assertNotIn("groups", account)

    def test_console_secret_is_generated_and_never_committed(self):
        secret = next(
            item for item in load_documents("secrets.yaml")
            if item["metadata"]["name"] == "magicstick-console-client"
        )
        annotations = secret["metadata"]["annotations"]

        self.assertEqual(annotations["secret-generator.v1.mittwald.de/autogenerate"], "client-secret")
        self.assertEqual(annotations["kustomize.toolkit.fluxcd.io/prune"], "disabled")
        self.assertEqual(secret["stringData"], {"client-id": CONSOLE_CLIENT_ID})
        env = {item["name"]: item for item in keycloak_container()["env"]}
        self.assertEqual(
            env["MAGICSTICK_CONSOLE_CLIENT_SECRET"]["valueFrom"]["secretKeyRef"],
            {"name": "magicstick-console-client", "key": "client-secret"},
        )

    def test_upgrade_reconciliation_creates_the_console_client(self):
        function = console_sync_function()

        self.assertIn("client_uuid magicstick-console", function)
        self.assertIn("serviceAccountsEnabled=true", function)
        self.assertIn("publicClient=false", function)
        self.assertIn('"secret=$MAGICSTICK_CONSOLE_CLIENT_SECRET"', function)
        self.assertIn("directAccessGrantsEnabled=false", function)
        self.assertIn(
            "sync_console_client || { echo 'Keycloak client sync: CONSOLE failed'",
            sync_script(),
        )
        # Flux substitutes ${...}; the hook must only use unbraced shell variables.
        self.assertNotIn("${", function)

    def test_default_administrator_access_is_granted_once_and_never_reasserted(self):
        function = console_sync_function()
        marker_check = function.index("defaultAccessApplied")
        early_return = function.index("return 0", marker_check)
        grant = function.index("add-roles")
        marker_write = function.index("defaultAccessApplied", grant)

        # An administrator's later downgrade or opt-out must survive restarts:
        # the marker short-circuits before roles are touched, and it is written
        # only after the grant succeeded so a failed grant is retried.
        self.assertLess(marker_check, early_return)
        self.assertLess(early_return, grant)
        self.assertLess(grant, marker_write)
        self.assertEqual(function.count("add-roles"), 1)
        self.assertIn("--rolename magicstick-admin", function)
        self.assertNotIn("remove-roles", function)
        self.assertNotIn("--cclientid", function)


if __name__ == "__main__":
    unittest.main()
