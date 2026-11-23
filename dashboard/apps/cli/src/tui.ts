import {
  canAdminister,
  canMutateRuntime,
  dashboardRole,
  sessionDisplayName,
} from '@magicstick/dashboard-core';
import type {DashboardSnapshot, ExtraKey} from './snapshot';
import {loadSnapshot} from './snapshot';
import type {Runtime} from './runtime';
import {truncate} from './output';
import {bannerFits, createBannerAnimation, renderBanner, type BannerFrame} from './banner';
import {
  activeMeshTab, activeSettingsSection, activeStatusSection, activeSystemSection, AREA_MODULES, availablePages,
  availableSettingsSections, availableStatusSections, availableSystemSections, buildPage, dataNeeds, initialPageState, meshTabs, queryOptions,
  SERVICE_FILTERS, type Hotkey, type PageId, type PageState, type PageView,
} from './tui-pages';
import type {ActionRequest, ConfirmOptions, PerformResult, TuiContext} from './tui-context';
import {
  dialogFocus, dialogFocusIds, findDialogItem, formDialog, overlayBar, renderOverlay,
  type BarItem, type DialogItem, type InlineButton, type TuiOverlay,
} from './tui-dialogs';
import {createFileAccess, openFile, saveAs} from './tui-files';
import {
  badge, button, Canvas, fit, hitTarget, span, textWidth,
  type Action, type Row, type Target,
} from './tui-screen';

export {availablePages, availableSystemSections} from './tui-pages';
export type {PageId, SystemSectionId, ServiceFilter} from './tui-pages';
export {buildLocalModelPayload, type LocalModelInput} from './tui-models';
export type {TuiOverlay} from './tui-dialogs';
export {saveNewFile} from './tui-files';

/** Why the TUI ended: a plain quit, or a request the appliance console must act on. */
export type TuiOutcome = 'quit' | 'switch-user' | 'restart-session';

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
  ...initialPageState(), scrollTop: 0, ...overrides,
});

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

const UP = '\u001b[A', DOWN = '\u001b[B', RIGHT = '\u001b[C', LEFT = '\u001b[D', SHIFT_TAB = '\u001b[Z';
const PAGE_UP = '\u001b[5~', PAGE_DOWN = '\u001b[6~';
const HOME = ['\u001b[H', '\u001b[1~'], END = ['\u001b[F', '\u001b[4~'];
const ENTER = ['\r', '\n'];
const ESC = '\u001b', CTRL_S = '\u0013', CTRL_U = '\u0015', BACKSPACE = ['\u007f', '\b'];

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  /** The page asked to be repainted every second (a countdown is visible). */
  tick: boolean;
}

const keyed = (targets: Target[]): FocusTarget[] => {
  const seen = new Map<string, number>();
  return targets.map((target) => {
    const count = seen.get(target.action.id) ?? 0;
    seen.set(target.action.id, count + 1);
    return {...target, key: count ? `${target.action.id}#${count}` : target.action.id};
  });
};

