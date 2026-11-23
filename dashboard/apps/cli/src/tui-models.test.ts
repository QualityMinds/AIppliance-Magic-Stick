import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {MemoryEstimate, ModelActivation, ModelLogsPayload} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {ConfirmOptions, TuiContext} from './tui-context';
import type {DialogItem, TuiOverlay} from './tui-dialogs';
import {logLines, logsCopyValue, modelsModule, sanitizeLogText} from './tui-models';
import {modelFixture} from './tui-model-fixture';
import {initialPageState} from './tui-state';
import {renderTui, runTui} from './tui';
import {createDemoRuntime} from './demo';

/** A test double of the runtime context: dialogs stack as in the terminal, changes run at once. */
const harness = (snapshot: DashboardSnapshot, api: Partial<MagicStickApi> = {}) => {
  let overlay: TuiOverlay | undefined;
  const confirms: ConfirmOptions[] = [];
  const messages: Array<{title: string; lines: string | string[]}> = [];
  const completed: string[][] = [];
  const ctx: TuiContext = {
    api: api as MagicStickApi, view: initialPageState({page: 'models'}), demo: false,
    snapshot: () => snapshot, session: () => snapshot.session, draw: vi.fn(), refresh: async () => undefined,
    message: (title, lines) => { messages.push({title, lines}); overlay = undefined; },
    perform: async (_title, operation) => {
      const result = await operation();
      completed.push(result?.lines ?? []);
      overlay = undefined;
    },
    task: async (_title, operation, then) => { then?.(await operation()); },
    load: async (_title, fetch, then) => { then(await fetch()); },
    confirm: (options) => { confirms.push(options); },
    form: (title, description, fields, submitLabel, onSubmit, back) => {
      overlay = {kind: 'dialog', scroll: 0, back: back ? overlay : undefined, spec: {title, description,
        items: () => fields.map((field): DialogItem => ({kind: 'text', id: field.id, label: field.label, value: field.value, onChange: (value) => { field.value = value; }})),
        submit: {label: submitLabel, run: () => onSubmit(Object.fromEntries(fields.map((field) => [field.id, field.value])))}}};
    },
    dialog: (spec, back) => { overlay = {kind: 'dialog', spec, scroll: 0, back: back ? overlay : undefined}; },
    menu: vi.fn(),
    viewer: (spec, back) => { overlay = {kind: 'viewer', spec, scroll: 0, back: back ? overlay : undefined}; },
    current: () => overlay,
    close: () => { overlay = overlay?.back; },
    copy: vi.fn(),
    saveAs: vi.fn(), openFile: vi.fn(),
    requestId: () => 'request',
    missing: vi.fn(),
  };
  const dialog = () => {
    if (overlay?.kind !== 'dialog') throw new Error(`No dialog open (${overlay?.kind ?? 'none'})`);
    return overlay;
  };
  const items = () => dialog().spec.items();
  const item = <K extends DialogItem['kind']>(id: string, kind?: K) => {
    const found = items().find((entry) => 'id' in entry && entry.id === id);
    if (!found || (kind && found.kind !== kind)) throw new Error(`No ${kind ?? 'item'} ${id}: ${items().map((entry) => 'id' in entry ? entry.id : entry.kind).join(', ')}`);
    return found as Extract<DialogItem, {kind: K}>;
  };
  const press = (id: string) => {
    for (const entry of items()) if (entry.kind === 'buttons') {
      const button = entry.items.find((candidate) => candidate.id === id);
      if (button) {
        if (button.disabled) throw new Error(`Button ${id} is disabled: ${button.disabled}`);
        return button.onPress();
      }
    }
    throw new Error(`No button ${id}`);
  };
  const run = (id: string) => modelsModule.handle(ctx, {id, scope: id.split(':')[0]!, verb: id.split(':')[1]!, target: id.split(':').slice(2).join(':')});
  const screen = () => renderTui(snapshot, {page: 'models', overlay}, 121, 60, false);
  return {ctx, run, dialog, items, item, press, confirms, messages, completed, screen, overlay: () => overlay};
};

