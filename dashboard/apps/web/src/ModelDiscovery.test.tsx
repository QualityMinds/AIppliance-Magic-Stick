import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {
  models: vi.fn(), popularModels: vi.fn(), searchModels: vi.fn(), modelArtifacts: vi.fn(), estimateMemory: vi.fn(), createLocalModel: vi.fn(),
}}));

const session = {subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const models = {
  activations: [], models: [], presets: {},
  computeTargets: {default: 'cpu', targets: [{
    id: 'cpu', kind: 'cpu', available: true, engines: ['VLLM'],
    kvCacheTypes: {VLLM: [{value: 'auto', label: 'Standard - model precision'}]},
  }]},
  computeMemory: {devices: [{id: 'cpu', computeTarget: 'cpu', totalMi: 65536, unreservedMi: 60000, freeMi: 59000}]},
};

const contextFor = (repo: string) => repo.endsWith('27B') ? 262144 : 32768;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.models).mockResolvedValue(models);
  vi.mocked(api.createLocalModel).mockResolvedValue({});
  vi.mocked(api.popularModels).mockResolvedValue({provider: 'huggingface', results: [], total: 0});
  vi.mocked(api.searchModels).mockResolvedValue({
    provider: 'huggingface', total: 2,
    results: [
      {id: 'Qwen/Qwen3.8-9B', repo: 'Qwen/Qwen3.8-9B', modelMaxContext: 32768},
      {id: 'Qwen/Qwen3.8-27B', repo: 'Qwen/Qwen3.8-27B', modelMaxContext: 262144},
    ],
  });
  vi.mocked(api.modelArtifacts).mockImplementation(async (params) => {
    const repo = params.get('repo') ?? '';
    const context = contextFor(repo);
    return {
      provider: 'huggingface', total: 2,
      baseModel: {id: repo, repo, modelMaxContext: context},
      artifacts: [{
        id: `${repo}-fp8`, repo: `${repo}-FP8`, url: `hf://${repo}-FP8`,
        modelMaxContext: 0, revision: repo.endsWith('27B') ? 'b'.repeat(40) : 'a'.repeat(40),
      }, {
        id: `${repo}-bf16`, repo, url: `hf://${repo}`,
        modelMaxContext: context, revision: 'c'.repeat(40),
      }],
    };
  });
  vi.mocked(api.estimateMemory).mockResolvedValue({detectedModelType: 'chat',
    minimumMi: 6000, recommendedMi: 7000, maximumMi: 60000, computeTarget: 'cpu',
    weightsMi: 5000, kvCacheMi: 500, reserveMi: 500, confidence: 'estimated',
  });
});

describe('Hugging Face model selection', () => {
  it('shows the full revision of the selected artifact and updates it with the selection', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
      <ModelsPage session={session} />
    </QueryClientProvider>);
    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.click(screen.getByRole('button', {name: 'Search'}));
    await screen.findByText(`Revision: ${'a'.repeat(40)}`);
    await user.selectOptions(screen.getByLabelText('Quantization / artifact'), 'Qwen/Qwen3.8-9B-bf16');
    expect(screen.getByText(`Revision: ${'c'.repeat(40)}`)).toBeVisible();
    expect(screen.queryByText(`Revision: ${'a'.repeat(40)}`)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Matching model'), 'Qwen/Qwen3.8-27B');
    await screen.findByText(`Revision: ${'b'.repeat(40)}`);
    expect(screen.queryByText(`Revision: ${'c'.repeat(40)}`)).not.toBeInTheDocument();
  });

  it('does not invent a revision when the registry did not return one', async () => {
    vi.mocked(api.modelArtifacts).mockResolvedValue({provider: 'huggingface', total: 1,
      artifacts: [{id: 'unknown-revision', repo: 'example/model', url: 'hf://example/model'}]});
    const user = userEvent.setup();
    render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
      <ModelsPage session={session} />
    </QueryClientProvider>);
    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.click(screen.getByRole('button', {name: 'Search'}));
    await screen.findByLabelText('Quantization / artifact');
    expect(screen.queryByText(/^Revision:/)).not.toBeInTheDocument();
  });

  it('uses the selected base model context when its quantization has no context metadata', async () => {
    const user = userEvent.setup();
    render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
      <ModelsPage session={session} />
    </QueryClientProvider>);

    await user.click(await screen.findByRole('button', {name: 'Create'}));
    await user.click(screen.getByRole('button', {name: 'Search'}));
    await screen.findByLabelText('Matching model');
    await waitFor(() => expect(screen.getByLabelText('Context Size')).toHaveValue(32768));

    await user.selectOptions(screen.getByLabelText('Matching model'), 'Qwen/Qwen3.8-27B');

    await waitFor(() => expect(screen.getByLabelText('Selected URL')).toHaveValue('hf://Qwen/Qwen3.8-27B-FP8'));
    await waitFor(() => expect(screen.getByLabelText('Context Size')).toHaveValue(262144));
  });
});


const openDirectModel = async () => {
  render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
    <ModelsPage session={session} />
  </QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', {name: 'Create'}));
  await userEvent.selectOptions(screen.getByLabelText('Model source'), 'direct');
  await userEvent.type(screen.getByLabelText('Hugging Face URL'), 'hf://example/model');
};

it.each(['chat', 'embedding'] as const)('detects the %s task without a manual type selector and requests server resolution', async (task) => {
  vi.mocked(api.estimateMemory).mockResolvedValue({detectedModelType: task, minimumMi: 1024, recommendedMi: 2048, maximumMi: 60000});
  await openDirectModel();
  await screen.findByText(/detected automatically/);
  expect(screen.queryByLabelText('Type')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', {name: 'Model task'})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', {name: /Add Local Model/}));
  await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({modelType: 'auto'})})));
});

it('requires an explicit task when metadata is unknown and discards it for a different model', async () => {
  vi.mocked(api.estimateMemory).mockResolvedValue({detectedModelType: null, minimumMi: 1024, recommendedMi: 2048, maximumMi: 60000});
  await openDirectModel();
  const task = await screen.findByRole('combobox', {name: 'Model task'});
  expect(screen.getByRole('button', {name: /Add Local Model/})).toBeDisabled();
  await userEvent.selectOptions(task, 'embedding');
  await userEvent.type(screen.getByLabelText('Hugging Face URL'), '-different');
  await waitFor(() => expect(screen.getByRole('combobox', {name: 'Model task'})).toHaveValue(''));
  expect(screen.getByRole('button', {name: /Add Local Model/})).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole('combobox', {name: 'Model task'}), 'chat');
  await userEvent.click(screen.getByRole('button', {name: /Add Local Model/}));
  await waitFor(() => expect(api.createLocalModel).toHaveBeenCalledWith(expect.objectContaining({local: expect.objectContaining({modelType: 'chat', url: 'hf://example/model-different'})})));
});
