// SPDX-License-Identifier: BUSL-1.1
import assert from "node:assert/strict";
import { test } from "node:test";
import { approval } from "../dashboard/tools/pr114-test-audit.mjs";
import { acceptedFinding, admission, eligible, exactTree } from "../tools/pr114-main-advisory.mjs";

const repo = { full_name: "QualityMinds/AIppliance-Magic-Stick" };
const checkoutSha = "a".repeat(40), proposedHead = "b".repeat(40);
const scoped = {
  env: { GITHUB_REPOSITORY: repo.full_name, GITHUB_EVENT_NAME: "pull_request", GITHUB_JOB: "advisories",
    GITHUB_REF: "refs/pull/114/merge", GITHUB_SHA: checkoutSha },
  event: { number: 114, pull_request: { number: 114, state: "open", draft: false,
    head: { ref: admission.branch, sha: proposedHead, repo }, base: { ref: "main", sha: admission.base, repo } } },
  now: Date.parse("2026-11-18T14:00:00Z"),
};
const tree = {
  checkoutSha, proposedHead, headAndParents: [checkoutSha, admission.base, proposedHead].join(" "),
  changes: [".github/workflows/dependency-security.yml", "tools/pr114-main-advisory.mjs"],
  lockSha256: approval.lockSha256,
};

test("only the exact same-repository PR into the tested Main base before expiry is eligible", () => {
  assert.equal(eligible(scoped), true);
  for (const env of [
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
    { GITHUB_EVENT_NAME: "schedule" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/pull/115/merge" },
    { GITHUB_JOB: "pr114-unfiltered" },
    { GITHUB_SHA: "not-a-commit" },
  ]) assert.equal(eligible({ ...scoped, env: { ...scoped.env, ...env } }), false);
  const pr = scoped.event.pull_request;
  for (const pull_request of [
    { ...pr, number: 115 }, { ...pr, state: "closed" }, { ...pr, draft: true },
    { ...pr, head: { ...pr.head, ref: "different-branch" } },
    { ...pr, head: { ...pr.head, repo: { full_name: "fork/AIppliance-Magic-Stick" } } },
    { ...pr, base: { ...pr.base, sha: "c".repeat(40) } },
  ]) assert.equal(eligible({ ...scoped, event: { ...scoped.event, pull_request } }), false);
  assert.equal(eligible({ ...scoped, now: Date.parse(admission.expiresAt) }), false);
});

test("reusing the proven images requires checkout parents, lock checksum and policy-only changes", () => {
  assert.equal(exactTree(tree), true);
  for (const overrides of [
    { headAndParents: [checkoutSha, proposedHead, admission.base].join(" ") },
    { checkoutSha: "c".repeat(40) }, { proposedHead: "c".repeat(40) },
    { lockSha256: "not-the-reviewed-lockfile" }, { changes: [] },
    { changes: [...tree.changes, "dashboard/apps/cli/Dockerfile"] },
    { changes: [...tree.changes, "dashboard/pnpm-workspace.yaml"] },
    { changes: [...tree.changes, "dashboard/apps/web/regression/core/security-ci.ts"] },
    { changes: [...tree.changes, "magic-cluster/apps/regression/runtime.yaml"] },
  ]) assert.equal(exactTree({ ...tree, ...overrides }), false);
});

const finding = { github_advisory_id: approval.advisory, module_name: "picomatch", severity: "high",
  findings: [{ version: "4.0.7", paths: ["apps__cli>vitest>tinyglobby>picomatch"] }] };
const report = (...advisories) => ({
  status: Number(advisories.some(a => a.severity === "high" || a.severity === "critical")),
  stdout: JSON.stringify({ advisories: Object.fromEntries(advisories.map((a, i) => [i, a])),
    metadata: { totalDependencies: 20, vulnerabilities: Object.fromEntries(
      ["info", "low", "moderate", "high", "critical"].map(s => [s, advisories.filter(a => a.severity === s).length])) } }),
});

test("only the recorded test finding can be accepted; a clean scan needs no exception", () => {
  assert.equal(acceptedFinding({ production: report(), full: report(finding) }), true);
  assert.equal(acceptedFinding({ production: report(), full: report() }), false);
  for (const inputs of [
    { production: report(finding), full: report(finding) },
    { production: report(), full: report(finding, { ...finding, github_advisory_id: "GHSA-other-finding" }) },
    { production: report(), full: { status: 1, stdout: '{"error":{"code":"REGISTRY_UNAVAILABLE"}}' } },
  ]) assert.throws(() => acceptedFinding(inputs));
});