const estimate = (overrides: Partial<MemoryEstimate> = {}): MemoryEstimate => ({
  minimumMi: 5000, recommendedMi: 6150, maximumMi: 50000, confidence: 'estimated', detectedModelType: 'chat',
  weightsMi: 4000, kvCacheMi: 512, reserveMi: 600, recommendedReserveMi: 500, downloadBytes: 4_200_000_000,
  calculations: {minimumMi: {formula: 'weights + KV + runtime', substitution: '4000 + 512 + 600 = 5112 MiB'}}, ...overrides,
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Models page', () => {
  it('shows every model detail the browser shows, with role-appropriate buttons', () => {
    const page = renderTui(modelFixture(), {page: 'models'}, 121, 130, false);
    expect(page).toContain('Local inference and external OpenAI-compatible providers.');
    expect(page).toContain('INSTALLED MODELS · 4 models');
    expect(page).toContain('[Artifact: bf16] [Format: safetensors] [KV requested: auto]');
    expect(page).toContain('[KV active: pending confirmation]');
    expect(page).toContain('2 GPUs · one model');
    expect(page).toContain('Parallelism: tensor');
    expect(page).toContain('[GPU allocation: Shared · Time-slicing] [GPU node: node-a · GPU-1]');
    expect(page).toContain('[CPU offloading enabled] [Host RAM reserved: 16 GiB]');
    expect(page).toContain('Actual RAM / VRAM split is not currently reported.');
    expect(page).toContain('[Provider: openai/gpt-4o-mini] [Context: 128000]');
    expect(page).toContain('provider-model  openai/gpt-4o-mini · openai');
    expect(page).toContain('[ Edit ] [ Stop ] [ Logs ] [ Remove ]');
    expect(page).toContain('[ Edit ] [ Start ] [ Remove ]');
    // Unknown telemetry stays unknown, never zero.
    expect(page).toContain('VRAM Free             ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  Not reported of 24 GiB');
    expect(page).toContain('Slots: 1 / 2 free');

    const operator = renderTui(modelFixture(['magicstick-operator']), {page: 'models'}, 121, 130, false);
    expect(operator).toContain('[ Edit ] [ Stop ] [ Remove ]');
    expect(operator).not.toContain('[ Logs ]');
    const viewer = renderTui(modelFixture(['magicstick-viewer']), {page: 'models'}, 121, 130, false);
    expect(viewer).not.toMatch(/\[ (Edit|Stop|Start|Logs|Remove|Add Model) \]/);
  });

  it('expands GPU identities and memory details on request', () => {
    const snapshot = modelFixture();
    expect(renderTui(snapshot, {page: 'models'}, 121, 130, false)).not.toContain('• node-a · GPU-2');
    const collapsed = renderTui(snapshot, {page: 'models'}, 121, 130, false);
    expect(collapsed).toContain('► Selected GPU identities');
    const page = renderTui(snapshot, {page: 'models', expanded: {'model-gpus:split-gpu': true, 'memory:gpu-1': true}}, 121, 160, false);
    expect(page).toContain('• node-a · GPU-2');
    expect(page).toContain('not reported, not zero');
  });

  it('offers removing the automatically installed runtime only after the last local model', () => {
    const snapshot = modelFixture();
    expect(renderTui(snapshot, {page: 'models'}, 121, 130, false)).not.toContain('Remove Local Inference Runtime');
    snapshot.models.activations = snapshot.models.activations.filter((item) => item.spec?.type !== 'local');
    expect(renderTui(snapshot, {page: 'models'}, 121, 130, false)).toContain('[ Remove Local Inference Runtime ]');
    const removeLocalRuntime = vi.fn(async () => ({}));
    const {run, confirms, completed} = harness(snapshot, {removeLocalRuntime});
    run('model:remove-runtime:');
    expect(confirms[0]?.description).toContain('Manually managed modules are preserved.');
    expect(removeLocalRuntime).not.toHaveBeenCalled();
    return Promise.resolve(confirms[0]!.onConfirm()).then(() => {
      expect(removeLocalRuntime).toHaveBeenCalledOnce();
      expect(completed[0]?.[0]).toContain('Removal of the automatically installed local inference runtime was requested.');
    });
  });
});

