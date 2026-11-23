import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {GpuSharingState, ManagedHost} from '@magicstick/dashboard-contracts';
import {createDemoRuntime} from './demo';
import type {Runtime} from './runtime';
import type {DashboardSnapshot} from './snapshot';
import type {ConfirmOptions, TuiContext} from './tui-context';
import type {DialogItem, DialogSpec} from './tui-dialogs';
import {hardwareModule, hardwareNodes} from './tui-hardware';
import {initialPageState} from './tui-state';
import {renderTui, runTui} from './tui';

// Synthetic hardware only: example node names, PCI addresses and sizes.
const host = (overrides: Partial<ManagedHost> = {}): ManagedHost => ({
  name: 'example-node', nodeUid: 'uid-1', bootId: 'boot-1', kernel: '6.8.0-example', available: true, message: 'Host worker ready.',
  plan: {
    id: 'plan-1', state: 'available', message: 'The Strix Halo kernel profile is required.', profileId: 'strix-halo', profileVersion: '1.0',
    gpuProfile: 'strix-halo', experimental: true, packages: {'linux-image-example': '6.9.0-1'}, targetKernel: '6.9.0-example', rebootRequired: true,
    experiment: {id: 'plan-1-experiment', state: 'available', message: 'Two AMD GPUs are not a reviewed combination.', profileId: 'strix-halo', profileVersion: '1.0',
      gpuProfile: 'strix-halo', experimental: true, experimentMode: true, engineValidationAvailable: false, packages: {}, targetKernel: '6.9.0-example', rebootRequired: true},
  },
  gpuMemory: {
    id: 'mem-1', supported: true, message: 'Firmware settings reported.', pciAddress: '0000:c5:00.0', systemMemoryMi: 63488,
    currentCarveoutIndex: 1, currentCarveoutMi: 65536, currentDynamicLimitMi: 32768, stepMi: 1024, minDynamicLimitMi: 1024, systemReserveMi: 16384,
    options: [{index: 0, label: 'Minimum', sizeMi: 512}, {index: 1, label: '64 GB', sizeMi: 65536}],
  },
  ...overrides,
});

const sharing = (overrides: Partial<GpuSharingState> = {}): GpuSharingState => ({
  provider: 'nvidia', backend: 'time-slicing', mode: 'exclusive', managed: true, experimental: false, maxModels: 4,
  nodeName: 'example-gpu', nodeUid: 'uid-2', namespace: 'gpu-operator', expectedRevision: 'rev-7', available: true, reason: '', phase: 'Ready',
  message: '', draAvailable: false, claimName: '', activeModels: 0, admittedModels: [], memoryIsolation: false, ...overrides,
});

const snapshot = (roles = ['magicstick-admin']): DashboardSnapshot => ({
  session: {subject: '1', username: 'example-admin', roles, identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'example'}, status: {phase: 'Ready'}},
  modules: {modules: {}, catalogJson: {modules: {}}},
  instances: {instances: {}},
  models: {activations: [], presets: {}, computeTargets: {targets: []}},
  status: {hardwareOperators: {
    'amd-gpu': {
      displayName: 'AMD GPU Operator', phase: 'Ready', detectedNodes: ['example-node'], allocatableResources: 1, operatorVersion: 'v1.0.0', message: 'Synthetic AMD operator.',
      devices: [{id: 'uid-1/0000:c5:00.0', node: 'example-node', nodeUid: 'uid-1', vendor: 'amd', name: 'Radeon 8060S', pciAddress: '0000:c5:00.0', pciId: '1002:1586',
        architecture: 'gfx1151', hostDriver: 'amdgpu', hostDriverReady: true, resourceRegistered: true, memoryArchitecture: 'unified',
        memory: {node: 'example-node', installedMemoryMi: 131072, firmwareReservedMi: 65536, physicalMemoryMi: 63488, gpuAccessibleMi: 49152, gpuAllocationMode: 'firmware-reserved', gpuCapacityMi: 65536, gpuCapacitySource: 'kfd-topology', memoryAccountingVerified: false},
        validationAvailable: true, validation: {OLlama: {state: 'passed', runtimeReady: true, message: 'Smoke test passed.', image: 'registry.example.com/ollama:test'}, VLLM: {state: 'failed', message: 'Synthetic failure.'}}}],
      compatibility: {schemaVersion: 1, selectedProfile: 'strix-halo', allowExperimental: true,
        profiles: [{id: 'strix-halo', displayName: 'Strix Halo', version: '1.0', experimental: true, memoryArchitecture: 'unified', description: 'Synthetic unified-memory profile.'}],
        nodes: [{node: 'example-node', nodeUid: 'uid-1', profileId: 'strix-halo', profileVersion: '1.0', upstreamSupported: false, message: 'Profile matches this node.'}]},
    },
    gpu: {
      displayName: 'NVIDIA GPU Operator', phase: 'Ready', detectedNodes: ['example-gpu'], allocatableResources: 2,
      devices: [{id: 'uid-2/0000:01:00.0', node: 'example-gpu', nodeUid: 'uid-2', vendor: 'nvidia', name: 'Example RTX', pciAddress: '0000:01:00.0', pciId: '10de:2684',
        memoryTotalMi: 24576, validationAvailable: false, validationReason: 'Waiting for fresh physical GPU inventory from the host.'}],
    },
  }},
  hosts: {nodes: [host(), host({name: 'example-gpu', nodeUid: 'uid-2', bootId: 'boot-2', plan: null, gpuMemory: null})]},
  gpuSharing: {providers: [sharing(), sharing({provider: 'amd', nodeName: 'example-node', nodeUid: 'uid-1', device: {name: 'Radeon 8060S', pool: 'gpu', pciAddress: '0000:c5:00.0'}})]},
  loadedAt: Date.now(),
});

