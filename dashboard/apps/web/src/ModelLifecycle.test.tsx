import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelActivation, ModelsPayload, Session} from '@magicstick/dashboard-contracts';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {models: vi.fn(), request: vi.fn(), removeModel: vi.fn()}}));

const operator: Session = {subject: 'operator', username: 'operator', roles: ['magicstick-operator'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const activation = (engine = 'VLLM', computeTarget = 'nvidia-gpu'): ModelActivation => ({
  metadata: {name: 'example-model', uid: 'example-model-uid', generation: 2, resourceVersion: '17'},
  spec: {type: 'local', enabled: true, targetNamespace: 'ai', local: {
    engine, computeTarget, url: 'hf://Qwen/Qwen3-8B', contextWindow: 4096, maxNumSeqs: 1,
  }},
  status: {phase: 'Ready'},
});
const payload = (model = activation()): ModelsPayload => ({
  activations: [model], models: [], presets: {}, computeTargets: {targets: []}, computeMemory: {devices: []},
});
const renderModels = (session = operator) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><ModelsPage session={session} /></QueryClientProvider>);

describe('model start and stop controls', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.models).mockResolvedValue(payload());
  });

  it.each([
    ['OLlama', 'cpu'], ['OLlama', 'amd-gpu'], ['OLlama', 'nvidia-gpu'],
    ['VLLM', 'cpu'], ['VLLM', 'amd-gpu'], ['VLLM', 'nvidia-gpu'],
    ['FreeToken', 'nvidia-gpu'],
  ])('stops and starts %s on %s without deleting or changing its settings', async (engine, target) => {
    const user = userEvent.setup();
    const serverModels = payload(activation(engine, target));
    const savedSettings = structuredClone(serverModels.activations[0]!.spec!.local);
    vi.mocked(api.models).mockImplementation(async () => structuredClone(serverModels));
    vi.mocked(api.request).mockImplementation(async (path) => {
      const current = serverModels.activations[0]!;
      current.spec!.enabled = path.endsWith('/start');
      current.metadata!.generation = Number(current.metadata!.generation) + 1;
      current.status = {phase: current.spec!.enabled ? 'Starting' : 'Disabled'};
      return {activation: structuredClone(current)};
    });
    renderModels();

    const stop = await screen.findByRole('button', {name: 'Stop example-model'});
    if (engine === 'FreeToken') expect(stop).toHaveAttribute('title', expect.stringContaining('temporary model downloads are cleared'));
    await user.click(stop);
    expect(api.request).toHaveBeenNthCalledWith(1, '/api/models/example-model/stop', {
      method: 'POST', body: JSON.stringify({expectedRevision: 'generation:example-model-uid:2'}),
    });
    const start = await screen.findByRole('button', {name: 'Start example-model'});
    await waitFor(() => expect(start).toBeEnabled());
    expect(screen.getByText('example-model')).toBeInTheDocument();
    await user.click(start);

    expect(api.request).toHaveBeenNthCalledWith(2, '/api/models/example-model/start', {
      method: 'POST', body: JSON.stringify({expectedRevision: 'generation:example-model-uid:3'}),
    });
    await waitFor(() => expect(screen.getByRole('button', {name: 'Stop example-model'})).toBeEnabled());
    expect(serverModels.activations[0]!.spec!.local).toEqual(savedSettings);
    expect(api.removeModel).not.toHaveBeenCalled();
  });

  it('also allows disabling an external provider route without promising a remote server shutdown', async () => {
    const user = userEvent.setup();
    const model = activation();
    model.spec = {type: 'external', enabled: true, external: {model: 'provider/model'}};
    vi.mocked(api.models).mockResolvedValue(payload(model));
    vi.mocked(api.request).mockResolvedValue({});
    renderModels();
    const stop = await screen.findByRole('button', {name: 'Stop example-model'});
    expect(stop).toHaveAttribute('title', expect.stringContaining('remote provider itself is not shut down'));
    expect(screen.queryByRole('button', {name: /Restart/})).not.toBeInTheDocument();
    await user.click(stop);
    expect(api.request).toHaveBeenCalledWith('/api/models/example-model/stop', expect.objectContaining({method: 'POST'}));
  });

  it('blocks repeated and conflicting changes while a stop request is pending', async () => {
    const user = userEvent.setup();
    let complete: ((value: object) => void) | undefined;
    vi.mocked(api.request).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    renderModels();
    const stop = await screen.findByRole('button', {name: 'Stop example-model'});
    await user.click(stop);
    expect(stop).toBeDisabled();
    expect(stop).toHaveTextContent('Stopping…');
    expect(screen.getByRole('button', {name: 'Edit example-model'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Remove'})).toBeDisabled();
    await user.click(stop);
    expect(api.request).toHaveBeenCalledTimes(1);
    await act(async () => { complete?.({}); });
  });

  it('waits for runtime removal before offering Start', async () => {
    const model = activation();
    model.spec!.enabled = false;
    model.status = {phase: 'Removing'};
    vi.mocked(api.models).mockResolvedValue(payload(model));
    renderModels();
    const start = await screen.findByRole('button', {name: 'Start example-model'});
    expect(start).toBeDisabled();
    expect(start).toHaveTextContent('Stopping…');
    expect(screen.getByRole('button', {name: 'Edit example-model'})).toBeDisabled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('uses the desired enabled state rather than an old Disabled status after starting', async () => {
    const model = activation();
    model.status = {phase: 'Disabled'};
    vi.mocked(api.models).mockResolvedValue(payload(model));
    renderModels();
    expect(await screen.findByRole('button', {name: 'Stop example-model'})).toBeEnabled();
    expect(screen.queryByRole('button', {name: 'Start example-model'})).not.toBeInTheDocument();
  });

  it('shows API errors without deleting the model or claiming that it stopped', async () => {
    const user = userEvent.setup();
    vi.mocked(api.request).mockRejectedValue(new Error('The model configuration changed. Refresh and try again.'));
    renderModels();
    await user.click(await screen.findByRole('button', {name: 'Stop example-model'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('The model configuration changed');
    expect(screen.getByRole('button', {name: 'Stop example-model'})).toBeEnabled();
    expect(screen.queryByRole('button', {name: 'Start example-model'})).not.toBeInTheDocument();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.removeModel).not.toHaveBeenCalled();
  });

  it('requires a current configuration revision before changing the runtime', async () => {
    const model = activation();
    model.metadata = {name: 'example-model'};
    vi.mocked(api.models).mockResolvedValue(payload(model));
    renderModels();
    expect(await screen.findByRole('button', {name: 'Stop example-model'})).toBeDisabled();
  });

  it('does not offer lifecycle actions for an activation already being deleted', async () => {
    const model = activation('FreeToken');
    model.metadata!.deletionTimestamp = '2026-01-01T00:00:00Z';
    vi.mocked(api.models).mockResolvedValue(payload(model));
    renderModels();
    await screen.findByText('example-model');
    expect(screen.queryByRole('button', {name: /^(Start|Stop|Restart) /})).not.toBeInTheDocument();
  });

  it('keeps viewer access and catalog-only models read-only', async () => {
    const data = payload();
    data.models = [{id: 'catalog-only'}];
    vi.mocked(api.models).mockResolvedValue(data);
    renderModels({...operator, roles: ['magicstick-viewer']});
    await screen.findByText('catalog-only');
    expect(screen.queryByRole('button', {name: /^(Start|Stop|Restart) /})).not.toBeInTheDocument();
    expect(api.request).not.toHaveBeenCalled();
  });
});
