// Services page: applications, their instances and modules, and the instance
// create/sharing/credential actions (apps/web/src/pages/ServicesPage.tsx, InstanceSharing.tsx).
import {
  canAdminister, canMutateRuntime, effectiveModuleStatus, flattenInstances, initialInstanceDraft, instanceCreatePayload,
  instanceHasCredentials, instanceModelRequired, instanceResourceLinks, instanceStorageDefault, missingApplicationModules,
  moduleResourceLinks, phaseInProgress, titleFromKey, type FlatInstance, type InstanceDraft,
} from '@magicstick/dashboard-core';
import type {
  InstanceAccessState, InstanceSharing, ModelsPayload, ModuleCatalogEntry, ModuleState, SharingPrincipal,
} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {Choice, DialogItem, InlineButton} from './tui-dialogs';
import {SERVICE_FILTERS, type PageState, type PageView, type ServiceFilter} from './tui-state';
import {button, divider, fit, gap, joinSpans, panel, prose, span, textWidth, toggle, type Row} from './tui-screen';
import {
  blank, deployedChatModels, heading, linkRows, modulePhase, plural, progressRows, sectionLabel, statusBadge, tabBar, text,
} from './tui-widgets';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Saved module parameters as the browser's form shows them: sizes of storage objects, everything else as text. */
export const savedParameters = (state?: ModuleState): Record<string, string> => Object.fromEntries(Object.entries((state?.parameters ?? {}) as Record<string, unknown>)
  .map(([key, value]) => [key, typeof value === 'object' && value ? String((value as Record<string, unknown>).size ?? (value as Record<string, unknown>).storageSize ?? '') : String(value ?? '')]));

/** Deployed models of one type, the choices of a catalog parameter of type `model`. */
export const modelChoices = (models: ModelsPayload['models'], type?: string) => [...new Set((models ?? [])
  .filter((model) => model.type === type).map((model) => String(model.id ?? model.name ?? '')).filter(Boolean))].sort();

export const invalidModelParameter = (catalog: ModuleCatalogEntry | undefined, values: Record<string, string>, models: ModelsPayload['models']) =>
  catalog?.parameters?.find((parameter) => parameter.type === 'model' && values[parameter.name]
    && !modelChoices(models, parameter.modelType).includes(values[parameter.name]!));

