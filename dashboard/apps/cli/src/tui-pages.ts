// Page content of the terminal dashboard. It mirrors the browser dashboard:
// the same pages, sections, panels and buttons, built from the shared snapshot.
import {
  canAdminister,
  canMutateRuntime,
  consoleAccessLabel,
  effectiveModuleStatus,
  flattenInstances,
  formatMi,
  gpuValidationSummary,
  instanceHasCredentials,
  instanceResourceLinks,
  missingApplicationModules,
  modelEditRevision,
  moduleResourceLinks,
  phaseInProgress,
  phaseNeedsAttention,
  phaseTone,
  progressForPhase,
  titleFromKey,
  type FlatInstance,
  type ResourceLink,
} from '@magicstick/dashboard-core';
import type {ModuleCatalogEntry, ModuleState, Session, User} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import {licenseLines} from './license';
import {
  badge, button, choice, divider, fit, gap, joinSpans, link, panel, phaseToneOf, progressBar, prose, span, table, toggle,
  type Row, type Span,
} from './tui-screen';

export type PageId = 'overview' | 'models' | 'services' | 'api-access' | 'mesh' | 'kubernetes-access' | 'system';
export type SystemSectionId = 'settings' | 'license' | 'users' | 'hardware' | 'status' | 'power';
export type ServiceFilter = 'all' | 'applications' | 'runtime' | 'platform';

export interface PageState {
  page: PageId;
  systemSection: SystemSectionId;
  serviceFilter: ServiceFilter;
  expanded: Record<string, boolean>;
}

/** A page-level shortcut shown in the hotkey bar; it triggers the same action as its button. */
export interface Hotkey {
  key: string;
  label: string;
  actionId: string;
}

export interface PageView {
  rows: Row[];
  hotkeys: Hotkey[];
}

// Same pages, order and visibility rules as the browser dashboard.
const PAGES: Array<{id: PageId; label: string; admin?: boolean; identity?: boolean}> = [
  {id: 'overview', label: 'Overview'},
  {id: 'models', label: 'Models'},
  {id: 'services', label: 'Services'},
  {id: 'api-access', label: 'API Access', admin: true},
  {id: 'mesh', label: 'Mesh', admin: true},
  {id: 'kubernetes-access', label: 'Kubernetes Access', admin: true, identity: true},
  {id: 'system', label: 'System'},
];

const SYSTEM_SECTIONS: Array<{id: SystemSectionId; label: string; admin?: boolean; identity?: boolean}> = [
  {id: 'settings', label: 'Settings', admin: true},
  {id: 'license', label: 'License', admin: true},
  {id: 'users', label: 'Users', admin: true, identity: true},
  {id: 'hardware', label: 'Hardware'},
  {id: 'status', label: 'System Status'},
  {id: 'power', label: 'Computer power', admin: true},
];

export const SERVICE_FILTERS: Array<{id: ServiceFilter; label: string}> = [
  {id: 'all', label: 'All'}, {id: 'applications', label: 'Applications'},
  {id: 'runtime', label: 'AI Runtime'}, {id: 'platform', label: 'Platform'},
];

const allowed = <T extends {admin?: boolean; identity?: boolean}>(items: T[], session: Session) => items.filter((item) => (
  (!item.admin || canAdminister(session)) && (!item.identity || session.identityManagementAvailable !== false)
));

export const availablePages = (snapshot: DashboardSnapshot) => allowed(PAGES, snapshot.session);
export const availableSystemSections = (snapshot: DashboardSnapshot) => allowed(SYSTEM_SECTIONS, snapshot.session);
export const activeSystemSection = (snapshot: DashboardSnapshot, section: SystemSectionId): SystemSectionId =>
  availableSystemSections(snapshot).some((item) => item.id === section) ? section : 'status';

export const userSource = (user: User) => {
  if (typeof user.source === 'object' && user.source) {
    const source = user.source as Record<string, unknown>;
    return String(source.provider ?? source.alias ?? source.type ?? source.displayName ?? 'external');
  }
  return String(user.provider ?? user.source ?? 'local');
};
export const isLocalUser = (user: User) => user.local ?? ['local', 'keycloak', 'internal'].includes(userSource(user).toLowerCase());

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const text = (width: number, value: string, tone?: Parameters<typeof span>[1]): Row => fit(width, [span(value, tone)]);
const blank: Row = [];
const statusBadge = (phase?: string): Span => {
  const label = phase || 'Unknown';
  return badge(label, phaseToneOf(phaseTone(label)), !['disabled', 'suspended'].includes(label.toLowerCase()));
};
const heading = (width: number, title: string, subtitle: string, actions: Row = []): Row[] => [
  fit(width, [span(title, undefined, true)], actions),
  ...(subtitle ? [text(width, subtitle, 'dim')] : []),
  blank,
];
const sectionLabel = (width: number, title: string, detail: string): Row => fit(width, [span(title.toUpperCase(), undefined, true), ...(detail ? [span(` · ${detail}`, 'dim')] : [])]);
const linkRows = (links: ResourceLink[]): Row[] => links.map((item) => [link(item.url), span(`  ${item.scope}`, 'dim')]);
const progressRows = (phase: string, enabled: boolean | undefined, message?: string): Row[] => {
  if (!phaseInProgress(phase) && !phaseNeedsAttention(phase)) return [];
  const progress = progressForPhase(phase, enabled, message);
  return [progressBar(progress.value, progress.label, phaseToneOf(progress.tone))];
};
const note = (width: number, title: string, value: string): Row[] => panel(width, {title}, prose(width - 4, value, 'dim'));

