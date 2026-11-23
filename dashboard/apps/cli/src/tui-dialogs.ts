// Modal dialogs of the terminal dashboard: the counterparts of the browser's dialogs,
// confirmations and popovers. A dialog is rebuilt from its own state on every render,
// so dependent fields, live estimates and inline buttons behave like the web forms.
import {
  badge, button, clipText, fit, gap, panel, prose, span, textWidth,
  type Row, type Span, type Tone,
} from './tui-screen';

export interface Choice {
  value: string;
  label: string;
  /** Why this choice cannot be selected; it stays visible, like a disabled option in a select. */
  disabled?: string;
}

/** Fields of the simple list forms (kept for the many small forms that only collect values). */
export interface FormField {
  id: string;
  label: string;
  value: string;
  kind?: 'text' | 'secret' | 'choice';
  choices?: Choice[];
  required?: boolean;
  hint?: string;
}

export interface MenuOption {
  label: string;
  disabled?: boolean;
  hint?: string;
  action: () => void;
}

export interface InlineButton {
  id: string;
  label: string;
  onPress: () => void;
  tone?: 'ghost' | 'primary' | 'danger';
  /** Why the button cannot be used; pressing it shows the reason. */
  disabled?: string;
}

/** One element of a dialog. Items with an `id` take the cursor; the others only display. */
export type DialogItem =
  | {kind: 'text'; id: string; label: string; value: string; onChange: (value: string) => void; secret?: boolean; required?: boolean; hint?: string; disabled?: string; maxLength?: number}
  | {kind: 'number'; id: string; label: string; value: string; onChange: (value: string) => void; step?: number; min?: number; max?: number; required?: boolean; hint?: string; disabled?: string; decimals?: boolean}
  | {kind: 'choice'; id: string; label: string; value: string; choices: Choice[]; onChange: (value: string) => void; hint?: string; disabled?: string}
  | {kind: 'check'; id: string; label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string; disabled?: string}
  | {kind: 'toggle'; id: string; label: string; open: boolean; onChange: (open: boolean) => void; meta?: string}
  | {kind: 'buttons'; items: InlineButton[]}
  | {kind: 'note'; text: string; tone?: Tone}
  | {kind: 'heading'; text: string; meta?: string; status?: Span}
  | {kind: 'facts'; rows: Array<[string, string]>; width?: number}
  | {kind: 'blank'};

export interface DialogSpec {
  title: string;
  description?: string;
  /** Rebuilt on every render from the dialog's own state. */
  items: () => DialogItem[];
  submit?: {
    label: string;
    tone?: 'primary' | 'danger';
    /** Why submitting is not possible right now (invalid, unchanged, still calculating). */
    disabled?: () => string | undefined;
    run: () => Promise<void> | void;
  };
  cancelLabel?: string;
  /** Short status in the title bar, e.g. "Step 2 of 3". */
  meta?: () => string | undefined;
}

export interface ViewerLine {
  text: string;
  tone?: Tone;
  bold?: boolean;
}

export interface ViewerAction {
  key: string;
  label: string;
  run: () => void;
}

export interface ViewerSpec {
  title: string;
  description?: string;
  lines: () => ViewerLine[];
  actions?: ViewerAction[];
  /** Repeats a reload while the viewer is open, like the browser's polling log view. */
  autoRefresh?: {ms: number; run: () => Promise<void>};
}

interface Stacked {
  /** The dialog Esc returns to; without it, Esc closes everything. */
  back?: TuiOverlay;
}

export type TuiOverlay =
  | ({kind: 'menu'; title: string; description?: string; options: MenuOption[]; active: number} & Stacked)
  | ({kind: 'confirm'; title: string; description: string; confirmLabel: string; onConfirm: () => Promise<void>;
    /** Exact text the user has to type before the confirmation is accepted (a host name, an alias). */
    expected?: string; typed?: string; error?: string; danger?: boolean} & Stacked)
  | ({kind: 'message'; title: string; lines: string[]; tone?: 'normal' | 'error'; copyValue?: string} & Stacked)
  | ({kind: 'busy'; title: string; description?: string} & Stacked)
  | ({kind: 'dialog'; spec: DialogSpec; focus?: string; scroll: number; error?: string} & Stacked)
  | ({kind: 'viewer'; spec: ViewerSpec; scroll: number; error?: string} & Stacked);

