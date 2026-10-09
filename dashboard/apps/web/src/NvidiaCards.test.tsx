import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelsPayload} from '@magicstick/dashboard-contracts';
import {fourNvidiaCards, nvidiaSelection} from '../regression/fixtures/nvidia-cards';
import {api} from './api';
import {nvidiaCardKey} from './NvidiaGpuSelect';
import {ModelsPage} from './pages/ModelsPage';

vi.mock('./api', () => ({api: {models: vi.fn(), popularModels: vi.fn(), estimateMemory: vi.fn(),
  createLocalModel: vi.fn(), estimateModelUpdate: vi.fn(), updateModel: vi.fn()}}));
const session = {subject: 'fixture-admin', username: 'fixture-admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const estimate = {minimumMi: 5000, recommendedMi: 6000, maximumMi: 49152, weightsMi: 4000, kvCacheMi: 500, reserveMi: 500, confidence: 'high' as const};
const key = (index: number) => nvidiaCardKey(nvidiaSelection(index));
function mount(data: ModelsPayload) {
  vi.mocked(api.models).mockResolvedValue(data);
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  render(<QueryClientProvider client={client}><ModelsPage session={session} /></QueryClientProvider>);
  return client;
}
async function create() {
  await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
  await userEvent.selectOptions(screen.getByLabelText('Inference Engine'), 'VLLM');
  await userEvent.selectOptions(screen.getByLabelText('Hardware'), 'nvidia-gpu');
  await userEvent.selectOptions(screen.getByLabelText('Model source'), 'direct');
  await userEvent.type(screen.getByLabelText('Hugging Face URL'), 'hf://fixture/small-model');
  return screen.getByRole('button', {name: 'Add Local Model'});
}
function deployed(enabled = true) {
  const data = fourNvidiaCards([0, 0, 0, 0]);
  data.activations = [{metadata: {name: 'fixture-model', resourceVersion: '9'}, spec: {type: 'local', targetNamespace: 'ai', enabled,
    local: {engine: 'VLLM', computeTarget: 'nvidia-gpu', url: 'hf://fixture/small-model', gpuDevice: nvidiaSelection(2),
      vramMi: 8192, contextWindow: 4096, maxNumSeqs: 1, kvCacheType: 'auto'}}, status: {phase: enabled ? 'Ready' : 'Disabled'}}];
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.popularModels).mockResolvedValue({provider: 'huggingface', results: [], total: 0});
  vi.mocked(api.estimateMemory).mockResolvedValue(estimate);
  vi.mocked(api.estimateModelUpdate).mockResolvedValue(estimate);
  vi.mocked(api.createLocalModel).mockResolvedValue({});
  vi.mocked(api.updateModel).mockResolvedValue({});
});

