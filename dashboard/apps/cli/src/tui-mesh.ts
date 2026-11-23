// Mesh page: create, join and manage a private mesh (apps/web/src/pages/MeshPage.tsx).
import type {MeshInvite, MeshRelay, MeshShare, MeshStatus} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {DialogItem, DialogSpec} from './tui-dialogs';
import {activeMeshTab, meshTabs, type PageState, type PageView} from './tui-state';
import {badge, button, fit, gap, joinSpans, panel, prose, span, toggle, type Row, type Span, type Tone} from './tui-screen';
import {blank, dateTime, facts, heading, loadingRows, plural, tabBar, tags, text} from './tui-widgets';

export const MESH_SHARE_DEFAULTS: MeshShare = {enabled: false, maxConcurrent: 2, rpm: 10, tpm: 64000, maxContext: 32768, maxOutput: 2048, priority: 'low'};
const PHASES: Record<string, string> = {connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting', relay: 'Relay connection',
  mesh_unavailable: 'Mesh unavailable', litellm_unavailable: 'LiteLLM unavailable', model_unavailable: 'Model unavailable',
  authentication_failed: 'Authentication failed', configuration_error: 'Configuration error'};
const COMPONENTS: Record<string, string> = {mesh: 'MeshLLM', litellm: 'LiteLLM', models: 'Local models', vllm: 'Local models', sync: 'Model Sync', export: 'Export'};
const LIMITS: Array<{key: 'maxConcurrent' | 'rpm' | 'tpm' | 'maxContext' | 'maxOutput'; label: string; max: number; step: number}> = [
  {key: 'maxConcurrent', label: 'Max concurrent requests', max: 64, step: 1},
  {key: 'rpm', label: 'Requests / minute', max: 10000, step: 10},
  {key: 'tpm', label: 'Tokens / minute', max: 10000000, step: 1000},
  {key: 'maxContext', label: 'Max context budget', max: 1048576, step: 1024},
  {key: 'maxOutput', label: 'Max output tokens', max: 131072, step: 256},
];
const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NODE_NAME_HELP = '1–63 lowercase letters, digits or hyphens; start and end with a letter or digit.';

export const validMeshName = (name: string) => NODE_NAME.test(name);
const typeLabel = (type: string) => type === 'client' ? 'Employee laptop' : 'Magic Stick';
const date = (seconds: number) => dateTime(seconds);
const enabledShares = (status: MeshStatus) => Object.values(status.shares ?? {}).filter((item) => item.enabled).length;
const phaseLabel = (phase: string) => PHASES[phase] ?? phase;
const phaseBadge = (phase: string): Span => {
  const tone: Tone = phase === 'connected' ? 'good' : ['connecting', 'relay'].includes(phase) ? 'warn'
    : ['disconnected', ''].includes(phase) ? 'dim' : 'bad';
  return badge(phaseLabel(phase), tone, tone !== 'dim');
};
const inviteState = (item: MeshInvite) => item.revoked ? 'Revoked' : item.usedAt ? 'Used' : item.expiresAt * 1000 <= Date.now() ? 'Expired' : 'Active';
const validUrl = (value: string) => {
  try { return ['https:', 'http:'].includes(new URL(value.trim()).protocol); } catch { return false; }
};

const TRUST_INFO = 'Only enrolled devices can connect. The creator manages membership; laptops can only consume models. If the creator is unreachable, membership expires after two minutes and new mesh requests stop.';
const RELAY_INFO = "Direct connections preferred. Iroh uses a relay when a direct connection is unavailable. Auto and Public relay use the built-in public relay set. A relay never grants mesh membership. The creator's HTTPS address must remain reachable by every member for enrollment and authorization renewal; the inference relay does not forward this control connection.";
const LIMITS_INFO = 'Remote request limits: all engines use separate concurrency/rate limits for remote requests. vLLM additionally uses a lower queue priority; Ollama does not receive vLLM-specific parameters. Active work is not preempted. Text context uses a conservative byte-based budget; media input is not supported.';
const SHARE_INFO = 'Local availability is managed in Models. Sharing creates an alias for this same backend, without loading a second copy.';
const ACTIVITY_INFO = 'Counters reset when the component restarts. Backend attempts include retries and fallbacks, not only successful requests. No prompts or response contents are recorded.';
const leaveText = (status: MeshStatus) => `Mesh sharing and imported routes will stop. Your local models keep running.${status.authority ? ' This node owns the mesh; other members will also lose access when their membership expires.' : ''}`;

