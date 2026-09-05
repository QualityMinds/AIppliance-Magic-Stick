import {
  canAdminister,
  canMutateRuntime,
  dashboardRole,
  flattenInstances,
  formatMi,
  phaseNeedsAttention,
  titleFromKey,
} from '@magicstick/dashboard-core';
import type {
  ApiKeyItem,
  ComputeTarget,
  KubernetesAccessUser,
  ModelActivation,
  ModuleCatalogEntry,
  ModuleState,
  User,
} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import {loadSnapshot} from './snapshot';
import type {Runtime} from './runtime';
import {clipTerminalLine, truncate} from './output';
import {bannerFits, createBannerAnimation, renderBanner, type BannerFrame} from './banner';

export type TuiTab = 'Overview' | 'Services' | 'Models' | 'Settings' | 'Users' | 'API Access' | 'Kubernetes' | 'System';

type TuiEntity =
  | {kind: 'service'; id: string; state: ModuleState; catalog?: ModuleCatalogEntry}
  | {kind: 'model'; id: string; activation: ModelActivation}
  | {kind: 'user'; id: string; user: User}
  | {kind: 'api-key'; id: string; item: ApiKeyItem}
  | {kind: 'kubernetes'; id: string; user: KubernetesAccessUser};

interface Choice {
  value: string;
  label: string;
}

interface FormField {
  id: string;
  label: string;
  value: string;
  kind?: 'text' | 'secret' | 'choice';
  choices?: Choice[];
  required?: boolean;
  hint?: string;
}

interface MenuOption {
  label: string;
  disabled?: boolean;
  hint?: string;
  action: () => void;
}

type TuiOverlay =
  | {kind: 'menu'; title: string; description?: string; options: MenuOption[]; active: number}
  | {kind: 'form'; title: string; description?: string; fields: FormField[]; active: number; submitLabel: string; error?: string; onSubmit: (values: Record<string, string>) => Promise<void>}
  | {kind: 'confirm'; title: string; description: string; confirmLabel: string; onConfirm: () => Promise<void>}
  | {kind: 'message'; title: string; lines: string[]; tone?: 'normal' | 'error'; copyValue?: string}
  | {kind: 'busy'; title: string; description?: string};

interface TuiRenderState {
  demo?: boolean;
  banner?: BannerFrame;
  selectionIndex?: number;
  overlay?: TuiOverlay;
  notice?: string;
}

export interface LocalModelInput {
  name: string;
  modelType: string;
  engine: string;
  computeTarget: string;
  reference: string;
  contextWindow: number;
  maxNumSeqs: number;
  reservationMi: number;
}

