# SPDX-License-Identifier: BUSL-1.1
"""CHANNEL-06 owning render/selection checks; real API merging is separate."""
import json
from pathlib import Path
import re
import unittest

import jinja2
from jinja2.nativetypes import NativeEnvironment
import yaml


ROLE = Path(__file__).resolve().parents[1]
ROOT = ROLE.parents[2]
TASKS = yaml.safe_load((ROLE / "tasks/main.yml").read_text())
BLOCK = next(task["block"] for task in TASKS
             if task["name"] == "Bootstrap Flux through public read-only path")
PUBLIC_TASKS = {task["name"]: task for task in BLOCK}
CONTENT = PUBLIC_TASKS["Render public Flux sync manifest"]["ansible.builtin.copy"]["content"]
FIELDS = {"branch", "tag", "semver", "name", "commit"}
COMMIT = "b" * 40
REPO = "https://example.com/synthetic.git"
ENVIRONMENT = NativeEnvironment(undefined=jinja2.StrictUndefined)
ENVIRONMENT.filters.update(
    to_json=json.dumps, from_json=json.loads, combine=lambda a, b: {**a, **b},
    regex_replace=lambda value, pattern, replacement: re.sub(pattern, replacement, value),
)


def render_source(kind="branch", ref="main", resolved=COMMIT):
    values = {"magicstick_public_repo": REPO,
              "magicstick_public_ref_kind": kind, "magicstick_public_ref": ref,
              "flux_public_sync_path": "magic-cluster/flux/entrypoints/single-node"}
    if resolved is not None:
        values["magicstick_public_resolved_commit"] = resolved
    pin = PUBLIC_TASKS["Determine the exact public Flux commit pin"]["ansible.builtin.set_fact"]
    values["flux_public_source_commit"] = ENVIRONMENT.from_string(pin["flux_public_source_commit"]).render(values)
    return list(yaml.safe_load_all(ENVIRONMENT.from_string(CONTENT).render(values)))


def recurring_commands(source, pin=COMMIT):
    """Evaluate the actual role's pin/cache predicates for a rendered source status."""
    values = {"flux_public_source_commit": pin, "magicstick_public_repo": REPO,
              "flux_public_source_observation": {"stdout": json.dumps(source)}}
    readiness = PUBLIC_TASKS["Check for a current pinned Flux artifact"]

    def selected(task):
        when = task.get("when", "true")
        return ENVIRONMENT.compile_expression(when, undefined_to_none=False)(values)

    if selected(readiness):
        for name, expression in readiness["vars"].items():
            values[name] = ENVIRONMENT.from_string(expression).render(values)
        for name, expression in readiness["ansible.builtin.set_fact"].items():
            values[name] = ENVIRONMENT.from_string(expression).render(values)

    return [task["ansible.builtin.command"]["argv"][2] for task in BLOCK
            if task.get("ansible.builtin.command", {}).get("argv", [])[:2] == ["flux", "reconcile"]
            and selected(task)]


def ready_source(revision):
    return {
        "metadata": {"generation": 4},
        "spec": {"url": REPO, "ref": {"commit": COMMIT}},
        "status": {
            "observedGeneration": 4,
            "conditions": [{"type": "Ready", "status": "True", "observedGeneration": 4}],
            "artifact": {"revision": revision, "digest": "sha256:" + "a" * 64,
                         "url": "http://source-controller.flux-system.svc.cluster.local/artifact.tar.gz"},
        },
    }