describe('Create Model dialog', () => {
  it('adds a direct-reference local model with the estimate and the shared create payload', async () => {
    vi.useFakeTimers();
    const snapshot = modelFixture();
    const estimateMemory = vi.fn(async () => estimate());
    const createLocalModel = vi.fn(async () => ({}));
    const popularModels = vi.fn(async () => ({provider: 'huggingface' as const, results: [], total: 0}));
    const test = harness(snapshot, {estimateMemory, createLocalModel, popularModels});
    test.run('model:add:');
    expect(test.item('location', 'choice').value).toBe('local');
    expect(test.item('engine', 'choice').choices.map((choice) => choice.label)).toEqual(['Ollama', 'vLLM']);
    expect(test.item('hardware', 'choice').value).toBe('cpu');
    expect(test.dialog().spec.submit?.disabled?.()).toBe('Choose a model reference.');

    test.item('source', 'choice').onChange('direct');
    test.item('direct-url', 'text').onChange('hf://example/tiny-chat');
    expect(test.item('name', 'text').value).toBe('tiny-chat');
    test.items();
    expect(test.screen()).toContain('Detecting model task…');
    await vi.advanceTimersByTimeAsync(400);
    expect(estimateMemory).toHaveBeenCalledWith({engine: 'VLLM', computeTarget: 'cpu', url: 'hf://example/tiny-chat', contextWindow: 4096, maxNumSeqs: 1, modelType: 'auto', kvCacheType: 'auto'});
    const screen = test.screen();
    expect(screen).toContain('Model task: Chat · detected automatically');
    expect(screen).toContain('RAM budget (MiB): 6200');
    expect(screen).toContain('[ Minimum ] [ Recommended ] [ 100% ]');
    expect(test.dialog().spec.submit?.label).toBe('⚠ Add Local Model');
    expect(screen).toContain('Memory requirements are estimated and may differ at runtime.');

    test.press('estimate:minimum');
    expect(test.item('estimate:budget', 'number').value).toBe('5000');
    test.item('kv-cache', 'choice').onChange('fp8');
    test.item('advanced', 'toggle').onChange(true);
    test.item('cpu-request', 'number').onChange('1.5');
    test.items();
    await vi.advanceTimersByTimeAsync(400);
    await test.dialog().spec.submit!.run();
    expect(createLocalModel).toHaveBeenCalledWith({name: 'tiny-chat', enabled: true, targetNamespace: 'ai', local: {
      engine: 'VLLM', computeTarget: 'cpu', modelType: 'auto', contextWindow: 4096, maxNumSeqs: 1, cpuResources: {requestMillicores: 1500},
      kvCacheType: 'fp8', memoryRequiredMi: 6200, allowMemoryRisk: true, url: 'hf://example/tiny-chat',
    }});
    expect(test.completed[0]?.[0]).toBe('tiny-chat was requested on CPU with vLLM.');
  });

  it('validates the model name like the browser and keeps the task question open when metadata is inconclusive', async () => {
    vi.useFakeTimers();
    const snapshot = modelFixture();
    const test = harness(snapshot, {estimateMemory: vi.fn(async () => estimate({detectedModelType: null})), popularModels: vi.fn(async () => ({provider: 'huggingface' as const, results: [], total: 0}))});
    test.run('model:add:');
    test.item('source', 'choice').onChange('direct');
    test.item('direct-url', 'text').onChange('hf://example/unknown');
    test.item('name', 'text').onChange('chat-local');
    test.items();
    await vi.advanceTimersByTimeAsync(400);
    expect(test.dialog().spec.submit?.disabled?.()).toBe('Select the model task.');
    test.item('task', 'choice').onChange('embedding');
    expect(test.dialog().spec.submit?.disabled?.()).toBe('A model with this name already exists. Choose another name.');
    test.item('name', 'text').onChange('Bad Name');
    expect(test.dialog().spec.submit?.disabled?.()).toContain('Use lowercase letters');
  });

  it('searches the model library, loads artifacts and applies the context of the selected one', async () => {
    vi.useFakeTimers();
    const snapshot = modelFixture();
    const searchModels = vi.fn(async (_params: URLSearchParams) => ({provider: 'huggingface' as const, total: 2, nextCursor: 'next',
      results: [{id: 'r1', repo: 'example/qwen-a', pulls: 1200}, {id: 'r2', repo: 'example/qwen-b'}]}));
    const modelArtifacts = vi.fn(async (_params: URLSearchParams) => ({provider: 'huggingface' as const, total: 1,
      artifacts: [{id: 'a1', repo: 'example/qwen-a', label: 'BF16', url: 'hf://example/qwen-a', modelMaxContext: 32768, sizeLabel: '8 GB', format: 'safetensors'}]}));
    const popularModels = vi.fn(async () => ({provider: 'huggingface' as const, total: 1, results: [{id: 'p1', repo: 'example/popular', name: 'Popular'}]}));
    const test = harness(snapshot, {searchModels, modelArtifacts, popularModels, estimateMemory: vi.fn(async () => estimate())});
    test.run('model:add:');
    test.items();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.screen()).toContain('Trending on Hugging Face');
    expect(test.screen()).toContain('[ Popular ]');
    test.press('search-run');
    await vi.advanceTimersByTimeAsync(0);
    expect(searchModels.mock.calls[0]![0].toString()).toBe('provider=huggingface&engine=VLLM&computeTarget=cpu&modelType=&q=Qwen&limit=20');
    expect(modelArtifacts.mock.calls[0]![0].get('repo')).toBe('example/qwen-a');
    expect(test.item('search-result', 'choice').choices[0]!.label).toBe('example/qwen-a · 1,200 pulls');
    expect(test.item('artifact', 'choice').value).toBe('a1');
    expect(test.item('context', 'number').value).toBe('32768');
    expect(test.item('name', 'text').value).toBe('qwen-a');
    expect(test.screen()).toContain('[Model context: 32,768]');
    test.press('search-more');
    await vi.advanceTimersByTimeAsync(0);
    expect(searchModels.mock.calls[1]![0].get('cursor')).toBe('next');
  });

  it('selects NVIDIA cards and splits one model across them', async () => {
    vi.useFakeTimers();
    const snapshot = modelFixture();
    snapshot.models.activations = snapshot.models.activations.filter((item) => item.metadata?.name !== 'split-gpu');
    const estimateMemory = vi.fn(async () => estimate({maximumMi: 20000, physicalMaximumMi: 24576, systemMemory: {
      scope: 'per-pod', replicaCount: 1, workerCount: 1, minimumMi: 2000, recommendedMi: 4000, runningMinimumMi: 1500, runningRecommendedMi: 2500,
      startupMinimumMi: 2000, startupUpperMi: 9000, maximumMi: 50000, totalRecommendedMi: 4000, weightsOnCpuMi: 0, cacheOnCpuMi: 0, hostRuntimeMi: 1500,
      multimodalCacheMi: 0, promptBuffersMi: 100, loadingBuffersMi: 400, fileCacheUpperMi: 7000, confidence: 'estimated'}, systemMemoryMaximumMi: 50000}));
    const createLocalModel = vi.fn(async () => ({}));
    const test = harness(snapshot, {estimateMemory, createLocalModel, popularModels: vi.fn(async () => ({provider: 'huggingface' as const, results: [], total: 0}))});
    test.run('model:add:');
    test.item('hardware', 'choice').onChange('nvidia-gpu');
    expect(test.item('card:n1/GPU-1', 'check').checked).toBe(true);
    test.item('card:n1/GPU-2', 'check').onChange(true);
    expect(test.item('gpu-deployment', 'choice').value).toBe('split');
    test.item('source', 'choice').onChange('direct');
    test.item('direct-url', 'text').onChange('hf://example/large');
    test.items();
    await vi.advanceTimersByTimeAsync(400);
    expect(estimateMemory).toHaveBeenCalledWith(expect.objectContaining({gpuDevices: [{nodeName: 'node-a', nodeUid: 'n1', uuid: 'GPU-1'}, {nodeName: 'node-a', nodeUid: 'n1', uuid: 'GPU-2'}], gpuDeployment: 'split', vllm: {parallelism: 'auto'}}));
    test.items();
    expect(test.screen()).toContain('VRAM per GPU: 6.1 GiB · 2 GPUs');
    test.item('advanced', 'toggle').onChange(true);
    test.item('parallelism', 'choice').onChange('pipeline');
    test.items();
    await vi.advanceTimersByTimeAsync(400);
    await test.dialog().spec.submit!.run();
    const local = (createLocalModel.mock.calls[0] as unknown as [{local: Record<string, unknown>}])[0].local;
    expect(local).toMatchObject({computeTarget: 'nvidia-gpu', gpuDeployment: 'split', vllm: {parallelism: 'pipeline'}, cpuOffloading: false, memoryRequiredMi: 4000, vram: '6200Mi'});
    expect(local.gpuDevices).toHaveLength(2);
  });

  it('adds a tested preset with its artifact instead of a URL', async () => {
    vi.useFakeTimers();
    const snapshot = modelFixture();
    const createLocalModel = vi.fn(async () => ({}));
    const test = harness(snapshot, {createLocalModel, estimateMemory: vi.fn(async () => estimate({detectedModelType: null})), popularModels: vi.fn(async () => ({provider: 'huggingface' as const, results: [], total: 0}))});
    test.run('model:add:');
    test.item('source', 'choice').onChange('preset');
    expect(test.item('preset-artifact', 'choice').disabled).toBe('Select a tested preset first.');
    test.item('preset', 'choice').onChange('qwen-small');
    test.item('preset-artifact', 'choice').onChange('awq');
    expect(test.item('context', 'number').value).toBe('8192');
    expect(test.item('max-seqs', 'number').value).toBe('2');
    test.items();
    await vi.advanceTimersByTimeAsync(400);
    // The preset declares its task, so no detection question appears.
    expect(test.screen()).toContain('Model task: Chat · detected automatically');
    await test.dialog().spec.submit!.run();
    // As in the browser: the name comes from the first reference, and a detected task is sent as automatic.
    expect(createLocalModel).toHaveBeenCalledWith({name: 'qwen-small', enabled: true, targetNamespace: 'ai', local: expect.objectContaining({
      preset: 'qwen-small', artifact: 'awq', modelType: 'auto', contextWindow: 8192, maxNumSeqs: 2})});
    expect((createLocalModel.mock.calls[0] as unknown as [{local: Record<string, unknown>}])[0].local.url).toBeUndefined();
  });

  it('configures an experimental vLLM-Omni Realtime model from its profile', async () => {
    const snapshot = modelFixture();
    snapshot.models.computeTargets.engineCatalog!.VLLM!.realtimeProfiles = {'omni-example': {displayName: 'Omni example', model: 'example/omni',
      description: 'Experimental realtime profile.', gpuCounts: [1, 2], defaultContextWindow: 8192, defaultSystemMemoryMi: 16384, sourceRevision: 'r1',
      computeTargets: ['nvidia-gpu'], image: 'registry.example.com/omni:1'}};
    snapshot.models.computeTargets.realtimeDevices = [{profile: 'omni-example', node: 'node-a', name: 'Example GPU', supported: true, reason: '', gpuCount: 2,
      freeGpuCount: 2, gpuMemoryMi: 24576, systemMemoryMi: 65536, computeTarget: 'nvidia-gpu', allocationMode: 'exclusive'}];
    const createLocalModel = vi.fn(async () => ({}));
    const test = harness(snapshot, {createLocalModel, popularModels: vi.fn(async () => ({provider: 'huggingface' as const, results: [], total: 0}))});
    test.run('model:add:');
    expect(test.item('engine', 'choice').choices.at(-1)).toEqual({value: 'VLLM-Omni', label: '(Experimental) vLLM-Omni'});
    test.item('engine', 'choice').onChange('VLLM-Omni');
    expect(test.item('profile', 'choice').value).toBe('omni-example');
    expect(test.item('name', 'text').value).toBe('qwen3-omni-realtime');
    expect(test.item('realtime-node', 'choice').choices[0]!.label).toBe('node-a · Example GPU · 2 free GPU slots');
    test.item('realtime-gpus', 'choice').onChange('2');
    test.item('max-seqs', 'number').onChange('2');
    expect(test.screen()).toContain('Concurrent sessions: 2');
    expect(test.dialog().spec.submit?.label).toBe('Add Realtime Model');
    await test.dialog().spec.submit!.run();
    expect(createLocalModel).toHaveBeenCalledWith({name: 'qwen3-omni-realtime', enabled: true, targetNamespace: 'ai', local: {
      engine: 'VLLM', computeTarget: 'nvidia-gpu', modelType: 'chat', contextWindow: 8192, maxNumSeqs: 2, url: 'hf://example/omni',
      realtime: {profile: 'omni-example', gpuNode: 'node-a', gpuCount: 2, systemMemoryMi: 16384, gpuMemoryFraction: 0.9, thinkerCpuOffloadGiB: 0},
    }});
  });

  it('registers an external model with the browser defaults', async () => {
    const snapshot = modelFixture();
    const createExternalModel = vi.fn(async () => ({}));
    const test = harness(snapshot, {createExternalModel, popularModels: vi.fn(async () => ({provider: 'huggingface' as const, results: [], total: 0}))});
    test.run('model:add:');
    test.item('location', 'choice').onChange('external');
    expect(test.item('external-model', 'text').value).toBe('openai/gpt-4o-mini');
    expect(test.item('external-base', 'text').value).toBe('https://api.openai.com/v1');
    expect(test.dialog().spec.submit?.label).toBe('Add External Model');
    test.item('external-name', 'text').onChange('remote');
    expect(test.dialog().spec.submit?.disabled?.()).toContain('already exists');
    test.item('external-name', 'text').onChange('provider-chat');
    test.item('external-key', 'text').onChange('CHANGEME');
    await test.dialog().spec.submit!.run();
    expect(createExternalModel).toHaveBeenCalledWith({name: 'provider-chat', enabled: true, targetNamespace: 'ai',
      external: {model: 'openai/gpt-4o-mini', apiBase: 'https://api.openai.com/v1', modelType: 'chat', contextWindow: 128000}, apiKey: 'CHANGEME'});
  });
});

