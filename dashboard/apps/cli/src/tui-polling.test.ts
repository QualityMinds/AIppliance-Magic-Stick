import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDemoRuntime} from './demo';
import {runTui} from './tui';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('terminal dashboard polling', () => {
  it('polls a page\'s own data quickly and the shared state only at the normal interval', async () => {
    vi.useFakeTimers();
    const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
    const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 121, rows: 45});
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
    const runtime = createDemoRuntime();
    const session = vi.spyOn(runtime.api, 'session');
    const users = vi.spyOn(runtime.api, 'users');
    const hosts = vi.spyOn(runtime.api, 'hostManagement');
    const running = runTui(runtime, {refreshSeconds: 15});
    const key = (value: string) => stdin.emit('data', Buffer.from(value));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hosts).not.toHaveBeenCalled();
      key('7'); // System; move along the section bar to a section that shows the computers.
      key('l'); for (let step = 0; step < 5; step += 1) key('\t');
      key('\r');
      await vi.advanceTimersByTimeAsync(0);
      expect(hosts).toHaveBeenCalledTimes(1);
      expect(session).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(11_000);
      // Host operations poll every 5 seconds without reloading users or the session.
      expect(hosts.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(session).toHaveBeenCalledTimes(1);
      expect(users).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session).toHaveBeenCalledTimes(2);
      expect(users).toHaveBeenCalledTimes(2);
      key('q');
      expect(await running).toBe('quit');
    } finally { stdin.destroy(); stdout.destroy(); }
  });
});