const metrics = (width: number, items: Array<{label: string; value: string; detail: Span}>): Row[] => {
  const size = Math.floor((width - (items.length - 1)) / items.length);
  const last = width - (size + 1) * (items.length - 1);
  const boxes = items.map((item, index) => panel(index === items.length - 1 ? last : size, {title: item.label}, [[span(item.value, undefined, true), gap(2), item.detail]]));
  return boxes[0]!.map((_, index) => boxes.flatMap((box, column) => column ? [gap(1), ...box[index]!] : box[index]!));
};

const modulePhase = (state: ModuleState, spec: ModuleCatalogEntry | undefined, phase?: string) =>
  phase ?? ((state.activationMode ?? spec?.activationMode) === 'static' && state.enabled ? 'Ready' : state.enabled ? 'Requested' : 'Disabled');

const instanceTitle = (type: string, name: string) => {
  const prefix = `${type}-`;
  const shortName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return `${titleFromKey(type)}${shortName && shortName !== type ? ` ${shortName}` : ''}`;
};

const overviewPage = (snapshot: DashboardSnapshot, width: number): PageView => {
  const moduleEntries = Object.entries(snapshot.modules.modules ?? {});
  const catalog = snapshot.modules.catalogJson?.modules ?? {};
  const instances = flattenInstances(snapshot.instances);
  const activations = snapshot.models.activations ?? [];
  const activationNames = new Set(activations.map((item) => item.metadata?.name).filter(Boolean));
  const registered = (snapshot.models.models ?? []).filter((model) => !activationNames.has(model.id) && !activationNames.has(model.name));
  const telemetry = (snapshot.models.vram as {available?: boolean} | undefined)?.available;
  const statusOf = (id: string, state: ModuleState) => effectiveModuleStatus(id, state, snapshot.status, telemetry);

  const resources = [
    ...instances.map((item) => ({
      title: instanceTitle(item.type, item.name), subtitle: 'Instance',
      phase: item.value.status?.phase ?? (item.value.spec?.enabled !== false ? 'Requested' : 'Suspended'),
      links: instanceResourceLinks(item.value, snapshot.status),
    })),
    ...moduleEntries.map(([id, state]) => ({
      title: state.displayName ?? catalog[id]?.displayName ?? titleFromKey(id), subtitle: 'Module',
      phase: modulePhase(state, catalog[id], statusOf(id, state).phase),
      links: moduleResourceLinks(id, catalog[id], snapshot.status),
    })),
  ].filter((item) => item.links.length);
  const urlCount = new Set(resources.flatMap((item) => item.links.map((entry) => entry.url.replace(/\/$/, '')))).size;

  const attention: Array<{title: string; detail: string; phase: string}> = [];
  const conditions = Array.isArray(snapshot.appliance.status?.conditions) ? snapshot.appliance.status.conditions as Array<Record<string, unknown>> : [];
  conditions.forEach((condition) => {
    if (condition.status && condition.status !== 'True') attention.push({title: `Appliance ${String(condition.type ?? 'Condition')}`, detail: String(condition.reason ?? condition.message ?? condition.status), phase: 'Degraded'});
  });
  moduleEntries.forEach(([id, state]) => {
    const status = statusOf(id, state);
    const phase = status.phase ?? (state.enabled ? 'Requested' : 'Disabled');
    if (state.enabled && phaseNeedsAttention(phase)) attention.push({title: `Module ${state.displayName ?? catalog[id]?.displayName ?? titleFromKey(id)}`, detail: status.message ?? phase, phase});
  });
  instances.forEach((item) => {
    const phase = item.value.status?.phase ?? (item.value.spec?.enabled === false ? 'Suspended' : 'Requested');
    if (phaseNeedsAttention(phase)) attention.push({title: `Instance ${instanceTitle(item.type, item.name)}`, detail: item.value.status?.message ?? phase, phase});
  });
  activations.forEach((item) => {
    const phase = item.status?.phase ?? (item.spec?.enabled === false ? 'Disabled' : 'Requested');
    if (phaseNeedsAttention(phase)) attention.push({title: `Model ${item.metadata?.name ?? 'unnamed'}`, detail: item.status?.message ?? phase, phase});
  });
  (snapshot.status.fluxKustomizations ?? []).forEach((item) => {
    const ready = item.conditions?.find((condition) => condition.type === 'Ready');
    if (ready?.status && ready.status !== 'True') attention.push({title: `Flux ${item.name ?? 'Kustomization'}`, detail: ready.reason ?? ready.message ?? ready.status, phase: 'Reconciling'});
  });

  const inner = width - 4;
  return {hotkeys: [], rows: [
    ...heading(width, 'Overview', 'Live state from the shared appliance control plane.'),
    ...metrics(width, [
      {label: 'Appliance', value: snapshot.appliance.metadata?.name ?? 'local', detail: statusBadge(snapshot.appliance.status?.phase)},
      {label: 'Modules', value: String(moduleEntries.filter(([, item]) => item.enabled).length), detail: span('enabled', 'dim')},
      {label: 'Instances', value: String(instances.length), detail: span('configured', 'dim')},
      {label: 'Models', value: String(activations.length + registered.length), detail: span('available', 'dim')},
    ]),
    blank,
    ...panel(width, {title: 'Available URLs', meta: `${plural(urlCount, 'URL')} from modules and instances`}, resources.length
      ? resources.flatMap((item) => [
        fit(inner, [span(item.title, undefined, true), span(`  ${item.subtitle}`, 'dim')], [statusBadge(item.phase)]),
        ...linkRows(item.links).map((row) => [gap(2), ...row]),
      ])
      : [text(inner, 'No module or instance URLs discovered yet.', 'dim')]),
    ...panel(width, {title: 'Attention', meta: attention.length ? plural(attention.length, 'item') : 'No issues'}, attention.length
      ? attention.flatMap((item) => [
        fit(inner, [span(item.title, undefined, true)], [statusBadge(item.phase)]),
        ...prose(inner - 2, item.detail, 'dim').map((row) => [gap(2), ...row]),
      ])
      : [text(inner, 'No issues detected.', 'dim')]),
  ]};
};

