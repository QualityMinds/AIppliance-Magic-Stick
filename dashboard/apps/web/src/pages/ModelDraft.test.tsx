import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, within, waitFor, fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, it, vi} from 'vitest';
import type {ModelsPayload, Session} from '@magicstick/dashboard-contracts';
import {ModelsPage} from './ModelsPage';
import {api} from '../api';

vi.mock('../api', () => ({api: {models: vi.fn(), estimateModelUpdate: vi.fn(), updateModel: vi.fn()}}));

it('CPU Ollama draft starts collapsed, survives polling and disables unchanged, reverted or invalid saves', async () => {
  const session: Session = {subject: 'fixture-admin', username: 'fixture-admin', roles: ['magicstick-admin'],
    identityManagementAvailable: true, identityManagementMode: 'keycloak'};
  const models: ModelsPayload = {activations: [{metadata: {name: 'fixture-cpu', uid: 'fixture-uid', generation: 1},
    spec: {type: 'local', enabled: true, local: {engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://fixture',
      contextWindow: 2048, maxNumSeqs: 1, memoryRequiredMi: 3072}}, status: {phase: 'Ready'}}], models: [], presets: {},
    computeTargets: {targets: [{id: 'cpu', kind: 'cpu', available: true, engines: ['OLlama']}]}, computeMemory: {devices: []}};
  vi.mocked(api.models).mockImplementation(async () => structuredClone(models));
  vi.mocked(api.estimateModelUpdate).mockResolvedValue({minimumMi: 1024, recommendedMi: 2048, maximumMi: 16384, confidence: 'high', weightsMi: 512, kvCacheMi: 256, reserveMi: 256});
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}}), user = userEvent.setup();
  render(<QueryClientProvider client={client}><ModelsPage session={session} /></QueryClientProvider>);
  await user.click(await screen.findByRole('button', {name: 'Edit fixture-cpu'}));
  const dialog = screen.getByRole('dialog', {name: 'Edit Model · fixture-cpu'}), field = within(dialog).getByLabelText('Context Size');
  const save = within(dialog).getByRole('button', {name: 'Save changes'});
  expect(within(dialog).getByText('Advanced').closest('details')).not.toHaveAttribute('open'); expect(save).toBeDisabled();
  fireEvent.change(field, {target: {value: '1024'}}); await waitFor(() => expect(save).toBeEnabled());
  await client.invalidateQueries({queryKey: ['models']}); expect(field).toHaveValue(1024);
  fireEvent.change(field, {target: {value: '2048'}}); await waitFor(() => expect(save).toBeDisabled());
  fireEvent.change(field, {target: {value: '0'}}); expect(save).toBeDisabled();
  await user.click(within(dialog).getByRole('button', {name: 'Cancel'})); expect(api.updateModel).not.toHaveBeenCalled();
});