const hardware = (data: DashboardSnapshot, ui: Record<string, string> = {}, expanded: Record<string, boolean> = {}) =>
  renderTui(data, {page: 'system', systemSection: 'hardware', ui, expanded}, 121, 400, false);

/** A context that records dialogs and confirmations instead of drawing them. */
const harness = (data: DashboardSnapshot) => {
  const calls = {
    requestHostOperation: vi.fn(async () => ({accepted: true, requestId: 'a'.repeat(32), operation: {phase: 'Pending'}})),
    configureGpuSharing: vi.fn(async () => ({accepted: true, mode: 'shared'})),
    enableModule: vi.fn(async () => ({})),
    requestGpuValidation: vi.fn(async () => ({accepted: true, requestId: 'dashboard-example'})),
  };
  const dialogs: DialogSpec[] = [];
  const confirms: ConfirmOptions[] = [];
  const messages: Array<{title: string; lines: string | string[]}> = [];
  const results: string[][] = [];
  const view = initialPageState({page: 'system', systemSection: 'hardware'});
  const ctx = {
    api: calls as unknown as MagicStickApi, view, demo: false,
    snapshot: () => data, session: () => data.session, draw: () => undefined, refresh: async () => undefined,
    message: (title: string, lines: string | string[]) => { messages.push({title, lines}); },
    perform: async (_title: string, operation: () => Promise<{lines?: string[]} | void>) => { results.push((await operation())?.lines ?? []); },
    task: async () => undefined, load: async () => undefined,
    confirm: (options: ConfirmOptions) => { confirms.push(options); },
    form: () => undefined, dialog: (spec: DialogSpec) => { dialogs.push(spec); }, menu: () => undefined, viewer: () => undefined,
    current: () => undefined, close: () => undefined, copy: () => undefined, saveAs: () => undefined, openFile: () => undefined,
    requestId: () => 'a'.repeat(32), missing: () => { messages.push({title: 'missing', lines: []}); },
  } as TuiContext;
  const act = (id: string) => {
    const [scope = '', verb = '', ...rest] = id.split(':');
    return hardwareModule.handle(ctx, {id, scope, verb, target: rest.join(':')});
  };
  const item = <K extends DialogItem['kind']>(spec: DialogSpec, id: string) => spec.items().find((entry) => 'id' in entry && entry.id === id) as Extract<DialogItem, {kind: K}>;
  return {calls, dialogs, confirms, messages, results, view, act, item};
};

afterEach(() => vi.restoreAllMocks());

