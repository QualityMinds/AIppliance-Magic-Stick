// SPDX-License-Identifier: BUSL-1.1
import assert from "node:assert/strict";
import { test } from "node:test";
import { development, selectContext, verifyTree } from "../tools/main-dev-advisory-admission.mjs";

const repo = { full_name: "QualityMinds/AIppliance-Magic-Stick" };
const origin = development.startingMain, incoming = "a".repeat(40), head = "b".repeat(40);
const newerMain = "c".repeat(40);
const now = Date.parse("2026-11-18T16:00:00Z");
const env = { GITHUB_REPOSITORY: repo.full_name, GITHUB_JOB: "advisories", GITHUB_SHA: head };
const prEnv = { ...env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/201/merge" };
const pull = { number: 201, state: "open", draft: false, user: { login: "example" },
  head: { ref: development.policyBranch, sha: incoming, repo }, base: { ref: "main", sha: origin, repo } };
const pr = { number: 201, repository: repo, pull_request: pull };
const bot = { ...pr, pull_request: { ...pull, user: { login: "github-actions[bot]" },
  head: { ...pull.head, ref: "codex/promote-images-" + newerMain.slice(0, 12) },
  base: { ...pull.base, sha: newerMain } } };
const pushEnv = { ...env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" };
const push = { repository: repo, ref: pushEnv.GITHUB_REF, before: newerMain, after: head, deleted: false, forced: false };

test("only the named policy PR, immediately following bot pin PR and Main pushes can be considered", () => {
  assert.deepEqual(selectContext({env: prEnv, event: pr, now}), {head, base: origin, incoming, kind: "policy"});
  assert.deepEqual(selectContext({env: prEnv, event: bot, now}), {head, base: newerMain, incoming, kind: "pins"});
  assert.deepEqual(selectContext({env: pushEnv, event: push, now}), {head, base: newerMain, kind: "pins"});
  assert.equal(selectContext({env: pushEnv, event: {...push, before: origin}, now}).kind, "policy");
  for (const changed of [
    {event: {...bot, pull_request: {...bot.pull_request, user: {login: "example"}}}},
    {event: {...pr, pull_request: {...pull, head: {...pull.head, repo: {full_name: "fork/project"}}}}},
    {event: {...pr, pull_request: {...pull, draft: true}}},
    {event: {...pr, pull_request: {...pull, base: {...pull.base, sha: newerMain}}}},
    {env: {...prEnv, GITHUB_REF: "refs/pull/202/merge"}},
    {env: {...prEnv, GITHUB_JOB: "pr114-unfiltered"}},
    {env: {...prEnv, GITHUB_EVENT_NAME: "workflow_dispatch"}},
    {env: {...prEnv, GITHUB_EVENT_NAME: "schedule"}},
    {now: Date.parse(development.expiry)},
  ]) {
    assert.equal(selectContext({env: prEnv, event: pr, now, ...changed}), null);
  }
  assert.equal(selectContext({env: pushEnv, event: {...push, forced: true}, now}), null);
  assert.equal(selectContext({env: pushEnv, event: {...push, after: incoming}, now}), null);
});

const policy = [
  ".github/workflows/build-dashboard-image.yml", ".github/workflows/dependency-security.yml",
  "docs/development/dashboard.md", "docs/development/regression-test-catalog.md",
  "tests/main-dev-advisory-admission.test.mjs", "tests/test_dependency_patches.py",
  "tools/main-dev-advisory-admission.mjs",
];
const images = {
  "magic-cluster/apps/dashboard/deployment.yaml": "magicstick-dashboard:sha-",
  "magic-cluster/apps/dashboard/api-deployment.yaml": "magicstick-dashboard:api-sha-",
  "magic-host/roles/dashboard-console/defaults/main.yml": "magicstick-dashboard:cli-sha-",
  "magic-cluster/apps/regression/runtime.yaml": "magicstick-regression:sha-",
};
const pins = [...Object.keys(images), "licenses/dependency-inventory.json"];
const repoFixture = {
  parents: rev => rev === head ? [newerMain, incoming] : [origin, incoming],
  changed: (from, to) => to === newerMain ? policy : pins,
  contents: (rev, path) => 'image: "ghcr.io/qualityminds/' + images[path] + newerMain
    + '@sha256:' + "d".repeat(64) + '"\nsourceRevision: "' + newerMain + '"\n',
};

test("the initial merged tree may contain all and only the policy, tests and documentation", () => {
  const context = selectContext({env: prEnv, event: pr, now});
  const g = {...repoFixture, parents: () => [origin, incoming], changed: () => policy};
  assert.equal(verifyTree(context, g), true);
  assert.equal(verifyTree(context, {...g, parents: () => [origin, head]}), false);
  assert.equal(verifyTree(context, {...g, changed: () => [...policy, "dashboard/apps/cli/Dockerfile"]}), false);
});

test("the second merge permits only four canonical pins built from the one reviewed policy successor", () => {
  const context = selectContext({env: prEnv, event: bot, now});
  assert.equal(verifyTree(context, repoFixture), true);
  for (const changed of [
    {parents: rev => rev === head ? [newerMain, incoming] : [incoming, origin]},
    {changed: () => pins},
    {changed: (a,b) => b === newerMain ? [...policy, "magic-host/roles/host-management/files/software_channel.py"] : pins},
    {changed: (a,b) => b === newerMain ? policy : pins.slice(1)},
    {contents: (r,p) => repoFixture.contents(r,p).replaceAll(newerMain, origin)},
  ]) assert.equal(verifyTree(context, {...repoFixture, ...changed}), false);
});
