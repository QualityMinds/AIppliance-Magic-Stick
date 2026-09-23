import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelsPayload, Session} from '@magicstick/dashboard-contracts';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {
  models: vi.fn(), estimateModelUpdate: vi.fn(), updateModel: vi.fn(),
}}));

const operator: Session = {subject: 'operator', username: 'operator', roles: ['magicstick-operator'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const models: ModelsPayload = {
  activations: [{
    metadata: {name: 'qwen-local', resourceVersion: '17'},
    spec: {type: 'local', enabled: true, targetNamespace: 'ai', local: {
      url: 'hf://Qwen/Qwen3.5-27B', engine: 'VLLM', computeTarget: 'nvidia-gpu', modelType: 'chat',
      contextWindow: 4096, maxNumSeqs: 1, kvCacheType: 'auto', vramMi: 8192,
    }},
    status: {phase: 'Ready'},
  }],
  models: [], presets: {},
  computeTargets: {targets: [{
    id: 'nvidia-gpu', kind: 'gpu', available: true, engines: ['VLLM'],
    kvCacheTypes: {VLLM: [{value: 'auto', label: 'Standard - model precision'}]},
  }]},
  computeMemory: {devices: [{id: 'nvidia-0', kind: 'gpu', computeTarget: 'nvidia-gpu', unreservedMi: 12000}]},
};

const renderModels = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><ModelsPage session={operator} /></QueryClientProvider>);

describe('model parameter editing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.models).mockResolvedValue(models);
    vi.mocked(api.estimateModelUpdate).mockResolvedValue({minimumMi: 6000, recommendedMi: 8000, maximumMi: 20000, confidence: 'high', weightsMi: 5000, kvCacheMi: 500, reserveMi: 500});
    vi.mocked(api.updateModel).mockResolvedValue({});
  });

  it('keeps identity fixed and saves only changed runtime parameters', async () => {
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Edit qwen-local'}));

    const dialog = await screen.findByRole('dialog', {name: 'Edit Model · qwen-local'});
    expect(within(dialog).getByText('Engine: VLLM')).toBeInTheDocument();
    expect(within(dialog).getByText('Compute: nvidia-gpu')).toBeInTheDocument();
    const save = within(dialog).getByRole('button', {name: 'Save changes'});
    expect(save).toBeDisabled();

    const context = within(dialog).getByLabelText('Context Size');
    await user.clear(context);
    await user.type(context, '8192');
    await waitFor(() => expect(api.estimateModelUpdate).toHaveBeenLastCalledWith('qwen-local', expect.objectContaining({contextWindow: 8192})));
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('qwen-local', {
      expectedRevision: '17', local: {contextWindow: 8192},
    }));
  });

  it('saves CPU changes independently of the RAM and VRAM budget', async () => {
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Edit qwen-local'}));
    const dialog = await screen.findByRole('dialog', {name: 'Edit Model · qwen-local'});
    const advanced = within(dialog).getByText('Advanced').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    await user.click(within(dialog).getByText('Advanced'));
    await user.type(within(dialog).getByLabelText('CPU reservation (cores)'), '0.5');
    await user.type(within(dialog).getByLabelText('CPU limit (cores, 0 = unlimited)'), '0');
    const save = within(dialog).getByRole('button', {name: 'Save changes'});
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('qwen-local', {
      expectedRevision: '17', local: {cpuResources: {requestMillicores: 500, limitMillicores: 0}},
    }));
  });

  it('rejects a CPU limit below the reservation and restores automatic settings', async () => {
    const user = userEvent.setup();
    const saved = structuredClone(models);
    saved.activations[0]!.spec!.local = {...saved.activations[0]!.spec!.local, cpuResources: {requestMillicores: 1000, limitMillicores: 2000}};
    vi.mocked(api.models).mockResolvedValue(saved);
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Edit qwen-local'}));
    const dialog = await screen.findByRole('dialog', {name: 'Edit Model · qwen-local'});
    await user.click(within(dialog).getByText('Advanced'));
    expect(within(dialog).getByLabelText('CPU reservation (cores)')).toHaveValue(1);
    const limit = within(dialog).getByLabelText('CPU limit (cores, 0 = unlimited)');
    await user.clear(limit);
    await user.type(limit, '0.5');
    expect(within(dialog).getByRole('button', {name: 'Save changes'})).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('at least the reservation');
    await user.click(within(dialog).getByRole('button', {name: 'Use automatic CPU settings'}));
    const save = within(dialog).getByRole('button', {name: 'Save changes'});
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('qwen-local', {expectedRevision: '17', local: {cpuResources: null}}));
  });

  it('keeps the memory slider mounted while its changed budget is re-estimated', async () => {
    const estimate = {minimumMi: 6000, recommendedMi: 8000, maximumMi: 20000, confidence: 'high' as const, weightsMi: 5000, kvCacheMi: 500, reserveMi: 500};
    let resolveUpdatedEstimate: ((value: typeof estimate) => void) | undefined;
    vi.mocked(api.estimateModelUpdate)
      .mockResolvedValueOnce(estimate)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveUpdatedEstimate = resolve; }));

    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Edit qwen-local'}));
    const dialog = await screen.findByRole('dialog', {name: 'Edit Model · qwen-local'});
    const slider = await within(dialog).findByRole('slider', {name: 'Memory reservation'});

    fireEvent.change(slider, {target: {value: '9000'}});
    await waitFor(() => expect(api.estimateModelUpdate).toHaveBeenCalledTimes(2));

    expect(within(dialog).getByRole('slider', {name: 'Memory reservation'})).toBe(slider);
    expect(slider).toHaveValue('9000');
    expect(within(dialog).queryByText('Choose a model reference to calculate memory.')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', {name: 'Save changes'})).toBeDisabled();

    resolveUpdatedEstimate?.(estimate);
    await waitFor(() => expect(within(dialog).getByRole('button', {name: 'Save changes'})).toBeEnabled());
  });

  it('edits an external provider without requiring its existing API key', async () => {
    vi.mocked(api.models).mockResolvedValue({...models, activations: [{
      metadata: {name: 'remote-api', resourceVersion: '8'},
      spec: {type: 'external', enabled: true, external: {
        model: 'provider/model', apiBase: 'https://provider.test/v1', modelType: 'chat', contextWindow: 32000,
        apiKeySecretRef: {name: 'provider-key', key: 'api-key'},
      }}, status: {phase: 'Ready'},
    }]});
    const user = userEvent.setup();
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Edit remote-api'}));
    const dialog = await screen.findByRole('dialog', {name: 'Edit Model · remote-api'});
    expect(within(dialog).getByPlaceholderText('Leave blank to keep the current key')).toHaveValue('');
    const context = within(dialog).getByLabelText('Context Size');
    await user.clear(context);
    await user.type(context, '64000');
    await user.click(within(dialog).getByRole('button', {name: 'Save changes'}));
    await waitFor(() => expect(api.updateModel).toHaveBeenCalledWith('remote-api', {
      expectedRevision: '8', external: {contextWindow: 64000},
    }));
  });
});