describe('terminal Hardware section', () => {
  it('builds the GPU nodes like the browser, including legacy placeholder devices', () => {
    const data = snapshot();
    expect(hardwareNodes(data).map((entry) => [entry.key, entry.devices.map((device) => device.id), entry.host?.name])).toEqual([
      ['uid-1', ['uid-1/0000:c5:00.0'], 'example-node'],
      ['uid-2', ['uid-2/0000:01:00.0'], 'example-gpu'],
    ]);
    const legacy = snapshot();
    legacy.status.hardwareOperators!['amd-gpu']!.devices = [];
    legacy.status.hardwareOperators!.gpu!.devices = [];
    expect(hardwareNodes(legacy).map((entry) => entry.devices.map((device) => [device.id, device.validationAvailable]))).toEqual([
      [['uid-1/legacy-amd', false]],
      [['uid-2/legacy-nvidia', false]],
    ]);
  });

  it('shows operators, host preparation, devices and validation results with administrator controls', () => {
    const page = hardware(snapshot(), {}, {'hw:dev:uid-1/0000:c5:00.0': true, 'hw:dev:uid-2/0000:01:00.0': true});
    expect(page).toContain('[ Refresh hardware ]');
    expect(page).toContain('1 nodes · 1 GPU resources · v1.0.0');
    expect(page).toContain('Node: example-node');
    expect(page).toContain('Upstream operator recognition');
    expect(page).toContain('Not recognized');
    expect(page).toContain('Planned kernel');
    expect(page).toContain('6.9.0-example');
    expect(page).toContain('linux-image-example = 6.9.0-1');
    expect(page).toContain('[ ] Experiment mode — test an unreviewed hardware combination');
    expect(page).toContain('[ ] I accept the experimental profile and its limitations.');
    expect(page).toContain('[ Review hardware preparation ]');
    expect(page).toContain('▼ GPU Configuration AMD · Radeon 8060S · 0000:c5:00.0');
    expect(page).toContain('Physical memory layout · example-node');
    expect(page).toContain('Driver-reported GPU capacity');
    expect(page).toContain('Strix Halo · 1.0 · Experimental');
    expect(page).toContain('[ Change profile ]');
    expect(page).toContain('Current dynamic GPU ceiling (TTM)');
    expect(page).toContain('[ Configure memory ]');
    expect(page).toContain('▼ GPU Configuration NVIDIA · Example RTX · 0000:01:00.0');
    expect(page).toContain('Dedicated GPU memory');
    expect(page).toContain('24 GiB');
    expect(page).toContain('[ Configure sharing ]');
    expect(page).toContain('Exclusive · one model per GPU');
    expect(page).toContain('● GPU smoke passed');
    expect(page).toContain('● Runtime Ready');
    expect(page).toContain('[ Verify Ollama ]');
    expect(page).not.toContain('validationRequest');

    const viewer = hardware(snapshot(['magicstick-viewer']), {}, {'hw:dev:uid-1/0000:c5:00.0': true});
    expect(viewer).toContain('Physical memory layout · example-node');
    expect(viewer).toContain('Administrator access is required to change profiles or run validation.');
    expect(viewer).not.toMatch(/Change profile|Configure memory|Configure sharing|Verify Ollama|Review hardware|Experiment mode/);
  });

  it('shows loading and error states for the per-page host data', () => {
    const loading = {...snapshot(), hosts: undefined, gpuSharing: undefined};
    expect(hardware(loading)).toContain('Loading computer information…');
    const failed = {...snapshot(), hosts: undefined, errors: {hosts: 'HTTP 503', gpuSharing: 'HTTP 502'}};
    expect(hardware(failed)).toContain('Computer information could not be loaded: HTTP 503');
    expect(hardware(failed)).toContain('GPU sharing state could not be loaded: HTTP 502');
  });

  it('prepares hardware only after acknowledgement and the exact computer name, with the plan identity', async () => {
    const data = snapshot();
    const {calls, confirms, messages, view, act} = harness(data);
    act('host:prepare:uid-1');
    expect(messages.at(-1)?.title).toBe('Acknowledgement required');
    act('hwui:ack:uid-1');
    expect(hardware(data, view.ui)).toContain('[x] I accept the experimental profile and its limitations.');
    act('host:prepare:uid-1');
    const confirm = confirms.at(-1)!;
    expect(confirm.expected).toBe('example-node');
    expect(confirm.description).toContain('This authorizes package preparation and one orderly restart after preparation.');
    expect(calls.requestHostOperation).not.toHaveBeenCalled();
    await confirm.onConfirm();
    expect(calls.requestHostOperation).toHaveBeenCalledWith({
      action: 'prepare-gpu', nodeName: 'example-node', nodeUid: 'uid-1', bootId: 'boot-1', requestId: 'a'.repeat(32), confirmation: 'example-node',
      acknowledgeDisruption: true, allowExperimental: true, experimentMode: false, planId: 'plan-1',
    });
    expect(hardware(data, view.ui)).toContain('Preparation requested. Progress continues on the computer');

    // Experiment mode switches to the experimental plan and requires a new acknowledgement.
    act('hwui:experiment:uid-1');
    expect(hardware(data, view.ui)).toContain('[ ] I accept the experimental profile, the unreviewed GPU combination');
    expect(hardware(data, view.ui)).toContain('Engine validation is unavailable for this multi-AMD layout.');
    act('hwui:ack:uid-1');
    act('host:prepare:uid-1');
    expect(confirms.at(-1)!.title).toBe('Start hardware experiment');
    expect(confirms.at(-1)!.description).toContain('This GPU combination is unreviewed.');
    await confirms.at(-1)!.onConfirm();
    expect(calls.requestHostOperation).toHaveBeenLastCalledWith(expect.objectContaining({experimentMode: true, allowExperimental: true, planId: 'plan-1-experiment'}));
  });

  it('applies GPU sharing only when changed, with the provider revision', async () => {
    const {calls, dialogs, confirms, act, item} = harness(snapshot());
    act('gpu:sharing:uid-2|uid-2/0000:01:00.0');
    const spec = dialogs.at(-1)!;
    expect(spec.submit!.disabled!()).toBe('No changes to apply.');
    const backend = item<'choice'>(spec, 'backend');
    expect(backend.choices.find((entry) => entry.value === 'dra')?.disabled).toContain('not available');
    item<'choice'>(spec, 'mode').onChange('shared');
    item<'number'>(spec, 'maxModels').onChange('20');
    expect(spec.submit!.disabled!()).toBe('Enter 2 to 16 simultaneous models.');
    item<'number'>(spec, 'maxModels').onChange('3');
    expect(spec.submit!.disabled!()).toBeUndefined();
    await spec.submit!.run();
    expect(confirms.at(-1)!.confirmLabel).toBe('Apply and restart NVIDIA models');
    await confirms.at(-1)!.onConfirm();
    expect(calls.configureGpuSharing).toHaveBeenCalledWith({
      provider: 'nvidia', mode: 'shared', maxModels: 3, nodeName: 'example-gpu', nodeUid: 'uid-2', expectedRevision: 'rev-7',
      allocationBackend: 'device-plugin', acknowledgeSharing: true, acknowledgeRestart: true,
    });
  });

  it('saves the AMD runtime profile through the shared compatibility parameters', async () => {
    const {calls, dialogs, act, item} = harness(snapshot());
    act('gpu:profile:uid-1');
    const spec = dialogs.at(-1)!;
    expect(spec.submit!.disabled!()).toBe('No changes to save.');
    item<'choice'>(spec, 'profile').onChange('');
    expect(spec.submit!.disabled!()).toBeUndefined();
    await spec.submit!.run();
    expect(calls.enableModule).toHaveBeenCalledWith('amd-gpu', {compatibilityProfile: '', allowExperimental: 'false'});
    item<'choice'>(spec, 'profile').onChange('strix-halo');
    expect(spec.submit!.disabled!()).toBe('Accept the experimental hardware profile first.');
  });

  it('reviews shared GPU memory within the CPU/OS allowance and sends the host operation', async () => {
    const {calls, dialogs, confirms, act, item} = harness(snapshot());
    act('host:memory:uid-1');
    const spec = dialogs.at(-1)!;
    expect(spec.submit!.disabled!()).toBe('Change the fixed reservation or the dynamic limit first.');
    const dynamic = item<'number'>(spec, 'dynamic');
    expect(dynamic.max).toBe(47104);
    dynamic.onChange('48128');
    expect(spec.submit!.disabled!()).toContain('does not leave enough Linux RAM');
    dynamic.onChange('40960');
    expect(spec.submit!.disabled!()).toBeUndefined();
    // A smaller firmware reservation raises the allowed dynamic ceiling.
    item<'choice'>(spec, 'fixed').onChange('0');
    expect(item<'number'>(spec, 'dynamic').max).toBe(111616);
    item<'choice'>(spec, 'fixed').onChange('1');
    await spec.submit!.run();
    const confirm = confirms.at(-1)!;
    expect(confirm.expected).toBe('example-node');
    expect(confirm.description).toContain('Changing only the dynamic limit requires one restart.');
    await confirm.onConfirm();
    expect(calls.requestHostOperation).toHaveBeenCalledWith({
      action: 'configure-gpu-memory', nodeName: 'example-node', nodeUid: 'uid-1', bootId: 'boot-1', requestId: 'a'.repeat(32), confirmation: 'example-node',
      acknowledgeDisruption: true, allowExperimental: true, experimentMode: false, planId: 'mem-1', gpuMemory: {carveoutIndex: 1, dynamicLimitMi: 40960},
    });
  });

  it('requests engine validation for the selected physical GPUs with a dashboard request id', async () => {
    const {calls, dialogs, act, item} = harness(snapshot());
    act('gpu:verify-VLLM:uid-1');
    const spec = dialogs.at(-1)!;
    expect(item<'choice'>(spec, 'selection').choices.map((entry) => entry.value)).toEqual(['all', 'uid-1/0000:c5:00.0']);
    expect(spec.submit!.disabled!()).toBeUndefined();
    await spec.submit!.run();
    expect(calls.requestGpuValidation).toHaveBeenCalledWith({
      nodeName: 'example-node', nodeUid: 'uid-1', engine: 'VLLM', deviceIds: ['uid-1/0000:c5:00.0'],
      requestId: expect.stringMatching(/^dashboard-[A-Za-z0-9._-]{1,70}$/), acknowledgeResourceUse: true,
    });
    act('gpu:verify-OLlama:uid-2');
    expect(dialogs.at(-1)!.submit!.disabled!()).toContain('Waiting for fresh physical GPU inventory');
    expect(calls.enableModule).not.toHaveBeenCalled();
  });
});

