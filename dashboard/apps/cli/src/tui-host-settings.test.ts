import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {ManagedHost} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {ConfirmOptions, PerformResult, TuiContext} from './tui-context';
import type {DialogItem, DialogSpec} from './tui-dialogs';
import {hostSettingsModule, networkSection, updatesSection, validChannel, validPolicy} from './tui-host-settings';
import {initialPageState, type PageState} from './tui-state';
import type {Row} from './tui-screen';

const NOW = Date.parse('2026-11-23T12:00:00Z');

const host = (overrides: Partial<ManagedHost> = {}): ManagedHost => ({
  name: 'stick-01', nodeUid: 'uid-1', bootId: 'boot-1', kernel: '6.8.0-example', available: true, message: 'Ready',
  network: {
    id: 'net-plan-1', supported: true, message: '',
    interfaces: [
      {name: 'eth0', kind: 'ethernet', mac: '02:00:00:00:00:01', state: 'UP', addresses: ['198.51.100.10/24'], gateway: '198.51.100.1',
        editable: true, scanSupported: false, clusterAddresses: ['198.51.100.10'], configuredMode: 'dhcp', metric: 100},
      {name: 'wlan0', kind: 'wifi', mac: '02:00:00:00:00:02', state: 'DOWN', addresses: [], editable: true, scanSupported: true,
        clusterAddresses: [], configuredMode: 'dhcp', metric: 600, configuredSsid: 'example-office', hasPassword: true, security: 'wpa-psk'},
    ],
    scan: {interface: 'wlan0', observedAt: '2026-11-23T11:59:00Z', networks: [{ssid: 'example-guest', signal: -61, security: 'open'}, {ssid: 'example-office', signal: -48, security: 'wpa-psk'}]},
  },
  updates: {
    supported: true, id: 'updates-plan-1', busy: false, rebootRequired: true, phase: 'Ready', checkedAt: '2026-11-23T10:00:00Z',
    policy: {mode: 'security', windowStart: '03:00', windowMinutes: 60, automaticReboot: false},
    pendingCount: 3, securityCount: 1, blockedCount: 0, truncated: false,
    packages: [{name: 'example-lib', installed: '1.0', candidate: '1.1', security: true, blocked: ''}],
  },
  software: {
    supported: true, releaseCatalogVersion: 1, id: 'software-plan-1', channel: {kind: 'tag', value: 'v1.0.0'},
    hostCommit: 'a'.repeat(40), previousCommit: 'b'.repeat(40),
  },
  ...overrides,
});

const snapshotWith = (hosts?: ManagedHost[], extra: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  session: {subject: '1', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {}, modules: {} as DashboardSnapshot['modules'], instances: {} as DashboardSnapshot['instances'], status: {},
  models: {activations: [], presets: {}, computeTargets: {targets: []}} as unknown as DashboardSnapshot['models'],
  ...(hosts ? {hosts: {nodes: hosts}} : {}),
  softwareReleases: {fetchedAt: '2026-11-23T11:00:00Z', stale: false, releases: [
    {version: 'v1.1.0', releaseId: 2, url: 'https://example.com/releases/v1.1.0', publishedAt: '2026-11-20T00:00:00Z', prerelease: false, selectable: true},
    {version: 'v1.2.0-rc.1', releaseId: 3, url: 'https://example.com/releases/v1.2.0-rc.1', publishedAt: '2026-11-21T00:00:00Z', prerelease: true, selectable: true},
  ]},
  loadedAt: NOW, ...extra,
});

const plain = (rows: Row[]) => rows.map((row) => row.map((item) => item.text).join('')).join('\n');
const actions = (rows: Row[]) => rows.flatMap((row) => row.flatMap((item) => item.action ? [item.action] : []));

