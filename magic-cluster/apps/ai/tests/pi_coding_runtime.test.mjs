// SPDX-License-Identifier: BUSL-1.1
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readlink, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {install, verifyAsset} from '../../instances/pi-coding/files/install.mjs';
import {prepare} from '../../instances/pi-coding/files/prepare.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-coding-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const config = {agentDir: join(root, 'agent'), workspace: join(root, 'workspace'),
    modelsPath: join(root, 'pi-models.json'), selectedModel: 'small-coder'};
  await writeFile(config.modelsPath, JSON.stringify({providers: {litellm: {
    apiKey: '${LITELLM_API_KEY}', models: [
      {id: 'small-coder', contextWindow: 1024, maxTokens: 256},
      {id: 'large-coder', contextWindow: 131072, maxTokens: 8192},
    ],
  }}}));
  return config;
}

test('uses catalog limits and preserves existing preferences, auth and sessions on repeated startup', async t => {
  const config = await fixture(t);
  await mkdir(join(config.agentDir, 'sessions'), {recursive: true});
  await writeFile(join(config.agentDir, 'settings.json'), JSON.stringify({theme: 'dark',
    defaultProvider: 'openai', compaction: {enabled: false, reserveTokens: 16384}}));
  await writeFile(join(config.agentDir, 'auth.json'), 'synthetic-auth');
  await writeFile(join(config.agentDir, 'sessions', 'saved.jsonl'), 'synthetic-session');
  await prepare(config);
  await prepare(config);
  const settings = JSON.parse(await readFile(join(config.agentDir, 'settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.defaultProvider, 'litellm');
  assert.equal(settings.defaultModel, 'small-coder');
  assert.equal(settings.compaction.enabled, false);
  assert.equal(settings.compaction.reserveTokens, 256);
  assert.equal(settings.compaction.keepRecentTokens, 256);
  assert.deepEqual(settings.compaction.modelOverrides['litellm/large-coder'], {reserveTokens: 8192, keepRecentTokens: 20000});
  assert.equal(await readFile(join(config.agentDir, 'auth.json'), 'utf8'), 'synthetic-auth');
  assert.equal(await readFile(join(config.agentDir, 'sessions', 'saved.jsonl'), 'utf8'), 'synthetic-session');
  assert.equal(await readlink(join(config.agentDir, 'models.json')), config.modelsPath);
  assert.equal((await readFile(join(config.agentDir, 'models.json'), 'utf8')).includes('${LITELLM_API_KEY}'), true);
});

test('model updates remain visible and a requested model is never silently replaced', async t => {
  const config = await fixture(t);
  await prepare(config);
  await writeFile(config.modelsPath, JSON.stringify({providers: {litellm: {models: []}}}));
  assert.deepEqual(JSON.parse(await readFile(join(config.agentDir, 'models.json'), 'utf8')).providers.litellm.models, []);
  await assert.rejects(prepare(config), /selected chat model is unavailable/);
  assert.equal(JSON.parse(await readFile(join(config.agentDir, 'settings.json'), 'utf8')).defaultModel, 'small-coder');
});

test('rejects invalid token budgets and preserves damaged settings for repair', async t => {
  const config = await fixture(t);
  await writeFile(config.modelsPath, JSON.stringify({providers: {litellm: {models: [
    {id: config.selectedModel, contextWindow: -1, maxTokens: 256},
  ]}}}));
  await assert.rejects(prepare(config), /invalid token limits/);
  const valid = await fixture(t);
  await mkdir(valid.agentDir, {recursive: true});
  await writeFile(join(valid.agentDir, 'settings.json'), 'damaged-settings');
  await assert.rejects(prepare(valid), /Repair the settings/);
  assert.equal(await readFile(join(valid.agentDir, 'settings.json'), 'utf8'), 'damaged-settings');
});

test('rejects altered downloads and unsupported architectures before execution', async t => {
  const config = await fixture(t);
  const asset = join(config.workspace, 'asset');
  await mkdir(config.workspace);
  await writeFile(asset, 'verified-upstream-fixture');
  const digest = createHash('sha256').update('verified-upstream-fixture').digest('hex');
  await verifyAsset(asset, digest);
  await writeFile(asset, 'altered-download');
  await assert.rejects(verifyAsset(asset, digest), /checksum mismatch/);
  await assert.rejects(install(config.workspace, 'riscv64'), /amd64 and arm64 only/);
});
