import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {ManagedHost, RegressionRun, RegressionStatus} from '@magicstick/dashboard-contracts';
import {createDemoRuntime} from './demo';
import type {Runtime} from './runtime';
import type {DashboardSnapshot} from './snapshot';
import type {ConfirmOptions, PerformResult, TuiContext} from './tui-context';
import type {DialogItem, DialogSpec, FormField, ViewerSpec} from './tui-dialogs';
import {initialPageState, type StatusSectionId} from './tui-state';
import {cacheClearReason, regressionCaseLines, regressionState, statusModule} from './tui-status';
import {renderTui, runTui} from './tui';

const host = (overrides: Partial<ManagedHost> = {}): ManagedHost => ({
  name: 'node-a', nodeUid: 'uid-a', bootId: 'boot-1', kernel: '6.8.0-example', available: true, message: 'Ready',
  modelCache: {supported: true, blocked: false, id: 'cache-plan-1', totalBytes: 500e9, freeBytes: 200e9, reclaimableBytes: 42e9,
    caches: [{id: 'hf', name: 'Hugging Face', usedBytes: 40e9, clearable: true}, {id: 'ollama', name: 'Ollama', usedBytes: 2e9, clearable: true}]},
  ...overrides,
});

const finishedRun = (overrides: Partial<RegressionRun> = {}): RegressionRun => ({
  id: 'run-1', uid: 'uid-run-1', createdAt: '2026-11-20T10:00:00Z', phases: [0, 1], sourceRevision: '0123456789abcdef0123',
  phase: 'Failed', message: 'Tests finished with failures.', reportAvailable: true, credentialsCleaned: true, testMode: 'full',
  progress: {percent: 100, completedPhases: 2, totalPhases: 2},
  cleanup: {state: 'verified'},
  result: {
    counts: {Passed: 10, Failed: 1, Blocked: 2}, executionCounts: {Passed: 4, Failed: 1, Blocked: 1}, recoveryRequired: false, omittedCases: 3,
    blockedCounts: {prerequisite: 1, failure: 1, cancelled: 0, unknown: 0}, excludedSteps: ['phase1.destructive-step'],
    evidenceCounts: {fixture: {Passed: 6, Failed: 0, Blocked: 0}, live: {Passed: 4, Failed: 1, Blocked: 2}},
    phases: [{phase: 1, outcome: 'Failed', counts: {Passed: 10, Failed: 1, Blocked: 2}, executionCounts: {Passed: 4, Failed: 1, Blocked: 1}, blockedCounts: {prerequisite: 1, failure: 1, cancelled: 0, unknown: 0}}],
    cases: [
      {id: 'P1-001', description: 'Creates an instance', outcome: 'Failed', layer: 'api', variant: 'admin', reason: 'API', message: 'HTTP 500', action: 'Check the API logs.', durationMs: 10,
        phase: 1, stage: 'create', tracePath: 'traces/p1-001.json', diagnostics: ['cleanup observation'], causeReason: 'COMPONENT', causeStage: 'deploy'},
      {id: 'P1-002', outcome: 'Blocked', layer: 'live', variant: 'gpu', reason: 'GPU_PROVIDER', message: 'No GPU.', action: 'Attach a GPU.', durationMs: 0,
        blockedBy: {kind: 'prerequisite', caseId: 'P0-003', reason: 'GPU', stage: 'inventory', traceRunId: 'trace-1', executionId: 'exec-1'}, gpuValidationDiagnostics: ['gpu observation']},
    ],
  },
  ...overrides,
});

const regression = (overrides: Partial<RegressionStatus> = {}): RegressionStatus => ({
  registered: true, applianceUid: 'appliance-uid', runtimeAvailable: true, sourceRevision: 'abc', message: 'Runner ready.',
  runs: [finishedRun()], executionLocation: 'appliance-kubernetes', externalRunnerRequired: [],
  cleanup: {available: true, message: 'Previous run can be cleaned up.', revision: 'lock-7'},
  diagnosticSelections: [{id: 'gpu-smoke', title: 'GPU smoke', caseIds: ['P3-001', 'P3-002'], phase: 3}],
  ...overrides,
});

