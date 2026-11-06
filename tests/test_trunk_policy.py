# SPDX-License-Identifier: BUSL-1.1
import copy
import unittest
from tools import trunk_policy as policy


class TrunkPolicyTests(unittest.TestCase):
    def setUp(self):
        self.rules = {}
        self.immutable = False
        self.writes = []
        self.admin = True
        self.actions = {"default_workflow_permissions": "read", "can_approve_pull_request_reviews": False}

    def api(self, path, method="GET", payload=None):
        if method != "GET": self.writes.append((path, method, payload))
        if path == policy.product.REPO:
            return {"full_name": policy.product.catalog.REPOSITORY, "default_branch": "main", "permissions": {"admin": self.admin}}
        if "/rulesets?" in path:
            return [{"id": number, "name": value["name"]} for number, value in self.rules.items()]
        if path.endswith("/rulesets"):
            number = len(self.rules) + 1; self.rules[number] = copy.deepcopy(payload); return {"id": number}
        if "/rulesets/" in path: return self.rules[int(path.rsplit("/", 1)[1])]
        if path.endswith("/immutable-releases"):
            if method == "PUT": self.immutable = True; return None
            return {"enabled": self.immutable}
        if path.endswith("/actions/permissions/workflow"):
            if method == "PUT": self.actions = copy.deepcopy(payload); return None
            return copy.deepcopy(self.actions)
        raise AssertionError(path)

    def test_default_is_read_only_and_apply_is_idempotent_with_no_bypass(self):
        plan = policy.inspect_or_apply(api=self.api)
        self.assertEqual(len(plan["rulesetsToCreate"]), 2); self.assertEqual(self.writes, [])
        self.assertTrue(policy.inspect_or_apply(apply=True, api=self.api)["applied"])
        self.assertTrue(self.immutable); self.assertEqual(len(self.writes), 3)
        self.assertEqual([r["bypass_actors"] for r in self.rules.values()], [[], []])
        policy.inspect_or_apply(apply=True, api=self.api)
        self.assertEqual(len(self.writes), 3)

    def test_unrelated_and_different_named_rules_are_never_deleted_or_overwritten(self):
        self.rules[1] = {"name": "Other owner policy", "enforcement": "active"}
        policy.inspect_or_apply(apply=True, api=self.api)
        self.assertEqual(self.rules[1], {"name": "Other owner policy", "enforcement": "active"})
        self.rules[2]["bypass_actors"] = [{"actor_type": "User", "actor_id": 1}]
        count = len(self.writes)
        with self.assertRaisesRegex(ValueError, "differs"): policy.inspect_or_apply(apply=True, api=self.api)
        self.assertEqual(len(self.writes), count)

    def test_tag_creation_remains_possible_but_updates_deletion_and_force_are_prohibited(self):
        tag = policy.policies()[1]
        self.assertEqual(tag["target"], "tag")
        self.assertEqual({r["type"] for r in tag["rules"]}, {"update", "deletion", "non_fast_forward"})
        self.assertNotIn("creation", str(tag["rules"]))

    def test_only_known_neutral_or_stricter_server_defaults_are_accepted(self):
        expected = policy.policies()[0]
        current = copy.deepcopy(expected)
        review = next(r for r in current['rules'] if r['type'] == 'pull_request')['parameters']
        review.update(dismissal_restriction={'allowed_actors': [], 'enabled': False},
                      required_reviewers=[], require_extra_approval_for_unattributed_changes=True)
        checks = next(r for r in current['rules'] if r['type'] == 'required_status_checks')['parameters']
        checks['do_not_enforce_on_create'] = False
        self.assertTrue(policy.equivalent(current, expected))
        checks['do_not_enforce_on_create'] = True
        self.assertFalse(policy.equivalent(current, expected))
        checks['do_not_enforce_on_create'] = False
        current['bypass_actors'] = [{'actor_id': 1, 'actor_type': 'User'}]
        self.assertFalse(policy.equivalent(current, expected))

    def test_pr_and_always_running_checks_are_required_without_forced_second_person(self):
        main = policy.policies()[0]
        rules = {r["type"]: r for r in main["rules"]}
        self.assertEqual(rules["pull_request"]["parameters"]["required_approving_review_count"], 0)
        checks = rules["required_status_checks"]["parameters"]
        self.assertTrue(checks["strict_required_status_checks_policy"])
        self.assertEqual({c["context"] for c in checks["required_status_checks"]}, policy.CONTEXTS)

    def test_no_admin_permission_or_unreadable_settings_cannot_be_treated_as_enabled(self):
        self.admin = False
        with self.assertRaisesRegex(ValueError, "administration"): policy.inspect_or_apply(apply=True, api=self.api)
        self.assertEqual(self.writes, [])
        with self.assertRaises(ValueError): policy.policies(2)

    def test_actions_pr_creation_requires_explicit_opt_in_and_preserves_default_read_access(self):
        policy.inspect_or_apply(apply=True, api=self.api)
        self.assertFalse(self.actions["can_approve_pull_request_reviews"])
        plan = policy.inspect_or_apply(allow_promotion_prs=True, api=self.api)
        self.assertTrue(plan["enableWorkflowPullRequests"])
        self.assertEqual(len(self.writes), 3)
        policy.inspect_or_apply(apply=True, allow_promotion_prs=True, api=self.api)
        self.assertEqual(self.actions, {"default_workflow_permissions": "read", "can_approve_pull_request_reviews": True})
        self.assertEqual(len(self.writes), 4)
        policy.inspect_or_apply(apply=True, allow_promotion_prs=True, api=self.api)
        self.assertEqual(len(self.writes), 4)


if __name__ == "__main__": unittest.main()
