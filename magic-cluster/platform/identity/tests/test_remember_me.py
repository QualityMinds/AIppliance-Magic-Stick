"""AUTH-01/03/06 owning policy/migration counterexamples; no live credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "keycloak-session-policy.sh"
MARKER = "magicstickRememberMePolicyVersion"

FAKE_CLI = r'''
import json,os,sys
from pathlib import Path
path=Path(os.environ["SESSION_POLICY_FIXTURE"]); state=json.loads(path.read_text()); args=sys.argv[1:]
def save(): path.write_text(json.dumps(state))
def flag(name): return args[args.index(name)+1]
operation=args[0]; state.setdefault("calls",[]).append(operation); failure=state.get("failure")
if operation=="config":
    if failure=="auth": print("private-fixture-credential",file=sys.stderr); save(); sys.exit(1)
    Path(flag("--config")).write_text("private-fixture-token"); state["adminConfig"]=flag("--config")
    if failure=="changed": state["realm"]["ssoSessionIdleTimeoutRememberMe"]=123
elif operation=="get":
    if failure=="read": print("private-fixture-credential",file=sys.stderr); save(); sys.exit(1)
    field=flag("--fields")
    if field.startswith("attributes("):
        value=state["realm"].get("attributes",{}).get("magicstickRememberMePolicyVersion")
        # Jackson's pretty printer uses '{ }' for empty objects.
        print(json.dumps({"attributes":({"magicstickRememberMePolicyVersion":value} if value is not None else {})},indent=2).replace("{}","{ }"))
    elif failure=="malformed" and field=="accessTokenLifespan": print("300\n300")
    else:
        value=state["realm"].get(field)
        print(str(value).lower() if isinstance(value,bool) else value)
elif operation=="update":
    state.setdefault("updates",[]).append([args[i+1] for i,v in enumerate(args) if v=="-s"])
    if failure in ("write","permission"):
        print("HTTP 403 Forbidden private-fixture-credential" if failure=="permission" else "private-fixture-credential",file=sys.stderr)
        save(); sys.exit(1)
    for update in state["updates"][-1]:
        key,value=update.split("=",1); value=json.loads(value)
        if key.startswith("attributes."): state["realm"].setdefault("attributes",{})[key[11:]]=value
        elif failure!="verify": state["realm"][key]=value
    if failure=="lost-ack": save(); sys.exit(1)
else: sys.exit(3)
save()
'''


class RememberMePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="magicstick-session-policy-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.state_path = self.directory / "state.json"
        self.cli = self.directory / "kcadm"
        self.cli.write_text("#!" + sys.executable + "\n" + FAKE_CLI)
        self.cli.chmod(0o700)
        self.realm = {"id": "realm-fixture", "rememberMe": True, "accessTokenLifespan": 300,
                      "ssoSessionIdleTimeout": 1800, "ssoSessionMaxLifespan": 36000,
                      "ssoSessionIdleTimeoutRememberMe": 0, "ssoSessionMaxLifespanRememberMe": 0,
                      "attributes": {"unrelated": "keep"}}

    def invoke(self, *, failure=None, credentials=True, reset=True):
        if reset:
            self.state_path.write_text(json.dumps({"realm": self.realm, "failure": failure}))
        env = {**os.environ, "KCADM": str(self.cli), "SESSION_POLICY_FIXTURE": str(self.state_path),
               "KC_BOOTSTRAP_ADMIN_USERNAME": "fixture-admin", "KC_BOOTSTRAP_ADMIN_PASSWORD": "private-fixture-credential"}
        if not credentials:
            env.pop("KC_BOOTSTRAP_ADMIN_PASSWORD")
        result = subprocess.run(["/bin/sh", str(SCRIPT), str(self.directory / "reader.config")],
                                env=env, text=True, capture_output=True, timeout=20)
        state = json.loads(self.state_path.read_text())
        self.assertNotIn("private-fixture", result.stdout + result.stderr)
        if state.get("adminConfig"):
            self.assertFalse(Path(state["adminConfig"]).exists(), "Temporary bootstrap token must be removed")
        return result, state

    def test_fresh_defaults_keep_short_normal_sessions_and_opt_in_long_sessions(self):
        realm = json.loads(yaml.safe_load((ROOT / "keycloak-realm.yaml").read_text())["data"]["magicstick-realm.json"])
        self.assertIs(realm["rememberMe"], True)
        self.assertEqual({key: realm.get(key) for key in self.realm if key not in ("id", "attributes")},
                         {**{key: value for key, value in self.realm.items() if key not in ("id", "attributes")},
                          "ssoSessionIdleTimeoutRememberMe": 604800, "ssoSessionMaxLifespanRememberMe": 2592000})
        self.assertEqual(realm["attributes"][MARKER], "1")

    def test_old_defaults_are_migrated_and_unrelated_attributes_are_preserved(self):
        result, state = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("version 1 applied", result.stdout)
        self.assertEqual(state["realm"], {**self.realm, "ssoSessionIdleTimeoutRememberMe": 604800,
            "ssoSessionMaxLifespanRememberMe": 2592000, "attributes": {"unrelated": "keep", MARKER: "1"}})
        self.assertEqual(len(state["updates"]), 1)

    def test_repeat_needs_no_bootstrap_credentials_and_does_not_write_again(self):
        self.assertEqual(self.invoke()[0].returncode, 0)
        result, state = self.invoke(reset=False, credentials=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(state["updates"]), 1)

    def test_custom_or_disabled_policies_are_reviewed_without_changing_any_session_value(self):
        original = dict(self.realm)
        for patch in ({"ssoSessionIdleTimeoutRememberMe": 123}, {"ssoSessionMaxLifespanRememberMe": 999},
                      {"rememberMe": False}, {"ssoSessionIdleTimeout": 60}, {"accessTokenLifespan": 100}):
            with self.subTest(patch=patch):
                self.realm = {**original, **patch}
                result, state = self.invoke()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("custom session settings preserved", result.stdout)
                self.assertEqual({k:v for k,v in state["realm"].items() if k!="attributes"},
                                 {k:v for k,v in self.realm.items() if k!="attributes"})
                self.assertEqual(state["updates"], [[f'attributes.{MARKER}="1"']])

    def test_missing_or_denied_bootstrap_authority_never_changes_policy(self):
        for credentials, failure in ((False, None), (True, "auth")):
            with self.subTest(credentials=credentials):
                result, state = self.invoke(credentials=credentials, failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("migration: AUTH", result.stderr)
                self.assertEqual(state["realm"], self.realm)
                self.assertFalse(state.get("updates"))

    def test_read_malformed_unknown_version_and_changed_policy_fail_without_writes(self):
        for failure in ("read", "malformed", "changed"):
            with self.subTest(failure=failure):
                result, state = self.invoke(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(state.get("updates"))
        self.realm["attributes"][MARKER] = "2"
        result, state = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("migration: VERSION", result.stderr)
        self.assertEqual(state["calls"], ["get"])

    def test_write_or_verification_failure_cannot_report_success(self):
        for failure in ("write", "permission", "verify"):
            with self.subTest(failure=failure):
                result, _ = self.invoke(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("version 1 applied", result.stdout)
                self.assertIn("migration: " + failure.upper(), result.stderr)

    def test_marker_with_whitespace_or_an_unknown_value_is_not_normalized_into_version_one(self):
        for value in (" 1 ", "2", "", "1\n", "1 "):
            with self.subTest(value=value):
                self.realm["attributes"][MARKER] = value
                result, state = self.invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("migration: VERSION", result.stderr)
                self.assertFalse(state.get("updates"))

    def test_lost_write_acknowledgement_is_safe_to_retry(self):
        result, state = self.invoke(failure="lost-ack")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("migration: WRITE", result.stderr)
        self.assertEqual(state["realm"]["attributes"][MARKER], "1")
        result, state = self.invoke(reset=False, credentials=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(state["updates"]), 1)

    def test_deployment_runs_the_mounted_migration_in_both_existing_startup_paths(self):
        documents = list(yaml.safe_load_all((ROOT / "keycloak.yaml").read_text()))
        deployment = next(x for x in documents if x["kind"] == "Deployment")
        pod = deployment["spec"]["template"]["spec"]
        container = pod["containers"][0]
        script = container["lifecycle"]["postStart"]["exec"]["command"][-1]
        self.assertEqual(script.count('/bin/sh /opt/magicstick/keycloak-session-policy.sh "$config" || exit 1'), 2)
        self.assertNotIn("--rolename manage-realm", script)
        self.assertIn({"name": "session-policy", "mountPath": "/opt/magicstick", "readOnly": True}, container["volumeMounts"])
        self.assertIn({"name": "session-policy", "configMap": {"name": "keycloak-session-policy"}}, pod["volumes"])
        self.assertIn("keycloak-session-policy.sh", (ROOT / "kustomization.yaml").read_text())
