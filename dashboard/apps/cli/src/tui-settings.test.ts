import {describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {FederatedSsoStatus, LicenseStatus} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {TuiContext} from './tui-context';
import {findDialogItem, type DialogItem, type InlineButton, type TuiOverlay} from './tui-dialogs';
import {settingsModule, validDomain} from './tui-settings';
import {initialPageState} from './tui-state';
import {renderTui} from './tui';

const license = (licensed: boolean): LicenseStatus => ({
  edition: licensed ? 'free-registered' : 'free', state: licensed ? 'valid' : 'missing', valid: licensed, message: '', installationId: 'install-1', revision: '1',
  checkedAt: 0, hasDocument: licensed, trustedKeyIds: [],
  features: [{id: 'federated-sso', name: 'Federated SSO', licensed, implemented: true}],
} as unknown as LicenseStatus);

const federation = (available = true): FederatedSsoStatus => ({
  feature: {id: 'federated-sso', name: 'Federated SSO', licensed: available, implemented: true, available, reason: available ? 'available' : 'not_licensed'} as FederatedSsoStatus['feature'],
  issuer: 'https://id.example.com/realms/magicstick',
  callbackUrl: 'https://id.example.com/realms/magicstick/broker/{alias}/endpoint',
  providers: [{alias: 'company-login', displayName: 'Company SSO', protocol: 'oidc', metadataUrl: 'https://login.example.com/.well-known/openid-configuration',
    clientId: 'magicstick', scopes: 'openid profile email', enabled: true, trustEmail: false, secretConfigured: true,
    mappings: [{source: 'groups', value: 'magicstick-users', accessLevel: 'user'}], revision: 'rev-7'}],
});

const snapshot = (overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {modules: {}, catalogJson: {modules: {}}},
  instances: {instances: {}},
  models: {models: [], activations: [], presets: {}, computeTargets: {targets: []}},
  settings: {publicDomain: 'magicstick.example.com', dashboardHost: 'dashboard.magicstick.example.com', mdnsDomain: 'magicstick.local', mdnsName: 'magicstick'},
  status: {},
  license: license(true),
  federatedSso: federation(),
  consoleAccess: {available: true, accessLevel: 'admin'},
  loadedAt: Date.now(),
  ...overrides,
});

const fake = (data: DashboardSnapshot, api: Record<string, unknown>) => {
  let overlay: TuiOverlay | undefined;
  const copy = vi.fn();
  const ctx: TuiContext = {
    api: api as unknown as MagicStickApi, view: initialPageState({page: 'system', systemSection: 'settings'}), demo: false,
    snapshot: () => data, session: () => data.session, draw: () => undefined, refresh: vi.fn(async () => undefined),
    message: (title, lines, tone, copyValue) => { overlay = {kind: 'message', title, lines: Array.isArray(lines) ? lines : [lines], tone, copyValue}; },
    perform: async (title, operation) => {
      const result = await operation();
      overlay = {kind: 'message', title: 'Completed', lines: result?.lines ?? [title]};
    },
    task: async (_title, operation, then) => { then?.(await operation()); },
    load: async (_title, fetch, then) => then(await fetch()),
    confirm: (options) => { overlay = {kind: 'confirm', title: options.title, description: options.description, confirmLabel: options.confirmLabel, expected: options.expected, onConfirm: async () => { await options.onConfirm(); }}; },
    form: () => undefined,
    dialog: (spec) => { overlay = {kind: 'dialog', spec, scroll: 0}; },
    menu: () => undefined, viewer: () => undefined,
    current: () => overlay, close: () => { overlay = undefined; },
    copy, saveAs: vi.fn(), openFile: vi.fn(), requestId: () => 'a'.repeat(32),
    missing: () => { overlay = {kind: 'message', title: 'No longer available', lines: []}; },
  };
  const dialog = () => {
    if (overlay?.kind !== 'dialog') throw new Error(`No dialog open: ${overlay?.kind}`);
    return overlay;
  };
  return {
    ctx, copy, dialog,
    overlay: () => overlay,
    item: <T extends DialogItem['kind']>(id: string) => findDialogItem(dialog().spec.items(), id) as Extract<DialogItem, {kind: T}>,
    press: (id: string) => (findDialogItem(dialog().spec.items(), id) as InlineButton).onPress(),
    blocked: () => dialog().spec.submit?.disabled?.(),
    submit: async () => {
      const reason = dialog().spec.submit?.disabled?.();
      if (reason) throw new Error(reason);
      await dialog().spec.submit!.run();
    },
  };
};