/** Lays out one full screen and reports where every interactive element is. */
export const composeTui = (snapshot: DashboardSnapshot, state: TuiViewState, width = 120, height = 36, color = true): TuiLayout => {
  const columns = Math.min(usableColumns(width), MAX_CONTENT_COLUMNS);
  const banner = bannerFits(height) ? renderBanner(columns, state.banner?.elapsedMs, color, state.banner?.seed) : [];
  const rows = Math.max(1, height - banner.length);
  const canvas = new Canvas(columns, rows);
  const pages = availablePages(snapshot);
  const page = pages.some((item) => item.id === state.page) ? state.page : pages[0]!.id;
  const viewport = Math.max(0, rows - 4 - (state.notice ? 1 : 0));
  const contentX = SIDEBAR + 3;
  const contentWidth = Math.max(10, columns - SIDEBAR - 6);
  const view: PageView = buildPage(snapshot, {...state, page}, contentWidth);
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
    const wide = state.overlay.kind === 'dialog' || state.overlay.kind === 'viewer';
    const boxWidth = Math.max(20, Math.min(wide ? 108 : 84, columns - 4));
    const box = renderOverlay(state.overlay, boxWidth, Math.max(3, rows - 1));
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
    // Lower-priority entries give way first when the bar is too long; all of them also exist as buttons.
    const entries: Array<BarItem & {drop?: number}> = [
      {key: '↑↓←→', label: 'Move'}, {key: 'Tab', label: 'Next', drop: 100},
      ...(focused ? [{key: 'Enter', label: focused.action.label}] : []),
      ...view.hotkeys.map((item, index) => ({key: item.key, label: item.label, actionId: item.actionId, drop: 50 - index})),
      {key: `1-${pages.length}`, label: 'Page', drop: 90}, {key: 'r', label: 'Reload', actionId: 'reload'},
      ...(state.demo ? [] : [{key: 'x', label: state.localConsole ? 'Switch user' : 'Sign out', actionId: 'session'}]),
      {key: '?', label: 'Help', actionId: 'help'}, {key: 'q', label: 'Quit', actionId: 'quit'},
    ];
    const widthOf = (items: BarItem[]) => items.reduce((total, item) => total + textWidth(item.key) + 1 + textWidth(item.label) + 2, 1);
    while (widthOf(entries) > columns + 1 && entries.some((item) => item.drop !== undefined)) {
      const lowest = entries.reduce((best, item) => (item.drop ?? -1) > (best.drop ?? -1) ? item : best);
      entries.splice(entries.indexOf(lowest), 1);
    }
    bar = entries;
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
    hotkeys: view.hotkeys, page, scrollTop, maxScroll, viewport, tick: Boolean(view.tick),
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
  /** Folder the appliance console shares with the host's USB helper; files are then saved to and opened from USB sticks. */
  transferDirectory?: string;
}

const isPrintable = (key: string) => Array.from(key).every((character) => character >= ' ' && character !== '\u007f');
const SNAPSHOT_FIELDS: Record<ExtraKey, keyof DashboardSnapshot> = {
  hosts: 'hosts', gpuSharing: 'gpuSharing', mesh: 'mesh', federatedSso: 'federatedSso', regression: 'regression', softwareReleases: 'softwareReleases',
};

