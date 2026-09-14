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
const mount = async (roles = session.roles, expand = true) => {
  const rendered = render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><GpuSharingControls nodeUid="example-uid" session={{...session, roles}} /></QueryClientProvider>);
  if (expand) for (const provider of providers.filter((item) => item.nodeUid === 'example-uid')) {
    await userEvent.click(await screen.findByText(`GPU Configuration ${provider.provider === 'amd' ? 'AMD' : 'NVIDIA'}`));
  }
  return rendered;
};

describe('Provider-independent GPU sharing configuration', () => {
  beforeEach(() => {
    state = {provider: 'amd', backend: 'dra', managed: false, experimental: true, mode: 'exclusive', maxModels: 2, nodeName: 'example-node', nodeUid: 'example-uid', namespace: 'ai', expectedRevision: '7', available: true, reason: '', phase: 'Ready', message: '', claimName: '', activeModels: 0, admittedModels: [], memoryIsolation: false};
    providers = [state];
    writes.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body));
        writes.push(payload);
        providers = providers.map((item) => item.provider === payload.provider ? {...item, mode: payload.mode, maxModels: payload.maxModels, managed: true} : item);
      }
      return new Response(JSON.stringify(init?.method === 'POST' ? {accepted: true} : {providers}), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('starts both provider sections collapsed and expands them independently', async () => {
    providers.push({...state, provider: 'nvidia', backend: 'time-slicing'});
    const {container} = await mount(session.roles, false);
    await screen.findByText('GPU Configuration AMD');
    expect(container.querySelectorAll('.gpu-configuration details[open]')).toHaveLength(0);
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).not.toBeVisible();
    expect(screen.getByRole('button', {name: 'Apply NVIDIA sharing'})).not.toBeVisible();
    await userEvent.click(screen.getByText('GPU Configuration AMD'));
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Apply NVIDIA sharing'})).not.toBeVisible();
    await userEvent.click(screen.getByText('GPU Configuration AMD'));
    expect(container.querySelectorAll('.gpu-configuration details[open]')).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('uses the restart confirmation instead of an additional sharing checkbox', async () => {
    await mount();
    await userEvent.selectOptions(await screen.findByLabelText('AMD allocation mode'), 'shared');
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Apply AMD sharing'}));
    expect(writes).toHaveLength(0);
    expect(screen.getByRole('dialog')).toHaveTextContent('Shared mode has no isolated GPU memory');
    await userEvent.click(screen.getByRole('button', {name: 'Apply and restart AMD models'}));
    await waitFor(() => expect(writes).toEqual([{provider: 'amd', mode: 'shared', maxModels: 2, nodeName: 'example-node', nodeUid: 'example-uid', expectedRevision: '7', acknowledgeSharing: true, acknowledgeRestart: true}]));
    await waitFor(() => expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled());
  });

  it('offers only read-only configuration to non-admin users', async () => {
    await mount(['magicstick-operator']);
    expect(await screen.findByLabelText('AMD allocation mode')).toBeDisabled();
    expect(screen.queryByRole('button', {name: 'Apply AMD sharing'})).not.toBeInTheDocument();
  });

  it('keeps explanations in an info popover and unsupported DRA disabled', async () => {
    state.available = false;
    await mount();
    expect(await screen.findByRole('option', {name: 'Shared · multiple models'})).toBeDisabled();
    expect(screen.queryByText(/does not partition/)).not.toBeInTheDocument();
    await userEvent.hover(screen.getByRole('button', {name: 'Explain AMD GPU sharing'}));
    expect(screen.getByText(/does not partition/)).toBeInTheDocument();
  });

  it('allows recovery to exclusive mode without experimental consent', async () => {
    state.mode = 'shared'; state.available = false;
    await mount();
    await userEvent.selectOptions(await screen.findByLabelText('AMD allocation mode'), 'exclusive');
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('manages NVIDIA independently beside AMD on a mixed node', async () => {
    providers.push({...state, provider: 'nvidia', backend: 'time-slicing', experimental: false, expectedRevision: '9', mode: 'shared'});
    await mount();
    const nvidia = within(await screen.findByRole('region', {name: 'NVIDIA GPU sharing'}));
    expect(screen.getByRole('region', {name: 'AMD GPU sharing'})).toBeInTheDocument();
    expect(nvidia.getByText('Time-slicing configuration')).toBeInTheDocument();
    expect(screen.getByText('DRA sharing configuration')).toBeInTheDocument();
    expect(screen.queryByText(/Inherited configuration|Experimental/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', {name: 'GPU Configuration AMD'})).toBeInTheDocument();
    expect(screen.getByRole('heading', {name: 'GPU Configuration NVIDIA'})).toBeInTheDocument();
    expect(nvidia.getByRole('heading', {name: 'GPU sharing'})).toBeInTheDocument();
    expect(nvidia.getByRole('button', {name: 'Apply NVIDIA sharing'})).toBeDisabled();
    expect(writes).toEqual([]);
    await userEvent.clear(nvidia.getByLabelText('NVIDIA maximum simultaneous models'));
    await userEvent.type(nvidia.getByLabelText('NVIDIA maximum simultaneous models'), '3');
    expect(nvidia.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(nvidia.getByRole('button', {name: 'Apply NVIDIA sharing'}));
    expect(writes).toEqual([]);
    await userEvent.click(screen.getByRole('button', {name: 'Apply and restart NVIDIA models'}));
    await waitFor(() => expect(writes).toEqual([{provider: 'nvidia', mode: 'shared', maxModels: 3, nodeName: 'example-node', nodeUid: 'example-uid', expectedRevision: '9', acknowledgeSharing: true, acknowledgeRestart: true}]));
  });

  it('does not show providers assigned to another node', async () => {
    state.nodeUid = 'other-uid';
    await mount();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('disables invalid slot limits and unchanged managed settings', async () => {
    state.managed = true; state.mode = 'shared';
    await mount();
    const count = await screen.findByLabelText('AMD maximum simultaneous models');
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled();
    await userEvent.clear(count);
    await userEvent.type(count, '17');
    expect(screen.getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it.each([
    ['amd', false], ['amd', true], ['nvidia', false], ['nvidia', true],
  ] as const)('enables Apply only while the %s configuration differs (managed: %s)', async (provider, managed) => {
    state.provider = provider; state.managed = managed;
    state.backend = provider === 'amd' ? 'dra' : 'time-slicing';
    const vendor = provider === 'amd' ? 'AMD' : 'NVIDIA';
    await mount();
    const mode = await screen.findByLabelText(`${vendor} allocation mode`);
    const apply = screen.getByRole('button', {name: `Apply ${vendor} sharing`});
    expect(apply).toBeDisabled();
    await userEvent.selectOptions(mode, 'shared');
    expect(apply).toBeEnabled();
    await userEvent.selectOptions(mode, 'exclusive');
    expect(apply).toBeDisabled();
    expect(writes).toHaveLength(0);
  });

  it.each([false, true])('recognizes only actual slot changes, including reverting to the current value (managed: %s)', async (managed) => {
    state.mode = 'shared'; state.managed = managed;
    await mount();
    const count = await screen.findByLabelText('AMD maximum simultaneous models');
    const apply = screen.getByRole('button', {name: 'Apply AMD sharing'});
    expect(apply).toBeDisabled();
    await userEvent.clear(count);
    expect(apply).toBeDisabled();
    await userEvent.type(count, '3');
    expect(apply).toBeEnabled();
    await userEvent.clear(count);
    await userEvent.type(count, '2');
    expect(apply).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
});
