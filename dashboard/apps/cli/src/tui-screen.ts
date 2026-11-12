// Layout primitives for the terminal dashboard: styled spans, fixed-width rows,
// web-like panels and a cell canvas that records where interactive elements land.
// Glyphs stay within the Linux console font so the attached monitor renders them.

export type Tone = 'normal' | 'dim' | 'good' | 'bad' | 'warn' | 'accent';

export interface Style {
  tone?: Tone;
  bold?: boolean;
  inverse?: boolean;
}

/** Something the cursor or the mouse can activate. The id is dispatched by the TUI runtime. */
export interface Action {
  id: string;
  /** Shown beside Enter in the hotkey bar. */
  label: string;
  /** Why the element cannot be used right now; it stays focusable so the reason can be shown. */
  disabled?: string;
}

export interface Span {
  text: string;
  style?: Style;
  action?: Action;
}

export type Row = Span[];

export type Zone = 'header' | 'nav' | 'content' | 'dialog' | 'bar';

export interface Target {
  action: Action;
  zone: Zone;
  x: number;
  y: number;
  width: number;
}

export const textWidth = (value: string) => Array.from(value).length;
export const rowWidth = (row: Row) => row.reduce((total, span) => total + textWidth(span.text), 0);

export const span = (text: string, tone?: Tone, bold = false): Span => ({text, style: tone || bold ? {tone, bold} : undefined});
export const gap = (width = 1): Span => ({text: ' '.repeat(Math.max(0, width))});

export const clipText = (value: string, width: number) => {
  const characters = Array.from(value);
  if (characters.length <= width) return value;
  return width <= 1 ? characters.slice(0, Math.max(0, width)).join('') : `${characters.slice(0, width - 1).join('')}…`;
};

const clipRow = (row: Row, width: number): Row => {
  const result: Row = [];
  let remaining = width;
  for (const item of row) {
    if (remaining <= 0) break;
    const size = textWidth(item.text);
    result.push(size <= remaining ? item : {...item, text: clipText(item.text, remaining)});
    remaining -= Math.min(size, remaining);
  }
  return result;
};

/** A row of exactly `width` cells: `left` starts at the left edge, `right` ends at the right edge. */
export const fit = (width: number, left: Row, right: Row = []): Row => {
  const end = clipRow(right, width);
  const endWidth = rowWidth(end);
  const start = clipRow(left, Math.max(0, width - endWidth - (endWidth && left.length ? 1 : 0)));
  return [...start, gap(width - rowWidth(start) - endWidth), ...end];
};

export const wrapText = (value: string, width: number): string[] => {
  const rows: string[] = [];
  for (const paragraph of String(value).split('\n')) {
    let row = '';
    for (const word of paragraph.split(' ')) {
      if (row && textWidth(`${row} ${word}`) > width) {
        rows.push(row);
        row = word;
      } else row = row ? `${row} ${word}` : word;
      while (textWidth(row) > width && width > 0) {
        rows.push(Array.from(row).slice(0, width).join(''));
        row = Array.from(row).slice(width).join('');
      }
    }
    rows.push(row);
  }
  return rows;
};

export const prose = (width: number, value: string, tone?: Tone): Row[] => wrapText(value, width).map((line) => fit(width, [span(line, tone)]));

export type ButtonKind = 'ghost' | 'primary' | 'danger';

export const button = (id: string, label: string, kind: ButtonKind = 'ghost', disabled?: string): Span => ({
  text: `[ ${label} ]`,
  style: disabled ? {tone: 'dim'} : kind === 'primary' ? {tone: 'accent', bold: true} : kind === 'danger' ? {tone: 'bad'} : undefined,
  action: {id, label, ...(disabled ? {disabled} : {})},
});

/** A pressed/unpressed choice in a filter or section bar. */
export const choice = (id: string, label: string, active: boolean): Span => ({
  text: active ? `[■ ${label} ]` : `[ ${label} ]`,
  style: active ? {tone: 'accent', bold: true} : undefined,
  action: {id, label},
});

export const toggle = (id: string, label: string, open: boolean): Span => ({
  text: `${open ? '▼' : '►'} ${label}`,
  action: {id, label: open ? 'Collapse' : 'Expand'},
});

export const link = (url: string): Span => ({text: `→ ${url}`, style: {tone: 'accent'}, action: {id: `link:${url}`, label: 'Show address'}});

export const joinSpans = (items: Span[], spacing = 1): Row => items.flatMap((item, index) => index ? [gap(spacing), item] : [item]);

export const phaseToneOf = (tone: string): Tone => tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : 'dim';

export const badge = (label: string, tone: Tone, filled = true): Span => ({text: `${filled ? '●' : '○'} ${label}`, style: {tone}});

export const progressBar = (value: number, label: string, tone: Tone, size = 24): Row => {
  const filled = Math.round(Math.min(100, Math.max(0, value)) / 100 * size);
  return [span('█'.repeat(filled), tone), span('░'.repeat(size - filled), 'dim'), gap(2), span(label, 'dim')];
};

export interface PanelOptions {
  title: string;
  meta?: string;
  status?: Span;
}

