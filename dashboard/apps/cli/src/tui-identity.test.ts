import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {LicenseStatus, User} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {ConfirmOptions, TuiContext} from './tui-context';
import type {SaveSpec} from './tui-files';
import type {DialogItem, DialogSpec, ViewerSpec} from './tui-dialogs';
import {identityModule, licenseSection, usersSection} from './tui-identity';
import {LICENSE_DOCUMENTS, readLicenseDocument} from './license';
import {initialPageState, type PageState} from './tui-state';
import {fit, type Row} from './tui-screen';

const capabilities = {canEditProfile: true, canManageRoles: true, canEnable: true, canDisable: true, canResetPassword: true, canDelete: true};
const userList: User[] = [
  {id: 'l', username: 'lee', displayName: 'Lee Example', email: 'lee@example.com', enabled: true, local: true, accessLevel: 'operator', effectiveAccessLevel: 'operator',
    directRoles: ['magicstick-operator'], effectiveRoles: ['magicstick-operator', 'magicstick-viewer'], createdTimestamp: 1767225600000, capabilities},
  {id: 'x', username: 'ext', enabled: false, provider: 'company-sso', local: false, capabilities: {...capabilities, canEditProfile: false, canResetPassword: false, canDelete: false}},
];

const license: LicenseStatus = {
  edition: 'free', state: 'missing', valid: false, message: 'No license installed.', installationId: 'inst-1', revision: '3', checkedAt: 1767225600,
  hasDocument: false, trustedKeyIds: [], features: [
    {id: 'federated-sso', name: 'Federated SSO', licensed: false, implemented: true, available: false, reason: 'unlicensed'},
    {id: 'commercial-production', name: 'Commercial production', licensed: false, implemented: true, available: false, reason: 'unlicensed'},
  ],
};

const snapshot = (): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {}, modules: {modules: {}}, instances: {instances: {}}, status: {},
  models: {activations: [], presets: {}, computeTargets: {targets: []}},
  users: {users: userList, total: 30, first: 0, max: 25},
  license,
  loadedAt: Date.now(),
});

const harness = (data: DashboardSnapshot, api: Record<string, unknown> = {}) => {
  const log = {dialogs: [] as DialogSpec[], viewers: [] as ViewerSpec[], confirms: [] as ConfirmOptions[], messages: [] as Array<{title: string; lines: string[]}>,
    saves: [] as SaveSpec[], refreshed: 0};
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
    copy: () => undefined, saveAs: (spec) => { log.saves.push(spec); }, openFile: () => undefined,
    requestId: () => 'a'.repeat(32), missing: () => { log.messages.push({title: 'missing', lines: []}); },
  };
  return {ctx, log, view};
};
const text = (rows: Row[]) => rows.map((row) => fit(91, row).map((item) => item.text).join('')).join('\n');
const disabled = (rows: Row[], id: string) => rows.flat().find((item) => item.action?.id === id)?.action?.disabled;
const run = (ctx: TuiContext, id: string) => {
  const [scope = '', verb = '', ...rest] = id.split(':');
  return identityModule.handle(ctx, {id, scope, verb, target: rest.join(':')});
};
type Field = Extract<DialogItem, {kind: 'text' | 'choice' | 'check' | 'number'}>;
const field = (spec: DialogSpec, id: string) => spec.items().find((item) => 'id' in item && item.id === id) as Field;
const set = (spec: DialogSpec, id: string, value: string | boolean) => (field(spec, id).onChange as (next: string | boolean) => void)(value);

