// System → Settings → Network and Updates: per-computer host operations
// (apps/web/src/pages/NetworkPage.tsx, UpdatesPage.tsx, SoftwareChannelEditor.tsx).
// Edits happen in dialogs; every host change is confirmed by typing the computer name,
// exactly as in the browser. Opening these sections or polling never starts an operation.
import type {
  HostOperationRequest, HostUpdatePolicy, ManagedHost, NetworkInterface, NetworkSettings, SoftwareChannel, SoftwareRelease,
} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {DialogItem} from './tui-dialogs';
import type {PageState, PageView} from './tui-state';
import {badge, button, fit, gap, joinSpans, link, panel, prose, span, table, toggle, type Row, type Span} from './tui-screen';
import {blank, dateTime, facts, heading, loadingRows, statusBadge, terminalHostPhases, text} from './tui-widgets';

type HostSoftware = NonNullable<ManagedHost['software']>;
type HostUpdates = NonNullable<ManagedHost['updates']>;

const NETWORK_INFO = "Ethernet and Wi-Fi use Ubuntu's existing Netplan backend. Changes require exact-host confirmation and a second confirmation after applying. Passwords are never returned by the API. A local rollback service does not depend on dashboard connectivity; retain console access for recovery.";
const UPDATES_INFO = 'Updates use the configured Ubuntu APT mirrors. Automatic installations start in the UTC maintenance window; busy hosts retry inside that window. Running package transactions may finish later. Kernel, GPU driver and firmware updates remain in Hardware preparation. K3s, operators and container images use the Magic Stick release workflow. Services may restart during package installation.';
const SOFTWARE_INFO = 'Choose a published product version to keep a fixed, reviewed host and cluster revision. Development branches follow new commits automatically and are not stable releases. Checking or refreshing the version list never starts an update. Ubuntu updates are configured separately below.';

const hostsOf = (snapshot: DashboardSnapshot) => snapshot.hosts?.nodes ?? [];
const findHost = (snapshot: DashboardSnapshot, nodeUid: string) => hostsOf(snapshot).find((host) => host.nodeUid === nodeUid);
const operationActive = (host: ManagedHost) => Boolean(host.operation && !terminalHostPhases.has(host.operation.phase));
const stale = (snapshot: DashboardSnapshot) => Boolean(snapshot.errors?.hosts);
/** `nodeUid/interface` in action ids; interface names never contain a slash. */
const splitTarget = (target: string): [string, string] => {
  const index = target.indexOf('/');
  return index < 0 ? [target, ''] : [target.slice(0, index), target.slice(index + 1)];
};
const when = (value?: string) => value ? dateTime(value) : 'Not yet';
const lines = (width: number, value: string, tone?: Parameters<typeof prose>[2]) => prose(width, value, tone);

// ── Network ────────────────────────────────────────────────────────────────

/** The request the browser sends for network changes and Wi-Fi scans (NetworkPage identity()). */
export const networkRequest = (host: ManagedHost, action: 'configure-network' | 'scan-wifi', network: NetworkSettings, requestId: string): HostOperationRequest => ({
  action, nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId,
  requestId, planId: host.network?.id,
  confirmation: host.name, acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, network,
});

/** Why network controls of a host are locked (the browser's disabled fieldset), if they are. */
const networkBlocked = (snapshot: DashboardSnapshot, host: ManagedHost) => stale(snapshot) ? 'Host information is unavailable or stale. Refresh before changing the network.'
  : !host.available ? `${host.name} is currently unavailable.`
    : operationActive(host) ? 'Another host operation is in progress on this computer.'
      : !host.network?.supported ? host.network?.message || 'Network management requires the updated host worker.' : undefined;

const remainingSeconds = (deadline?: string, now = Date.now()) => deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : 0;

const interfaceInfo = (device: NetworkInterface) => [
  "Lower route metrics are preferred. Only this interface's IPv4 and Wi-Fi settings are edited; IPv6 and the current backend are retained. Complex topologies require the local console.",
  ...(device.clusterAddresses.length ? ['This interface carries the Kubernetes management address; address migration and switching its SSID are blocked.'] : []),
  ...(device.kind === 'wifi' ? ['The selected SSID replaces this interface’s configured access-point list. Enterprise Wi-Fi authentication requires local configuration.'] : []),
];

const trialRows = (host: ManagedHost, state: PageState, inner: number, now: number): {rows: Row[]; tick: boolean} => {
  const operation = host.operation;
  if (!operation || !['configure-network', 'scan-wifi'].includes(operation.action)) return {rows: [], tick: false};
  const awaiting = operation.phase === 'AwaitingConfirmation';
  const remaining = remainingSeconds(operation.confirmationDeadline, now);
  const kept = state.ui[`network.kept.${operation.requestId}`] === '1';
  return {tick: awaiting, rows: [
    fit(inner, [span(`${operation.action === 'scan-wifi' ? 'Wi-Fi scan' : 'Network change'} · ${operation.phase}`, terminalHostPhases.has(operation.phase) ? undefined : 'warn', true)]),
    ...(operation.message ? lines(inner, operation.message, 'dim') : []),
    ...(awaiting ? [
      ...lines(inner, `Check that the connection works. Automatic rollback in ${remaining} seconds unless confirmed.`, 'warn'),
      fit(inner, [button(`network:keep:${host.nodeUid}`, 'Keep this network configuration', 'primary',
        !remaining ? 'The confirmation period has ended; the host restores the previous configuration.'
          : kept ? 'Confirmation sent. Waiting for the host to save the configuration.' : undefined)]),
      ...(kept ? lines(inner, 'Confirmation sent. Waiting for the host to save the configuration.', 'dim') : []),
    ] : []),
    blank,
  ]};
};

