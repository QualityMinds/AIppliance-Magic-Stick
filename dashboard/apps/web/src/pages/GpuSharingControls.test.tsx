import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {GpuSharingState, Session} from '@magicstick/dashboard-contracts';
import {GpuSharingControls} from './GpuSharingControls';

const session: Session = {subject: 'example', username: 'example', roles: ['magicstick-admin'], identityManagementAvailable: false, identityManagementMode: 'external'};
let state: GpuSharingState;
let providers: GpuSharingState[];
const writes: unknown[] = [];
const mount = (roles = session.roles) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><GpuSharingControls nodeUid="example-uid" session={{...session, roles}} /></QueryClientProvider>);

describe('Provider-independent GPU sharing configuration', () => {
  beforeEach(() => {
    state = {provider: 'amd', backend: 'dra', managed: false, experimental: true, mode: 'exclusive', maxModels: 2, nodeName: 'example-node', nodeUid: 'example-uid', namespace: 'ai', expectedRevision: '7', available: true, reason: '', phase: 'Ready', message: '', claimName: '', activeModels: 0, admittedModels: [], memoryIsolation: false};
    providers = [state];
    writes.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(init?.method === 'POST' ? {accepted: true} : {providers}), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('requires explicit experimental consent and restart confirmation', async () => {
    mount();
    await userEvent.selectOptions(await screen.findByLabelText('AMD allocation mode'), 'shared');
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', {name: /I accept experimental/}));
    await userEvent.click(screen.getByRole('button', {name: 'Apply AMD sharing'}));
    expect(writes).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', {name: 'Apply and restart AMD models'}));
    await waitFor(() => expect(writes).toEqual([{provider: 'amd', mode: 'shared', maxModels: 2, nodeName: 'example-node', nodeUid: 'example-uid', expectedRevision: '7', acknowledgeSharing: true, acknowledgeRestart: true}]));
  });

  it('offers only read-only configuration to non-admin users', async () => {
    mount(['magicstick-operator']);
    expect(await screen.findByLabelText('AMD allocation mode')).toBeDisabled();
    expect(screen.queryByRole('button', {name: 'Apply AMD sharing'})).not.toBeInTheDocument();
  });

  it('keeps explanations in an info popover and unsupported DRA disabled', async () => {
    state.available = false;
    mount();
    expect(await screen.findByRole('option', {name: 'Shared · multiple models'})).toBeDisabled();
    expect(screen.queryByText(/does not partition/)).not.toBeInTheDocument();
    await userEvent.hover(screen.getByRole('button', {name: 'Explain AMD GPU sharing'}));
    expect(screen.getByText(/does not partition/)).toBeInTheDocument();
  });

  it('allows recovery to exclusive mode without experimental consent', async () => {
    state.mode = 'shared'; state.available = false;
    mount();
    await userEvent.selectOptions(await screen.findByLabelText('AMD allocation mode'), 'exclusive');
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('manages NVIDIA independently beside AMD on a mixed node', async () => {
    providers.push({...state, provider: 'nvidia', backend: 'time-slicing', experimental: false, expectedRevision: '9', mode: 'shared'});
    mount();
    const nvidia = within(await screen.findByRole('region', {name: 'NVIDIA GPU sharing'}));
    expect(screen.getByRole('region', {name: 'AMD GPU sharing'})).toBeInTheDocument();
    expect(nvidia.getByText('Time-slicing')).toBeInTheDocument();
    expect(nvidia.getByText('Inherited configuration')).toBeInTheDocument();
    expect(writes).toEqual([]);
    await userEvent.clear(nvidia.getByLabelText('NVIDIA maximum simultaneous models'));
    await userEvent.type(nvidia.getByLabelText('NVIDIA maximum simultaneous models'), '3');
    await userEvent.click(nvidia.getByRole('checkbox', {name: /I accept NVIDIA/}));
    await userEvent.click(nvidia.getByRole('button', {name: 'Apply NVIDIA sharing'}));
    expect(writes).toEqual([]);
    await userEvent.click(screen.getByRole('button', {name: 'Apply and restart NVIDIA models'}));
    await waitFor(() => expect(writes).toEqual([{provider: 'nvidia', mode: 'shared', maxModels: 3, nodeName: 'example-node', nodeUid: 'example-uid', expectedRevision: '9', acknowledgeSharing: true, acknowledgeRestart: true}]));
  });

  it('does not show providers assigned to another node', async () => {
    state.nodeUid = 'other-uid';
    mount();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('disables invalid slot limits and unchanged managed settings', async () => {
    state.managed = true; state.mode = 'shared';
    mount();
    const count = await screen.findByLabelText('AMD maximum simultaneous models');
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled();
    await userEvent.clear(count);
    await userEvent.type(count, '17');
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled();
    expect(writes).toEqual([]);
  });
});
