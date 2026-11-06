# SPDX-License-Identifier: BUSL-1.1
"""Inspect/apply the narrowly scoped repository policy; never remove old rules."""
import argparse
import copy
import json
from tools import product_release as product

CONTEXTS = {"setup-upgrade", "release-checks", "advisories", "source", "CodeQL",
    "python-advisories (dashboard/apps/api/requirements.txt)",
    "python-advisories (magic-cluster/apps/ai/private-mesh/requirements.txt)"}


def policies(approvals=0):
    if type(approvals) is not int or approvals not in (0, 1):
        raise ValueError("Select zero or one required independent approval explicitly.")
    common = {"enforcement": "active", "bypass_actors": []}
    return [
        {**common, "name": "Magic Stick integration trunk", "target": "branch",
         "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
         "rules": [{"type": "deletion"}, {"type": "non_fast_forward"},
             {"type": "pull_request", "parameters": {"dismiss_stale_reviews_on_push": True,
                 "require_code_owner_review": False, "require_last_push_approval": False,
                 "required_approving_review_count": approvals, "required_review_thread_resolution": True,
                 "allowed_merge_methods": ["merge", "squash", "rebase"]}},
             {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": True,
                 "required_status_checks": [{"context": name, "integration_id": 57789 if name == "CodeQL" else 15368} for name in sorted(CONTEXTS)]}}]},
        {**common, "name": "Magic Stick immutable product tags", "target": "tag",
         "conditions": {"ref_name": {"include": ["refs/tags/v[0-9]*"], "exclude": []}},
         "rules": [{"type": "update"}, {"type": "deletion"}, {"type": "non_fast_forward"}]},
    ]


def equivalent(current, expected):
    """Accept only the known neutral/stricter GitHub response defaults."""
    value = copy.deepcopy(current)
    defaults = {
        "pull_request": {"dismissal_restriction": {"allowed_actors": [], "enabled": False},
                         "require_extra_approval_for_unattributed_changes": True, "required_reviewers": []},
        "required_status_checks": {"do_not_enforce_on_create": False},
    }
    for rule in value.get("rules", []):
        params = rule.get("parameters", {})
        for key, default in defaults.get(rule.get("type"), {}).items():
            if params.get(key) == default:
                params.pop(key)
    return all(value.get(key) == wanted for key, wanted in expected.items())


def inspect_or_apply(*, apply=False, approvals=0, allow_promotion_prs=False, api=product.github):
    repo = api(product.REPO)
    if repo.get("full_name") != product.catalog.REPOSITORY or repo.get("default_branch") != "main":
        raise ValueError("Repository identity/default branch differs; no settings were changed.")
    existing = api(product.REPO + "/rulesets?includes_parents=true&per_page=100")
    if not isinstance(existing, list) or len(existing) >= 100:
        raise ValueError("The complete existing repository policy could not be inspected.")
    wanted = policies(approvals)
    missing = []
    for expected in wanted:
        found = [r for r in existing if r.get("name") == expected["name"]]
        if len(found) > 1:
            raise ValueError("Ambiguous existing ruleset; inspect it manually. No overwrite.")
        if not found:
            missing.append(expected); continue
        current = api(product.REPO + "/rulesets/" + str(found[0]["id"]))
        if not equivalent(current, expected):
            raise ValueError("An existing named ruleset differs; it was not weakened or replaced.")
    immutable = api(product.REPO + "/immutable-releases")
    if not isinstance(immutable, dict) or type(immutable.get("enabled")) is not bool:
        raise ValueError("Immutable-release settings could not be read; no policy change.")
    actions = None
    if allow_promotion_prs:
        actions = api(product.REPO + "/actions/permissions/workflow")
        if (not isinstance(actions, dict) or actions.get("default_workflow_permissions") not in {"read", "write"}
                or type(actions.get("can_approve_pull_request_reviews")) is not bool):
            raise ValueError("Workflow PR permissions could not be read; no permission change.")
    result = {"rulesetsToCreate": missing, "enableImmutableReleases": not immutable["enabled"],
              "enableWorkflowPullRequests": bool(actions is not None and not actions["can_approve_pull_request_reviews"]), "applied": False}
    if not apply:
        return result
    if not repo.get("permissions", {}).get("admin"):
        raise ValueError("Repository administration permission is required; no bypass is provided.")
    for expected in missing:
        created = api(product.REPO + "/rulesets", method="POST", payload=expected)
        if not product.catalog._integer(created.get("id")):
            raise ValueError("Rule creation was not confirmed. Inspect before any retry.")
        current = api(product.REPO + "/rulesets/" + str(created["id"]))
        if not equivalent(current, expected):
            raise ValueError("The created protection differs; no destructive rollback or weakening was attempted.")
    if not immutable["enabled"]:
        api(product.REPO + "/immutable-releases", method="PUT")
        if api(product.REPO + "/immutable-releases").get("enabled") is not True:
            raise ValueError("Immutable release enablement was not confirmed.")
    if result["enableWorkflowPullRequests"]:
        # GitHub combines PR creation/review capability in this switch. Preserve
        # default token access; no workflow is granted automatic approval/merge.
        expected = {"default_workflow_permissions": actions["default_workflow_permissions"],
                    "can_approve_pull_request_reviews": True}
        api(product.REPO + "/actions/permissions/workflow", method="PUT", payload=expected)
        if api(product.REPO + "/actions/permissions/workflow") != expected:
            raise ValueError("Workflow PR permission enablement was not confirmed. Inspect it; no bypass was attempted.")
    result["applied"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--approvals", type=int, choices=(0, 1), default=0)
    parser.add_argument("--allow-promotion-prs", action="store_true",
                        help="Explicit owner opt-in to GitHub's combined Actions PR creation/review capability; default token access is preserved")
    args = parser.parse_args()
    try:
        print(json.dumps(inspect_or_apply(apply=args.apply, approvals=args.approvals,
                                         allow_promotion_prs=args.allow_promotion_prs), indent=2, sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, str(error) if isinstance(error, ValueError) else "Repository policy verification failed.\n")


if __name__ == "__main__": main()
