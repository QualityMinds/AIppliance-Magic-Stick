// SPDX-License-Identifier: BUSL-1.1
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, copyFile, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {install, verifyAsset, verifyInstallation} from '../../instances/pi-coding/files/install.mjs';
import {prepare, toolMode} from '../../instances/pi-coding/files/prepare.mjs';

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

test('known tool-less models disable native Pi tools without guessing unknown capabilities', () => {
  const catalog = {models: [{id:'no-tools', capabilities:{tools:false,vision:true}},
    {id:'tools', capabilities:{tools:true}}, {id:'unknown'}]};
  assert.equal(toolMode(catalog,'no-tools'), 'disabled');
  assert.equal(toolMode(catalog,'tools'), 'default');
  assert.equal(toolMode(catalog,'unknown'), 'default');
});

async function projectedBootstrap(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-coding-projection-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = fileURLToPath(new URL('../../instances/pi-coding/files/', import.meta.url));
  const revision = join(root, '..2026_fixture');
  await mkdir(revision);
  await symlink('..2026_fixture', join(root, '..data'));
  for (const name of await readdir(source)) {
    await copyFile(join(source, name), join(revision, name));
    await symlink(`..data/${name}`, join(root, name));
  }
  return {root, source};
}

function cli(path, env = {}, args = []) {
  return spawnSync(process.execPath, [path, ...args], {env: {PATH: '', ...env},
    encoding: 'utf8', timeout: 10000});
}

test('CLI preparation rejects missing credentials through both direct and ConfigMap-projected paths', async t => {
  const {root, source} = await projectedBootstrap(t);
  for (const directory of [source, root]) {
    for (const args of [[], ['--tool-mode']]) {
      const result = cli(join(directory, 'prepare-cli.mjs'), {}, args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /The LiteLLM runtime credential is unavailable/);
    }
  }
});

test('a ConfigMap-projected installer actually runs and refuses an unavailable download tool', async t => {
  const {root, source} = await projectedBootstrap(t);
  for (const [index, directory] of [source, root].entries()) {
    const runtimeDir = join(root, `runtime-${index}`);
    const result = cli(join(directory, 'install-cli.mjs'), {PI_RUNTIME_DIR: runtimeDir});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to download the pinned Pi Coding runtime/);
    assert.deepEqual(await readdir(runtimeDir), []);
  }
});

test('importing runtime functions does not install or prepare an application', async t => {
  const {root} = await projectedBootstrap(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(join(root, 'install.mjs'))}); await import(${JSON.stringify(join(root, 'prepare.mjs'))});`],
  {env: {}, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('installation requires executable, compatible versions and redacts child diagnostics', async t => {
  const {root} = await projectedBootstrap(t);
  const terminal = join(root, 'ttyd');
  const agent = join(root, 'pi', 'pi');
  await assert.rejects(verifyInstallation(root), /pinned ttyd runtime is missing/);
  await mkdir(join(root, 'pi'));
  await writeFile(terminal, '#!/bin/sh\nprintf "ttyd version 1.7.7\\n"\n', {mode: 0o755});
  await writeFile(agent, '#!/bin/sh\nprintf "Pi v1.0.0\\n"\n', {mode: 0o755});
  await verifyInstallation(root);
  await chmod(terminal, 0o600);
  await assert.rejects(verifyInstallation(root), /pinned ttyd runtime/);
  await chmod(terminal, 0o755);
  await writeFile(agent, '#!/bin/sh\nprintf "unexpected-version\\n"\n');
  await assert.rejects(verifyInstallation(root), /pinned Pi runtime/);
  await writeFile(agent, '#!/bin/sh\nprintf "synthetic-private-diagnostic" >&2\nexit 1\n');
  await assert.rejects(verifyInstallation(root), error =>
    error.message === 'The pinned Pi runtime is missing, not executable or incompatible.');
  await rm(agent);
  await symlink(terminal, agent);
  await assert.rejects(verifyInstallation(root), /pinned Pi runtime/);
});