const setupRows = (snapshot: DashboardSnapshot, status: MeshStatus, state: PageState, width: number): Row[] => {
  const inner = width - 4;
  const installing = !status.installed && state.ui['mesh.installRequested'] === '1';
  return panel(width, {title: 'Private Mesh', status: phaseBadge('disconnected')}, [
    ...prose(inner, 'Share models between your own appliances. Create a new private mesh on this appliance, or join an existing one with an invitation.', 'dim'),
    blank,
    fit(inner, joinSpans([
      !status.installed
        ? button('mesh:enable', installing ? 'Installing…' : 'Enable Private Mesh', 'primary', installing ? 'Private Mesh is being installed. This page updates when it is ready.' : undefined)
        : button('mesh:create', 'Create Private Mesh', 'primary'),
      button('mesh:join', 'Join Mesh'),
    ])),
    ...(snapshot.mesh?.lastError ? [blank, ...prose(inner, String(snapshot.mesh.lastError), 'bad')] : []),
  ]);
};

const overviewRows = (status: MeshStatus, state: PageState, width: number): Row[] => {
  const inner = width - 4;
  const nodes = status.nodes ?? [];
  const metrics = status.metrics;
  const activityOpen = state.expanded['mesh-activity'] ?? false;
  const latency = (requests: number, seconds: number) => requests ? (seconds / requests).toFixed(2) : '0';
  return [
    ...panel(width, {title: status.mesh?.name ?? 'Private mesh'}, [
      fit(inner, [], [button('mesh:sync', 'Sync now')]),
      ...facts(inner, [
        ['This node', status.node?.name ?? '—'], ['Node type', typeLabel(status.node?.type ?? '')],
        ['Nodes online', String(nodes.filter((node) => node.online).length)], ['Remote models', String(status.imports?.length ?? 0)],
        ['Shared models', String(enabledShares(status))], ['Connection', !status.transport || status.transport === 'unknown' ? 'Not yet reported' : status.transport],
        ...(status.lastSync ? [['Last sync', date(status.lastSync)] as [string, string]] : []),
      ]),
      ...tags(inner, Object.entries(status.components ?? {}).map(([name, value]) => `${COMPONENTS[name] ?? name} · ${value.replaceAll('_', ' ')}`)),
      ...(status.lastError ? prose(inner, status.lastError, 'bad') : []),
    ]),
    ...panel(width, {title: 'Nodes', meta: plural(nodes.length, 'node')}, nodes.length ? nodes.flatMap((node) => {
      const revocable = status.authority && node.id !== status.node?.id && !node.revoked;
      return [fit(inner, [span(node.name, undefined, true), span(`  ${typeLabel(node.type)}${node.id === status.node?.id ? ' · this node' : ''}`, 'dim')], [
        node.revoked ? badge('Revoked', 'bad') : node.online ? badge('Online', 'good') : badge('Offline', 'dim', false),
        ...(revocable ? [gap(2), button(`mesh:revoke-node:${node.id}`, 'Revoke access', 'danger')] : []),
      ])];
    }) : [text(inner, 'No nodes reported yet.', 'dim')]),
    fit(width, [toggle('expand:mesh-activity', 'Activity', activityOpen)]),
    ...(activityOpen ? panel(width, {title: 'Activity'}, [
      ...facts(inner, [
        ['Requests from mesh', String(metrics?.incoming.requests ?? '—')], ['Requests to mesh', String(metrics?.outgoing.requests ?? '—')],
        ['Active remote requests', String(metrics?.incoming.active ?? '—')], ['Remote errors', String(metrics?.incoming.errors ?? '—')],
      ]),
      blank,
      fit(inner, [span('Backend activity', undefined, true)]),
      ...prose(inner, ACTIVITY_INFO, 'dim'),
      ...(!metrics?.backends ? [text(inner, 'Local metrics unavailable', 'dim')] : metrics.backends.byModel.flatMap((row) => [
        fit(inner, [span(row.model, undefined, true)]),
        ...prose(inner - 2, `${row.traffic} · ${row.requests} attempts · ${row.errors} errors · ${latency(row.requests, row.latencySeconds)} s average`, 'dim').map((line) => [gap(2), ...line]),
      ])),
      ...(metrics?.byPeerModel ?? []).flatMap((row) => [
        fit(inner, [span(row.model, undefined, true)]),
        ...prose(inner - 2, `${nodes.find((node) => node.id === row.peer)?.name ?? 'Other peer'} · ${row.requests} requests · ${row.active} active · ${row.errors} errors`, 'dim').map((line) => [gap(2), ...line]),
      ]),
    ]) : []),
    blank,
    fit(width, [], [button('mesh:leave', 'Leave mesh', 'danger')]),
  ];
};

