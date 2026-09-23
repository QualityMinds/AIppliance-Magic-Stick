import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelActivation, ModelsPayload} from '@magicstick/dashboard-contracts';
import {RealtimeModelForm} from './RealtimeModelForm';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {models: vi.fn(), popularModels: vi.fn(), searchModels: vi.fn(), modelArtifacts: vi.fn(), createLocalModel: vi.fn(), updateModel: vi.fn(), request: vi.fn()}}));
const models = (): ModelsPayload => ({
  activations: [], models: [], presets: {},
  computeTargets: {targets: [{id: 'nvidia-gpu', kind: 'gpu', available: true, engines: ['VLLM']}],
    engineCatalog: {VLLM: {displayName: 'vLLM', realtimeProfiles: {'qwen3-omni': {
      displayName: 'Qwen3-Omni Realtime · vLLM-Omni', model: 'Qwen/Qwen3-Omni-30B-A3B-Instruct',
      description: 'Pinned upstream duplex profile', gpuCounts: [1, 2], defaultContextWindow: 8192,
      maxContextWindow: 32768, defaultSystemMemoryMi: 16384, sourceRevision: 'test',
    }}}},
    realtimeDevices: [
      {profile: 'qwen3-omni', node: 'example-node', name: 'NVIDIA H100', supported: true, reason: '', gpuCount: 2, freeGpuCount: 2, gpuMemoryMi: 81920, systemMemoryMi: 131072},
      {profile: 'qwen3-omni', node: 'unsupported', name: 'NVIDIA MIG', supported: false, reason: 'MIG partitions are not supported.', gpuCount: 4, freeGpuCount: 4, gpuMemoryMi: 24576, systemMemoryMi: 65536},
    ]},
});
const wrapper = (component: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}>{component}</QueryClientProvider>);
const mount = (data = models(), activation?: ModelActivation) => wrapper(<RealtimeModelForm models={data} activation={activation} onClose={vi.fn()} onSaved={vi.fn().mockResolvedValue(undefined)} />);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.createLocalModel).mockResolvedValue({});
  vi.mocked(api.updateModel).mockResolvedValue({});
  vi.mocked(api.popularModels).mockResolvedValue({provider: 'huggingface', results: [], total: 0});
});

