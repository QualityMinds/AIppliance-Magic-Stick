import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {ModelsPayload, ModulesPayload} from '@magicstick/dashboard-contracts';
import {createDemoRuntime} from './demo';
import type {Runtime} from './runtime';
import {loadSnapshot} from './snapshot';
import {renderTui, runTui} from './tui';

// A live-shaped runtime on the synthetic demo data, with the mutating calls replaced by spies.
const liveRuntime = async (roles = ['magicstick-admin']) => {
  const demo = createDemoRuntime();
  const modules = structuredClone(await demo.api.modules()) as ModulesPayload;
  modules.catalogJson!.modules!.litellm!.credentials = {provider: 'synthetic'};
  const models = structuredClone(await demo.api.models()) as ModelsPayload;
  models.activations[0]!.metadata = {name: 'demo-chat', uid: 'uid-1', generation: 2};
  const session = {...await demo.api.session(), roles};
  const calls = {
    createInstance: vi.fn(async () => ({})),
    removeInstance: vi.fn(async () => ({})),
    moduleCredentials: vi.fn(async () => ({title: 'LiteLLM', credentials: [{key: 'master', value: 'synthetic-value'}]})),
    instanceAccess: vi.fn(async () => ({name: 'demo', revision: 'r1', sharing: {mode: 'all' as const, users: [], groups: []}, authentication: 'sso', guardReady: true, principals: {users: [], groups: []}})),
    instancePrincipals: vi.fn(async () => ({kind: 'users', items: [{id: 'u1', name: 'tova'}], next: null})),
    updateInstanceAccess: vi.fn(async () => ({})),
    lifecycle: vi.fn(async (_path: string, _init?: RequestInit) => ({})),
  };
  const api = Object.assign(Object.create(demo.api) as MagicStickApi, {
    session: async () => session, modules: async () => modules, models: async () => models,
    createInstance: calls.createInstance, removeInstance: calls.removeInstance, moduleCredentials: calls.moduleCredentials,
    instanceAccess: calls.instanceAccess, instancePrincipals: calls.instancePrincipals, updateInstanceAccess: calls.updateInstanceAccess,
    request: (path: string, init?: RequestInit) => init?.method === 'POST' && path.startsWith('/api/models/') ? calls.lifecycle(path, init) : demo.api.request(path, init),
  });
  const runtime: Runtime = {...demo, api};
  return {runtime, calls};
};

