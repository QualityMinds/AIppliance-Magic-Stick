import {
  canAdminister,
  canMutateRuntime,
  consoleAccessLabel,
  dashboardRole,
  formatMi,
  flattenInstances,
  gpuCompatibilityParameters,
  initialInstanceDraft,
  instanceCreatePayload,
  instanceHasStorage,
  instanceModelRequired,
  missingApplicationModules,
  modelEditRevision,
  sessionDisplayName,
  titleFromKey,
} from '@magicstick/dashboard-core';
import {CONSOLE_ACCESS_LEVELS} from '@magicstick/dashboard-contracts';
import type {
  ApiKeyItem,
  ComputeTarget,
  ConsoleAccessLevel,
  InstanceAccessState,
  InstanceSharing,
  KubernetesAccessUser,
  ModelActivation,
  ModuleCatalogEntry,
  ModuleState,
  User,
} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import {loadSnapshot} from './snapshot';
import type {Runtime} from './runtime';
import {truncate} from './output';
import {bannerFits, createBannerAnimation, renderBanner, type BannerFrame} from './banner';
import {previewLines, readLicenseFile, saveLicenseFile} from './license';
import {
  activeSystemSection, availablePages, availableSystemSections, buildPage, deployedChatModels, isLocalUser, SERVICE_FILTERS,
  type Hotkey, type PageId, type PageState,
} from './tui-pages';
import {
  badge, button, Canvas, fit, gap, hitTarget, panel, prose, span, textWidth,
  type Action, type Row, type Span, type Target,
} from './tui-screen';

export {availablePages, availableSystemSections} from './tui-pages';
export type {PageId, SystemSectionId, ServiceFilter} from './tui-pages';

/** Why the TUI ended: a plain quit, or a request the appliance console must act on. */
export type TuiOutcome = 'quit' | 'switch-user' | 'restart-session';

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

export type TuiOverlay =
  | {kind: 'menu'; title: string; description?: string; options: MenuOption[]; active: number}
  | {kind: 'form'; title: string; description?: string; fields: FormField[]; active: number; submitLabel: string; error?: string; onSubmit: (values: Record<string, string>) => Promise<void>}
  | {kind: 'confirm'; title: string; description: string; confirmLabel: string; onConfirm: () => Promise<void>}
  | {kind: 'message'; title: string; lines: string[]; tone?: 'normal' | 'error'; copyValue?: string}
  | {kind: 'busy'; title: string; description?: string};

/** Everything that decides what the screen shows, besides the appliance data. */
export interface TuiViewState extends PageState {
  /** The element under the cursor; resolved to an existing element on every render. */
  focusId?: string;
  /** Where the cursor last was, to stay close when its element disappears after a refresh. */
  focusAt?: {x: number; y: number};
  scrollTop: number;
  overlay?: TuiOverlay;
  notice?: string;
  demo?: boolean;
  /** The terminal is the appliance console with automatic sign-in: x switches users instead of signing out. */
  localConsole?: boolean;
  banner?: BannerFrame;
  /** Screen cell of a mouse pointer the TUI has to draw itself (the attached monitor has none). */
  pointer?: {x: number; y: number};
}

export const initialViewState = (overrides: Partial<TuiViewState> = {}): TuiViewState => ({
  page: 'overview', systemSection: 'status', serviceFilter: 'all', expanded: {}, scrollTop: 0, ...overrides,
});

export interface LocalModelInput {
  name: string;
  modelType: string;
  engine: string;
  computeTarget: string;
  reference: string;
  contextWindow: number;
  maxNumSeqs: number;
  kvCacheType?: string;
  reservationMi: number;
  cpuOffloading?: boolean;
  hostMemoryMi?: number;
}

const CLEAR = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ALT_SCREEN = '\x1b[?1049h';
const NORMAL_SCREEN = '\x1b[?1049l';
// Click and wheel reports in the SGR encoding; terminals without mouse support ignore both.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1003l\x1b[?1000l';
// Additionally reports every pointer movement, for a console where the TUI draws the pointer.
const MOUSE_MOTION_ON = '\x1b[?1003h';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
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
    kvCacheType: input.kvCacheType ?? (input.engine === 'OLlama' ? 'f16' : 'auto'),
    url: input.reference,
  };
  if (target.kind === 'cpu' || input.computeTarget === 'cpu') local.memoryRequiredMi = input.reservationMi;
  else local.vram = `${input.reservationMi}Mi`;
  if (input.cpuOffloading !== undefined) {
    if (input.cpuOffloading && input.computeTarget !== 'nvidia-gpu') throw new Error('CPU offloading currently supports NVIDIA GPU models only.');
    if (input.computeTarget === 'nvidia-gpu') local.cpuOffloading = input.cpuOffloading;
    if (input.cpuOffloading) {
      if (!Number.isInteger(input.hostMemoryMi) || Number(input.hostMemoryMi) < 100) throw new Error('A separate host RAM reservation is required for CPU offloading.');
      local.memoryRequiredMi = input.hostMemoryMi;
    }
  }
  return {name: input.name, enabled: true, targetNamespace: 'ai', local};
};

export const osc52ClipboardSequence = (value: string) => `\x1b]52;c;${Buffer.from(value).toString('base64')}\x07`;

/** Splits one raw terminal chunk into keys; control sequences (arrows, paging keys, mouse reports) stay whole. */
export const splitTerminalInput = (value: string) => {
  const keys: string[] = [];
  for (let index = 0; index < value.length;) {
    if (value[index] === '\u001b' && value[index + 1] === '[') {
      let end = index + 2;
      while (end < value.length && /[0-9;<=>?]/.test(value[end]!)) end += 1;
      if (end < value.length) {
        keys.push(value.slice(index, end + 1));
        index = end + 1;
        continue;
      }
    }
    const [key = ''] = Array.from(value.slice(index));
    keys.push(key);
    index += key.length;
  }
  return keys;
};

export interface MouseEvent {
  button: number;
  x: number;
  y: number;
  pressed: boolean;
}

/** Decodes an SGR mouse report (`ESC [ < button ; column ; row M|m`) to zero-based screen cells. */
export const parseMouse = (key: string): MouseEvent | undefined => {
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
  return match ? {button: Number(match[1]), x: Number(match[2]) - 1, y: Number(match[3]) - 1, pressed: match[4] === 'M'} : undefined;
};

export const moveTab = (index: number, direction: number, count: number) => count
  ? (index + direction + count) % count
  : 0;

export const moveSelection = (index: number, direction: number, count: number) => count
  ? Math.min(Math.max(0, index + direction), count - 1)
  : 0;

// The layout is designed for 120 columns; wider terminals keep that width.
export const MAX_CONTENT_COLUMNS = 120;
// Leave the final terminal column unused to avoid automatic line wrapping.
const usableColumns = (width: number) => Math.max(1, width - 1);
const SIDEBAR = 20;

/** A focusable element with a key that stays unique when the same action appears twice on a page. */
export interface FocusTarget extends Target {
  key: string;
}

interface BarItem {
  key: string;
  label: string;
  actionId?: string;
}

