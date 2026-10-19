"""Initial-setup re-entry against the real server and an isolated Kubernetes store."""
import base64
import copy
from http.cookies import SimpleCookie
import json
import pathlib
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch

import yaml

from test_setup_server import load_setup_module


setup = load_setup_module()


def secret(**values):
    return {"metadata": {"resourceVersion": "1"}, "data": {
        key: base64.b64encode(value.encode()).decode() for key, value in values.items()}}


class SetupSessionTests(unittest.TestCase):
    code = "abc234xy"

    def setUp(self):
        setup.FAILED_CLAIMS.clear()
        self.objects = {
            setup.SETUP_PATH: {"metadata": {"resourceVersion": "1"},
                "spec": {"installationId": "a1b2c3d4-1111-2222-3333-444444444444", "setupVersion": "v1"},
                "status": {"phase": "Pending"}},
            setup.CLAIM_SECRET_PATH: secret(**{"claim-sha256": setup.secret_hash(self.code)}),
        }
        self.calls = []
        self.patch = patch.object(setup, "kube_request", side_effect=self.kube)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(setup.FAILED_CLAIMS.clear)

    def kube(self, method, path, body=None, content_type="application/json", allow_missing=False):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == "GET":
            return copy.deepcopy(self.objects.get(path))
        if method == "DELETE":
            self.objects.pop(path, None)
            return {}
        if method == "PATCH" and path == setup.SETUP_PATH + "/status":
            self.objects[setup.SETUP_PATH]["status"].update(body["status"])
            return copy.deepcopy(self.objects[setup.SETUP_PATH])
        if method == "POST" and path == setup.SECRETS_PATH:
            path += "/" + body["metadata"]["name"]
            if path in self.objects:
                raise urllib.error.HTTPError(path, 409, "Conflict", {}, None)
            self.objects[path] = {"metadata": {**body["metadata"], "resourceVersion": "1"}, "data": {}}
        elif method == "PATCH" and path == setup.SESSION_SECRET_PATH:
            expected = self.objects[path]["metadata"]["resourceVersion"]
            if body["metadata"]["resourceVersion"] != expected:
                raise urllib.error.HTTPError(path, 409, "Conflict", {}, None)
            self.objects[path]["metadata"]["resourceVersion"] = str(int(expected) + 1)
        else:
            raise AssertionError("Unexpected Kubernetes operation: " + method + " " + path)
        self.objects[path]["data"].update({key: base64.b64encode(value.encode()).decode()
                                         for key, value in body.get("stringData", {}).items()})
        return copy.deepcopy(self.objects[path])

    def handler(self, payload=None, cookies="", path="/setup/api/claim"):
        handler = object.__new__(setup.Handler)
        handler.path = path
        handler.headers = {"Cookie": cookies}
        jar = SimpleCookie(cookies)
        if setup.CSRF_COOKIE in jar:
            handler.headers["X-MagicStick-CSRF"] = jar[setup.CSRF_COOKIE].value
        handler.client_address = ("192.0.2.10", 12345)
        handler.read_json = lambda: copy.deepcopy(payload or {})
        handler.responses = []
        handler.send_json = lambda status, body, cookies=None: handler.responses.append((status, body, cookies or []))
        return handler

    def claim(self, code=None):
        handler = self.handler({"claimToken": self.code if code is None else code})
        handler.claim()
        self.assertEqual(handler.responses[0][0], 200)
        return "; ".join(value.split(";", 1)[0] for value in handler.responses[0][2])

    def payload(self):
        return {"applianceName": "Example Appliance", "mdnsDomain": "example.local", "timezone": "UTC",
            "language": "en", "publicDomain": "", "username": "example-admin", "displayName": "Example Admin",
            "email": "admin@example.com", "password": "synthetic-password-only", "recoveryUsername": "recovery-a1b2c3d4",
            "recoveryCode": "synthetic-recovery-value-only"}

    def assert_session(self, cookies):
        jar, stored = setup.validate_session(cookies)
        setup.validate_csrf(jar, stored, jar[setup.CSRF_COOKIE].value)

    def test_same_console_code_opens_three_independent_browser_sessions(self):
        credentials = [self.claim() for _ in range(3)]
        self.assertEqual(len(set(credentials)), 3)
        for cookies in credentials:
            self.assert_session(cookies)
        self.assertEqual(setup.decode_secret(self.objects[setup.CLAIM_SECRET_PATH], "claim-sha256"), setup.secret_hash(self.code))
        self.assertEqual(self.objects[setup.SETUP_PATH]["status"]["phase"], "Claimed")

    def test_browser_sessions_survive_a_setup_server_restart(self):
        credentials = [self.claim(), self.claim()]
        restarted = load_setup_module()
        with patch.object(restarted, "kube_request", side_effect=self.kube):
            for cookies in credentials:
                jar, stored = restarted.validate_session(cookies)
                restarted.validate_csrf(jar, stored, jar[restarted.CSRF_COOKIE].value)

    def test_completion_server_replicas_cannot_overlap_during_upgrades(self):
        manifest = pathlib.Path(__file__).parents[1] / "setup-app.yaml"
        deployment = next(item for item in yaml.safe_load_all(manifest.read_text()) if item["kind"] == "Deployment")
        self.assertEqual(deployment["spec"]["replicas"], 1)
        self.assertEqual(deployment["spec"]["strategy"]["type"], "Recreate")

    def test_claim_does_not_erase_applying_failed_or_already_claimed_progress(self):
        for phase in ["Claimed", "Applying", "Failed"]:
            with self.subTest(phase=phase):
                self.objects[setup.SETUP_PATH]["status"] = {"phase": phase, "claimedAt": "2026-10-01T00:00:00Z",
                                                           "lastErrorCode": "dependency_http_error"}
                before = copy.deepcopy(self.objects[setup.SETUP_PATH])
                self.assert_session(self.claim())
                self.assertEqual(self.objects[setup.SETUP_PATH], before)

    def test_lost_claim_response_and_expired_cookie_do_not_consume_the_code(self):
        first = self.handler({"claimToken": self.code})
        first.send_json = lambda *args: (_ for _ in ()).throw(BrokenPipeError())
        first.do_POST()
        cookies = self.claim()
        with patch.object(setup.time, "time", return_value=time.time() + setup.SESSION_TTL_SECONDS + 1):
            with self.assertRaises(setup.ApiError) as expired:
                setup.validate_session(cookies)
            self.assertEqual(expired.exception.code, "session_expired")
            self.assert_session(self.claim())

    def test_wrong_code_is_still_rejected_but_cannot_lock_out_the_correct_code(self):
        for _ in range(7):
            handler = self.handler({"claimToken": "not-valid"})
            handler.do_POST()
            self.assertIn(handler.responses[-1][0], [403, 429])
        self.assertNotIn(setup.SESSION_SECRET_PATH, self.objects)
        self.assert_session(self.claim())

    def test_signed_session_and_csrf_cannot_be_tampered_or_mixed_between_browsers(self):
        first, second = SimpleCookie(self.claim()), SimpleCookie(self.claim())
        token = first[setup.SESSION_COOKIE].value
        for changed in [token[:-1] + ("a" if token[-1] != "a" else "b"), "v2.bad.invalid.hash.signature"]:
            with self.assertRaises(setup.ApiError):
                setup.validate_session(setup.SESSION_COOKIE + "=" + changed)
        cookies, stored = setup.validate_session(first.output(header="", sep=";").strip())
        for header in ["", second[setup.CSRF_COOKIE].value]:
            with self.assertRaises(setup.ApiError):
                setup.validate_csrf(cookies, stored, header)

    def test_legacy_browser_survives_another_browser_opening_setup(self):
        old_token, old_csrf = "synthetic-legacy-session", "synthetic-legacy-csrf"
        self.objects[setup.SETUP_PATH]["status"]["phase"] = "Claimed"
        self.objects[setup.SESSION_SECRET_PATH] = secret(**{"session-sha256": setup.secret_hash(old_token),
            "csrf-sha256": setup.secret_hash(old_csrf), "expires-at": str(time.time() + 1800)})
        newer = self.claim()
        self.assert_session(f"{setup.SESSION_COOKIE}={old_token}; {setup.CSRF_COOKIE}={old_csrf}")
        self.assert_session(newer)

    def test_concurrent_secret_creation_uses_the_winning_key_without_replacement(self):
        winner = secret(**{"signing-key": "synthetic-winning-signing-key"})
        original = self.kube
        def race(method, path, *args, **kwargs):
            if method == "POST" and path == setup.SECRETS_PATH:
                self.objects[setup.SESSION_SECRET_PATH] = winner
                raise urllib.error.HTTPError(path, 409, "Conflict", {}, None)
            return original(method, path, *args, **kwargs)
        with patch.object(setup, "kube_request", side_effect=race):
            self.assert_session(self.claim())
        self.assertEqual(setup.decode_secret(self.objects[setup.SESSION_SECRET_PATH], "signing-key"), "synthetic-winning-signing-key")

    def test_draft_patch_conflict_preserves_other_browser_sessions(self):
        cookies = self.claim()
        original = self.kube
        conflicted = False
        def race(method, path, *args, **kwargs):
            nonlocal conflicted
            if method == "PATCH" and path == setup.SESSION_SECRET_PATH and not conflicted:
                conflicted = True
                self.objects[path]["metadata"]["resourceVersion"] = "2"
                raise urllib.error.HTTPError(path, 409, "Conflict", {}, None)
            return original(method, path, *args, **kwargs)
        with patch.object(setup, "kube_request", side_effect=race):
            setup.ensure_session_secret(draft=self.payload())
        self.assertTrue(conflicted)
        self.assert_session(cookies)
        self.assertEqual(json.loads(setup.decode_secret(self.objects[setup.SESSION_SECRET_PATH], "draft-json"))["username"], "example-admin")

    def test_invalid_form_does_not_close_setup_or_invalidate_any_session(self):
        cookies = self.claim()
        values = {**self.payload(), "password": "short"}
        handler = self.handler(values, cookies, "/setup/api/complete")
        with patch.object(setup, "keycloak_token") as token:
            handler.do_POST()
        self.assertEqual(handler.responses[-1][0], 400)
        token.assert_not_called()
        self.assert_session(cookies)
        self.assert_session(self.claim())
        self.assertEqual(self.objects[setup.SETUP_PATH]["status"]["phase"], "Claimed")

    def test_partial_failure_preserves_non_secret_fields_and_allows_same_code_retry(self):
        first = self.claim()
        handler = self.handler(self.payload(), first, "/setup/api/complete")
        with (patch.object(setup, "update_settings"), patch.object(setup, "keycloak_token", return_value="synthetic-token"),
              patch.object(setup, "ensure_keycloak_user", side_effect=["primary-id", RuntimeError("controlled failure")])):
            handler.do_POST()
        self.assertEqual(handler.responses[-1][0], 500)
        self.assertEqual(self.objects[setup.SETUP_PATH]["status"]["phase"], "Failed")
        next_session = self.claim()
        self.assert_session(first)
        config_handler = self.handler(cookies=next_session, path="/setup/api/config")
        config_handler.do_GET()
        status, values, _ = config_handler.responses[-1]
        self.assertEqual(status, 200)
        self.assertEqual(values["username"], "example-admin")
        self.assertEqual(values["mdnsDomain"], "example.local")
        self.assertNotIn("password", values)
        self.assertNotIn("recoveryCode", values)
        saved = setup.decode_secret(self.objects[setup.SESSION_SECRET_PATH], "draft-json")
        self.assertNotIn(self.payload()["password"], saved)
        self.assertNotIn(self.payload()["recoveryCode"], saved)
        retry = self.handler(self.payload(), next_session, "/setup/api/complete")
        with (patch.object(setup, "update_settings"), patch.object(setup, "keycloak_token", return_value="synthetic-token"),
              patch.object(setup, "ensure_keycloak_user", return_value="synthetic-user")):
            retry.do_POST()
        self.assertEqual(retry.responses[-1][0], 200)
        self.assertEqual(self.objects[setup.SETUP_PATH]["status"]["phase"], "Completed")
        self.assertNotIn(setup.CLAIM_SECRET_PATH, self.objects)
        self.assertNotIn(setup.SESSION_SECRET_PATH, self.objects)
        for cookies in [first, next_session]:
            with self.assertRaises(setup.ApiError):
                setup.validate_session(cookies)

    def test_completed_and_legacy_installations_cannot_be_reopened_even_with_leftover_secrets(self):
        cookies = self.claim()
        for phase in ["Completed", "CompletedLegacy"]:
            with self.subTest(phase=phase):
                self.objects[setup.SETUP_PATH]["status"]["phase"] = phase
                before = copy.deepcopy(self.objects)
                claim = self.handler({"claimToken": self.code})
                claim.do_POST()
                complete = self.handler(self.payload(), cookies, "/setup/api/complete")
                complete.do_POST()
                self.assertEqual(claim.responses[-1][0], 409)
                self.assertEqual(complete.responses[-1][0], 409)
                self.assertEqual(self.objects, before)
                with self.assertRaises(setup.ApiError):
                    setup.validate_session(cookies)

    def test_disconnected_completion_and_delete_failures_do_not_reopen_finished_setup(self):
        handler = self.handler(self.payload(), self.claim(), "/setup/api/complete")
        def disconnected(*args):
            raise BrokenPipeError()
        handler.send_json = disconnected
        with (patch.object(setup, "update_settings"), patch.object(setup, "keycloak_token", return_value="synthetic-token"),
              patch.object(setup, "ensure_keycloak_user", return_value="synthetic-user"),
              patch.object(setup, "delete_resource", side_effect=RuntimeError("controlled delete failure"))):
            handler.do_POST()
        self.assertEqual(self.objects[setup.SETUP_PATH]["status"]["phase"], "Completed")
        rejected = self.handler({"claimToken": self.code})
        rejected.do_POST()
        self.assertEqual(rejected.responses[-1][0], 409)
        with patch.object(setup, "dashboard_handoff_ready", return_value=False):
            setup.reconcile_once()
        self.assertNotIn(setup.CLAIM_SECRET_PATH, self.objects)
        self.assertNotIn(setup.SESSION_SECRET_PATH, self.objects)

    def test_lost_completed_status_response_never_demotes_completed(self):
        handler = self.handler(self.payload(), self.claim(), "/setup/api/complete")
        original = self.kube
        def lost_response(method, path, body=None, *args, **kwargs):
            result = original(method, path, body, *args, **kwargs)
            if path == setup.SETUP_PATH + "/status" and (body or {}).get("status", {}).get("phase") == "Completed":
                raise urllib.error.HTTPError(path, 504, "Lost response", {}, None)
            return result
        with (patch.object(setup, "update_settings"), patch.object(setup, "keycloak_token", return_value="synthetic-token"),
              patch.object(setup, "ensure_keycloak_user", return_value="synthetic-user"),
              patch.object(setup, "kube_request", side_effect=lost_response)):
            handler.do_POST()
        self.assertEqual(self.objects[setup.SETUP_PATH]["status"]["phase"], "Completed")

    def test_two_completion_requests_create_only_one_pair_of_users(self):
        cookies = self.claim()
        first = self.handler(self.payload(), cookies, "/setup/api/complete")
        second = self.handler(self.payload(), self.claim(), "/setup/api/complete")
        entered, proceed = threading.Event(), threading.Event()
        def user(*args):
            entered.set()
            if not proceed.wait(5):
                raise RuntimeError("test did not release completion")
            return "synthetic-user"
        with (patch.object(setup, "update_settings"), patch.object(setup, "keycloak_token", return_value="synthetic-token"),
              patch.object(setup, "ensure_keycloak_user", side_effect=user) as create):
            workers = [threading.Thread(target=handler.do_POST) for handler in [first, second]]
            workers[0].start()
            try:
                self.assertTrue(entered.wait(5))
                workers[1].start()
            finally:
                proceed.set()
                for worker in workers:
                    if worker.ident is not None:
                        worker.join(5)
            self.assertTrue(all(not worker.is_alive() for worker in workers))
            self.assertEqual(create.call_count, 2)
        self.assertEqual(first.responses[-1][0], 200)
        self.assertEqual(second.responses[-1][0], 409)


if __name__ == "__main__":
    unittest.main()