describe('terminal Computer power', () => {
  const power = (data: DashboardSnapshot, ui: Record<string, string> = {}) => renderTui(data, {page: 'system', systemSection: 'power', ui}, 121, 60, false);

  it('shows the selected computer, its operation and the unreachable-after-accept notice', () => {
    const data = snapshot();
    data.hosts!.nodes[0]!.operation = {requestId: 'b'.repeat(32), action: 'reboot', phase: 'RebootScheduled', message: 'Restart in one minute.'};
    const page = power(data);
    expect(page).toContain('[ Change computer ]');
    expect(page).toContain('Kernel: 6.8.0-example · Host worker ready.');
    expect(page).toContain('reboot · RebootScheduled');
    expect(page).toContain('All workloads on this computer will be interrupted.');
    expect(page).toMatch(/\[ Restart computer \]/);
    expect(power(data, {'power.host': 'example-gpu'})).toContain('example-gpu');
    const unreachable = {...snapshot(), hosts: undefined, errors: {hosts: 'HTTP 503'}};
    expect(power(unreachable, {'power.accepted': 'x'})).toContain('The request was accepted, but the computer is currently unreachable.');
    expect(power(unreachable)).toContain('Computer information could not be loaded: HTTP 503');
  });

  it('restarts the computer only after typing its exact name', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    const demo = createDemoRuntime();
    const data = snapshot();
    const requestHostOperation = vi.fn(async () => ({accepted: true, requestId: 'a'.repeat(32), operation: {phase: 'Pending'}}));
    const api = Object.assign(Object.create(demo.api) as MagicStickApi, {
      hostManagement: async () => ({nodes: [host()]}),
      gpuSharing: async () => data.gpuSharing!,
      requestHostOperation,
    });
    const runtime: Runtime = {...demo, api};
    const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
    const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 121, rows: 48});
    const writes: string[] = [];
    stdout.on('data', (value: Buffer) => writes.push(value.toString()));
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
    const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
    const screen = () => ([...writes].reverse().find((write) => write.includes('AI Appliance Dashboard')) ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const key = async (value: string) => { stdin.emit('data', Buffer.from(value)); await settle(); };
    const click = async (label: string) => {
      const rows = screen().split('\n');
      const row = rows.findIndex((line) => line.includes(label));
      if (row < 0) throw new Error(`Not on screen: ${label}`);
      await key(`\x1b[<0;${Array.from(rows[row]!.slice(0, rows[row]!.indexOf(label))).length + 2};${row + 1}M`);
    };
    const running = runTui(runtime, {color: false});
    try {
      await settle();
      await key('7'); // System
      await key('s'); // System Status → Computer power
      expect(screen()).toContain('[ Restart computer ]');
      await click('[ Restart computer ]');
      expect(screen()).toContain('Restart this computer in about one minute');
      await key('\r');
      expect(requestHostOperation).not.toHaveBeenCalled();
      await key('example-node');
      await key('\r');
      expect(requestHostOperation).toHaveBeenCalledWith({
        action: 'reboot', nodeName: 'example-node', nodeUid: 'uid-1', bootId: 'boot-1', requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
        confirmation: 'example-node', acknowledgeDisruption: true, allowExperimental: false, experimentMode: false,
      });
      expect(screen()).toContain('Restart computer was requested for example-node.');
    } finally {
      stdin.emit('data', Buffer.from('\x03'));
      await running;
      vi.useRealTimers();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
