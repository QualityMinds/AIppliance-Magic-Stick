const visibleLength = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '').length;

// Preserve ASCII art/table spacing and SGR resets when fitting a screen row.
export const clipTerminalLine = (value: string, columns: number) => {
  let remaining = Math.max(0, columns);
  return (value.match(/\x1b\[[0-9;]*m|[^\x1b]/gu) ?? [])
    .filter((part) => part.startsWith('\x1b') || remaining-- > 0).join('');
};

export const table = (headers: string[], rows: Array<Array<string | number | undefined>>) => {
  const normalized = rows.map((row) => row.map((value) => String(value ?? '')));
  const widths = headers.map((header, column) => Math.max(
    visibleLength(header),
    ...normalized.map((row) => visibleLength(row[column] ?? '')),
  ));
  const render = (row: string[]) => row.map((value, column) => value.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
  return [render(headers), render(widths.map((width) => '─'.repeat(width))), ...normalized.map(render)].join('\n');
};

export const stringify = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const truncate = (value: unknown, maximum = 70) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
};

export const phase = (value?: string) => value || 'Unknown';
