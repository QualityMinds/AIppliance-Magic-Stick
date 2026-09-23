import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelsPayload, Session} from '@magicstick/dashboard-contracts';
import {ModelsPage} from './pages/ModelsPage';
import {api} from './api';

vi.mock('./api', () => ({api: {models: vi.fn(), modelLogs: vi.fn()}}));

const admin: Session = {subject: 'admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const operator: Session = {...admin, roles: ['magicstick-operator']};
const models: ModelsPayload = {
  activations: [
    {metadata: {name: 'qwen-local'}, spec: {type: 'local', enabled: true, targetNamespace: 'ai', local: {engine: 'VLLM', computeTarget: 'cpu'}}, status: {phase: 'Starting'}},
    {metadata: {name: 'remote-api'}, spec: {type: 'external', enabled: true, external: {model: 'provider/model'}}, status: {phase: 'Ready'}},
  ],
  models: [], presets: {}, computeTargets: {targets: []}, computeMemory: {devices: []},
};

const renderModels = (session: Session) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><ModelsPage session={session} /></QueryClientProvider>);

describe('model runtime logs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.models).mockResolvedValue(models);
    vi.mocked(api.modelLogs).mockResolvedValue({
      model: 'qwen-local', namespace: 'ai', generatedAt: '2026-09-19T10:00:00Z', tailLines: 300,
      pods: [{name: 'qwen-local-abc', phase: 'Running', node: 'worker-1', deleting: false, containers: [{
        name: 'server', kind: 'application', ready: true, restartCount: 1, state: 'running', logs: [
          {previous: false, text: 'server ready'},
          {previous: true, text: 'previous process failed'},
        ],
      }]}],
    });
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: vi.fn(async () => undefined)}});
  });

  it('opens bounded current and previous Pod output for a local model', async () => {
    const user = userEvent.setup();
    renderModels(admin);
    await user.click(await screen.findByRole('button', {name: 'View logs for qwen-local'}));
    expect(await screen.findByRole('dialog', {name: 'Runtime logs · qwen-local'})).toBeInTheDocument();
    expect(api.modelLogs).toHaveBeenCalledWith('qwen-local');
    expect(screen.getByLabelText('qwen-local-abc server current logs')).toHaveTextContent('server ready');
    expect(screen.getByLabelText('qwen-local-abc server previous logs')).toHaveTextContent('previous process failed');
    expect(screen.getByText('Restarts: 1')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Copy all'})).toBeInTheDocument();
  });

  it('does not expose runtime logs to operators or for external models', async () => {
    renderModels(operator);
    await screen.findByText('qwen-local');
    expect(screen.queryByRole('button', {name: /View logs/})).not.toBeInTheDocument();
    expect(api.modelLogs).not.toHaveBeenCalled();
  });
});
