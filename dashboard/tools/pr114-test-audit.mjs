// SPDX-License-Identifier: BUSL-1.1
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const approval = Object.freeze({
  repository: "qualityminds/aippliance-magic-stick",
  ref: "refs/heads/codex/fix-odysseus-guard-transport",
  lockSha256: "38a1bd5f772dac2187070684ce761dd65c1203d585879a6f08a36c474c61f04a",
  expiresAt: "2026-11-19T13:55:00Z",
  advisory: "GHSA-fc5q-39xc-vjpf",
});

const severities = ["info", "low", "moderate", "high", "critical"];
const devEntrypoints = new Set([
  "apps__cli>vite", "apps__cli>vitest", "apps__web>@vitejs/plugin-react",
  "apps__web>vite", "apps__web>vitest",
]);

export function checkScope({ env, dispatched, skipTests, lockSha256, now }) {
  if (env.GITHUB_REPOSITORY?.toLowerCase() !== approval.repository
      || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_JOB !== "build"
      || env.GITHUB_REF !== approval.ref || ![true, "true"].includes(dispatched)) {
    throw new Error("Test acceptance applies only to the explicitly requested PR #114 candidate build.");
  }
  if (![undefined, false, "false"].includes(skipTests)) {
    throw new Error("PR #114 test acceptance requires the full candidate test suite.");
  }
  if (!Number.isFinite(now) || now >= Date.parse(approval.expiresAt)) {
    throw new Error("PR #114 test acceptance has expired.");
  }
  if (lockSha256 !== approval.lockSha256) {
    throw new Error("PR #114 test acceptance does not cover this dependency graph.");
  }
}

export function blockingAdvisories(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error("Registry audit did not complete normally.");
  }
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error("Registry audit returned invalid JSON."); }
  const counts = report?.metadata?.vulnerabilities;
  const advisories = report?.advisories;
  if (!counts || !advisories || typeof advisories !== "object" || Array.isArray(advisories)
      || !severities.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
      || !Number.isSafeInteger(report.metadata.totalDependencies) || report.metadata.totalDependencies <= 0) {
    throw new Error("Registry audit returned an incomplete report.");
  }
  const observed = Object.values(advisories);
  if (!observed.every(finding => severities.includes(finding?.severity))) {
    throw new Error("Registry audit returned an unknown severity.");
  }
  const blocked = observed.filter(x => x.severity === "high" || x.severity === "critical");
  if (severities.slice(-2).some(key => counts[key] !== blocked.filter(x => x.severity === key).length)
      || result.status !== Number(blocked.length > 0)) {
    throw new Error("Registry audit counts or exit status are inconsistent.");
  }
  return blocked;
}

function coveredDevelopmentFinding(advisory) {
  return advisory.github_advisory_id === approval.advisory
    && advisory.module_name === "picomatch" && advisory.severity === "high"
    && Array.isArray(advisory.findings) && advisory.findings.length > 0
    && advisory.findings.every(finding => (
      finding?.version === "4.0.7" && Array.isArray(finding.paths) && finding.paths.length > 0
      && finding.paths.every(path => {
        if (typeof path !== "string") return false;
        const parts = path.split(">");
        return parts.length >= 3 && parts.at(-1) === "picomatch"
          && devEntrypoints.has(parts.slice(0, 2).join(">"));
      })
    ));
}

export function enforce({ production, full }) {
  if (blockingAdvisories(production).length) {
    throw new Error("The production graph has a high or critical advisory; no test acceptance applies.");
  }
  const blocked = blockingAdvisories(full);
  if (blocked.length === 0) return "No high or critical registry advisories.";
  if (blocked.length !== 1 || !coveredDevelopmentFinding(blocked[0])) {
    throw new Error("The full audit contains a finding outside PR #114's exact test acceptance.");
  }
  return approval.advisory + " remains open for picomatch 4.0.7. "
    + "Accepted only for this PR #114 isolated candidate build; production graph clean. "
    + "Expires " + approval.expiresAt + ". The required merge advisory check remains unchanged.";
}

function main() {
  const inputs = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).inputs ?? {};
  const lockSha256 = createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex");
  const check = () => checkScope({ env: process.env, dispatched: inputs.accept_pr114_test_advisory,
    skipTests: inputs.skip_tests, lockSha256, now: Date.now() });
  check();
  const audit = (...flags) => spawnSync("pnpm", ["audit", ...flags, "--json", "--audit-level", "high"], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 8_000_000,
  });
  const decision = enforce({ production: audit("--prod"), full: audit() });
  check();
  process.stdout.write(decision + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}