export const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Ids of the elements that take the cursor, in reading order, including the footer buttons. */
export const dialogFocusIds = (overlay: Extract<TuiOverlay, {kind: 'dialog'}>, items = overlay.spec.items()) => [
  ...items.flatMap((item) => item.kind === 'buttons' ? item.items.map((entry) => entry.id) : 'id' in item ? [item.id] : []),
  'dlg:cancel', ...(overlay.spec.submit ? ['dlg:submit'] : []),
];

export const findDialogItem = (items: DialogItem[], id?: string): DialogItem | InlineButton | undefined => {
  for (const item of items) {
    if (item.kind === 'buttons') {
      const entry = item.items.find((candidate) => candidate.id === id);
      if (entry) return entry;
    } else if ('id' in item && item.id === id) return item;
  }
  return undefined;
};

/** The dialog's cursor, moved to an existing element when the one it was on disappeared. */
export const dialogFocus = (overlay: Extract<TuiOverlay, {kind: 'dialog'}>, items = overlay.spec.items()) => {
  const ids = dialogFocusIds(overlay, items);
  return overlay.focus && ids.includes(overlay.focus) ? overlay.focus : ids[0]!;
};

const valueText = (item: Extract<DialogItem, {kind: 'text' | 'number'}>, focused: boolean) => {
  const shown = item.kind === 'text' && item.secret ? '•'.repeat(Array.from(item.value).length) : item.value;
  return `${item.label}${item.required ? ' *' : ''}: ${shown}${focused && !item.disabled ? '_' : ''}${!shown && item.hint ? `  (${item.hint})` : ''}`;
};

const choiceLabel = (item: Extract<DialogItem, {kind: 'choice'}>) => item.choices.find((entry) => entry.value === item.value)?.label ?? item.value;

const inlineButton = (entry: InlineButton): Span => button(`dlg:item:${entry.id}`, entry.label, entry.tone ?? 'ghost', entry.disabled);

/** The rows of one dialog item, each with the cursor id it belongs to. */
const itemRows = (item: DialogItem, inner: number, focus: string): Array<{row: Row; id?: string}> => {
  const action = (id: string, label: string, disabled?: string) => ({id: `dlg:item:${id}`, label, ...(disabled ? {disabled} : {})});
  switch (item.kind) {
    case 'blank': return [{row: []}];
    case 'note': return prose(inner, item.text, item.tone ?? 'dim').map((row) => ({row}));
    case 'heading': return [{row: fit(inner, [span(item.text, undefined, true), ...(item.meta ? [span(` · ${item.meta}`, 'dim')] : [])], item.status ? [item.status] : [])}];
    case 'facts': {
      const width = item.width ?? Math.min(34, Math.max(...item.rows.map(([label]) => textWidth(label))) + 2);
      return item.rows.flatMap(([label, value]) => prose(Math.max(10, inner - width), value || '—').map((row, index) => ({
        row: [span(index ? ' '.repeat(width) : clipText(label, width - 1).padEnd(width), 'dim'), ...row],
      })));
    }
    case 'buttons': return [{row: item.items.flatMap((entry, index) => index ? [gap(), inlineButton(entry)] : [inlineButton(entry)]), id: item.items[0]?.id}];
    case 'toggle': return [{row: [{text: `${item.open ? '▼' : '►'} ${item.label}`, style: {bold: true}, action: action(item.id, item.open ? 'Collapse' : 'Expand')},
      ...(item.meta ? [span(`  ${item.meta}`, 'dim')] : [])], id: item.id}];
    case 'check': return [
      {row: [{text: `[${item.checked ? 'x' : ' '}] ${item.label}`, style: item.disabled ? {tone: 'dim'} : undefined, action: action(item.id, item.checked ? 'Clear' : 'Select', item.disabled)}], id: item.id},
      ...(item.disabled && focus === item.id ? prose(inner - 4, item.disabled, 'dim').map((row) => ({row: [gap(4), ...row]})) : []),
      ...(item.hint ? prose(inner - 4, item.hint, 'dim').map((row) => ({row: [gap(4), ...row]})) : []),
    ];
    case 'choice': {
      const current = item.choices.find((entry) => entry.value === item.value);
      return [
        {row: [{text: clipText(`${item.label}: < ${choiceLabel(item)} >`, inner), style: item.disabled ? {tone: 'dim'} : undefined, action: action(item.id, 'Change', item.disabled)}], id: item.id},
        ...(current?.disabled ? prose(inner - 4, `Not available: ${current.disabled}`, 'warn').map((row) => ({row: [gap(4), ...row]})) : []),
        ...(item.disabled && focus === item.id ? prose(inner - 4, item.disabled, 'dim').map((row) => ({row: [gap(4), ...row]})) : []),
        ...(item.hint ? prose(inner - 4, item.hint, 'dim').map((row) => ({row: [gap(4), ...row]})) : []),
      ];
    }
    default: {
      const focused = focus === item.id;
      const label = valueText(item, focused);
      // Long values keep their end (where typing happens) visible.
      const characters = Array.from(label);
      const text = characters.length > inner ? `…${characters.slice(characters.length - inner + 1).join('')}` : label;
      return [
        {row: [{text, style: item.disabled ? {tone: 'dim'} : undefined, action: action(item.id, 'Edit', item.disabled)}], id: item.id},
        ...(item.kind === 'number' && focused && !item.disabled && item.step ? [{row: [gap(4), span(`←→ ${item.step.toLocaleString('en-US')} per step${item.min !== undefined || item.max !== undefined ? ` · ${item.min ?? '…'} – ${item.max ?? '…'}` : ''}`, 'dim')]}] : []),
        ...(item.disabled && focused ? prose(inner - 4, item.disabled, 'dim').map((row) => ({row: [gap(4), ...row]})) : []),
        ...(item.value && item.hint && item.kind === 'number' ? prose(inner - 4, item.hint, 'dim').map((row) => ({row: [gap(4), ...row]})) : []),
      ];
    }
  }
};