/** A context that records dialogs, confirmations and messages instead of drawing them. */
const fakeContext = (snapshot: DashboardSnapshot, state: PageState = initialPageState()) => {
  const requestHostOperation = vi.fn(async (_request: unknown) => ({accepted: true, requestId: 'r', operation: {phase: 'Pending'}}));
  const confirmHostNetwork = vi.fn(async (_payload: unknown) => ({accepted: true, requestId: 'r'}));
  const record = {dialogs: [] as DialogSpec[], confirms: [] as ConfirmOptions[], messages: [] as Array<{title: string; lines: string | string[]}>, results: [] as Array<PerformResult | void>};
  let ids = 0;
  const ctx = {
    api: {requestHostOperation, confirmHostNetwork} as unknown as MagicStickApi,
    view: state, demo: false,
    snapshot: () => snapshot, session: () => snapshot.session, draw: vi.fn(), refresh: vi.fn(async () => undefined),
    message: (title: string, lines: string | string[]) => { record.messages.push({title, lines}); },
    perform: async (_title: string, operation: () => Promise<PerformResult | void>) => { record.results.push(await operation()); },
    task: vi.fn(), load: vi.fn(), form: vi.fn(), menu: vi.fn(), viewer: vi.fn(), current: () => undefined, close: vi.fn(),
    confirm: (options: ConfirmOptions) => { record.confirms.push(options); },
    dialog: (spec: DialogSpec) => { record.dialogs.push(spec); },
    copy: vi.fn(), saveAs: vi.fn(), openFile: vi.fn(), requestId: () => `request-${++ids}`, missing: () => { record.messages.push({title: 'missing', lines: ''}); },
  } as unknown as TuiContext;
  const act = (id: string) => {
    const [scope = '', verb = '', ...rest] = id.split(':');
    return hostSettingsModule.handle(ctx, {id, scope, verb, target: rest.join(':')});
  };
  return {ctx, act, record, requestHostOperation, confirmHostNetwork};
};

