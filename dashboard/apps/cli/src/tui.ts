import {dashboardRole, flattenInstances, formatMi, phaseNeedsAttention, titleFromKey} from '@magicstick/dashboard-core';
import type {DashboardSnapshot} from './snapshot';
import {loadSnapshot} from './snapshot';
import type {Runtime} from './runtime';
import {truncate} from './output';

export type TuiTab = 'Overview' | 'Services' | 'Models' | 'Settings' | 'Users' | 'API Access' | 'Kubernetes' | 'System';

const CLEAR = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ALT_SCREEN = '\x1b[?1049h';
const NORMAL_SCREEN = '\x1b[?1049l';
const cyan = (value: string, color: boolean) => color ? `\x1b[36m${value}\x1b[0m` : value;
const dim = (value: string, color: boolean) => color ? `\x1b[2m${value}\x1b[0m` : value;
const good = (value: string, color: boolean) => color ? `\x1b[32m${value}\x1b[0m` : value;
const bad = (value: string, color: boolean) => color ? `\x1b[31m${value}\x1b[0m` : value;

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

const statusLabel = (value?: string) => value || 'Unknown';

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

const serviceLines = (snapshot: DashboardSnapshot) => {
  const modules = Object.entries(snapshot.modules.modules ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const instances = flattenInstances(snapshot.instances);
  return [
    'Modules',
    ...modules.map(([id, item]) => `  ${item.enabled ? '●' : '○'} ${(item.displayName ?? titleFromKey(id)).padEnd(25)} ${statusLabel(item.status?.phase)}`),
    '', 'Instances',
    ...instances.map((item) => `  ● ${item.type.padEnd(15)} ${item.name.padEnd(24)} ${statusLabel(item.value.status?.phase)}`),
  ];
};

const modelLines = (snapshot: DashboardSnapshot) => {
  const devices = snapshot.models.computeMemory?.devices ?? [];
  return [
    'Compute memory',
    ...devices.map((device) => `  ${device.name ?? device.id}: ${formatMi(device.freeMi)} free / ${formatMi(device.unreservedMi)} unreserved / ${formatMi(device.totalMi)} total`),
    '', 'Models',
    ...(snapshot.models.activations ?? []).map((item) => {
      const local = item.spec?.local ?? {};
      return `  ${item.metadata?.name ?? 'unnamed'}  ${statusLabel(item.status?.phase)}  ${String(local.engine ?? '')} ${String(local.computeTarget ?? '')}`.trimEnd();
    }),
  ];
};

const settingsLines = (snapshot: DashboardSnapshot) => [
  `Public domain  ${snapshot.settings?.publicDomain ?? 'unavailable'}`,
  `Dashboard host ${snapshot.settings?.dashboardHost ?? 'unavailable'}`,
  `mDNS domain    ${snapshot.settings?.mdnsDomain ?? 'unavailable'}`,
];

const userLines = (snapshot: DashboardSnapshot) => [
  `${snapshot.users?.total ?? 0} user(s)`,
  ...(snapshot.users?.users ?? []).map((user) => `  ${user.enabled ? '●' : '○'} ${user.username.padEnd(22)} ${(user.effectiveAccessLevel ?? user.accessLevel ?? 'user').padEnd(10)} ${user.provider ?? user.source ?? 'local'}`),
];

const apiAccessLines = (snapshot: DashboardSnapshot) => [
  `${snapshot.apiAccess?.total ?? 0} named API key(s)`,
  ...(snapshot.apiAccess?.apiBases ?? []).map((item) => `  ${item.scope ?? 'api'}  ${item.url}`),
  '',
  ...(snapshot.apiAccess?.items ?? []).map((item) => `  ${item.name.padEnd(24)} ${item.keyHint ?? ''} ${item.status ?? 'active'}`),
];

const kubernetesLines = (snapshot: DashboardSnapshot) => {
  const configured = Boolean(snapshot.kubernetesAccess?.configuration?.configured);
  return [
    `OIDC configuration  ${configured ? 'Ready' : 'Not confirmed'}`,
    `${snapshot.kubernetesAccess?.total ?? 0} identity/identities`,
    ...(snapshot.kubernetesAccess?.users ?? []).map((user) => `  ${user.enabled ? '●' : '○'} ${user.username.padEnd(22)} ${(user.accessLevel ?? 'none').padEnd(10)} ${user.provider ?? user.source ?? 'local'}`),
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

export const tabLines = (tab: TuiTab, snapshot: DashboardSnapshot) => {
  switch (tab) {
    case 'Services': return serviceLines(snapshot);
    case 'Models': return modelLines(snapshot);
    case 'Settings': return settingsLines(snapshot);
    case 'Users': return userLines(snapshot);
    case 'API Access': return apiAccessLines(snapshot);
    case 'Kubernetes': return kubernetesLines(snapshot);
    case 'System': return systemLines(snapshot);
    default: return overviewLines(snapshot);
  }
};

export const renderTui = (snapshot: DashboardSnapshot, tabIndex: number, width = 100, height = 30, color = true) => {
  const tabs = availableTabs(snapshot);
  const safeIndex = Math.min(Math.max(0, tabIndex), tabs.length - 1);
  const active = tabs[safeIndex] ?? 'Overview';
  const header = `${cyan('MAGIC STICK', color)}  ${dim(`signed in: ${snapshot.session.username} · ${dashboardRole(snapshot.session)}`, color)}`;
  const navigation = tabs.map((tab, index) => index === safeIndex ? cyan(`[ ${tab} ]`, color) : `  ${tab}  `).join('');
  const maximumBody = Math.max(3, height - 7);
  const body = tabLines(active, snapshot).slice(0, maximumBody).map((line) => truncate(line, Math.max(20, width - 2)));
  const health = phaseNeedsAttention(snapshot.appliance.status?.phase) ? bad(statusLabel(snapshot.appliance.status?.phase), color) : good(statusLabel(snapshot.appliance.status?.phase), color);
  return [header, navigation, '─'.repeat(Math.max(20, Math.min(width, 140))), `${active}  ${dim(`Appliance ${health}`, color)}`, '', ...body, '', dim('←/→ or h/l: page · r: refresh · q: quit · mutations: magicstick --help', color)].join('\n');
};

export const runTui = async (runtime: Runtime, options: {color?: boolean; refreshSeconds?: number} = {}) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI needs an interactive terminal. Use CLI commands or --json for non-interactive use.');
  let snapshot = await loadSnapshot(runtime.api);
  let tabIndex = 0;
  let loading = false;
  let refreshError = '';
  const color = options.color !== false;

  const draw = () => {
    const rendered = renderTui(snapshot, tabIndex, process.stdout.columns ?? 100, process.stdout.rows ?? 30, color);
    const failure = refreshError ? `\n${bad(`Refresh failed: ${truncate(refreshError, 100)}`, color)}` : '';
    process.stdout.write(`${CLEAR}${rendered}${failure}`);
  };
  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      snapshot = await loadSnapshot(runtime.api);
      refreshError = '';
    } catch (error) {
      refreshError = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
      draw();
    }
  };
  let finished = false;
  let finish: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    process.stdin.off('data', onData);
    process.stdin.off('end', cleanup);
    process.stdout.off('resize', draw);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${SHOW_CURSOR}${NORMAL_SCREEN}`);
    finish?.();
  };
  const onData = (input: Buffer) => {
    const key = input.toString('utf8');
    if (key === 'q' || key === '\u0003') {
      cleanup();
      return;
    }
    if (key === '\u001b[C' || key === 'l' || key === 'j') tabIndex = moveTab(tabIndex, 1, availableTabs(snapshot).length);
    if (key === '\u001b[D' || key === 'h' || key === 'k') tabIndex = moveTab(tabIndex, -1, availableTabs(snapshot).length);
    if (key === 'r') void refresh();
    draw();
  };

  process.stdout.write(`${ALT_SCREEN}${HIDE_CURSOR}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdin.once('end', cleanup);
  process.stdout.on('resize', draw);
  timer = setInterval(() => void refresh(), Math.max(5, options.refreshSeconds ?? 15) * 1000);
  draw();
  await new Promise<void>((resolve) => { finish = resolve; });
};
