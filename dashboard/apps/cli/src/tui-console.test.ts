import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import {createDemoRuntime} from './demo';
import type {Runtime, SessionKind} from './runtime';
import {runTui} from './tui';

// A live-shaped runtime backed by the synthetic demo data.
const consoleRuntime = (kind: SessionKind, localConsole = true) => {
  const demo = createDemoRuntime();
  const updateConsoleAccess = vi.fn(async (accessLevel: string) => ({available: true, accessLevel}));
  const api = Object.assign(Object.create(demo.api) as MagicStickApi, {
    consoleAccess: async () => ({available: true, accessLevel: 'admin'}),
    updateConsoleAccess,
  });
  const runtime: Runtime = {
    ...demo, api, localConsole,
    sessionKind: () => kind,
    logout: vi.fn(async () => { kind = localConsole ? 'console' : 'none'; }),
  };
  return {runtime, updateConsoleAccess};
};

const terminal = () => {
  const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
  const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 110, rows: 40});
  const writes: string[] = [];
  stdout.on('data', (value: Buffer) => writes.push(value.toString()));
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
  return {
    key: async (value: string) => {
      stdin.emit('data', Buffer.from(value));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    screen: () => [...writes].reverse().find((write) => write.includes('Signed in')) ?? '',
    close: () => { stdin.destroy(); stdout.destroy(); },
  };
};

const started = async (runtime: Runtime) => {
  const io = terminal();
  const running = runTui(runtime, {color: false});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {io, running};
};

afterEach(() => vi.restoreAllMocks());

describe('appliance-console user switching', () => {
  it('asks for a second-device login only after confirmation and keeps the automatic session on cancel', async () => {
    const {runtime} = consoleRuntime('console');
    const {io, running} = await started(runtime);
    try {
      await io.key('x');
      expect(io.screen()).toContain('Sign in as another user');
      expect(io.screen()).toContain('second device');
      await io.key('\u001b');
      expect(io.screen()).not.toContain('Sign in as another user');

      await io.key('x');
      await io.key('\r');
      expect(await running).toBe('switch-user');
      expect(runtime.logout).not.toHaveBeenCalled();
    } finally { io.close(); }
  });

  it('returns a signed-in user to the automatic monitor session', async () => {
    const {runtime} = consoleRuntime('user');
    const {io, running} = await started(runtime);
    try {
      await io.key('x');
      expect(io.screen()).toContain('Return to the automatic monitor session');
      expect(io.screen()).toContain('Sign in as another user');
      await io.key('\r');
      expect(await running).toBe('restart-session');
      expect(runtime.logout).toHaveBeenCalledOnce();
    } finally { io.close(); }
  });

  it('keeps the plain sign-out for a workstation terminal', async () => {
    const {runtime} = consoleRuntime('user', false);
    const {io, running} = await started(runtime);
    try {
      await io.key('x');
      expect(io.screen()).toContain('Sign out');
      expect(io.screen()).not.toContain('automatic');
      await io.key('\r');
      expect(await running).toBe('quit');
      expect(runtime.logout).toHaveBeenCalledOnce();
    } finally { io.close(); }
  });

  it('changes the monitor sign-in level from Settings through the shared API', async () => {
    const {runtime, updateConsoleAccess} = consoleRuntime('console');
    const {io, running} = await started(runtime);
    try {
      await io.key('7'); // System
      await io.key('l'); // into the page: the Settings section button
      await io.key('\r');
      expect(io.screen()).toContain('Automatic sign-in  Administrator');
      await io.key('e');
      expect(io.screen()).toContain('Monitor sign-in');
      await io.key('\r'); // Unchanged level: nothing is sent.
      expect(io.screen()).toContain('already active');
      expect(updateConsoleAccess).not.toHaveBeenCalled();
      await io.key('\u001b[D'); // admin → operator
      await io.key('\r');
      expect(updateConsoleAccess).toHaveBeenCalledWith('operator');
      await io.key('\r');
      await io.key('q');
      expect(await running).toBe('quit');
    } finally { io.close(); }
  });
});
