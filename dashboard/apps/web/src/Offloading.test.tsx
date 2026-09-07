import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {models: vi.fn(), popularModels: vi.fn(), estimateMemory: vi.fn(), createLocalModel: vi.fn()}}));
const fixture = {
  activations: [], presets: {}, models: [],
  computeTargets: {targets: [{id: 'nvidia-gpu', kind: 'gpu', available: true, engines: ['VLLM', 'OLlama']}]},
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

describe('CPU offloading model configuration', () => {
  it('is opt-in and sends both budgets, but no client-derived engine controls', async () => {
    const user = await openForm();
    expect(screen.getByLabelText('Use additional system RAM')).not.toBeChecked();
    await user.click(screen.getByLabelText('Use additional system RAM'));
    await screen.findByLabelText('Host RAM budget (MiB)');
    await waitFor(() => expect(screen.getByLabelText('Host RAM budget (MiB)')).toHaveValue(12300));
    expect(screen.getByText('Weights · GPU')).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Add Local Model'}));
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({cpuOffloading: true, memoryRequiredMi: 12300, vram: '12000Mi'})})));
    expect((vi.mocked(api.createLocalModel).mock.calls[0]![0] as {local: Record<string, unknown>}).local).not.toHaveProperty('cpuOffloadMi');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('blocks creation when host RAM cannot be verified', async () => {
    vi.mocked(api.estimateMemory).mockImplementation(async (payload) => (payload as {cpuOffloading?: boolean}).cpuOffloading
      ? {...base, offloading: {...plan, ramMaximumMi: null}} : base);
    const user = await openForm();
    await user.click(screen.getByLabelText('Use additional system RAM'));
    await screen.findByText('Unknown');
    expect(screen.getByRole('button', {name: 'Add Local Model'})).toBeDisabled();
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