export const runTui = async (runtime: Runtime, options: TuiOptions = {}): Promise<TuiOutcome> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI needs an interactive terminal. Use CLI commands or --json for non-interactive use.');
  const view = initialViewState();
  const files = await createFileAccess(options.transferDirectory);
  const initialQuery = queryOptions(view);
  let snapshot = await loadSnapshot(runtime.api, initialQuery);
  let layout: TuiLayout | undefined;
  let busy = false;
  let refreshing = false;
  let loadSequence = 0;
  let lastQuery = JSON.stringify([initialQuery.users, initialQuery.kubernetesSearch]);
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

  /** Loads the shared state plus the open page's data; a newer load always wins over an older one. */
  const reload = async (forceReleases = false, extrasOnly = false) => {
    const sequence = ++loadSequence;
    const {options: needs} = dataNeeds(snapshot, view);
    if (!extrasOnly) lastQuery = JSON.stringify([needs.users, needs.kubernetesSearch]);
    const next = await loadSnapshot(runtime.api, {...needs, previous: snapshot, forceReleases, extrasOnly});
    if (sequence === loadSequence) snapshot = next;
  };
  const refresh = async (forceReleases = false, extrasOnly = false) => {
    if (refreshing || busy || finished) return;
    refreshing = true;
    try {
      await reload(forceReleases, extrasOnly);
      refreshError = '';
    } catch (error) {
      refreshError = truncate(errorText(error), 100);
    } finally {
      refreshing = false;
      draw();
    }
  };
  /** Loads page data as soon as a page that needs it opens, instead of waiting for the next poll. */
  const ensureData = () => {
    const {options: needs} = dataNeeds(snapshot, view);
    const query = JSON.stringify([needs.users, needs.kubernetesSearch]);
    const missing = (needs.extras ?? []).some((key) => snapshot[SNAPSHOT_FIELDS[key]] === undefined && !snapshot.errors?.[key]);
    if (query !== lastQuery) void refresh();
    else if (missing) void refresh(false, true);
  };

  const show = (next: TuiOverlay | undefined) => {
    overlay = next;
    draw();
  };
  const message = (title: string, lines: string | string[], tone: 'normal' | 'error' = 'normal', copyValue?: string) =>
    show({kind: 'message', title, lines: Array.isArray(lines) ? lines : [lines], tone, copyValue});
  const returnWithError = (origin: TuiOverlay | undefined, error: unknown) => {
    if (origin && (origin.kind === 'dialog' || origin.kind === 'confirm' || origin.kind === 'viewer')) {
      origin.error = errorText(error);
      overlay = origin;
    } else overlay = {kind: 'message', title: 'Could not apply change', lines: [errorText(error)], tone: 'error'};
  };
  const perform = async (title: string, operation: () => Promise<PerformResult | void>) => {
    if (busy) return;
    const origin = overlay;
    busy = true;
    show({kind: 'busy', title});
    try {
      const result = await operation();
      const lines = result?.lines ?? [title];
      try {
        await reload();
        refreshError = '';
      } catch (error) {
        refreshError = truncate(errorText(error), 100);
        lines.push(`The change succeeded, but refreshing the status failed: ${refreshError}`);
      }
      overlay = {kind: 'message', title: 'Completed', lines, ...(result?.copyValue ? {copyValue: result.copyValue} : {})};
    } catch (error) {
      returnWithError(origin, error);
    } finally {
      busy = false;
      draw();
    }
  };
  const task = async <T,>(title: string, operation: () => Promise<T>, then?: (value: T) => void) => {
    if (busy) return;
    const origin = overlay;
    busy = true;
    show({kind: 'busy', title, description: 'Working…', back: origin});
    try {
      const value = await operation();
      busy = false;
      if (origin && 'error' in origin) origin.error = undefined;
      overlay = origin;
      then?.(value);
    } catch (error) {
      busy = false;
      returnWithError(origin, error);
    }
    draw();
  };
  /** Loads something to read (credentials, an access policy) behind a busy dialog, without a "completed" message. */
  const load = async <T,>(title: string, fetch: () => Promise<T>, then: (value: T) => void) => {
    if (busy) return;
    busy = true;
    show({kind: 'busy', title, description: 'Loading…'});
    try {
      const value = await fetch();
      busy = false;
      overlay = undefined;
      then(value);
    } catch (error) {
      busy = false;
      overlay = {kind: 'message', title: 'Could not load', lines: [errorText(error)], tone: 'error'};
    }
    draw();
  };
  const confirm = (spec: ConfirmOptions) => show({
    kind: 'confirm', title: spec.title, description: spec.description, confirmLabel: spec.confirmLabel,
    onConfirm: async () => { await spec.onConfirm(); },
    expected: spec.expected, typed: spec.expected !== undefined ? '' : undefined, danger: spec.danger,
    back: spec.back ? overlay : undefined,
  });
  const close = () => show(overlay?.back);

  const viewerTimers = new Set<ReturnType<typeof setInterval>>();
  const inStack = (target: TuiOverlay) => {
    for (let item = overlay; item; item = item.back) if (item === target) return true;
    return false;
  };

  const ctx: TuiContext = {
    api: runtime.api,
    view,
    demo: Boolean(options.demo),
    snapshot: () => snapshot,
    session: () => snapshot.session,
    draw: redraw,
    refresh: (refreshOptions) => refresh(Boolean(refreshOptions?.releases)),
    message, perform, task, load, confirm, close,
    form: (title, description, fields, submitLabel, onSubmit, back) => {
      const next = formDialog(title, description, fields, submitLabel, onSubmit);
      next.back = back ? overlay : undefined;
      show(next);
    },
    dialog: (spec, back) => show({kind: 'dialog', spec, scroll: 0, back: back ? overlay : undefined}),
    menu: (title, description, menuOptions, active = 0, back) => show({kind: 'menu', title, description, options: menuOptions, active, back: back ? overlay : undefined}),
    viewer: (spec, back) => {
      const next: TuiOverlay = {kind: 'viewer', spec, scroll: 0, back: back ? overlay : undefined};
      show(next);
      if (spec.autoRefresh) {
        const timer = setInterval(() => {
          if (finished || !inStack(next)) {
            clearInterval(timer);
            viewerTimers.delete(timer);
            return;
          }
          if (overlay !== next || busy) return;
          void spec.autoRefresh!.run().then(() => { next.error = undefined; }, (error) => { next.error = errorText(error); }).finally(() => { if (overlay === next) draw(); });
        }, Math.max(1000, spec.autoRefresh.ms));
        viewerTimers.add(timer);
      }
    },
    current: () => overlay,
    copy: (value) => { process.stdout.write(osc52ClipboardSequence(value)); },
    saveAs: (spec) => saveAs(ctx, files, spec),
    openFile: (spec) => openFile(ctx, files, spec),
    requestId: () => crypto.randomUUID().replaceAll('-', ''),
    missing: () => message('No longer available', 'This item has changed in the meantime. The view shows the current state.'),
  };

  let finish: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    for (const item of viewerTimers) clearInterval(item);
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
      confirm({title: 'Sign in as another user', description: 'This monitor is signed in automatically. To act as a different user, a one-time code is shown that you confirm in a browser on a second device. You can cancel and return here at any time.', confirmLabel: 'continue', onConfirm: () => leave('switch-user')});
    } else if (runtime.localConsole && kind === 'user') {
      ctx.menu('Switch user', `Signed in as ${sessionDisplayName(snapshot.session)}.`, [
        {label: 'Return to the automatic monitor session', hint: 'removes this user login', action: () => void runtime.logout().then(() => leave('restart-session'), (error) => message('Could not sign out', errorText(error), 'error'))},
        {label: 'Sign in as another user', hint: 'needs a second device', action: () => leave('switch-user')},
      ]);
    } else {
      confirm({title: 'Sign out', description: 'The locally cached SSO session is removed. A new device login is needed afterwards.', confirmLabel: 'sign out', onConfirm: async () => {
        await runtime.logout();
        cleanup();
      }});
    }
  };
  const showHelp = () => message('Keyboard and mouse', [
    'Arrow keys (or h j k l) move the cursor to the nearest element. Tab and Shift+Tab walk through all elements in reading order.',
    'Enter or Space uses the element under the cursor: opens a page, presses a button, expands a section.',
    'Left from the page returns to the page list; there, Up and Down switch pages and Right enters the page.',
    'Page Up, Page Down, Home and End scroll long pages. The number keys open a page directly; s, t and f switch sections, tabs and filters where shown.',
    'In dialogs, Up and Down move between fields. Left and Right change a choice or adjust a number like a slider; Space opens the full list of a choice or toggles a checkbox; letters jump to a matching choice. Enter moves to the next field or presses a button, Ctrl+S submits and Esc goes back.',
    'With a mouse: click any element or footer entry, and use the wheel to scroll. Hold Shift to select text with the terminal.',
    'The footer always lists the keys that work right now.',
  ]);

  const openPage = (page: PageId) => {
    view.page = page;
    view.scrollTop = 0;
    view.focusId = `nav:${page}`;
  };
  const cycle = <T,>(items: T[], current: T) => items[(items.indexOf(current) + 1) % items.length] ?? current;

  const RUNTIME_SCOPES = new Set<string>();
  const ADMIN_SCOPES = new Set<string>();
  const handlers = new Map<string, (typeof AREA_MODULES)[number]>();
  for (const module of AREA_MODULES) {
    for (const [scope, access] of Object.entries(module.scopes)) {
      handlers.set(scope, module);
      if (access === 'runtime') RUNTIME_SCOPES.add(scope);
      if (access === 'admin') ADMIN_SCOPES.add(scope);
    }
  }

  /** Switches between the tabs of a bar; `next` cycles through the selectable ones. */
  const switchTab = <T extends string,>(items: Array<{id: T; disabled?: string}>, current: T, next: string, apply: (value: T) => void) => {
    const selectable = items.filter((item) => !item.disabled).map((item) => item.id);
    const target = next === 'next' ? cycle(selectable, current) : next as T;
    const entry = items.find((item) => item.id === target);
    if (entry?.disabled) return message('Not available', entry.disabled);
    apply(target);
    view.scrollTop = 0;
    draw();
  };

  /** Runs what a button, link, page entry or hotkey stands for. */
  const activate = (action: Action) => {
    const id = action.id;
    if (action.disabled) return message('Not available', action.disabled);
    if (id === 'quit') return cleanup();
    if (id === 'reload') return void refresh(true);
    if (id === 'help') return showHelp();
    if (id === 'session') return sessionAction();
    if (id.startsWith('nav:')) {
      openPage(id.slice(4) as PageId);
      return draw();
    }
    const [scope = '', verb = '', ...rest] = id.split(':');
    const target = rest.join(':');
    if (scope === 'section') return switchTab(availableSystemSections(snapshot), activeSystemSection(snapshot, view.systemSection), verb, (value) => { view.systemSection = value; });
    if (scope === 'settings-tab') return switchTab(availableSettingsSections(snapshot), activeSettingsSection(snapshot, view.settingsSection), verb, (value) => { view.settingsSection = value; });
    if (scope === 'status-tab') return switchTab(availableStatusSections(snapshot), activeStatusSection(snapshot, view.statusSection), verb, (value) => { view.statusSection = value; });
    if (scope === 'mesh-tab') return switchTab(meshTabs(snapshot), activeMeshTab(snapshot, view.meshTab), verb, (value) => { view.meshTab = value; });
    if (scope === 'filter') {
      view.serviceFilter = verb === 'next' ? cycle(SERVICE_FILTERS.map((item) => item.id), view.serviceFilter) : verb as typeof view.serviceFilter;
      return draw();
    }
    if (scope === 'expand') {
      const key = id.slice(7);
      view.expanded[key] = !(view.expanded[key] ?? false);
      return draw();
    }
    if (scope === 'link') return message('Address', [id.slice(5), 'Open this address in a browser on a device in the same network.'], 'normal', id.slice(5));
    if (scope === 'copy') return message('Copy', [id.slice(5)], 'normal', id.slice(5));

    const handler = handlers.get(scope);
    const request: ActionRequest = {id, scope, verb, target};
    if (options.demo && !handler?.readOnly?.(request)) return message('Offline demo', 'This preview is read-only. Live actions require an appliance connection.');
    if (RUNTIME_SCOPES.has(scope) && !canMutateRuntime(snapshot.session)) return message('Read-only session', 'Operator or administrator access is required for this action.', 'error');
    if (ADMIN_SCOPES.has(scope) && !canAdminister(snapshot.session)) return message('Administrator access required', 'This action is restricted to Magic Stick administrators.', 'error');
    if (!handler) return;
    try {
      const result = handler.handle(ctx, request);
      if (result instanceof Promise) void result.catch((error) => message('Could not apply change', errorText(error), 'error'));
    } catch (error) {
      message('Could not apply change', errorText(error), 'error');
    }
  };

  const submitDialog = async (current: Extract<TuiOverlay, {kind: 'dialog'}>) => {
    const submit = current.spec.submit;
    if (!submit) return;
    const items = current.spec.items();
    const missing = items.find((item): item is Extract<DialogItem, {kind: 'text' | 'number'}> =>
      (item.kind === 'text' || item.kind === 'number') && Boolean(item.required) && !item.disabled && !item.value.trim());
    if (missing) {
      current.error = `${missing.label} is required.`;
      current.focus = missing.id;
      return draw();
    }
    const blocked = submit.disabled?.();
    if (blocked) {
      current.error = blocked;
      return draw();
    }
    current.error = undefined;
    try {
      await submit.run();
    } catch (error) {
      current.error = errorText(error);
      if (overlay === current) draw();
    }
  };

  /** Enter on an input moves to the next input, or submits after the last one, like the browser forms. */
  const nextInputOrSubmit = (current: Extract<TuiOverlay, {kind: 'dialog'}>, items: DialogItem[], ids: string[], index: number) => {
    const inputs = new Set(items.filter((item) => ['text', 'number', 'choice', 'check'].includes(item.kind)).map((item) => (item as {id: string}).id));
    const next = ids.slice(index + 1).find((id) => inputs.has(id));
    if (next) {
      current.focus = next;
      return draw();
    }
    void submitDialog(current);
  };

  const pickChoice = (current: Extract<TuiOverlay, {kind: 'dialog'}>, item: Extract<DialogItem, {kind: 'choice'}>) => {
    const active = Math.max(0, item.choices.findIndex((entry) => entry.value === item.value));
    overlay = {kind: 'menu', title: item.label, back: current, active, options: item.choices.map((entry) => ({
      label: entry.label, disabled: Boolean(entry.disabled), hint: entry.disabled,
      action: () => {
        item.onChange(entry.value);
        current.error = undefined;
        show(current);
      },
    }))};
    draw();
  };

  const stepChoice = (item: Extract<DialogItem, {kind: 'choice'}>, direction: number) => {
    const choices = item.choices;
    if (!choices.length) return;
    let index = Math.max(0, choices.findIndex((entry) => entry.value === item.value));
    for (let step = 0; step < choices.length; step += 1) {
      index = moveTab(index, direction, choices.length);
      if (!choices[index]!.disabled) break;
    }
    if (!choices[index]!.disabled) item.onChange(choices[index]!.value);
  };

  const pressInline = (current: Extract<TuiOverlay, {kind: 'dialog'}>, entry: InlineButton) => {
    if (entry.disabled) {
      current.error = entry.disabled;
      return draw();
    }
    current.error = undefined;
    entry.onPress();
    draw();
  };

  const handleDialogKey = (key: string, current: Extract<TuiOverlay, {kind: 'dialog'}>) => {
    const items = current.spec.items();
    const ids = dialogFocusIds(current, items);
    const focus = dialogFocus(current, items);
    const index = ids.indexOf(focus);
    const item = findDialogItem(items, focus);
    const move = (direction: number) => { current.focus = ids[moveSelection(index, direction, ids.length)]; };
    if (key === UP || key === SHIFT_TAB) move(-1);
    else if (key === DOWN || key === '\t') move(1);
    else if (key === CTRL_S) return void submitDialog(current);
    else if (focus === 'dlg:cancel') {
      if (ENTER.includes(key) || key === ' ') return close();
      if (key === LEFT) move(-1); else if (key === RIGHT) move(1);
    } else if (focus === 'dlg:submit') {
      if (ENTER.includes(key) || key === ' ') return void submitDialog(current);
      if (key === LEFT) move(-1);
    } else if (item && !('kind' in item)) {
      if (ENTER.includes(key) || key === ' ') return pressInline(current, item);
      if (key === LEFT) move(-1); else if (key === RIGHT) move(1);
    } else if (item && 'kind' in item) {
      const disabled = 'disabled' in item ? item.disabled : undefined;
      if (item.kind === 'text' || item.kind === 'number') {
        if (ENTER.includes(key)) return nextInputOrSubmit(current, items, ids, index);
        if (disabled && (isPrintable(key) || BACKSPACE.includes(key) || key === CTRL_U)) current.error = disabled;
        else if (key === CTRL_U) { item.onChange(''); current.error = undefined; }
        else if (BACKSPACE.includes(key)) { item.onChange(Array.from(item.value).slice(0, -1).join('')); current.error = undefined; }
        else if (item.kind === 'number' && (key === LEFT || key === RIGHT) && !disabled) {
          const step = item.step ?? 1;
          const base = Number(item.value);
          const start = Number.isFinite(base) && item.value.trim() !== '' ? base : item.min ?? 0;
          let next = key === LEFT ? start - step : start + step;
          // Snap to the step grid like a slider; the saved value may have been off-grid.
          next = Math.round(next / step) * step;
          if (item.min !== undefined) next = Math.max(item.min, next);
          if (item.max !== undefined) next = Math.min(item.max, next);
          item.onChange(item.decimals ? String(Number(next.toFixed(3))) : String(Math.round(next)));
          current.error = undefined;
        } else if (!key.startsWith(ESC) && isPrintable(key)) {
          const accepted = item.kind === 'number' ? Array.from(key).filter((character) => /[0-9.]/.test(character) || (character === '-' && (item.min ?? 0) < 0)).join('') : key;
          const value = `${item.value}${accepted}`;
          const limit = item.kind === 'text' ? item.maxLength : undefined;
          item.onChange(limit ? Array.from(value).slice(0, limit).join('') : value);
          current.error = undefined;
        }
      } else if (item.kind === 'choice') {
        if (ENTER.includes(key)) return nextInputOrSubmit(current, items, ids, index);
        if (disabled && (key === ' ' || key === LEFT || key === RIGHT)) current.error = disabled;
        else if (key === ' ') return pickChoice(current, item);
        else if (key === LEFT) { stepChoice(item, -1); current.error = undefined; }
        else if (key === RIGHT) { stepChoice(item, 1); current.error = undefined; }
        else if (!disabled && /^[a-z0-9]$/i.test(key)) {
          // Type-ahead like a select: jump to the next choice starting with that character.
          const start = Math.max(0, item.choices.findIndex((entry) => entry.value === item.value));
          const order = [...item.choices.slice(start + 1), ...item.choices.slice(0, start + 1)];
          const match = order.find((entry) => !entry.disabled && entry.label.toLowerCase().startsWith(key.toLowerCase()));
          if (match) { item.onChange(match.value); current.error = undefined; }
        }
      } else if (item.kind === 'check') {
        if (ENTER.includes(key) || key === ' ') {
          if (disabled) current.error = disabled;
          else { item.onChange(!item.checked); current.error = undefined; }
        }
      } else if (item.kind === 'toggle') {
        if (ENTER.includes(key) || key === ' ' || key === LEFT || key === RIGHT) item.onChange(key === LEFT ? false : key === RIGHT ? true : !item.open);
      }
    }
    draw();
  };

  const handleOverlayInput = (key: string, current: TuiOverlay) => {
    if (current.kind === 'busy') return;
    if (key === ESC) return close();
    if (current.kind === 'message') {
      if (key === 'c' && current.copyValue) {
        process.stdout.write(osc52ClipboardSequence(current.copyValue));
        current.lines = [...current.lines.filter((line) => line !== 'Copied to clipboard.'), 'Copied to clipboard.'];
        draw();
      } else if (ENTER.includes(key) || key === ' ') close();
      return;
    }
    if (current.kind === 'confirm') {
      const run = async () => {
        try {
          current.error = undefined;
          await current.onConfirm();
        } catch (error) {
          current.error = errorText(error);
          if (overlay === current) draw();
        }
      };
      if (current.expected !== undefined) {
        if (ENTER.includes(key)) {
          if (current.typed === current.expected) return void run();
          current.error = `Type ${current.expected} exactly to confirm.`;
        } else if (key === CTRL_U) current.typed = '';
        else if (BACKSPACE.includes(key)) current.typed = Array.from(current.typed ?? '').slice(0, -1).join('');
        else if (!key.startsWith(ESC) && isPrintable(key)) current.typed = `${current.typed ?? ''}${key}`;
        return draw();
      }
      if (key === 'n') close();
      else if (key === 'y' || ENTER.includes(key)) void run();
      return;
    }
    if (current.kind === 'menu') {
      if (key === UP || key === 'k') current.active = moveSelection(current.active, -1, current.options.length);
      else if (key === DOWN || key === 'j' || key === '\t') current.active = moveSelection(current.active, 1, current.options.length);
      else if (key === PAGE_UP) current.active = moveSelection(current.active, -10, current.options.length);
      else if (key === PAGE_DOWN) current.active = moveSelection(current.active, 10, current.options.length);
      else if (ENTER.includes(key)) {
        const item = current.options[current.active];
        if (item?.disabled) message('Action unavailable', item.hint ?? 'This action is not available for the selected item.', 'error');
        else item?.action();
        return;
      }
      draw();
      return;
    }
    if (current.kind === 'viewer') {
      const page = Math.max(1, (process.stdout.rows ?? 30) - 14);
      const action = current.spec.actions?.find((item) => item.key === key);
      if (action) {
        current.error = undefined;
        action.run();
        return draw();
      }
      if (key === UP || key === 'k') current.scroll -= 1;
      else if (key === DOWN || key === 'j') current.scroll += 1;
      else if (key === PAGE_UP) current.scroll -= page;
      else if (key === PAGE_DOWN || key === ' ') current.scroll += page;
      else if (HOME.includes(key)) current.scroll = 0;
      else if (END.includes(key)) current.scroll = Number.MAX_SAFE_INTEGER;
      else if (ENTER.includes(key) || key === 'q') return close();
      current.scroll = Math.max(0, current.scroll);
      return draw();
    }
    handleDialogKey(key, current);
  };

  /** A click inside a dialog does what the matching key does. */
  const handleDialogClick = (id: string, current: TuiOverlay) => {
    if (id === 'dlg:close') return current.kind === 'viewer' ? close() : handleOverlayInput('\r', current);
    if (id === 'dlg:cancel') return close();
    if (id === 'dlg:copy') return handleOverlayInput('c', current);
    if (id === 'dlg:typed') return;
    if (id === 'dlg:confirm' && current.kind === 'confirm') return handleOverlayInput('\r', current);
    if (id.startsWith('dlg:act:') && current.kind === 'viewer') return handleOverlayInput(id.slice(8), current);
    if (id.startsWith('dlg:option:') && current.kind === 'menu') {
      current.active = moveSelection(Number(id.split(':')[2]), 0, current.options.length);
      return handleOverlayInput('\r', current);
    }
    if (current.kind !== 'dialog') return;
    if (id === 'dlg:submit') return void submitDialog(current);
    if (id.startsWith('dlg:item:')) {
      const itemId = id.slice(9);
      const items = current.spec.items();
      const item = findDialogItem(items, itemId);
      const already = dialogFocus(current, items) === itemId;
      current.focus = itemId;
      if (!item) return draw();
      if (!('kind' in item)) return pressInline(current, item);
      if (item.kind === 'check' || item.kind === 'toggle') return handleDialogKey(' ', current);
      // Clicking the selected choice again opens its list.
      if (item.kind === 'choice' && already) return handleDialogKey(' ', current);
      draw();
    }
  };

  const scrollBy = (rows: number) => {
    if (!layout) return;
    view.scrollTop = Math.min(layout.maxScroll, Math.max(0, layout.scrollTop + rows));
  };
  const focus = (direction: 'up' | 'down' | 'left' | 'right' | 'next' | 'previous') => {
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
      else if (overlay?.kind === 'viewer') overlay.scroll = Math.max(0, overlay.scroll + direction * 3);
      else if (overlay?.kind === 'dialog') return handleDialogKey(direction < 0 ? UP : DOWN, overlay);
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
    if (key === 'r') return void refresh(true);
    if (key === '?') return showHelp();
    const pages = availablePages(snapshot);
    const hotkey = layout?.hotkeys.find((item) => item.key === key);
    if (key === UP || key === 'k') focus('up');
    else if (key === DOWN || key === 'j') focus('down');
    else if (key === LEFT || key === 'h') focus('left');
    else if (key === RIGHT || key === 'l') focus('right');
    else if (key === '\t') focus('next');
    else if (key === SHIFT_TAB) focus('previous');
    else if (key === PAGE_UP) scrollBy(-Math.max(1, (layout?.viewport ?? 2) - 1));
    else if (key === PAGE_DOWN) scrollBy(Math.max(1, (layout?.viewport ?? 2) - 1));
    else if (HOME.includes(key)) scrollBy(-Infinity);
    else if (END.includes(key)) scrollBy(Infinity);
    else if (key === ESC) view.focusId = `nav:${view.page}`;
    else if (/^[1-9]$/.test(key) && pages[Number(key) - 1]) openPage(pages[Number(key) - 1]!.id);
    else if ((ENTER.includes(key) || key === ' ') && layout?.focused) return activate(layout.focused.action);
    else if (hotkey) return activate({id: hotkey.actionId, label: hotkey.label});
    draw();
  };
  const onData = (input: Buffer) => {
    const value = input.toString('utf8');
    const activeItem = overlay?.kind === 'dialog' ? findDialogItem(overlay.spec.items(), dialogFocus(overlay)) : undefined;
    const typing = (activeItem && 'kind' in activeItem && (activeItem.kind === 'text' || activeItem.kind === 'number'))
      || (overlay?.kind === 'confirm' && overlay.expected !== undefined);
    const printablePaste = typing && Array.from(value).length > 1 && isPrintable(value);
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
    if (!overlay && !finished) ensureData();
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
  const baseRefreshMs = Math.max(5, options.refreshSeconds ?? 15) * 1000;
  timer = setInterval(() => {
    if (finished) return;
    // Countdowns (a network change awaiting confirmation) repaint every second.
    if (layout?.tick && !overlay) draw();
    // The shared state reloads at the normal interval; a page's own data (host operations,
    // mesh, regression runs) polls faster on its own, like the browser's per-page queries.
    const {refreshMs, options: needs} = dataNeeds(snapshot, view);
    const now = Date.now();
    if (now - snapshot.loadedAt >= baseRefreshMs) void refresh();
    else if ((needs.extras ?? []).length && now - (snapshot.extrasLoadedAt ?? snapshot.loadedAt) >= refreshMs) void refresh(false, true);
  }, 1000);
  animation.start();
  draw();
  ensureData();
  await new Promise<void>((resolve) => { finish = resolve; });
  return outcome;
};
