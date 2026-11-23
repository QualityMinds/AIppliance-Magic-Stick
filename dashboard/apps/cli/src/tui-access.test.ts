import {describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {KubernetesAccessUser} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {ConfirmOptions, TuiContext} from './tui-context';
import type {SaveSpec} from './tui-files';
import type {DialogItem, DialogSpec, ViewerSpec} from './tui-dialogs';
import {accessModule, apiAccessPage, kubernetesPage} from './tui-access';
import {initialPageState} from './tui-state';
import {fit} from './tui-screen';

const users: KubernetesAccessUser[] = [
  {id: 'a', username: 'ada', displayName: 'Ada Example', email: 'ada@example.com', enabled: true, accessLevel: 'admin'},
  {id: 'b', username: 'bo', enabled: true, accessLevel: 'none'},
  {id: 'c', username: 'cy', enabled: false, accessLevel: 'none'},
  {id: 'd', username: 'recovery', enabled: true, accessLevel: 'admin', protected: true},
];

const snapshot = (configured = true): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {}, modules: {modules: {}}, instances: {instances: {}}, status: {},
  models: {activations: [], presets: {}, computeTargets: {targets: []}},
  apiAccess: {total: 2, apiBases: [{scope: 'public', url: 'https://api.example.com/v1'}, {scope: 'local', url: 'https://api.example.local/v1'}], items: [
    {id: 'k1', name: 'ci', status: 'active', createdAt: '2026-01-02T03:04:05Z'},
    {id: 'k2', name: 'old', keyHint: 'sk-…ab', status: 'revoked'},
  ]},
  kubernetesAccess: {users, total: users.length, first: 0, max: 100, configuration: configured ? {configured: true, apiServer: 'https://k8s.example.com:6443'} : {configured: false}},
  loadedAt: Date.now(),
});

const harness = (data: DashboardSnapshot, api: Record<string, unknown> = {}) => {
  const log = {dialogs: [] as DialogSpec[], viewers: [] as ViewerSpec[], confirms: [] as ConfirmOptions[], messages: [] as Array<{title: string; lines: string[]}>,
    saves: [] as SaveSpec[], copied: [] as string[], refreshed: 0};
  const view = initialPageState();
  const ctx: TuiContext = {
    api: api as unknown as MagicStickApi, view, demo: false,
    snapshot: () => data, session: () => data.session, draw: () => undefined, refresh: async () => { log.refreshed += 1; },
    message: (title, lines) => { log.messages.push({title, lines: Array.isArray(lines) ? lines : [lines]}); },
    perform: async (title, operation) => { const result = await operation(); log.messages.push({title: 'Completed', lines: result?.lines ?? [title]}); },
    task: async (_title, operation, then) => { const value = await operation(); then?.(value); },
    load: async (_title, fetch, then) => { then(await fetch()); },
    confirm: (options) => { log.confirms.push(options); },
    form: () => undefined, dialog: (spec) => { log.dialogs.push(spec); }, menu: () => undefined,
    viewer: (spec) => { log.viewers.push(spec); }, current: () => undefined, close: () => undefined,
    copy: (value) => { log.copied.push(value); }, saveAs: (spec) => { log.saves.push(spec); }, openFile: () => undefined,
    requestId: () => 'a'.repeat(32), missing: () => { log.messages.push({title: 'missing', lines: []}); },
  };
  return {ctx, log, view};
};
const text = (rows: ReturnType<typeof apiAccessPage>['rows']) => rows.map((row) => fit(91, row).map((item) => item.text).join('')).join('\n');
const disabled = (rows: ReturnType<typeof apiAccessPage>['rows'], id: string) => rows.flat().find((item) => item.action?.id === id)?.action?.disabled;
const run = (ctx: TuiContext, id: string) => {
  const [scope = '', verb = '', ...rest] = id.split(':');
  return accessModule.handle(ctx, {id, scope, verb, target: rest.join(':')});
};

