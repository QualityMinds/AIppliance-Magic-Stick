import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {models: vi.fn(), popularModels: vi.fn(), estimateMemory: vi.fn(), createLocalModel: vi.fn()}}));
const fixture = {
  activations: [], presets: {}, models: [],
  computeTargets: {targets: [{id: 'nvidia-gpu', kind: 'gpu', available: true, engines: ['VLLM', 'OLlama'], kvCacheTypes: {
    VLLM: [{value: 'auto', label: 'Standard - model precision'}, {value: 'fp8', label: 'FP8'}],
    OLlama: [{value: 'f16', label: 'Standard - F16'}, {value: 'q8_0', label: 'Memory saving - Q8'}, {value: 'q4_0', label: 'Strongly compressed - Q4'}],
  }}]},
  computeMemory: {devices: [{id: 'gpu-1', computeTarget: 'nvidia-gpu', unreservedMi: 12000, totalMi: 24000, freeMi: 12000}]},
};
const plan = {enabled: true, mode: 'weights' as const, vramBudgetMi: 12000, weightsOnGpuMi: 8000, weightsOnCpuMi: 4000,
  kvOnGpuMi: 2000, kvOnCpuMi: 0, hostRuntimeMi: 6144, ramMinimumMi: 10200, ramRecommendedMi: 12300,
  ramMaximumMi: 32000, gpuMinimumMi: 11000, gpuRecommendedMi: 12000, fitsVram: true, estimated: true};
const base = {minimumMi: 15000, recommendedMi: 18000, computeTarget: 'nvidia-gpu', weightsMi: 12000, kvCacheMi: 2000, reserveMi: 1000};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.models).mockResolvedValue(fixture);
  vi.mocked(api.popularModels).mockResolvedValue({results: [], provider: 'huggingface', total: 0});
  vi.mocked(api.estimateMemory).mockImplementation(async (payload) => (payload as {cpuOffloading?: boolean}).cpuOffloading
    ? {...base, minimumMi: plan.gpuMinimumMi, recommendedMi: plan.gpuRecommendedMi, offloading: {...plan}} : base);
  vi.mocked(api.createLocalModel).mockResolvedValue({});
});

async function openForm() {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><ModelsPage session={{subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}} /></QueryClientProvider>);
  await user.click(await screen.findByRole('button', {name: /^Create$/}));
  await user.selectOptions(screen.getByLabelText('Model source'), 'direct');
  await user.type(screen.getByLabelText('Hugging Face URL'), 'hf://example/model');
  await screen.findByText('VRAM reservation');
  return user;
}

