import {describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {MeshStatus} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {TuiContext} from './tui-context';
import {findDialogItem, type DialogItem, type InlineButton, type TuiOverlay} from './tui-dialogs';
import {MESH_SHARE_DEFAULTS, meshModule} from './tui-mesh';
import {initialPageState} from './tui-state';
import {renderTui} from './tui';

const baseSnapshot = (mesh?: MeshStatus): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {modules: {}, catalogJson: {modules: {}}},
  instances: {instances: {}},
  models: {models: [], activations: [], presets: {}, computeTargets: {targets: []}},
  settings: {publicDomain: 'example.com', dashboardHost: 'dashboard.example.com', mdnsDomain: 'example.local', mdnsName: 'example'},
  status: {},
  mesh,
  loadedAt: Date.now(),
});

const configured = (authority = true): MeshStatus => ({
  installed: true, configured: true, phase: 'connected', authority,
  mesh: {id: 'm1', name: 'company-mesh', authority: 'n1', origin: 'https://dashboard.example.com'},
  node: {id: 'n1', name: 'stick-01', type: 'magic-stick'},
  nodes: [
    {id: 'n1', name: 'stick-01', type: 'magic-stick', online: true, revoked: false, lastSeen: 0},
    {id: 'n2', name: 'laptop-01', type: 'client', online: false, revoked: false, lastSeen: 0},
  ],
  invites: [{id: 'i1', type: 'client', creator: 'tova', expiresAt: Date.now() / 1000 + 3600, createdAt: 0, usedAt: null, revoked: false}],
  models: ['chat-a', 'chat-b'],
  shares: {'chat-a': {...MESH_SHARE_DEFAULTS, enabled: true}},
  imports: ['remote-chat'],
  relay: {mode: 'auto', url: ''},
  components: {mesh: 'running', litellm: 'ready'},
  transport: 'direct',
});

const fake = (snapshot: DashboardSnapshot, api: Record<string, unknown>) => {
  let overlay: TuiOverlay | undefined;
  const ctx: TuiContext = {
    api: api as unknown as MagicStickApi, view: initialPageState({page: 'mesh'}), demo: false,
    snapshot: () => snapshot, session: () => snapshot.session, draw: () => undefined, refresh: vi.fn(async () => undefined),
    message: (title, lines, tone, copyValue) => { overlay = {kind: 'message', title, lines: Array.isArray(lines) ? lines : [lines], tone, copyValue}; },
    perform: async (title, operation) => {
      const result = await operation();
      overlay = {kind: 'message', title: 'Completed', lines: result?.lines ?? [title], copyValue: result?.copyValue};
    },
    task: async (_title, operation, then) => { then?.(await operation()); },
    load: async (_title, fetch, then) => then(await fetch()),
    confirm: (options) => { overlay = {kind: 'confirm', title: options.title, description: options.description, confirmLabel: options.confirmLabel, expected: options.expected, onConfirm: async () => { await options.onConfirm(); }}; },
    form: () => undefined,
    dialog: (spec) => { overlay = {kind: 'dialog', spec, scroll: 0}; },
    menu: () => undefined, viewer: () => undefined,
    current: () => overlay, close: () => { overlay = undefined; },
    copy: vi.fn(), saveAs: vi.fn(), openFile: vi.fn(), requestId: () => 'a'.repeat(32),
    missing: () => { overlay = {kind: 'message', title: 'No longer available', lines: []}; },
  };
  const dialog = () => {
    if (overlay?.kind !== 'dialog') throw new Error(`No dialog open: ${overlay?.kind}`);
    return overlay;
  };
  const item = <T extends DialogItem['kind']>(id: string) => findDialogItem(dialog().spec.items(), id) as Extract<DialogItem, {kind: T}>;
  return {
    ctx, dialog, item,
    overlay: () => overlay,
    press: (id: string) => (findDialogItem(dialog().spec.items(), id) as InlineButton).onPress(),
    blocked: () => dialog().spec.submit?.disabled?.(),
    submit: async () => {
      const reason = dialog().spec.submit?.disabled?.();
      if (reason) throw new Error(reason);
      await dialog().spec.submit!.run();
    },
  };
};

