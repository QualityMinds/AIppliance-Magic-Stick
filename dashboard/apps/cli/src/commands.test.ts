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
});