const interfaceCard = (snapshot: DashboardSnapshot, state: PageState, host: ManagedHost, device: NetworkInterface, width: number): Row[] => {
  const inner = width - 4;
  const wifi = device.kind === 'wifi';
  const blocked = networkBlocked(snapshot, host);
  const target = `${host.nodeUid}/${device.name}`;
  const scan = host.network?.scan;
  const results = wifi && scan?.interface === device.name ? scan : undefined;
  const open = state.expanded[`net-scan:${target}`] ?? false;
  return panel(width, {title: `${wifi ? 'Wi-Fi' : 'Ethernet'} · ${device.name}`, status: statusBadge(device.state === 'UP' ? 'Ready' : device.state)}, [
    ...facts(inner, [
      ['Addresses', device.addresses.join(', ') || 'No address'],
      ['MAC address', device.mac],
      ['IPv4', `${device.configuredMode === 'static' ? 'Static' : 'DHCP'} · Metric ${device.metric ?? '—'}`],
      ['Gateway', device.gateway || '—'],
      ...(wifi ? [['Connected Wi-Fi', device.connectedSsid || 'Not connected'], ['Configured Wi-Fi', device.configuredSsid || 'Not configured']] as Array<[string, string]> : []),
    ]),
    fit(inner, [], joinSpans([
      button(`network:info:${target}`, 'Info'),
      ...(wifi ? [button(`network:scan:${target}`, 'Scan Wi-Fi', 'ghost', blocked ?? (!device.scanSupported ? 'Wi-Fi scanning is not supported for this interface.' : undefined))] : []),
      button(`network:configure:${target}`, 'Configure', 'primary', blocked ?? (!device.editable ? 'This interface cannot be changed here. Complex topologies require the local console.' : undefined)),
    ])),
    ...(results ? [
      fit(inner, [toggle(`expand:net-scan:${target}`, `${results.networks.length} Wi-Fi networks · ${new Date(results.observedAt).toLocaleTimeString()}`, open)]),
      ...(open ? results.networks.map((network) => fit(inner, [gap(2), span(network.ssid)], [span(`${network.signal ?? '?'} dBm · ${network.security}`, 'dim')])) : []),
    ] : []),
  ]);
};

export const networkSection = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const inner = width - 4;
  const head = heading(width, 'Network', '', joinSpans([button('network:info', 'Info'), button('network:refresh', 'Refresh network')]));
  const hosts = snapshot.hosts?.nodes;
  if (!hosts) return {hotkeys: [], rows: [...head, ...loadingRows(width, snapshot.errors?.hosts, 'Network information')]};
  const now = Date.now();
  let tick = false;
  const rows = hosts.flatMap((host) => {
    const trial = trialRows(host, state, inner, now);
    tick ||= trial.tick;
    const interfaces = host.network?.interfaces ?? [];
    return panel(width, {title: host.name, status: host.available ? undefined : badge('Unavailable', 'warn')}, [
      ...trial.rows,
      ...(!host.network?.supported ? lines(inner, host.network?.message ?? 'Network management requires the updated host worker.', 'dim') : []),
      ...interfaces.flatMap((device) => interfaceCard(snapshot, state, host, device, inner)),
      ...(host.network?.supported && !interfaces.length ? [text(inner, 'No physical Ethernet or Wi-Fi interfaces detected.', 'dim')] : []),
    ]);
  });
  return {hotkeys: [], tick, rows: [
    ...head,
    ...(stale(snapshot) ? lines(width, `Host information could not be refreshed: ${snapshot.errors?.hosts}`, 'bad') : []),
    ...rows,
    ...(hosts.length ? [] : [text(width, 'No manageable computers reported.', 'dim')]),
  ]};
};

const configureNetwork = (ctx: TuiContext, nodeUid: string, name: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  const device = host?.network?.interfaces.find((item) => item.name === name);
  if (!host || !device) return ctx.missing();
  const blocked = networkBlocked(ctx.snapshot(), host) ?? (!device.editable ? 'This interface cannot be changed here. Complex topologies require the local console.' : undefined);
  if (blocked) return ctx.message('Not available', blocked);
  const opened = {bootId: host.bootId, planId: host.network?.id};
  const wifi = device.kind === 'wifi';
  const draft = {
    mode: device.configuredMode ?? 'dhcp', address: device.configuredAddress ?? '', gateway: device.configuredGateway ?? '',
    dns: device.dns?.join(', ') ?? '', metric: String(device.metric ?? (wifi ? 600 : 100)),
    ssid: device.configuredSsid ?? '', security: device.security ?? 'wpa-psk', password: '', hidden: device.hidden ?? false,
  };
  // The draft belongs to this boot and plan, like the browser's keyed editor.
  const live = () => {
    const current = findHost(ctx.snapshot(), nodeUid);
    return current && current.bootId === opened.bootId && current.network?.id === opened.planId ? current : undefined;
  };
  const keepsPassword = () => Boolean(device.hasPassword) && draft.ssid === device.configuredSsid;
  const settings = (): NetworkSettings => ({
    interface: device.name, mode: draft.mode, ...(draft.mode === 'static' ? {address: draft.address, gateway: draft.gateway} : {}),
    dns: draft.dns.split(/[\s,]+/).filter(Boolean), metric: Number(draft.metric),
    ...(wifi ? {ssid: draft.ssid, security: draft.security, password: draft.security === 'open' ? '' : draft.password, hidden: draft.hidden} : {}),
  });
  const invalid = () => {
    const current = live();
    if (!current) return 'Host state changed. Close this dialog and review the current network configuration again.';
    const reason = networkBlocked(ctx.snapshot(), current);
    if (reason) return reason;
    if (!/^\d+$/.test(draft.metric.trim()) || Number(draft.metric) < 1 || Number(draft.metric) > 65535) return 'Enter a route metric between 1 and 65535.';
    if (wifi && Array.from(draft.ssid).length > 32) return 'The SSID can have at most 32 characters.';
    return undefined;
  };
  const review = () => {
    const current = live();
    const reason = invalid();
    if (!current || reason) throw new Error(reason ?? 'Host state changed.');
    const description = `${current.name} · ${device.name}: ${draft.mode === 'dhcp' ? 'DHCP' : draft.address}, route metric ${draft.metric}${wifi ? `, Wi-Fi ${draft.ssid} (${draft.security})` : ''}. Network access and running services may be interrupted. The host restores the previous Netplan configuration if you do not confirm the working connection within 3 minutes. Keep local console access available. This does not migrate the Kubernetes management address.${wifi && draft.security === 'open' ? ' This Wi-Fi network is unencrypted.' : ''}`;
    ctx.confirm({title: 'Apply network trial', description, confirmLabel: 'Apply temporarily', expected: current.name, danger: true, back: true, onConfirm: async () => {
      const target = live();
      const blockedNow = invalid();
      if (!target || blockedNow) throw new Error(blockedNow ?? 'Host state changed.');
      const network = settings();
      try {
        await ctx.perform(`Configure ${device.name} on ${target.name}`, async () => {
          await ctx.api.requestHostOperation(networkRequest(target, 'configure-network', network, ctx.requestId()));
          return {lines: [
            `Network change requested for ${device.name} on ${target.name}.`,
            'When it is applied, check the connection and confirm it under System → Settings → Network within 3 minutes; otherwise the host restores the previous configuration.',
          ]};
        });
      } finally {
        // Never keep the Wi-Fi password once it was submitted.
        draft.password = '';
      }
    }});
  };
  ctx.dialog({
    title: `Configure ${device.name}`,
    description: `${host.name} · ${wifi ? 'Wi-Fi' : 'Ethernet'}. ${interfaceInfo(device).join(' ')}`,
    items: () => {
      const scan = ctx.snapshot().hosts?.nodes.find((item) => item.nodeUid === nodeUid)?.network?.scan;
      const networks = scan?.interface === device.name ? scan.networks : [];
      const items: DialogItem[] = [];
      if (wifi) {
        if (networks.length) items.push({kind: 'choice', id: 'scanned', label: 'Scanned networks', value: networks.some((item) => item.ssid === draft.ssid) ? draft.ssid : '',
          choices: [{value: '', label: 'Enter the SSID below'}, ...networks.map((item) => ({value: item.ssid, label: `${item.ssid} · ${item.signal ?? '?'} dBm · ${item.security}`}))],
          onChange: (value) => { if (value) draft.ssid = value; }});
        items.push(
          {kind: 'text', id: 'ssid', label: 'Wi-Fi network (SSID)', value: draft.ssid, required: true, maxLength: 32, onChange: (value) => { draft.ssid = value; }},
          {kind: 'choice', id: 'security', label: 'Wi-Fi security', value: draft.security, choices: [{value: 'wpa-psk', label: 'WPA personal'}, {value: 'open', label: 'Open (unencrypted)'}],
            onChange: (value) => { draft.security = value as typeof draft.security; }},
          ...(draft.security === 'wpa-psk' ? [{kind: 'text' as const, id: 'password', label: 'Wi-Fi password', value: draft.password, secret: true, maxLength: 64,
            required: !keepsPassword(), hint: keepsPassword() ? 'Leave empty to keep saved password' : undefined, onChange: (value: string) => { draft.password = value; }}] : []),
          {kind: 'check', id: 'hidden', label: 'Hidden network', checked: draft.hidden, onChange: (checked) => { draft.hidden = checked; }},
        );
      }
      items.push(
        {kind: 'choice', id: 'mode', label: 'IPv4 configuration', value: draft.mode, choices: [{value: 'dhcp', label: 'Automatic (DHCP)'}, {value: 'static', label: 'Static IPv4'}],
          onChange: (value) => { draft.mode = value as typeof draft.mode; }},
        {kind: 'number', id: 'metric', label: 'Route metric', value: draft.metric, min: 1, max: 65535, step: 1, required: true, onChange: (value) => { draft.metric = value; }},
        ...(draft.mode === 'static' ? [
          {kind: 'text' as const, id: 'address', label: 'IPv4 address / prefix', value: draft.address, required: true, hint: '198.51.100.10/24', onChange: (value: string) => { draft.address = value; }},
          {kind: 'text' as const, id: 'gateway', label: 'IPv4 gateway', value: draft.gateway, hint: '198.51.100.1', onChange: (value: string) => { draft.gateway = value; }},
        ] : []),
        {kind: 'text', id: 'dns', label: 'DNS servers', value: draft.dns, hint: 'Automatic with DHCP; comma separated', onChange: (value) => { draft.dns = value; }},
      );
      return items;
    },
    submit: {label: 'Review network change', disabled: invalid, run: review},
  });
};