const snapshot = (overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {modules: {}, catalogJson: {modules: {}}},
  instances: {instances: {}},
  models: {activations: [], presets: {}, computeTargets: {targets: []}},
  status: {
    pods: [{name: 'a', phase: 'Running'}, {name: 'b', phase: 'Pending'}],
    services: [{name: 'svc'}], ingresses: [],
    httpRoutes: [{namespace: 'ai', name: 'dashboard', hostnames: ['dashboard.example.com'], accepted: true}, {namespace: 'ai', name: 'chat', hostnames: [], accepted: false}],
    fluxKustomizations: [
      {namespace: 'flux-system', name: 'apps', conditions: [{type: 'Ready', status: 'True', reason: 'ReconciliationSucceeded', message: 'Applied revision main'}]},
      {namespace: 'flux-system', name: 'infra', phase: 'Reconciling', conditions: [{type: 'Ready', status: 'False', reason: 'HealthCheckFailed', message: 'Timeout'}]},
    ],
    hardwareOperators: {
      gpu: {displayName: 'NVIDIA GPU Operator', operatorActive: true, phase: 'Ready', operatorVersion: 'v25.3', driverMode: 'host', detectedNodes: ['node-a'], compatibleNodes: ['node-a'], allocatableResources: 2, managedBy: 'magicstick', needed: true, message: 'All GPUs registered.'},
      amd: {displayName: 'AMD GPU Operator', operatorActive: false, phase: 'Disabled'},
    },
  },
  hosts: {nodes: [host()]},
  regression: regression(),
  loadedAt: Date.now(),
  ...overrides,
});

const screen = (data: DashboardSnapshot, statusSection: StatusSectionId, expanded: Record<string, boolean> = {}, ui: Record<string, string> = {}) =>
  renderTui(data, {page: 'system', systemSection: 'status', statusSection, expanded, ui}, 121, 400, false);

/** A context that records what the area asks the runtime to show. */
const context = (data: DashboardSnapshot, api: Partial<MagicStickApi> = {}) => {
  const recorded = {
    confirms: [] as ConfirmOptions[], dialogs: [] as DialogSpec[], viewers: [] as ViewerSpec[], messages: [] as string[],
    forms: [] as Array<{fields: FormField[]; onSubmit: (values: Record<string, string>) => Promise<void>}>, results: [] as Array<PerformResult | void>,
  };
  const view = initialPageState({page: 'system', systemSection: 'status'});
  const ctx: TuiContext = {
    api: api as MagicStickApi, view, demo: false,
    snapshot: () => data, session: () => data.session, draw: vi.fn(), refresh: vi.fn(async () => undefined),
    message: (title) => { recorded.messages.push(title); },
    perform: async (_title, operation) => { recorded.results.push(await operation()); },
    task: async (_title, operation, then) => { const value = await operation(); then?.(value); },
    load: async (_title, fetch, then) => then(await fetch()),
    confirm: (options) => { recorded.confirms.push(options); },
    form: (_title, _description, fields, _label, onSubmit) => { recorded.forms.push({fields, onSubmit}); },
    dialog: (spec) => { recorded.dialogs.push(spec); },
    menu: vi.fn(), viewer: (spec) => { recorded.viewers.push(spec); },
    current: () => undefined, close: vi.fn(), copy: vi.fn(), saveAs: vi.fn(), openFile: vi.fn(),
    requestId: () => 'f'.repeat(32), missing: () => { recorded.messages.push('missing'); },
  };
  const act = (id: string) => {
    const [scope = '', verb = '', ...rest] = id.split(':');
    return statusModule.handle(ctx, {id, scope, verb, target: rest.join(':')});
  };
  return {ctx, recorded, act};
};

const item = (spec: DialogSpec, id: string) => spec.items().find((entry) => 'id' in entry && entry.id === id) as Extract<DialogItem, {id: string}>;

afterEach(() => vi.restoreAllMocks());

