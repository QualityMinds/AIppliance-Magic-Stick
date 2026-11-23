// Shared building blocks of the terminal pages: headings, badges, fact lists,
// progress rows and section bars, in the style of the browser components.
import {
  phaseInProgress, phaseNeedsAttention, phaseTone, progressForPhase, titleFromKey,
  type ResourceLink,
} from '@magicstick/dashboard-core';
import type {ModuleCatalogEntry, ModuleState, User} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import {
  badge, choice, clipText, fit, gap, joinSpans, link, panel, phaseToneOf, progressBar, prose, span, textWidth,
  type Row, type Span, type Tone,
} from './tui-screen';

export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
export const text = (width: number, value: string, tone?: Tone): Row => fit(width, [span(value, tone)]);
export const blank: Row = [];

export const statusBadge = (phase?: string): Span => {
  const label = phase || 'Unknown';
  return badge(label, phaseToneOf(phaseTone(label)), !['disabled', 'suspended'].includes(label.toLowerCase()));
};

export const heading = (width: number, title: string, subtitle: string, actions: Row = []): Row[] => [
  fit(width, [span(title, undefined, true)], actions),
  ...(subtitle ? prose(width, subtitle, 'dim') : []),
  blank,
];

export const sectionLabel = (width: number, title: string, detail: string, actions: Row = []): Row =>
  fit(width, [span(title.toUpperCase(), undefined, true), ...(detail ? [span(` · ${detail}`, 'dim')] : [])], actions);

export const linkRows = (links: ResourceLink[]): Row[] => links.map((item) => [link(item.url), span(`  ${item.scope}`, 'dim')]);

/** A progress bar while something is changing or needs attention; nothing for a settled state. */
export const progressRows = (phase: string, enabled: boolean | undefined, message?: string): Row[] => {
  if (!phaseInProgress(phase) && !phaseNeedsAttention(phase)) return [];
  const progress = progressForPhase(phase, enabled, message);
  return [progressBar(progress.value, progress.label, phaseToneOf(progress.tone))];
};

export const note = (width: number, title: string, value: string): Row[] => panel(width, {title}, prose(width - 4, value, 'dim'));

/** Label/value rows like the browser's fact lists; long values wrap under their value column. */
export const facts = (width: number, rows: Array<[string, string]>, labelWidth?: number): Row[] => {
  const size = labelWidth ?? Math.min(34, Math.max(0, ...rows.map(([label]) => textWidth(label))) + 2);
  return rows.flatMap(([label, value]) => prose(Math.max(10, width - size), value || '—').map((row, index) => [
    span(index ? ' '.repeat(size) : clipText(label, size - 1).padEnd(size), 'dim'), ...row,
  ]));
};

/** A row of tags, wrapped to the width (the browser's tag lists). */
export const tags = (width: number, values: string[], tone: Tone = 'dim'): Row[] => {
  const rows: Row[] = [];
  let row: Row = [];
  let used = 0;
  for (const value of values.filter(Boolean)) {
    const label = clipText(`[${value}]`, width);
    const size = textWidth(label) + (row.length ? 1 : 0);
    if (row.length && used + size > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(...(row.length ? [gap()] : []), span(label, tone));
    used += textWidth(label) + (row.length > 1 ? 1 : 0);
  }
  if (row.length) rows.push(row);
  return rows;
};

export const metrics = (width: number, items: Array<{label: string; value: string; detail: Span}>): Row[] => {
  const size = Math.floor((width - (items.length - 1)) / items.length);
  const last = width - (size + 1) * (items.length - 1);
  const boxes = items.map((item, index) => panel(index === items.length - 1 ? last : size, {title: item.label}, [[span(item.value, undefined, true), gap(2), item.detail]]));
  return boxes[0]!.map((_, index) => boxes.flatMap((box, column) => column ? [gap(1), ...box[index]!] : box[index]!));
};

/** A bar of pressed/unpressed choices: section tabs and filters. */
export const tabBar = (prefix: string, items: Array<{id: string; label: string; disabled?: string}>, active: string): Row =>
  joinSpans(items.map((item) => item.disabled
    ? {...choice(`${prefix}:${item.id}`, item.label, false), style: {tone: 'dim' as const}, action: {id: `${prefix}:${item.id}`, label: item.label, disabled: item.disabled}}
    : choice(`${prefix}:${item.id}`, item.label, item.id === active)), 2);

export const modulePhase = (state: ModuleState, spec: ModuleCatalogEntry | undefined, phase?: string) =>
  phase ?? ((state.activationMode ?? spec?.activationMode) === 'static' && state.enabled ? 'Ready' : state.enabled ? 'Requested' : 'Disabled');

export const instanceTitle = (type: string, name: string) => {
  const prefix = `${type}-`;
  const shortName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return `${titleFromKey(type)}${shortName && shortName !== type ? ` ${shortName}` : ''}`;
};

export const userSource = (user: User) => {
  if (typeof user.source === 'object' && user.source) {
    const source = user.source as Record<string, unknown>;
    return String(source.displayName ?? source.provider ?? source.alias ?? source.type ?? 'External');
  }
  return String(user.provider ?? user.source ?? 'Local');
};
export const isLocalUser = (user: User) => user.local ?? ['local', 'keycloak', 'internal'].includes(userSource(user).toLowerCase());

/** Chat models an application instance can use, as the browser's create form lists them. */
export const deployedChatModels = (snapshot: DashboardSnapshot) => [...new Set((snapshot.models.models ?? [])
  .filter((model) => String(model.type ?? '').toLowerCase() === 'chat').map((model) => String(model.id ?? model.name ?? '')).filter(Boolean))].sort();

/** Local date and time, as the browser shows timestamps. */
export const dateTime = (value?: string | number | null) => {
  if (value === undefined || value === null || value === '') return 'Unknown';
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
};

/** Shown while on-demand page data has not arrived or failed to load. */
export const loadingRows = (width: number, error: string | undefined, what: string): Row[] => error
  ? [...prose(width, `${what} could not be loaded: ${error}`, 'bad'), blank, ...prose(width, 'Press r to try again.', 'dim')]
  : prose(width, `Loading ${what.toLowerCase()}…`, 'dim');

export const terminalHostPhases = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted', 'RolledBack']);