export interface RenderedOverlay {
  rows: Row[];
  /** Id of the element under the dialog cursor, highlighted by the caller. */
  focus?: string;
}

const footerRow = (inner: number, buttons: Span[]): Row => fit(inner, [], buttons.flatMap((item, index) => index ? [gap(), item] : [item]));

/** Lays out a dialog of the given width; `room` is the number of rows available on screen. */
export const renderOverlay = (overlay: TuiOverlay, width: number, room: number): RenderedOverlay => {
  const inner = width - 4;
  const description = 'description' in overlay && overlay.description ? [...prose(inner, overlay.description, 'dim'), []] : [];
  const limited = (lead: Row[], tail: Row[]) => lead.length + tail.length > room - 2 ? [...lead.slice(0, Math.max(0, room - 2 - tail.length)), ...tail] : [...lead, ...tail];
  if (overlay.kind === 'busy') return {rows: panel(width, {title: overlay.title}, prose(inner, overlay.description ?? 'Applying change and refreshing state…', 'dim'))};
  if (overlay.kind === 'message') return {
    focus: 'dlg:close',
    rows: panel(width, {title: overlay.title, status: overlay.tone === 'error' ? badge('Failed', 'bad') : undefined}, limited(
      overlay.lines.flatMap((line) => prose(inner, line, overlay.tone === 'error' ? 'bad' : undefined)),
      [[], footerRow(inner, [...(overlay.copyValue ? [button('dlg:copy', 'Copy')] : []), button('dlg:close', 'Close', 'primary')])],
    )),
  };
  if (overlay.kind === 'confirm') {
    const typed = overlay.expected !== undefined
      ? [[], [{text: clipText(`Type ${overlay.expected} to confirm: ${overlay.typed ?? ''}_`, inner), action: {id: 'dlg:typed', label: 'Type'}}] as Row] : [];
    const error = overlay.error ? [[], ...prose(inner, `! ${overlay.error}`, 'bad')] : [];
    const ready = overlay.expected === undefined || overlay.typed === overlay.expected;
    return {
      focus: overlay.expected !== undefined && !ready ? 'dlg:typed' : 'dlg:confirm',
      rows: panel(width, {title: overlay.title}, limited([...prose(inner, overlay.description), ...typed], [
        ...error, [],
        footerRow(inner, [button('dlg:cancel', 'Cancel'), button('dlg:confirm', capitalize(overlay.confirmLabel), overlay.danger ? 'danger' : 'primary', ready ? undefined : `Type ${overlay.expected} exactly to confirm.`)]),
      ])),
    };
  }
  if (overlay.kind === 'menu') {
    const options = overlay.options.map((item, index): Row => [{
      text: clipText(`${item.disabled ? '×' : '●'} ${item.label}${item.hint ? ` — ${item.hint}` : ''}`, inner),
      style: item.disabled ? {tone: 'dim'} : undefined,
      action: {id: `dlg:option:${index}`, label: 'Choose'},
    }]);
    // Long lists show a window around the selected entry.
    const visible = Math.max(1, Math.min(options.length, room - 4 - description.length));
    const start = Math.max(0, Math.min(overlay.active - Math.floor(visible / 2), options.length - visible));
    return {
      focus: `dlg:option:${overlay.active}`,
      rows: panel(width, {title: overlay.title, meta: options.length > visible ? `${overlay.active + 1} of ${options.length}` : undefined}, limited(
        [...description, ...options.slice(start, start + visible)],
        [[], footerRow(inner, [button('dlg:cancel', overlay.back ? 'Back' : 'Cancel')])],
      )),
    };
  }
  if (overlay.kind === 'viewer') {
    const body = viewerRows(overlay, inner);
    const actions = overlay.spec.actions ?? [];
    const tail: Row[] = [
      ...(overlay.error ? prose(inner, `! ${overlay.error}`, 'bad') : []),
      [], footerRow(inner, [...actions.map((item) => button(`dlg:act:${item.key}`, item.label)), button('dlg:close', overlay.back ? 'Back' : 'Close', 'primary')]),
    ];
    const visible = Math.max(1, room - 2 - description.length - tail.length);
    const scroll = Math.min(Math.max(0, overlay.scroll), Math.max(0, body.length - visible));
    overlay.scroll = scroll;
    return {
      focus: 'dlg:close',
      rows: panel(width, {title: overlay.spec.title, meta: body.length > visible ? `lines ${scroll + 1}–${Math.min(body.length, scroll + visible)} of ${body.length}` : undefined},
        [...description, ...body.slice(scroll, scroll + visible), ...tail]),
    };
  }

  const items = overlay.spec.items();
  const focus = dialogFocus(overlay, items);
  overlay.focus = focus;
  const body: Array<{row: Row; id?: string}> = [...description.map((row) => ({row})), ...items.flatMap((item) => itemRows(item, inner, focus))];
  const submit = overlay.spec.submit;
  const blocked = submit?.disabled?.();
  const tail: Row[] = [
    ...(overlay.error ? [[], ...prose(inner, `! ${overlay.error}`, 'bad')] : []),
    [], footerRow(inner, [
      button('dlg:cancel', overlay.spec.cancelLabel ?? (overlay.back ? 'Back' : 'Cancel')),
      ...(submit ? [button('dlg:submit', capitalize(submit.label), submit.tone ?? 'primary', blocked)] : []),
    ]),
  ];
  const visible = Math.max(1, room - 2 - tail.length);
  // Keep the cursor's element on screen, with one row of context where possible.
  const focusRows = body.map((entry, index) => entry.id === focus ? index : -1).filter((index) => index >= 0);
  let scroll = Math.min(Math.max(0, overlay.scroll), Math.max(0, body.length - visible));
  if (focusRows.length) {
    const first = focusRows[0]!, last = focusRows.at(-1)!;
    if (first < scroll + 1) scroll = Math.max(0, first - 1);
    if (last >= scroll + visible - 1) scroll = Math.min(Math.max(0, body.length - visible), last - visible + 2);
  } else if (focus === 'dlg:submit' || focus === 'dlg:cancel') scroll = Math.max(0, body.length - visible);
  overlay.scroll = scroll;
  const meta = overlay.spec.meta?.() ?? (body.length > visible ? `rows ${scroll + 1}–${Math.min(body.length, scroll + visible)} of ${body.length}` : undefined);
  return {focus: focus.startsWith('dlg:') ? focus : `dlg:item:${focus}`, rows: panel(width, {title: overlay.spec.title, meta}, [...body.slice(scroll, scroll + visible).map((entry) => entry.row), ...tail])};
};

