import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {
  models: vi.fn(), popularModels: vi.fn(), searchModels: vi.fn(), modelArtifacts: vi.fn(), estimateMemory: vi.fn(),
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
      provider: 'huggingface', total: 1,
      baseModel: {id: repo, repo, modelMaxContext: context},
      artifacts: [{
        id: `${repo}-fp8`, repo: `${repo}-FP8`, url: `hf://${repo}-FP8`,
        modelMaxContext: 0,
      }],
    };
  });
  vi.mocked(api.estimateMemory).mockResolvedValue({
    minimumMi: 6000, recommendedMi: 7000, maximumMi: 60000, computeTarget: 'cpu',
    weightsMi: 5000, kvCacheMi: 500, reserveMi: 500, confidence: 'estimated',
  });
});

describe('Hugging Face model selection', () => {
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