const computeMemoryLines = (snapshot: DashboardSnapshot) => [
  ...(snapshot.models.computeMemory?.sharedPools ?? []).flatMap((pool) => [
    `${pool.node}: installed RAM ${formatMi(pool.installedMemoryMi)} / fixed GPU reservation ${formatMi(pool.firmwareReservedMi)}`,
    `  Linux RAM ${formatMi(pool.physicalMemoryMi)} / dynamic GPU ceiling ${formatMi(pool.gpuAccessibleMi)} (within Linux RAM, not extra)`,
    `  One GPU: driver capacity ${formatMi(pool.gpuCapacityMi)} / allocation ${pool.gpuAllocationMode ?? 'unknown'} / source ${pool.gpuCapacitySource ?? 'unavailable'}`,
    '  Dynamic memory is not a protected reservation. Firmware and dynamic limits are not added.',
  ]),
  ...(snapshot.models.computeMemory?.devices ?? []).flatMap((device) => [
    `${device.name ?? device.id}: ${formatMi(device.freeMi)} ${device.gpuAllocationMode === 'shared-gtt' ? 'shared RAM available' : 'free'} / ${formatMi(device.unreservedMi)} unreserved / ${formatMi(device.totalMi)} ${device.memoryArchitecture === 'unified' ? 'budgetable' : 'total'}`,
    ...(device.memoryArchitecture === 'unified' ? [`  Only host runtime and dynamic GPU allocations are charged to Linux RAM; GPU accounting ${device.accountingVerified ? 'verified.' : 'not verified.'}`] : []),
  ]),
];

