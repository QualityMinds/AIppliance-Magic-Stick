import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BANNER_HEIGHT} from './banner';
import {createDemoRuntime} from './demo';
import {loadSnapshot} from './snapshot';
import {renderTui, runTui, type TuiOptions} from './tui';

const started = async (options: TuiOptions) => {
  const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
  const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 121, rows: 40});
  const writes: string[] = [];
  stdout.on('data', (value: Buffer) => writes.push(value.toString()));
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
  const settle = async () => { for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const key = async (value: string) => { stdin.emit('data', Buffer.from(value)); await settle(); };
  const running = runTui(createDemoRuntime(), {color: false, demo: true, ...options});
  await settle();
  return {writes, key, running, close: async () => { await key('\x03'); stdin.destroy(); stdout.destroy(); }};
};

afterEach(() => vi.restoreAllMocks());

describe('mouse pointer on the appliance console', () => {
  it('draws the pointer as a block below the banner', async () => {
    const snapshot = await loadSnapshot(createDemoRuntime().api);
    const row = BANNER_HEIGHT + 4;
    const plain = renderTui(snapshot, {pointer: {x: 30, y: row}}, 121, 40, false).split('\n');
    expect(Array.from(plain[row]!)[30]).toBe('█');
    expect(renderTui(snapshot, {pointer: {x: 30, y: row}}, 121, 40, true).split('\n')[row]).toContain('\x1b[1;33;7m');
    const overBanner = renderTui(snapshot, {pointer: {x: 30, y: 2}, banner: {elapsedMs: 0, seed: 1}}, 121, 40, false);
    expect(overBanner).toBe(renderTui(snapshot, {banner: {elapsedMs: 0, seed: 1}}, 121, 40, false));
  });

  it('asks for movement reports and repaints only the rows the pointer touched', async () => {
    const io = await started({pointer: true});
    try {
      expect(io.writes.join('')).toContain('\x1b[?1000h\x1b[?1006h\x1b[?1003h');
      const before = io.writes.length;
      await io.key('\x1b[<35;31;12M');
      const moved = io.writes.slice(before).filter((write) => !write.startsWith('\x1b[H'));
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatch(/^\x1b\[12;1H[^\n]*█[^\n]*\x1b\[K$/);

      const again = io.writes.length;
      await io.key('\x1b[<35;31;14M');
      const next = io.writes.slice(again).filter((write) => !write.startsWith('\x1b[H'));
      expect(next).toHaveLength(1);
      expect(next[0]).toMatch(/^\x1b\[12;1H[^█]*\x1b\[K\x1b\[14;1H[^\n]*█/);

      // A click still works and the full repaint keeps the pointer.
      await io.key('\x1b[<0;5;11M');
      const full = [...io.writes].reverse().find((write) => write.includes('AI Appliance Dashboard')) ?? '';
      expect(full).toContain('INSTALLED MODELS');
      expect(Array.from(full.split('\n')[10]!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))[4]).toBe('█');
      await io.key('q');
      await io.running;
      expect(io.writes.at(-1)).toContain('\x1b[?1003l');
    } finally { await io.close(); }
  });

  it('leaves the pointer to the terminal everywhere else', async () => {
    const io = await started({});
    try {
      expect(io.writes.join('')).toContain('\x1b[?1000h\x1b[?1006h');
      expect(io.writes.join('')).not.toContain('\x1b[?1003h');
      const before = io.writes.length;
      await io.key('\x1b[<35;31;12M');
      expect(io.writes.slice(before).filter((write) => !write.startsWith('\x1b[H'))).toHaveLength(0);
      expect(io.writes.join('')).not.toContain('█');
    } finally { await io.close(); }
  });
});