const modelsRows = (status: MeshStatus, width: number): Row[] => {
  const inner = width - 4;
  const names = [...new Set([...(status.models ?? []), ...Object.keys(status.shares ?? {})])];
  const imports = status.imports ?? [];
  return [
    ...(status.node?.type === 'magic-stick' ? panel(width, {title: 'Local model sharing', meta: `${enabledShares(status)} shared`}, names.length ? [
      ...prose(inner, SHARE_INFO, 'dim'),
      blank,
      ...names.flatMap((name) => {
        const saved = status.shares?.[name];
        const ready = status.models?.includes(name) ?? false;
        return [fit(inner, [span(name, undefined, true), span(`  ${ready ? 'Available locally' : 'Local model unavailable'}`, 'dim')], [
          saved?.enabled ? badge('Shared', 'good') : badge('Local only', 'dim', false), gap(2),
          button(`mesh:share:${name}`, 'Configure'),
        ]), ...(saved?.enabled ? [fit(inner, [gap(2), span(`${saved.maxConcurrent} concurrent · ${saved.rpm} req/min · ${saved.tpm} tokens/min · context ${saved.maxContext} · output ${saved.maxOutput}`, 'dim')])] : [])];
      }),
    ] : [text(inner, 'No local model is ready. Start a model in Models to share it.', 'dim')]) : []),
    ...panel(width, {title: 'Models from your mesh', meta: plural(imports.length, 'model')}, imports.length
      ? tags(inner, imports, 'normal') : [text(inner, 'No remote models are available.', 'dim')]),
  ];
};

const invitationsRows = (status: MeshStatus, width: number): Row[] => {
  const inner = width - 4;
  const invites = status.invites ?? [];
  return panel(width, {title: 'Invitations', meta: plural(invites.length, 'invitation')}, [
    fit(inner, [span('Create a single-use invitation for another Magic Stick or an employee laptop.', 'dim')], [button('mesh:invite', 'Create invite', 'primary')]),
    blank,
    ...(invites.length ? invites.flatMap((item) => {
      const label = inviteState(item);
      return [
        fit(inner, [span(typeLabel(item.type), undefined, true), span(`  ${item.creator} · Expires ${date(item.expiresAt)}`, 'dim')], [
          badge(label, label === 'Active' ? 'good' : label === 'Revoked' ? 'bad' : 'dim', label === 'Active'),
          ...(label === 'Active' ? [gap(2), button(`mesh:revoke-invite:${item.id}`, 'Revoke', 'danger')] : []),
        ]),
      ];
    }) : [text(inner, 'No invitations have been created.', 'dim')]),
  ]);
};

const networkRows = (status: MeshStatus, width: number): Row[] => {
  const inner = width - 4;
  const relay = status.relay;
  return panel(width, {title: 'Network'}, [
    ...(relay ? [
      fit(inner, [span('Relay', undefined, true)], [button('mesh:relay', 'Edit network')]),
      ...facts(inner, [['Relay mode', relay.mode === 'auto' ? 'Auto' : relay.mode === 'public' ? 'Public relay' : 'Custom relay'],
        ...(relay.mode === 'custom' ? [['Relay URL', relay.url] as [string, string]] : [])]),
    ] : [text(inner, 'The relay configuration has not been reported yet.', 'dim')]),
    blank,
    ...prose(inner, RELAY_INFO, 'dim'),
  ]);
};