const item = <K extends DialogItem['kind']>(spec: DialogSpec, id: string) =>
  spec.items().find((entry) => 'id' in entry && entry.id === id) as Extract<DialogItem, {kind: K}>;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Settings → Network', () => {
  it('shows each interface with its facts, locked controls and a loading state', () => {
    expect(plain(networkSection(snapshotWith(), initialPageState(), 91).rows)).toContain('Loading network information…');
    expect(plain(networkSection(snapshotWith(undefined, {errors: {hosts: 'HTTP 503'}}), initialPageState(), 91).rows)).toContain('could not be loaded: HTTP 503');

    const view = networkSection(snapshotWith([host()]), initialPageState(), 91);
    const text = plain(view.rows);
    expect(text).toContain('Ethernet · eth0');
    expect(text).toContain('Wi-Fi · wlan0');
    expect(text).toContain('198.51.100.10/24');
    expect(text).toContain('DHCP · Metric 600');
    expect(text).toContain('example-office');
    expect(text).toContain('2 Wi-Fi networks');
    expect(view.tick).toBe(false);
    expect(actions(view.rows).find((action) => action.id === 'network:scan:uid-1/wlan0')?.disabled).toBeUndefined();

    const busy = networkSection(snapshotWith([host({operation: {requestId: 'op', action: 'check-updates', phase: 'Running'}})]), initialPageState(), 91);
    expect(actions(busy.rows).find((action) => action.id === 'network:configure:uid-1/eth0')?.disabled).toContain('Another host operation');
    const unsupported = networkSection(snapshotWith([host({network: {supported: false, message: 'Update the host worker.', interfaces: []}})]), initialPageState(), 91);
    expect(plain(unsupported.rows)).toContain('Update the host worker.');
  });

  it('counts down a network trial and keeps the configuration only on request', async () => {
    vi.useFakeTimers({now: NOW});
    const trial = host({operation: {requestId: 'trial-1', action: 'configure-network', phase: 'AwaitingConfirmation', message: 'Applied temporarily.', confirmationDeadline: new Date(NOW + 90_000).toISOString()}});
    const snapshot = snapshotWith([trial]);
    const view = networkSection(snapshot, initialPageState(), 91);
    expect(view.tick).toBe(true);
    expect(plain(view.rows)).toContain('Automatic rollback in 90 seconds unless confirmed.');
    const {act, confirmHostNetwork, ctx} = fakeContext(snapshot);
    await act('network:keep:uid-1');
    await Promise.resolve();
    expect(confirmHostNetwork).toHaveBeenCalledWith({nodeUid: 'uid-1', requestId: 'trial-1', confirmation: 'stick-01'});
    const after = networkSection(snapshot, ctx.view, 91);
    expect(plain(after.rows)).toContain('Confirmation sent.');
    expect(actions(after.rows).find((action) => action.id === 'network:keep:uid-1')?.disabled).toContain('Confirmation sent');

    vi.setSystemTime(NOW + 120_000);
    expect(actions(networkSection(snapshot, initialPageState(), 91).rows).find((action) => action.id === 'network:keep:uid-1')?.disabled).toContain('ended');
  });

  it('reviews a Wi-Fi change with the host name typed and sends the browser payload once', async () => {
    const snapshot = snapshotWith([host()]);
    const {act, record, requestHostOperation} = fakeContext(snapshot);
    act('network:configure:uid-1/wlan0');
    const spec = record.dialogs[0]!;
    expect(item<'text'>(spec, 'password').required).toBe(false); // Same SSID: the saved password is kept.
    item<'choice'>(spec, 'scanned').onChange('example-guest');
    expect(item<'text'>(spec, 'ssid').value).toBe('example-guest');
    expect(item<'text'>(spec, 'password').required).toBe(true);
    item<'text'>(spec, 'password').onChange('CHANGEME-passphrase');
    item<'choice'>(spec, 'mode').onChange('static');
    item<'text'>(spec, 'address').onChange('198.51.100.20/24');
    item<'text'>(spec, 'gateway').onChange('198.51.100.1');
    item<'text'>(spec, 'dns').onChange('198.51.100.53, 198.51.100.54');
    item<'number'>(spec, 'metric').onChange('70000');
    expect(spec.submit!.disabled!()).toContain('between 1 and 65535');
    item<'number'>(spec, 'metric').onChange('500');
    expect(spec.submit!.disabled!()).toBeUndefined();
    await spec.submit!.run();
    const confirm = record.confirms[0]!;
    expect(confirm.expected).toBe('stick-01');
    expect(confirm.back).toBe(true);
    expect(confirm.confirmLabel).toBe('Apply temporarily');
    expect(confirm.description).toContain('stick-01 · wlan0: 198.51.100.20/24, route metric 500, Wi-Fi example-guest (wpa-psk)');
    expect(confirm.description).toContain('within 3 minutes');
    expect(requestHostOperation).not.toHaveBeenCalled();
    await confirm.onConfirm();
    expect(requestHostOperation).toHaveBeenCalledOnce();
    expect(requestHostOperation.mock.calls[0]![0]).toEqual({
      action: 'configure-network', nodeName: 'stick-01', nodeUid: 'uid-1', bootId: 'boot-1', requestId: 'request-1', planId: 'net-plan-1',
      confirmation: 'stick-01', acknowledgeDisruption: true, allowExperimental: false, experimentMode: false,
      network: {interface: 'wlan0', mode: 'static', address: '198.51.100.20/24', gateway: '198.51.100.1', dns: ['198.51.100.53', '198.51.100.54'], metric: 500,
        ssid: 'example-guest', security: 'wpa-psk', password: 'CHANGEME-passphrase', hidden: false},
    });
    // The password is not kept in the dialog after submitting.
    expect(item<'text'>(spec, 'password').value).toBe('');
  });

  it('refuses a review when the host rebooted after the dialog opened', async () => {
    const snapshot = snapshotWith([host()]);
    const {act, record} = fakeContext(snapshot);
    act('network:configure:uid-1/eth0');
    const spec = record.dialogs[0]!;
    expect(spec.items().some((entry) => 'id' in entry && entry.id === 'ssid')).toBe(false);
    snapshot.hosts = {nodes: [host({bootId: 'boot-2'})]};
    expect(spec.submit!.disabled!()).toContain('Host state changed');
  });

  it('requests a Wi-Fi scan only when the button is used', async () => {
    const snapshot = snapshotWith([host()]);
    const {act, requestHostOperation} = fakeContext(snapshot);
    networkSection(snapshot, initialPageState(), 91);
    expect(requestHostOperation).not.toHaveBeenCalled();
    act('network:scan:uid-1/wlan0');
    await Promise.resolve();
    expect(requestHostOperation.mock.calls[0]![0]).toMatchObject({action: 'scan-wifi', planId: 'net-plan-1', network: {interface: 'wlan0'}, confirmation: 'stick-01'});
  });
});