const scanWifi = (ctx: TuiContext, nodeUid: string, name: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  const device = host?.network?.interfaces.find((item) => item.name === name);
  if (!host || !device) return ctx.missing();
  const blocked = networkBlocked(ctx.snapshot(), host) ?? (!device.scanSupported ? 'Wi-Fi scanning is not supported for this interface.' : undefined);
  if (blocked) return ctx.message('Not available', blocked);
  void ctx.perform(`Scan Wi-Fi on ${host.name}`, async () => {
    await ctx.api.requestHostOperation(networkRequest(host, 'scan-wifi', {interface: device.name}, ctx.requestId()));
    return {lines: [`A Wi-Fi scan was requested on ${device.name}. The networks appear below the interface when ${host.name} reports them.`]};
  });
};

const keepNetwork = (ctx: TuiContext, nodeUid: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  if (!host) return ctx.missing();
  const operation = host.operation;
  if (!operation || operation.phase !== 'AwaitingConfirmation') return ctx.message('Nothing to confirm', 'No network change on this computer is waiting for confirmation.');
  if (!remainingSeconds(operation.confirmationDeadline)) return ctx.message('Confirmation period ended', 'The host restores the previous network configuration.');
  if (ctx.view.ui[`network.kept.${operation.requestId}`] === '1') return ctx.message('Already confirmed', 'Confirmation sent. Waiting for the host to save the configuration.');
  void ctx.perform('Keep this network configuration', async () => {
    await ctx.api.confirmHostNetwork({nodeUid: host.nodeUid, requestId: operation.requestId, confirmation: host.name});
    ctx.view.ui[`network.kept.${operation.requestId}`] = '1';
    return {lines: ['Confirmation sent. Waiting for the host to save the configuration.']};
  });
};

// ── Magic Stick software channel ──────────────────────────────────────────

type ChannelMode = 'release' | 'main' | 'branch' | 'tag' | 'commit';
interface ChannelDraft {mode: ChannelMode; channel: SoftwareChannel; prereleases: boolean}

const same = (a?: SoftwareChannel, b?: SoftwareChannel) => a?.kind === b?.kind && a?.value === b?.value;
export const shortRevision = (value?: string) => value ? value.replace(/^(?:.*@)?sha1:/, '').slice(0, 12) : 'Unknown';
const productTag = (channel?: SoftwareChannel) => channel?.kind === 'tag' && /^v\d+\.\d+\.\d+(?:-.*)?$/.test(channel.value);
const modeOf = (channel?: SoftwareChannel): ChannelMode => productTag(channel) ? 'release'
  : channel?.kind === 'branch' && channel.value === 'main' ? 'main' : channel?.kind ?? 'release';
const channelForMode = (mode: ChannelMode): SoftwareChannel => mode === 'main' ? {kind: 'branch', value: 'main'}
  : {kind: mode === 'release' ? 'tag' : mode, value: ''};

/** The same ref validation as the browser's channel editor. */
export const validChannel = (channel: SoftwareChannel) => channel.kind === 'commit' ? /^[a-fA-F0-9]{40}$/.test(channel.value)
  : /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(channel.value) && !channel.value.includes('..')
    && !channel.value.includes('//') && !channel.value.startsWith('refs/') && !/[/.]$/.test(channel.value)
    && !channel.value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));

