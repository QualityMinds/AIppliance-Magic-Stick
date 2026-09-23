import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelsPayload, Session} from '@magicstick/dashboard-contracts';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {
  models: vi.fn(), popularModels: vi.fn(), searchModels: vi.fn(), modelArtifacts: vi.fn(),
  estimateMemory: vi.fn(), createLocalModel: vi.fn(), updateModel: vi.fn(), request: vi.fn(),
}}));

const admin: Session = {subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const baseModels = (): ModelsPayload => ({
  activations: [], models: [], presets: {},
  computeTargets: {
    targets: [{
      id: 'nvidia-gpu', kind: 'gpu', available: true, displayName: 'NVIDIA GPU',
      engines: ['VLLM', 'FreeToken'], declaredEngines: ['VLLM', 'FreeToken'],
      engineAvailability: {VLLM: {available: true}, FreeToken: {available: true}},
    }],
    engineCatalog: {VLLM: {displayName: 'vLLM'}, FreeToken: {displayName: 'FreeToken'}},
    freeTokenCapabilities: {
      available: true, version: '0.1.3',
      memoryStrategies: ['auto', 'offload', 'cpu', 'hybrid', 'fused'], cacheTypes: ['radix', 'naive'],
      minimumGpuMemoryMi: 1024, minimumSystemMemoryMi: 4096,
      defaults: {memoryStrategy: 'auto', systemMemoryMi: 8192, contextWindow: 4096, maxNumSeqs: 1},
      advanced: {cacheType: ['radix', 'naive'], kvReserveTokens: true, cpuThreads: true, cudaGraphMaxBatchSize: true, moeCacheSize: true, maxPrefillLength: true, expertLoad: ['auto', 'serial', 'parallel'], dtype: ['auto', 'float16', 'bfloat16', 'float32']},
      devices: [
        {id: 'node:ai', node: 'ai', supported: true, systemMemoryMi: 32768, systemAvailableMi: 12000},
      ],
      unavailableDevices: [{id: 'node:legacy', node: 'legacy', supported: false, reason: 'This architecture is not supported by FreeToken.'}],
    },
  },
  computeMemory: {devices: [
    {id: 'cpu', kind: 'cpu', name: 'CPU', nodes: ['ai'], totalMi: 65536, unreservedMi: 50000, freeMi: 50000},
    {id: 'nvidia-a', kind: 'gpu', name: 'NVIDIA RTX 5090', nodes: ['ai'], computeTarget: 'nvidia-gpu', totalMi: 24576, unreservedMi: 20000, freeMi: 20000, freeToken: {id: 'node:ai', supported: true}},
    {id: 'nvidia-b', kind: 'gpu', name: 'NVIDIA Tesla K80', nodes: ['legacy'], computeTarget: 'nvidia-gpu', totalMi: 24576, unreservedMi: 20000, freeMi: 20000, freeToken: {supported: false, reason: 'This architecture is not supported by FreeToken.'}},
  ]},
});

const mount = async (models = baseModels()) => {
  vi.mocked(api.models).mockResolvedValue(models);
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  render(<QueryClientProvider client={client}><ModelsPage session={admin} /></QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.popularModels).mockResolvedValue({provider: 'huggingface', results: [], total: 0});
  vi.mocked(api.createLocalModel).mockResolvedValue({});
  vi.mocked(api.updateModel).mockResolvedValue({});
  vi.mocked(api.request).mockResolvedValue({});
});