describe('NVIDIA physical card selection', () => {
  it('offers four identical cards with distinct identities and persists only the chosen binding', async () => {
    mount(fourNvidiaCards([4, 0, 3, 4]));
    const submit = await create();
    const select = screen.getByLabelText('NVIDIA card');
    expect(within(select).getAllByRole('option')).toHaveLength(4);
    expect(within(select).getByRole('option', {name: /0000:02:00.0.*no free slots/})).toBeDisabled();
    await userEvent.selectOptions(select, key(3));
    await waitFor(() => expect(api.estimateMemory).toHaveBeenLastCalledWith(expect.objectContaining({gpuDevice: nvidiaSelection(3)})));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({gpuDevice: nvidiaSelection(3)})})));
    expect(vi.mocked(api.createLocalModel).mock.calls[0]![0]).not.toHaveProperty('local.env');
  });

  it('keeps the selected card and draft when it fills despite free siblings, then releases it', async () => {
    const client = mount(fourNvidiaCards());
    const submit = await create();
    await userEvent.selectOptions(screen.getByLabelText('NVIDIA card'), key(2));
    await waitFor(() => expect(submit).toBeEnabled());
    await act(async () => {client.setQueryData(['models'], fourNvidiaCards([4, 4, 0, 4]));});
    await waitFor(() => expect(submit).toBeDisabled());
    expect(screen.getByLabelText('NVIDIA card')).toHaveValue(key(2));
    expect(screen.getByLabelText('Hugging Face URL')).toHaveValue('hf://fixture/small-model');
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    await waitFor(() => expect(api.createLocalModel).not.toHaveBeenCalled());
    await act(async () => {client.setQueryData(['models'], fourNvidiaCards());});
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('requires a new choice after node replacement and never drops a disappeared binding', async () => {
    const client = mount(fourNvidiaCards());
    const submit = await create();
    await userEvent.selectOptions(screen.getByLabelText('NVIDIA card'), key(2));
    const replaced = fourNvidiaCards();
    for (const card of replaced.computeMemory!.devices!) card.gpuDevice!.nodeUid = 'replacement-uid';
    await act(async () => {client.setQueryData(['models'], replaced);});
    expect(await screen.findByRole('option', {name: 'Selected card is no longer available'})).toBeDisabled();
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('NVIDIA card'), nvidiaCardKey(nvidiaSelection(2, 'replacement-uid')));
    await waitFor(() => expect(submit).toBeEnabled());
    const missing = fourNvidiaCards(); missing.computeMemory!.devices = []; missing.computeTargets.targets[1]!.available = false;
    await act(async () => {client.setQueryData(['models'], missing);});
    await waitFor(() => expect(submit).toBeDisabled());
    expect(screen.getByLabelText('NVIDIA card')).toBeInTheDocument();
    expect(submit).toBeDisabled(); expect(api.createLocalModel).not.toHaveBeenCalled();
  });

  it('shows one automatic node pool without pretending the device plugin can select cards', async () => {
    mount(fourNvidiaCards(undefined, false));
    await create();
    expect(screen.queryByLabelText('NVIDIA card')).not.toBeInTheDocument();
    expect(screen.getByText(/Automatic GPU assignment:/)).toBeInTheDocument();
    expect(screen.getAllByRole('article', {name: 'NVIDIA GPU pool · fixture-node'})).toHaveLength(1);
  });

  it('credits an active edit only on its own full card, not on its full siblings', async () => {
    mount(deployed());
    await userEvent.click(await screen.findByRole('button', {name: 'Edit fixture-model'}));
    const dialog = within(screen.getByRole('dialog', {name: 'Edit Model · fixture-model'}));
    const select = dialog.getByLabelText('NVIDIA card');
    expect(within(select).getByRole('option', {name: /0000:03:00.0.*1\/4 slots free/})).toBeEnabled();
    expect(within(select).getByRole('option', {name: /0000:04:00.0.*no free slots/})).toBeDisabled();
    await userEvent.clear(dialog.getByLabelText('Context Size')); await userEvent.type(dialog.getByLabelText('Context Size'), '8192');
    await waitFor(() => expect(dialog.getByRole('button', {name: 'Save changes'})).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('fixture-model', {expectedRevision: '9', local: {contextWindow: 8192}}));
  });

  it('does not borrow a stopped model slot and saves a card change independently', async () => {
    const data = deployed(false); data.computeMemory!.devices![3]!.slots = {total: 4, used: 3, free: 1, scope: 'device'};
    mount(data);
    await userEvent.click(await screen.findByRole('button', {name: 'Edit fixture-model'}));
    const dialog = within(screen.getByRole('dialog', {name: 'Edit Model · fixture-model'}));
    expect(dialog.getByRole('option', {name: /0000:03:00.0.*no free slots/})).toBeDisabled();
    await userEvent.selectOptions(dialog.getByLabelText('NVIDIA card'), key(3));
    await waitFor(() => expect(dialog.getByRole('button', {name: 'Save changes'})).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('fixture-model', {expectedRevision: '9', local: {gpuDevice: nvidiaSelection(3)}}));
  });

  it('explicitly clears a saved binding after returning to legacy allocation', async () => {
    const data = fourNvidiaCards(undefined, false); data.activations = deployed(false).activations;
    mount(data);
    await userEvent.click(await screen.findByRole('button', {name: 'Edit fixture-model'}));
    const dialog = within(screen.getByRole('dialog', {name: 'Edit Model · fixture-model'}));
    await userEvent.selectOptions(dialog.getByLabelText('NVIDIA card'), '');
    await waitFor(() => expect(api.estimateModelUpdate).toHaveBeenLastCalledWith('fixture-model', expect.objectContaining({gpuDevice: null})));
    await waitFor(() => expect(dialog.getByRole('button', {name: 'Save changes'})).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('fixture-model', {expectedRevision: '9', local: {gpuDevice: null}}));
  });
});