export const meshPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const status = snapshot.mesh;
  if (!status) return {hotkeys: [], rows: [
    ...heading(width, 'Private Mesh', 'Share models between your own appliances.'),
    ...loadingRows(width, snapshot.errors?.mesh, 'Mesh status'),
  ]};
  if (!status.configured) return {
    hotkeys: [status.installed ? {key: 'c', label: 'Create mesh', actionId: 'mesh:create'} : {key: 'e', label: 'Enable mesh', actionId: 'mesh:enable'}],
    rows: [
      ...heading(width, 'Private Mesh', 'Share models between your own appliances.'),
      ...setupRows(snapshot, status, state, width),
    ],
  };
  const tab = activeMeshTab(snapshot, state.meshTab);
  const body = tab === 'models' ? modelsRows(status, width)
    : tab === 'invitations' ? invitationsRows(status, width)
      : tab === 'network' ? networkRows(status, width)
        : overviewRows(status, state, width);
  return {
    hotkeys: [
      {key: 't', label: 'Mesh tab', actionId: 'mesh-tab:next'},
      ...(tab === 'overview' ? [{key: 's', label: 'Sync now', actionId: 'mesh:sync'}] : []),
      ...(tab === 'invitations' ? [{key: 'i', label: 'Create invite', actionId: 'mesh:invite'}] : []),
    ],
    rows: [
      fit(width, [span('Private Mesh', undefined, true)], [phaseBadge(status.phase), gap(2), button('mesh:join', 'Join Mesh')]),
      ...prose(width, TRUST_INFO, 'dim'),
      blank,
      tabBar('mesh-tab', meshTabs(snapshot), tab),
      blank,
      ...body,
    ],
  };
};

const meshCommand = <T = Record<string, unknown>>(ctx: TuiContext, action: Parameters<TuiContext['api']['meshCommand']>[0], payload: object = {}) =>
  ctx.api.meshCommand<T>(action, payload);

const enableMesh = (ctx: TuiContext) => ctx.perform('Enable Private Mesh', async () => {
  await ctx.api.enableModule('private-mesh');
  ctx.view.ui['mesh.installRequested'] = '1';
  return {lines: ['Private Mesh is being installed. The Mesh page shows Create and Join once it is ready.']};
});

/** The address members use for enrollment: the browser sends its own origin; the terminal proposes the dashboard host. */
const defaultOrigin = (snapshot: DashboardSnapshot) => snapshot.mesh?.mesh?.origin
  || (snapshot.settings?.dashboardHost ? `https://${snapshot.settings.dashboardHost}` : '');

const relayItems = (relay: MeshRelay, update: (relay: MeshRelay) => void): DialogItem[] => [
  {kind: 'choice', id: 'relay-mode', label: 'Relay mode', value: relay.mode, choices: [
    {value: 'auto', label: 'Auto'}, {value: 'public', label: 'Public relay'}, {value: 'custom', label: 'Custom relay'},
  ], onChange: (value) => update({mode: value as MeshRelay['mode'], url: relay.url})},
  ...(relay.mode === 'custom' ? [{kind: 'text' as const, id: 'relay-url', label: 'Relay URL', value: relay.url, required: true, hint: 'https://relay.example.com',
    onChange: (value: string) => update({...relay, url: value})}] : []),
  {kind: 'note', text: RELAY_INFO},
];
const relayProblem = (relay: MeshRelay) => relay.mode === 'custom' && !validUrl(relay.url) ? 'Enter the custom relay URL (https://…).' : undefined;

