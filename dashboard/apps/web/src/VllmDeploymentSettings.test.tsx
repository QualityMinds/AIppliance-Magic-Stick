import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelsPayload, Session, VisionAttentionSettings} from '@magicstick/dashboard-contracts';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {
  models: vi.fn(), popularModels: vi.fn(), searchModels: vi.fn(), modelArtifacts: vi.fn(),
  estimateMemory: vi.fn(), createLocalModel: vi.fn(), estimateModelUpdate: vi.fn(), updateModel: vi.fn(),
}}));

const session: Session = {subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const definition: VisionAttentionSettings = {
  default: 'triton', computeTargets: ['amd-gpu'], runtimeVersion: '0.26.0',
  options: [
    {value: 'auto', label: 'Automatic (vLLM default)', description: 'The engine selects its backend.'},
    {value: 'aotriton', label: 'PyTorch SDPA + AOTriton (experimental)', description: 'Requires matching experimental kernels.'},
    {value: 'triton', label: 'vLLM Triton attention', description: 'Requires compatible Triton kernels.'},
    {value: 'flash-attn-triton', label: 'FlashAttention (AMD Triton)', description: 'Requires flash_attn with AMD Triton dependencies.'},
  ],
};
const models: ModelsPayload = {
  activations: [], models: [], presets: {},
  computeTargets: {
    engineCatalog: {VLLM: {displayName: 'vLLM', deploymentSettings: {visionAttention: definition}}, OLlama: {displayName: 'Ollama'}},
    targets: ['amd-gpu', 'nvidia-gpu'].map((id) => ({id, kind: 'gpu', available: true, engines: ['VLLM', 'OLlama'],
      kvCacheTypes: {VLLM: [{value: 'auto', label: 'Standard - model precision'}], OLlama: [{value: 'f16', label: 'Standard - F16'}]},
    })),
  },
  computeMemory: {devices: ['amd-gpu', 'nvidia-gpu'].map((id) => ({id, kind: 'gpu', computeTarget: id, totalMi: 24000, unreservedMi: 20000, freeMi: 20000}))},
};
const estimate = {minimumMi: 6000, recommendedMi: 7000, maximumMi: 20000, computeTarget: 'amd-gpu', weightsMi: 5000, kvCacheMi: 500, reserveMi: 500, confidence: 'high' as const};
const renderModels = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><ModelsPage session={session} /></QueryClientProvider>);
const modelForEdit = (choice?: VisionAttentionSettings['default']) => ({...models, activations: [{
  metadata: {name: 'vision-model', resourceVersion: '17'},
  spec: {type: 'local', enabled: true, local: {
    url: 'hf://example/vision-model', engine: 'VLLM', computeTarget: 'amd-gpu', modelType: 'chat',
    vramMi: 7000, contextWindow: 4096, maxNumSeqs: 1, kvCacheType: 'auto', ...(choice ? {vllm: {visionAttention: choice}} : {}),
  }}, status: {phase: 'Ready'},
}]});

const enterReference = async (user: ReturnType<typeof userEvent.setup>, url = 'hf://example/vision-model') => {
  await user.selectOptions(screen.getByLabelText('Model source'), 'direct');
  fireEvent.change(screen.getByLabelText(url.startsWith('ollama') ? 'Ollama model reference' : 'Hugging Face URL'), {target: {value: url}});
  await waitFor(() => expect(screen.getByLabelText('VRAM budget (MiB)')).toHaveValue(7000));
};