describe('System Status resource sections', () => {
  it('summarises resources like the browser overview', () => {
    const text = screen(snapshot(), 'overview');
    expect(text).toContain('[■ Overview ]');
    expect(text).toContain('1/2');
    expect(text).toContain('running');
    expect(text).toMatch(/GPU operators +1 ready \/ 1 active \/ 2 known/);
    expect(text).toMatch(/Flux +1 \/ 2 ready/);
    expect(text).toMatch(/Gateway routes +1 \/ 2 accepted/);
    expect(text).toContain('[ Refresh status ]');
    // All six tabs stay visible (and clickable) within the 120-column layout.
    expect(text).toContain('[ Network & routes ]  [ Model cache ]');
    expect(text).toMatch(/│ \[ Regression tests \] +│/);
  });

  it('shows operator, Flux and route details on their tabs', () => {
    const operators = screen(snapshot(), 'gpu-operators');
    expect(operators).toContain('1 ready / 1 active / 2 known');
    expect(operators).toMatch(/Version +v25\.3/);
    expect(operators).toMatch(/Detected \/ compatible +1 \/ 1 nodes/);
    expect(operators).toMatch(/Allocatable +2 resource\(s\)/);
    expect(operators).toContain('All GPUs registered.');
    expect(operators).toContain('No status message.');
    const flux = screen(snapshot(), 'flux');
    expect(flux).toContain('flux-system/apps');
    expect(flux).toContain('HealthCheckFailed');
    expect(flux).toContain('Timeout');
    expect(flux).not.toContain('Applied revision main\n'.repeat(2));
    const routes = screen(snapshot(), 'network');
    expect(routes).toContain('→ https://dashboard.example.com/');
    expect(routes).toContain('● Accepted');
    expect(routes).toContain('Pending');
  });

  it('keeps administrator-only tabs away from viewers', () => {
    const viewer = snapshot({session: {subject: '2', username: 'viewer', roles: ['magicstick-viewer'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}});
    const text = screen(viewer, 'regression');
    expect(text).not.toContain('Model cache');
    expect(text).not.toContain('Regression tests');
    expect(text).toContain('[■ Overview ]');
  });
});

describe('model cache', () => {
  it('lists disk usage per computer and explains why clearing is unavailable', () => {
    const text = screen(snapshot(), 'model-cache');
    expect(text).toMatch(/Clearable model cache +42\.0 GB/);
    expect(text).toContain('Hugging Face');
    expect(text).toContain('[ Clear model cache ]');
    const empty = host({modelCache: {...host().modelCache!, reclaimableBytes: 0}});
    expect(cacheClearReason(empty, false)).toBe('The model cache is empty.');
    expect(cacheClearReason(host({modelCache: {...host().modelCache!, blocked: true, message: 'Stop demo-chat first.'}}), false)).toBe('Stop demo-chat first.');
    expect(cacheClearReason(host({operation: {requestId: 'r', action: 'check-updates', phase: 'Running'}}), false)).toBe('Another host operation is in progress.');
    expect(cacheClearReason(host(), true)).toBe('Host information is unavailable or stale.');
    expect(screen(snapshot({hosts: undefined, errors: {hosts: 'HTTP 503'}}), 'model-cache')).toContain('Host information could not be loaded: HTTP 503');
    expect(screen(snapshot({hosts: {nodes: [host({modelCache: {supported: false, blocked: false, reclaimableBytes: 0, caches: [], message: 'Worker too old.'}})]}}), 'model-cache')).toContain('Worker too old.');
  });

  it('clears the cache only after typing the computer name, with the browser payload', async () => {
    const requestHostOperation = vi.fn(async () => ({accepted: true, requestId: 'r', operation: {phase: 'Accepted'}}));
    const {recorded, act} = context(snapshot(), {requestHostOperation});
    act('cache:clear:uid-a');
    const confirm = recorded.confirms[0]!;
    expect(confirm.expected).toBe('node-a');
    expect(confirm.description).toContain('node-a: delete cached Hugging Face and Ollama model files (42.0 GB)');
    expect(requestHostOperation).not.toHaveBeenCalled();
    await confirm.onConfirm();
    expect(requestHostOperation).toHaveBeenCalledWith({
      action: 'clear-model-cache', nodeName: 'node-a', nodeUid: 'uid-a', bootId: 'boot-1', requestId: 'f'.repeat(32), planId: 'cache-plan-1',
      confirmation: 'node-a', acknowledgeDisruption: true, allowExperimental: false, experimentMode: false,
    });
  });

  it('rechecks the computer when the confirmation is accepted', async () => {
    const data = snapshot();
    const requestHostOperation = vi.fn();
    const {recorded, act} = context(data, {requestHostOperation});
    act('cache:clear:uid-a');
    data.hosts = {nodes: [host({bootId: 'boot-2'})]};
    expect(() => recorded.confirms[0]!.onConfirm()).toThrow('Host state changed');
    expect(requestHostOperation).not.toHaveBeenCalled();
  });
});

describe('regression tests', () => {
  it('shows the suite controls and every reported run detail', () => {
    const text = screen(snapshot(), 'regression', {'regression-excluded:uid-run-1': true, 'regression-executions:uid-run-1': true});
    expect(text).toContain('No license is required to run regression tests');
    expect(text).toContain('[ Start regression tests ]');
    expect(text).toContain('[ Clean up previous test run ]');
    expect(text).toContain('Previous run can be cleaned up.');
    expect(text).toContain('Runner revision 0123456789ab');
    expect(text).toContain('Selected phases: 0, 1.');
    expect(text).toContain('Test mode: Full, including destructive tests.');
    expect(text).toContain('· phase1.destructive-step');
    expect(text).toContain('100% means execution finished, not passed.');
    expect(text).toContain('ALL CHECKS');
    expect(text).toContain('Blocked: 1 by prerequisite · 1 by failure');
    expect(text).toContain('One executable scenario can produce several check results.');
    expect(text).toContain('Resource cleanup: verified');
    expect(text).toContain('Live evidence: 4 passed · 1 failed · 2 blocked.');
    expect(text).toContain('Phase results · case / variant / layer evidence');
    expect(text).toContain('[ Failures and blocked checks (2 shown; 3 more in the report) ]');
    expect(text).toContain('[ Download report ] [ HTML summary ] [ JUnit XML ]');
  });

  it('lists failed and blocked checks with diagnostics and traces', () => {
    const run = finishedRun();
    const lines = run.result!.cases.flatMap(regressionCaseLines).map((line) => line.text);
    expect(lines).toContain('P1-001 · api · admin');
    expect(lines).toContain('Reason: API — HTTP 500');
    expect(lines).toContain('Underlying cause: COMPONENT · deploy');
    expect(lines).toContain('  · cleanup observation');
    expect(lines).toContain('Trace in report archive: traces/p1-001.json');
    expect(lines).toContain('Blocked by prerequisite');
    expect(lines).toContain('Blocking check: P0-003 · GPU · Stage: inventory');
    expect(lines).toContain('  · gpu observation');
    expect(lines).toContain('Blocking scenario trace: report-artifacts/trace-1/traces/exec-1.json');
    const {recorded, act} = context(snapshot());
    act('regression:cases:uid-run-1');
    expect(recorded.viewers[0]!.title).toContain('2 shown; 3 more in the report');
  });

  it('enables the runner and shows its activation until it is ready', async () => {
    const enableModule = vi.fn(async () => ({}));
    const data = snapshot({regression: regression({runtimeAvailable: false, registered: false, runs: [], message: 'Runner not installed.'})});
    const {ctx, act} = context(data, {enableModule});
    expect(screen(data, 'regression')).toContain('Runner not installed.');
    await act('regression:enable');
    expect(enableModule).toHaveBeenCalledWith('regression');
    expect(ctx.view.ui['regression.enableRequested']).toBe('1');
    const waiting = screen(data, 'regression', {}, ctx.view.ui);
    expect(waiting).toContain('Activation requested. Waiting for the regression runner to become ready…');
    expect(waiting).toContain('Waiting for runner readiness…');
    data.regression = regression({registered: false, runs: []});
    expect(screen(data, 'regression', {}, ctx.view.ui)).toContain('Regression runner is ready. Register this disposable test Appliance to continue.');
  });

  it('registers only after typing the disposable test server phrase', async () => {
    const registerRegression = vi.fn(async () => regression());
    const {recorded, act} = context(snapshot({regression: regression({registered: false})}), {registerRegression});
    act('regression:register');
    expect(recorded.confirms[0]!.expected).toBe('DISPOSABLE TEST SERVER');
    await recorded.confirms[0]!.onConfirm();
    expect(registerRegression).toHaveBeenCalledOnce();
  });

  it('starts the selected phases in the chosen mode', async () => {
    const startRegression = vi.fn(async () => finishedRun());
    const {ctx, recorded, act} = context(snapshot({regression: regression({cleanup: {available: false, message: 'Nothing to clean.'}, runs: []})}), {startRegression});
    act('regression:start');
    const spec = recorded.dialogs[0]!;
    expect(spec.items().some((entry) => entry.kind === 'note' && entry.text.startsWith('Read existing appliance state'))).toBe(true);
    const buttons = spec.items().find((entry) => entry.kind === 'buttons') as Extract<DialogItem, {kind: 'buttons'}>;
    buttons.items.find((entry) => entry.id === 'phases-none')!.onPress();
    expect(spec.submit!.disabled!()).toBe('Select at least one test phase.');
    (item(spec, 'phase-2') as Extract<DialogItem, {kind: 'check'}>).onChange(true);
    (item(spec, 'phase-5') as Extract<DialogItem, {kind: 'check'}>).onChange(true);
    expect(spec.submit!.disabled!()).toBeUndefined();
    await spec.submit!.run();
    expect(startRegression).toHaveBeenCalledWith('f'.repeat(32), [2, 5], 'non-destructive');
    expect(ctx.view.ui['regression.phases']).toBe('2,5');

    (item(spec, 'diagnostic') as Extract<DialogItem, {kind: 'choice'}>).onChange('gpu-smoke');
    expect((item(spec, 'mode') as Extract<DialogItem, {kind: 'choice'}>).value).toBe('full');
    expect((item(spec, 'phase-2') as Extract<DialogItem, {kind: 'check'}>).disabled).toBeTruthy();
    expect(spec.items().find((entry) => entry.kind === 'note' && entry.text.startsWith('Run the selected P0 phases'))).toBeTruthy();
    await spec.submit!.run();
    expect(startRegression).toHaveBeenLastCalledWith('f'.repeat(32), [3], 'full', 'gpu-smoke');
  });

  it('blocks non-destructive runs while a previous run still needs cleanup', () => {
    const pending = regression({runs: [finishedRun({credentialsCleaned: false})], recoveryAvailable: true});
    expect(regressionState(pending).cleanupPending).toBe(true);
    const {recorded, act} = context(snapshot({regression: pending}));
    act('regression:start');
    const spec = recorded.dialogs[0]!;
    expect(spec.submit!.disabled!()).toBe('Clean up the previous run separately before non-destructive tests.');
    (item(spec, 'mode') as Extract<DialogItem, {kind: 'choice'}>).onChange('full');
    expect(spec.submit!.disabled!()).toBeUndefined();
    const blocked = regression({runs: [finishedRun({credentialsCleaned: false})], recoveryAvailable: false});
    expect(regressionState(blocked).startBlocked).toBe('Previous-run cleanup must finish before new tests can start.');
  });

  it('cancels the active run and cleans up with the reviewed lock revision only', async () => {
    const cancelRegression = vi.fn(async () => finishedRun());
    const recoverRegressionLock = vi.fn(async () => finishedRun());
    const running = finishedRun({phase: 'Running', id: 'run-2', uid: 'uid-run-2', result: null, reportAvailable: false, progress: {percent: 40, currentPhase: 1, step: 'phase1', testIndex: 2, testTotal: 5, currentTest: 'Creating instance'}});
    const data = snapshot({regression: regression({runs: [running, finishedRun()]})});
    const {recorded, act} = context(data, {cancelRegression, recoverRegressionLock});
    const text = screen(data, 'regression');
    expect(text).toContain('Phase 1 P0 · 40%');
    expect(text).toContain('Current step: phase1 · 2 / 5 scenarios');
    expect(text).toContain('Creating instance');
    expect(text).toContain('A test or cleanup run is active. Wait for it to finish.');
    act('regression:cancel');
    await recorded.confirms[0]!.onConfirm();
    expect(cancelRegression).toHaveBeenCalledWith('run-2');

    data.regression = regression();
    act('regression:recover');
    data.regression = regression({cleanup: {available: true, message: 'Changed.', revision: 'lock-8'}});
    await expect(recorded.confirms[1]!.onConfirm()).rejects.toThrow('The lock changed after review.');
    act('regression:recover');
    await recorded.confirms[2]!.onConfirm();
    expect(recoverRegressionLock).toHaveBeenCalledWith('f'.repeat(32), 'lock-8');
  });

  it('saves report downloads as new local files', async () => {
    const downloadRegression = vi.fn(async () => new Blob(['<testsuite/>']));
    const {ctx, act} = context(snapshot(), {downloadRegression});
    act('regression:download:junit:run-1');
    const save = vi.mocked(ctx.saveAs).mock.calls[0]![0];
    expect(save.defaultName).toBe('magicstick-run-1.xml');
    // Nothing is downloaded before the user chooses where to save it.
    expect(downloadRegression).not.toHaveBeenCalled();
    expect(await save.content()).toEqual(new TextEncoder().encode('<testsuite/>'));
    expect(downloadRegression).toHaveBeenCalledWith('run-1', 'junit');
    const unavailable = context(snapshot({regression: regression({runs: [finishedRun({reportAvailable: false})]})}));
    unavailable.act('regression:download:archive:run-1');
    expect(unavailable.recorded.messages).toContain('Report unavailable');
  });
});

describe('model cache in the running terminal dashboard', () => {
  const started = async (runtime: Runtime) => {
    const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
    const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 121, rows: 60});
    const writes: string[] = [];
    stdout.on('data', (value: Buffer) => writes.push(value.toString()));
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
    const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
    const screenText = () => ([...writes].reverse().find((write) => write.includes('AI Appliance Dashboard')) ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const key = async (value: string) => { stdin.emit('data', Buffer.from(value)); await settle(); };
    const click = async (label: string) => {
      const rows = screenText().split('\n');
      const row = rows.findIndex((line) => line.includes(label));
      if (row < 0) throw new Error(`Not on screen: ${label}`);
      await key(`\x1b[<0;${Array.from(rows[row]!.slice(0, rows[row]!.indexOf(label))).length + 2};${row + 1}M`);
    };
    const running = runTui(runtime, {color: false});
    await settle();
    return {key, click, screen: screenText, running, close: async () => { await key('\x03'); stdin.destroy(); stdout.destroy(); }};
  };

  it('loads hosts when the tab opens and needs the typed computer name', async () => {
    const demo = createDemoRuntime();
    const hostManagement = vi.fn(async () => ({nodes: [host()]}));
    const requestHostOperation = vi.fn(async () => ({accepted: true, requestId: 'r', operation: {phase: 'Accepted'}}));
    const api = Object.assign(Object.create(demo.api) as MagicStickApi, {hostManagement, requestHostOperation});
    const io = await started({...demo, api});
    try {
      await io.key('7');
      expect(hostManagement).not.toHaveBeenCalled();
      for (let tab = 0; tab < 4; tab += 1) await io.key('t');
      expect(io.screen()).toContain('[■ Model cache ]');
      expect(hostManagement).toHaveBeenCalled();
      await io.click('[ Clear model cache ]');
      expect(io.screen()).toContain('Type node-a to confirm');
      await io.key('\r');
      expect(io.screen()).toContain('Type node-a exactly to confirm.');
      expect(requestHostOperation).not.toHaveBeenCalled();
      await io.key('node-a');
      await io.key('\r');
      expect(requestHostOperation).toHaveBeenCalledWith(expect.objectContaining({action: 'clear-model-cache', confirmation: 'node-a', planId: 'cache-plan-1'}));
      expect(io.screen()).toContain('Cache cleanup was requested on node-a.');
    } finally { await io.close(); }
  });
});