describe('Settings → Updates', () => {
  it('shows packages, policy and software channel with the same locks as the browser', () => {
    const view = updatesSection(snapshotWith([host()]), initialPageState({expanded: {'pkg:uid-1': true}}), 91);
    const text = plain(view.rows);
    expect(text).toContain('Magic Stick software');
    expect(text).toContain('Current channel');
    expect(text).toContain('tag: v1.0.0');
    expect(text).toContain('Released version · v1.0.0');
    expect(text).toContain('Restart required');
    expect(text).toContain('Security updates');
    expect(text).toContain('example-lib');
    const list = actions(view.rows);
    // The saved v1.0.0 is not in the verified catalog: neither check nor apply is offered for it.
    expect(list.find((action) => action.id === 'updates:apply-channel:uid-1')?.disabled).toContain('verified released version');
    expect(list.find((action) => action.id === 'updates:check-channel:uid-1')?.disabled).toContain('verified released version');
    const listed = updatesSection(snapshotWith([host({software: {...host().software!, channel: {kind: 'tag', value: 'v1.1.0'}}})]), initialPageState(), 91);
    expect(actions(listed.rows).find((action) => action.id === 'updates:check-channel:uid-1')?.disabled).toBeUndefined();
    expect(actions(listed.rows).find((action) => action.id === 'updates:apply-channel:uid-1')?.disabled).toContain('Check this channel first');
    expect(list.find((action) => action.id === 'section:power')).toBeDefined();

    const running = updatesSection(snapshotWith([host({updates: {...host().updates!, busy: true}})]), initialPageState(), 91);
    expect(actions(running.rows).find((action) => action.id === 'updates:install-security:uid-1')?.disabled).toContain('Ubuntu updates are running');
    expect(plain(updatesSection(snapshotWith([host({software: {supported: false, message: 'Update the host worker first.'}})]), initialPageState(), 91).rows)).toContain('Update the host worker first.');
  });

  it('saves an update policy only when it changed and after typing the host name', async () => {
    const {act, record, requestHostOperation} = fakeContext(snapshotWith([host()]));
    act('updates:policy:uid-1');
    const spec = record.dialogs[0]!;
    expect(spec.submit!.disabled!()).toBe('No changes to save.');
    item<'choice'>(spec, 'mode').onChange('all');
    item<'text'>(spec, 'windowStart').onChange('25:00');
    expect(spec.submit!.disabled!()).toContain('HH:MM');
    item<'text'>(spec, 'windowStart').onChange('02:30');
    item<'number'>(spec, 'windowMinutes').onChange('120');
    item<'check'>(spec, 'automaticReboot').onChange(true);
    expect(spec.submit!.disabled!()).toBeUndefined();
    await spec.submit!.run();
    const confirm = record.confirms[0]!;
    expect(confirm.expected).toBe('stick-01');
    expect(confirm.description).toBe('stick-01: Automatic Ubuntu updates daily from 02:30 UTC for 120 minutes. Automatic computer restarts are enabled within the window. Package updates can restart services. Running installations finish even if the window ends.');
    await confirm.onConfirm();
    expect(requestHostOperation.mock.calls[0]![0]).toEqual({
      action: 'configure-updates', nodeName: 'stick-01', nodeUid: 'uid-1', bootId: 'boot-1', planId: 'updates-plan-1', requestId: 'request-1',
      confirmation: 'stick-01', acknowledgeDisruption: true, allowExperimental: false, experimentMode: false,
      updatePolicy: {mode: 'all', windowStart: '02:30', windowMinutes: 120, automaticReboot: true},
    });
  });

  it('installs security updates after a typed confirmation and checks for updates directly', async () => {
    const {act, record, requestHostOperation} = fakeContext(snapshotWith([host()]));
    act('updates:install-security:uid-1');
    const confirm = record.confirms[0]!;
    expect(confirm.title).toBe('Install Ubuntu updates');
    expect(confirm.description).toContain('install security updates now');
    expect(requestHostOperation).not.toHaveBeenCalled();
    await confirm.onConfirm();
    expect(requestHostOperation.mock.calls[0]![0]).toMatchObject({action: 'install-updates', updateScope: 'security', planId: 'updates-plan-1'});
    act('updates:check-updates:uid-1');
    await Promise.resolve();
    expect(requestHostOperation.mock.calls[1]![0]).toMatchObject({action: 'check-updates', planId: 'updates-plan-1'});
  });

  it('selects, checks and applies a released version with the reviewed preview', async () => {
    const snapshot = snapshotWith([host()]);
    const {act, record, requestHostOperation, ctx} = fakeContext(snapshot);
    act('updates:channel:uid-1');
    const spec = record.dialogs[0]!;
    const versions = item<'choice'>(spec, 'version').choices.map((entry) => entry.value);
    expect(versions).toContain('v1.1.0');
    expect(versions).not.toContain('v1.2.0-rc.1');
    item<'check'>(spec, 'prereleases').onChange(true);
    expect(item<'choice'>(spec, 'version').choices.map((entry) => entry.value)).toContain('v1.2.0-rc.1');
    item<'choice'>(spec, 'version').onChange('v1.1.0');
    await spec.submit!.run();
    expect(ctx.close).toHaveBeenCalled();
    expect(plain(updatesSection(snapshot, ctx.view, 91).rows)).toContain('Released version · v1.1.0');

    act('updates:check-channel:uid-1');
    await Promise.resolve();
    expect(requestHostOperation.mock.calls[0]![0]).toEqual({
      action: 'check-software-channel', nodeName: 'stick-01', nodeUid: 'uid-1', bootId: 'boot-1', planId: 'software-plan-1', requestId: 'request-1',
      confirmation: 'stick-01', acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, softwareChannel: {kind: 'tag', value: 'v1.1.0'},
    });

    act('updates:apply-channel:uid-1');
    expect(record.messages.at(-1)?.title).toBe('Not available'); // Not reviewed yet.
    snapshot.hosts = {nodes: [host({software: {...host().software!, preview: {
      id: 'preview-1', configurationId: 'software-plan-1', channel: {kind: 'tag', value: 'v1.1.0'}, commit: 'c'.repeat(40),
      checkedAtEpoch: Date.now() / 1000 - 10, ready: true, images: [{name: 'dashboard', image: 'registry.example.com/dashboard@sha256:0', available: true}],
    }}})]};
    act('updates:apply-channel:uid-1');
    const confirm = record.confirms[0]!;
    expect(confirm.expected).toBe('stick-01');
    expect(confirm.description).toContain('use tag v1.1.0 at cccccccccccc');
    expect(confirm.description).toContain('This revision remains fixed.');
    await confirm.onConfirm();
    expect(requestHostOperation.mock.calls[1]![0]).toMatchObject({action: 'apply-software-channel', softwareChannel: {kind: 'tag', value: 'v1.1.0'}, softwarePreviewId: 'preview-1'});
  });

  it('validates refs and policies like the browser', () => {
    expect(validChannel({kind: 'branch', value: 'feature/example'})).toBe(true);
    expect(validChannel({kind: 'branch', value: 'refs/heads/main'})).toBe(false);
    expect(validChannel({kind: 'branch', value: 'a..b'})).toBe(false);
    expect(validChannel({kind: 'tag', value: 'v1.2.3.lock'})).toBe(false);
    expect(validChannel({kind: 'commit', value: 'f'.repeat(40)})).toBe(true);
    expect(validChannel({kind: 'commit', value: 'f'.repeat(39)})).toBe(false);
    expect(validPolicy({mode: 'manual', windowStart: '23:59', windowMinutes: 360, automaticReboot: false})).toBe(true);
    expect(validPolicy({mode: 'manual', windowStart: '3:00', windowMinutes: 60, automaticReboot: false})).toBe(false);
    expect(validPolicy({mode: 'manual', windowStart: '03:00', windowMinutes: 14, automaticReboot: false})).toBe(false);
  });

  it('selects the previous revision as an exact commit draft', () => {
    const snapshot = snapshotWith([host()]);
    const {act, ctx} = fakeContext(snapshot);
    act('updates:previous:uid-1');
    expect(plain(updatesSection(snapshot, ctx.view, 91).rows)).toContain(`Exact commit · ${'b'.repeat(40)}`);
  });
});
