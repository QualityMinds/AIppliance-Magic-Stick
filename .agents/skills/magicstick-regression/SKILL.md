---
name: magicstick-regression
description: "Maintain Magic Stick regression coverage when implementing new or changed behavior or fixing bugs; add, update or diagnose regression scenarios and their catalog/profile evidence. Use alongside the owning development skill. Not authority to deploy or run disruptive live tests."
---

# Maintain regression coverage

Read [project instructions](../../../AGENTS.md), the affected cases in the
[catalog](../../../docs/development/regression-test-catalog.md), and the
[file/selection/evidence policy](../../../docs/development/regression-test-concept.md#file-names-selection-and-evidence).
For execution, use the short [current runner guide](../../../docs/development/regression-remaining-p0.md);
consult the technical reference only for the adapter or operation being changed.

## Decide coverage in the same change

Trace the changed behavior through the real consumer: user action, API validation
and authorization, saved intent, reconciliation, status, runtime and routing as
affected. Map existing case IDs and required engine/vendor/role variants before
adding tests. Existing adequate coverage is a valid decision; name the tests and
explain why no extension is needed. Prose-only edits normally need no live tests.

For a bug fix, add a focused reproduction that would reject the defective behavior.
For a feature, test the new observable outcome, relevant rejection/failure paths
and compatibility with existing saved configurations and unaffected consumers.
Do not merely assert that a label, implementation string or manifest exists when
the requirement concerns behavior. Correct fixture/selector drift against the
real contract; do not change expectations just to make a product defect pass.

## Select the owning layers

- **U/C:** keep unit/component, API/controller/role and render-contract tests at
  their existing owning layer. Do not relocate them into a parallel test engine.
- **B:** update real built-frontend browser fixtures for changed forms, navigation,
  loading/errors, accessibility and permissions. A component test is not Chromium.
- **A/E:** update installed API and critical browser workflows when the actual
  intent-to-runtime or user interaction contract changes. Verify results through
  independent status/Kubernetes/inference observations, not HTTP acceptance alone.
- **O/N:** add operational/recovery or security/performance coverage when affected.
  Physical drills, hardware and external peers remain real prerequisites, not
  simulated proof of live acceptance.

Use the smallest meaningful combination, not every layer for every edit. Reuse
source catalogs/capability APIs for matrices; do not invent another hardware policy.
Installed-appliance regression does not cover USB/Subiquity/VM installation.

## Keep tests discoverable and evidence truthful

Name specs by function and layer, not phase. Preserve stable case IDs and explicit
variants. Register new specs in [selection profiles](../../../dashboard/apps/web/regression/profiles/selections.ts)
and update the relevant requirement matrix, case descriptions and catalog ledger
when their scope changes. Phase/priority are selection metadata, not filename rules.

Use the existing [evidence helpers](../../../dashboard/apps/web/regression/core/evidence.ts)
for completed case/variant/layer assertions. Do not credit every layer from one
passing fixture or relabel historical failed runs. Newly added coverage is
implemented, not live-accepted until an actual dated run proves its required tuples.
Keep experimental exclusions in the existing
[engine test policy](../../../dashboard/apps/web/regression/core/engine-policy.ts);
do not disable product features or suppress required cases to obtain a green run.

## Preserve the automatic runner and cleanup

Reuse existing foundation, ownership, borrowing, Lease and journal adapters for
live mutations. Record acknowledged resource identity before later assertions;
ensure failure teardown and UID/revision-bound cleanup restore only owned or
unchanged borrowed state. Cleanup failure must remain visible and fence later
writes; a matching name alone is not ownership.

Use the registered disposable lab and automatic fixture preparation. Do not add
per-test approval forms, hand-written input JSON, admin fallbacks or TLS bypasses.
Missing real prerequisites are **Blocked** with a reason and next action; product
assertion/API/timeout/harness errors are **Failed**. Independent selected cases
continue when safe. Keep raw credentials, journals and live artifacts private.

## Verify and hand off

Run affected owning tests, regression typecheck, harness selftests and relevant
fast/fixture selections in proportion to the change. Rebuild the Docker runner
after runner-source changes; an old local image does not test new code. For an
authorized live run, also verify the installed source/images match the behavior
under test. The current guide provides `all` and scoped phase selections without
repeated setup; do not automatically launch a full campaign for ordinary edits.

At handoff state: affected case IDs/variants/layers and tests added or updated
(or why existing coverage suffices); actual local/live results; any unimplemented,
blocked or unrun checks and next action. A green local suite is not appliance or
full hardware-matrix acceptance. Publication and deployment need their own scope.
