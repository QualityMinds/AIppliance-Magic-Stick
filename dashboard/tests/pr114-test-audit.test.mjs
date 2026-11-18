// SPDX-License-Identifier: BUSL-1.1
import assert from "node:assert/strict";
import { test } from "node:test";
import { approval, checkScope, enforce } from "../tools/pr114-test-audit.mjs";

const scoped = {
  env: {
    GITHUB_REPOSITORY: "QualityMinds/AIppliance-Magic-Stick",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_JOB: "build",
    GITHUB_REF: approval.ref,
  },
  dispatched: "true",
  skipTests: "false",
  lockSha256: approval.lockSha256,
  now: Date.parse("2026-11-18T14:00:00Z"),
};
const finding = {
  github_advisory_id: approval.advisory,
  module_name: "picomatch",
  severity: "high",
  findings: [{ version: "4.0.7", paths: ["apps__web>vite>tinyglobby>picomatch"] }],
};
const report = (...findings) => ({
  status: Number(findings.some(x => x.severity === "high" || x.severity === "critical")),
  stdout: JSON.stringify({
    advisories: Object.fromEntries(findings.map((x, i) => [String(i), x])),
    metadata: {
      totalDependencies: 20,
      vulnerabilities: Object.fromEntries(["info", "low", "moderate", "high", "critical"]
        .map(key => [key, findings.filter(x => x.severity === key).length])),
    },
  }),
});

test("acceptance requires the named dispatch, branch, repository, graph and time", () => {
  assert.doesNotThrow(() => checkScope(scoped));
  for (const overrides of [
    { env: { ...scoped.env, GITHUB_REF: "refs/heads/main" } },
    { env: { ...scoped.env, GITHUB_REPOSITORY: "example/fork" } },
    { env: { ...scoped.env, GITHUB_EVENT_NAME: "pull_request" } },
    { env: { ...scoped.env, GITHUB_JOB: "advisories" } },
    { dispatched: false },
    { skipTests: true },
    { skipTests: "true" },
    { lockSha256: "another-lock" },
    { now: Date.parse(approval.expiresAt) },
  ]) {
    assert.throws(() => checkScope({ ...scoped, ...overrides }));
  }
});

test("the exact isolated test finding stays visible with a clean production audit", () => {
  assert.match(enforce({ production: report(), full: report(finding) }), /remains open/);
  assert.match(enforce({ production: report(), full: report() }), /No high or critical/);
  assert.throws(() => enforce({ production: report(finding), full: report(finding) }), /production graph/);
});

test("new, changed, critical and non-development findings remain blocked", () => {
  for (const full of [
    report(finding, { ...finding, github_advisory_id: "GHSA-abcd-2345-wxyz" }),
    report({ ...finding, severity: "critical" }),
    report({ ...finding, module_name: "another-package" }),
    report({ ...finding, findings: [{ ...finding.findings[0], version: "4.0.6" }] }),
    report({ ...finding, findings: [{ ...finding.findings[0], paths: ["apps__cli>workspace-runtime>picomatch"] }] }),
  ]) {
    assert.throws(() => enforce({ production: report(), full }), /outside/);
  }
});

test("registry errors, invalid JSON and inconsistent counts fail closed", () => {
  for (const full of [
    { status: 1, stdout: '{"error":{"code":"REGISTRY_UNAVAILABLE"}}' },
    { status: 0, stdout: "not JSON" },
    { ...report(finding), status: 0 },
    { ...report(), signal: "SIGTERM" },
    { ...report(), error: new Error("network") },
  ]) {
    assert.throws(() => enforce({ production: report(), full }));
  }
});