const modelsPage = (snapshot: DashboardSnapshot, width: number): PageView => {
  const mutable = canMutateRuntime(snapshot.session);
  const activations = (snapshot.models.activations ?? []).filter((item) => Boolean(item.metadata?.name));
  const names = new Set(activations.map((item) => item.metadata?.name));
  const registered = (snapshot.models.models ?? []).filter((model) => !names.has(model.id) && !names.has(model.name));
  const inner = width - 4;
  const memory = computeMemoryLines(snapshot);
  return {hotkeys: mutable ? [{key: 'a', label: 'Add model', actionId: 'model:add'}] : [], rows: [
    ...heading(width, 'Models', `${activations.length} installed · ${registered.length} registered`, mutable ? [button('model:add', 'Add Model', 'primary')] : []),
    ...panel(width, {title: 'Compute memory'}, memory.length ? memory.flatMap((line) => prose(inner, line)) : [text(inner, 'No compute memory has been reported.', 'dim')]),
    blank,
    sectionLabel(width, 'Installed Models', plural(activations.length, 'model')),
    ...activations.flatMap((item) => {
      const name = item.metadata?.name ?? 'unnamed';
      const local = item.spec?.local ?? {};
      const removing = Boolean(item.metadata?.deletionTimestamp);
      const phase = removing ? 'Removing' : item.status?.phase ?? (item.spec?.enabled === false ? 'Disabled' : 'Requested');
      const phaseName = phase.toLowerCase();
      const stopped = item.spec?.enabled === false;
      const stopping = stopped && !['disabled', 'stopped'].includes(phaseName);
      // Same rules as the browser: no lifecycle change while stopping or removing, or without a saved revision.
      const blocked = stopping ? 'Waiting for this model to finish stopping.'
        : phaseName === 'removing' ? 'This model is being removed.'
          : modelEditRevision(item) ? undefined : 'The model has no saved revision yet. Reload and try again.';
      const actions: Row = !mutable ? [] : joinSpans([
        ...(!removing && !stopped && item.spec?.type !== 'external' && Boolean(local.realtime) ? [button(`model:restart:${name}`, 'Restart', 'ghost', blocked)] : []),
        ...(!removing ? [stopped ? button(`model:start:${name}`, 'Start', 'primary', blocked) : button(`model:stop:${name}`, 'Stop', 'ghost', blocked)] : []),
        button(`model:remove:${name}`, 'Remove', 'danger', phaseName === 'removing' ? 'This model is being removed.' : undefined),
      ]);
      const detail = item.spec?.type === 'external'
        ? `External · ${String((item.spec?.external as Record<string, unknown> | undefined)?.model ?? 'external')}`
        : `${String(local.engine ?? '')} ${String(local.computeTarget ?? '')} · KV ${String(item.status?.effectiveKvCacheType || item.status?.requestedKvCacheType || local.kvCacheType || 'default')}${item.status?.requestedKvCacheType && !item.status?.effectiveKvCacheType ? ' (pending)' : ''}${local.cpuOffloading ? ` · CPU offloading · host RAM ${formatMi(Number(item.status?.memoryRequiredMi ?? local.memoryRequiredMi))}` : ''}`.trim();
      const message = item.status?.message && phase.toLowerCase() !== 'ready' ? String(item.status.message) : '';
      return panel(width, {title: name, meta: detail, status: statusBadge(phase)}, [
        ...(actions.length || message ? [fit(inner, [span(message, 'dim')], actions)] : []),
        ...progressRows(phase, item.spec?.enabled !== false, message),
      ]);
    }),
    ...(activations.length ? [] : [text(width, 'No models are installed yet.', 'dim')]),
    blank,
    ...panel(width, {title: 'Registered Models', meta: plural(registered.length, 'model')}, registered.length
      ? registered.map((model) => fit(inner, [span(String(model.id ?? model.name ?? 'unnamed')), span(model.type ? `  ${String(model.type)}` : '', 'dim')]))
      : [text(inner, 'No additional models are registered.', 'dim')]),
  ]};
};

/** Chat models an application instance can use, as the browser's create form lists them. */
export const deployedChatModels = (snapshot: DashboardSnapshot) => [...new Set((snapshot.models.models ?? [])
  .filter((model) => String(model.type ?? '').toLowerCase() === 'chat').map((model) => String(model.id ?? model.name ?? '')).filter(Boolean))].sort();

const servicesPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const mutable = canMutateRuntime(snapshot.session);
  const catalog = snapshot.modules.catalogJson?.modules ?? {};
  const states = snapshot.modules.modules ?? {};
  const definitions = snapshot.modules.catalogJson?.applications ?? {};
  const instances = flattenInstances(snapshot.instances);
  const telemetry = (snapshot.models.vram as {available?: boolean} | undefined)?.available;
  const statusOf = (id: string, module: ModuleState) => effectiveModuleStatus(id, module, snapshot.status, telemetry);
  const applications = Object.entries(definitions).map(([id, definition]) => ({
    id, label: definition.displayName ?? titleFromKey(id), definition,
    missing: missingApplicationModules(definition, states, catalog),
  })).sort((left, right) => left.label.localeCompare(right.label));
  const primaryModules = new Set(applications.map((item) => item.definition.requiredModules?.[0]).filter(Boolean));
  const moduleEntries = Object.entries(states).sort(([left], [right]) => (catalog[left]?.order ?? 9999) - (catalog[right]?.order ?? 9999) || left.localeCompare(right));
  const inner = width - 4;
  const admin = canAdminister(snapshot.session);
  const chatModels = deployedChatModels(snapshot);
  const anyReady = applications.some((item) => !item.missing.length);
  const createBlocked = !anyReady ? 'No application has all of its required services ready.'
    : chatModels.length ? undefined : 'Add a chat model first: applications need a deployed chat model.';

  const controls = (id: string, module: ModuleState, phase: string): Row => {
    if (!mutable) return [];
    const removing = phase.toLowerCase() === 'removing';
    const busy = phaseInProgress(phase) ? 'Wait until the current change has finished.' : undefined;
    return joinSpans([
      ...(catalog[id]?.credentials?.provider && module.enabled && !removing ? [button(`service:credentials:${id}`, 'Credentials')] : []),
      ...((module.activationMode ?? catalog[id]?.activationMode) === 'moduleactivation'
        ? [module.enabled ? button(`service:disable:${id}`, 'Disable', 'danger', busy) : button(`service:enable:${id}`, 'Enable', 'primary', busy)] : []),
    ]);
  };

  const moduleCard = ([id, module]: [string, ModuleState]): Row[] => {
    const spec = catalog[id];
    const status = statusOf(id, module);
    const phase = modulePhase(module, spec, status.phase);
    const description = String(status.message || spec?.description || '');
    const actions = controls(id, module, phase);
    return panel(width, {title: module.displayName ?? spec?.displayName ?? titleFromKey(id), meta: id, status: statusBadge(phase)}, [
      ...(description || actions.length ? [fit(inner, [span(description, 'dim')], actions)] : []),
      ...progressRows(phase, module.enabled, status.message),
      ...linkRows(moduleResourceLinks(id, spec, snapshot.status)),
    ]);
  };

  const instanceRows = (item: FlatInstance): Row[] => {
    const enabled = item.value.spec?.enabled !== false;
    const phase = item.value.status?.phase ?? (enabled ? 'Requested' : 'Suspended');
    const access = item.value.spec?.access?.authentication === 'none' ? 'public without login' : `SSO: ${item.value.spec?.access?.role ?? 'user'}`;
    const message = item.value.status?.message && phase.toLowerCase() !== 'ready' ? String(item.value.status.message) : '';
    const removing = phase.toLowerCase() === 'removing';
    const restricted = item.value.spec?.access?.sharing?.mode === 'selected';
    const actions = removing ? [] : [
      ...(mutable && instanceHasCredentials(item.type) ? [button(`instance:credentials:${item.name}`, 'Credentials')] : []),
      ...(admin ? [button(`instance:sharing:${item.name}`, 'Sharing')] : []),
      ...(mutable && (!restricted || admin) ? [button(`instance:remove:${item.name}`, 'Remove', 'danger')] : []),
    ];
    return [
      fit(inner, [gap(2), span(item.name, undefined, true), span(`  ${item.value.spec?.targetNamespace ?? 'ai'} · ${access}${restricted ? ' · selected users and groups' : ''}`, 'dim')],
        [statusBadge(phase), ...(actions.length ? [gap(2), ...joinSpans(actions)] : [])]),
      ...progressRows(phase, enabled, message).map((row) => [gap(2), ...row]),
      ...linkRows(instanceResourceLinks(item.value, snapshot.status)).map((row) => [gap(2), ...row]),
    ];
  };

  const applicationCard = (application: (typeof applications)[number]): Row[] => {
    const primaryId = application.definition.requiredModules?.[0] ?? '';
    const primary = states[primaryId];
    const spec = catalog[primaryId];
    const items = instances.filter((item) => item.type === application.id);
    const open = state.expanded[`app:${application.id}`] ?? false;
    const status = primary ? statusOf(primaryId, primary) : {};
    const phase = !application.missing.length ? 'Ready' : status.phase ?? (primary?.enabled ? 'Waiting' : 'Disabled');
    const instanceUrls = new Set(items.flatMap((item) => instanceResourceLinks(item.value, snapshot.status)).map((entry) => entry.url.replace(/\/$/, '')));
    const links = (primaryId ? moduleResourceLinks(primaryId, spec, snapshot.status) : []).filter((entry) => !instanceUrls.has(entry.url.replace(/\/$/, '')));
    const actions = joinSpans([
      ...(mutable && !application.missing.length && chatModels.length ? [button(`instance:create:${application.id}`, 'New Instance', 'primary')] : []),
      ...(primary ? controls(primaryId, primary, phase) : []),
    ]);
    const expander: Row = items.length ? [toggle(`expand:app:${application.id}`, open ? 'Hide' : `Show ${plural(items.length, 'instance')}`, open)] : [];
    return panel(width, {title: application.label, meta: `Module · ${plural(items.length, 'instance')}`, status: statusBadge(phase)}, [
      ...(expander.length || actions.length ? [fit(inner, expander, actions)] : []),
      ...(application.missing.length ? prose(inner, `Required services are not ready: ${application.missing.map((id) => catalog[id]?.displayName ?? titleFromKey(id)).join(', ')}.`, 'dim') : []),
      ...progressRows(phase, primary?.enabled, status.message),
      ...linkRows(links),
      ...(open ? [divider(inner), ...items.flatMap(instanceRows)] : []),
    ]);
  };

  const standalone = moduleEntries.filter(([id]) => !primaryModules.has(id) && catalog[id]?.group === 'apps');
  const runtime = moduleEntries.filter(([id]) => !primaryModules.has(id) && catalog[id]?.group === 'runtime');
  const platform = moduleEntries.filter(([id]) => !primaryModules.has(id) && !['apps', 'runtime'].includes(catalog[id]?.group ?? 'other'));
  const show = (section: ServiceFilter) => state.serviceFilter === 'all' || state.serviceFilter === section;
  const platformOpen = state.serviceFilter === 'platform' || (state.expanded.platform ?? false);

  return {hotkeys: [{key: 'f', label: 'Filter', actionId: 'filter:next'}, ...(mutable && !createBlocked ? [{key: 'n', label: 'New instance', actionId: 'instance:create'}] : [])], rows: [
    ...heading(width, 'Services', `${plural(moduleEntries.filter(([, module]) => module.enabled).length, 'module')} enabled · ${plural(instances.length, 'instance')}`,
      mutable ? [button('instance:create', 'Create Instance', 'primary', createBlocked)] : []),
    joinSpans(SERVICE_FILTERS.map((item) => choice(`filter:${item.id}`, item.label, state.serviceFilter === item.id)), 2),
    blank,
    ...(show('applications') ? [
      sectionLabel(width, 'Applications', `${plural(applications.length + standalone.length, 'service')} · ${plural(instances.length, 'instance')}`),
      ...applications.flatMap(applicationCard),
      ...standalone.flatMap(moduleCard),
      ...(applications.length || standalone.length ? [] : [text(width, 'No application services are catalogued.', 'dim')]),
      blank,
    ] : []),
    ...(show('runtime') ? [
      sectionLabel(width, 'AI Runtime', plural(runtime.length, 'module')),
      ...runtime.flatMap(moduleCard),
      ...(runtime.length ? [] : [text(width, 'No shared AI runtime modules are catalogued.', 'dim')]),
      blank,
    ] : []),
    ...(show('platform') ? [
      fit(width, [toggle('expand:platform', 'Platform & Operators', platformOpen), span(` · ${plural(platform.length, 'technical module')}`, 'dim')]),
      ...(platformOpen ? platform.flatMap(moduleCard) : []),
    ] : []),
  ]};
};