const createMesh = (ctx: TuiContext) => {
  const status = ctx.snapshot().mesh;
  if (!status?.installed) return ctx.message('Private Mesh not installed', 'Enable Private Mesh on this appliance first.');
  const draft = {step: 0, meshName: '', nodeName: '', relay: {mode: 'auto', url: ''} as MeshRelay, origin: defaultOrigin(ctx.snapshot()), selected: [] as string[]};
  const steps = ['Name', 'Network', 'Model sharing'];
  const validNames = () => validMeshName(draft.nodeName) && validMeshName(draft.meshName);
  const refocus = () => {
    const current = ctx.current();
    if (current?.kind === 'dialog') current.focus = undefined;
    if (spec.submit) spec.submit.label = draft.step === 2 ? 'Create mesh' : 'Next';
  };
  const spec: DialogSpec = {
    title: 'Create private mesh',
    meta: () => `Step ${draft.step + 1} of 3 · ${steps[draft.step]}`,
    items: () => {
      const models = ctx.snapshot().mesh?.models ?? status.models ?? [];
      const back: DialogItem[] = draft.step > 0 ? [{kind: 'buttons', items: [{id: 'back', label: 'Back', onPress: () => { draft.step -= 1; refocus(); }}]}] : [];
      if (draft.step === 0) return [
        {kind: 'text', id: 'mesh-name', label: 'Mesh name', value: draft.meshName, required: true, maxLength: 63, hint: 'company-mesh', onChange: (value) => { draft.meshName = value; }},
        {kind: 'text', id: 'node-name', label: 'Node name', value: draft.nodeName, required: true, maxLength: 63, hint: 'magicstick-01', onChange: (value) => { draft.nodeName = value; }},
        {kind: 'note', text: NODE_NAME_HELP, tone: (draft.meshName && !validMeshName(draft.meshName)) || (draft.nodeName && !validMeshName(draft.nodeName)) ? 'warn' : 'dim'},
      ];
      if (draft.step === 1) return [
        ...relayItems(draft.relay, (relay) => { draft.relay = relay; }),
        {kind: 'text', id: 'origin', label: 'Enrollment address (this dashboard)', value: draft.origin, required: true, hint: 'https://dashboard.example.com', onChange: (value) => { draft.origin = value; }},
        {kind: 'note', text: 'Members contact this HTTPS address for enrollment and authorization renewal. The browser uses the address it is opened with; check that every member can reach it.'},
        ...back,
      ];
      return [
        {kind: 'heading', text: 'Share local models'},
        ...(models.length ? models.map((name): DialogItem => ({kind: 'check', id: `share-${name}`, label: name, checked: draft.selected.includes(name),
          onChange: (checked) => { draft.selected = checked ? [...draft.selected, name] : draft.selected.filter((item) => item !== name); }}))
          : [{kind: 'note', text: 'No local model is ready. You can share a model later.'} as DialogItem]),
        {kind: 'note', text: `Shared models start with the default remote limits: ${MESH_SHARE_DEFAULTS.maxConcurrent} concurrent requests, ${MESH_SHARE_DEFAULTS.rpm} requests and ${MESH_SHARE_DEFAULTS.tpm} tokens per minute. Change them later under Models.`},
        ...back,
      ];
    },
    submit: {
      label: draft.step === 2 ? 'Create mesh' : 'Next',
      disabled: () => !validNames() ? `Mesh and node names: ${NODE_NAME_HELP}`
        : draft.step === 1 ? relayProblem(draft.relay) ?? (validUrl(draft.origin) ? undefined : 'Enter the enrollment address of this dashboard (https://…).') : undefined,
      run: async () => {
        if (draft.step < 2) {
          draft.step += 1;
          refocus();
          return ctx.draw();
        }
        await ctx.perform(`Create mesh ${draft.meshName}`, async () => {
          await meshCommand(ctx, 'create', {
            meshName: draft.meshName, nodeName: draft.nodeName, relay: draft.relay, origin: draft.origin.trim().replace(/\/$/, ''),
            shares: Object.fromEntries(draft.selected.map((name) => [name, {...MESH_SHARE_DEFAULTS, enabled: true}])),
          });
          ctx.view.meshTab = 'overview';
          return {lines: [`The private mesh ${draft.meshName} is being created with this appliance as ${draft.nodeName}.`]};
        });
      },
    },
  };
  ctx.dialog(spec);
};