const started = async (runtime: Runtime) => {
  const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
  const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 121, rows: 48});
  const writes: string[] = [];
  stdout.on('data', (value: Buffer) => writes.push(value.toString()));
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
  const settle = async () => { for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const screen = () => ([...writes].reverse().find((write) => write.includes('AI Appliance Dashboard')) ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const key = async (value: string) => { stdin.emit('data', Buffer.from(value)); await settle(); };
  // Clicks the first occurrence of a label where the screen shows it, as a terminal mouse would report it.
  const click = async (label: string) => {
    const rows = screen().split('\n');
    const row = rows.findIndex((line) => line.includes(label));
    if (row < 0) throw new Error(`Not on screen: ${label}`);
    await key(`\x1b[<0;${Array.from(rows[row]!.slice(0, rows[row]!.indexOf(label))).length + 2};${row + 1}M`);
  };
  const running = runTui(runtime, {color: false});
  await settle();
  return {key, click, screen, running, close: async () => { await key('\x03'); stdin.destroy(); stdout.destroy(); }};
};

afterEach(() => vi.restoreAllMocks());

describe('terminal dashboard actions shared with the browser', () => {
  it('creates an instance with the same payload as the browser form', async () => {
    const {runtime, calls} = await liveRuntime();
    const io = await started(runtime);
    try {
      await io.key('3');
      await io.key('n');
      expect(io.screen()).toContain('Create Instance');
      expect(io.screen()).toContain('× Paperclip — required services are not ready: Paperclip');
      await io.key('\r');
      expect(io.screen()).toContain('New Hermes instance');
      expect(io.screen()).toContain('Model: < demo-chat >');
      expect(io.screen()).not.toContain('Postgres');

      await io.key('\x15');
      await io.key('Bad Name');
      await io.key('\x13');
      expect(io.screen()).toContain('lowercase letters');
      expect(calls.createInstance).not.toHaveBeenCalled();

      await io.key('\x15');
      await io.key('team');
      await io.key('\x13');
      expect(calls.createInstance).toHaveBeenCalledWith('hermes', {
        name: 'team', enabled: true, namespace: 'ai', model: 'demo-chat',
        access: {authentication: 'sso', role: 'user', exposure: 'localAndPublic'},
        storage: {size: '10Gi'}, ingress: {enabled: false, host: 'team.hermes.example.com'},
      });
      expect(io.screen()).toContain('Hermes instance team was requested');
    } finally { await io.close(); }
  });

  it('removes an instance only after confirmation, by mouse', async () => {
    const {runtime, calls} = await liveRuntime();
    const io = await started(runtime);
    try {
      await io.click('Services');
      await io.click('► Show 1 instance');
      await io.click('[ Remove ]');
      expect(io.screen()).toContain('Remove demo? Its reconciled application resources will be removed by the');
      await io.click('[ Cancel ]');
      expect(io.screen()).not.toContain('Remove demo?');
      expect(calls.removeInstance).not.toHaveBeenCalled();
      await io.click('[ Remove ]');
      await io.key('\r');
      expect(calls.removeInstance).toHaveBeenCalledWith('demo');
    } finally { await io.close(); }
  });

  it('shows service credentials on request and clears them when the dialog closes', async () => {
    const {runtime, calls} = await liveRuntime();
    const io = await started(runtime);
    try {
      await io.key('3');
      expect(io.screen()).not.toContain('synthetic-value');
      await io.click('[ Credentials ]');
      expect(calls.moduleCredentials).toHaveBeenCalledWith('litellm');
      expect(io.screen()).toContain('master: synthetic-value');
      await io.key('\r');
      expect(io.screen()).not.toContain('synthetic-value');
    } finally { await io.close(); }
  });

  it('saves instance sharing with the loaded revision after naming who gets access', async () => {
    const {runtime, calls} = await liveRuntime();
    const io = await started(runtime);
    try {
      await io.key('3');
      await io.click('► Show 1 instance');
      await io.click('[ Sharing ]');
      expect(io.screen()).toContain('Visible to: all users with the required role');
      await io.key('\x1b[B'); // Save sharing: nothing changed yet
      await io.key('\r');
      expect(io.screen()).toContain('no changes to save');
      await io.key('\r');
      expect(io.screen()).not.toContain('Sharing · demo');

      await io.click('[ Sharing ]');
      await io.key('\r'); // → selected users or groups
      await io.key('\x1b[B');
      await io.key('\r'); // Add user…
      await io.key('to');
      await io.key('\r');
      expect(calls.instancePrincipals).toHaveBeenCalledWith('users', 'to');
      await io.key('\r'); // choose tova
      expect(io.screen()).toContain('User tova');
      for (let step = 0; step < 4; step += 1) await io.key('\x1b[B');
      await io.key('\r');
      expect(io.screen()).toContain('Only these will be able to see and use this instance: tova.');
      expect(calls.updateInstanceAccess).not.toHaveBeenCalled();
      await io.key('\r');
      expect(calls.updateInstanceAccess).toHaveBeenCalledWith('demo', {mode: 'selected', users: ['u1'], groups: []}, 'r1');
    } finally { await io.close(); }
  });

  it('stops a model after confirmation with its saved revision and starts it directly', async () => {
    const {runtime, calls} = await liveRuntime();
    const io = await started(runtime);
    try {
      await io.key('2');
      await io.click('[ Stop ]');
      expect(io.screen()).toContain('Saved settings are kept.');
      expect(calls.lifecycle).not.toHaveBeenCalled();
      await io.key('\r');
      expect(calls.lifecycle).toHaveBeenCalledWith('/api/models/demo-chat/stop', {method: 'POST', body: JSON.stringify({expectedRevision: 'generation:uid-1:2'})});
      expect(io.screen()).toContain('Stop requested for demo-chat');
    } finally { await io.close(); }
  });

  it('keeps operator and viewer sessions within their role', async () => {
    const operator = await liveRuntime(['magicstick-operator']);
    const services = (snapshot: Awaited<ReturnType<typeof loadSnapshot>>) => renderTui(snapshot, {page: 'services', expanded: {'app:hermes': true}}, 121, 48, false);
    const asOperator = services(await loadSnapshot(operator.runtime.api));
    expect(asOperator).toContain('[ New Instance ]');
    expect(asOperator).toContain('[ Remove ]');
    expect(asOperator).not.toContain('[ Sharing ]');
    const viewer = await liveRuntime(['magicstick-viewer']);
    const asViewer = services(await loadSnapshot(viewer.runtime.api));
    expect(asViewer).not.toMatch(/\[ (New Instance|Create Instance|Remove|Credentials|Sharing|Disable) \]/);
    expect(renderTui(await loadSnapshot(viewer.runtime.api), {page: 'models'}, 121, 48, false)).not.toMatch(/\[ (Stop|Start|Remove) \]/);
  });

  it('explains why a model without a saved revision cannot be stopped', async () => {
    const demo = createDemoRuntime();
    const request = vi.spyOn(demo.api, 'request');
    const io = await started({...demo});
    try {
      await io.key('2');
      const before = request.mock.calls.length;
      await io.click('[ Stop ]');
      expect(io.screen()).toContain('no saved revision');
      expect(request.mock.calls.slice(before).some(([path]) => String(path).includes('/stop'))).toBe(false);
    } finally { await io.close(); }
  });
});