describe('Edit Model dialog', () => {
  it('edits a local model with the saved revision, only sending changes', async () => {
    vi.useFakeTimers();
    const snapshot = modelFixture();
    const estimateModelUpdate = vi.fn(async () => estimate({maximumMi: 58000}));
    const updateModel = vi.fn(async () => ({}));
    const test = harness(snapshot, {estimateModelUpdate, updateModel});
    test.run('model:edit:chat-local');
    expect(test.dialog().spec.title).toBe('Edit Model · chat-local');
    expect(test.item('name', 'text').disabled).toBeTruthy();
    expect(() => test.item('source')).toThrow();
    test.items();
    expect(test.dialog().spec.submit?.disabled?.()).toBe('No changes to save.');
    await vi.advanceTimersByTimeAsync(300);
    expect(estimateModelUpdate).toHaveBeenCalledWith('chat-local', expect.objectContaining({contextWindow: 4096, memoryRequiredMi: 8000}));
    test.item('context', 'number').onChange('8192');
    test.items();
    expect(test.dialog().spec.submit?.disabled?.()).toBe('Recalculating memory…');
    await vi.advanceTimersByTimeAsync(300);
    expect(test.dialog().spec.submit?.disabled?.()).toBeUndefined();
    await test.dialog().spec.submit!.run();
    expect(updateModel).toHaveBeenCalledWith('chat-local', {expectedRevision: 'generation:uid-1:3', local: {contextWindow: 8192, allowMemoryRisk: true}});
  });

  it('edits an external model and keeps the API key unless replaced', async () => {
    const snapshot = modelFixture();
    const updateModel = vi.fn(async () => ({}));
    const test = harness(snapshot, {updateModel});
    test.run('model:edit:remote');
    expect(test.dialog().spec.submit?.disabled?.()).toBe('No changes to save.');
    test.item('external-rpm', 'number').onChange('60');
    test.item('external-apiBase', 'text').onChange('https://provider.example.com/v1');
    await test.dialog().spec.submit!.run();
    expect(updateModel).toHaveBeenCalledWith('remote', {expectedRevision: 'generation:uid-3:1', external: {apiBase: 'https://provider.example.com/v1', rpm: 60}});
  });

  it('refuses editing an unsupported engine', () => {
    const snapshot = modelFixture();
    (snapshot.models.activations[0] as ModelActivation).spec!.local!.engine = 'TGI';
    const test = harness(snapshot);
    test.run('model:edit:chat-local');
    expect(test.messages[0]?.lines).toContain('This engine is no longer supported.');
  });
});

