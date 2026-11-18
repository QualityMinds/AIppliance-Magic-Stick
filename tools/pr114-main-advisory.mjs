// SPDX-License-Identifier: BUSL-1.1
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { approval, blockingAdvisories, enforce } from "../dashboard/tools/pr114-test-audit.mjs";

// Admission of this PR only. Preserve the ordinary audit on all Main pushes,
// scheduled runs, dispatches and other PRs. This is not product release evidence.
export const admission = Object.freeze({
  repository: approval.repository,
  number: 114,
  branch: "codex/fix-odysseus-guard-transport",
  base: "223f175c8920d20ed5030666e075698dd689cdc9",
  tested: "098a7ebf5ab5e60ae3e2c0c9b9e532d48e551046", // Images/test proof in run 44321832724.
  expiresAt: approval.expiresAt,
});

const oid = /^[a-f0-9]{40}$/;
const admissionFiles = new Set([
  ".github/workflows/dependency-security.yml",
  "docs/development/dashboard.md",
  "docs/development/regression-test-catalog.md",
  "tests/pr114-main-advisory.test.mjs",
  "tests/test_dependency_patches.py",
  "tools/pr114-main-advisory.mjs",
]);

export function eligible({ env, event, now }) {
  const pr = event?.pull_request;
  return Number.isFinite(now) && now < Date.parse(admission.expiresAt)
    && env.GITHUB_REPOSITORY?.toLowerCase() === admission.repository
    && env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_JOB === "advisories"
    && env.GITHUB_REF === "refs/pull/114/merge"
    && event?.number === admission.number && pr?.number === admission.number
    && pr.state === "open" && pr.draft === false
    && pr.base?.ref === "main" && pr.base.sha === admission.base
    && pr.head?.ref === admission.branch
    && pr.base?.repo?.full_name?.toLowerCase() === admission.repository
    && pr.head?.repo?.full_name?.toLowerCase() === admission.repository
    && oid.test(pr.head.sha ?? "") && oid.test(env.GITHUB_SHA ?? "");
}

export function exactTree({ headAndParents, checkoutSha, proposedHead, changes, lockSha256 }) {
  return headAndParents === [checkoutSha, admission.base, proposedHead].join(" ")
    && lockSha256 === approval.lockSha256 && changes.length > 0
    && changes.every(file => admissionFiles.has(file));
}

export function acceptedFinding(results) {
  enforce(results); // Reject transport, schema, production and other high/critical failures.
  return blockingAdvisories(results.full).length === 1;
}

function main() {
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const inWindow = () => eligible({ env, event, now: Date.now() });
  if (!inWindow()) {
    console.log("No current PR 114 Main admission; strict audit required.");
    return;
  }

  const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
  git("merge-base", "--is-ancestor", admission.tested, event.pull_request.head.sha);
  const exact = exactTree({
    headAndParents: git("rev-list", "--parents", "-n", "1", "HEAD").trim(),
    checkoutSha: env.GITHUB_SHA,
    proposedHead: event.pull_request.head.sha,
    changes: git("diff", "--name-only", "-z", admission.tested, "HEAD", "--").split("\0").filter(Boolean),
    lockSha256: createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
  });
  if (!exact) {
    console.log("PR 114 runtime tree, lockfile or merge parents differ from the admitted inputs; strict audit required.");
    return;
  }

  const audit = (...flags) => spawnSync("pnpm", ["audit", ...flags, "--json", "--audit-level", "high"], {
    encoding: "utf8", timeout: 120000, maxBuffer: 8_000_000,
  });
  if (!acceptedFinding({ production: audit("--prod"), full: audit() }) || !inWindow()) return;

  const note = "GHSA-fc5q-39xc-vjpf (picomatch 4.0.7) remains unresolved in the locked build/test graph. "
    + "Production audit has no high/critical findings. Risk accepted only for PR 114 admission to Main, "
    + "tested runtime source " + admission.tested + ", expiring " + admission.expiresAt
    + ". This is not a clean advisory result, installed SEC-03 evidence or release approval.";
  appendFileSync(env.GITHUB_STEP_SUMMARY, note + "\n");
  appendFileSync(env.GITHUB_OUTPUT, "accepted=true\n");
  console.log(note);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) { console.error("PR 114 advisory admission rejected:", error.message); process.exitCode = 1; }
}
