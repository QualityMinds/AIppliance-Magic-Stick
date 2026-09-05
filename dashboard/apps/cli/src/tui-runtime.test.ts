import {PassThrough} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {createDemoRuntime} from './demo';
import {runTui} from './tui';
import {BANNER_HEIGHT} from './banner';

describe('terminal animation lifecycle', () => {
  it('keeps animating during dialogs without fetching and cleans up on quit', async () => {
    vi.useFakeTimers();
    const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
    const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 100, rows: 30});
    const writes: string[] = [];
    stdout.on('data', (value: Buffer) => writes.push(value.toString()));
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
    const runtime = createDemoRuntime();
    const session = vi.spyOn(runtime.api, 'session');
    const signalListeners = process.listenerCount('SIGTERM');
    const running = runTui(runtime, {demo: true});
    const key = (value: string) => stdin.emit('data', Buffer.from(value));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.join('')).toContain('AIppliance');
      expect(writes.join('')).toContain('Magic Stick');
      await vi.advanceTimersByTimeAsync(125);
      expect(writes.at(-1)?.split('\n')).toHaveLength(BANNER_HEIGHT);
      expect(writes.at(-1)).not.toContain('Overview');
      expect(session).toHaveBeenCalledOnce();

      key('b');
      expect(writes.at(-1)).not.toMatch(/b:|pause|animate|Live actions require/);
      const browsingWrites = writes.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(writes.length).toBeGreaterThan(browsingWrites);
      key('a');
      expect(writes.at(-1)).toContain('Live actions require an appliance connection');
      const dialogWrites = writes.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(writes.length).toBeGreaterThan(dialogWrites);
      for (const repaint of writes.slice(dialogWrites)) {
        expect(repaint.split('\n')).toHaveLength(BANNER_HEIGHT);
        expect(repaint).not.toContain('Live actions require');
      }
      key('\x1b');
      await vi.advanceTimersByTimeAsync(125);
      expect(writes.at(-1)?.split('\n')).toHaveLength(BANNER_HEIGHT);

      stdout.rows = 18;
      stdout.emit('resize');
      expect(writes.at(-1)).not.toContain('AIppliance');
      const smallScreenWrites = writes.length;
      await vi.advanceTimersByTimeAsync(9000);
      expect(writes).toHaveLength(smallScreenWrites);
      expect(session).toHaveBeenCalledOnce();
      stdout.rows = 30;
      stdout.emit('resize');
      expect(writes.at(-1)).toContain('AIppliance');
      expect(writes.at(-1)).not.toContain(' :: |'); // Docking continued while hidden.
      key('q');
      await running;
      expect(vi.getTimerCount()).toBe(0);
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(process.listenerCount('SIGTERM')).toBe(signalListeners);
      const finalWrites = writes.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toHaveLength(finalWrites);
    } finally {
      key('\x03');
      vi.restoreAllMocks();
      vi.useRealTimers();
      stdin.destroy();
      stdout.destroy();
    }
  });
});