describe('Runtime logs', () => {
  const logs = (text: string): ModelLogsPayload => ({model: 'chat-local', namespace: 'ai', generatedAt: '2026-01-01T00:00:00Z', tailLines: 300,
    replicas: [{name: 'copy-a', uuid: 'GPU-1'}],
    pods: [{name: 'chat-local-0', phase: 'Running', node: 'node-a', deleting: false, containers: [{name: 'server', kind: 'application', restartCount: 2, state: 'running',
      logs: [{previous: false, text}, {previous: true, text: '', error: 'previous log unavailable', truncated: true}]}]}]});

  it('never lets log output control the terminal', () => {
    expect(sanitizeLogText('ok\x1b[31mred\x1b[0m\x1b]52;c;ZXZpbA==\x07\tend\x07')).toBe('okred  end');
  });

  it('shows pods, containers and both runs, and copies and saves the output', async () => {
    vi.useFakeTimers();
    const snapshot = modelFixture();
    const modelLogs = vi.fn(async () => logs('line one\nline two'));
    const test = harness(snapshot, {modelLogs});
    test.run('model:logs:chat-local');
    await vi.advanceTimersByTimeAsync(0);
    const viewer = test.overlay();
    if (viewer?.kind !== 'viewer') throw new Error('viewer expected');
    const text = viewer.spec.lines().map((line) => line.text).join('\n');
    expect(text).toContain('■ chat-local-0 [Running] [Node: node-a]');
    expect(text).toContain('▸ server [Container] [running] [Restarts: 2]');
    expect(text).toContain('Previous run [Output limited]');
    expect(text).toContain('previous log unavailable');
    expect(text).toContain('Model copy: All copies · newest Pods');
    viewer.spec.actions!.find((action) => action.key === 'c')!.run();
    expect(test.ctx.copy).toHaveBeenCalledWith(logsCopyValue(logs('line one\nline two')));
    viewer.spec.actions!.find((action) => action.key === 'm')!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(modelLogs).toHaveBeenLastCalledWith('chat-local', 300, 'copy-a');
    viewer.spec.actions!.find((action) => action.key === 's')!.run();
    const save = vi.mocked(test.ctx.saveAs).mock.calls[0]![0];
    expect(save).toMatchObject({defaultName: 'chat-local-logs.txt', back: true});
    expect(await save.content()).toContain('# chat-local-0 · server · current');
    expect(test.overlay()).toBe(viewer);
    expect(logLines(undefined, '')[0]!.text).toBe('Loading current output…');
  });

  it('restricts logs to administrators', () => {
    const test = harness(modelFixture(['magicstick-operator']));
    test.run('model:logs:chat-local');
    expect(test.messages[0]?.title).toBe('Administrator access required');
  });
});