const draftKey = (host: ManagedHost) => `updates.channel.${host.nodeUid}`;
/** The channel being prepared for a host: kept in the view while checking and applying, reset by a reboot. */
const channelDraft = (ui: Record<string, string>, host: ManagedHost): ChannelDraft => {
  try {
    const saved = JSON.parse(ui[draftKey(host)] ?? '') as ChannelDraft & {bootId?: string};
    if (saved.bootId === host.bootId && saved.channel && saved.mode) return {mode: saved.mode, channel: saved.channel, prereleases: Boolean(saved.prereleases)};
  } catch { /* no saved draft */ }
  const channel = host.software?.channel;
  return {mode: modeOf(channel), channel: channel ?? {kind: 'branch', value: 'main'}, prereleases: Boolean(productTag(channel) && channel?.value.includes('-'))};
};
const storeDraft = (ui: Record<string, string>, host: ManagedHost, draft: ChannelDraft) => {
  ui[draftKey(host)] = JSON.stringify({...draft, bootId: host.bootId});
};

interface SoftwareModel {
  software: HostSoftware;
  draft: ChannelDraft;
  disabled?: string;
  releaseSupported: boolean;
  catalogUnavailable: boolean;
  visibleVersions: SoftwareRelease[];
  selectedRelease?: SoftwareRelease;
  valid: boolean;
  releaseValid: boolean;
  reviewed: boolean;
  applicable: boolean;
  /** Why Check channel cannot be used, if it cannot. */
  checkBlocked?: string;
  /** Why Apply channel cannot be used, if it cannot. */
  applyBlocked?: string;
}

const softwareDisabled = (snapshot: DashboardSnapshot, host: ManagedHost, software: HostSoftware) => stale(snapshot) ? 'Host information is unavailable or stale.'
  : !host.available ? `${host.name} is currently unavailable.`
    : software.busy ? 'A software change is in progress.'
      : host.updates?.busy ? 'Ubuntu updates are running.'
        : operationActive(host) ? 'Another host operation is in progress on this computer.' : undefined;

const softwareModel = (snapshot: DashboardSnapshot, host: ManagedHost, draft: ChannelDraft, now = Date.now()): SoftwareModel | undefined => {
  const software = host.software;
  if (!software?.supported || !software.channel) return undefined;
  const catalog = snapshot.softwareReleases;
  const releases = Array.isArray(catalog?.releases) ? catalog.releases : [];
  const visibleVersions = releases.filter((item) => draft.prereleases || !item.prerelease);
  const selectedRelease = visibleVersions.find((item) => item.version === draft.channel.value);
  const catalogUnavailable = !catalog || Boolean(snapshot.errors?.softwareReleases) || catalog.stale !== false;
  const releaseSupported = software.releaseCatalogVersion === 1;
  const releaseValid = draft.mode !== 'release' || (releaseSupported && !catalogUnavailable && selectedRelease?.selectable === true);
  const valid = validChannel(draft.channel);
  const changed = !same(draft.channel, software.channel);
  const preview = software.preview;
  const age = preview ? now / 1000 - preview.checkedAtEpoch : -1;
  const reviewed = Boolean(preview?.ready && same(preview.channel, draft.channel) && preview.configurationId === software.id && age >= 0 && age <= 900);
  const applicable = reviewed && (changed || preview?.commit !== software.hostCommit || Boolean(software.blocked));
  const disabled = softwareDisabled(snapshot, host, software);
  const invalidReason = !valid ? draft.mode === 'release' ? 'Choose a released version first.' : 'Enter a valid branch, tag or 40-character commit first.'
    : !releaseValid ? !releaseSupported ? 'Version selection requires the current release-aware host worker.'
      : catalogUnavailable ? 'The release catalog is loading, stale or unavailable. Refresh versions first.' : 'Choose a verified released version.' : undefined;
  return {
    software, draft, disabled, releaseSupported, catalogUnavailable, visibleVersions, selectedRelease, valid, releaseValid, reviewed, applicable,
    checkBlocked: disabled ?? invalidReason,
    applyBlocked: disabled ?? invalidReason ?? (!reviewed ? 'Check this channel first. A check result can be applied for 15 minutes.' : !applicable ? 'This revision is already active.' : undefined),
  };
};

const channelText = (draft: ChannelDraft) => draft.mode === 'release' ? `Released version · ${draft.channel.value || 'not chosen'}`
  : draft.mode === 'main' ? 'Development · main'
    : `${draft.mode === 'branch' ? 'Other branch' : draft.mode === 'tag' ? 'Other tag' : 'Exact commit'} · ${draft.channel.value || 'not entered'}`;

const catalogRows = (snapshot: DashboardSnapshot, model: SoftwareModel, inner: number): Row[] => {
  const catalog = snapshot.softwareReleases;
  const error = snapshot.errors?.softwareReleases;
  return [
    ...(!model.releaseSupported ? lines(inner, 'Version selection requires the current release-aware host worker. Existing branch and commit settings are preserved.', 'dim') : []),
    ...(!catalog && !error ? lines(inner, 'Loading released versions…', 'dim')
      : catalog?.stale ? lines(inner, catalog.message ?? 'The release catalog is stale. Refresh before checking or applying a version.', 'warn')
        : catalog && !model.visibleVersions.some((item) => item.selectable) ? lines(inner, `No verified ${model.draft.prereleases ? 'product versions' : 'stable versions'} are published. A development branch is never selected automatically.`, 'dim') : []),
    ...(error ? lines(inner, `Released versions could not be loaded: ${error}`, 'bad') : []),
  ];
};

const releaseRows = (release: SoftwareRelease | undefined, inner: number): Row[] => release ? [
  fit(inner, [span(`${release.prerelease ? 'Prerelease' : 'Released'} · ${release.publishedAt.slice(0, 10)} · Release notes `, 'dim'), link(release.url)]),
  ...(release.reason ? lines(inner, release.reason, 'dim') : []),
] : [];

