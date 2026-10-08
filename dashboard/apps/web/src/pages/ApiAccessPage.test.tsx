import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, within, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, expect, it, vi} from 'vitest';
import {ApiAccessPage} from './ApiAccessPage';
import {api} from '../api';

vi.mock('../api', () => ({api: {apiAccess: vi.fn(), createApiKey: vi.fn(), revokeApiKey: vi.fn()}}));
beforeEach(() => { vi.resetAllMocks(); });

it('creates a one-time key, clears its secret and revokes only the selected metadata ID', async () => {
  const id = 'fixture-key-id', name = 'fixture-component-key', secret = 'sk-synthetic-component';
  let present = false;
  vi.mocked(api.apiAccess).mockImplementation(async () => ({total: present ? 1 : 0, items: present ? [{id, name, status: 'active'}] : []}));
  vi.mocked(api.createApiKey).mockImplementation(async () => { present = true; return {item: {id, name}, key: secret}; });
  vi.mocked(api.revokeApiKey).mockImplementation(async () => { present = false; return {}; });
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><ApiAccessPage /></QueryClientProvider>);
  await user.click(await screen.findByRole('button', {name: 'Create API Key'}));
  const create = screen.getByRole('dialog', {name: 'Create API Key'});
  await user.type(within(create).getByLabelText('Name'), name);
  await user.click(within(create).getByRole('button', {name: 'Create Key'}));
  const created = await screen.findByRole('dialog', {name: 'API key created'});
  expect(within(created).getByText(secret)).toBeInTheDocument(); expect(api.createApiKey).toHaveBeenCalledWith(name);
  await user.click(within(created).getByRole('button', {name: 'Done'}));
  await user.click(screen.getByRole('button', {name: 'Refresh'}));
  expect(screen.queryByText(secret)).not.toBeInTheDocument();
  expect(JSON.stringify({local: {...localStorage}, session: {...sessionStorage}})).not.toContain(secret);
  const row = await screen.findByRole('row', {name: /fixture-component-key/});
  await user.click(within(row).getByRole('button', {name: 'Revoke'}));
  await user.click(within(screen.getByRole('dialog', {name: 'Revoke API key'})).getByRole('button', {name: 'Revoke'}));
  await waitFor(() => expect(api.revokeApiKey).toHaveBeenCalledWith(id));
  await waitFor(() => expect(screen.queryByRole('row', {name: /fixture-component-key/})).not.toBeInTheDocument());
});
