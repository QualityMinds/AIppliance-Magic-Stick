# SPDX-License-Identifier: BUSL-1.1
"""CHANNEL-06 owning render/selection checks; real API merging is separate."""
import json
from pathlib import Path
import re
import unittest

import jinja2
import yaml


ROLE = Path(__file__).resolve().parents[1]
ROOT = ROLE.parents[2]
TASKS = yaml.safe_load((ROLE / "tasks/main.yml").read_text())
BLOCK = next(task["block"] for task in TASKS
             if task["name"] == "Bootstrap Flux through public read-only path")
CONTENT = next(task["ansible.builtin.copy"]["content"] for task in BLOCK
               if task["name"] == "Render public Flux sync manifest")
FIELDS = {"branch", "tag", "semver", "name", "commit"}
COMMIT = "b" * 40


def render_source(kind="branch", ref="main", resolved=COMMIT):
    environment = jinja2.Environment(undefined=jinja2.StrictUndefined)
    environment.filters.update(to_json=json.dumps, combine=lambda a, b: {**a, **b},
                               regex_replace=lambda value, pattern, replacement: re.sub(pattern, replacement, value))
    values = {"magicstick_public_repo": "https://example.com/synthetic.git",
              "magicstick_public_ref_kind": kind, "magicstick_public_ref": ref,
              "flux_public_sync_path": "magic-cluster/flux/entrypoints/single-node"}
    if resolved is not None:
        values["magicstick_public_resolved_commit"] = resolved
    return list(yaml.safe_load_all(environment.from_string(CONTENT).render(**values)))


class PublicSourceReferenceTests(unittest.TestCase):
    def test_resolved_commit_explicitly_clears_every_obsolete_selector(self):
        for kind, ref in (("branch", "old-branch"), ("tag", "v1.0.0"),
                          ("commit", "a" * 40), ("semver", ">=1.0.0")):
            with self.subTest(kind=kind):
                source, sync = render_source(kind, ref)
                self.assertEqual(source["spec"]["ref"],
                                 {**dict.fromkeys(FIELDS), "commit": COMMIT})
                self.assertEqual(source["spec"]["url"], "https://example.com/synthetic.git")
                self.assertEqual(source["metadata"], {"name": "flux-system", "namespace": "flux-system"})
                self.assertEqual(sync["spec"]["sourceRef"], {"kind": "GitRepository", "name": "flux-system"})
                self.assertTrue(sync["spec"]["prune"])

    def test_legacy_bootstrap_without_resolved_commit_has_exactly_one_selector(self):
        for resolved in (None, ""):
            for kind, ref in (("branch", "feature/synthetic"), ("tag", "v1.0.0"),
                              ("commit", "a" * 40), ("semver", ">=1.0.0")):
                with self.subTest(kind=kind, resolved=resolved):
                    source, _ = render_source(kind, ref, resolved)
                    self.assertEqual(source["spec"]["ref"], {**dict.fromkeys(FIELDS), kind: ref})

    def test_canonical_apply_precedes_reconcile_and_is_not_a_delete_recreate(self):
        names = [task["name"] for task in BLOCK]
        apply = next(task for task in BLOCK if task["name"] == "Apply public Flux sync manifest")
        argv = apply["ansible.builtin.command"]["argv"]
        self.assertIn("apply", argv)
        self.assertNotIn("delete", argv)
        self.assertLess(names.index(apply["name"]), names.index("Reconcile public Flux source"))

    def test_native_api_counterexample_is_selected_by_both_existing_gateway_profiles(self):
        script = (ROOT / "magic-cluster/platform/identity/tests/gateway_policy_contract.py").read_text()
        workflow = yaml.safe_load((ROOT / ".github/workflows/public-release-checks.yml").read_text())
        self.assertIn("verify_source_ref_apply(call)", script)
        self.assertEqual(workflow["jobs"]["gateway-security"]["strategy"]["matrix"]["bootstrap"],
                         ["fresh", "upgrade"])


if __name__ == "__main__":
    unittest.main()