const softwareRows = (snapshot: DashboardSnapshot, state: PageState, host: ManagedHost, inner: number): Row[] => {
  const software = host.software;
  if (!software?.supported || !software.channel) return [
    fit(inner, [span('Magic Stick software', undefined, true)]),
    ...lines(inner, software?.message ?? 'Software channel management requires the current host worker.', 'dim'),
  ];
  const model = softwareModel(snapshot, host, channelDraft(state.ui, host))!;
  const draft = model.draft;
  const observed = software.observed;
  const freshObserved = Boolean(observed?.checkedAtEpoch && Date.now() / 1000 - observed.checkedAtEpoch < 180);
  const converged = freshObserved && observed?.ready && software.hostCommit
    && observed.appliedRevision?.endsWith(software.hostCommit) && observed.sourceRevision?.endsWith(software.hostCommit);
  const preview = software.preview;
  const lastResult = software.operation;
  const imagesOpen = state.expanded[`sw-images:${host.nodeUid}`] ?? false;
  const runningOpen = state.expanded[`sw-running:${host.nodeUid}`] ?? false;
  return [
    fit(inner, [span('Magic Stick software', undefined, true)], [
      statusBadge(software.busy ? 'Updating' : software.blocked ? 'Needs attention' : converged ? 'Ready' : 'Checking'), gap(2),
      button('updates:info-software', 'Info'),
    ]),
    ...facts(inner, [
      ['Current channel', `${software.channel.kind}: ${software.channel.value}`],
      ['Host revision', shortRevision(software.hostCommit)],
      ['Cluster revision', freshObserved ? shortRevision(observed?.appliedRevision) : 'Unknown'],
      ['Selected channel', channelText(draft)],
    ]),
    ...(software.blocked ? lines(inner, 'Automatic software updates are paused after an incomplete change. Review the result and check a channel again, or use local software recovery.', 'warn') : []),
    ...(draft.mode === 'release' ? [...catalogRows(snapshot, model, inner), ...releaseRows(model.selectedRelease, inner)] : []),
    ...(draft.channel.kind === 'branch' ? lines(inner, 'This is a development branch, not a stable release. Future commits also update host automation.', 'warn') : []),
    fit(inner, [], joinSpans([
      button(`updates:channel:${host.nodeUid}`, 'Change channel', 'ghost', model.disabled),
      ...(draft.mode === 'release' ? [button('updates:refresh-versions', 'Refresh versions')] : []),
      button(`updates:check-channel:${host.nodeUid}`, 'Check channel', 'ghost', model.checkBlocked),
      button(`updates:apply-channel:${host.nodeUid}`, 'Apply channel', 'primary', model.applyBlocked),
      ...(software.previousCommit ? [button(`updates:previous:${host.nodeUid}`, 'Select previous revision', 'ghost', model.disabled)] : []),
    ])),
    ...(model.reviewed && preview ? [
      blank,
      fit(inner, [span(`Checked revision: ${shortRevision(preview.commit)}`, undefined, true)]),
      ...(preview.release ? [
        ...lines(inner, `Verified release: ${preview.release.version}`),
        ...lines(inner, `Magic Stick source: BUSL-1.1 · first public distribution ${preview.release.license.firstPublicDistribution} · Change License MIT from ${preview.release.license.changeDate}.`, 'dim'),
        ...lines(inner, 'Third-party components retain their own licenses. Installing a version does not grant a commercial entitlement.', 'dim'),
      ] : []),
      fit(inner, [toggle(`expand:sw-images:${host.nodeUid}`, `Published images (${preview.images.length})`, imagesOpen)]),
      ...(imagesOpen ? preview.images.flatMap((item) => [fit(inner, [gap(2), span(item.name, undefined, true)]), ...lines(inner - 4, item.image, 'dim').map((row) => [gap(4), ...row])]) : []),
    ] : []),
    ...(lastResult?.message ? lines(inner, `${lastResult.phase} · ${lastResult.message}`, lastResult.phase === 'Failed' || lastResult.phase === 'Interrupted' ? 'warn' : 'dim') : []),
    fit(inner, [toggle(`expand:sw-running:${host.nodeUid}`, 'Running software details', runningOpen)]),
    ...(runningOpen ? [
      ...facts(inner, [['Source revision', observed?.sourceRevision || 'Unknown']]),
      ...(observed?.images ?? []).flatMap((item) => [
        fit(inner, [gap(2), span(item.name, undefined, true), span(` · ${freshObserved && item.ready ? 'Ready' : 'Not verified'}`, 'dim')]),
        ...lines(inner - 4, item.imageId || item.image, 'dim').map((row) => [gap(4), ...row]),
      ]),
    ] : []),
  ];
};

/** The request the browser sends to check or apply a software channel (SoftwareChannelEditor payload()). */
export const softwareRequest = (host: ManagedHost, software: HostSoftware, action: 'check-software-channel' | 'apply-software-channel', channel: SoftwareChannel, requestId: string, previewId?: string): HostOperationRequest => ({
  action, nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId, planId: software.id,
  requestId, confirmation: host.name,
  acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, softwareChannel: channel,
  ...(action === 'apply-software-channel' ? {softwarePreviewId: previewId} : {}),
});