const render = (data: DashboardSnapshot, settingsSection: 'domains' | 'federated-sso' | 'console') =>
  renderTui(data, {page: 'system', systemSection: 'settings', settingsSection}, 121, 70, false);

describe('terminal settings', () => {
  it('edits domains with the browser validation and saves only changes', async () => {
    expect(render(snapshot(), 'domains')).toMatch(/Public Domain +magicstick\.example\.com/);
    expect(validDomain('Example.COM.')).toBe(true);
    expect(validDomain('localhost')).toBe(false);
    const updateSettings = vi.fn(async () => ({}));
    const io = fake(snapshot(), {updateSettings});
    settingsModule.handle(io.ctx, {id: 'settings:domains', scope: 'settings', verb: 'domains', target: ''});
    expect(io.blocked()).toBe('No changes to save.');
    io.item<'text'>('public').onChange('MagicStick.Example.com.');
    expect(io.blocked()).toBe('No changes to save.');
    io.item<'text'>('mdns').onChange('local');
    expect(io.blocked()).toMatch(/Both domains must be valid/);
    io.item<'text'>('mdns').onChange('stick.local');
    await io.submit();
    expect(updateSettings).toHaveBeenCalledWith({publicDomain: 'MagicStick.Example.com.', mdnsDomain: 'stick.local'});
    expect(io.overlay()).toMatchObject({kind: 'message', lines: ['Domain settings saved.']});
  });

  it('shows Federated SSO providers, entitlement state and the provider actions', () => {
    const page = render(snapshot(), 'federated-sso');
    expect(page).toContain('Federated SSO entitlement active.');
    expect(page).toContain('https://id.example.com/realms/magicstick/broker/company-login/endpoint');
    expect(page).toMatch(/Company SSO +● Enabled +OIDC/);
    expect(page).toContain('[Alias: company-login] [1 mapping] [Secret: configured]');
    expect(page).toContain('[ Copy callback ]');
    expect(page).toContain('Recovery and enforcement');
    const unlicensed = render(snapshot({federatedSso: federation(false)}), 'federated-sso');
    expect(unlicensed).toContain('A valid Free Registered or Commercial Federated SSO entitlement is required');
    expect(render(snapshot({federatedSso: undefined, errors: {federatedSso: 'HTTP 502'}}), 'federated-sso')).toContain('Federated SSO could not be loaded: HTTP 502');
    // Without the entitlement the tab cannot be opened, as in the browser.
    expect(render(snapshot({license: license(false)}), 'federated-sso')).toContain('[■ Domains ]');
  });

  it('adds a provider only after metadata validation, with the browser payload', async () => {
    const validateFederation = vi.fn(async () => ({protocol: 'saml', metadataUrl: 'https://idp.example.com/metadata', configuration: {entityId: 'https://idp.example.com'}}));
    const createFederation = vi.fn(async () => ({}));
    const io = fake(snapshot(), {validateFederation, createFederation});
    settingsModule.handle(io.ctx, {id: 'federation:add', scope: 'federation', verb: 'add', target: ''});
    io.item<'choice'>('protocol').onChange('saml');
    expect(io.item('client-id')).toBeUndefined();
    io.item<'text'>('alias').onChange('Bad Alias');
    io.item<'text'>('display').onChange('Partner SSO');
    io.item<'text'>('metadata').onChange('https://idp.example.com/metadata');
    io.item<'text'>('map-value-0').onChange('magicstick-admins');
    io.item<'choice'>('map-level-0').onChange('admin');
    expect(io.blocked()).toMatch(/alias/);
    io.item<'text'>('alias').onChange('partner');
    expect(io.blocked()).toBe('Validate metadata before saving.');
    io.press('validate');
    await vi.waitFor(() => expect(validateFederation).toHaveBeenCalledWith({protocol: 'saml', metadataUrl: 'https://idp.example.com/metadata'}));
    expect(io.blocked()).toBeUndefined();
    io.press('map-add');
    expect(io.blocked()).toMatch(/Every mapping/);
    io.press('map-remove-1');
    // Changing the metadata source invalidates the validation.
    io.item<'text'>('metadata').onChange('https://idp.example.com/metadata2');
    expect(io.blocked()).toBe('Validate metadata before saving.');
    io.item<'text'>('metadata').onChange('https://idp.example.com/metadata');
    io.press('validate');
    await vi.waitFor(() => expect(io.blocked()).toBeUndefined());
    await io.submit();
    expect(createFederation).toHaveBeenCalledWith({
      alias: 'partner', displayName: 'Partner SSO', protocol: 'saml', metadataUrl: 'https://idp.example.com/metadata', enabled: true, trustEmail: false,
      mappings: [{source: 'groups', value: 'magicstick-admins', accessLevel: 'admin'}], expectedRevision: 'new',
    });
  });

  it('edits with a re-entered secret, copies callbacks and deletes only after typing the alias', async () => {
    const updateFederation = vi.fn(async () => ({}));
    const deleteFederation = vi.fn(async () => ({}));
    const validateFederation = vi.fn(async () => ({protocol: 'oidc', metadataUrl: '', configuration: {}}));
    const io = fake(snapshot(), {updateFederation, deleteFederation, validateFederation});
    settingsModule.handle(io.ctx, {id: 'federation:edit:company-login', scope: 'federation', verb: 'edit', target: 'company-login'});
    expect(io.item<'text'>('alias').disabled).toBeTruthy();
    expect(io.item<'choice'>('protocol').disabled).toBeTruthy();
    io.press('validate');
    await vi.waitFor(() => expect(io.blocked()).toMatch(/client secret again/));
    io.item<'text'>('client-secret').onChange('CHANGEME');
    await io.submit();
    expect(updateFederation).toHaveBeenCalledWith('company-login', expect.objectContaining({alias: 'company-login', clientSecret: 'CHANGEME', expectedRevision: 'rev-7'}));

    settingsModule.handle(io.ctx, {id: 'federation:copy:company-login', scope: 'federation', verb: 'copy', target: 'company-login'});
    expect(io.copy).toHaveBeenCalledWith('https://id.example.com/realms/magicstick/broker/company-login/endpoint');

    settingsModule.handle(io.ctx, {id: 'federation:delete:company-login', scope: 'federation', verb: 'delete', target: 'company-login'});
    const confirm = io.overlay();
    expect(confirm).toMatchObject({kind: 'confirm', expected: 'company-login'});
    expect(deleteFederation).not.toHaveBeenCalled();
    if (confirm?.kind === 'confirm') await confirm.onConfirm();
    expect(deleteFederation).toHaveBeenCalledWith('company-login', 'rev-7');

    const unlicensed = fake(snapshot({federatedSso: federation(false)}), {});
    settingsModule.handle(unlicensed.ctx, {id: 'federation:edit:company-login', scope: 'federation', verb: 'edit', target: 'company-login'});
    expect(unlicensed.overlay()).toMatchObject({kind: 'message', title: 'Not available'});
  });

  it('shows the local console texts and saves only a different sign-in level', async () => {
    const page = render(snapshot(), 'console');
    expect(page).toContain('The monitor and keyboard attached to the appliance show the terminal dashboard.');
    expect(render(snapshot({consoleAccess: {available: false, accessLevel: 'off'}}), 'console')).toContain('has not set up automatic console sign-in yet');
    const updateConsoleAccess = vi.fn(async (accessLevel: string) => ({available: true, accessLevel}));
    const io = fake(snapshot(), {updateConsoleAccess});
    settingsModule.handle(io.ctx, {id: 'console:edit', scope: 'console', verb: 'edit', target: ''});
    expect(io.blocked()).toBe('This level is already active.');
    io.item<'choice'>('accessLevel').onChange('viewer');
    expect(io.dialog().spec.items().some((item) => item.kind === 'note' && item.text.includes('gets Viewer (read-only) access without a password'))).toBe(true);
    await io.submit();
    expect(updateConsoleAccess).toHaveBeenCalledWith('viewer');
    expect(io.overlay()).toMatchObject({kind: 'message', lines: ['Local console sign-in saved: Viewer (read-only).']});
  });
});