export interface TuiLayout {
  lines: string[];
  /** Screen row of the first row below the banner; mouse targets are relative to it. */
  top: number;
  mouse: Target[];
  header: FocusTarget[];
  nav: FocusTarget[];
  /** Page elements in page coordinates: `y` is the row within the whole page, not the visible window. */
  content: FocusTarget[];
  focused?: FocusTarget;
  hotkeys: Hotkey[];
  page: PageId;
  scrollTop: number;
  maxScroll: number;
  viewport: number;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const keyed = (targets: Target[]): FocusTarget[] => {
  const seen = new Map<string, number>();
  return targets.map((target) => {
    const count = seen.get(target.action.id) ?? 0;
    seen.set(target.action.id, count + 1);
    return {...target, key: count ? `${target.action.id}#${count}` : target.action.id};
  });
};

const fieldRow = (field: FormField, active: boolean): string => {
  const shown = displayFieldValue(field);
  const value = field.kind === 'choice' ? `< ${shown} >` : `${shown}${active ? '_' : ''}`;
  return `${field.label}${field.required ? ' *' : ''}: ${value}${!shown && field.hint ? `  (${field.hint})` : ''}`;
};

const dialog = (overlay: TuiOverlay, width: number, room: number): {rows: Row[]; focus?: string} => {
  const inner = width - 4;
  const description = 'description' in overlay && overlay.description ? [...prose(inner, overlay.description, 'dim'), []] : [];
  const footer = (buttons: Span[]): Row[] => [[], fit(inner, [], buttons.flatMap((item, index) => index ? [gap(), item] : [item]))];
  const limited = (lead: Row[], tail: Row[]) => lead.length + tail.length > room ? [...lead.slice(0, Math.max(0, room - tail.length)), ...tail] : [...lead, ...tail];
  if (overlay.kind === 'busy') return {rows: panel(width, {title: overlay.title}, prose(inner, overlay.description ?? 'Applying change and refreshing state…', 'dim'))};
  if (overlay.kind === 'message') return {
    focus: 'dlg:close',
    rows: panel(width, {title: overlay.title, status: overlay.tone === 'error' ? badge('Failed', 'bad') : undefined}, limited(
      overlay.lines.flatMap((line) => prose(inner, line, overlay.tone === 'error' ? 'bad' : undefined)),
      footer([...(overlay.copyValue ? [button('dlg:copy', 'Copy')] : []), button('dlg:close', 'Close', 'primary')]),
    )),
  };
  if (overlay.kind === 'confirm') return {
    focus: 'dlg:confirm',
    rows: panel(width, {title: overlay.title}, limited(
      prose(inner, overlay.description),
      footer([button('dlg:cancel', 'Cancel'), button('dlg:confirm', capitalize(overlay.confirmLabel), 'primary')]),
    )),
  };
  if (overlay.kind === 'menu') return {
    focus: `dlg:option:${overlay.active}`,
    rows: panel(width, {title: overlay.title}, limited([
      ...description,
      ...overlay.options.map((item, index): Row => [{
        text: `${item.disabled ? '×' : '●'} ${item.label}${item.hint ? ` — ${item.hint}` : ''}`,
        style: item.disabled ? {tone: 'dim'} : undefined,
        action: {id: `dlg:option:${index}`, label: 'Choose'},
      }]),
    ], footer([button('dlg:cancel', 'Cancel')]))),
  };
  const error = overlay.error ? [[], ...prose(inner, `! ${overlay.error}`, 'bad')] : [];
  const tail = [...error, ...footer([button('dlg:cancel', 'Cancel'), button('dlg:submit', capitalize(overlay.submitLabel), 'primary')])];
  // Long forms show a window of fields around the active one, so it and the buttons stay on screen.
  const visible = Math.max(1, Math.min(overlay.fields.length, room - description.length - tail.length));
  const start = Math.max(0, Math.min(overlay.active - Math.floor(visible / 2), overlay.fields.length - visible));
  return {
    focus: `dlg:field:${overlay.active}`,
    rows: panel(width, {title: overlay.title, meta: overlay.fields.length > visible ? `field ${overlay.active + 1} of ${overlay.fields.length}` : undefined}, limited([
      ...description,
      ...overlay.fields.slice(start, start + visible).map((field, offset): Row => [{
        text: fieldRow(field, start + offset === overlay.active),
        action: {id: `dlg:field:${start + offset}`, label: 'Edit'},
      }]),
    ], tail)),
  };
};

const overlayBar = (overlay: TuiOverlay): BarItem[] => {
  if (overlay.kind === 'busy') return [{key: '…', label: 'Please wait'}];
  if (overlay.kind === 'message') return [
    {key: 'Enter', label: 'Close', actionId: 'dlg:close'},
    ...(overlay.copyValue ? [{key: 'c', label: 'Copy to clipboard', actionId: 'dlg:copy'}] : []),
  ];
  if (overlay.kind === 'confirm') return [
    {key: 'Enter', label: capitalize(overlay.confirmLabel), actionId: 'dlg:confirm'}, {key: 'Esc', label: 'Cancel', actionId: 'dlg:cancel'},
  ];
  if (overlay.kind === 'menu') return [
    {key: '↑↓', label: 'Select'}, {key: 'Enter', label: 'Choose'}, {key: 'Esc', label: 'Cancel', actionId: 'dlg:cancel'},
  ];
  const last = overlay.active === overlay.fields.length - 1;
  return [
    {key: '↑↓', label: 'Field'},
    ...(overlay.fields[overlay.active]?.kind === 'choice' ? [{key: '←→', label: 'Change'}] : []),
    {key: 'Enter', label: last ? capitalize(overlay.submitLabel) : 'Next'},
    {key: 'Ctrl+S', label: capitalize(overlay.submitLabel), actionId: 'dlg:submit'},
    {key: 'Ctrl+U', label: 'Clear'}, {key: 'Esc', label: 'Cancel', actionId: 'dlg:cancel'},
  ];
};

/** Lays out one full screen and reports where every interactive element is. */
export const composeTui = (snapshot: DashboardSnapshot, state: TuiViewState, width = 120, height = 36, color = true): TuiLayout => {
  const columns = Math.min(usableColumns(width), MAX_CONTENT_COLUMNS);
  const banner = bannerFits(height) ? renderBanner(columns, state.banner?.elapsedMs, color, state.banner?.seed) : [];
  const rows = Math.max(1, height - banner.length);
  const canvas = new Canvas(columns, rows);
  const pages = availablePages(snapshot);
  const page = pages.some((item) => item.id === state.page) ? state.page : 'overview';
  const viewport = Math.max(0, rows - 4 - (state.notice ? 1 : 0));
  const contentX = SIDEBAR + 3;
  const contentWidth = Math.max(10, columns - SIDEBAR - 6);
  const view = buildPage(snapshot, {...state, page}, contentWidth);
  const pageRows = view.rows.map((row) => fit(contentWidth, row));
  const maxScroll = Math.max(0, pageRows.length - viewport);
  const scrollTop = Math.min(Math.max(0, state.scrollTop), maxScroll);

  // Header: the one-line counterpart of the web header.
  const identity: Row = state.demo ? [span('OFFLINE DEMO · read-only · sample data', 'warn')] : [
    state.notice ? badge('Not refreshed', 'warn') : badge('Connected', 'good'),
    span(`  Signed in: ${sessionDisplayName(snapshot.session)} · ${dashboardRole(snapshot.session)}${snapshot.session.localConsole ? ' · automatic' : ''}  `, 'dim'),
    button('session', state.localConsole ? 'Switch user' : 'Sign out'),
  ];
  canvas.row(1, 0, fit(Math.max(0, columns - 2), [span('AI Appliance Dashboard', undefined, true)], identity), 'header');

  // Workspace frame: sidebar with the pages on the left, the page on the right.
  const frame = {tone: 'dim'} as const;
  const horizontal = (left: string, middle: string, right: string) => `${left}${'─'.repeat(SIDEBAR)}${middle}${'─'.repeat(Math.max(0, columns - SIDEBAR - 3))}${right}`;
  canvas.put(0, 1, horizontal('┌', '┬', '┐'), frame);
  for (let index = 0; index < viewport; index += 1) {
    for (const x of [0, SIDEBAR + 1, columns - 1]) canvas.put(x, 2 + index, '│', frame);
  }
  canvas.put(0, 2 + viewport, horizontal('└', '┴', '┘'), frame);
  pages.slice(0, viewport).forEach((item, index) => {
    const active = item.id === page;
    if (active) canvas.put(1, 2 + index, '▌', {tone: 'accent'});
    canvas.row(2, 2 + index, [{
      text: item.label.padEnd(SIDEBAR - 2), style: active ? {tone: 'accent', bold: true} : undefined,
      action: {id: `nav:${item.id}`, label: 'Open page'},
    }], 'nav');
  });

  const content: Target[] = [];
  pageRows.forEach((row, index) => {
    let x = contentX;
    for (const item of row) {
      const size = textWidth(item.text);
      if (item.action) content.push({action: item.action, zone: 'content', x, y: index, width: size});
      x += size;
    }
  });
  pageRows.slice(scrollTop, scrollTop + viewport).forEach((row, index) => canvas.row(contentX, 2 + index, row, 'content'));
  if (maxScroll > 0 && viewport > 0) {
    const thumb = Math.max(1, Math.round(viewport * viewport / pageRows.length));
    const offset = Math.round(scrollTop / maxScroll * (viewport - thumb));
    for (let index = 0; index < viewport; index += 1) canvas.put(columns - 2, 2 + index, index >= offset && index < offset + thumb ? '█' : '░', frame);
  }
  if (state.notice) canvas.put(1, 3 + viewport, state.notice, {tone: 'warn'});

  const header = keyed(canvas.targets.filter((target) => target.zone === 'header'));
  const nav = keyed(canvas.targets.filter((target) => target.zone === 'nav'));
  const keyedContent = keyed(content);
  const everything = [...header, ...nav, ...keyedContent];
  let focused = everything.find((target) => target.key === state.focusId);
  if (!focused) {
    // The element is gone (page changed, a button swapped after a refresh): stay as close as possible.
    const at = state.focusAt;
    const wasContent = Boolean(state.focusId) && !state.focusId!.startsWith('nav:') && state.focusId !== 'session';
    focused = wasContent && at && keyedContent.length
      ? keyedContent.reduce((best, target) => Math.abs(target.y - at.y) * 1000 + Math.abs(target.x - at.x) < Math.abs(best.y - at.y) * 1000 + Math.abs(best.x - at.x) ? target : best)
      : nav.find((target) => target.key === `nav:${page}`) ?? nav[0];
  }

  let bar: BarItem[];
  if (state.overlay) {
    canvas.dim();
    const boxWidth = Math.max(20, Math.min(84, columns - 4));
    const box = dialog(state.overlay, boxWidth, Math.max(1, rows - 3));
    const left = Math.max(0, Math.floor((columns - boxWidth) / 2));
    const top = Math.max(0, Math.floor((rows - 1 - box.rows.length) / 2));
    box.rows.forEach((row, index) => {
      canvas.put(left, top + index, ' '.repeat(boxWidth));
      canvas.row(left, top + index, row, 'dialog');
    });
    const active = canvas.targets.find((target) => target.zone === 'dialog' && target.action.id === box.focus);
    if (active) canvas.highlight(active, color);
    bar = overlayBar(state.overlay);
  } else {
    if (focused) {
      const y = focused.zone === 'content' ? 2 + focused.y - scrollTop : focused.y;
      if (focused.zone !== 'content' || (y >= 2 && y < 2 + viewport)) canvas.highlight({...focused, y}, color);
    }
    bar = [
      {key: '↑↓←→', label: 'Move'}, {key: 'Tab', label: 'Next'},
      ...(focused ? [{key: 'Enter', label: focused.action.label}] : []),
      ...view.hotkeys.map((item) => ({key: item.key, label: item.label, actionId: item.actionId})),
      {key: `1-${pages.length}`, label: 'Page'}, {key: 'r', label: 'Reload', actionId: 'reload'},
      ...(state.demo ? [] : [{key: 'x', label: state.localConsole ? 'Switch user' : 'Sign out', actionId: 'session'}]),
      {key: '?', label: 'Help', actionId: 'help'}, {key: 'q', label: 'Quit', actionId: 'quit'},
    ];
  }

  // Footer: the hotkey bar. Entries with an action can also be clicked.
  let x = 1;
  for (const item of bar) {
    const size = textWidth(item.key) + 1 + textWidth(item.label);
    if (x + size > columns) break;
    canvas.put(x, rows - 1, item.key, {tone: 'accent', bold: true});
    canvas.put(x + textWidth(item.key) + 1, rows - 1, item.label, {tone: 'dim'});
    if (item.actionId) canvas.targets.push({action: {id: item.actionId, label: item.label}, zone: 'bar', x, y: rows - 1, width: size});
    x += size + 2;
  }

  if (state.pointer) canvas.pointer(state.pointer.x, state.pointer.y - banner.length, color);

  return {
    lines: [...banner, ...canvas.lines(color)].slice(0, height),
    top: banner.length, mouse: canvas.targets, header, nav, content: keyedContent, focused,
    hotkeys: view.hotkeys, page, scrollTop, maxScroll, viewport,
  };
};

export const renderTui = (snapshot: DashboardSnapshot, state: Partial<TuiViewState> = {}, width = 120, height = 36, color = true) =>
  composeTui(snapshot, initialViewState(state), width, height, color).lines.join('\n');

export type FocusDirection = 'up' | 'down' | 'left' | 'right' | 'next' | 'previous';

/** Scroll position that keeps a page row visible, with a little context above or below it. */
const revealRow = (layout: TuiLayout, y: number) => {
  if (y < layout.scrollTop) return Math.max(0, y - 3);
  if (y >= layout.scrollTop + layout.viewport) return Math.min(layout.maxScroll, y - layout.viewport + 3);
  return layout.scrollTop;
};

/**
 * Moves the cursor like focus in the browser: arrows go to the nearest element in
 * that direction, Tab walks in reading order. Returns the new element and scroll position.
 */
export const moveFocus = (layout: TuiLayout, direction: FocusDirection): {focusId?: string; scrollTop: number} => {
  const current = layout.focused;
  const stay = {focusId: current?.key, scrollTop: layout.scrollTop};
  const navActive = layout.nav.find((target) => target.key === `nav:${layout.page}`) ?? layout.nav[0];
  const toContent = (target?: FocusTarget) => target ? {focusId: target.key, scrollTop: revealRow(layout, target.y)} : undefined;
  const visible = (target: FocusTarget) => target.y >= layout.scrollTop && target.y < layout.scrollTop + layout.viewport;
  const firstVisible = layout.content.find(visible) ?? layout.content[0];
  if (!current) return {focusId: navActive?.key, scrollTop: layout.scrollTop};

  if (current.zone === 'header') {
    if (direction === 'next' || direction === 'down' || direction === 'left') return {focusId: navActive?.key, scrollTop: layout.scrollTop};
    if (direction === 'previous') return toContent(layout.content.at(-1)) ?? {focusId: navActive?.key, scrollTop: layout.scrollTop};
    return stay;
  }
  if (current.zone === 'nav') {
    const index = layout.nav.indexOf(current);
    if (direction === 'up') return index > 0 ? {focusId: layout.nav[index - 1]!.key, scrollTop: 0} : {focusId: layout.header[0]?.key ?? current.key, scrollTop: layout.scrollTop};
    if (direction === 'down') return {focusId: layout.nav[Math.min(layout.nav.length - 1, index + 1)]!.key, scrollTop: index < layout.nav.length - 1 ? 0 : layout.scrollTop};
    if (direction === 'right' || direction === 'next') return toContent(firstVisible) ?? (direction === 'next' && layout.header[0] ? {focusId: layout.header[0].key, scrollTop: layout.scrollTop} : stay);
    if (direction === 'previous') return {focusId: layout.header[0]?.key ?? current.key, scrollTop: layout.scrollTop};
    return stay;
  }

  const index = layout.content.indexOf(current);
  if (direction === 'next') return toContent(layout.content[index + 1]) ?? {focusId: layout.header[0]?.key ?? navActive?.key, scrollTop: layout.scrollTop};
  if (direction === 'previous') return toContent(layout.content[index - 1]) ?? {focusId: navActive?.key, scrollTop: layout.scrollTop};
  // After scrolling with the wheel or paging keys the cursor may be off screen: continue from what is visible.
  if (!visible(current) && firstVisible && visible(firstVisible)) return toContent(firstVisible)!;
  if (direction === 'left' || direction === 'right') {
    const row = layout.content.filter((target) => target.y === current.y);
    const neighbour = row[row.indexOf(current) + (direction === 'left' ? -1 : 1)];
    if (neighbour) return toContent(neighbour)!;
    return direction === 'left' ? {focusId: navActive?.key, scrollTop: layout.scrollTop} : stay;
  }
  const candidates = layout.content.filter((target) => direction === 'up' ? target.y < current.y : target.y > current.y);
  if (!candidates.length) {
    // Nothing left to select: scroll the rest of the page into view instead.
    return {focusId: current.key, scrollTop: Math.min(layout.maxScroll, Math.max(0, layout.scrollTop + (direction === 'up' ? -1 : 1)))};
  }
  const nearestRow = direction === 'up' ? Math.max(...candidates.map((target) => target.y)) : Math.min(...candidates.map((target) => target.y));
  const centre = current.x + current.width / 2;
  const best = candidates.filter((target) => target.y === nearestRow)
    .reduce((left, right) => Math.abs(right.x + right.width / 2 - centre) < Math.abs(left.x + left.width / 2 - centre) ? right : left);
  const moved = toContent(best)!;
  // Moving to the first element also brings the page heading back.
  return best === layout.content[0] && best.y < layout.viewport ? {...moved, scrollTop: 0} : moved;
};

export interface TuiOptions {
  color?: boolean;
  refreshSeconds?: number;
  demo?: boolean;
  /** Draw a mouse pointer and ask for movement reports: set on the appliance console, whose terminal shows none. */
  pointer?: boolean;
}

export const runTui = async (runtime: Runtime, options: TuiOptions = {}): Promise<TuiOutcome> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI needs an interactive terminal. Use CLI commands or --json for non-interactive use.');
  let snapshot = await loadSnapshot(runtime.api);
  const view = initialViewState();
  let layout: TuiLayout | undefined;
  let loading = false;
  let refreshError = '';
  let overlay: TuiOverlay | undefined;
  let finished = false;
  let outcome: TuiOutcome = 'quit';
  const color = options.color !== false;
  const animation = createBannerAnimation((frame) => {
    const rows = renderBanner(Math.min(usableColumns(process.stdout.columns ?? 100), MAX_CONTENT_COLUMNS), frame.elapsedMs, color, frame.seed);
    // Only repaint the banner, not forms or the entire dashboard, on a tick.
    process.stdout.write(`\x1b[H${rows.map((row) => `${row}\x1b[K`).join('\n')}`);
  }, () => !finished && bannerFits(process.stdout.rows ?? 30));

  let pointer: {x: number; y: number} | undefined;
  /** Repaints the whole screen, or only the given screen rows when just the pointer moved. */
  const draw = (onlyRows?: number[]) => {
    if (finished) return;
    layout = composeTui(snapshot, {
      ...view, overlay, pointer,
      demo: options.demo,
      banner: animation.frame,
      localConsole: runtime.localConsole,
      notice: refreshError ? `Refresh failed: ${refreshError}` : '',
    }, process.stdout.columns ?? 100, process.stdout.rows ?? 30, color);
    // Remember where the cursor ended up, so it survives refreshes and changed buttons.
    view.page = layout.page;
    view.scrollTop = layout.scrollTop;
    view.focusId = layout.focused?.key;
    view.focusAt = layout.focused?.zone === 'content' ? {x: layout.focused.x, y: layout.focused.y} : undefined;
    if (onlyRows) {
      // The banner repaints itself; only rows below it can show the pointer.
      const frame = layout;
      const rows = [...new Set(onlyRows)].filter((row) => row >= frame.top && row < frame.lines.length);
      if (rows.length) process.stdout.write(rows.map((row) => `\x1b[${row + 1};1H${frame.lines[row]}\x1b[K`).join(''));
      return;
    }
    process.stdout.write(`\x1b[H${layout.lines.map((row) => `${row}\x1b[K`).join('\n')}\x1b[J`);
  };
  const redraw = () => draw();
  const refresh = async () => {
    if (loading || overlay) return;
    loading = true;
    try {
      snapshot = await loadSnapshot(runtime.api);
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
  const openLocalModelForm = (runtimeValue: string) => {
    const [engine = '', computeTarget = ''] = runtimeValue.split('\u001f');
    const target = snapshot.models.computeTargets.targets.find((item) => item.id === computeTarget && item.available && item.engines?.includes(engine));
    if (!target) return message('Runtime unavailable', 'The selected runtime and hardware combination is no longer available.', 'error');
    const kvCacheChoices = target.kvCacheTypes?.[engine] ?? (engine === 'OLlama'
      ? [{value: 'f16', label: 'Standard - F16'}]
      : [{value: 'auto', label: 'Standard - model precision'}]);
    openForm('Add local model', `${engine} / ${target.displayName ?? target.id}. Enter a direct model reference; leave the reservation empty to use the calculated recommendation.`, [
      {id: 'name', label: 'Name', value: '', required: true},
      {id: 'modelType', label: 'Type', value: 'chat', kind: 'choice', choices: [{value: 'chat', label: 'Chat'}, {value: 'embedding', label: 'Embedding'}]},
      {id: 'reference', label: 'Model reference', value: '', required: true, hint: 'hf://publisher/model or ollama://model:tag'},
      {id: 'contextWindow', label: 'Context size', value: '4096', required: true},
      {id: 'kvCacheType', label: 'KV cache', value: kvCacheChoices[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto'), kind: 'choice', choices: kvCacheChoices, required: true},
      {id: 'maxNumSeqs', label: 'Max sequences', value: '1', required: true},
      {id: 'reservationMi', label: 'RAM/VRAM reservation MiB', value: '', hint: 'automatic recommendation'},
      {id: 'cpuOffloading', label: 'Use additional system RAM', value: 'false', kind: 'choice', choices: [{value: 'false', label: 'No'}, {value: 'true', label: 'Yes (NVIDIA GPU only)'}], hint: 'May substantially reduce inference speed.'},
      {id: 'hostMemoryMi', label: 'Additional host RAM budget MiB', value: '', hint: 'offloading + runtime; empty = recommendation'},
    ], 'create model', async (values) => {
      const liveTarget = snapshot.models.computeTargets.targets.find((item) => item.id === computeTarget && item.available && item.engines?.includes(engine));
      if (!liveTarget) throw new Error('The selected runtime and hardware combination is no longer available.');
      if (!kvCacheChoices.some((item) => item.value === values.kvCacheType)) throw new Error('The selected KV cache is not compatible with this runtime and hardware.');
      const contextWindow = positiveInteger(values.contextWindow ?? '', 'Context size');
      const maxNumSeqs = positiveInteger(values.maxNumSeqs ?? '', 'Max sequences');
      const cpuOffloading = values.cpuOffloading === 'true';
      if (cpuOffloading && computeTarget !== 'nvidia-gpu') throw new Error('CPU offloading currently supports NVIDIA GPU models only.');
      await perform(`Create model ${values.name}`, async () => {
        const estimate = await runtime.api.estimateMemory({engine, computeTarget, url: values.reference, contextWindow, maxNumSeqs, modelType: values.modelType, kvCacheType: values.kvCacheType});
        let displayEstimate = estimate;
        const reservationMi = values.reservationMi?.trim()
          ? positiveInteger(values.reservationMi, 'RAM/VRAM reservation')
          : cpuOffloading && estimate.maximumMi != null
            ? Math.max(100, Math.min(roundMemory(estimate.recommendedMi), Math.floor(estimate.maximumMi / 100) * 100))
            : roundMemory(estimate.recommendedMi);
        let hostMemoryMi: number | undefined;
        if (cpuOffloading) {
          const split = await runtime.api.estimateMemory({engine, computeTarget, url: values.reference, contextWindow, maxNumSeqs, modelType: values.modelType, kvCacheType: values.kvCacheType, cpuOffloading: true, vramMi: reservationMi});
          const plan = split.offloading;
          displayEstimate = split;
          if (!plan?.fitsVram) throw new Error('VRAM is too small for remaining GPU weights, KV cache and runtime. Increase VRAM or reduce context.');
          hostMemoryMi = values.hostMemoryMi?.trim() ? positiveInteger(values.hostMemoryMi, 'Host RAM budget') : roundMemory(plan.ramRecommendedMi);
          if (plan.ramMaximumMi == null || hostMemoryMi < plan.ramMinimumMi || hostMemoryMi > plan.ramMaximumMi) throw new Error('The host RAM budget must cover offloading and runtime and fit on an eligible GPU node.');
        }
        const input: LocalModelInput = {
          name: values.name ?? '', modelType: values.modelType ?? 'chat', engine, computeTarget,
          reference: values.reference ?? '', contextWindow, maxNumSeqs, kvCacheType: values.kvCacheType ?? '', reservationMi, cpuOffloading, hostMemoryMi,
        };
        await runtime.api.createLocalModel(buildLocalModelPayload(input, liveTarget));
        return {lines: [
          `${input.name} was requested on ${target.displayName ?? target.id} with ${engine}.`,
          `Reservation: ${formatMi(reservationMi)}; estimate: ${formatMi(displayEstimate.minimumMi)} minimum / ${formatMi(displayEstimate.recommendedMi)} recommended.`,
          ...(cpuOffloading ? [`Additional host RAM reserved: ${formatMi(hostMemoryMi)}. The RAM/VRAM split is estimated, not measured.`] : []),
        ]};
      });
    });
  };
  const addLocalModel = () => {
    const choices = runtimeChoices();
    if (!choices.length) return message('No local runtime available', 'No inference-engine and compute-target combination is currently available.', 'error');
    if (choices.length === 1) return openLocalModelForm(choices[0]!.value);
    overlay = {kind: 'menu', title: 'Choose local runtime', description: 'KV cache choices are filtered for the selected engine and hardware.', active: 0, options: choices.map((choice) => ({
      label: choice.label,
      action: () => openLocalModelForm(choice.value),
    }))};
    draw();
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

  const editConsoleAccess = () => {
    const access = snapshot.consoleAccess;
    if (!access?.available) return message('Automatic sign-in unavailable', 'This appliance has not provisioned automatic sign-in for its monitor yet. It appears after the next platform update.');
    openForm('Monitor sign-in', 'Access of the attached monitor and keyboard without a login. Off requires a user sign-in from a second device. Changes apply immediately; a lower level can only be raised again by a signed-in administrator.', [
      {id: 'accessLevel', label: 'Automatic sign-in', value: access.accessLevel, kind: 'choice', choices: CONSOLE_ACCESS_LEVELS.map((value) => ({value, label: consoleAccessLabel(value)}))},
    ], 'save', async (values) => {
      const level = values.accessLevel as ConsoleAccessLevel;
      if (level === access.accessLevel) throw new Error('This level is already active.');
      await perform('Change monitor sign-in', async () => {
        await runtime.api.updateConsoleAccess(level);
        return {lines: [`Automatic sign-in of the appliance monitor: ${consoleAccessLabel(level)}.`]};
      });
    });
  };

  const hardwareAction = (verb: string) => {
    const compatibility = snapshot.status.hardwareOperators?.['amd-gpu']?.compatibility;
    if (!compatibility) return message('Hardware catalog unavailable', 'The server has not reported GPU compatibility profiles yet. Refresh after the controller update.');
    const apply = async (parameters: Record<string, string>) => perform('GPU compatibility', async () => {
      await runtime.api.enableModule('amd-gpu', parameters);
      return {lines: ['Hardware configuration saved. GPU use requires host readiness and GPU registration. Optional engine tests run only when requested manually.']};
    });
    if (verb === 'profile') openForm('AMD compatibility profile', 'Experimental profiles require explicit acceptance. Selection affects matching nodes only and does not certify inference.', [
      {id: 'profile', label: 'Profile', value: compatibility.selectedProfile ?? '', kind: 'choice', choices: [{value: '', label: 'Upstream operator rules only'}, ...compatibility.profiles.map((profile) => ({value: profile.id, label: `${profile.displayName} ${profile.version}${profile.experimental ? ' (experimental)' : ''}`}))]},
      {id: 'acknowledge', label: 'Accept experimental profile limitations', value: 'false', kind: 'choice', choices: [{value: 'false', label: 'No'}, {value: 'true', label: 'Yes, explicitly opt in'}]},
    ], 'save', async (values) => apply(gpuCompatibilityParameters(values.profile ?? '', compatibility.profiles, values.acknowledge === 'true')));
    else if (verb === 'upstream') openConfirm('Return to upstream rules', 'Remove the custom GPU compatibility profile. Existing models may lose GPU eligibility. This does not uninstall the host driver.', 'use upstream', async () => apply(gpuCompatibilityParameters('', compatibility.profiles, false)));
    else if (verb === 'validate') {
      if (!compatibility.selectedProfile) return message('Select a profile first', 'GPU validation requires a saved compatibility profile.');
      openConfirm('Run GPU validation', 'Optional diagnostic: the profile tests may download images and use GPU resources. Results do not block GPU use; this is not a full model quality benchmark.', 'run tests', async () => {
        const parameters = gpuCompatibilityParameters(compatibility.selectedProfile ?? '', compatibility.profiles, compatibility.allowExperimental === true);
        parameters.validationRequest = `tui-${Date.now()}-${crypto.randomUUID()}`;
        await apply(parameters);
      });
    }
  };
  const importLicense = () => openForm('Import license', 'Enter a local license file path. Validation does not replace the current license.', [
    {id: 'file', label: 'License file', value: '', required: true},
  ], 'inspect', async (values) => {
    try {
      const document = await readLicenseFile(values.file ?? '');
      const preview = await runtime.api.inspectLicense(document);
      if (!preview.candidate.valid) return message('License rejected', preview.candidate.message, 'error');
      openConfirm('Activate license', [...previewLines(preview), 'Replace previous entitlements? Missing features stay unavailable.'].join('\n'), 'activate', async () => {
        await perform('Activate license', async () => {
          await runtime.api.importLicense(document, preview.current.revision);
          return {lines: ['License saved persistently. Federated SSO availability follows the active license.']};
        });
      });
    } catch (error) { message('License inspection failed', errorText(error), 'error'); }
  });
  const exportLicense = () => openForm('Export license', 'Choose a new file path. Existing files are never overwritten.', [
    {id: 'file', label: 'Output file', value: '', required: true},
  ], 'export', async (values) => {
    await perform('Export license', async () => {
      const result = await runtime.api.exportLicense();
      await saveLicenseFile(values.file ?? '', result.content);
      return {lines: ['License exported with private file permissions.']};
    });
  });

  /** Loads something to read (credentials, an access policy) behind a busy dialog, without a "completed" message. */
  const load = async <T,>(title: string, fetch: () => Promise<T>, then: (value: T) => void) => {
    if (loading) return;
    loading = true;
    overlay = {kind: 'busy', title, description: 'Loading…'};
    draw();
    try {
      const value = await fetch();
      loading = false;
      overlay = undefined;
      then(value);
    } catch (error) {
      loading = false;
      overlay = {kind: 'message', title: 'Could not load', lines: [errorText(error)], tone: 'error'};
    }
    draw();
  };
  const showCredentials = (label: string, fetch: () => Promise<{title?: string; credentials?: Array<{key: string; value: string}>}>) =>
    load(`Credentials · ${label}`, fetch, (result) => message(`Credentials · ${result.title ?? label}`, [
      'Sensitive values are shown only on request. Close this dialog when you are done.',
      ...((result.credentials ?? []).length ? (result.credentials ?? []).map((entry) => `${entry.key}: ${entry.value}`) : ['No credentials are stored.']),
    ]));

  const applicationOptions = () => {
    const catalog = snapshot.modules.catalogJson?.modules ?? {};
    return Object.entries(snapshot.modules.catalogJson?.applications ?? {}).map(([id, definition]) => ({
      id, label: definition.displayName ?? titleFromKey(id),
      missing: missingApplicationModules(definition, snapshot.modules.modules ?? {}, catalog).map((module) => catalog[module]?.displayName ?? titleFromKey(module)),
    })).sort((left, right) => left.label.localeCompare(right.label));
  };
  const openInstanceForm = (type: string, label: string) => {
    const models = deployedChatModels(snapshot);
    const yesNo = [{value: 'true', label: 'Yes'}, {value: 'false', label: 'No'}];
    const gateway = (kind: string) => [{value: '', label: 'Off'}, ...flattenInstances(snapshot.instances)
      .filter((item) => item.type === kind && item.value.spec?.enabled !== false && String(item.value.status?.phase ?? '').toLowerCase() !== 'removing')
      .map((item) => ({value: item.name, label: item.name}))];
    const draft = initialInstanceDraft(type, models[0] ?? '');
    openForm(`New ${label} instance`, 'Only the values this application supports are shown. Sharing with selected users can be set afterwards.', [
      {id: 'name', label: 'Name', value: draft.name, required: true, hint: 'lowercase letters, digits, hyphens'},
      ...(instanceModelRequired(type) ? [{id: 'model', label: type === 'paperclip' ? 'Default model' : 'Model', value: draft.model, kind: 'choice' as const, choices: models.map((value) => ({value, label: value}))}] : []),
      ...(type === 'paperclip' ? [{id: 'adminEmail', label: 'Admin email', value: draft.adminEmail, required: true}] : []),
      ...(type === 'kubeopencode' ? [{id: 'template', label: 'Template', value: draft.template, required: true}] : []),
      {id: 'authentication', label: 'Access', value: draft.authentication, kind: 'choice', choices: [{value: 'sso', label: 'SSO protected'}, {value: 'none', label: 'Public without login'}]},
      {id: 'role', label: 'Minimum role', value: draft.role, kind: 'choice', choices: [{value: 'user', label: 'Authenticated user'}, {value: 'viewer', label: 'Viewer'}, {value: 'operator', label: 'Operator'}, {value: 'admin', label: 'Administrator'}]},
      {id: 'exposure', label: 'Exposure', value: draft.exposure, kind: 'choice', choices: [{value: 'localAndPublic', label: 'Local and public hosts'}, {value: 'local', label: 'Local host only'}]},
      ...(instanceHasStorage(type) ? [{id: 'storage', label: 'Storage', value: draft.storage, required: true}] : []),
      ...(type === 'paperclip' ? [
        {id: 'postgresStorage', label: 'Postgres storage', value: draft.postgresStorage, required: true},
        {id: 'maxConcurrentAgents', label: 'Parallel agents (1-10)', value: String(draft.maxConcurrentAgents), required: true},
        {id: 'openCodeEnabled', label: 'OpenCode runtime', value: 'true', kind: 'choice' as const, choices: yesNo},
        {id: 'openClawInstanceRef', label: 'OpenClaw gateway', value: '', kind: 'choice' as const, choices: gateway('openclaw')},
        {id: 'hermesInstanceRef', label: 'Hermes gateway', value: '', kind: 'choice' as const, choices: gateway('hermes')},
      ] : []),
      ...(type === 'odysseus' ? [
        {id: 'chromaStorage', label: 'Chroma storage', value: draft.chromaStorage, required: true},
        {id: 'searxngStorage', label: 'SearXNG storage', value: draft.searxngStorage, required: true},
        {id: 'ntfyStorage', label: 'ntfy storage', value: draft.ntfyStorage, required: true},
      ] : []),
    ], 'create instance', async (values) => {
      const application = applicationOptions().find((item) => item.id === type);
      if (!application || application.missing.length) throw new Error('The required services of this application are no longer ready.');
      const next = {
        ...draft, ...values,
        maxConcurrentAgents: type === 'paperclip' ? positiveInteger(values.maxConcurrentAgents ?? '', 'Parallel agents') : draft.maxConcurrentAgents,
        openCodeEnabled: values.openCodeEnabled !== 'false',
        openClawEnabled: Boolean(values.openClawInstanceRef), hermesEnabled: Boolean(values.hermesInstanceRef),
      };
      await perform(`Create ${label} instance`, async () => {
        // The hostname follows the configured domain; only administrators have it in the snapshot.
        const domain = snapshot.settings?.publicDomain ?? (await runtime.api.settings().catch(() => undefined))?.publicDomain ?? '';
        await runtime.api.createInstance(type, instanceCreatePayload(next, domain));
        return {lines: [`${label} instance ${next.name} was requested. It appears under Services while the operator sets it up.`]};
      });
    });
  };
  const createInstance = (type?: string) => {
    if (!deployedChatModels(snapshot).length) return message('No chat model available', 'Add a chat model first: applications need a deployed chat model.');
    const applications = applicationOptions();
    const direct = applications.find((item) => item.id === type);
    if (direct && !direct.missing.length) return openInstanceForm(direct.id, direct.label);
    if (!applications.some((item) => !item.missing.length)) return message('No application available', 'No application has all of its required services ready.');
    overlay = {kind: 'menu', title: 'Create Instance', description: 'Choose an application.', active: Math.max(0, applications.findIndex((item) => !item.missing.length)), options: applications.map((item) => ({
      label: item.label,
      disabled: Boolean(item.missing.length),
      hint: item.missing.length ? `required services are not ready: ${item.missing.join(', ')}` : undefined,
      action: () => openInstanceForm(item.id, item.label),
    }))};
    draw();
  };
  const removeInstance = (name: string) => openConfirm(`Remove ${name}`, `Remove ${name}? Its reconciled application resources will be removed by the operator.`, 'remove', async () => {
    await perform(`Remove instance ${name}`, async () => {
      await runtime.api.removeInstance(name);
      return {lines: [`Removal of ${name} was requested.`]};
    });
  });

  /** Sharing editor: a menu that is reopened after every change until the policy is saved. */
  const sharingMenu = (access: InstanceAccessState, sharing: InstanceSharing, names: Map<string, string>, active = 0) => {
    const usable = access.guardReady && access.authentication === 'sso';
    const blocked = !access.guardReady ? 'the access guard is still being prepared; wait until the instance is ready'
      : access.authentication !== 'sso' ? 'this instance is public without login; selected users need SSO' : undefined;
    const changed = JSON.stringify(sharing) !== JSON.stringify(access.sharing);
    const nameOf = (kind: 'users' | 'groups', id: string) => names.get(`${kind}:${id}`) ?? access.principals?.[kind].find((item) => item.id === id)?.name ?? id;
    const reopen = (next: InstanceSharing, index = 0) => sharingMenu(access, next, names, index);
    const search = (kind: 'users' | 'groups') => openForm(`Add ${kind === 'users' ? 'user' : 'group'}`, 'Search the directory. Leave the name empty to list the first entries.', [
      {id: 'search', label: 'Name', value: ''},
    ], 'search', async (values) => load('Searching directory', () => runtime.api.instancePrincipals(kind, values.search ?? ''), (result) => {
      const selected = sharing[kind] ?? [];
      overlay = {kind: 'menu', title: `Add ${kind === 'users' ? 'user' : 'group'}`, description: result.items.length ? 'Choose an entry to add.' : 'No matching entries. Groups are managed in Keycloak.', active: 0, options: [
        ...result.items.map((entry) => ({
          label: entry.name, disabled: selected.includes(entry.id) || selected.length >= 100,
          hint: selected.includes(entry.id) ? 'already selected' : undefined,
          action: () => {
            names.set(`${kind}:${entry.id}`, entry.name);
            reopen({...sharing, [kind]: [...selected, entry.id]});
          },
        })),
        {label: 'Back', action: () => reopen(sharing)},
      ]};
    }));
    const selectedRows = (kind: 'users' | 'groups') => (sharing[kind] ?? []).map((id) => ({
      label: `${kind === 'users' ? 'User' : 'Group'} ${nameOf(kind, id)}`, hint: 'remove from the list',
      action: () => reopen({...sharing, [kind]: (sharing[kind] ?? []).filter((item) => item !== id)}, 0),
    }));
    const summary = sharing.mode === 'all' ? 'All users with the required role will be able to see and use this instance.'
      : !sharing.users?.length && !sharing.groups?.length ? 'No one can use this instance until at least one user or group is selected.'
        : `Only these will be able to see and use this instance: ${[...(sharing.users ?? []).map((id) => nameOf('users', id)), ...(sharing.groups ?? []).map((id) => `group ${nameOf('groups', id)}`)].join(', ')}. Subgroups are included and the minimum role still applies.`;
    const options: MenuOption[] = [
      {
        label: `Visible to: ${sharing.mode === 'all' ? 'all users with the required role' : 'selected users or groups'}`, hint: blocked ?? 'change', disabled: !usable,
        action: () => reopen(sharing.mode === 'all' ? {mode: 'selected', users: [], groups: []} : {mode: 'all', users: [], groups: []}),
      },
      ...(sharing.mode === 'selected' && usable ? [
        ...selectedRows('users'), ...selectedRows('groups'),
        {label: 'Add user…', action: () => search('users')},
        {label: 'Add group…', action: () => search('groups')},
      ] : []),
      {
        label: 'Save sharing', disabled: !usable || !changed, hint: !usable ? blocked : changed ? undefined : 'no changes to save',
        action: () => openConfirm(`Save sharing for ${access.name}`, summary, 'save sharing', async () => {
          await perform(`Save sharing for ${access.name}`, async () => {
            await runtime.api.updateInstanceAccess(access.name, sharing, access.revision);
            return {lines: [`Sharing for ${access.name} was saved.`]};
          });
        }),
      },
    ];
    overlay = {kind: 'menu', title: `Sharing · ${access.name}`, description: 'Administrators retain the management view. App access and instance credentials still require an explicit grant.', options, active: Math.min(active, options.length - 1)};
    draw();
  };
  const editSharing = (name: string) => load(`Sharing · ${name}`, () => runtime.api.instanceAccess(name),
    (access) => sharingMenu(access, {mode: access.sharing.mode, users: [...(access.sharing.users ?? [])], groups: [...(access.sharing.groups ?? [])]}, new Map()));

  const modelLifecycle = (activation: ModelActivation, action: 'start' | 'stop' | 'restart') => {
    const name = activation.metadata?.name ?? '';
    const external = activation.spec?.type === 'external';
    const run = async () => perform(`${capitalize(action)} ${name}`, async () => {
      await runtime.api.request(`/api/models/${encodeURIComponent(name)}/${action}`, {method: 'POST', body: JSON.stringify({expectedRevision: modelEditRevision(activation)})});
      return {lines: [action === 'start' ? `${name} is starting with its saved settings.` : action === 'stop' ? `Stop requested for ${name}. Its saved settings are kept.` : `Restart requested for ${name}.`]};
    });
    if (action === 'start') return void run();
    openConfirm(`${capitalize(action)} ${name}`, action === 'restart' ? 'The model runtime is restarted. Requests fail until it is ready again.'
      : external ? 'This provider route is stopped in Magic Stick. The remote provider itself is not shut down. Saved settings are kept.'
        : 'The model is stopped and its runtime resources are released. Requests to it fail until it is started again. Saved settings are kept.', action, run);
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
    process.stdout.off('resize', redraw);
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    process.off('SIGHUP', cleanup);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${MOUSE_OFF}${SHOW_CURSOR}${NORMAL_SCREEN}`);
    finish?.();
  };

  const sessionAction = () => {
    if (options.demo) return message('Offline demo', 'No session is stored or changed in demo mode. Press q to quit.');
    const leave = (next: TuiOutcome) => {
      outcome = next;
      cleanup();
    };
    const kind = runtime.sessionKind();
    if (runtime.localConsole && kind === 'console') {
      openConfirm('Sign in as another user', 'This monitor is signed in automatically. To act as a different user, a one-time code is shown that you confirm in a browser on a second device. You can cancel and return here at any time.', 'continue', async () => leave('switch-user'));
    } else if (runtime.localConsole && kind === 'user') {
      overlay = {kind: 'menu', title: 'Switch user', description: `Signed in as ${sessionDisplayName(snapshot.session)}.`, active: 0, options: [
        {label: 'Return to the automatic monitor session', hint: 'removes this user login', action: () => void runtime.logout().then(() => leave('restart-session'), (error) => message('Could not sign out', errorText(error), 'error'))},
        {label: 'Sign in as another user', hint: 'needs a second device', action: () => leave('switch-user')},
      ]};
      draw();
    } else {
      openConfirm('Sign out', 'The locally cached SSO session is removed. A new device login is needed afterwards.', 'sign out', async () => {
        await runtime.logout();
        cleanup();
      });
    }
  };
  const showHelp = () => message('Keyboard and mouse', [
    'Arrow keys (or h j k l) move the cursor to the nearest element. Tab and Shift+Tab walk through all elements in reading order.',
    'Enter or Space uses the element under the cursor: opens a page, presses a button, expands a section.',
    'Left from the page returns to the page list; there, Up and Down switch pages and Right enters the page.',
    'Page Up, Page Down, Home and End scroll long pages. The number keys open a page directly.',
    'With a mouse: click any element or footer entry, and use the wheel to scroll. Hold Shift to select text with the terminal.',
    'The footer always lists the keys that work right now.',
  ]);

  const openPage = (page: PageId) => {
    view.page = page;
    view.scrollTop = 0;
    view.focusId = `nav:${page}`;
  };
  const cycle = <T,>(items: T[], current: T) => items[(items.indexOf(current) + 1) % items.length] ?? current;
  const missing = () => message('No longer available', 'This item has changed in the meantime. The view shows the current state.');

  /** Runs what a button, link, page entry or hotkey stands for. */
  const activate = (action: Action) => {
    const id = action.id;
    if (action.disabled) return message('Not available', action.disabled);
    if (id === 'quit') return cleanup();
    if (id === 'reload') return void refresh();
    if (id === 'help') return showHelp();
    if (id === 'session') return sessionAction();
    if (id.startsWith('nav:')) {
      openPage(id.slice(4) as PageId);
      return draw();
    }
    if (id.startsWith('section:')) {
      const sections = availableSystemSections(snapshot).map((item) => item.id);
      const next = id.slice(8);
      view.systemSection = next === 'next' ? cycle(sections, activeSystemSection(snapshot, view.systemSection)) : next as typeof view.systemSection;
      view.scrollTop = 0;
      return draw();
    }
    if (id.startsWith('filter:')) {
      const next = id.slice(7);
      view.serviceFilter = next === 'next' ? cycle(SERVICE_FILTERS.map((item) => item.id), view.serviceFilter) : next as typeof view.serviceFilter;
      return draw();
    }
    if (id.startsWith('expand:')) {
      const key = id.slice(7);
      view.expanded[key] = !(view.expanded[key] ?? false);
      return draw();
    }
    if (id.startsWith('link:')) return message('Address', [id.slice(5), 'Open this address in a browser on a device in the same network.'], 'normal', id.slice(5));

    if (options.demo) return message('Offline demo', 'This preview is read-only. Live actions require an appliance connection.');
    const [scope = '', verb = '', ...rest] = id.split(':');
    const target = rest.join(':');
    if (['service', 'model', 'instance'].includes(scope) && !canMutateRuntime(snapshot.session)) return message('Read-only session', 'Operator or administrator access is required for this action.', 'error');
    if (['console', 'user', 'apikey', 'k8s', 'license', 'hardware'].includes(scope) && !canAdminister(snapshot.session)) return message('Administrator access required', 'This action is restricted to Magic Stick administrators.', 'error');

    if (scope === 'service') {
      const state = snapshot.modules.modules?.[target];
      if (!state) return missing();
      const entity = {kind: 'service' as const, id: target, state, catalog: snapshot.modules.catalogJson?.modules?.[target]};
      if (verb === 'credentials') return void showCredentials(entity.catalog?.displayName ?? titleFromKey(target), () => runtime.api.moduleCredentials(target));
      return verb === 'enable' ? enableService(entity) : disableService(entity);
    }
    if (scope === 'instance') {
      if (verb === 'create') return createInstance(target || undefined);
      if (!flattenInstances(snapshot.instances).some((item) => item.name === target)) return missing();
      if (verb === 'credentials') return void showCredentials(target, () => runtime.api.instanceCredentials(target));
      if (verb === 'sharing') return canAdminister(snapshot.session) ? void editSharing(target) : message('Administrator access required', 'This action is restricted to Magic Stick administrators.', 'error');
      return removeInstance(target);
    }
    if (scope === 'model') {
      if (verb === 'add') return addModel();
      const activation = (snapshot.models.activations ?? []).find((item) => item.metadata?.name === target);
      if (!activation) return missing();
      if (verb === 'start' || verb === 'stop' || verb === 'restart') return modelLifecycle(activation, verb);
      return removeModel({kind: 'model', id: target, activation});
    }
    if (scope === 'apikey') {
      if (verb === 'create') return createApiKey();
      const item = (snapshot.apiAccess?.items ?? []).find((entry) => entry.id === target);
      return item ? revokeApiKey({kind: 'api-key', id: target, item}) : missing();
    }
    if (scope === 'k8s') {
      const user = (snapshot.kubernetesAccess?.users ?? []).find((entry) => entry.id === target);
      if (!user) return missing();
      const entity = {kind: 'kubernetes' as const, id: target, user};
      if (verb === 'access') return editKubernetesAccess(entity);
      if (verb === 'revoke') return revokeKubernetesAccess(entity);
      return void copyKubeconfig(entity);
    }
    if (scope === 'user') {
      if (verb === 'create') return createUser();
      const user = (snapshot.users?.users ?? []).find((entry) => entry.id === target);
      if (!user) return missing();
      if (verb === 'profile') return editUserProfile(user);
      if (verb === 'access') return editUserRole(user);
      if (verb === 'toggle') return toggleUser(user);
      if (verb === 'password') return resetUserPassword(user);
      return deleteUser({kind: 'user', id: target, user});
    }
    if (scope === 'license') return verb === 'import' ? importLicense() : exportLicense();
    if (scope === 'hardware') return hardwareAction(verb);
    if (scope === 'console') return editConsoleAccess();
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
      } else if (key === '\r' || key === '\n' || key === ' ') {
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
  /** A click inside a dialog does what the matching key does. */
  const handleDialogClick = (id: string, current: TuiOverlay) => {
    if (id === 'dlg:close' || id === 'dlg:confirm') return handleOverlayInput('\r', current);
    if (id === 'dlg:cancel') return handleOverlayInput('\u001b', current);
    if (id === 'dlg:copy') return handleOverlayInput('c', current);
    if (id === 'dlg:submit') return handleOverlayInput('\u0013', current);
    const index = Number(id.split(':')[2]);
    if (id.startsWith('dlg:option:') && current.kind === 'menu') {
      current.active = moveSelection(index, 0, current.options.length);
      return handleOverlayInput('\r', current);
    }
    if (id.startsWith('dlg:field:') && current.kind === 'form') {
      const already = current.active === index;
      current.active = moveSelection(index, 0, current.fields.length);
      // Clicking the selected choice again steps to its next value.
      if (already && current.fields[index]?.kind === 'choice') return handleOverlayInput(' ', current);
      draw();
    }
  };

  const scrollBy = (rows: number) => {
    if (!layout) return;
    view.scrollTop = Math.min(layout.maxScroll, Math.max(0, layout.scrollTop + rows));
  };
  const focus = (direction: FocusDirection) => {
    if (!layout) return;
    const moved = moveFocus(layout, direction);
    view.focusId = moved.focusId;
    view.scrollTop = moved.scrollTop;
    // In the page list the cursor is the selection: moving it opens that page.
    if (moved.focusId?.startsWith('nav:') && moved.focusId !== `nav:${view.page}`) openPage(moved.focusId.slice(4) as PageId);
  };
  const handleMouse = (event: MouseEvent) => {
    if (options.pointer) {
      const previous = pointer;
      pointer = {x: event.x, y: event.y};
      // Bit 5 marks a movement report: only the pointer changed, so repaint just its old and new row.
      if (event.button & 32) return draw([previous?.y ?? event.y, event.y]);
    }
    if (!event.pressed || !layout) return;
    if (event.button === 64 || event.button === 65) {
      const direction = event.button === 64 ? -1 : 1;
      if (overlay?.kind === 'menu') overlay.active = moveSelection(overlay.active, direction, overlay.options.length);
      else if (overlay?.kind === 'form') overlay.active = moveSelection(overlay.active, direction, overlay.fields.length);
      else if (!overlay) scrollBy(direction * 3);
      return draw();
    }
    if (event.button !== 0) return;
    const target = hitTarget(layout.mouse, event.x, event.y - layout.top);
    if (!target) return;
    if (overlay) {
      if (target.zone === 'dialog' || target.action.id.startsWith('dlg:')) handleDialogClick(target.action.id, overlay);
      return;
    }
    if (target.zone !== 'bar') {
      const pool = target.zone === 'content' ? layout.content : target.zone === 'nav' ? layout.nav : layout.header;
      const y = target.zone === 'content' ? target.y - 2 + layout.scrollTop : target.y;
      view.focusId = pool.find((item) => item.x === target.x && item.y === y)?.key ?? view.focusId;
    }
    activate(target.action);
    draw();
  };
  const handleBrowseInput = (key: string) => {
    if (key === 'q') return cleanup();
    if (key === 'x') return sessionAction();
    if (key === 'r') return void refresh();
    if (key === '?') return showHelp();
    const pages = availablePages(snapshot);
    const hotkey = layout?.hotkeys.find((item) => item.key === key);
    if (key === '\u001b[A' || key === 'k') focus('up');
    else if (key === '\u001b[B' || key === 'j') focus('down');
    else if (key === '\u001b[D' || key === 'h') focus('left');
    else if (key === '\u001b[C' || key === 'l') focus('right');
    else if (key === '\t') focus('next');
    else if (key === '\u001b[Z') focus('previous');
    else if (key === '\u001b[5~') scrollBy(-Math.max(1, (layout?.viewport ?? 2) - 1));
    else if (key === '\u001b[6~') scrollBy(Math.max(1, (layout?.viewport ?? 2) - 1));
    else if (key === '\u001b[H' || key === '\u001b[1~') scrollBy(-Infinity);
    else if (key === '\u001b[F' || key === '\u001b[4~') scrollBy(Infinity);
    else if (key === '\u001b') view.focusId = `nav:${view.page}`;
    else if (/^[1-9]$/.test(key) && pages[Number(key) - 1]) openPage(pages[Number(key) - 1]!.id);
    else if ((key === '\r' || key === '\n' || key === ' ') && layout?.focused) return activate(layout.focused.action);
    else if (hotkey) return activate({id: hotkey.actionId, label: hotkey.label});
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
      const mouse = parseMouse(key);
      if (mouse) handleMouse(mouse);
      else if (overlay) handleOverlayInput(key, overlay);
      else handleBrowseInput(key);
    }
  };

  process.stdout.write(`${ALT_SCREEN}${HIDE_CURSOR}${MOUSE_ON}${options.pointer ? MOUSE_MOTION_ON : ''}${CLEAR}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdin.once('end', cleanup);
  process.stdout.on('resize', redraw);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('SIGHUP', cleanup);
  timer = setInterval(() => void refresh(), Math.max(5, options.refreshSeconds ?? 15) * 1000);
  animation.start();
  draw();
  await new Promise<void>((resolve) => { finish = resolve; });
  return outcome;
};