describe('terminal Users section', () => {
  it('shows profile, source, roles and the browser reasons for unavailable actions', () => {
    const rows = usersSection(snapshot(), initialPageState(), 91).rows;
    const shown = text(rows);
    expect(shown).toContain('Lee Example');
    expect(shown).toContain('lee · Local · Managed locally · Created');
    expect(shown).toContain('Direct: magicstick-operator · Effective: magicstick-operator, magicstick-viewer');
    expect(shown).toContain('Not set');
    expect(shown).toContain('company-sso · Profile and password managed upstream');
    expect(shown).toContain('1–2 of 30');
    expect(disabled(rows, 'user:profile:x')).toBe('Profile fields are managed upstream.');
    expect(disabled(rows, 'user:password:x')).toBe('Reset the password at the external identity provider.');
    expect(disabled(rows, 'user:delete:x')).toBe('External accounts must be disabled or removed upstream.');
    expect(disabled(rows, 'user:page:previous')).toBe('This is the first page.');
    expect(disabled(rows, 'user:page:next')).toBeUndefined();
  });

  it('filters the loaded page by status and source, and pages through the directory', async () => {
    const state: PageState = {...initialPageState(), ui: {'users.status': 'disabled'}};
    const shown = text(usersSection(snapshot(), state, 91).rows);
    expect(shown).not.toContain('Lee Example');
    expect(shown).toContain('1 shown after filters');
    const {ctx, log, view} = harness(snapshot());
    run(ctx, 'user:page:next');
    expect(view.ui['users.first']).toBe('25');
    run(ctx, 'user:page-size');
    expect(view.ui).toMatchObject({'users.max': '50', 'users.first': '0'});
    run(ctx, 'user:search');
    set(log.dialogs[0]!, 'search', ' lee ');
    set(log.dialogs[0]!, 'source', 'local');
    await log.dialogs[0]!.submit!.run();
    expect(view.ui).toMatchObject({'users.search': 'lee', 'users.source': 'local', 'users.first': '0'});
    expect(log.refreshed).toBe(3);
  });

  it('validates a new user like the browser and sends the enable choice', async () => {
    const createUser = vi.fn(async () => ({}));
    const {ctx, log} = harness(snapshot(), {createUser});
    run(ctx, 'user:create');
    const dialog = log.dialogs[0]!;
    set(dialog, 'username', '-bad');
    set(dialog, 'email', 'new@example.com');
    expect(dialog.submit!.disabled!()).toContain('username');
    set(dialog, 'username', 'new.user');
    set(dialog, 'password', 'short');
    expect(dialog.submit!.disabled!()).toContain('12 characters');
    set(dialog, 'password', 'CHANGEME-temporary');
    set(dialog, 'confirmation', 'CHANGEME-other');
    expect(dialog.submit!.disabled!()).toContain('does not match');
    set(dialog, 'confirmation', 'CHANGEME-temporary');
    set(dialog, 'enabled', false);
    set(dialog, 'access', 'viewer');
    expect(dialog.submit!.disabled!()).toBeUndefined();
    await dialog.submit!.run();
    expect(createUser).toHaveBeenCalledWith({username: 'new.user', firstName: '', lastName: '', email: 'new@example.com', password: 'CHANGEME-temporary', enabled: false, accessLevel: 'viewer'});
  });

  it('asks for the exact username before deleting and shows roles when changing access', async () => {
    const deleteUser = vi.fn(async () => ({}));
    const {ctx, log} = harness(snapshot(), {deleteUser});
    run(ctx, 'user:delete:l');
    expect(log.confirms[0]!.expected).toBe('lee');
    await log.confirms[0]!.onConfirm();
    expect(deleteUser).toHaveBeenCalledWith('l', 'lee');
    run(ctx, 'user:delete:x');
    expect(log.messages.at(-1)?.title).toBe('Account cannot be deleted');
    run(ctx, 'user:access:l');
    expect(log.dialogs[0]!.items().find((item) => item.kind === 'facts')).toEqual({kind: 'facts', rows: [['Direct roles', 'magicstick-operator'], ['Effective roles', 'magicstick-operator, magicstick-viewer']]});
  });
});

describe('terminal License section', () => {
  it('shows the editions, offline license texts and license status', () => {
    const shown = text(licenseSection(snapshot(), initialPageState(), 91).rows);
    expect(shown).toContain('Free Use Grant');
    expect(shown).toContain('Business Source License 1.1');
    expect(shown).toContain('Technical edition: Free');
    expect(shown).toContain('Revenue is not checked by the software.');
    expect(shown).toContain('License verification keys are unavailable.');
    expect(disabled(licenseSection(snapshot(), initialPageState(), 91).rows, 'license:export')).toBe('No license document is installed.');
  });

  it('saves an unsigned license request under the suggested name', async () => {
    const createLicenseRequest = vi.fn(async () => ({filename: 'magicstick-license-request.json', content: '{"unsigned":true}'}));
    const {ctx, log} = harness(snapshot(), {createLicenseRequest});
    run(ctx, 'license:request');
    const dialog = log.dialogs[0]!;
    expect(dialog.submit!.disabled!()).toContain('customer reference');
    set(dialog, 'customer', 'Example Org');
    set(dialog, 'edition', 'commercial');
    set(dialog, 'ttl', '12');
    set(dialog, 'unit', 'hours');
    const entitlements = dialog.items().find((item) => item.kind === 'facts') as Extract<DialogItem, {kind: 'facts'}>;
    expect(entitlements.rows.map(([name]) => name)).toEqual(['✓ Federated SSO', '✓ Commercial production']);
    await dialog.submit!.run();
    expect(createLicenseRequest).toHaveBeenCalledWith({customer: 'Example Org', edition: 'commercial', features: ['commercial-production', 'federated-sso'], ttlSeconds: 43200});
    expect(log.saves[0]!.defaultName).toBe('magicstick-license-request.json');
    expect(await log.saves[0]!.content()).toBe('{"unsigned":true}');
  });

  it('reads the offline license texts at runtime and offers a saved copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'magicstick-licenses-'));
    try {
      await mkdir(join(root, 'licenses'), {recursive: true});
      await writeFile(join(root, 'licenses', 'MIT-CHANGE.txt'), 'MIT\n  indented');
      const document = LICENSE_DOCUMENTS.find((item) => item.path === 'licenses/MIT-CHANGE.txt')!;
      expect(await readLicenseDocument(document, ['/nonexistent-root', root])).toBe('MIT\n  indented');
      await expect(readLicenseDocument(LICENSE_DOCUMENTS[0]!, [root])).rejects.toThrow('not installed');
    } finally { await rm(root, {recursive: true, force: true}); }
    // The source checkout carries the texts at the repository root.
    const {ctx, log} = harness(snapshot());
    await run(ctx, 'license:document:1');
    const viewer = log.viewers[0]!;
    expect(viewer.title).toBe('Business Source License 1.1');
    expect(viewer.lines().length).toBeGreaterThan(10);
    viewer.actions![0]!.run();
    expect(log.saves[0]!.defaultName).toBe('MagicStick-BSL.txt');
    expect(log.saves[0]!.back).toBe(true);
    expect(await log.saves[0]!.content()).toContain('Business Source License');
  });
});