const editChannel = (ctx: TuiContext, nodeUid: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  if (!host?.software?.supported || !host.software.channel) return ctx.missing();
  const initial = softwareModel(ctx.snapshot(), host, channelDraft(ctx.view.ui, host))!;
  if (initial.disabled) return ctx.message('Not available', initial.disabled);
  const draft: ChannelDraft = {...initial.draft, channel: {...initial.draft.channel}};
  const model = () => {
    const current = findHost(ctx.snapshot(), nodeUid);
    return current ? softwareModel(ctx.snapshot(), current, draft) : undefined;
  };
  ctx.dialog({
    title: `Software channel · ${host.name}`,
    description: SOFTWARE_INFO,
    items: () => {
      const current = model();
      if (!current) return [{kind: 'note', text: 'This computer is no longer reported. Close this dialog.', tone: 'warn'}];
      const items: DialogItem[] = [
        {kind: 'choice', id: 'mode', label: 'Software channel', value: draft.mode, choices: [
          {value: 'release', label: 'Released version'}, {value: 'main', label: 'Development · main'},
          {value: 'branch', label: 'Other branch (advanced)'}, {value: 'tag', label: 'Other tag (advanced)'}, {value: 'commit', label: 'Exact commit (advanced)'},
        ], onChange: (value) => { draft.mode = value as ChannelMode; draft.channel = channelForMode(draft.mode); }},
      ];
      if (draft.mode === 'release') {
        const locked = !current.releaseSupported ? 'Version selection requires the current release-aware host worker.'
          : current.catalogUnavailable ? 'The release catalog is loading, stale or unavailable. Refresh versions first.' : undefined;
        const listed = current.visibleVersions.some((item) => item.version === draft.channel.value);
        items.push(
          {kind: 'choice', id: 'version', label: 'Version', value: draft.channel.value, disabled: locked, choices: [
            {value: '', label: 'Choose a released version'},
            ...(draft.channel.value && !listed ? [{value: draft.channel.value, label: `${draft.channel.value} · not in the current verified list`, disabled: 'Not in the current verified list.'}] : []),
            ...current.visibleVersions.map((item) => ({
              value: item.version,
              label: `${item.version}${item.prerelease ? ' · prerelease' : ''}${!item.selectable ? ' · not verified' : ''}`,
              ...(!item.selectable ? {disabled: item.reason ?? 'Not verified.'} : {}),
            })),
          ], onChange: (value) => { draft.channel = {kind: 'tag', value}; }},
          {kind: 'check', id: 'prereleases', label: 'Show prereleases', checked: draft.prereleases, onChange: (checked) => {
            draft.prereleases = checked;
            if (!checked && draft.channel.value.includes('-')) draft.channel = {kind: 'tag', value: ''};
          }},
          {kind: 'buttons', items: [{id: 'refresh-versions', label: 'Refresh versions', onPress: () => { void ctx.refresh({releases: true}); }}]},
          ...catalogNotes(ctx.snapshot(), current),
          ...(current.selectedRelease ? [{kind: 'note' as const, text: `${current.selectedRelease.prerelease ? 'Prerelease' : 'Released'} · ${current.selectedRelease.publishedAt.slice(0, 10)} · Release notes: ${current.selectedRelease.url}${current.selectedRelease.reason ? ` · ${current.selectedRelease.reason}` : ''}`}] : []),
        );
      } else if (draft.mode !== 'main') {
        const commit = draft.channel.kind === 'commit';
        items.push({kind: 'text', id: 'value', label: draft.channel.kind === 'branch' ? 'Branch name' : draft.channel.kind === 'tag' ? 'Tag name' : 'Full commit',
          value: draft.channel.value, maxLength: commit ? 40 : 200, hint: draft.channel.kind === 'branch' ? 'feature/my-change' : draft.channel.kind === 'tag' ? 'v1.2.3' : '40-character commit',
          onChange: (value) => { draft.channel = {...draft.channel, value: commit ? value.toLowerCase() : value}; }});
      }
      if (draft.channel.kind === 'branch') items.push({kind: 'note', text: 'This is a development branch, not a stable release. Future commits also update host automation.', tone: 'warn'});
      items.push({kind: 'note', text: 'Selecting a channel changes nothing on the computer. Check channel reviews the exact revision; Apply channel changes it after a second confirmation.'});
      return items;
    },
    submit: {label: 'Use this channel', disabled: () => {
      const current = model();
      if (!current) return 'This computer is no longer reported.';
      if (current.disabled) return current.disabled;
      return current.valid ? undefined : draft.mode === 'release' ? 'Choose a released version.' : 'Enter a valid branch, tag or 40-character commit.';
    }, run: () => {
      const current = findHost(ctx.snapshot(), nodeUid);
      if (!current) throw new Error('This computer is no longer reported.');
      storeDraft(ctx.view.ui, current, draft);
      ctx.close();
    }},
  });
};

const catalogNotes = (snapshot: DashboardSnapshot, model: SoftwareModel): DialogItem[] => catalogRows(snapshot, model, 200)
  .map((row) => ({kind: 'note' as const, text: row.map((item) => item.text).join('').trim(), tone: row[0]?.style?.tone}));

const checkChannel = (ctx: TuiContext, nodeUid: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  if (!host) return ctx.missing();
  const model = softwareModel(ctx.snapshot(), host, channelDraft(ctx.view.ui, host));
  if (!model) return ctx.missing();
  if (model.checkBlocked) return ctx.message('Not available', model.checkBlocked);
  const channel = {...model.draft.channel};
  void ctx.perform(`Check software channel on ${host.name}`, async () => {
    await ctx.api.requestHostOperation(softwareRequest(host, model.software, 'check-software-channel', channel, ctx.requestId()));
    return {lines: [`Checking ${channel.kind} ${channel.value} on ${host.name}. The checked revision appears under Updates when the host reports it; checking never starts an update.`]};
  });
};

const applyChannel = (ctx: TuiContext, nodeUid: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  if (!host) return ctx.missing();
  const model = softwareModel(ctx.snapshot(), host, channelDraft(ctx.view.ui, host));
  if (!model) return ctx.missing();
  if (model.applyBlocked) return ctx.message('Not available', model.applyBlocked);
  const channel = {...model.draft.channel};
  const preview = model.software.preview;
  ctx.confirm({
    title: 'Change software channel', confirmLabel: 'Apply channel', expected: host.name, danger: true,
    description: `${host.name}: use ${channel.kind} ${channel.value} at ${shortRevision(preview?.commit)}. Services and the dashboard may restart. ${channel.kind === 'branch' ? 'New commits on this branch will be applied automatically.' : 'This revision remains fixed.'} Host configuration and cluster resources will change; reverting software does not undo database migrations.`,
    onConfirm: async () => {
      // Re-check against the current state: the review may have expired or another operation started.
      const current = findHost(ctx.snapshot(), nodeUid);
      const live = current ? softwareModel(ctx.snapshot(), current, {...model.draft, channel}) : undefined;
      if (!current || !live || live.applyBlocked) throw new Error(live?.applyBlocked ?? 'This computer is no longer reported.');
      await ctx.perform(`Apply software channel on ${current.name}`, async () => {
        await ctx.api.requestHostOperation(softwareRequest(current, live.software, 'apply-software-channel', channel, ctx.requestId(), live.software.preview?.id));
        return {lines: [`${current.name} is changing to ${channel.kind} ${channel.value}. Services and the dashboard may restart; follow the result under Updates.`]};
      });
    },
  });
};

const selectPrevious = (ctx: TuiContext, nodeUid: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  const software = host?.software;
  if (!host || !software?.previousCommit) return ctx.missing();
  const reason = softwareDisabled(ctx.snapshot(), host, software);
  if (reason) return ctx.message('Not available', reason);
  const draft = channelDraft(ctx.view.ui, host);
  storeDraft(ctx.view.ui, host, {...draft, mode: 'commit', channel: {kind: 'commit', value: software.previousCommit}});
  ctx.draw();
};

// ── Ubuntu packages ───────────────────────────────────────────────────────

const MODE_LABELS: Record<HostUpdatePolicy['mode'], string> = {
  security: 'Security updates', all: 'Security and regular Ubuntu updates', manual: 'Manual installation',
};

