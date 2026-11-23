// Overview page and the "My applications" page of users without a dashboard role
// (apps/web/src/pages/OverviewPage.tsx, MyInstancesPage.tsx).
import {
  effectiveModuleStatus, flattenInstances, instanceResourceLinks, moduleResourceLinks, phaseNeedsAttention, titleFromKey,
} from '@magicstick/dashboard-core';
import type {ModuleState} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {PageView} from './tui-state';
import {fit, gap, panel, prose, span, type Row} from './tui-screen';
import {
  blank, heading, instanceTitle, linkRows, metrics, modulePhase, plural, statusBadge, text,
} from './tui-widgets';

export const overviewPage = (snapshot: DashboardSnapshot, width: number): PageView => {
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
    if (phaseNeedsAttention(phase)) attention.push({title: `Module ${state.displayName ?? catalog[id]?.displayName ?? titleFromKey(id)}`, detail: status.message ?? phase, phase});
  });
  instances.forEach((item) => {
    const phase = item.value.status?.phase ?? (item.value.spec?.enabled === false ? 'Suspended' : 'Requested');
    if (phaseNeedsAttention(phase)) attention.push({title: `Instance ${instanceTitle(item.type, item.name)}`, detail: item.value.status?.message ?? phase, phase});
  });
  activations.forEach((item) => {
    const removing = Boolean(item.metadata?.deletionTimestamp);
    const phase = item.status?.phase ?? (item.spec?.enabled === false ? 'Disabled' : 'Requested');
    if (phaseNeedsAttention(phase) || removing) attention.push({title: `Model ${item.metadata?.name ?? 'unnamed'}`, detail: item.status?.message ?? (removing ? 'Removing' : phase), phase: removing ? 'Removing' : phase});
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
      {label: 'Models', value: String(activations.length + registered.length), detail: span('installed or registered', 'dim')},
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

/** Applications shared with a signed-in user who has no dashboard role. */
export const myInstancesPage = (snapshot: DashboardSnapshot, width: number): PageView => {
  const inner = width - 4;
  const items = snapshot.myInstances ?? [];
  const links = (urls: string[]): Row[] => urls.flatMap((url) => {
    try {
      const parsed = new URL(url);
      return ['https:', 'http:'].includes(parsed.protocol) ? [linkRows([{url, label: parsed.host, scope: 'direct'}])[0]!] : [];
    } catch { return []; }
  });
  return {hotkeys: [], rows: [
    ...heading(width, 'My applications', `Signed in: ${snapshot.session.username}. Applications available to your account.`),
    ...items.flatMap((item) => panel(width, {title: item.name, meta: item.application, status: statusBadge(item.phase)}, links(item.urls).length ? links(item.urls) : [text(inner, 'No address reported yet.', 'dim')])),
    ...(items.length ? [] : [text(width, 'No instances are currently available to your account.', 'dim')]),
  ]};
};