const joinMesh = (ctx: TuiContext) => {
  const status = ctx.snapshot().mesh;
  if (!status) return ctx.missing();
  if (status.configured) return ctx.dialog({
    title: 'Join private mesh',
    items: () => [
      {kind: 'note', text: `This Magic Stick already belongs to ${status.mesh?.name ?? 'a mesh'}. Leave it before joining another mesh.`, tone: 'normal'},
      {kind: 'note', text: leaveText(status)},
    ],
    submit: {label: 'Leave current mesh', tone: 'danger', run: () => ctx.perform('Leave mesh', async () => {
      await meshCommand(ctx, 'leave');
      return {lines: ['This appliance is leaving the mesh. Join the new mesh once the Mesh page shows it disconnected.']};
    })},
  });
  if (!status.installed) return ctx.dialog({
    title: 'Join private mesh',
    items: () => [{kind: 'note', text: 'Enable Private Mesh on this appliance to join an existing mesh.', tone: 'normal'}],
    submit: {label: 'Enable Private Mesh', run: () => enableMesh(ctx)},
  });
  const draft = {nodeName: status.node?.name ?? '', token: ''};
  ctx.dialog({
    title: 'Join private mesh',
    items: () => [
      {kind: 'heading', text: 'Join with an invitation'},
      {kind: 'note', text: "On the mesh owner's dashboard, open Mesh → Invitations and create a Magic Stick invitation. Paste its single-use token here. An expired or already-used invitation must be replaced with a new one."},
      {kind: 'text', id: 'node-name', label: 'Node name', value: draft.nodeName, required: true, maxLength: 63, hint: 'magicstick-02', onChange: (value) => { draft.nodeName = value; }},
      ...(draft.nodeName && !validMeshName(draft.nodeName) ? [{kind: 'note' as const, text: NODE_NAME_HELP, tone: 'warn' as const}] : []),
      {kind: 'text', id: 'token', label: 'Invite token', value: draft.token, required: true, onChange: (value) => { draft.token = value.trim(); }},
    ],
    submit: {
      label: 'Join mesh',
      disabled: () => !validMeshName(draft.nodeName) ? `Node name: ${NODE_NAME_HELP}` : !draft.token.trim() ? 'Paste the invite token.' : undefined,
      run: () => ctx.perform('Join mesh', async () => {
        await meshCommand(ctx, 'join', {token: draft.token.trim(), nodeName: draft.nodeName});
        draft.token = '';
        ctx.view.meshTab = 'overview';
        return {lines: [`This appliance is joining the mesh as ${draft.nodeName}.`]};
      }),
    },
  });
};

const editShare = (ctx: TuiContext, name: string) => {
  const status = ctx.snapshot().mesh;
  if (!status) return ctx.missing();
  const saved = status.shares?.[name];
  const ready = status.models?.includes(name) ?? false;
  const baseline = saved ?? MESH_SHARE_DEFAULTS;
  const draft = {enabled: baseline.enabled, ...Object.fromEntries(LIMITS.map((limit) => [limit.key, String(baseline[limit.key])]))} as {enabled: boolean} & Record<(typeof LIMITS)[number]['key'], string>;
  const value = (): MeshShare => ({...baseline, enabled: draft.enabled, ...Object.fromEntries(LIMITS.map((limit) => [limit.key, Number(draft[limit.key])]))});
  const invalid = () => draft.enabled ? LIMITS.find((limit) => {
    const number = Number(draft[limit.key]);
    return !Number.isInteger(number) || number < 1 || number > limit.max;
  }) : undefined;
  ctx.dialog({
    title: `Mesh sharing · ${name}`,
    items: () => [
      {kind: 'facts', rows: [['Local availability', ready ? 'Available locally' : 'Local model unavailable'], ['Saved', saved?.enabled ? 'Shared' : 'Local only']]},
      {kind: 'note', text: SHARE_INFO},
      {kind: 'check', id: 'enabled', label: 'Share with private mesh', checked: draft.enabled,
        disabled: !ready && !draft.enabled ? 'This model is not available locally. Start it in Models before sharing it.' : undefined,
        onChange: (checked) => { draft.enabled = checked; }},
      ...(draft.enabled ? [
        ...LIMITS.map((limit): DialogItem => ({kind: 'number', id: limit.key, label: limit.label, value: draft[limit.key], min: 1, max: limit.max, step: limit.step,
          onChange: (next) => { draft[limit.key] = next; }})),
        {kind: 'note', text: LIMITS_INFO} as DialogItem,
      ] : []),
    ],
    submit: {
      label: 'Save sharing',
      disabled: () => {
        const bad = invalid();
        if (bad) return `${bad.label} must be a whole number from 1 to ${bad.max.toLocaleString('en-US')}.`;
        if (JSON.stringify(value()) === JSON.stringify(baseline)) return 'No changes to save.';
        if (draft.enabled && !ready) return 'This model is not available locally.';
        return undefined;
      },
      run: () => ctx.perform(`Save mesh sharing for ${name}`, async () => {
        if (draft.enabled) await meshCommand(ctx, 'share', {model: name, settings: value()});
        else await meshCommand(ctx, 'unshare', {model: name});
        return {lines: [draft.enabled ? `${name} is shared with the private mesh.` : `${name} is no longer shared with the private mesh.`]};
      }),
    },
  });
};