/** The request the browser sends for package operations (HostUpdateEditor payload()). */
export const updatesRequest = (host: ManagedHost, updates: HostUpdates, action: 'check-updates' | 'configure-updates' | 'install-updates', requestId: string, extra: Partial<HostOperationRequest> = {}): HostOperationRequest => ({
  action, nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId, planId: updates.id,
  requestId, confirmation: host.name,
  acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, ...extra,
});

const updatesDisabled = (snapshot: DashboardSnapshot, host: ManagedHost) => stale(snapshot) ? 'Host information is unavailable or stale.'
  : !host.available ? `${host.name} is currently unavailable.`
    : host.updates?.busy ? 'Ubuntu updates are running.'
      : operationActive(host) ? 'Another host operation is in progress on this computer.' : undefined;

export const validPolicy = (policy: HostUpdatePolicy) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(policy.windowStart)
  && Number.isInteger(policy.windowMinutes) && policy.windowMinutes >= 15 && policy.windowMinutes <= 360;

const policyDescription = (host: ManagedHost, draft: HostUpdatePolicy) => `${host.name}: ${draft.mode === 'manual' ? 'Manual package installation' : `Automatic ${draft.mode === 'security' ? 'security' : 'Ubuntu'} updates daily from ${draft.windowStart} UTC for ${draft.windowMinutes} minutes`}. ${draft.automaticReboot && draft.mode !== 'manual' ? 'Automatic computer restarts are enabled within the window.' : 'Computer restarts remain manual.'} Package updates can restart services. Running installations finish even if the window ends.`;
const installDescription = (host: ManagedHost, scope: 'security' | 'all') => `${host.name}: install ${scope === 'security' ? 'security' : 'eligible Ubuntu'} updates now. Services and models may be interrupted. Kernel, GPU and held packages remain excluded. This manual action does not restart the computer automatically.`;

const updateRows = (snapshot: DashboardSnapshot, state: PageState, host: ManagedHost, inner: number): Row[] => {
  const updates = host.updates;
  if (!updates?.supported) return [fit(inner, [span('Ubuntu packages', undefined, true)]), text(inner, 'Update management requires the current host worker.', 'dim')];
  const disabled = updatesDisabled(snapshot, host);
  const operation = host.operation;
  const packagesOpen = state.expanded[`pkg:${host.nodeUid}`] ?? false;
  const packages = updates.packages ?? [];
  const label = updates.busy ? 'Ubuntu updates running' : updates.phase === 'Failed' || updates.phase === 'Interrupted' ? 'Update needs attention' : 'Update status';
  const policy = updates.policy;
  const statusLine: Span = statusBadge(updates.busy ? 'Updating' : updates.phase ?? 'Ready');
  return [
    fit(inner, [span('Ubuntu packages', undefined, true)], [statusLine, gap(2), button(`updates:check-updates:${host.nodeUid}`, 'Check for updates', 'ghost', disabled)]),
    ...(updates.message ? lines(inner, `${label}: ${updates.message}`, updates.phase === 'Failed' || updates.phase === 'Interrupted' ? 'warn' : 'dim') : []),
    ...facts(inner, [
      ['Available updates', String(updates.pendingCount ?? '—')],
      ['Security updates', String(updates.securityCount ?? '—')],
      ['Held / hardware updates', String(updates.blockedCount ?? '—')],
      ['Last check', when(updates.checkedAt)],
      ['Last successful installation', when(updates.lastSuccessAt)],
    ]),
    ...(updates.rebootRequired ? [fit(inner, [span('Restart required', 'warn', true)], [button('section:power', 'Computer power')])] : []),
    blank,
    ...facts(inner, [
      ['Automatic updates', MODE_LABELS[policy.mode] ?? policy.mode],
      ['Maintenance start (UTC)', policy.windowStart],
      ['Window duration', `${policy.windowMinutes} minutes`],
      ['Automatic restart', policy.automaticReboot && policy.mode !== 'manual' ? 'Allowed in this window' : 'Manual'],
    ]),
    fit(inner, [], joinSpans([
      button(`updates:policy:${host.nodeUid}`, 'Change update settings', 'ghost', disabled),
      button(`updates:install-security:${host.nodeUid}`, 'Install security updates', 'ghost', disabled ?? (!updates.securityCount ? 'No security updates are available.' : undefined)),
      button(`updates:install-all:${host.nodeUid}`, 'Install Ubuntu updates', 'ghost', disabled ?? (!updates.pendingCount ? 'No Ubuntu updates are available.' : undefined)),
    ])),
    ...(operation && operation.action.includes('updates') ? [
      fit(inner, [span(`${operation.action} · ${operation.phase}`, terminalHostPhases.has(operation.phase) ? undefined : 'warn', true)]),
      ...lines(inner, operation.message ?? 'Waiting for the host worker.', 'dim'),
    ] : []),
    ...(packages.length ? [
      fit(inner, [toggle(`expand:pkg:${host.nodeUid}`, `Available packages (${updates.pendingCount ?? packages.length})`, packagesOpen)]),
      ...(packagesOpen ? [
        ...table(inner, [{header: 'Package', max: 30}, {header: 'Installed', max: 22}, {header: 'Available', max: 22}, {header: 'Status'}],
          packages.map((item) => ({cells: [span(item.name), span(item.installed, 'dim'), span(item.candidate), span(`${item.security ? 'Security · ' : ''}${item.blocked || 'Eligible'}`, item.security ? 'warn' : 'dim')]}))),
        ...(updates.truncated ? lines(inner, `Showing the first ${packages.length} packages.`, 'dim') : []),
      ] : []),
    ] : []),
  ];
};

export const updatesSection = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const inner = width - 4;
  const head = heading(width, 'Updates', '', [button('updates:info', 'Info')]);
  const hosts = snapshot.hosts?.nodes;
  if (!hosts) return {hotkeys: [], rows: [...head, ...loadingRows(width, snapshot.errors?.hosts, 'Update information')]};
  return {hotkeys: [], rows: [
    ...head,
    ...(stale(snapshot) ? lines(width, `Host information could not be refreshed: ${snapshot.errors?.hosts}`, 'bad') : []),
    ...hosts.flatMap((host) => panel(width, {title: host.name, status: host.available ? undefined : badge('Unavailable', 'warn')}, [
      ...softwareRows(snapshot, state, host, inner),
      blank,
      ...updateRows(snapshot, state, host, inner),
    ])),
    ...(hosts.length ? [] : [text(width, 'No manageable computers reported.', 'dim')]),
  ]};
};