const CLEAR = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ALT_SCREEN = '\x1b[?1049h';
const NORMAL_SCREEN = '\x1b[?1049l';
const cyan = (value: string, color: boolean) => color ? `\x1b[36m${value}\x1b[0m` : value;
const dim = (value: string, color: boolean) => color ? `\x1b[2m${value}\x1b[0m` : value;
const good = (value: string, color: boolean) => color ? `\x1b[32m${value}\x1b[0m` : value;
const bad = (value: string, color: boolean) => color ? `\x1b[31m${value}\x1b[0m` : value;
const warn = (value: string, color: boolean) => color ? `\x1b[33m${value}\x1b[0m` : value;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusLabel = (value?: string) => value || 'Unknown';
const selectedPrefix = (index: number, selectedIndex = -1) => index === selectedIndex ? '›' : ' ';
const currentChoice = (field: FormField) => field.choices?.find((item) => item.value === field.value)?.label ?? field.value;
const displayFieldValue = (field: FormField) => field.kind === 'secret' ? '•'.repeat(Array.from(field.value).length) : currentChoice(field);
const formValues = (fields: FormField[]) => Object.fromEntries(fields.map((field) => [field.id, field.value]));
const positiveInteger = (value: string, label: string) => {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer.`);
  return result;
};
const roundMemory = (value: number) => Math.max(100, Math.ceil(value / 100) * 100);

export const buildLocalModelPayload = (input: LocalModelInput, target: ComputeTarget) => {
  const local: Record<string, unknown> = {
    modelType: input.modelType,
    computeTarget: input.computeTarget,
    engine: input.engine,
    contextWindow: input.contextWindow,
    maxNumSeqs: input.maxNumSeqs,
    url: input.reference,
  };
  if (target.kind === 'cpu' || input.computeTarget === 'cpu') local.memoryRequiredMi = input.reservationMi;
  else local.vram = `${input.reservationMi}Mi`;
  return {name: input.name, enabled: true, targetNamespace: 'ai', local};
};

export const osc52ClipboardSequence = (value: string) => `\x1b]52;c;${Buffer.from(value).toString('base64')}\x07`;

export const splitTerminalInput = (value: string) => {
  const keys: string[] = [];
  for (let index = 0; index < value.length;) {
    if (value[index] === '\u001b' && value[index + 1] === '[' && value[index + 2]) {
      keys.push(value.slice(index, index + 3));
      index += 3;
    } else {
      const [key = ''] = Array.from(value.slice(index));
      keys.push(key);
      index += key.length;
    }
  }
  return keys;
};

export const availableTabs = (snapshot: DashboardSnapshot): TuiTab[] => {
  const tabs: TuiTab[] = ['Overview', 'Services', 'Models'];
  if (dashboardRole(snapshot.session) === 'admin') tabs.push('Settings');
  if (dashboardRole(snapshot.session) === 'admin' && snapshot.session.identityManagementAvailable !== false) tabs.push('Users');
  if (dashboardRole(snapshot.session) === 'admin') tabs.push('API Access');
  if (dashboardRole(snapshot.session) === 'admin' && snapshot.session.identityManagementAvailable !== false) tabs.push('Kubernetes');
  tabs.push('System');
  return tabs;
};

export const moveTab = (index: number, direction: number, count: number) => count
  ? (index + direction + count) % count
  : 0;

export const moveSelection = (index: number, direction: number, count: number) => count
  ? Math.min(Math.max(0, index + direction), count - 1)
  : 0;

const serviceEntries = (snapshot: DashboardSnapshot) => {
  const catalog = snapshot.modules.catalogJson?.modules ?? {};
  return Object.entries(snapshot.modules.modules ?? {}).sort(([left], [right]) => {
    const order = (catalog[left]?.order ?? 9999) - (catalog[right]?.order ?? 9999);
    return order || left.localeCompare(right);
  });
};

const modelEntries = (snapshot: DashboardSnapshot) => (snapshot.models.activations ?? [])
  .filter((activation) => Boolean(activation.metadata?.name));

const selectableEntities = (tab: TuiTab, snapshot: DashboardSnapshot): TuiEntity[] => {
  if (tab === 'Services') return serviceEntries(snapshot).map(([id, state]) => ({
    kind: 'service', id, state, catalog: snapshot.modules.catalogJson?.modules?.[id],
  }));
  if (tab === 'Models') return modelEntries(snapshot).map((activation) => ({
    kind: 'model', id: activation.metadata?.name ?? '', activation,
  }));
  if (tab === 'Users') return (snapshot.users?.users ?? []).map((user) => ({kind: 'user', id: user.id, user}));
  if (tab === 'API Access') return (snapshot.apiAccess?.items ?? []).map((item) => ({kind: 'api-key', id: item.id, item}));
  if (tab === 'Kubernetes') return (snapshot.kubernetesAccess?.users ?? []).map((user) => ({kind: 'kubernetes', id: user.id, user}));
  return [];
};

export const selectableCount = (tab: TuiTab, snapshot: DashboardSnapshot) => selectableEntities(tab, snapshot).length;

const overviewLines = (snapshot: DashboardSnapshot) => {
  const modules = Object.entries(snapshot.modules.modules ?? {});
  const instances = flattenInstances(snapshot.instances);
  const activations = snapshot.models.activations ?? [];
  const attention = [
    ...modules.filter(([, item]) => item.enabled && phaseNeedsAttention(item.status?.phase)).map(([id, item]) => `Module ${item.displayName ?? titleFromKey(id)}: ${item.status?.message ?? item.status?.phase}`),
    ...instances.filter((item) => phaseNeedsAttention(item.value.status?.phase)).map((item) => `Instance ${item.name}: ${item.value.status?.message ?? item.value.status?.phase}`),
    ...activations.filter((item) => phaseNeedsAttention(item.status?.phase)).map((item) => `Model ${item.metadata?.name ?? 'unnamed'}: ${item.status?.message ?? item.status?.phase}`),
  ];
  return [
    `Appliance  ${snapshot.appliance.metadata?.name ?? 'local'}  ${statusLabel(snapshot.appliance.status?.phase)}`,
    `Modules    ${modules.filter(([, item]) => item.enabled).length} enabled / ${modules.length} catalogued`,
    `Instances  ${instances.length}`,
    `Models     ${activations.length} activation(s), ${(snapshot.models.models ?? []).length} registered`,
    '',
    attention.length ? 'Attention' : 'Attention  No issues detected.',
    ...attention.slice(0, 12).map((item) => `  ! ${truncate(item, 100)}`),
  ];
};

const serviceLines = (snapshot: DashboardSnapshot, selectedIndex = -1) => {
  const modules = serviceEntries(snapshot);
  const instances = flattenInstances(snapshot.instances);
  return [
    'Modules',
    ...modules.map(([id, item], index) => `${selectedPrefix(index, selectedIndex)} ${item.enabled ? '●' : '○'} ${(item.displayName ?? titleFromKey(id)).padEnd(25)} ${statusLabel(item.status?.phase)}`),
    '', 'Instances (managed in the browser or with `magicstick instance`)',
    ...instances.map((item) => `  ● ${item.type.padEnd(15)} ${item.name.padEnd(24)} ${statusLabel(item.value.status?.phase)}`),
  ];
};

const modelLines = (snapshot: DashboardSnapshot, selectedIndex = -1) => {
  const devices = snapshot.models.computeMemory?.devices ?? [];
  const models = modelEntries(snapshot);
  return [
    'Compute memory',
    ...devices.map((device) => `  ${device.name ?? device.id}: ${formatMi(device.freeMi)} free / ${formatMi(device.unreservedMi)} unreserved / ${formatMi(device.totalMi)} total`),
    '', 'Models',
    ...models.map((item, index) => {
      const local = item.spec?.local ?? {};
      const detail = item.spec?.type === 'external'
        ? String((item.spec?.external as Record<string, unknown> | undefined)?.model ?? 'external')
        : `${String(local.engine ?? '')} ${String(local.computeTarget ?? '')}`.trim();
      return `${selectedPrefix(index, selectedIndex)} ${item.metadata?.name ?? 'unnamed'}  ${statusLabel(item.status?.phase)}  ${detail}`.trimEnd();
    }),
  ];
};

const settingsLines = (snapshot: DashboardSnapshot) => [
  `Public domain  ${snapshot.settings?.publicDomain ?? 'unavailable'}`,
  `Dashboard host ${snapshot.settings?.dashboardHost ?? 'unavailable'}`,
  `mDNS domain    ${snapshot.settings?.mdnsDomain ?? 'unavailable'}`,
];

const userLines = (snapshot: DashboardSnapshot, selectedIndex = -1) => [
  `${snapshot.users?.total ?? 0} user(s)`,
  ...(snapshot.users?.users ?? []).map((user, index) => `${selectedPrefix(index, selectedIndex)} ${user.enabled ? '●' : '○'} ${user.username.padEnd(22)} ${(user.effectiveAccessLevel ?? user.accessLevel ?? 'user').padEnd(10)} ${user.provider ?? user.source ?? 'local'}`),
];

const apiAccessLines = (snapshot: DashboardSnapshot, selectedIndex = -1) => [
  `${snapshot.apiAccess?.total ?? 0} named API key(s)`,
  ...(snapshot.apiAccess?.apiBases ?? []).map((item) => `  ${item.scope ?? 'api'}  ${item.url}`),
  '',
  ...(snapshot.apiAccess?.items ?? []).map((item, index) => `${selectedPrefix(index, selectedIndex)} ${item.name.padEnd(24)} ${item.keyHint ?? ''} ${item.status ?? 'active'}`),
];

const kubernetesLines = (snapshot: DashboardSnapshot, selectedIndex = -1) => {
  const configured = Boolean(snapshot.kubernetesAccess?.configuration?.configured);
  return [
    `OIDC configuration  ${configured ? 'Ready' : 'Not confirmed'}`,
    `${snapshot.kubernetesAccess?.total ?? 0} identity/identities`,
    ...(snapshot.kubernetesAccess?.users ?? []).map((user, index) => `${selectedPrefix(index, selectedIndex)} ${user.enabled ? '●' : '○'} ${user.username.padEnd(22)} ${(user.accessLevel ?? 'none').padEnd(10)} ${user.provider ?? user.source ?? 'local'}`),
  ];
};

const systemLines = (snapshot: DashboardSnapshot) => [
  'Hardware operators',
  ...Object.entries(snapshot.status.hardwareOperators ?? {}).map(([id, item]) => `  ${item.operatorActive ? '●' : '○'} ${(item.displayName ?? titleFromKey(id)).padEnd(28)} ${statusLabel(item.phase)}  ${truncate(item.message, 60)}`),
  '',
  `Flux             ${snapshot.status.fluxKustomizations?.length ?? 0}`,
  `Pods             ${snapshot.status.pods?.length ?? 0}`,
  `Services         ${snapshot.status.services?.length ?? 0}`,
  `Ingresses        ${snapshot.status.ingresses?.length ?? 0}`,
  `HTTP routes      ${snapshot.status.httpRoutes?.length ?? 0}`,
];

export const tabLines = (tab: TuiTab, snapshot: DashboardSnapshot, selectedIndex = -1) => {
  switch (tab) {
    case 'Services': return serviceLines(snapshot, selectedIndex);
    case 'Models': return modelLines(snapshot, selectedIndex);
    case 'Settings': return settingsLines(snapshot);
    case 'Users': return userLines(snapshot, selectedIndex);
    case 'API Access': return apiAccessLines(snapshot, selectedIndex);
    case 'Kubernetes': return kubernetesLines(snapshot, selectedIndex);
    case 'System': return systemLines(snapshot);
    default: return overviewLines(snapshot);
  }
};

const overlayLines = (overlay: TuiOverlay) => {
  if (overlay.kind === 'busy') return [overlay.title, overlay.description ?? 'Applying change and refreshing state…'];
  if (overlay.kind === 'message') return [overlay.title, '', ...overlay.lines, '', overlay.copyValue ? 'c: copy to clipboard · Enter/Esc: close' : 'Enter/Esc: close'];
  if (overlay.kind === 'confirm') return [overlay.title, '', overlay.description, '', `Enter/y: ${overlay.confirmLabel} · Esc/n: cancel`];
  if (overlay.kind === 'menu') return [
    overlay.title,
    ...(overlay.description ? ['', overlay.description] : []),
    '',
    ...overlay.options.map((item, index) => `${selectedPrefix(index, overlay.active)} ${item.disabled ? '×' : '●'} ${item.label}${item.hint ? ` — ${item.hint}` : ''}`),
    '', '↑/↓: select · Enter: choose · Esc: cancel',
  ];
  return [
    overlay.title,
    ...(overlay.description ? ['', overlay.description] : []),
    '',
    ...overlay.fields.map((field, index) => {
      const value = displayFieldValue(field) || field.hint || '';
      const required = field.required ? ' *' : '';
      const choices = field.kind === 'choice' ? '  ←/→' : '';
      return `${selectedPrefix(index, overlay.active)} ${field.label}${required}: ${value}${choices}`;
    }),
    ...(overlay.error ? ['', `! ${overlay.error}`] : []),
    '', `Enter/Tab: next${overlay.active === overlay.fields.length - 1 ? ` and ${overlay.submitLabel}` : ''} · Ctrl+S: ${overlay.submitLabel} · Ctrl+U: clear · Esc: cancel`,
  ];
};

const browseHelp = (tab: TuiTab, snapshot: DashboardSnapshot) => {
  const base = 'x: sign out';
  if (tab === 'Services' && canMutateRuntime(snapshot.session)) return `${base} · a: enable · d: disable`;
  if (tab === 'Models' && canMutateRuntime(snapshot.session)) return `${base} · a: add · d: remove`;
  if (tab === 'Users' && canAdminister(snapshot.session)) return `${base} · a: add · e/Enter: edit · d: delete`;
  if (tab === 'API Access' && canAdminister(snapshot.session)) return `${base} · a: create · d: revoke`;
  if (tab === 'Kubernetes' && canAdminister(snapshot.session)) return `${base} · e/Enter: access · d: revoke · c: copy kubeconfig`;
  return base;
};

export const renderTui = (
  snapshot: DashboardSnapshot,
  tabIndex: number,
  width = 100,
  height = 30,
  color = true,
  state: TuiRenderState = {},
) => {
  // Leave the final terminal column unused to avoid automatic line wrapping.
  const columns = Math.max(1, width - 1);
  const banner = bannerFits(height) ? renderBanner(columns, state.banner?.elapsedMs, color, state.banner?.seed) : [];
  const tabs = availableTabs(snapshot);
  const safeIndex = Math.min(Math.max(0, tabIndex), tabs.length - 1);
  const active = tabs[safeIndex] ?? 'Overview';
  const identity = state.demo ? 'OFFLINE DEMO · read-only · sample data' : `signed in: ${snapshot.session.username} · ${dashboardRole(snapshot.session)}`;
  const header = dim(identity, color);
  const tabLabels = tabs.map((tab, index) => index === safeIndex ? `[ ${tab} ]` : tab);
  let firstTab = 0;
  while (firstTab < safeIndex && tabLabels.slice(firstTab, safeIndex + 1).join('  ').length + 2 > columns) firstTab += 1;
  const navigation = `${firstTab ? '< ' : ''}${tabLabels.slice(firstTab).map((label, index) => index + firstTab === safeIndex ? cyan(label, color) : label).join('  ')}`;
  const rawBody = state.overlay ? overlayLines(state.overlay) : tabLines(active, snapshot, state.selectionIndex);
  const controls = columns < 72 ? 'h/l:tabs j/k:rows r:refresh q:quit'
    : '←/→ h/l: tabs · ↑/↓ k/j: rows · r: refresh · q: quit';
  // Keep form/confirmation instructions on-screen even when the body scrolls.
  const help = state.overlay
    ? state.overlay.kind === 'busy' ? [] : [rawBody.pop() ?? '']
    : state.demo ? [controls] : [controls, browseHelp(active, snapshot)];
  const maximumBody = Math.max(0, height - banner.length - 5 - help.length - (state.notice ? 1 : 0));
  const focus = rawBody.findIndex((line) => line.startsWith('›'));
  const bodyStart = focus >= maximumBody ? Math.max(0, focus - maximumBody + 1) : 0;
  const body = rawBody.slice(bodyStart, bodyStart + maximumBody).map((line) => {
    const clipped = clipTerminalLine(line, columns);
    if (!line.startsWith('›')) return clipped;
    return cyan(clipped, color);
  });
  const health = phaseNeedsAttention(snapshot.appliance.status?.phase) ? bad(statusLabel(snapshot.appliance.status?.phase), color) : good(statusLabel(snapshot.appliance.status?.phase), color);
  const context = state.overlay
    ? state.overlay.kind === 'message' && state.overlay.tone === 'error' ? bad('Action failed', color) : cyan('Action', color)
    : dim(`Appliance ${health}`, color);
  const notice = state.notice ? [warn(state.notice, color)] : [];
  return [...banner, header, navigation, '─'.repeat(Math.min(columns, 120)), `${active}  ${context}`, '', ...body, ...notice, ...help.map((line) => dim(line, color))]
    .slice(0, height).map((line) => clipTerminalLine(line, columns)).join('\n');
};

const userSource = (user: User) => {
  if (typeof user.source === 'object' && user.source) {
    const source = user.source as Record<string, unknown>;
    return String(source.provider ?? source.alias ?? source.type ?? source.displayName ?? 'external');
  }
  return String(user.provider ?? user.source ?? 'local');
};
const isLocalUser = (user: User) => user.local ?? ['local', 'keycloak', 'internal'].includes(userSource(user).toLowerCase());

export const runTui = async (runtime: Runtime, options: {color?: boolean; refreshSeconds?: number; demo?: boolean} = {}) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI needs an interactive terminal. Use CLI commands or --json for non-interactive use.');
  let snapshot = await loadSnapshot(runtime.api);
  let tabIndex = 0;
  let loading = false;
  let refreshError = '';
  let overlay: TuiOverlay | undefined;
  let finished = false;
  const selection: Partial<Record<TuiTab, number>> = {};
  const color = options.color !== false;
  const animation = createBannerAnimation((frame) => {
    const rows = renderBanner(Math.max(1, (process.stdout.columns ?? 100) - 1), frame.elapsedMs, color, frame.seed);
    // Only repaint the banner, not forms or the entire dashboard, on a tick.
    process.stdout.write(`\x1b[H${rows.map((row) => `${row}\x1b[K`).join('\n')}`);
  }, () => !finished && bannerFits(process.stdout.rows ?? 30));

  const activeTab = () => availableTabs(snapshot)[tabIndex] ?? 'Overview';
  const activeSelection = () => selection[activeTab()] ?? 0;
  const selectedEntity = () => selectableEntities(activeTab(), snapshot)[activeSelection()];
  const clampSelection = () => {
    for (const tab of availableTabs(snapshot)) selection[tab] = moveSelection(selection[tab] ?? 0, 0, selectableCount(tab, snapshot));
  };
  const draw = () => {
    if (finished) return;
    const rendered = renderTui(snapshot, tabIndex, process.stdout.columns ?? 100, process.stdout.rows ?? 30, color, {
      demo: options.demo,
      banner: animation.frame,
      selectionIndex: activeSelection(), overlay,
      notice: refreshError ? `Refresh failed: ${refreshError}` : '',
    });
    process.stdout.write(`\x1b[H${rendered.split('\n').map((row) => `${row}\x1b[K`).join('\n')}\x1b[J`);
  };
  const refresh = async () => {
    if (loading || overlay) return;
    loading = true;
    try {
      snapshot = await loadSnapshot(runtime.api);
      clampSelection();
      refreshError = '';
    } catch (error) {
      refreshError = truncate(errorText(error), 100);
    } finally {
      loading = false;
      draw();
    }
  };
  const message = (title: string, lines: string | string[], tone: 'normal' | 'error' = 'normal', copyValue?: string) => {
    overlay = {kind: 'message', title, lines: Array.isArray(lines) ? lines : [lines], tone, copyValue};
    draw();
  };
  const perform = async (title: string, operation: () => Promise<{lines?: string[]; copyValue?: string} | void>) => {
    if (loading) return;
    const origin = overlay;
    loading = true;
    overlay = {kind: 'busy', title};
    draw();
    try {
      const result = await operation();
      const lines = result?.lines ?? [title];
      try {
        snapshot = await loadSnapshot(runtime.api);
        clampSelection();
        refreshError = '';
      } catch (error) {
        refreshError = truncate(errorText(error), 100);
        lines.push(`The change succeeded, but refreshing the status failed: ${refreshError}`);
      }
      overlay = {kind: 'message', title: 'Completed', lines, ...(result?.copyValue ? {copyValue: result.copyValue} : {})};
    } catch (error) {
      if (origin?.kind === 'form') {
        origin.error = errorText(error);
        overlay = origin;
      } else {
        overlay = {kind: 'message', title: 'Could not apply change', lines: [errorText(error)], tone: 'error'};
      }
    } finally {
      loading = false;
      draw();
    }
  };
  const openConfirm = (title: string, description: string, confirmLabel: string, onConfirm: () => Promise<void>) => {
    overlay = {kind: 'confirm', title, description, confirmLabel, onConfirm};
    draw();
  };
  const openForm = (title: string, description: string, fields: FormField[], submitLabel: string, onSubmit: (values: Record<string, string>) => Promise<void>) => {
    overlay = {kind: 'form', title, description, fields, active: 0, submitLabel, onSubmit};
    draw();
  };
  const submitForm = async (form: Extract<TuiOverlay, {kind: 'form'}>) => {
    const missing = form.fields.find((field) => field.required && !field.value.trim());
    if (missing) {
      form.error = `${missing.label} is required.`;
      form.active = form.fields.indexOf(missing);
      draw();
      return;
    }
    try {
      form.error = undefined;
      await form.onSubmit(formValues(form.fields));
    } catch (error) {
      form.error = errorText(error);
      draw();
    }
  };

  const enableService = (entity: Extract<TuiEntity, {kind: 'service'}>) => {
    if (entity.state.enabled) return message('Service already enabled', `${entity.catalog?.displayName ?? titleFromKey(entity.id)} is already enabled.`);
    if ((entity.state.activationMode ?? entity.catalog?.activationMode) !== 'moduleactivation') return message('Service is static', 'This platform service is managed by the installation and cannot be enabled from the TUI.');
    const saved = (entity.state.parameters ?? {}) as Record<string, unknown>;
    const fields = (entity.catalog?.parameters ?? []).map((parameter): FormField => ({
      id: parameter.name,
      label: parameter.label ?? titleFromKey(parameter.name),
      value: String(saved[parameter.name] ?? ''),
      kind: parameter.type === 'password' ? 'secret' : 'text',
      hint: parameter.placeholder,
    }));
    const apply = async (values: Record<string, string>) => perform(`Enable ${entity.catalog?.displayName ?? entity.id}`, async () => {
      const parameters = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
      await runtime.api.enableModule(entity.id, parameters);
      return {lines: [`${entity.catalog?.displayName ?? titleFromKey(entity.id)} was enabled.`]};
    });
    if (fields.length) openForm(`Enable ${entity.catalog?.displayName ?? titleFromKey(entity.id)}`, 'Optional service parameters. Leave a field empty to use its configured default.', fields, 'enable', apply);
    else openConfirm(`Enable ${entity.catalog?.displayName ?? titleFromKey(entity.id)}`, 'The service and its declared dependencies will be reconciled.', 'enable', async () => apply({}));
  };
  const disableService = (entity: Extract<TuiEntity, {kind: 'service'}>) => {
    if (!entity.state.enabled) return message('Service already disabled', `${entity.catalog?.displayName ?? titleFromKey(entity.id)} is already disabled.`);
    if ((entity.state.activationMode ?? entity.catalog?.activationMode) !== 'moduleactivation') return message('Service is static', 'This platform service is managed by the installation and cannot be disabled from the TUI.');
    openConfirm(`Disable ${entity.catalog?.displayName ?? titleFromKey(entity.id)}`, 'Dependent workloads may become unavailable. Persistent-data handling follows the module uninstall policy.', 'disable', async () => {
      await perform(`Disable ${entity.catalog?.displayName ?? entity.id}`, async () => {
        await runtime.api.disableModule(entity.id);
        return {lines: [`${entity.catalog?.displayName ?? titleFromKey(entity.id)} was disabled.`]};
      });
    });
  };

  const runtimeChoices = () => snapshot.models.computeTargets.targets
    .filter((target) => target.available)
    .flatMap((target) => (target.engines ?? []).map((engine) => ({
      value: `${engine}\u001f${target.id}`,
      label: `${engine} / ${target.displayName ?? target.id}`,
    })));
  const addLocalModel = () => {
    const choices = runtimeChoices();
    if (!choices.length) return message('No local runtime available', 'No inference-engine and compute-target combination is currently available.', 'error');
    openForm('Add local model', 'Enter a direct Hugging Face or Ollama model reference. Leave the reservation empty to use the calculated recommendation.', [
      {id: 'name', label: 'Name', value: '', required: true},
      {id: 'runtime', label: 'Runtime / hardware', value: choices[0]?.value ?? '', kind: 'choice', choices, required: true},
      {id: 'modelType', label: 'Type', value: 'chat', kind: 'choice', choices: [{value: 'chat', label: 'Chat'}, {value: 'embedding', label: 'Embedding'}]},
      {id: 'reference', label: 'Model reference', value: '', required: true, hint: 'hf://publisher/model or ollama://model:tag'},
      {id: 'contextWindow', label: 'Context size', value: '4096', required: true},
      {id: 'maxNumSeqs', label: 'Max sequences', value: '1', required: true},
      {id: 'reservationMi', label: 'RAM/VRAM reservation MiB', value: '', hint: 'automatic recommendation'},
    ], 'create model', async (values) => {
      const [engine = '', computeTarget = ''] = values.runtime?.split('\u001f') ?? [];
      const target = snapshot.models.computeTargets.targets.find((item) => item.id === computeTarget && item.available && item.engines?.includes(engine));
      if (!target) throw new Error('The selected runtime and hardware combination is no longer available.');
      const contextWindow = positiveInteger(values.contextWindow ?? '', 'Context size');
      const maxNumSeqs = positiveInteger(values.maxNumSeqs ?? '', 'Max sequences');
      await perform(`Create model ${values.name}`, async () => {
        const estimate = await runtime.api.estimateMemory({engine, computeTarget, url: values.reference, contextWindow, maxNumSeqs, modelType: values.modelType});
        const reservationMi = values.reservationMi?.trim()
          ? positiveInteger(values.reservationMi, 'RAM/VRAM reservation')
          : roundMemory(estimate.recommendedMi);
        const input: LocalModelInput = {
          name: values.name ?? '', modelType: values.modelType ?? 'chat', engine, computeTarget,
          reference: values.reference ?? '', contextWindow, maxNumSeqs, reservationMi,
        };
        await runtime.api.createLocalModel(buildLocalModelPayload(input, target));
        return {lines: [
          `${input.name} was requested on ${target.displayName ?? target.id} with ${engine}.`,
          `Reservation: ${formatMi(reservationMi)}; estimate: ${formatMi(estimate.minimumMi)} minimum / ${formatMi(estimate.recommendedMi)} recommended.`,
        ]};
      });
    });
  };
  const addExternalModel = () => openForm('Add external model', 'Register an OpenAI-compatible provider endpoint.', [
    {id: 'name', label: 'Name', value: '', required: true},
    {id: 'model', label: 'Provider model', value: '', required: true, hint: 'openai/gpt-4o-mini'},
    {id: 'apiBase', label: 'API base', value: '', required: true, hint: 'https://provider.example/v1'},
    {id: 'modelType', label: 'Type', value: 'chat', kind: 'choice', choices: [{value: 'chat', label: 'Chat'}, {value: 'embedding', label: 'Embedding'}]},
    {id: 'contextWindow', label: 'Context size', value: '128000', required: true},
    {id: 'apiKey', label: 'API key', value: '', kind: 'secret', hint: 'optional when supplied elsewhere'},
  ], 'create model', async (values) => {
    const contextWindow = positiveInteger(values.contextWindow ?? '', 'Context size');
    await perform(`Create model ${values.name}`, async () => {
      await runtime.api.createExternalModel({
        name: values.name, enabled: true, targetNamespace: 'ai',
        external: {model: values.model, apiBase: values.apiBase, modelType: values.modelType, contextWindow},
        ...(values.apiKey ? {apiKey: values.apiKey} : {}),
      });
      return {lines: [`${values.name} was registered as an external model.`]};
    });
  });
  const addModel = () => {
    overlay = {kind: 'menu', title: 'Add model', description: 'Choose where inference runs.', active: 0, options: [
      {label: 'Local model', hint: 'vLLM or Ollama on available CPU/GPU hardware', action: addLocalModel},
      {label: 'External model', hint: 'OpenAI-compatible remote provider', action: addExternalModel},
    ]};
    draw();
  };
  const removeModel = (entity: Extract<TuiEntity, {kind: 'model'}>) => openConfirm(`Remove ${entity.id}`, 'The ModelActivation is deleted and its local runtime workload is cleaned up.', 'remove', async () => {
    await perform(`Remove model ${entity.id}`, async () => {
      await runtime.api.removeModel(entity.id);
      return {lines: [`${entity.id} was removed.`]};
    });
  });

  const createUser = () => openForm('Create user', 'Create a locally managed Keycloak identity. Password input is masked.', [
    {id: 'username', label: 'Username', value: '', required: true},
    {id: 'firstName', label: 'First name', value: ''},
    {id: 'lastName', label: 'Last name', value: ''},
    {id: 'email', label: 'Email', value: '', required: true},
    {id: 'accessLevel', label: 'Dashboard access', value: 'user', kind: 'choice', choices: ['user', 'viewer', 'operator', 'admin'].map((value) => ({value, label: titleFromKey(value)}))},
    {id: 'password', label: 'Temporary password', value: '', kind: 'secret', required: true},
    {id: 'confirmation', label: 'Confirm password', value: '', kind: 'secret', required: true},
    {id: 'enabled', label: 'Account status', value: 'true', kind: 'choice', choices: [{value: 'true', label: 'Enabled'}, {value: 'false', label: 'Disabled'}]},
  ], 'create user', async (values) => {
    if ((values.password ?? '').length < 12) throw new Error('The temporary password must contain at least 12 characters.');
    if (values.password !== values.confirmation) throw new Error('The password confirmation does not match.');
    await perform(`Create user ${values.username}`, async () => {
      await runtime.api.createUser({
        username: values.username, firstName: values.firstName, lastName: values.lastName,
        email: values.email, password: values.password, enabled: values.enabled === 'true', accessLevel: values.accessLevel,
      });
      return {lines: [`${values.username} was created with ${titleFromKey(values.accessLevel ?? 'user')} access.`]};
    });
  });
  const editUserProfile = (user: User) => {
    if (user.capabilities?.canEditProfile === false || !isLocalUser(user)) return message('Profile is read-only', 'This identity is protected or managed by an external identity provider.');
    openForm(`Edit ${user.username}`, 'Update the locally managed profile.', [
      {id: 'firstName', label: 'First name', value: user.firstName ?? ''},
      {id: 'lastName', label: 'Last name', value: user.lastName ?? ''},
      {id: 'email', label: 'Email', value: user.email ?? '', required: true},
    ], 'save profile', async (values) => {
      await perform(`Update ${user.username}`, async () => {
        await runtime.api.updateUser(user.id, {firstName: values.firstName, lastName: values.lastName, email: values.email});
        return {lines: [`${user.username} was updated.`]};
      });
    });
  };
  const editUserRole = (user: User) => {
    if (user.capabilities?.canManageRoles === false) return message('Access is protected', 'The access level for this identity cannot be changed.');
    openForm(`Dashboard access for ${user.username}`, 'Only direct Magic Stick roles are replaced.', [
      {id: 'accessLevel', label: 'Access level', value: user.accessLevel ?? 'user', kind: 'choice', choices: ['user', 'viewer', 'operator', 'admin'].map((value) => ({value, label: titleFromKey(value)}))},
    ], 'save access', async (values) => {
      await perform(`Change access for ${user.username}`, async () => {
        await runtime.api.updateUserRoles(user.id, values.accessLevel ?? 'user');
        return {lines: [`${user.username} now has ${titleFromKey(values.accessLevel ?? 'user')} access.`]};
      });
    });
  };
  const toggleUser = (user: User) => {
    const enable = user.enabled === false;
    const permitted = enable ? user.capabilities?.canEnable : user.capabilities?.canDisable;
    if (permitted === false) return message('Account is protected', `This account cannot be ${enable ? 'enabled' : 'disabled'}.`);
    openConfirm(`${enable ? 'Enable' : 'Disable'} ${user.username}`, enable ? 'The account will be allowed to sign in.' : 'Current sessions are ended and the account can no longer sign in.', enable ? 'enable' : 'disable', async () => {
      await perform(`${enable ? 'Enable' : 'Disable'} ${user.username}`, async () => {
        await runtime.api.setUserEnabled(user.id, enable);
        return {lines: [`${user.username} was ${enable ? 'enabled' : 'disabled'}.`]};
      });
    });
  };
  const resetUserPassword = (user: User) => {
    if (user.capabilities?.canResetPassword === false || !isLocalUser(user)) return message('Password is managed elsewhere', 'This identity is protected or managed by an external identity provider.');
    openForm(`Reset password for ${user.username}`, 'Set a temporary password that must be changed at the next sign-in.', [
      {id: 'password', label: 'Temporary password', value: '', kind: 'secret', required: true},
      {id: 'confirmation', label: 'Confirm password', value: '', kind: 'secret', required: true},
    ], 'set password', async (values) => {
      if ((values.password ?? '').length < 12) throw new Error('The temporary password must contain at least 12 characters.');
      if (values.password !== values.confirmation) throw new Error('The password confirmation does not match.');
      await perform(`Reset password for ${user.username}`, async () => {
        await runtime.api.resetUserPassword(user.id, values.password ?? '', true);
        return {lines: [`A temporary password was set for ${user.username}.`]};
      });
    });
  };
  const editUser = (entity: Extract<TuiEntity, {kind: 'user'}>) => {
    const user = entity.user;
    const options: MenuOption[] = [
      {label: 'Edit profile', disabled: user.capabilities?.canEditProfile === false || !isLocalUser(user), action: () => editUserProfile(user)},
      {label: 'Change dashboard access', disabled: user.capabilities?.canManageRoles === false, action: () => editUserRole(user)},
      {label: user.enabled === false ? 'Enable account' : 'Disable account', disabled: user.enabled === false ? user.capabilities?.canEnable === false : user.capabilities?.canDisable === false, action: () => toggleUser(user)},
      {label: 'Reset temporary password', disabled: user.capabilities?.canResetPassword === false || !isLocalUser(user), action: () => resetUserPassword(user)},
    ];
    overlay = {kind: 'menu', title: `Manage ${user.username}`, description: `${user.provider ?? user.source ?? 'Local'} identity`, options, active: Math.max(0, options.findIndex((item) => !item.disabled))};
    draw();
  };
  const deleteUser = (entity: Extract<TuiEntity, {kind: 'user'}>) => {
    if (entity.user.capabilities?.canDelete === false || !isLocalUser(entity.user)) return message('Account cannot be deleted', 'Self, recovery, last-admin, protected, and external accounts cannot be deleted here.');
    openForm(`Delete ${entity.user.username}`, 'This permanently deletes the local account. Enter the exact username to confirm.', [
      {id: 'confirmation', label: 'Username confirmation', value: '', required: true},
    ], 'delete user', async (values) => {
      if (values.confirmation !== entity.user.username) throw new Error('Enter the exact username to confirm deletion.');
      await perform(`Delete ${entity.user.username}`, async () => {
        await runtime.api.deleteUser(entity.user.id, values.confirmation ?? '');
        return {lines: [`${entity.user.username} was deleted.`]};
      });
    });
  };

  const createApiKey = () => openForm('Create API key', 'Use a recognizable application or integration name.', [
    {id: 'name', label: 'Name', value: '', required: true, hint: 'CI pipeline'},
  ], 'create key', async (values) => {
    await perform(`Create API key ${values.name}`, async () => {
      const result = await runtime.api.createApiKey(values.name ?? '');
      return {lines: [
        `API key ${values.name} was created. This secret is shown only once:`,
        result.key,
        'Press c to copy it before closing this message.',
      ], copyValue: result.key};
    });
  });
  const revokeApiKey = (entity: Extract<TuiEntity, {kind: 'api-key'}>) => openConfirm(`Revoke ${entity.item.name}`, 'Applications using this key lose access immediately.', 'revoke', async () => {
    await perform(`Revoke API key ${entity.item.name}`, async () => {
      await runtime.api.revokeApiKey(entity.id);
      return {lines: [`${entity.item.name} was revoked.`]};
    });
  });

  const editKubernetesAccess = (entity: Extract<TuiEntity, {kind: 'kubernetes'}>) => {
    if (entity.user.protected) return message('Kubernetes access is protected', 'Recovery access cannot be changed.');
    openForm(`Kubernetes access for ${entity.user.username}`, 'Assign an SSO-backed cluster role. Selecting No access revokes the direct group membership.', [
      {id: 'accessLevel', label: 'Access level', value: entity.user.accessLevel ?? 'none', kind: 'choice', choices: [
        {value: 'none', label: 'No access'}, {value: 'viewer', label: 'Viewer'},
        {value: 'operator', label: 'Operator'}, {value: 'admin', label: 'Cluster Administrator'},
      ]},
    ], 'save access', async (values) => {
      await perform(`Change Kubernetes access for ${entity.user.username}`, async () => {
        await runtime.api.updateKubernetesAccess(entity.id, values.accessLevel ?? 'none');
        return {lines: [`${entity.user.username} now has ${titleFromKey(values.accessLevel ?? 'none')} Kubernetes access.`]};
      });
    });
  };
  const revokeKubernetesAccess = (entity: Extract<TuiEntity, {kind: 'kubernetes'}>) => {
    if (entity.user.protected) return message('Kubernetes access is protected', 'Recovery access cannot be changed.');
    if ((entity.user.accessLevel ?? 'none') === 'none') return message('No Kubernetes access', `${entity.user.username} has no direct Kubernetes access.`);
    openConfirm(`Revoke Kubernetes access for ${entity.user.username}`, 'Existing direct Kubernetes group membership is removed.', 'revoke access', async () => {
      await perform(`Revoke Kubernetes access for ${entity.user.username}`, async () => {
        await runtime.api.updateKubernetesAccess(entity.id, 'none');
        return {lines: [`Kubernetes access was revoked for ${entity.user.username}.`]};
      });
    });
  };
  const copyKubeconfig = async (entity: Extract<TuiEntity, {kind: 'kubernetes'}>) => {
    await perform(`Copy kubeconfig for ${entity.user.username}`, async () => {
      const result = await runtime.api.kubeconfig(entity.id);
      process.stdout.write(osc52ClipboardSequence(result.content));
      return {lines: [`The token-free kubeconfig for ${entity.user.username} was copied through the terminal clipboard protocol.`]};
    });
  };

  const browseAction = (key: string) => {
    if (!['a', 'd', 'e', 'c', '\r', '\n'].includes(key)) return;
    if (options.demo) return message('Offline demo', 'This preview is read-only. Live actions require an appliance connection.');
    const tab = activeTab();
    const entity = selectedEntity();
    if ((tab === 'Services' || tab === 'Models') && !canMutateRuntime(snapshot.session)) return message('Read-only session', 'Operator or administrator access is required for this action.', 'error');
    if (['Users', 'API Access', 'Kubernetes'].includes(tab) && !canAdminister(snapshot.session)) return message('Administrator access required', 'This action is restricted to Magic Stick administrators.', 'error');
    if (tab === 'Services' && entity?.kind === 'service') {
      if (key === 'a') enableService(entity);
      else if (key === 'd') disableService(entity);
      else if (key === '\r' || key === '\n') entity.state.enabled ? disableService(entity) : enableService(entity);
    } else if (tab === 'Models') {
      if (key === 'a') addModel();
      else if (key === 'd' && entity?.kind === 'model') removeModel(entity);
    } else if (tab === 'Users') {
      if (key === 'a') createUser();
      else if ((key === 'e' || key === '\r' || key === '\n') && entity?.kind === 'user') editUser(entity);
      else if (key === 'd' && entity?.kind === 'user') deleteUser(entity);
    } else if (tab === 'API Access') {
      if (key === 'a') createApiKey();
      else if (key === 'd' && entity?.kind === 'api-key') revokeApiKey(entity);
    } else if (tab === 'Kubernetes' && entity?.kind === 'kubernetes') {
      if (key === 'e' || key === 'a' || key === '\r' || key === '\n') editKubernetesAccess(entity);
      else if (key === 'd') revokeKubernetesAccess(entity);
      else if (key === 'c') void copyKubeconfig(entity);
    }
  };

  let finish: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    animation.stop();
    process.stdin.off('data', onData);
    process.stdin.off('end', cleanup);
    process.stdout.off('resize', draw);
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    process.off('SIGHUP', cleanup);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${SHOW_CURSOR}${NORMAL_SCREEN}`);
    finish?.();
  };
  const handleOverlayInput = (key: string, current: TuiOverlay) => {
    if (current.kind === 'busy') return;
    if (key === '\u001b') {
      overlay = undefined;
      draw();
      return;
    }
    if (current.kind === 'message') {
      if (key === 'c' && current.copyValue) {
        process.stdout.write(osc52ClipboardSequence(current.copyValue));
        current.lines = [...current.lines.filter((line) => line !== 'Copied to clipboard.'), 'Copied to clipboard.'];
        draw();
      } else if (key === '\r' || key === '\n') {
        overlay = undefined;
        draw();
      }
      return;
    }
    if (current.kind === 'confirm') {
      if (key === 'n') {
        overlay = undefined;
        draw();
      } else if (key === 'y' || key === '\r' || key === '\n') void current.onConfirm();
      return;
    }
    if (current.kind === 'menu') {
      if (key === '\u001b[A' || key === 'k') current.active = moveSelection(current.active, -1, current.options.length);
      else if (key === '\u001b[B' || key === 'j' || key === '\t') current.active = moveSelection(current.active, 1, current.options.length);
      else if (key === '\r' || key === '\n') {
        const item = current.options[current.active];
        if (item?.disabled) message('Action unavailable', item.hint ?? 'This action is not available for the selected item.', 'error');
        else item?.action();
        return;
      }
      draw();
      return;
    }
    const field = current.fields[current.active];
    if (!field) return;
    if (key === '\u001b[A' || key === '\u001b[Z') current.active = moveSelection(current.active, -1, current.fields.length);
    else if (key === '\u001b[B' || key === '\t') current.active = moveSelection(current.active, 1, current.fields.length);
    else if (key === '\r' || key === '\n') {
      if (current.active === current.fields.length - 1) void submitForm(current);
      else current.active = moveSelection(current.active, 1, current.fields.length);
    } else if (key === '\u0013') void submitForm(current);
    else if (key === '\u0015') {
      field.value = '';
      current.error = undefined;
    }
    else if (field.kind === 'choice' && (key === '\u001b[D' || key === '\u001b[C' || key === ' ')) {
      const choices = field.choices ?? [];
      const index = Math.max(0, choices.findIndex((item) => item.value === field.value));
      const direction = key === '\u001b[D' ? -1 : 1;
      field.value = choices[moveTab(index, direction, choices.length)]?.value ?? field.value;
      current.error = undefined;
    } else if (field.kind !== 'choice' && (key === '\u007f' || key === '\b')) {
      field.value = Array.from(field.value).slice(0, -1).join('');
      current.error = undefined;
    }
    else if (field.kind !== 'choice' && !key.startsWith('\u001b')) {
      field.value += Array.from(key).filter((character) => character >= ' ' && character !== '\u007f').join('');
      current.error = undefined;
    }
    draw();
  };
  const handleBrowseInput = (key: string) => {
    if (key === '\u0003') {
      cleanup();
      return;
    }
    if (key === 'q') {
      cleanup();
      return;
    }
    if (key === 'x') {
      if (options.demo) return message('Offline demo', 'No session is stored or changed in demo mode. Press q to quit.');
      openConfirm('Sign out', 'The locally cached SSO session is removed. The appliance console will request a new device login.', 'sign out', async () => {
        await runtime.logout();
        cleanup();
      });
      return;
    }
    const tabs = availableTabs(snapshot);
    if (key === '\u001b[C' || key === 'l') {
      tabIndex = moveTab(tabIndex, 1, tabs.length);
      clampSelection();
    } else if (key === '\u001b[D' || key === 'h') {
      tabIndex = moveTab(tabIndex, -1, tabs.length);
      clampSelection();
    } else if (key === '\u001b[B' || key === 'j') {
      selection[activeTab()] = moveSelection(activeSelection(), 1, selectableCount(activeTab(), snapshot));
    } else if (key === '\u001b[A' || key === 'k') {
      selection[activeTab()] = moveSelection(activeSelection(), -1, selectableCount(activeTab(), snapshot));
    } else if (key === 'r') void refresh();
    else browseAction(key);
    draw();
  };
  const onData = (input: Buffer) => {
    const value = input.toString('utf8');
    const activeField = overlay?.kind === 'form' ? overlay.fields[overlay.active] : undefined;
    const printablePaste = activeField?.kind !== 'choice'
      && Array.from(value).length > 1
      && Array.from(value).every((character) => character >= ' ' && character !== '\u007f');
    const keys = printablePaste ? [value] : splitTerminalInput(value);
    for (const key of keys) {
      if (finished) return;
      if (key === '\u0003') {
        cleanup();
        return;
      }
      if (overlay) handleOverlayInput(key, overlay);
      else handleBrowseInput(key);
    }
  };

  process.stdout.write(`${ALT_SCREEN}${HIDE_CURSOR}${CLEAR}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdin.once('end', cleanup);
  process.stdout.on('resize', draw);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('SIGHUP', cleanup);
  timer = setInterval(() => void refresh(), Math.max(5, options.refreshSeconds ?? 15) * 1000);
  animation.start();
  draw();
  await new Promise<void>((resolve) => { finish = resolve; });
};