export const viewerRows = (overlay: Extract<TuiOverlay, {kind: 'viewer'}>, inner: number): Row[] => overlay.spec.lines()
  .flatMap((line) => prose(inner, line.text, line.tone).map((row) => line.bold ? row.map((item) => ({...item, style: {...item.style, bold: true}})) : row));

export interface BarItem {
  key: string;
  label: string;
  actionId?: string;
}

/** The hotkey bar while a dialog is open: only keys that work in it right now. */
export const overlayBar = (overlay: TuiOverlay): BarItem[] => {
  const close = {key: 'Esc', label: overlay.back ? 'Back' : 'Cancel', actionId: 'dlg:cancel'};
  if (overlay.kind === 'busy') return [{key: '…', label: 'Please wait'}];
  if (overlay.kind === 'message') return [
    {key: 'Enter', label: 'Close', actionId: 'dlg:close'},
    ...(overlay.copyValue ? [{key: 'c', label: 'Copy to clipboard', actionId: 'dlg:copy'}] : []),
  ];
  if (overlay.kind === 'confirm') return [
    ...(overlay.expected !== undefined ? [{key: 'Type', label: overlay.expected}] : []),
    {key: 'Enter', label: capitalize(overlay.confirmLabel), actionId: 'dlg:confirm'}, close,
  ];
  if (overlay.kind === 'menu') return [{key: '↑↓', label: 'Select'}, {key: 'Enter', label: 'Choose'}, close];
  if (overlay.kind === 'viewer') return [
    {key: '↑↓ PgUp PgDn', label: 'Scroll'},
    ...(overlay.spec.actions ?? []).map((item) => ({key: item.key, label: item.label, actionId: `dlg:act:${item.key}`})),
    {key: 'Esc', label: overlay.back ? 'Back' : 'Close', actionId: 'dlg:close'},
  ];
  const items = overlay.spec.items();
  const item = findDialogItem(items, dialogFocus(overlay, items));
  const kind = item && 'kind' in item ? item.kind : item ? 'button' : 'footer';
  return [
    {key: '↑↓', label: 'Field'},
    ...(kind === 'choice' ? [{key: '←→', label: 'Change'}, {key: 'Space', label: 'List'}]
      : kind === 'number' ? [{key: '←→', label: 'Adjust'}]
        : kind === 'check' || kind === 'toggle' ? [{key: 'Space', label: 'Toggle'}]
          : kind === 'button' ? [{key: 'Enter', label: 'Press'}] : []),
    ...(overlay.spec.submit ? [{key: 'Ctrl+S', label: capitalize(overlay.spec.submit.label), actionId: 'dlg:submit'}] : []),
    ...(kind === 'text' || kind === 'number' ? [{key: 'Ctrl+U', label: 'Clear'}] : []),
    close,
  ];
};