describe('terminal API Access page', () => {
  it('lists API bases and named keys like the browser', () => {
    const page = apiAccessPage(snapshot(), 91);
    const shown = text(page.rows);
    expect(shown).toContain('Create named LiteLLM virtual keys. Secret values are shown once.');
    expect(shown).toContain('local API base');
    expect(shown).toContain('Unavailable');
    expect(shown).toContain('2 keys');
    expect(disabled(page.rows, 'apikey:revoke:k1')).toBeUndefined();
    expect(disabled(page.rows, 'apikey:revoke:k2')).toBe('This key is no longer active.');
  });

  it('shows a created key once with the local API base, both copyable', async () => {
    const createApiKey = vi.fn(async () => ({item: {}, key: 'sk-synthetic', apiBases: [{scope: 'public', url: 'https://api.example.com/v1'}, {scope: 'local', url: 'https://api.example.local/v1'}]}));
    const {ctx, log} = harness(snapshot(), {createApiKey});
    run(ctx, 'apikey:create');
    const dialog = log.dialogs[0]!;
    (dialog.items()[0] as Extract<DialogItem, {kind: 'text'}>).onChange('ci pipeline');
    await dialog.submit!.run();
    expect(createApiKey).toHaveBeenCalledWith('ci pipeline');
    const viewer = log.viewers[0]!;
    expect(viewer.lines().map((line) => line.text)).toEqual(['API key', 'sk-synthetic', '', 'API base', 'https://api.example.local/v1', '']);
    viewer.actions!.find((action) => action.key === 'c')!.run();
    viewer.actions!.find((action) => action.key === 'b')!.run();
    expect(log.copied).toEqual(['sk-synthetic', 'https://api.example.local/v1']);
    expect(log.refreshed).toBe(1);
  });

  it('revokes only active keys, after confirmation', async () => {
    const revokeApiKey = vi.fn(async () => ({}));
    const {ctx, log} = harness(snapshot(), {revokeApiKey});
    run(ctx, 'apikey:revoke:k2');
    expect(log.confirms).toHaveLength(0);
    run(ctx, 'apikey:revoke:k1');
    expect(log.confirms[0]!.description).toBe('Revoke ci? Applications using it lose access immediately.');
    await log.confirms[0]!.onConfirm();
    expect(revokeApiKey).toHaveBeenCalledWith('k1');
  });
});

describe('terminal Kubernetes Access page', () => {
  it('explains why access changes and kubeconfig exports are unavailable', () => {
    const page = kubernetesPage(snapshot(), initialPageState(), 91);
    const shown = text(page.rows);
    expect(shown).toContain('SSO is active for https://k8s.example.com:6443.');
    expect(shown).toContain('Ada Example');
    expect(shown).toContain('ada · ada@example.com');
    expect(disabled(page.rows, 'k8s:download:a')).toBeUndefined();
    expect(disabled(page.rows, 'k8s:download:b')).toBe('Grant access first.');
    expect(disabled(page.rows, 'k8s:copy:c')).toBe('The user is disabled.');
    expect(disabled(page.rows, 'k8s:access:c')).toBe('Enable the user before granting Kubernetes access.');
    expect(disabled(page.rows, 'k8s:access:d')).toBe('Protected recovery access cannot be changed.');
    const unconfigured = kubernetesPage(snapshot(false), initialPageState(), 91);
    expect(text(unconfigured.rows)).toContain('Kubernetes SSO is not confirmed by this cluster.');
    expect(disabled(unconfigured.rows, 'k8s:download:a')).toBe('The Kubernetes API server has not confirmed OIDC.');
  });

  it('warns about cluster administrator access before saving', async () => {
    const updateKubernetesAccess = vi.fn(async () => ({}));
    const {ctx, log} = harness(snapshot(), {updateKubernetesAccess});
    run(ctx, 'k8s:access:b');
    const dialog = log.dialogs[0]!;
    (dialog.items()[0] as Extract<DialogItem, {kind: 'choice'}>).onChange('admin');
    expect(dialog.items().some((item) => item.kind === 'note' && item.tone === 'warn' && item.text.startsWith('Warning: Cluster Administrator'))).toBe(true);
    await dialog.submit!.run();
    expect(updateKubernetesAccess).toHaveBeenCalledWith('b', 'admin');
    expect(log.messages.at(-1)?.lines).toEqual(['Kubernetes access for bo updated to Cluster Administrator.']);
  });

  it('saves a token-free kubeconfig under the suggested name and copies it on request', async () => {
    const kubeconfig = vi.fn(async () => ({filename: 'ada-kubeconfig.yaml', content: 'apiVersion: v1\n'}));
    const {ctx, log} = harness(snapshot(), {kubeconfig});
    await run(ctx, 'k8s:download:a');
    expect(log.saves[0]!.defaultName).toBe('ada-kubeconfig.yaml');
    expect(await log.saves[0]!.content()).toBe('apiVersion: v1\n');
    await run(ctx, 'k8s:copy:a');
    expect(log.copied).toEqual(['apiVersion: v1\n']);
    await run(ctx, 'k8s:copy:b');
    expect(kubeconfig).toHaveBeenCalledTimes(2);
  });

  it('searches identities through the shared page state and shows the OIDC configuration', async () => {
    const {ctx, log, view} = harness(snapshot());
    run(ctx, 'k8s:search');
    const dialog = log.dialogs[0]!;
    (dialog.items()[0] as Extract<DialogItem, {kind: 'text'}>).onChange(' ada ');
    await dialog.submit!.run();
    expect(view.ui['k8s.search']).toBe('ada');
    expect(log.refreshed).toBe(1);
    expect(text(kubernetesPage(snapshot(), view, 91).rows)).toContain('"ada"');
    run(ctx, 'k8s:oidc');
    expect(log.viewers[0]!.lines().map((line) => line.text).join('\n')).toContain('"apiServer": "https://k8s.example.com:6443"');
  });
});