describe('vLLM advanced deployment settings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.models).mockResolvedValue(models);
    vi.mocked(api.popularModels).mockResolvedValue({provider: 'huggingface', results: [], total: 0});
    vi.mocked(api.estimateMemory).mockResolvedValue(estimate);
    vi.mocked(api.estimateModelUpdate).mockResolvedValue(estimate);
    vi.mocked(api.createLocalModel).mockResolvedValue({});
    vi.mocked(api.updateModel).mockResolvedValue({});
  });

  it('starts collapsed with vLLM Triton attention selected and saves that default on new AMD models', async () => {
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM');
    const advanced = screen.getByText('Advanced');
    expect(advanced.closest('details')).not.toHaveAttribute('open');
    await user.click(advanced);
    const select = screen.getByLabelText('Vision attention backend');
    expect(select).toHaveValue('triton');
    expect(within(select).getAllByRole('option')).toHaveLength(4);
    expect(screen.getByLabelText('Selected vision backend information')).toHaveAttribute('title', definition.options.find((option) => option.value === 'triton')!.description);
    await enterReference(user);
    await user.click(screen.getByRole('button', {name: 'Add Local Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({
      engine: 'VLLM', computeTarget: 'amd-gpu', vllm: {visionAttention: 'triton'},
    })})));
  });

  it.each(['aotriton', 'triton', 'flash-attn-triton'] as const)('saves the manual %s choice', async (choice) => {
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM');
    await user.click(screen.getByText('Advanced'));
    await user.selectOptions(screen.getByLabelText('Vision attention backend'), choice);
    await enterReference(user);
    await user.click(screen.getByRole('button', {name: 'Add Local Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({vllm: {visionAttention: choice}})})));
  });

  it.each(['nvidia-gpu', 'OLlama'])('does not leak manual settings when switching to %s', async (selection) => {
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM');
    await user.click(screen.getByText('Advanced'));
    await user.selectOptions(screen.getByLabelText('Vision attention backend'), 'aotriton');
    await user.selectOptions(screen.getByLabelText(selection === 'OLlama' ? 'Inference Engine' : 'Hardware'), selection);
    expect(screen.queryByLabelText('Vision attention backend')).not.toBeInTheDocument();
    await enterReference(user, selection === 'OLlama' ? 'ollama://example:latest' : undefined);
    await user.click(screen.getByRole('button', {name: 'Add Local Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalled());
    const payload = vi.mocked(api.createLocalModel).mock.calls[0]![0] as {local: Record<string, unknown>};
    expect(payload.local).not.toHaveProperty('vllm');
  });

  it('restores the catalog default after switching hardware away and back', async () => {
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM');
    await user.click(screen.getByText('Advanced'));
    await user.selectOptions(screen.getByLabelText('Vision attention backend'), 'triton');
    await user.selectOptions(screen.getByLabelText('Hardware'), 'nvidia-gpu');
    await user.selectOptions(screen.getByLabelText('Hardware'), 'amd-gpu');
    expect(screen.getByLabelText('Vision attention backend')).toHaveValue('triton');
  });

  it('loads the saved choice and edits it independently of memory and KV cache', async () => {
    vi.mocked(api.models).mockResolvedValue(modelForEdit('flash-attn-triton'));
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Edit vision-model'}));
    const dialog = await screen.findByRole('dialog', {name: 'Edit Model · vision-model'});
    const advanced = within(dialog).getByText('Advanced');
    expect(advanced.closest('details')).not.toHaveAttribute('open');
    await user.click(advanced);
    expect(within(dialog).getByLabelText('Vision attention backend')).toHaveValue('flash-attn-triton');
    const save = within(dialog).getByRole('button', {name: 'Save changes'});
    expect(save).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText('Vision attention backend'), 'auto');
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('vision-model', {expectedRevision: '17', local: {vllm: {visionAttention: 'auto'}}}));
  });

  it('does not add an override to existing models when another parameter is edited', async () => {
    vi.mocked(api.models).mockResolvedValue(modelForEdit());
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Edit vision-model'}));
    fireEvent.change(screen.getByLabelText('Max Num Seqs'), {target: {value: 2}});
    const save = screen.getByRole('button', {name: 'Save changes'});
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('vision-model', {expectedRevision: '17', local: {maxNumSeqs: 2}}));
  });

  it('does not invent choices when the catalog has none', async () => {
    const oldCatalog = structuredClone(models);
    delete oldCatalog.computeTargets.engineCatalog;
    vi.mocked(api.models).mockResolvedValue(oldCatalog);
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM');
    expect(screen.queryByLabelText('Vision attention backend')).not.toBeInTheDocument();
  });
});
