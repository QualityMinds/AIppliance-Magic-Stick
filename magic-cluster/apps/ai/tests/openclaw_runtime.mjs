// SPDX-License-Identifier: BUSL-1.1
// Run inside the pinned OpenClaw image with synthetic controller-generated
// small-chat.json and large-chat.json mounted at /fixtures. No inference runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

for (const [model, contextWindow, keepRecentTokens] of [
  ['small-chat', 8192, 2048], ['large-chat', 128000, 20000],
]) {
  const filename = '/fixtures/' + model + '.json';
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: filename };
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  assert.deepEqual(config.agents.defaults.compaction, { keepRecentTokens });
  const run = (args) => JSON.parse(execFileSync(process.execPath,
    ['/app/openclaw.mjs', ...args], { env, encoding: 'utf8', timeout: 60000 }));
  assert.equal(run(['config', 'validate', '--json']).valid, true);
  const catalog = run(['models', 'list', '--provider', 'litellm', '--json']);
  const selected = catalog.models.find((entry) => entry.tags.includes('default'));
  assert.equal(selected.key, 'litellm/' + model);
  assert.equal(selected.contextWindow, contextWindow);
}
console.log('OpenClaw native schema, per-instance defaults and context windows verified');
