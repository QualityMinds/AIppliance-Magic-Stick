import {describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {Runtime} from './runtime';
import {runCli, VERSION} from './commands';

const io = () => {
  let stdout = '';
  let stderr = '';
  return {
    supplied: {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
      readStdin: async () => '',
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

const runtime = (api: Partial<MagicStickApi>): Runtime => ({
  api: api as MagicStickApi,
  settings: {apiUrl: 'https://api.magicstick.local', issuer: 'https://id.magicstick.local/realms/magicstick', clientId: 'magicstick-cli'},
  login: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
});

describe('runCli', () => {
  it.each([['tui', '--demo'], ['--demo', 'tui']])('starts an offline preview for %j without constructing a live runtime', async (...argv) => {
    const createRuntime = vi.fn();
    const launch = vi.fn(async () => undefined);
    expect(await runCli(argv, io().supplied, {createRuntime, runTui: launch})).toBe(0);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith(expect.anything(), {demo: true, color: true, refreshSeconds: 15});
  });

  it('rejects the demo flag on live commands before accessing configuration', async () => {
    const createRuntime = vi.fn();
    for (const argv of [['console', '--demo'], ['service', 'enable', 'litellm', '--demo']]) {
      await expect(runCli(argv, io().supplied, {createRuntime})).rejects.toThrow('tui --demo');
    }
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('prints the version without constructing an authenticated runtime', async () => {
    const output = io();
    const createRuntime = vi.fn();
    expect(await runCli(['--version'], output.supplied, {createRuntime})).toBe(0);
    expect(output.stdout()).toBe(`${VERSION}\n`);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('provides machine-readable service output through the shared API client surface', async () => {
    const output = io();
    const modules = vi.fn(async () => ({modules: {litellm: {enabled: true, status: {phase: 'Ready'}}}}));
    await runCli(['service', 'list', '--json'], output.supplied, {createRuntime: async () => runtime({modules} as Partial<MagicStickApi>)});

    expect(modules).toHaveBeenCalledOnce();
    expect(JSON.parse(output.stdout())).toMatchObject({modules: {litellm: {enabled: true}}});
  });

  it('passes the configured interval into the interactive TUI', async () => {
    const output = io();
    const launch = vi.fn(async () => undefined);
    await runCli(['tui', '--refresh', '20', '--no-color'], output.supplied, {
      createRuntime: async () => runtime({}),
      runTui: launch,
    });

    expect(launch).toHaveBeenCalledWith(expect.anything(), {color: false, refreshSeconds: 20});
  });

  it('uses device login before opening the appliance console when no session exists', async () => {
    const output = io();
    const launch = vi.fn(async () => undefined);
    const session = vi.fn()
      .mockRejectedValueOnce(new Error('Not signed in. Run `magicstick login` first.'))
      .mockResolvedValue({subject: '1', username: 'tova', roles: ['magicstick-admin']});
    const consoleRuntime = runtime({session} as Partial<MagicStickApi>);
    consoleRuntime.login = vi.fn(async (_openBrowser, prompt) => prompt?.({
      verificationUri: 'https://id.magicstick.local/device',
      userCode: 'ABCD-EFGH',
    }));

    await runCli(['console'], output.supplied, {
      createRuntime: async () => consoleRuntime,
      runTui: launch,
    });

    expect(consoleRuntime.logout).toHaveBeenCalledOnce();
    expect(consoleRuntime.login).toHaveBeenCalledWith(false, expect.any(Function));
    expect(output.stdout()).toContain('ABCD-EFGH');
    expect(output.stdout()).toContain('Angemeldet als tova');
    expect(launch).toHaveBeenCalledOnce();
  });

  it('does not replace a network failure with a new console login', async () => {
    const output = io();
    const consoleRuntime = runtime({session: vi.fn(async () => { throw new Error('network unavailable'); })} as Partial<MagicStickApi>);

    await expect(runCli(['console'], output.supplied, {
      createRuntime: async () => consoleRuntime,
      runTui: vi.fn(async () => undefined),
    })).rejects.toThrow('network unavailable');

    expect(consoleRuntime.login).not.toHaveBeenCalled();
    expect(consoleRuntime.logout).not.toHaveBeenCalled();
  });

  it('passes an explicit appliance CA to the runtime', async () => {
    const output = io();
    const modules = vi.fn(async () => ({modules: {}}));
    const createRuntime = vi.fn(async () => runtime({modules} as Partial<MagicStickApi>));

    await runCli(['--ca-file', '/tmp/magicstick-ca.crt', 'service', 'list'], output.supplied, {createRuntime});

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({caFile: '/tmp/magicstick-ca.crt'}));
  });

  it('requires an explicit warning when TLS verification is disabled', async () => {
    const output = io();
    const modules = vi.fn(async () => ({modules: {}}));
    const createRuntime = vi.fn(async () => runtime({modules} as Partial<MagicStickApi>));

    await runCli(['--insecure', 'service', 'list'], output.supplied, {createRuntime});

    expect(output.stderr()).toContain('TLS certificate verification is disabled');
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({insecure: true}));
  });
});
