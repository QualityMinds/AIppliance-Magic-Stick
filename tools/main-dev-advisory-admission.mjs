// SPDX-License-Identifier: BUSL-1.1
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { approval } from "../dashboard/tools/pr114-test-audit.mjs";
import { acceptedFinding } from "./pr114-main-advisory.mjs";

export const development = Object.freeze({
  startingMain: "34a2343e98856c0f12cda8748c149897c5950c0e",
  policyBranch: "codex/main-dev-picomatch-34a2343",
  expiry: approval.expiresAt,
  repository: approval.repository,
});
const sha = /^[a-f0-9]{40}$/;
const policyPaths = [
  ".github/workflows/build-dashboard-image.yml",
  ".github/workflows/dashboard-browser-smoke.yml",
  ".github/workflows/dependency-security.yml",
  "docs/development/dashboard.md",
  "docs/development/regression-test-catalog.md",
  "tests/main-dev-advisory-admission.test.mjs",
  "tests/test_dependency_patches.py",
  "tools/main-dev-advisory-admission.mjs",
];
const imageRepository = {
  "magic-cluster/apps/dashboard/deployment.yaml": "magicstick-dashboard:sha-",
  "magic-cluster/apps/dashboard/api-deployment.yaml": "magicstick-dashboard:api-sha-",
  "magic-host/roles/dashboard-console/defaults/main.yml": "magicstick-dashboard:cli-sha-",
  "magic-cluster/apps/regression/runtime.yaml": "magicstick-regression:sha-",
};
const pinPaths = [...Object.keys(imageRepository), "licenses/dependency-inventory.json"];
const exactPaths = (actual, expected) => actual.length === expected.length && expected.every(path => actual.includes(path));
const isRepository = value => typeof value === "string" && value.toLowerCase() === development.repository;
const within = now => Number.isFinite(now) && now < Date.parse(development.expiry);

// Event identities are only a prerequisite. The full merge tree, its parents
// and the original native publishing work are independently checked below.
export function selectContext({ env, event, now }) {
  if (!within(now) || !isRepository(env.GITHUB_REPOSITORY) || !isRepository(event?.repository?.full_name)
      || env.GITHUB_JOB !== "advisories" || !sha.test(env.GITHUB_SHA ?? "")) return null;
  const head = env.GITHUB_SHA;
  if (env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main" && event.ref === env.GITHUB_REF
      && event.after === head && sha.test(event.before ?? "") && event.deleted === false && event.forced === false) {
    return { head, base: event.before, kind: event.before === development.startingMain ? "policy" : "pins" };
  }
  const pr = event.pull_request;
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !Number.isSafeInteger(event.number) || event.number <= 0
      || env.GITHUB_REF !== "refs/pull/" + event.number + "/merge" || event.number !== pr?.number
      || pr.state !== "open" || pr.draft !== false || pr.base?.ref !== "main"
      || !isRepository(pr.base?.repo?.full_name) || !isRepository(pr.head?.repo?.full_name)
      || !sha.test(pr.base.sha ?? "") || !sha.test(pr.head.sha ?? "")) return null;
  const base = pr.base.sha, incoming = pr.head.sha;
  if (base === development.startingMain && pr.head.ref === development.policyBranch)
    return { head, base, incoming, kind: "policy" };
  if (base !== development.startingMain && pr.user?.login === "github-actions[bot]"
      && pr.head.ref === "codex/promote-images-" + base.slice(0, 12))
    return { head, base, incoming, kind: "pins" };
  return null;
}

export function verifyTree(context, git) {
  const { head, base, incoming, kind } = context;
  const parents = git.parents(head);
  if (parents.length !== 2 || parents[0] !== base || (incoming && parents[1] !== incoming)) return false;
  if (kind === "policy") {
    return base === development.startingMain && exactPaths(git.changed(base, head), policyPaths);
  }
  // Only the one direct, policy-only Main successor may own the new pins.
  // A later Main revision or a different runtime change needs a fresh decision.
  const baseParents = git.parents(base);
  if (baseParents.length !== 2 || baseParents[0] !== development.startingMain
      || !exactPaths(git.changed(development.startingMain, base), policyPaths)
      || !exactPaths(git.changed(base, head), pinPaths)) return false;
  for (const [path, repository] of Object.entries(imageRepository)) {
    const marker = "ghcr.io/qualityminds/" + repository + base + "@sha256:";
    const lines = git.contents(head, path).split("\n").filter(line => line.includes(marker));
    if (lines.length !== 1 || !/^[a-f0-9]{64}(?:"|\s|$)/.test(lines[0].split(marker)[1])) return false;
  }
  return git.contents(head, "magic-cluster/apps/regression/runtime.yaml").includes('sourceRevision: "' + base + '"');
}

function main() {
  const env = process.env;
  const context = selectContext({ env, event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")), now: Date.now() });
  if (!context) return;
  const run = (program, args, timeout = 10000) => execFileSync(program, args, {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"],
  });
  const git = (...args) => run("git", args);
  const exact = git("rev-parse", "HEAD").trim() === context.head &&
    createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex") === approval.lockSha256 &&
    verifyTree(context, {
      parents: commit => git("rev-list", "--parents", "-n", "1", commit).trim().split(" ").slice(1),
      changed: (a, b) => git("diff", "--name-only", "-z", a, b, "--").split("\0").filter(Boolean),
      contents: (rev, path) => git("show", rev + ":" + path),
    });
  if (!exact) {
    console.log("Main-dev tree, dependency graph or image sources differ from the reviewed scope; strict audit required.");
    return;
  }
  if (context.kind === "pins") {
    const canonical = run("python3", ["../tools/trunk_promotion.py", "--pin-only", "--base", context.base]);
    if (canonical.trim() !== "pin_only=true") throw new Error("The candidate is not a canonical pin-only promotion.");
    run("python3", ["../tools/trunk_promotion.py", "--verify-pins"], 120000);
  }
  const audit = (...flags) => spawnSync("pnpm", ["audit", ...flags, "--json", "--audit-level", "high"], {
    encoding: "utf8", timeout: 120000, maxBuffer: 8_000_000,
  });
  if (!acceptedFinding({ production: audit("--prod"), full: audit() }) || !within(Date.now())) return;
  const note = approval.advisory + " (picomatch 4.0.7) remains open. No high/critical production findings. "
    + "Accepted only for the verified Main-dev " + context.kind + " tree " + context.head + " until "
    + development.expiry + ". Unfiltered audit still runs and blocks release/installed security qualification.";
  appendFileSync(env.GITHUB_STEP_SUMMARY, note + "\n");
  appendFileSync(env.GITHUB_OUTPUT, "accepted=true\n");
  console.log(note);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) { console.error("Main-dev advisory admission rejected:", error.message); process.exitCode = 1; }
}
