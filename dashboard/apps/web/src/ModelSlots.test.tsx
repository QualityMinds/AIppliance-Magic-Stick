import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelsPayload} from '@magicstick/dashboard-contracts';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {models: vi.fn(), popularModels: vi.fn(), estimateMemory: vi.fn(), createLocalModel: vi.fn()}}));
const session = {subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const payload = (free = 1): ModelsPayload => ({activations: [], models: [], presets: {}, computeTargets: {default: 'cpu', targets: [
  {id: 'cpu', kind: 'cpu', displayName: 'CPU', engines: ['VLLM', 'OLlama'], available: true},
  {id: 'amd-gpu', kind: 'gpu', displayName: 'AMD GPU', engines: ['VLLM', 'OLlama'], available: true, slots: {total: 2, used: 2 - free, free}},
]}, computeMemory: {devices: [{id: 'amd', kind: 'gpu', name: 'AMD GPU', computeTarget: 'amd-gpu', totalMi: 100000, unreservedMi: 100000, freeMi: 100000, slots: {total: 2, used: 2 - free, free}}]}});
const mount = async (data: ModelsPayload) => {
  vi.mocked(api.models).mockResolvedValue(data);
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  render(<QueryClientProvider client={client}><ModelsPage session={session} /></QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
  await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM');
  return client;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.popularModels).mockResolvedValue({provider: 'huggingface', results: [], total: 0});
  vi.mocked(api.estimateMemory).mockResolvedValue({minimumMi: 5000, recommendedMi: 6000, maximumMi: 100000,
    weightsMi: 4000, kvCacheMi: 500, reserveMi: 500, confidence: 'estimated'});
});

describe('model slot selection', () => {
  it('keeps a full GPU visible but disabled, even with free memory', async () => {
    await mount(payload(0));
    expect(screen.getByRole('option', {name: 'AMD GPU · no free slots (2/2 occupied)'})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Hardware'), 'amd-gpu');
    expect(screen.getByLabelText('Hardware')).toHaveValue('cpu');
    expect(screen.getByText('0 / 2 free')).toBeInTheDocument();
  });

  it('disables submission if the selected GPU fills while keeping the form and selection', async () => {
    const client = await mount(payload());
    await userEvent.selectOptions(screen.getByLabelText('Hardware'), 'amd-gpu');
    await userEvent.selectOptions(screen.getByLabelText('Model source'), 'direct');
    await userEvent.type(screen.getByLabelText('Hugging Face URL'), 'hf://example/model');
    const submit = screen.getByRole('button', {name: /Add Local Model/});
    await waitFor(() => expect(submit).toBeEnabled());
    await act(async () => {client.setQueryData(['models'], payload(0));});
    expect(screen.getByLabelText('Hardware')).toHaveValue('amd-gpu');
    expect(screen.getByLabelText('Hugging Face URL')).toHaveValue('hf://example/model');
    expect(await screen.findByText(/No free GPU model slots\./)).toBeVisible();
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    await waitFor(() => expect(screen.getAllByText(/No free GPU model slots\./)).toHaveLength(2));
    expect(api.createLocalModel).not.toHaveBeenCalled();
    await act(async () => {client.setQueryData(['models'], payload(1));});
    await waitFor(() => expect(submit).toBeEnabled());
    expect(document.getElementById('model-slots-full')).not.toBeInTheDocument();
  });

  it('uses engine-specific slots when only one runtime can use the remaining node', async () => {
    const data = payload(1);
    data.computeTargets.targets[1]!.engineAvailability = {VLLM: {available: true, slots: {total: 1, used: 1, free: 0}}, OLlama: {available: true, slots: {total: 2, used: 1, free: 1}}};
    await mount(data);
    expect(screen.getByRole('option', {name: /AMD GPU/})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'OLlama');
    expect(screen.getByRole('option', {name: 'AMD GPU · 1/2 slots free'})).toBeEnabled();
  });

  it('does not preselect a full GPU when no CPU target is offered', async () => {
    const data = payload(0); data.computeTargets.targets.shift();
    await mount(data);
    expect(screen.getByLabelText('Hardware')).toHaveValue('');
    expect(screen.getByRole('option', {name: 'No hardware with free slots'})).toBeDisabled();
    expect(screen.getByRole('button', {name: /Add Local Model/})).toBeDisabled();
  });
});