/** Wraps the simple list forms in a dialog: each field keeps its own value. */
export const formDialog = (title: string, description: string, fields: FormField[], submitLabel: string,
  onSubmit: (values: Record<string, string>) => Promise<void>): Extract<TuiOverlay, {kind: 'dialog'}> => {
  const values = () => Object.fromEntries(fields.map((field) => [field.id, field.value]));
  const overlay: Extract<TuiOverlay, {kind: 'dialog'}> = {kind: 'dialog', scroll: 0, spec: {
    title, description,
    items: () => fields.map((field): DialogItem => field.kind === 'choice'
      ? {kind: 'choice', id: field.id, label: field.label, value: field.value, choices: field.choices ?? [], onChange: (value) => { field.value = value; }}
      : {kind: 'text', id: field.id, label: field.label, value: field.value, secret: field.kind === 'secret', required: field.required, hint: field.hint, onChange: (value) => { field.value = value; }}),
    submit: {label: submitLabel, run: async () => {
      const missing = fields.find((field) => field.required && !field.value.trim());
      if (missing) {
        overlay.focus = missing.id;
        throw new Error(`${missing.label} is required.`);
      }
      await onSubmit(values());
    }},
    meta: () => {
      const index = fields.findIndex((field) => field.id === overlay.focus);
      return fields.length > 6 && index >= 0 ? `field ${index + 1} of ${fields.length}` : undefined;
    },
  }};
  return overlay;
};