const checkUpdates = (ctx: TuiContext, nodeUid: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  const updates = host?.updates;
  if (!host || !updates?.supported) return ctx.missing();
  const reason = updatesDisabled(ctx.snapshot(), host);
  if (reason) return ctx.message('Not available', reason);
  void ctx.perform(`Check for updates on ${host.name}`, async () => {
    await ctx.api.requestHostOperation(updatesRequest(host, updates, 'check-updates', ctx.requestId()));
    return {lines: [`${host.name} is checking the Ubuntu package lists. Nothing is installed by a check.`]};
  });
};

const editPolicy = (ctx: TuiContext, nodeUid: string) => {
  const host = findHost(ctx.snapshot(), nodeUid);
  const updates = host?.updates;
  if (!host || !updates?.supported) return ctx.missing();
  const reason = updatesDisabled(ctx.snapshot(), host);
  if (reason) return ctx.message('Not available', reason);
  const saved = updates.policy;
  const draft = {mode: saved.mode, windowStart: saved.windowStart, windowMinutes: String(saved.windowMinutes), automaticReboot: saved.automaticReboot};
  const policy = (): HostUpdatePolicy => ({mode: draft.mode, windowStart: draft.windowStart, windowMinutes: Number(draft.windowMinutes), automaticReboot: draft.automaticReboot});
  const changed = () => {
    const next = policy();
    return next.mode !== saved.mode || next.windowStart !== saved.windowStart || next.windowMinutes !== saved.windowMinutes || next.automaticReboot !== saved.automaticReboot;
  };
  ctx.dialog({
    title: `Update settings · ${host.name}`,
    description: UPDATES_INFO,
    items: () => [
      {kind: 'choice', id: 'mode', label: 'Automatic updates', value: draft.mode, choices: (['security', 'all', 'manual'] as const).map((value) => ({value, label: MODE_LABELS[value]})),
        onChange: (value) => { draft.mode = value as HostUpdatePolicy['mode']; }},
      {kind: 'text', id: 'windowStart', label: 'Maintenance start (UTC)', value: draft.windowStart, required: true, maxLength: 5, hint: 'HH:MM', onChange: (value) => { draft.windowStart = value; }},
      {kind: 'number', id: 'windowMinutes', label: 'Window duration (minutes)', value: draft.windowMinutes, required: true, min: 15, max: 360, step: 15, onChange: (value) => { draft.windowMinutes = value; }},
      {kind: 'check', id: 'automaticReboot', label: 'Allow automatic restart in this window', checked: draft.automaticReboot, onChange: (checked) => { draft.automaticReboot = checked; }},
    ],
    submit: {label: 'Save update settings', disabled: () => {
      const current = findHost(ctx.snapshot(), nodeUid);
      if (!current?.updates?.supported) return 'This computer is no longer reported.';
      return updatesDisabled(ctx.snapshot(), current) ?? (!changed() ? 'No changes to save.' : !validPolicy(policy()) ? 'Enter a start time as HH:MM (UTC) and a window of 15 to 360 minutes.' : undefined);
    }, run: () => {
      const current = findHost(ctx.snapshot(), nodeUid)!;
      const next = policy();
      const request = updatesRequest(current, current.updates!, 'configure-updates', ctx.requestId(), {updatePolicy: next});
      ctx.confirm({title: 'Save update settings', description: policyDescription(current, next), confirmLabel: 'Save settings', expected: current.name, back: true,
        onConfirm: () => ctx.perform(`Save update settings on ${current.name}`, async () => {
          await ctx.api.requestHostOperation(request);
          return {lines: [`Update settings for ${current.name} were sent to the host.`]};
        })});
    }},
  });
};

const installUpdates = (ctx: TuiContext, nodeUid: string, scope: 'security' | 'all') => {
  const host = findHost(ctx.snapshot(), nodeUid);
  const updates = host?.updates;
  if (!host || !updates?.supported) return ctx.missing();
  const reason = updatesDisabled(ctx.snapshot(), host)
    ?? (scope === 'security' && !updates.securityCount ? 'No security updates are available.' : scope === 'all' && !updates.pendingCount ? 'No Ubuntu updates are available.' : undefined);
  if (reason) return ctx.message('Not available', reason);
  const request = updatesRequest(host, updates, 'install-updates', ctx.requestId(), {updateScope: scope});
  ctx.confirm({title: 'Install Ubuntu updates', description: installDescription(host, scope), confirmLabel: 'Install updates', expected: host.name, danger: true,
    onConfirm: () => ctx.perform(`Install ${scope === 'security' ? 'security' : 'Ubuntu'} updates on ${host.name}`, async () => {
      await ctx.api.requestHostOperation(request);
      return {lines: [`Installation of ${scope === 'security' ? 'security' : 'eligible Ubuntu'} updates was requested on ${host.name}. Follow the operation under Updates; the computer is not restarted automatically.`]};
    })});
};

export const hostSettingsModule: AreaModule = {
  scopes: {network: 'admin', updates: 'admin'},
  readOnly: ({verb}) => ['info', 'info-software', 'refresh', 'refresh-versions'].includes(verb),
  handle: (ctx, {scope, verb, target}) => {
    if (scope === 'network') {
      if (verb === 'refresh') return void ctx.refresh();
      if (verb === 'keep') return keepNetwork(ctx, target);
      if (verb === 'info' && !target) return ctx.message('Network configuration', NETWORK_INFO);
      const [nodeUid, name] = splitTarget(target);
      if (verb === 'info') {
        const device = findHost(ctx.snapshot(), nodeUid)?.network?.interfaces.find((item) => item.name === name);
        return device ? ctx.message(`Network interface ${device.name}`, interfaceInfo(device)) : ctx.missing();
      }
      if (verb === 'scan') return scanWifi(ctx, nodeUid, name);
      if (verb === 'configure') return configureNetwork(ctx, nodeUid, name);
      return;
    }
    if (verb === 'info') return ctx.message('Ubuntu updates', UPDATES_INFO);
    if (verb === 'info-software') return ctx.message('Software channel', SOFTWARE_INFO);
    if (verb === 'refresh-versions') return void ctx.refresh({releases: true});
    if (verb === 'channel') return editChannel(ctx, target);
    if (verb === 'check-channel') return checkChannel(ctx, target);
    if (verb === 'apply-channel') return applyChannel(ctx, target);
    if (verb === 'previous') return selectPrevious(ctx, target);
    if (verb === 'check-updates') return checkUpdates(ctx, target);
    if (verb === 'policy') return editPolicy(ctx, target);
    if (verb === 'install-security') return installUpdates(ctx, target, 'security');
    if (verb === 'install-all') return installUpdates(ctx, target, 'all');
  },
};