const apiAccessPage = (snapshot: DashboardSnapshot, width: number): PageView => {
  const inner = width - 4;
  const items = snapshot.apiAccess?.items ?? [];
  return {hotkeys: [{key: 'a', label: 'Create key', actionId: 'apikey:create'}], rows: [
    ...heading(width, 'API Access', `${plural(snapshot.apiAccess?.total ?? 0, 'named API key')}`, [button('apikey:create', 'Create API Key', 'primary')]),
    ...panel(width, {title: 'API bases'}, (snapshot.apiAccess?.apiBases ?? []).length
      ? (snapshot.apiAccess?.apiBases ?? []).map((item) => [span((item.scope ?? 'api').padEnd(10), 'dim'), link(item.url)])
      : [text(inner, 'No API base has been reported.', 'dim')]),
    ...panel(width, {title: 'Named keys'}, items.length
      ? table(inner, [{header: 'Name', max: 30}, {header: 'Key ID', max: 22}, {header: 'Created', max: 20}, {header: 'Status'}], items.map((item) => {
        const status = item.status ?? 'active';
        return {
          cells: [span(item.name, undefined, true), span(item.keyHint ?? ''), span(String(item.createdAt ?? '').slice(0, 19), 'dim'), statusBadge(titleFromKey(status))],
          actions: [button(`apikey:revoke:${item.id}`, 'Revoke', 'danger', status === 'active' ? undefined : 'This key is no longer active.')],
        };
      }))
      : [text(inner, 'No named API keys exist yet.', 'dim')]),
  ]};
};

const kubernetesPage = (snapshot: DashboardSnapshot, width: number): PageView => {
  const inner = width - 4;
  const configured = Boolean(snapshot.kubernetesAccess?.configuration?.configured);
  const users = snapshot.kubernetesAccess?.users ?? [];
  return {hotkeys: [], rows: [
    ...heading(width, 'Kubernetes Access', plural(snapshot.kubernetesAccess?.total ?? 0, 'identity').replace('identitys', 'identities')),
    fit(width, [span('OIDC configuration  ', undefined, true), configured ? badge('Configured', 'good') : badge('Not confirmed', 'warn')]),
    blank,
    ...panel(width, {title: 'Users'}, users.length ? [
      fit(inner, [span('User'.padEnd(24), 'dim'), span('Source'.padEnd(12), 'dim'), span('Status'.padEnd(12), 'dim'), span('Kubernetes Access', 'dim')]),
      ...users.flatMap((user) => {
        const level = user.accessLevel ?? 'none';
        const locked = user.protected ? 'Recovery access cannot be changed.' : undefined;
        return [
          fit(inner, [
            span(user.username.padEnd(24).slice(0, 24), undefined, true), span(String(user.provider ?? user.source ?? 'local').padEnd(12).slice(0, 12), 'dim'),
            {...(user.enabled ? badge('Enabled', 'good') : badge('Disabled', 'dim', false)), text: `${user.enabled ? '● Enabled' : '○ Disabled'}`.padEnd(12)},
            span(level === 'none' ? 'No access' : level === 'admin' ? 'Cluster Administrator' : titleFromKey(level)),
          ]),
          fit(inner, [], [
            button(`k8s:access:${user.id}`, 'Access', 'ghost', locked),
            gap(),
            ...(level !== 'none' ? [button(`k8s:revoke:${user.id}`, 'Revoke', 'danger', locked), gap()] : []),
            button(`k8s:copy:${user.id}`, 'Copy kubeconfig', 'ghost', configured ? undefined : 'The Kubernetes API server has not confirmed OIDC.'),
          ]),
        ];
      }),
    ] : [text(inner, 'No identities are available.', 'dim')]),
  ]};
};

const settingsRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const inner = width - 4;
  const access = snapshot.consoleAccess;
  return [
    ...panel(width, {title: 'Domains'}, [
      text(inner, `Public domain   ${snapshot.settings?.publicDomain ?? 'unavailable'}`),
      text(inner, `Dashboard host  ${snapshot.settings?.dashboardHost ?? 'unavailable'}`),
      text(inner, `mDNS domain     ${snapshot.settings?.mdnsDomain ?? 'unavailable'}`),
    ]),
    ...(access ? panel(width, {title: 'Local console'}, [
      fit(inner, [span(`Automatic sign-in  ${access.available ? consoleAccessLabel(access.accessLevel) : 'Not provisioned on this appliance yet'}`)],
        access.available ? [button('console:edit', 'Change')] : []),
      ...(access.available && access.accessLevel !== 'off' ? [text(inner, 'Anyone at the attached keyboard has this access without a password.', 'dim')] : []),
    ]) : []),
    text(width, 'Domains, Federated SSO, Network and Updates are changed in the browser dashboard.', 'dim'),
  ];
};

const licenseRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const inner = width - 4;
  const status = snapshot.license;
  if (!status) return note(width, 'License status', snapshot.licenseError ?? 'No license status loaded.');
  return panel(width, {title: status.valid ? 'Valid license' : 'License status', status: status.valid ? badge('Valid', 'good') : badge(titleFromKey(status.state), 'dim', false)}, [
    ...licenseLines(status).flatMap((line) => prose(inner, line)),
    blank,
    fit(inner, [], [
      button('license:import', 'Import license', 'primary'), gap(),
      button('license:export', 'Export license', 'ghost', status.hasDocument ? undefined : 'No license document is installed.'),
    ]),
  ]);
};

const usersRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const inner = width - 4;
  const users = snapshot.users?.users ?? [];
  const blocked = (allowedHere: boolean | undefined, reason: string) => allowedHere === false ? reason : undefined;
  return [
    fit(width, [span(plural(snapshot.users?.total ?? 0, 'user'), 'dim')], [button('user:create', 'Add User', 'primary')]),
    ...panel(width, {title: 'User overview'}, users.length ? [
      fit(inner, [span('User'.padEnd(22), 'dim'), span('Email'.padEnd(30), 'dim'), span('Source'.padEnd(12), 'dim'), span('Status'.padEnd(12), 'dim'), span('Access', 'dim')]),
      ...users.flatMap((user) => {
        const local = isLocalUser(user);
        const external = 'This identity is protected or managed by an external identity provider.';
        return [
          fit(inner, [
            span(user.username.padEnd(22).slice(0, 22), undefined, true), span((user.email ?? '').padEnd(30).slice(0, 30), 'dim'),
            span(userSource(user).padEnd(12).slice(0, 12), 'dim'),
            {...(user.enabled === false ? badge('Disabled', 'dim', false) : badge('Enabled', 'good')), text: (user.enabled === false ? '○ Disabled' : '● Enabled').padEnd(12)},
            span(titleFromKey(user.effectiveAccessLevel ?? user.accessLevel ?? 'user')),
          ]),
          fit(inner, [], joinSpans([
            button(`user:profile:${user.id}`, 'Edit', 'ghost', user.capabilities?.canEditProfile === false || !local ? external : undefined),
            button(`user:access:${user.id}`, 'Access', 'ghost', blocked(user.capabilities?.canManageRoles, 'The access level for this identity cannot be changed.')),
            button(`user:toggle:${user.id}`, user.enabled === false ? 'Enable' : 'Disable', 'ghost', blocked(user.enabled === false ? user.capabilities?.canEnable : user.capabilities?.canDisable, 'This account is protected.')),
            button(`user:password:${user.id}`, 'Password', 'ghost', user.capabilities?.canResetPassword === false || !local ? external : undefined),
            button(`user:delete:${user.id}`, 'Delete', 'danger', user.capabilities?.canDelete === false || !local ? 'Self, recovery, last-admin, protected, and external accounts cannot be deleted here.' : undefined),
          ])),
        ];
      }),
    ] : [text(inner, 'No users were returned.', 'dim')]),
  ];
};

const hardwareRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const inner = width - 4;
  const admin = canAdminister(snapshot.session);
  const operators = Object.entries(snapshot.status.hardwareOperators ?? {});
  const compatibility = snapshot.status.hardwareOperators?.['amd-gpu']?.compatibility;
  return [
    ...panel(width, {title: 'GPU operators'}, operators.length
      ? operators.map(([id, item]) => fit(inner, [span(item.displayName ?? titleFromKey(id), undefined, true), span(`  ${item.allocatableResources ?? 0} GPU resources`, 'dim')], [statusBadge(item.phase)]))
      : [text(inner, 'No GPU operator has been reported.', 'dim')]),
    ...panel(width, {title: 'AMD runtime profile'}, [
      text(inner, `AMD compatibility profile: ${compatibility?.selectedProfile || 'upstream rules'}`),
      ...prose(inner, 'GPU availability requires host readiness and resource registration; engine validation is optional.', 'dim'),
      ...(compatibility ? [] : [text(inner, 'GPU compatibility catalog has not been reported.', 'dim')]),
      ...(admin ? [fit(inner, [], [
        button('hardware:profile', 'Change profile'), gap(),
        button('hardware:validate', 'Run validation', 'ghost', compatibility?.selectedProfile ? undefined : 'GPU validation requires a saved compatibility profile.'), gap(),
        button('hardware:upstream', 'Use upstream rules', 'danger'),
      ])] : []),
    ]),
    ...(compatibility?.nodes ?? []).flatMap((node) => panel(width, {title: node.node, meta: `GPU node · ${node.profileId || 'upstream'}`, status: node.eligible ? badge('Eligible', 'good') : badge('Not eligible', 'warn')}, [
      `Driver: ${node.hostDriverReady === true ? 'ready' : 'not verified'} · GPU resource: ${node.resourceRegistered === true ? 'registered' : 'not verified'}`,
      `Ollama: ${gpuValidationSummary(node.validation?.OLlama)} · vLLM: ${gpuValidationSummary(node.validation?.VLLM)}`,
      ...Object.entries(node.validation ?? {}).filter(([, validation]) => validation.runtimeMessage).map(([engine, validation]) => `${engine}: ${validation.runtimeMessage}`),
      ...(node.memoryArchitecture === 'unified' ? [
        `Installed RAM: ${formatMi(node.installedMemoryMi)} / fixed GPU reservation: ${formatMi(node.firmwareReservedMi)}`,
        `OS-visible shared RAM: ${formatMi(node.physicalMemoryMi)} / dynamic GPU ceiling: ${formatMi(node.gpuAccessibleMi)} (within Linux RAM, not extra).`,
        `One GPU: driver capacity ${formatMi(node.gpuCapacityMi)} / allocation ${node.gpuAllocationMode ?? 'unknown'} / source ${node.gpuCapacitySource ?? 'unavailable'}`,
        'Dynamic memory is not a protected reservation. Firmware and dynamic limits are not added.',
        `Shared accounting: ${node.memoryAccountingVerified ? 'verified' : 'not verified'}`,
      ] : []),
    ].flatMap((line) => prose(inner, line)))),
  ];
};

const statusRows = (snapshot: DashboardSnapshot, width: number): Row[] => {
  const inner = width - 4;
  const operators = Object.entries(snapshot.status.hardwareOperators ?? {});
  const count = (label: string, value?: unknown[]) => text(inner, `${label.padEnd(16)} ${value?.length ?? 0}`);
  return [
    ...panel(width, {title: 'Status summary', status: statusBadge(snapshot.appliance.status?.phase)}, [
      count('Flux', snapshot.status.fluxKustomizations), count('Pods', snapshot.status.pods), count('Services', snapshot.status.services),
      count('Ingresses', snapshot.status.ingresses), count('HTTP routes', snapshot.status.httpRoutes),
    ]),
    ...panel(width, {title: 'GPU Operators'}, operators.length ? operators.flatMap(([id, item]) => [
      fit(inner, [span(item.displayName ?? titleFromKey(id), undefined, true)], [statusBadge(item.phase)]),
      ...(item.message ? prose(inner - 2, String(item.message), 'dim').map((row) => [gap(2), ...row]) : []),
    ]) : [text(inner, 'No GPU operator has been reported.', 'dim')]),
    text(width, 'Flux details, routes, the model cache and regression tests are shown in the browser dashboard.', 'dim'),
  ];
};

const systemPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const sections = availableSystemSections(snapshot);
  const active = activeSystemSection(snapshot, state.systemSection);
  const body = active === 'settings' ? settingsRows(snapshot, width)
    : active === 'license' ? licenseRows(snapshot, width)
      : active === 'users' ? usersRows(snapshot, width)
        : active === 'hardware' ? hardwareRows(snapshot, width)
          : active === 'power' ? note(width, 'Computer power', 'Restart and shut down the computer in the browser dashboard under System → Computer power.')
            : statusRows(snapshot, width);
  const hotkeys: Hotkey[] = [
    {key: 's', label: 'Section', actionId: 'section:next'},
    ...(active === 'users' ? [{key: 'a', label: 'Add user', actionId: 'user:create'}] : []),
    ...(active === 'license' && snapshot.license ? [{key: 'i', label: 'Import', actionId: 'license:import'}, {key: 'e', label: 'Export', actionId: 'license:export'}] : []),
    ...(active === 'settings' && snapshot.consoleAccess?.available ? [{key: 'e', label: 'Monitor sign-in', actionId: 'console:edit'}] : []),
  ];
  return {hotkeys, rows: [
    ...heading(width, 'System', ''),
    joinSpans(sections.map((item) => choice(`section:${item.id}`, item.label, item.id === active)), 2),
    blank,
    ...body,
  ]};
};

export const buildPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  switch (state.page) {
    case 'models': return modelsPage(snapshot, width);
    case 'services': return servicesPage(snapshot, state, width);
    case 'api-access': return apiAccessPage(snapshot, width);
    case 'mesh': return {hotkeys: [], rows: [
      ...heading(width, 'Private Mesh', 'Share models between your own appliances.'),
      ...note(width, 'Private Mesh', 'Creating, joining and managing a mesh is done in the browser dashboard under Mesh.'),
    ]};
    case 'kubernetes-access': return kubernetesPage(snapshot, width);
    case 'system': return systemPage(snapshot, state, width);
    default: return overviewPage(snapshot, width);
  }
};