const createInvite = (ctx: TuiContext) => {
  const draft = {type: 'magic-stick' as MeshInvite['type'], lifetime: '3600'};
  ctx.dialog({
    title: 'Create invitation',
    items: () => [
      {kind: 'choice', id: 'type', label: 'Node type', value: draft.type, choices: [{value: 'magic-stick', label: 'Magic Stick'}, {value: 'client', label: 'Client / Employee laptop'}],
        onChange: (value) => { draft.type = value as MeshInvite['type']; }},
      {kind: 'choice', id: 'lifetime', label: 'Expires in', value: draft.lifetime, choices: [{value: '900', label: '15 minutes'}, {value: '3600', label: '1 hour'}, {value: '86400', label: '24 hours'}],
        onChange: (value) => { draft.lifetime = value; }},
      {kind: 'note', text: 'The single-use token is shown once after creation. Laptops can only consume models.'},
    ],
    submit: {label: 'Create invite', run: () => ctx.perform('Create invitation', async () => {
      const invite = await meshCommand<MeshInvite>(ctx, 'invite', {type: draft.type, lifetime: Number(draft.lifetime)});
      if (!invite.token) return {lines: ['The invitation was created, but no token was returned.']};
      return {lines: [
        'One-time invite token (shown only now):', invite.token,
        `${typeLabel(invite.type)} · Expires ${date(invite.expiresAt)}`,
        'Press c to copy it before closing this message.',
      ], copyValue: invite.token};
    })},
  });
};

const editRelay = (ctx: TuiContext) => {
  const saved = ctx.snapshot().mesh?.relay;
  if (!saved) return ctx.missing();
  let relay: MeshRelay = {...saved};
  ctx.dialog({
    title: 'Mesh network',
    items: () => relayItems(relay, (next) => { relay = next; }),
    submit: {
      label: 'Save network',
      disabled: () => JSON.stringify(relay) === JSON.stringify(saved) ? 'No changes to save.' : relayProblem(relay),
      run: () => ctx.perform('Save mesh network', async () => {
        await meshCommand(ctx, 'relay', relay);
        return {lines: ['The relay configuration was saved.']};
      }),
    },
  });
};

export const meshModule: AreaModule = {
  scopes: {mesh: 'admin'},
  handle: (ctx, {verb, target}) => {
    const status = ctx.snapshot().mesh;
    if (!status) return ctx.message('Mesh status unavailable', 'The mesh status has not been loaded yet. Press r to reload.');
    switch (verb) {
      case 'enable': return void enableMesh(ctx);
      case 'create': return createMesh(ctx);
      case 'join': return joinMesh(ctx);
      case 'sync': return void ctx.perform('Sync mesh', async () => {
        await meshCommand(ctx, 'sync');
        return {lines: ['Mesh model synchronization was requested.']};
      });
      case 'leave': return ctx.confirm({title: 'Leave private mesh?', description: leaveText(status), confirmLabel: 'leave mesh', danger: true,
        onConfirm: () => ctx.perform('Leave mesh', async () => {
          await meshCommand(ctx, 'leave');
          return {lines: ['This appliance is leaving the private mesh. Local models keep running.']};
        })});
      case 'revoke-node': {
        const node = status.nodes?.find((item) => item.id === target);
        if (!node) return ctx.missing();
        return ctx.confirm({title: `Revoke ${node.name}`, description: `${node.name} loses its mesh membership and can no longer use or provide mesh models. It needs a new invitation to rejoin.`, confirmLabel: 'revoke access', danger: true,
          onConfirm: () => ctx.perform(`Revoke ${node.name}`, async () => {
            await meshCommand(ctx, 'revoke-node', {id: target});
            return {lines: [`Mesh access for ${node.name} was revoked.`]};
          })});
      }
      case 'share': return editShare(ctx, target);
      case 'invite': return status.authority ? createInvite(ctx) : ctx.message('Not the mesh owner', 'Only the appliance that created the mesh can invite members.');
      case 'revoke-invite': {
        const invite = status.invites?.find((item) => item.id === target);
        if (!invite) return ctx.missing();
        return void ctx.perform('Revoke invitation', async () => {
          await meshCommand(ctx, 'revoke-invite', {id: target});
          return {lines: [`The ${typeLabel(invite.type)} invitation was revoked.`]};
        });
      }
      case 'relay': return editRelay(ctx);
      default: return undefined;
    }
  },
};