describe('FreeToken local engine', () => {
  it('searches Hugging Face with the FreeToken engine context and selects a compatible result', async () => {
    vi.mocked(api.searchModels).mockResolvedValue({
      provider: 'huggingface',
      results: [{
        id: 'Qwen/Qwen3.6-27B', repo: 'Qwen/Qwen3.6-27B', label: 'Qwen3.6-27B',
        url: 'hf://Qwen/Qwen3.6-27B', format: 'safetensors', compatibility: 'compatible',
      }],
      total: 1,
      nextCursor: null,
    });
    vi.mocked(api.modelArtifacts).mockResolvedValue({
      provider: 'huggingface',
      baseModel: {id: 'Qwen/Qwen3.6-27B', repo: 'Qwen/Qwen3.6-27B', label: 'Qwen3.6-27B'},
      artifacts: [{
        id: 'Qwen/Qwen3.6-27B', repo: 'Qwen/Qwen3.6-27B', label: 'Qwen3.6-27B',
        url: 'hf://Qwen/Qwen3.6-27B', format: 'safetensors', compatibility: 'compatible',
      }],
      total: 1,
      nextCursor: null,
    });
    const user = userEvent.setup();
    await mount();
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'FreeToken');
    await screen.findByRole('heading', {name: 'FreeToken'});
    await user.clear(screen.getByPlaceholderText('Qwen, GLM, DeepSeek…'));
    await user.type(screen.getByPlaceholderText('Qwen, GLM, DeepSeek…'), 'Qwen');
    await user.click(screen.getByRole('button', {name: 'Search'}));

    await waitFor(() => expect(api.searchModels).toHaveBeenCalledTimes(1));
    const params = vi.mocked(api.searchModels).mock.calls[0]?.[0];
    expect(params?.get('provider')).toBe('huggingface');
    expect(params?.get('engine')).toBe('FreeToken');
    expect(params?.get('computeTarget')).toBe('nvidia-gpu');
    expect(await screen.findByLabelText('Matching model')).toHaveValue('Qwen/Qwen3.6-27B');
  });

  it('uses the engine-specific configuration and excludes KV/offloading fields', async () => {
    const user = userEvent.setup();
    await mount();
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'FreeToken');
    await screen.findByRole('heading', {name: 'FreeToken'});

    expect(screen.queryByLabelText('KV Cache')).not.toBeInTheDocument();
    expect(screen.getByLabelText('FreeToken GPU allocation')).toHaveTextContent('ai · NVIDIA RTX 5090');
    expect(screen.getByText('legacy · NVIDIA Tesla K80 · unavailable')).toBeVisible();
    expect(screen.getByLabelText('FreeToken GPU memory')).toHaveValue('18000');
    expect(screen.getByLabelText('FreeToken system RAM')).toHaveValue('8192');
    expect(screen.getByLabelText('FreeToken system RAM')).toHaveAttribute('max', '12000');
    expect(screen.getByLabelText('FreeToken GPU memory')).toHaveAttribute('min', '1024');
    expect(screen.getByLabelText('FreeToken system RAM')).toHaveAttribute('min', '4096');

    await user.selectOptions(screen.getByLabelText('Model source'), 'direct');
    await user.type(screen.getByLabelText('Hugging Face model reference'), 'hf://Qwen/Qwen3.6-27B');
    const createButton = screen.getByRole('button', {name: 'Add Local Model'});
    expect(createButton).toBeEnabled();
    const createForm = createButton.closest('form') as HTMLFormElement;
    expect([...createForm.querySelectorAll(':invalid')].map((element) => element.outerHTML)).toEqual([]);
    await user.click(createButton);
    expect(screen.queryByRole('alert')).toBeNull();

    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({
      local: expect.objectContaining({
        engine: 'FreeToken', computeTarget: 'nvidia-gpu',
        freetoken: expect.objectContaining({
          gpuDevice: 'node:ai', gpuCount: 1, gpuMemoryMi: 18000, systemMemoryMi: 8192, memoryStrategy: 'auto',
          advanced: expect.objectContaining({cacheType: 'radix'}),
        }),
      }),
    })));
    const payload = vi.mocked(api.createLocalModel).mock.calls[0]?.[0] as {local: Record<string, unknown>};
    expect(payload.local).not.toHaveProperty('kvCacheType');
    expect(payload.local).not.toHaveProperty('cpuOffloading');
    expect(payload.local).toMatchObject({contextWindow: 4096, maxNumSeqs: 1});
    expect((payload.local.freetoken as {advanced: Record<string, unknown>}).advanced).not.toHaveProperty('memoryRatio');
  });

  it('derives the automatic RAM budget from the selected GPU node rather than cluster-wide CPU memory', async () => {
    const models = baseModels();
    const device = models.computeTargets.freeTokenCapabilities?.devices?.[0];
    if (!device) throw new Error('FreeToken capability fixture is missing.');
    device.systemMemoryMi = 128 * 1024;
    device.systemAvailableMi = 96 * 1024;

    await mount(models);
    await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'FreeToken');
    await screen.findByRole('heading', {name: 'FreeToken'});

    // The automatic policy is one quarter of installed node RAM, capped at
    // 32 GiB and bounded by the selected node's live available capacity.
    expect(screen.getByLabelText('FreeToken system RAM')).toHaveValue('32768');
  });

  it('selects multiple whole GPUs on one eligible node and persists an aggregate VRAM budget', async () => {
    const models = baseModels();
    const capability = models.computeTargets.freeTokenCapabilities?.devices?.[0];
    if (!capability || !models.computeMemory) throw new Error('FreeToken GPU fixture is missing.');
    capability.gpuCount = 2;
    capability.maxGpuCount = 2;
    models.computeMemory.devices?.push({
      id: 'nvidia-a-2', kind: 'gpu', name: 'NVIDIA RTX 5090', nodes: ['ai'], computeTarget: 'nvidia-gpu',
      totalMi: 24576, unreservedMi: 20000, freeMi: 20000, freeToken: {id: 'node:ai', supported: true},
    });
    const user = userEvent.setup();
    await mount(models);
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'FreeToken');
    await screen.findByRole('heading', {name: 'FreeToken'});
    await user.selectOptions(screen.getByLabelText('FreeToken GPU count'), '2');

    expect(screen.getByLabelText('FreeToken GPU memory')).toHaveAttribute('max', '40000');
    expect(screen.getByText(/FreeToken total limit:/)).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Model source'), 'direct');
    await user.type(screen.getByLabelText('Hugging Face model reference'), 'hf://Qwen/Qwen3.6-27B');
    await user.click(screen.getByRole('button', {name: 'Add Local Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({
      local: expect.objectContaining({freetoken: expect.objectContaining({gpuCount: 2, gpuMemoryMi: 18000})}),
    })));
  });

  it('does not fall back to cluster-wide CPU capacity when selected-node RAM telemetry is unavailable', async () => {
    const models = baseModels();
    const device = models.computeTargets.freeTokenCapabilities?.devices?.[0];
    if (!device) throw new Error('FreeToken capability fixture is missing.');
    device.systemAvailableMi = undefined;

    await mount(models);
    await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'FreeToken');
    await screen.findByRole('heading', {name: 'FreeToken'});

    expect(screen.getByLabelText('FreeToken system RAM')).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeDisabled();
  });

  it('edits only FreeToken runtime settings for a deployed FreeToken model', async () => {
    const models = baseModels();
    const gpu = models.computeMemory?.devices?.find((device) => device.id === 'nvidia-a');
    const node = models.computeTargets.freeTokenCapabilities?.devices?.[0];
    if (!gpu || !node) throw new Error('FreeToken GPU fixture is missing.');
    // This runtime already owns 18,000 MiB. Editing it must not silently
    // shrink its limit to the remainder, even when it is actively using VRAM.
    gpu.unreservedMi = 24576 - 18000;
    gpu.freeMi = 3000;
    node.systemAvailableMi = 2048;
    models.activations = [{
      metadata: {name: 'freetoken-model', uid: 'example-model-uid', generation: 2, resourceVersion: '9'},
      spec: {type: 'local', enabled: true, local: {
        engine: 'FreeToken', computeTarget: 'nvidia-gpu', modelType: 'chat', url: 'hf://Qwen/Qwen3.6-27B',
        freetoken: {gpuDevice: 'node:ai', gpuMemoryMi: 18000, systemMemoryMi: 8192, memoryStrategy: 'auto', advanced: {cacheType: 'radix'}},
      }},
      status: {phase: 'Ready', engine: 'FreeToken'},
    }];
    const user = userEvent.setup();
    await mount(models);
    await user.click(await screen.findByRole('button', {name: 'Edit freetoken-model'}));
    const dialog = await screen.findByRole('dialog', {name: 'Edit Model · freetoken-model'});
    expect(within(dialog).queryByLabelText('KV Cache')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('FreeToken GPU memory')).toHaveValue('18000');
    expect(within(dialog).getByLabelText('FreeToken system RAM')).toHaveValue('8192');
    expect(within(dialog).getByRole('button', {name: 'Save changes'})).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText('Memory strategy'), 'hybrid');
    const saveButton = within(dialog).getByRole('button', {name: 'Save changes'});
    expect(saveButton).toBeEnabled();
    const saveForm = saveButton.closest('form') as HTMLFormElement;
    expect([...saveForm.querySelectorAll(':invalid')].map((element) => element.outerHTML)).toEqual([]);
    await user.click(saveButton);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('freetoken-model', {
      expectedRevision: 'generation:example-model-uid:2', local: {freetoken: expect.objectContaining({memoryStrategy: 'hybrid', gpuMemoryMi: 18000, systemMemoryMi: 8192})},
    }));
  });

  it('does not substitute total VRAM when live FreeToken GPU capacity is explicitly zero', async () => {
    const models = baseModels();
    const gpu = models.computeMemory?.devices?.find((device) => device.id === 'nvidia-a');
    if (!gpu) throw new Error('FreeToken GPU fixture is missing.');
    gpu.freeMi = 0;
    gpu.unreservedMi = 0;
    const user = userEvent.setup();
    await mount(models);
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'FreeToken');
    await screen.findByRole('heading', {name: 'FreeToken'});

    expect(screen.getByLabelText('FreeToken GPU memory')).toBeDisabled();
    expect(screen.getByLabelText('GPU memory limit total (MiB)')).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Model source'), 'direct');
    await user.type(screen.getByLabelText('Hugging Face model reference'), 'hf://Qwen/Qwen3.6-27B');
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeDisabled();
  });

  it('renders the normalized FreeToken runtime statistics contract', async () => {
    const models = baseModels();
    models.activations = [{
      metadata: {name: 'freetoken-model', resourceVersion: '9'},
      spec: {type: 'local', enabled: true, local: {
        engine: 'FreeToken', computeTarget: 'nvidia-gpu', modelType: 'chat',
        freetoken: {gpuDevice: 'node:ai', gpuMemoryMi: 18000, systemMemoryMi: 8192, memoryStrategy: 'auto', advanced: {cacheType: 'radix'}},
      }},
      status: {phase: 'Ready', engine: 'FreeToken', freeTokenStats: {
        source: 'freetoken-v1-stats', sampledAt: '2026-09-20T12:00:00Z', vramMi: 12000,
        cacheBudgetMi: 9000, tokensPerSecond: 42.5, decodeTokensPerSecond: 42.5,
        prefillTokensPerSecond: 96.4, activeRequests: 2, p95LatencyMs: 153,
      }},
    }];

    await mount(models);

    expect(await screen.findByText('42.5 tokens/s')).toBeVisible();
    expect(screen.getByText('Decode 42.5 · Prefill 96.4')).toBeVisible();
    expect(screen.getByText('2 active requests')).toBeVisible();
    expect(screen.getByText(/12 GiB VRAM in use/)).toBeVisible();
  });

  it('restarts a running FreeToken model with its current revision', async () => {
    const models = baseModels();
    models.activations = [{
      metadata: {name: 'freetoken-model', uid: 'example-model-uid', generation: 2, resourceVersion: '9'},
      spec: {type: 'local', enabled: true, local: {
        engine: 'FreeToken', computeTarget: 'nvidia-gpu', modelType: 'chat',
        freetoken: {gpuDevice: 'node:ai', gpuMemoryMi: 18000, systemMemoryMi: 8192, memoryStrategy: 'auto', advanced: {cacheType: 'radix'}},
      }},
      status: {phase: 'Ready', engine: 'FreeToken'},
    }];
    const user = userEvent.setup();
    await mount(models);

    await user.click(await screen.findByRole('button', {name: 'Restart freetoken-model'}));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/api/models/freetoken-model/restart', {
      method: 'POST', body: JSON.stringify({expectedRevision: 'generation:example-model-uid:2'}),
    }));
  });
});