/** Splits inline buttons into rows that fit a dialog, like the browser's wrapping button lists. */
export const buttonRows = (entries: InlineButton[], width = 72): DialogItem[] => {
  const rows: InlineButton[][] = [];
  let row: InlineButton[] = [];
  let used = 0;
  for (const entry of entries) {
    const size = textWidth(entry.label) + 5;
    if (row.length && used + size > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(entry);
    used += size;
  }
  if (row.length) rows.push(row);
  return rows.map((items) => ({kind: 'buttons', items}));
};

export const servicesPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
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
  // Disabled modules with catalog parameters are configured in the Enable dialog, like the browser's Configure section.
  const parameterHint = (id: string, module: ModuleState): Row[] => {
    const parameters = catalog[id]?.parameters ?? [];
    if (module.enabled || !parameters.length) return [];
    return prose(inner, `Configurable when enabling: ${parameters.map((parameter) => parameter.label ?? titleFromKey(parameter.name)).join(', ')}.`, 'dim');
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
      ...(mutable ? parameterHint(id, module) : []),
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
      ...(message ? prose(inner - 2, message, 'dim').map((row) => [gap(2), ...row]) : []),
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
      ...(mutable && primary ? parameterHint(primaryId, primary) : []),
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
    tabBar('filter', SERVICE_FILTERS, state.serviceFilter),
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

type ServiceEntity = {id: string; state: ModuleState; catalog?: ModuleCatalogEntry};

/** The browser's module parameters (Configure) as fields of the Enable dialog. */
export const moduleParameterItems = (catalog: ModuleCatalogEntry | undefined, values: Record<string, string>, models: ModelsPayload['models']): DialogItem[] =>
  (catalog?.parameters ?? []).flatMap((parameter): DialogItem[] => {
    const label = parameter.label ?? titleFromKey(parameter.name);
    const value = values[parameter.name] ?? '';
    const set = (next: string) => { values[parameter.name] = next; };
    if (parameter.type === 'model') {
      const choices = modelChoices(models, parameter.modelType);
      const options: Choice[] = [
        {value: '', label: `Use catalog default${!choices.length ? ' · no model available' : ''}`},
        ...(value && !choices.includes(value) ? [{value, label: `${value} · unavailable`, disabled: `Choose an available ${parameter.modelType ?? ''} model or use the catalog default.`.replace('  ', ' ')}] : []),
        ...choices.map((model) => ({value: model, label: model})),
      ];
      return [{kind: 'choice', id: `param:${parameter.name}`, label, value, choices: options, onChange: set, hint: parameter.description}];
    }
    if (parameter.type === 'number') return [{kind: 'number', id: `param:${parameter.name}`, label, value, onChange: set, hint: parameter.description ?? parameter.placeholder}];
    return [{kind: 'text', id: `param:${parameter.name}`, label, value, onChange: set, secret: parameter.type === 'password', hint: parameter.placeholder},
      ...(parameter.description ? [{kind: 'note' as const, text: parameter.description}] : [])];
  });

const enableService = (ctx: TuiContext, entity: ServiceEntity) => {
  const label = entity.catalog?.displayName ?? titleFromKey(entity.id);
  if (entity.state.enabled) return ctx.message('Service already enabled', `${label} is already enabled.`);
  if ((entity.state.activationMode ?? entity.catalog?.activationMode) !== 'moduleactivation') return ctx.message('Service is static', 'This platform service is managed by the installation and cannot be enabled from the TUI.');
  const apply = (parameters: Record<string, string>) => ctx.perform(`Enable ${label}`, async () => {
    await ctx.api.enableModule(entity.id, parameters);
    return {lines: [`${label} was enabled.`]};
  });
  // The saved values are the starting point, as in the browser; unchanged values are sent again.
  const values = savedParameters(entity.state);
  if (!entity.catalog?.parameters?.length) {
    return ctx.confirm({title: `Enable ${label}`, description: 'The service and its declared dependencies will be reconciled.', confirmLabel: 'enable', onConfirm: () => apply(values)});
  }
  ctx.dialog({
    title: `Enable ${label}`,
    description: 'Configure the service before it is enabled. A model parameter left at the catalog default uses the default model.',
    items: () => moduleParameterItems(entity.catalog, values, ctx.snapshot().models.models),
    submit: {
      label: 'enable',
      disabled: () => {
        const invalid = invalidModelParameter(entity.catalog, values, ctx.snapshot().models.models);
        return invalid ? `Choose an available ${invalid.modelType ?? ''} model for ${invalid.label ?? titleFromKey(invalid.name)} or use the catalog default.`.replace('  ', ' ') : undefined;
      },
      run: () => apply({...values}),
    },
  });
};

const disableService = (ctx: TuiContext, entity: ServiceEntity) => {
  const label = entity.catalog?.displayName ?? titleFromKey(entity.id);
  if (!entity.state.enabled) return ctx.message('Service already disabled', `${label} is already disabled.`);
  if ((entity.state.activationMode ?? entity.catalog?.activationMode) !== 'moduleactivation') return ctx.message('Service is static', 'This platform service is managed by the installation and cannot be disabled from the TUI.');
  ctx.confirm({
    title: `Disable ${label}`, description: 'Dependent workloads may become unavailable. Persistent-data handling follows the module uninstall policy.', confirmLabel: 'disable', danger: true,
    onConfirm: () => ctx.perform(`Disable ${label}`, async () => {
      await ctx.api.disableModule(entity.id);
      return {lines: [`${label} was disabled.`]};
    }),
  });
};

const showCredentials = (ctx: TuiContext, label: string, fetch: () => Promise<{title?: string; credentials?: Array<{key: string; value: string}>}>) =>
  ctx.load(`Credentials · ${label}`, fetch, (result) => ctx.message(`Credentials · ${result.title ?? label}`, [
    'Sensitive values are shown only on request. Close this dialog when you are done.',
    ...((result.credentials ?? []).length ? (result.credentials ?? []).map((entry) => `${entry.key}: ${entry.value}`) : ['No credentials are stored.']),
  ]));

const applicationOptions = (snapshot: DashboardSnapshot) => {
  const catalog = snapshot.modules.catalogJson?.modules ?? {};
  return Object.entries(snapshot.modules.catalogJson?.applications ?? {}).map(([id, definition]) => ({
    id, label: definition.displayName ?? titleFromKey(id),
    missing: missingApplicationModules(definition, snapshot.modules.modules ?? {}, catalog).map((module) => catalog[module]?.displayName ?? titleFromKey(module)),
  })).sort((left, right) => left.label.localeCompare(right.label));
};

/** Directory search and selection of the browser's SharingFields, kept in a dialog's own state. */
export interface SharingEditor {
  sharing: InstanceSharing;
  kind: 'users' | 'groups';
  search: string;
  query: string;
  first: number;
  results?: {items: SharingPrincipal[]; next: number | null};
  loading: boolean;
  error?: string;
  names: Map<string, string>;
  labels: {users: SharingPrincipal[]; groups: SharingPrincipal[]};
  request: number;
}

export const sharingEditor = (sharing: InstanceSharing, labels?: {users: SharingPrincipal[]; groups: SharingPrincipal[]}): SharingEditor => ({
  sharing: {mode: sharing.mode, users: [...(sharing.users ?? [])], groups: [...(sharing.groups ?? [])]},
  kind: 'users', search: '', query: '', first: 0, loading: false, names: new Map(), labels: labels ?? {users: [], groups: []}, request: 0,
});

/** Loads one page of the directory; a newer request always replaces an older one. */
const loadPrincipals = (ctx: TuiContext, editor: SharingEditor) => {
  const request = ++editor.request;
  editor.loading = true;
  editor.error = undefined;
  ctx.draw();
  void ctx.api.instancePrincipals(editor.kind, editor.query, editor.first).then((result) => {
    if (request === editor.request) editor.results = {items: result.items, next: result.next};
  }, (error) => {
    if (request === editor.request) editor.error = errorText(error);
  }).finally(() => {
    if (request !== editor.request) return;
    editor.loading = false;
    ctx.draw();
  });
};

export const sharingItems = (ctx: TuiContext, editor: SharingEditor, changed: () => void, disabled?: string): DialogItem[] => {
  const {sharing} = editor;
  const nameOf = (kind: 'users' | 'groups', id: string) => editor.names.get(`${kind}:${id}`) ?? editor.labels[kind].find((item) => item.id === id)?.name ?? id;
  const selected = sharing[editor.kind] ?? [];
  const total = (sharing.users?.length ?? 0) + (sharing.groups?.length ?? 0);
  const items: DialogItem[] = [
    {kind: 'heading', text: 'Instance sharing'},
    {kind: 'choice', id: 'share-mode', label: 'Visible and accessible to', value: sharing.mode, disabled, choices: [
      {value: 'all', label: 'All users with the required role'}, {value: 'selected', label: 'Selected users or groups'},
    ], onChange: (value) => {
      editor.sharing = {mode: value === 'selected' ? 'selected' : 'all', users: [], groups: []};
      changed();
      if (value === 'selected') {
        editor.first = 0;
        loadPrincipals(ctx, editor);
      }
    }},
  ];
  if (sharing.mode !== 'selected') return items;
  const listed = (kind: 'users' | 'groups'): DialogItem[] => {
    const ids = sharing[kind] ?? [];
    return [
      {kind: 'heading', text: `Selected ${kind}`},
      ...(ids.length ? buttonRows(ids.map((id) => ({
        id: `share-remove:${kind}:${id}`, label: `${nameOf(kind, id)} ×`, disabled,
        onPress: () => {
          editor.sharing = {...editor.sharing, [kind]: (editor.sharing[kind] ?? []).filter((item) => item !== id)};
          changed();
        },
      }))) : [{kind: 'note' as const, text: 'None'}]),
    ];
  };
  return [
    ...items,
    {kind: 'note', text: 'Any selected user or member of a selected group may use this instance. Subgroups are included. The minimum role still applies.'},
    {kind: 'choice', id: 'share-kind', label: 'Search directory', value: editor.kind, disabled, choices: [{value: 'users', label: 'Users'}, {value: 'groups', label: 'Groups'}],
      onChange: (value) => { editor.kind = value === 'groups' ? 'groups' : 'users'; editor.first = 0; loadPrincipals(ctx, editor); }},
    {kind: 'text', id: 'share-search', label: 'User or group name', value: editor.search, maxLength: 128, disabled, onChange: (value) => { editor.search = value; }},
    {kind: 'buttons', items: [
      {id: 'share-search-run', label: 'Search', disabled, onPress: () => { editor.query = editor.search; editor.first = 0; loadPrincipals(ctx, editor); }},
      {id: 'share-previous', label: 'Previous', tone: 'ghost', disabled: disabled ?? (!editor.first ? 'This is the first page.' : editor.loading ? 'Loading directory…' : undefined),
        onPress: () => { editor.first = Math.max(0, editor.first - 50); loadPrincipals(ctx, editor); }},
      {id: 'share-next', label: 'Next', tone: 'ghost', disabled: disabled ?? (editor.results?.next == null ? 'There are no further entries.' : editor.loading ? 'Loading directory…' : undefined),
        onPress: () => { editor.first = editor.results?.next ?? editor.first; loadPrincipals(ctx, editor); }},
    ]},
    ...(editor.error ? [{kind: 'note' as const, text: editor.error, tone: 'bad' as const}] : []),
    ...(editor.loading ? [{kind: 'note' as const, text: 'Loading directory…'}] : []),
    ...buttonRows((editor.results?.items ?? []).map((entry) => ({
      id: `share-add:${editor.kind}:${entry.id}`,
      label: `${selected.includes(entry.id) ? '✓ ' : '+ '}${entry.name}`,
      disabled: disabled ?? (selected.includes(entry.id) ? 'Already selected.' : selected.length >= 100 ? 'At most 100 entries can be selected.' : undefined),
      onPress: () => {
        editor.names.set(`${editor.kind}:${entry.id}`, entry.name);
        editor.sharing = {...editor.sharing, [editor.kind]: [...(editor.sharing[editor.kind] ?? []), entry.id]};
        changed();
      },
    }))),
    ...(editor.results && !editor.results.items.length ? [{kind: 'note' as const, text: 'No matching entries. Groups are managed in Keycloak.'}] : []),
    ...listed('users'),
    ...listed('groups'),
    ...(!total ? [{kind: 'note' as const, text: 'No one can use this instance until at least one user or group is selected.', tone: 'warn' as const}] : []),
  ];
};

/** The browser's Create Instance dialog: application, its supported values, sharing, runtimes and storage. */
const openCreateInstance = (ctx: TuiContext, initialType?: string) => {
  const snapshot = ctx.snapshot();
  const models = deployedChatModels(snapshot);
  const admin = canAdminister(snapshot.session);
  const applications = applicationOptions(snapshot);
  const firstAvailable = applications.find((item) => !item.missing.length)?.id ?? '';
  const startType = initialType && applications.some((item) => item.id === initialType && !item.missing.length) ? initialType : firstAvailable;
  const draft: InstanceDraft & {maxAgents: string} = {...initialInstanceDraft(startType, models[0] ?? ''), maxAgents: '2'};
  const editor = sharingEditor({mode: 'all', users: [], groups: []});
  const state = {configure: false};
  const current = () => applicationOptions(ctx.snapshot()).find((item) => item.id === draft.type);
  const gateways = (kind: string) => flattenInstances(ctx.snapshot().instances)
    .filter((item) => item.type === kind && item.value.spec?.enabled !== false && String(item.value.status?.phase ?? '').toLowerCase() !== 'removing')
    .map((item) => item.name);
  const runtimeItems = (kind: 'openclaw' | 'hermes', label: string): DialogItem[] => {
    const available = gateways(kind);
    const enabledKey = kind === 'openclaw' ? 'openClawEnabled' : 'hermesEnabled';
    const refKey = kind === 'openclaw' ? 'openClawInstanceRef' : 'hermesInstanceRef';
    return [
      {kind: 'check', id: `runtime-${kind}`, label: `${label} Gateway`, checked: draft[enabledKey], disabled: available.length ? undefined : `No ${label} instance is available.`,
        onChange: (checked) => { draft[enabledKey] = checked; }},
      {kind: 'choice', id: `runtime-${kind}-instance`, label: `${label} Instance`, value: draft[refKey], disabled: draft[enabledKey] ? undefined : `Enable the ${label} gateway first.`,
        choices: [{value: '', label: 'Select instance', disabled: 'Select an instance.'}, ...available.map((name) => ({value: name, label: name}))],
        onChange: (value) => { draft[refKey] = value; }},
    ];
  };
  const submitBlock = () => {
    const application = current();
    if (!draft.type || !application) return 'Select an application whose required services are ready.';
    if (application.missing.length) return `Required services are not ready: ${application.missing.join(', ')}.`;
    if (instanceModelRequired(draft.type) && !deployedChatModels(ctx.snapshot()).length) return 'Add a chat model first: applications need a deployed chat model.';
    if (draft.type === 'paperclip') {
      const agents = Number(draft.maxAgents);
      if (!Number.isInteger(agents) || agents < 1 || agents > 10) return 'Parallel agents must be a whole number from 1 to 10.';
    }
    return undefined;
  };
  ctx.dialog({
    title: 'Create Instance',
    description: 'Choose an application and configure only its supported values.',
    items: () => {
      const application = current();
      const type = draft.type;
      const items: DialogItem[] = [
        {kind: 'choice', id: 'application', label: 'Application', value: type, choices: [
          {value: '', label: 'Select an available application', disabled: 'Select an application.'},
          ...applicationOptions(ctx.snapshot()).map((item) => ({value: item.id, label: `${item.label}${item.missing.length ? ' · unavailable' : ''}`,
            disabled: item.missing.length ? `Required services are not ready: ${item.missing.join(', ')}.` : undefined})),
        ], onChange: (value) => { draft.type = value; draft.storage = instanceStorageDefault(value); }},
      ];
      if (application?.missing.length) items.push({kind: 'note', text: `Required services are not ready: ${application.missing.join(', ')}.`, tone: 'warn'});
      if (!type || !application || application.missing.length) return items;
      items.push({kind: 'text', id: 'name', label: 'Name', value: draft.name, required: true, hint: 'lowercase letters, digits, hyphens', onChange: (value) => { draft.name = value; }});
      if (instanceModelRequired(type)) items.push({kind: 'choice', id: 'model', label: type === 'paperclip' ? 'Default Model' : 'Model', value: draft.model,
        choices: [{value: '', label: 'No deployed chat model selected', disabled: 'Select a deployed chat model.'}, ...deployedChatModels(ctx.snapshot()).map((model) => ({value: model, label: model}))],
        onChange: (value) => { draft.model = value; }});
      if (type === 'paperclip') items.push({kind: 'text', id: 'admin-email', label: 'Admin Email', value: draft.adminEmail, required: true, onChange: (value) => { draft.adminEmail = value; }});
      if (type === 'kubeopencode') items.push({kind: 'text', id: 'template', label: 'Template', value: draft.template, required: true, onChange: (value) => { draft.template = value; }});
      items.push(
        {kind: 'choice', id: 'authentication', label: 'Access', value: draft.authentication, choices: [{value: 'sso', label: 'SSO protected'}, {value: 'none', label: 'Public without login'}],
          onChange: (value) => {
            draft.authentication = value;
            if (value !== 'sso') editor.sharing = {mode: 'all', users: [], groups: []};
          }},
        {kind: 'choice', id: 'role', label: 'Minimum Role', value: draft.role, choices: [{value: 'user', label: 'Authenticated user'}, {value: 'viewer', label: 'Viewer'}, {value: 'operator', label: 'Operator'}, {value: 'admin', label: 'Administrator'}],
          onChange: (value) => { draft.role = value; }},
        {kind: 'choice', id: 'exposure', label: 'Exposure', value: draft.exposure, choices: [{value: 'localAndPublic', label: 'Local and public hosts'}, {value: 'local', label: 'Local host only'}],
          onChange: (value) => { draft.exposure = value; }},
      );
      if (admin && draft.authentication === 'sso') items.push(...sharingItems(ctx, editor, () => undefined));
      if (type === 'paperclip') items.push(
        {kind: 'heading', text: 'Agent runtimes'},
        {kind: 'check', id: 'runtime-opencode', label: 'OpenCode', checked: draft.openCodeEnabled, onChange: (checked) => { draft.openCodeEnabled = checked; }},
        ...runtimeItems('openclaw', 'OpenClaw'),
        ...runtimeItems('hermes', 'Hermes'),
      );
      if (type !== 'kubeopencode') {
        items.push({kind: 'toggle', id: 'configure', label: 'Configure', meta: 'Storage and runtime limits', open: state.configure, onChange: (open) => { state.configure = open; }});
        if (state.configure) {
          items.push({kind: 'text', id: 'storage', label: 'Storage', value: draft.storage, onChange: (value) => { draft.storage = value; }});
          if (type === 'paperclip') items.push(
            {kind: 'text', id: 'postgres', label: 'Postgres', value: draft.postgresStorage, onChange: (value) => { draft.postgresStorage = value; }},
            {kind: 'number', id: 'agents', label: 'Parallel Agents', value: draft.maxAgents, min: 1, max: 10, step: 1, onChange: (value) => { draft.maxAgents = value; }},
          );
          if (type === 'odysseus') items.push(
            {kind: 'text', id: 'chroma', label: 'Chroma', value: draft.chromaStorage, onChange: (value) => { draft.chromaStorage = value; }},
            {kind: 'text', id: 'searxng', label: 'SearXNG', value: draft.searxngStorage, onChange: (value) => { draft.searxngStorage = value; }},
            {kind: 'text', id: 'ntfy', label: 'ntfy', value: draft.ntfyStorage, onChange: (value) => { draft.ntfyStorage = value; }},
          );
        }
      }
      return items;
    },
    submit: {
      label: 'create',
      disabled: submitBlock,
      run: async () => {
        const label = current()?.label ?? titleFromKey(draft.type);
        const next: InstanceDraft = {...draft, sharing: editor.sharing, maxConcurrentAgents: Number(draft.maxAgents)};
        // Validates the draft before anything is sent; the hostname uses the configured domain below.
        instanceCreatePayload(next, 'example.com');
        await ctx.perform(`Create ${label} instance`, async () => {
          // The hostname follows the configured domain; only administrators have it in the snapshot.
          const domain = ctx.snapshot().settings?.publicDomain ?? (await ctx.api.settings().catch(() => undefined))?.publicDomain ?? '';
          await ctx.api.createInstance(next.type, instanceCreatePayload(next, domain));
          return {lines: [`${label} instance ${next.name} was requested. It appears under Services while the operator sets it up.`]};
        });
      },
    },
  });
};

const createInstance = (ctx: TuiContext, type?: string) => {
  const snapshot = ctx.snapshot();
  if (!deployedChatModels(snapshot).length) return ctx.message('No chat model available', 'Add a chat model first: applications need a deployed chat model.');
  if (!applicationOptions(snapshot).some((item) => !item.missing.length)) return ctx.message('No application available', 'No application has all of its required services ready.');
  openCreateInstance(ctx, type);
};

const removeInstance = (ctx: TuiContext, name: string) => ctx.confirm({
  title: 'Remove instance', description: `Remove ${name}? Its reconciled application resources will be removed by the operator.`, confirmLabel: 'remove', danger: true,
  onConfirm: () => ctx.perform(`Remove instance ${name}`, async () => {
    await ctx.api.removeInstance(name);
    return {lines: [`Removal of ${name} was requested.`]};
  }),
});

/** The browser's sharing dialog: who may see and use one instance, saved against the loaded revision. */
const sharingDialog = (ctx: TuiContext, access: InstanceAccessState) => {
  const editor = sharingEditor(access.sharing, access.principals);
  const state = {confirmed: false};
  const enabled = access.guardReady && access.authentication === 'sso';
  const blocked = !access.guardReady ? 'The operator is still preparing the access guard. Wait for the instance to become ready.'
    : access.authentication !== 'sso' ? 'Switch this instance to SSO before selecting users or groups.' : undefined;
  if (enabled && editor.sharing.mode === 'selected') loadPrincipals(ctx, editor);
  ctx.dialog({
    title: `Sharing · ${access.name}`,
    description: 'Manage access to this instance.',
    items: () => [
      {kind: 'note', text: 'Administrators retain the management view. App access and instance credentials still require an explicit grant.', tone: 'normal'},
      ...(blocked ? [{kind: 'note' as const, text: blocked, tone: 'warn' as const}] : []),
      ...sharingItems(ctx, editor, () => { state.confirmed = false; }, blocked),
      {kind: 'blank'},
      {kind: 'check', id: 'share-confirm', label: 'I confirm who will be able to see and use this instance.', checked: state.confirmed, disabled: blocked,
        onChange: (checked) => { state.confirmed = checked; }},
    ],
    submit: {
      label: 'save sharing',
      disabled: () => blocked ?? (!state.confirmed ? 'Confirm who will be able to see and use this instance first.' : undefined),
      run: () => ctx.perform(`Save sharing for ${access.name}`, async () => {
        await ctx.api.updateInstanceAccess(access.name, editor.sharing, access.revision);
        return {lines: [`Sharing for ${access.name} was saved.`]};
      }),
    },
  });
};

const editSharing = (ctx: TuiContext, name: string) => ctx.load(`Sharing · ${name}`, () => ctx.api.instanceAccess(name), (access) => sharingDialog(ctx, access));

export const servicesModule: AreaModule = {
  scopes: {service: 'runtime', instance: 'runtime'},
  handle: (ctx, {scope, verb, target}) => {
    const snapshot = ctx.snapshot();
    if (scope === 'service') {
      const state = snapshot.modules.modules?.[target];
      if (!state) return ctx.missing();
      const entity = {id: target, state, catalog: snapshot.modules.catalogJson?.modules?.[target]};
      if (verb === 'credentials') return void showCredentials(ctx, entity.catalog?.displayName ?? titleFromKey(target), () => ctx.api.moduleCredentials(target));
      if (verb === 'enable') return enableService(ctx, entity);
      if (verb === 'disable') return disableService(ctx, entity);
      return;
    }
    if (verb === 'create') return createInstance(ctx, target || undefined);
    const instance = flattenInstances(snapshot.instances).find((item) => item.name === target);
    if (!instance) return ctx.missing();
    if (String(instance.value.status?.phase ?? '').toLowerCase() === 'removing') return ctx.message('Instance is being removed', `${target} is being removed.`);
    if (verb === 'credentials') return void showCredentials(ctx, target, () => ctx.api.instanceCredentials(target));
    if (verb === 'sharing') return canAdminister(snapshot.session) ? void editSharing(ctx, target) : ctx.message('Administrator access required', 'This action is restricted to Magic Stick administrators.', 'error');
    if (verb === 'remove') {
      if (instance.value.spec?.access?.sharing?.mode === 'selected' && !canAdminister(snapshot.session)) return ctx.message('Administrator access required', 'Only administrators can remove an instance shared with selected users and groups.', 'error');
      return removeInstance(ctx, target);
    }
  },
};