const render = (snapshot: DashboardSnapshot, state = {}) => renderTui(snapshot, {page: 'mesh', ...state}, 121, 60, false);

describe('terminal mesh page', () => {
  it('offers setup only, and shows loading and failures of the mesh status', () => {
    expect(render(baseSnapshot())).toContain('Loading mesh status');
    expect(render({...baseSnapshot(), errors: {mesh: 'HTTP 503'}})).toContain('Mesh status could not be loaded: HTTP 503');
    const fresh = render(baseSnapshot({installed: false, configured: false, phase: 'disconnected'}));
    expect(fresh).toContain('[ Enable Private Mesh ]');
    expect(fresh).toContain('[ Join Mesh ]');
    expect(fresh).not.toContain('Create Private Mesh');
    expect(render(baseSnapshot({installed: true, configured: false, phase: 'disconnected'}))).toContain('[ Create Private Mesh ]');
  });

  it('shows the configured mesh like the browser, with owner-only controls', () => {
    const owner = render(baseSnapshot(configured()));
    expect(owner).toContain('● Connected');
    expect(owner).toContain('[ Invitations ]');
    expect(owner).toContain('company-mesh');
    expect(owner).toContain('Nodes online');
    expect(owner).toContain('MeshLLM · running');
    expect(owner).toContain('[ Sync now ]');
    expect(owner).toMatch(/laptop-01.*\[ Revoke access \]/);
    expect(owner).not.toMatch(/stick-01 .*\[ Revoke access \]/);
    expect(owner).toContain('[ Leave mesh ]');
    const member = render(baseSnapshot(configured(false)));
    expect(member).not.toContain('Invitations');
    expect(member).not.toContain('Revoke access');
    const models = render(baseSnapshot(configured()), {meshTab: 'models'});
    expect(models).toMatch(/chat-a .*● Shared/);
    expect(models).toMatch(/chat-b .*○ Local only/);
    expect(models).toContain('[remote-chat]');
    expect(render(baseSnapshot(configured()), {meshTab: 'invitations'})).toMatch(/Employee laptop .*● Active .*\[ Revoke \]/);
  });

  it('creates a mesh in three steps with the browser payload', async () => {
    const meshCommand = vi.fn(async () => ({}));
    const io = fake(baseSnapshot({installed: true, configured: false, phase: 'disconnected', models: ['chat-a']}), {meshCommand});
    meshModule.handle(io.ctx, {id: 'mesh:create', scope: 'mesh', verb: 'create', target: ''});
    expect(io.blocked()).toMatch(/Mesh and node names/);
    io.item<'text'>('mesh-name').onChange('company-mesh');
    io.item<'text'>('node-name').onChange('Bad Name');
    expect(io.blocked()).toMatch(/Mesh and node names/);
    io.item<'text'>('node-name').onChange('stick-01');
    await io.submit();
    expect(io.dialog().spec.meta?.()).toBe('Step 2 of 3 · Network');
    expect(io.item<'text'>('origin').value).toBe('https://dashboard.example.com');
    io.item<'choice'>('relay-mode').onChange('custom');
    expect(io.blocked()).toMatch(/custom relay URL/);
    io.item<'text'>('relay-url').onChange('https://relay.example.com');
    await io.submit();
    expect(io.dialog().spec.submit?.label).toBe('Create mesh');
    io.item<'check'>('share-chat-a').onChange(true);
    expect(meshCommand).not.toHaveBeenCalled();
    await io.submit();
    expect(meshCommand).toHaveBeenCalledWith('create', {
      meshName: 'company-mesh', nodeName: 'stick-01', relay: {mode: 'custom', url: 'https://relay.example.com'}, origin: 'https://dashboard.example.com',
      shares: {'chat-a': {...MESH_SHARE_DEFAULTS, enabled: true}},
    });
  });

  it('joins with an invitation, or asks to leave the current mesh first', async () => {
    const meshCommand = vi.fn(async () => ({}));
    const io = fake(baseSnapshot({installed: true, configured: false, phase: 'disconnected', node: {id: 'n', name: 'stick-02', type: 'magic-stick'}}), {meshCommand});
    meshModule.handle(io.ctx, {id: 'mesh:join', scope: 'mesh', verb: 'join', target: ''});
    expect(io.item<'text'>('node-name').value).toBe('stick-02');
    expect(io.blocked()).toBe('Paste the invite token.');
    io.item<'text'>('token').onChange('  synthetic-token  ');
    await io.submit();
    expect(meshCommand).toHaveBeenCalledWith('join', {token: 'synthetic-token', nodeName: 'stick-02'});

    const member = fake(baseSnapshot(configured(false)), {meshCommand});
    meshModule.handle(member.ctx, {id: 'mesh:join', scope: 'mesh', verb: 'join', target: ''});
    expect(member.dialog().spec.submit?.label).toBe('Leave current mesh');
    await member.submit();
    expect(meshCommand).toHaveBeenLastCalledWith('leave', {});
  });

  it('saves model sharing only when changed and only for locally available models', async () => {
    const meshCommand = vi.fn(async () => ({}));
    const status = configured();
    status.shares = {...status.shares, gone: {...MESH_SHARE_DEFAULTS, enabled: false}};
    const io = fake(baseSnapshot(status), {meshCommand});
    meshModule.handle(io.ctx, {id: 'mesh:share:chat-b', scope: 'mesh', verb: 'share', target: 'chat-b'});
    expect(io.blocked()).toBe('No changes to save.');
    io.item<'check'>('enabled').onChange(true);
    io.item<'number'>('rpm').onChange('0');
    expect(io.blocked()).toMatch(/Requests \/ minute must be a whole number/);
    io.item<'number'>('rpm').onChange('20');
    await io.submit();
    expect(meshCommand).toHaveBeenCalledWith('share', {model: 'chat-b', settings: {...MESH_SHARE_DEFAULTS, enabled: true, rpm: 20}});

    meshModule.handle(io.ctx, {id: 'mesh:share:chat-a', scope: 'mesh', verb: 'share', target: 'chat-a'});
    io.item<'check'>('enabled').onChange(false);
    await io.submit();
    expect(meshCommand).toHaveBeenLastCalledWith('unshare', {model: 'chat-a'});

    meshModule.handle(io.ctx, {id: 'mesh:share:gone', scope: 'mesh', verb: 'share', target: 'gone'});
    expect(io.item<'check'>('enabled').disabled).toMatch(/not available locally/);
  });

  it('shows a new invitation token once, revokes nodes after confirmation and saves relay changes', async () => {
    const meshCommand = vi.fn(async (action: string) => action === 'invite' ? {id: 'i2', type: 'magic-stick', creator: 'tova', expiresAt: 0, createdAt: 0, usedAt: null, revoked: false, token: 'synthetic-invite'} : {});
    const io = fake(baseSnapshot(configured()), {meshCommand});
    meshModule.handle(io.ctx, {id: 'mesh:invite', scope: 'mesh', verb: 'invite', target: ''});
    io.item<'choice'>('lifetime').onChange('900');
    await io.submit();
    expect(meshCommand).toHaveBeenCalledWith('invite', {type: 'magic-stick', lifetime: 900});
    const shown = io.overlay();
    expect(shown?.kind === 'message' && shown.copyValue).toBe('synthetic-invite');

    meshModule.handle(io.ctx, {id: 'mesh:revoke-node:n2', scope: 'mesh', verb: 'revoke-node', target: 'n2'});
    expect(meshCommand).not.toHaveBeenCalledWith('revoke-node', expect.anything());
    const confirm = io.overlay();
    if (confirm?.kind !== 'confirm') throw new Error('confirmation expected');
    await confirm.onConfirm();
    expect(meshCommand).toHaveBeenCalledWith('revoke-node', {id: 'n2'});

    meshModule.handle(io.ctx, {id: 'mesh:relay', scope: 'mesh', verb: 'relay', target: ''});
    expect(io.blocked()).toBe('No changes to save.');
    io.item<'choice'>('relay-mode').onChange('public');
    await io.submit();
    expect(meshCommand).toHaveBeenLastCalledWith('relay', {mode: 'public', url: ''});
  });
});
