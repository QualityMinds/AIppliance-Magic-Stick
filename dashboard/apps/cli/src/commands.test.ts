import {describe, expect, it, vi} from 'vitest';
import {ApiError, type MagicStickApi} from '@magicstick/dashboard-api-client';
import type {Runtime, SessionKind} from './runtime';
import {ConsoleSignInUnavailableError, LoginCancelledError} from './auth';
import type {TuiOutcome} from './tui';
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
  sessionKind: () => 'none',
  localConsole: false,
});

// The appliance monitor: a saved user login (optional) on top of the automatic console session.
const consoleRuntimeWith = (api: Partial<MagicStickApi>, initial: SessionKind = 'console') => {
  let kind = initial;
  const value = runtime(api);
  value.localConsole = true;
  value.sessionKind = () => kind;
  value.logout = vi.fn(async () => { kind = 'console'; });
  value.login = vi.fn(async (_openBrowser, prompt) => {
    prompt?.({verificationUri: 'https://id.magicstick.local/device', userCode: 'ABCD-EFGH'});
    kind = 'user';
  });
  return value;
};
const quit = () => vi.fn(async (): Promise<TuiOutcome> => 'quit');

describe('runCli', () => {
  const compatibility = {
    schemaVersion: 1, selectedProfile: 'strix-halo', allowExperimental: true,
    profiles: [{id: 'strix-halo', displayName: 'AMD Strix Halo', version: '1', experimental: true, memoryArchitecture: 'unified'}],
    nodes: [{node: 'example-node', memoryArchitecture: 'unified', physicalMemoryMi: 65536, gpuAccessibleMi: 49152, memoryAccountingVerified: false, validation: {OLlama: {state: 'passed' as const, runtimeReady: false, runtimeMessage: 'KubeAI activates with a model.'}, VLLM: {state: 'failed' as const}}}],
  };
  const hardwareRuntime = (roles = ['magicstick-admin']) => runtime({
    status: vi.fn(async () => ({hardwareOperators: {'amd-gpu': {phase: 'Degraded', compatibility}}})),
    session: vi.fn(async () => ({subject: 'example', username: 'example', roles, identityManagementAvailable: false, identityManagementMode: 'external'})),
    enableModule: vi.fn(async () => ({})),
  });

  it('requires experimental acknowledgement and persists the catalog profile', async () => {
    const live = hardwareRuntime();
    await expect(runCli(['hardware', 'profile', 'strix-halo'], io().supplied, {createRuntime: async () => live})).rejects.toThrow('Explicitly acknowledge');
    expect(live.api.enableModule).not.toHaveBeenCalled();
    await runCli(['hardware', 'profile', 'strix-halo', '--allow-experimental'], io().supplied, {createRuntime: async () => live});
    expect(live.api.enableModule).toHaveBeenCalledWith('amd-gpu', {compatibilityProfile: 'strix-halo', allowExperimental: 'true'});
  });

  it('rejects unknown profiles and non-admin mutations without writes', async () => {
    const live = hardwareRuntime();
    await expect(runCli(['hardware', 'profile', 'unknown', '--allow-experimental'], io().supplied, {createRuntime: async () => live})).rejects.toThrow('not available');
    expect(live.api.enableModule).not.toHaveBeenCalled();
    const viewer = hardwareRuntime(['magicstick-viewer']);
    await expect(runCli(['hardware', 'profile', 'upstream'], io().supplied, {createRuntime: async () => viewer})).rejects.toThrow('Administrator');
    expect(viewer.api.enableModule).not.toHaveBeenCalled();
  });

  it('requires confirmation to run bounded GPU validation and retains the saved profile', async () => {
    const live = hardwareRuntime();
    await expect(runCli(['hardware', 'validate'], io().supplied, {createRuntime: async () => live})).rejects.toThrow('--yes');
    await runCli(['hardware', 'validate', '--yes'], io().supplied, {createRuntime: async () => live});
    expect(live.api.enableModule).toHaveBeenCalledWith('amd-gpu', {compatibilityProfile: 'strix-halo', allowExperimental: 'true', validationRequest: expect.stringMatching(/^cli-/)});
  });

  it('reports per-engine validation and shared memory without promising readiness', async () => {
    const output = io();
    await runCli(['hardware', 'list'], output.supplied, {createRuntime: async () => hardwareRuntime()});
    expect(output.stdout()).toContain('passed');
    expect(output.stdout()).toContain('runtime pending');
    expect(output.stdout()).toContain('KubeAI activates with a model.');
    expect(output.stdout()).toContain('failed');
    expect(output.stdout()).toContain('within Linux RAM, not extra');
    expect(output.stdout()).toContain('installed RAM unknown; fixed GPU reservation unknown');
    expect(output.stdout()).toContain('OS-visible shared RAM 64 GiB');
    expect(output.stdout()).toContain('Accounting not verified');
  });

  it.each(['unverified', 'failed', 'stale'] as const)('reports a ready runtime independently of optional %s validation', async (state) => {
    const live = hardwareRuntime();
    vi.mocked(live.api.status).mockResolvedValue({hardwareOperators: {'amd-gpu': {phase: 'Ready', compatibility: {
      ...compatibility, nodes: [{node: 'example-node', eligible: true, validation: {OLlama: {
        state, runtimeReady: true, runtimeMessage: 'Configured image adopted; optional test only.',
      }}}],
    }}}});
    const output = io();
    await runCli(['hardware', 'list'], output.supplied, {createRuntime: async () => live});
    expect(output.stdout()).toContain('Engine validation is optional');
    expect(output.stdout()).toContain(`${state} · runtime ready`);
    expect(output.stdout()).toContain('Configured image adopted; optional test only.');
    expect(live.api.enableModule).not.toHaveBeenCalled();
  });

  it.each([['tui', '--demo'], ['--demo', 'tui']])('starts an offline preview for %j without constructing a live runtime', async (...argv) => {
    const createRuntime = vi.fn();
    const launch = quit();
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
    const launch = quit();
    await runCli(['tui', '--refresh', '20', '--no-color'], output.supplied, {
      createRuntime: async () => runtime({}),
      runTui: launch,
    });

    expect(launch).toHaveBeenCalledWith(expect.anything(), {color: false, refreshSeconds: 20});
  });

  it('uses device login before opening the appliance console when no session exists', async () => {
    const output = io();
    const launch = quit();
    const session = vi.fn()
      .mockRejectedValueOnce(new Error('Not signed in. Run `magicstick login` first.'))
      .mockResolvedValue({subject: '1', username: 'tova', roles: ['magicstick-admin']});
    const consoleRuntime = runtime({session} as Partial<MagicStickApi>);
    let signedIn = true;
    consoleRuntime.sessionKind = () => signedIn ? 'user' : 'none';
    consoleRuntime.logout = vi.fn(async () => { signedIn = false; });
    consoleRuntime.login = vi.fn(async (_openBrowser, prompt) => prompt?.({
      verificationUri: 'https://id.magicstick.local/device',
      userCode: 'ABCD-EFGH',
    }));

    await runCli(['console'], output.supplied, {
      createRuntime: async () => consoleRuntime,
      runTui: launch,
    });

    expect(consoleRuntime.logout).toHaveBeenCalledOnce();
    expect(consoleRuntime.login).toHaveBeenCalledWith(false, expect.any(Function), expect.any(AbortSignal));
    expect(output.stdout()).toContain('ABCD-EFGH');
    expect(output.stdout()).not.toContain('Esc:');
    expect(output.stdout()).toContain('Angemeldet als tova');
    expect(launch).toHaveBeenCalledOnce();
  });

  it('lets the TUI draw a mouse pointer only when the host mouse helper feeds the console', async () => {
    const launch = quit();
    const consoleRuntime = runtime({session: vi.fn(async () => ({subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}))} as Partial<MagicStickApi>);
    consoleRuntime.sessionKind = () => 'user';
    vi.stubEnv('MAGICSTICK_CONSOLE_POINTER', '1');
    try {
      await runCli(['console'], io().supplied, {createRuntime: async () => consoleRuntime, runTui: launch});
      expect(launch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({pointer: true}));
      vi.stubEnv('MAGICSTICK_CONSOLE_POINTER', '0');
      await runCli(['console'], io().supplied, {createRuntime: async () => consoleRuntime, runTui: launch});
      expect(launch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({pointer: false}));
      // A workstation terminal shows its own pointer: the plain tui command never asks for one.
      vi.stubEnv('MAGICSTICK_CONSOLE_POINTER', '1');
      await runCli(['tui'], io().supplied, {createRuntime: async () => consoleRuntime, runTui: launch});
      expect(launch).toHaveBeenLastCalledWith(expect.anything(), expect.not.objectContaining({pointer: true}));
    } finally { vi.unstubAllEnvs(); }
  });

  it('does not replace a network failure with a new console login', async () => {
    const output = io();
    const consoleRuntime = runtime({session: vi.fn(async () => { throw new Error('network unavailable'); })} as Partial<MagicStickApi>);

    await expect(runCli(['console'], output.supplied, {
      createRuntime: async () => consoleRuntime,
      runTui: quit(),
    })).rejects.toThrow('network unavailable');

    expect(consoleRuntime.login).not.toHaveBeenCalled();
    expect(consoleRuntime.logout).not.toHaveBeenCalled();
  });

  it('opens the appliance console with the automatic session and no login prompt', async () => {
    const output = io();
    const launch = quit();
    const session = vi.fn(async () => ({subject: 'console', username: 'service-account-magicstick-console', roles: ['magicstick-admin'], localConsole: true}));
    const consoleRuntime = consoleRuntimeWith({session} as unknown as Partial<MagicStickApi>);

    await runCli(['console'], output.supplied, {createRuntime: async () => consoleRuntime, runTui: launch});

    expect(consoleRuntime.login).not.toHaveBeenCalled();
    expect(consoleRuntime.logout).not.toHaveBeenCalled();
    expect(output.stdout()).toBe('');
    expect(launch).toHaveBeenCalledOnce();
  });

  it('replaces an expired saved user login with the automatic console session', async () => {
    const output = io();
    const launch = quit();
    const session = vi.fn()
      .mockRejectedValueOnce(new Error('The saved login has expired. Run `magicstick login` again.'))
      .mockResolvedValue({subject: 'console', username: 'service-account-magicstick-console', roles: ['magicstick-admin'], localConsole: true});
    const consoleRuntime = consoleRuntimeWith({session} as unknown as Partial<MagicStickApi>, 'user');

    await runCli(['console'], output.supplied, {createRuntime: async () => consoleRuntime, runTui: launch});

    expect(consoleRuntime.logout).toHaveBeenCalledOnce();
    expect(consoleRuntime.login).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
  });

  it.each([
    ['is switched off by an administrator', new ApiError('user role required', 403)],
    ['is not provisioned or rejected', new ConsoleSignInUnavailableError('Automatic console sign-in is not provisioned on this appliance yet.')],
  ])('falls back to the device login when automatic console sign-in %s', async (_name, failure) => {
    const output = io();
    const launch = quit();
    const session = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({subject: '1', username: 'tova', roles: ['magicstick-admin']});
    const consoleRuntime = consoleRuntimeWith({session} as unknown as Partial<MagicStickApi>);

    await runCli(['console'], output.supplied, {createRuntime: async () => consoleRuntime, runTui: launch});

    expect(consoleRuntime.login).toHaveBeenCalledOnce();
    expect(output.stdout()).toContain('ABCD-EFGH');
    expect(launch).toHaveBeenCalledOnce();
  });

  it('does not treat a missing permission of a signed-in user as a reason to log in again', async () => {
    const consoleRuntime = consoleRuntimeWith({session: vi.fn(async () => { throw new ApiError('user role required', 403); })} as unknown as Partial<MagicStickApi>, 'user');

    await expect(runCli(['console'], io().supplied, {createRuntime: async () => consoleRuntime, runTui: quit()})).rejects.toThrow('user role required');

    expect(consoleRuntime.login).not.toHaveBeenCalled();
  });

  it('lets the console switch to another user and return to the automatic session', async () => {
    const output = io();
    const outcomes: TuiOutcome[] = ['switch-user', 'restart-session', 'quit'];
    const launch = vi.fn(async (): Promise<TuiOutcome> => outcomes.shift() ?? 'quit');
    const session = vi.fn(async () => ({subject: '1', username: 'tova', roles: ['magicstick-viewer']}));
    const consoleRuntime = consoleRuntimeWith({session} as unknown as Partial<MagicStickApi>);
    const release = vi.fn();

    await runCli(['console'], output.supplied, {
      createRuntime: async () => consoleRuntime, runTui: launch, cancelOnKey: () => release,
    });

    expect(launch).toHaveBeenCalledTimes(3);
    expect(consoleRuntime.login).toHaveBeenCalledOnce();
    expect(output.stdout()).toContain('Esc: abbrechen');
    expect(output.stdout()).toContain('Angemeldet als tova');
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps the automatic session when switching users is cancelled or fails', async () => {
    for (const failure of [new LoginCancelledError(), new Error('The device login expired before it was completed. Run login again.')]) {
      const output = io();
      const outcomes: TuiOutcome[] = ['switch-user', 'quit'];
      const launch = vi.fn(async (): Promise<TuiOutcome> => outcomes.shift() ?? 'quit');
      const consoleRuntime = consoleRuntimeWith({session: vi.fn(async () => ({subject: 'console', username: 'console', roles: ['magicstick-admin'], localConsole: true}))} as unknown as Partial<MagicStickApi>);
      let cancel = () => undefined as void;
      consoleRuntime.login = vi.fn(async (_openBrowser, _prompt, signal) => {
        cancel();
        if (failure instanceof LoginCancelledError) expect(signal?.aborted).toBe(true);
        throw failure;
      });

      await runCli(['console'], output.supplied, {
        createRuntime: async () => consoleRuntime, runTui: launch,
        cancelOnKey: (abort) => { cancel = failure instanceof LoginCancelledError ? abort : cancel; return () => undefined; },
      });

      expect(launch).toHaveBeenCalledTimes(2);
      expect(consoleRuntime.logout).not.toHaveBeenCalled();
      expect(output.stdout()).toContain(failure instanceof LoginCancelledError ? 'Anmeldung abgebrochen' : 'Anmeldung nicht moeglich');
    }
  });

  it('reads and changes the automatic console sign-in level', async () => {
    const consoleAccess = vi.fn(async () => ({available: true, accessLevel: 'admin' as const}));
    const updateConsoleAccess = vi.fn(async () => ({available: true, accessLevel: 'off' as const}));
    const live = runtime({consoleAccess, updateConsoleAccess} as Partial<MagicStickApi>);

    const read = io();
    await runCli(['console-access'], read.supplied, {createRuntime: async () => live});
    expect(read.stdout()).toContain('Automatic console sign-in: Administrator');

    const write = io();
    await runCli(['console-access', 'set', 'off'], write.supplied, {createRuntime: async () => live});
    expect(updateConsoleAccess).toHaveBeenCalledWith('off');
    expect(write.stdout()).toContain('Off — sign-in required');

    await expect(runCli(['console-access', 'set', 'root'], io().supplied, {createRuntime: async () => live})).rejects.toThrow('off|viewer|operator|admin');
    expect(updateConsoleAccess).toHaveBeenCalledOnce();
  });

  it('passes an explicit appliance CA to the runtime', async () => {
    const output = io();
    const modules = vi.fn(async () => ({modules: {}}));
    const createRuntime = vi.fn(async () => runtime({modules} as Partial<MagicStickApi>));

    await runCli(['--ca-file', '/tmp/magicstick-ca.crt', 'service', 'list'], output.supplied, {createRuntime});

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({caFile: '/tmp/magicstick-ca.crt'}));
  });

  it('rejects the legacy TLS-verification bypass before constructing a runtime', async () => {
    const output = io();
    const createRuntime = vi.fn();

    await expect(runCli(['--insecure', 'service', 'list'], output.supplied, {createRuntime})).rejects.toThrow('--insecure is no longer supported');

    expect(createRuntime).not.toHaveBeenCalled();
  });
});