class PublicSourceReferenceTests(unittest.TestCase):
    def test_resolved_commit_explicitly_clears_every_obsolete_selector(self):
        for kind, ref in (("branch", "old-branch"), ("tag", "v1.0.0"),
                          ("commit", "a" * 40), ("semver", ">=1.0.0")):
            with self.subTest(kind=kind):
                source, sync = render_source(kind, ref)
                self.assertEqual(source["spec"]["ref"],
                                 {**dict.fromkeys(FIELDS), "commit": COMMIT})
                self.assertEqual(source["spec"]["url"], REPO)
                self.assertEqual(source["spec"]["interval"], "1h0m0s")
                self.assertEqual(source["metadata"], {"name": "flux-system", "namespace": "flux-system"})
                self.assertEqual(sync["spec"]["sourceRef"], {"kind": "GitRepository", "name": "flux-system"})
                self.assertEqual(sync["spec"]["interval"], "10m0s")
                self.assertTrue(sync["spec"]["prune"])

    def test_legacy_bootstrap_without_resolved_commit_has_exactly_one_selector(self):
        for resolved in (None, ""):
            for kind, ref in (("branch", "feature/synthetic"), ("tag", "v1.0.0"),
                              ("commit", "a" * 40), ("semver", ">=1.0.0")):
                with self.subTest(kind=kind, resolved=resolved):
                    source, _ = render_source(kind, ref, resolved)
                    self.assertEqual(source["spec"]["ref"], {**dict.fromkeys(FIELDS), kind: ref})
                    self.assertEqual(source["spec"]["interval"], "1h0m0s" if kind == "commit" else "1m0s")

    def test_current_ready_pin_only_reconciles_kustomization(self):
        for revision in ("sha1:" + COMMIT, "main@sha1:" + COMMIT):
            with self.subTest(revision=revision):
                self.assertEqual(recurring_commands(ready_source(revision)), ["kustomization"])

    def test_fresh_or_unusable_source_reconciles_git_once(self):
        variations = [
            (("status",), None),
            (("status", "artifact"), None),
            (("status", "artifact", "digest"), ""),
            (("status", "artifact", "url"), ""),
            (("status", "artifact", "revision"), "sha1:" + "a" * 40),
            (("status", "artifact", "revision"), "sha1:" + COMMIT + "f"),
            (("status", "conditions", 0, "status"), "False"),
            (("status", "conditions", 0, "observedGeneration"), 3),
            (("status", "observedGeneration"), 3),
            (("spec", "ref"), None),
            (("spec", "ref", "commit"), "a" * 40),
            (("spec", "url"), "https://example.com/other.git"),
            (("spec", "suspend"), True),
        ]
        for path, value in variations:
            with self.subTest(path=path, value=value):
                source = ready_source("sha1:" + COMMIT)
                cursor = source
                for key in path[:-1]:
                    cursor = cursor[key]
                cursor[path[-1]] = value
                self.assertEqual(recurring_commands(source), ["source", "kustomization"])

    def test_unpinned_legacy_source_still_reconciles_git(self):
        self.assertEqual(recurring_commands({}, pin=""), ["source", "kustomization"])

    def test_canonical_apply_precedes_reconcile_and_is_not_a_delete_recreate(self):
        names = [task["name"] for task in BLOCK]
        apply = next(task for task in BLOCK if task["name"] == "Apply public Flux sync manifest")
        argv = apply["ansible.builtin.command"]["argv"]
        self.assertIn("apply", argv)
        self.assertNotIn("delete", argv)
        self.assertLess(names.index(apply["name"]), names.index("Reconcile public Flux source"))
        self.assertLess(names.index("Reconcile public Flux source"),
                        names.index("Reconcile public Flux kustomization"))
        kustomization = PUBLIC_TASKS["Reconcile public Flux kustomization"]["ansible.builtin.command"]["argv"]
        self.assertNotIn("--with-source", kustomization)

    def test_native_api_counterexample_is_selected_by_both_existing_gateway_profiles(self):
        script = (ROOT / "magic-cluster/platform/identity/tests/gateway_policy_contract.py").read_text()
        workflow = yaml.safe_load((ROOT / ".github/workflows/public-release-checks.yml").read_text())
        self.assertIn("verify_source_ref_apply(call)", script)
        self.assertEqual(workflow["jobs"]["gateway-security"]["strategy"]["matrix"]["bootstrap"],
                         ["fresh", "upgrade"])


if __name__ == "__main__":
    unittest.main()