describe('Models dialogs in the running terminal', () => {
  it('opens the create and edit dialogs from the keyboard and mouse, and closes them with Esc', async () => {
    const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
    const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 121, rows: 50});
    const writes: string[] = [];
    stdout.on('data', (value: Buffer) => writes.push(value.toString()));
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
    const settle = async () => { for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
    const screen = () => ([...writes].reverse().find((write) => write.includes('AI Appliance Dashboard')) ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const key = async (value: string) => { stdin.emit('data', Buffer.from(value)); await settle(); };
    const click = async (label: string) => {
      const rows = screen().split('\n');
      const row = rows.findIndex((line) => line.includes(label));
      if (row < 0) throw new Error(`Not on screen: ${label}`);
      await key(`\x1b[<0;${Array.from(rows[row]!.slice(0, rows[row]!.indexOf(label))).length + 2};${row + 1}M`);
    };
    const running = runTui(createDemoRuntime(), {color: false});
    await settle();
    try {
      await key('2');
      await key('a');
      expect(screen()).toContain('┌─ Create Model');
      expect(screen()).toContain('Location: < Local >');
      await key('\x1b[C'); // Location → External
      expect(screen()).toContain('Provider Model *: openai/gpt-4o-mini');
      await key('\x1b');
      expect(screen()).not.toContain('Create Model');
      await click('[ Edit ]');
      expect(screen()).toContain('┌─ Edit Model · demo-chat');
      expect(screen()).toContain('The model has no saved revision yet.');
      await key('\x1b');
      expect(screen()).not.toContain('Edit Model');
    } finally {
      await key('\x03');
      await running;
      stdin.destroy(); stdout.destroy();
    }
  });
});