/** A bordered card with the title, meta text and status badge set into the top border, as in the web panels. */
export const panel = (width: number, options: PanelOptions, body: Row[]): Row[] => {
  const inner = Math.max(0, width - 4);
  const statusWidth = options.status ? textWidth(options.status.text) + 4 : 1;
  const title = clipText(options.title, Math.max(4, width - statusWidth - 6));
  const metaRoom = width - statusWidth - textWidth(title) - 10;
  const meta = options.meta && metaRoom >= 6 ? clipText(options.meta, metaRoom) : '';
  const head: Row = [span('┌─ ', 'dim'), span(title, undefined, true), span(' ─', 'dim'), ...(meta ? [span('─ ', 'dim'), span(meta, 'dim'), span(' ', 'dim')] : [])];
  const tail: Row = options.status ? [span('─ ', 'dim'), options.status, span(' ─┐', 'dim')] : [span('┐', 'dim')];
  const fill = Math.max(0, width - rowWidth(head) - rowWidth(tail));
  return [
    [...head, span('─'.repeat(fill), 'dim'), ...tail],
    ...body.map((row) => [span('│ ', 'dim'), ...fit(inner, row), span(' │', 'dim')]),
    [span(`└${'─'.repeat(Math.max(0, width - 2))}┘`, 'dim')],
  ];
};

export const divider = (width: number): Row => [span('─'.repeat(width), 'dim')];

export interface Column {
  header: string;
  /** Fixed width; the widest value (capped at `max`) is used when omitted. */
  width?: number;
  max?: number;
}

export interface TableRow {
  cells: Span[];
  actions?: Row;
}

/** Column-aligned rows with right-aligned row actions, like the web tables. */
export const table = (width: number, columns: Column[], rows: TableRow[]): Row[] => {
  const widths = columns.map((column, index) => column.width ?? Math.min(column.max ?? 28, Math.max(
    textWidth(column.header), ...rows.map((row) => textWidth(row.cells[index]?.text ?? '')),
  )));
  const cells = (items: Span[]): Row => items.flatMap((item, index) => {
    const size = widths[index] ?? 0;
    const text = clipText(item.text, size);
    return [{...item, text}, gap(size - textWidth(text) + 2)];
  });
  return [
    fit(width, cells(columns.map((column) => span(column.header, 'dim')))),
    ...rows.map((row) => fit(width, cells(row.cells), row.actions ?? [])),
  ];
};

const SGR: Record<Tone, string> = {normal: '', dim: '2', good: '32', bad: '31', warn: '33', accent: '36'};

const sgr = (style?: Style) => {
  if (!style) return '';
  const codes = [style.bold ? '1' : '', SGR[style.tone ?? 'normal'], style.inverse ? '7' : ''].filter(Boolean);
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
};

export class Canvas {
  readonly targets: Target[] = [];
  private readonly cells: string[][];
  private readonly styles: Array<Array<Style | undefined>>;

  constructor(readonly width: number, readonly height: number) {
    this.cells = Array.from({length: height}, () => Array.from({length: width}, () => ' '));
    this.styles = Array.from({length: height}, () => Array.from({length: width}, () => undefined));
  }

  put(x: number, y: number, text: string, style?: Style) {
    if (y < 0 || y >= this.height) return;
    let column = x;
    for (const character of Array.from(text)) {
      if (column >= 0 && column < this.width) {
        this.cells[y]![column] = character;
        this.styles[y]![column] = style;
      }
      column += 1;
    }
  }

  /** Draws a row and registers its interactive spans; `clip` limits drawing to a vertical window. */
  row(x: number, y: number, row: Row, zone: Zone, clip?: {top: number; bottom: number}) {
    const visible = !clip || (y >= clip.top && y < clip.bottom);
    let column = x;
    for (const item of row) {
      const size = textWidth(item.text);
      if (visible) {
        this.put(column, y, item.text, item.style);
        if (item.action) this.targets.push({action: item.action, zone, x: column, y, width: size});
      }
      column += size;
    }
  }

  /** Greys out everything drawn so far, so a dialog on top reads as modal. */
  dim() {
    for (const row of this.styles) row.fill({tone: 'dim'});
  }

  highlight(target: Target, color: boolean) {
    for (let column = target.x; column < target.x + target.width; column += 1) {
      if (column >= 0 && column < this.width && this.styles[target.y]) this.styles[target.y]![column] = {tone: 'accent', inverse: true, bold: true};
    }
    // Without colours the inverse cursor is invisible: bracket the element instead.
    if (!color && this.cells[target.y]) {
      const cells = this.cells[target.y]!;
      if (cells[target.x - 1] === ' ') cells[target.x - 1] = '►';
      if (cells[target.x + target.width] === ' ') cells[target.x + target.width] = '◄';
    }
  }

  /** Draws the mouse pointer as a solid block over one cell, for terminals that have no pointer of their own. */
  pointer(x: number, y: number, color: boolean) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    if (color) this.styles[y]![x] = {tone: 'warn', inverse: true, bold: true};
    else this.cells[y]![x] = '█';
  }

  lines(color: boolean): string[] {
    return this.cells.map((cells, y) => {
      if (!color) return cells.join('').trimEnd();
      let line = '';
      let current = '';
      cells.forEach((character, x) => {
        const code = sgr(this.styles[y]![x]);
        if (code !== current) {
          line += `${current ? '\x1b[0m' : ''}${code}`;
          current = code;
        }
        line += character;
      });
      return `${line}${current ? '\x1b[0m' : ''}`;
    });
  }
}

export const hitTarget = (targets: Target[], x: number, y: number) => [...targets].reverse()
  .find((target) => y === target.y && x >= target.x && x < target.x + target.width);