describe('Realtime model profile', () => {
  const checkpoint = {id: 'example/omni-finetune', repo: 'example/omni-finetune', url: 'hf://example/omni-finetune', compatibility: 'experimental' as const};

  it('searches the Hub with the Realtime profile and deploys the selected checkpoint', async () => {
    vi.mocked(api.searchModels).mockResolvedValue({provider: 'huggingface', total: 2, results: [checkpoint,
      {id: 'example/text-only', repo: 'example/text-only', url: 'hf://example/text-only', compatibility: 'incompatible', compatibilityReason: 'No audio output.'}]});
    vi.mocked(api.modelArtifacts).mockResolvedValue({provider: 'huggingface', artifacts: [checkpoint], total: 1});
    mount();
    await userEvent.click(screen.getByRole('button', {name: 'Search'}));
    const params = vi.mocked(api.searchModels).mock.calls[0]![0];
    expect(Object.fromEntries(params)).toMatchObject({q: 'Qwen3-Omni', engine: 'VLLM', realtimeProfile: 'qwen3-omni', computeTarget: 'nvidia-gpu'});
    expect(screen.getByRole('option', {name: /text-only/})).toBeEnabled();
    await userEvent.selectOptions(screen.getByLabelText('Matching model'), checkpoint.url);
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled());
    expect(api.modelArtifacts).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({url: checkpoint.url})})));
  });

  it.each(['hf://example/omni-finetune', 'example/omni-finetune', 'https://huggingface.co/example/omni-finetune/'])('accepts and normalizes direct Hugging Face path %s', async (reference) => {
    vi.mocked(api.modelArtifacts).mockResolvedValue({provider: 'huggingface', artifacts: [checkpoint], total: 1});
    mount();
    await userEvent.selectOptions(screen.getByLabelText('Model source'), 'direct');
    fireEvent.change(screen.getByLabelText('Hugging Face URL'), {target: {value: reference}});
    expect(screen.getByLabelText('Selected URL')).toHaveValue(checkpoint.url);
    await waitFor(() => expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled());
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({url: checkpoint.url})})));
  });

  it('accepts quantized, text-only and unknown repositories without metadata approval', async () => {
    vi.mocked(api.modelArtifacts).mockRejectedValue(new Error('offline'));
    mount();
    await userEvent.selectOptions(screen.getByLabelText('Model source'), 'direct');
    for (const repo of ['example/omni-AWQ-4bit', 'example/thinker-only', 'example/unknown']) {
      fireEvent.change(screen.getByLabelText('Hugging Face URL'), {target: {value: repo}});
      expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
    }
    expect(api.modelArtifacts).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Hugging Face URL'), {target: {value: 'https://example.com/model'}});
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeDisabled();
    await userEvent.click(screen.getByRole('button', {name: 'Use profile default'}));
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
  });

  it('allows long contexts, concurrency and exploratory memory budgets', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Context Size'), {target: {value: '262144'}});
    fireEvent.change(screen.getByLabelText('Concurrent sessions'), {target: {value: '16'}});
    fireEvent.change(screen.getByLabelText('Thinker CPU offload (GiB)'), {target: {value: '32'}});
    fireEvent.change(screen.getByLabelText('GPU memory budget'), {target: {value: '1'}});
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
    expect(screen.getByText('RAM below planning estimate ⓘ')).toHaveAttribute('title', expect.stringContaining('does not block'));
  });

  it.each(['cpu', 'xpu'] as const)('selects %s without a GPU allowlist and persists the runtime image', async (backend) => {
    const data = models();
    const target = backend === 'cpu' ? 'cpu' : 'intel-gpu';
    data.computeTargets.engineCatalog!.VLLM!.realtimeProfiles![backend] = {
      displayName: backend, model: 'example/omni', description: 'experimental', backend, image: '',
      computeTargets: [target], gpuCounts: [1], defaultContextWindow: 8192, defaultSystemMemoryMi: 16384, sourceRevision: 'test',
    };
    data.computeTargets.realtimeDevices!.push({profile: backend, computeTarget: target, node: 'other-node',
      name: backend, supported: true, reason: '', gpuCount: backend === 'cpu' ? 0 : 1, maxGpuCount: 1,
      freeGpuCount: 1, gpuMemoryMi: 0, systemMemoryMi: 65536});
    mount(data);
    await userEvent.selectOptions(screen.getByLabelText('Realtime profile'), backend);
    expect(screen.getByLabelText('Compute node')).toHaveValue('other-node');
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Runtime image (optional)'), {target: {value: 'example.local/omni:test'}});
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
    if (backend === 'cpu') expect(screen.queryByLabelText('GPUs')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({
      computeTarget: target, realtime: expect.objectContaining({runtimeImage: 'example.local/omni:test'}),
    })})));
  });

  it('keeps pagination on the submitted search and shows search failures', async () => {
    vi.mocked(api.searchModels).mockResolvedValueOnce({provider: 'huggingface', total: 2, results: [checkpoint], nextCursor: '1'})
      .mockRejectedValueOnce(new Error('Search rate limited.'));
    mount();
    await userEvent.click(screen.getByRole('button', {name: 'Search'}));
    fireEvent.change(screen.getByLabelText('Search Hugging Face'), {target: {value: 'different query'}});
    await userEvent.click(await screen.findByRole('button', {name: 'Load more models'}));
    expect(Object.fromEntries(vi.mocked(api.searchModels).mock.calls[1]![0])).toMatchObject({q: 'Qwen3-Omni', cursor: '1'});
    expect(await screen.findByText('Search rate limited.')).toBeVisible();
  });

  it('reloads a custom checkpoint without replacing it with the profile default', () => {
    mount(models(), {metadata: {name: 'saved-model'}, spec: {local: {engine: 'VLLM', computeTarget: 'nvidia-gpu', url: checkpoint.url,
      contextWindow: 8192, maxNumSeqs: 1, realtime: {profile: 'qwen3-omni', gpuNode: 'example-node', gpuCount: 1,
        systemMemoryMi: 16384, gpuMemoryFraction: .9, thinkerCpuOffloadGiB: 0}}}});
    expect(screen.getByLabelText('Selected URL')).toHaveValue(checkpoint.url);
    expect(screen.queryByLabelText('Model source')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Save changes'})).toBeDisabled();
  });

  it('creates a catalog-selected Qwen model with isolated defaults and collapsed advanced controls', async () => {
    mount();
    expect(screen.getByText('Advanced Settings').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Selected URL')).toHaveValue('hf://Qwen/Qwen3-Omni-30B-A3B-Instruct');
    expect(screen.getByRole('option', {name: /unsupported/})).toBeDisabled();
    expect(screen.queryByLabelText('KV Cache')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: {
      engine: 'VLLM', computeTarget: 'nvidia-gpu', modelType: 'chat', url: 'hf://Qwen/Qwen3-Omni-30B-A3B-Instruct',
      contextWindow: 8192, maxNumSeqs: 1, realtime: {profile: 'qwen3-omni', gpuNode: 'example-node', gpuCount: 1,
        systemMemoryMi: 16384, gpuMemoryFraction: .9, thinkerCpuOffloadGiB: 0},
    }})));
  });

  it('prevents exhausted GPU slots and impossible RAM settings, not memory estimates', () => {
    const data = models();
    data.computeTargets.realtimeDevices![0]!.freeGpuCount = 0;
    const view = mount(data);
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeDisabled();
    view.unmount();
    mount();
    fireEvent.change(screen.getByLabelText('System RAM (MiB)'), {target: {value: '999999'}});
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeDisabled();
    fireEvent.change(screen.getByLabelText('System RAM (MiB)'), {target: {value: '16384'}});
    fireEvent.change(screen.getByLabelText('Thinker CPU offload (GiB)'), {target: {value: '32'}});
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
  });

  it.each(['time-slicing', 'dra-shared'] as const)('allows one %s slot with a memory-isolation tooltip', async (allocationMode) => {
    const data = models();
    Object.assign(data.computeTargets.realtimeDevices![0]!, {allocationMode, gpuCount: 1, maxGpuCount: 1, slotCount: 4, freeGpuCount: 3});
    const view = mount(data);
    expect(screen.getByRole('option', {name: /3 free GPU slots/})).toBeEnabled();
    expect(screen.getByRole('option', {name: /2 GPUs/})).toBeDisabled();
    expect(screen.getByText(/Shared GPU · no VRAM isolation/)).toHaveAttribute('title', expect.stringContaining('memory'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({
      realtime: expect.objectContaining({gpuCount: 1}),
    })})));
    view.unmount();
    data.computeTargets.realtimeDevices![0]!.freeGpuCount = 0;
    mount(data);
    expect(screen.getByRole('option', {name: /0 free GPU slots/})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeDisabled();
  });

  it('reloads and edits its settings without changing model source or engine', async () => {
    const activation: ModelActivation = {metadata: {name: 'saved-realtime', resourceVersion: '17'}, spec: {type: 'local', enabled: true,
      local: {engine: 'VLLM', computeTarget: 'nvidia-gpu', url: 'hf://Qwen/Qwen3-Omni-30B-A3B-Instruct',
        contextWindow: 8192, maxNumSeqs: 1, realtime: {profile: 'qwen3-omni', gpuNode: 'example-node', gpuCount: 1,
          systemMemoryMi: 16384, gpuMemoryFraction: .9, thinkerCpuOffloadGiB: 0}}}};
    mount(models(), activation);
    expect(screen.getByRole('button', {name: 'Save changes'})).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Context Size'), {target: {value: '4096'}});
    await userEvent.click(screen.getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('saved-realtime', {
      expectedRevision: '17', local: {realtime: activation.spec!.local!.realtime, contextWindow: 4096, maxNumSeqs: 1},
    }));
  });

  it('is discoverable from the normal Models create dialog', async () => {
    vi.mocked(api.models).mockResolvedValue(models());
    wrapper(<ModelsPage session={{subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}} />);
    await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
    expect(within(screen.getByLabelText('Location')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Local', 'External']);
    await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM-Omni');
    expect(screen.getByLabelText('Location')).toHaveValue('local');
    expect(screen.getByRole('option', {name: '(Experimental) vLLM-Omni'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
    expect(screen.getByText('Engine: vLLM-Omni')).toBeVisible();
    expect(screen.queryByLabelText('KV Cache')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Model source')).toHaveValue('search');
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({
      engine: 'VLLM', realtime: expect.objectContaining({profile: 'qwen3-omni'}),
    })})));
  });

  it('switches between local engines and external providers without leaking Realtime settings', async () => {
    const data = models();
    data.computeTargets.engineCatalog!.OLlama = {displayName: 'Ollama'};
    data.computeTargets.engineCatalog!.FreeToken = {displayName: 'FreeToken'};
    data.computeTargets.targets[0]!.engines = ['VLLM', 'OLlama', 'FreeToken'];
    vi.mocked(api.models).mockResolvedValue(data);
    wrapper(<ModelsPage session={{subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}} />);
    await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
    expect(within(screen.getByLabelText('Inference Engine')).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Ollama', 'vLLM', '(Experimental) FreeToken', '(Experimental) vLLM-Omni']);
    expect(screen.getByLabelText('Inference Engine')).toHaveValue('OLlama');
    for (const engine of ['OLlama', 'FreeToken', 'VLLM']) {
      await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM-Omni');
      fireEvent.change(screen.getByLabelText('Context Size'), {target: {value: '2048'}});
      expect(screen.queryByLabelText('KV Cache')).not.toBeInTheDocument();
      await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), engine);
      expect(screen.queryByLabelText('Realtime profile')).not.toBeInTheDocument();
      expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeInTheDocument();
      expect(screen.getByLabelText(engine === 'FreeToken' ? 'Context length' : 'Context Size')).toHaveValue(4096);
      if (engine === 'OLlama') expect(screen.getByRole('heading', {name: 'Ollama Library'})).toBeVisible();
      if (engine === 'FreeToken') expect(screen.getByRole('heading', {name: 'FreeToken'})).toBeVisible();
      if (engine === 'VLLM') expect(screen.getByLabelText('KV Cache')).toHaveValue('auto');
    }
    await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM-Omni');
    expect(screen.getByLabelText('Context Size')).toHaveValue(8192);
    await userEvent.selectOptions(screen.getByLabelText('Location'), 'external');
    expect(screen.queryByLabelText('Inference Engine')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Realtime profile')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Add External Model'})).toBeInTheDocument();
    expect(api.createLocalModel).not.toHaveBeenCalled();
    expect(vi.mocked(api.popularModels).mock.calls.some(([params]) => params.get('engine') === 'VLLM-Omni')).toBe(false);
  });

  it('only offers Omni when the catalog advertises a Realtime profile', async () => {
    const data = models();
    delete data.computeTargets.engineCatalog!.VLLM!.realtimeProfiles;
    vi.mocked(api.models).mockResolvedValue(data);
    wrapper(<ModelsPage session={{subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}} />);
    await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
    expect(screen.queryByRole('option', {name: /Omni/})).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Location')).getAllByRole('option')).toHaveLength(2);
  });

  it('keeps Omni discoverable without eligible GPUs but blocks creation', async () => {
    const data = models();
    data.computeTargets.targets[0]!.available = false;
    data.computeTargets.realtimeDevices!.forEach((device) => { device.supported = false; device.freeGpuCount = 0; });
    vi.mocked(api.models).mockResolvedValue(data);
    wrapper(<ModelsPage session={{subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}} />);
    await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
    await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM-Omni');
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeDisabled();
    expect(screen.getByText(/No available compute slot/)).toBeVisible();
  });

  it.each([100, 108])('selects the ROCm profile with %s GiB shared capacity and hardware-aware RAM defaults', async (gpuCapacityGi) => {
    const data = models();
    const expectedRam = Math.max(102400, Math.floor(gpuCapacityGi * 1024 * .9) + 8192);
    data.computeTargets.engineCatalog!.VLLM!.realtimeProfiles!['qwen3-omni-rocm'] = {
      displayName: 'Qwen3-Omni Realtime AMD', model: 'Qwen/Qwen3-Omni-30B-A3B-Instruct',
      description: 'Experimental ROCm profile',
      computeTargets: ['amd-gpu'], backend: 'rocm', gpuCounts: [1], defaultContextWindow: 8192,
      maxContextWindow: 32768, defaultSystemMemoryMi: 102400, maxCpuOffloadGiB: 0,
      hostRuntimeHeadroomMi: 8192, sourceRevision: 'test',
    };
    data.computeTargets.realtimeDevices!.push({profile: 'qwen3-omni-rocm', computeTarget: 'amd-gpu',
      node: 'amd-node', name: 'AMD Strix Halo', supported: true, reason: '', gpuCount: 1, freeGpuCount: 1,
      gpuMemoryMi: gpuCapacityGi * 1024, systemMemoryMi: 122880, memoryArchitecture: 'unified', gpuAllocationMode: 'shared-gtt'});
    mount(data);
    await userEvent.selectOptions(screen.getByLabelText('Realtime profile'), 'qwen3-omni-rocm');
    expect(screen.getByLabelText('Compute node')).toHaveValue('amd-node');
    expect(screen.getByLabelText('System RAM (MiB)')).toHaveValue(expectedRam);
    expect(screen.getByLabelText('Thinker CPU offload (GiB)')).toHaveValue(0);
    expect(screen.getByText(`Shared GPU capacity: ${gpuCapacityGi} GiB`)).toBeVisible();
    fireEvent.change(screen.getByLabelText('System RAM (MiB)'), {target: {value: '98304'}});
    expect(screen.getByRole('button', {name: 'Add Realtime Model'})).toBeEnabled();
    fireEvent.change(screen.getByLabelText('System RAM (MiB)'), {target: {value: String(expectedRam)}});
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({
      computeTarget: 'amd-gpu', realtime: expect.objectContaining({profile: 'qwen3-omni-rocm', gpuNode: 'amd-node',
        systemMemoryMi: expectedRam, thinkerCpuOffloadGiB: 0}),
    })})));
    await userEvent.selectOptions(screen.getByLabelText('Realtime profile'), 'qwen3-omni');
    expect(screen.getByLabelText('Compute node')).toHaveValue('example-node');
    expect(screen.getByLabelText('System RAM (MiB)')).toHaveValue(16384);
    expect(screen.getByLabelText('Thinker CPU offload (GiB)')).toHaveValue(0);
  });

  it('shows API admission errors instead of pretending the model started', async () => {
    vi.mocked(api.createLocalModel).mockRejectedValue(new Error('The selected Realtime node does not have enough free whole-GPU slots.'));
    mount();
    await userEvent.click(screen.getByRole('button', {name: 'Add Realtime Model'}));
    expect(await screen.findByText(/does not have enough free whole-GPU slots/)).toBeVisible();
  });
});