async function openEmptyForm() {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><ModelsPage session={{subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'}} /></QueryClientProvider>);
  await user.click(await screen.findByRole('button', {name: /^Create$/}));
  return user;
}

describe('CPU offloading model configuration', () => {
  it('does not show a memory warning before a model has been selected and estimated', async () => {
    await openEmptyForm();
    expect(screen.getByText('Choose a model reference to calculate memory.')).toBeInTheDocument();
    expect(screen.queryByText(/Memory warning/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Add Local Model'})).not.toHaveAccessibleDescription();
  });

  it('is opt-in and sends both budgets, but no client-derived engine controls', async () => {
    const user = await openForm();
    expect(screen.getByLabelText('Use additional system RAM')).not.toBeChecked();
    await user.click(screen.getByLabelText('Use additional system RAM'));
    await screen.findByLabelText('Host RAM budget (MiB)');
    await waitFor(() => expect(screen.getByLabelText('Host RAM budget (MiB)')).toHaveValue(12300));
    expect(screen.getByText('Weights · GPU')).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Add Local Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({cpuOffloading: true, memoryRequiredMi: 12300, vram: '12000Mi', kvCacheType: 'auto'})})));
    expect((vi.mocked(api.createLocalModel).mock.calls[0]![0] as {local: Record<string, unknown>}).local).not.toHaveProperty('cpuOffloadMi');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('offers compatible cache formats and recalculates for the selected value', async () => {
    const user = await openForm();
    expect(screen.getByLabelText('KV Cache')).toHaveValue('auto');
    await user.selectOptions(screen.getByLabelText('KV Cache'), 'fp8');
    await waitFor(() => expect(api.estimateMemory).toHaveBeenCalledWith(expect.objectContaining({kvCacheType: 'fp8'})));
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'OLlama');
    await waitFor(() => expect(screen.getByLabelText('KV Cache')).toHaveValue('f16'));
    expect(screen.getByRole('option', {name: 'Memory saving - Q8'})).toBeInTheDocument();
    expect(screen.getByRole('option', {name: 'Strongly compressed - Q4'})).toBeInTheDocument();
  });

  it('warns but permits explicit risk acceptance when host RAM cannot be verified', async () => {
    vi.mocked(api.estimateMemory).mockImplementation(async (payload) => (payload as {cpuOffloading?: boolean}).cpuOffloading
      ? {...base, offloading: {...plan, ramMaximumMi: null}} : base);
    const user = await openForm();
    await user.click(screen.getByLabelText('Use additional system RAM'));
    await screen.findByText('Unknown');
    const add = screen.getByRole('button', {name: 'Add Local Model'});
    expect(add).toBeEnabled();
    expect(add).toHaveAccessibleDescription(/Unreserved host RAM could not be verified/);
    await user.click(add);
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({allowMemoryRisk: true, cpuOffloading: true, memoryRequiredMi: 12300})})));
  });

  it('permits a deliberately small host reservation without silently raising it', async () => {
    const user = await openForm();
    await user.click(screen.getByLabelText('Use additional system RAM'));
    const input = await screen.findByLabelText('Host RAM budget (MiB)');
    await waitFor(() => expect(input).toHaveValue(12300));
    await user.clear(input); await user.type(input, '100');
    const add = screen.getByRole('button', {name: 'Add Local Model'});
    expect(add).toBeEnabled();
    expect(add).toHaveAccessibleDescription(/Host RAM is below/);
    await user.click(add);
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({allowMemoryRisk: true, memoryRequiredMi: 100})})));
  });

  it('keeps syntactically invalid reservations disabled', async () => {
    const user = await openForm();
    const input = screen.getByLabelText('VRAM budget (MiB)');
    fireEvent.change(input, {target: {value: '-100'}});
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeDisabled();
    await user.clear(input); await user.type(input, '150');
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeDisabled();
  });

  it('accepts a numeric GPU budget over the slider ceiling with a warning', async () => {
    const user = await openForm();
    const input = screen.getByLabelText('VRAM budget (MiB)');
    await user.clear(input); await user.type(input, '14000');
    const add = screen.getByRole('button', {name: 'Add Local Model'});
    expect(add).toBeEnabled();
    expect(add).toHaveAccessibleDescription(/exceeds currently unreserved capacity/);
    await user.click(add);
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({allowMemoryRisk: true, vram: '14000Mi'})})));
  });

  it('does not invent 100 MiB of capacity when less than one planning step remains', async () => {
    vi.mocked(api.models).mockResolvedValue({...fixture, computeMemory: {devices: [{...fixture.computeMemory.devices[0]!, unreservedMi: 63}]}});
    await openForm();
    expect(screen.getByLabelText('Memory reservation')).toBeDisabled();
    expect(screen.getByRole('button', {name: /^100%$/})).toBeDisabled();
    expect(screen.getByText('< 100 MiB unreserved')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeEnabled();
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toHaveAccessibleDescription(/exceeds currently unreserved capacity/);
  });

  it('preserves manual RAM and resets opt-in when changing engine', async () => {
    const user = await openForm();
    await user.click(screen.getByLabelText('Use additional system RAM'));
    const input = await screen.findByLabelText('Host RAM budget (MiB)');
    await user.clear(input); await user.type(input, '15000');
    const context = screen.getByLabelText('Context Size');
    await user.clear(context); await user.type(context, '2048');
    await waitFor(() => expect(api.estimateMemory).toHaveBeenCalledWith(expect.objectContaining({cpuOffloading: true, contextWindow: 2048})));
    await waitFor(() => expect(screen.getByLabelText('Host RAM budget (MiB)')).toHaveValue(15000));
    expect(screen.getByLabelText('VRAM budget (MiB)')).toHaveValue(12000);
    await user.selectOptions(screen.getByLabelText('Inference Engine'), 'OLlama');
    expect(screen.getByLabelText('Use additional system RAM')).not.toBeChecked();
  });
});
