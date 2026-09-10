import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ManagedHost, Session} from '@magicstick/dashboard-contracts';
import {HostPowerPanel, HostPreparationPanel} from './HostManagement';

const session: Session = {subject: 'example', username: 'example', roles: ['magicstick-admin'], identityManagementAvailable: false, identityManagementMode: 'external'};
let host: ManagedHost;
const writes: Array<Record<string, unknown>> = [];
const response = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
const mount = (component = <HostPowerPanel />) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}>{component}</QueryClientProvider>);

describe('host operations', () => {
  beforeEach(() => {
    writes.length = 0;
    host = {name: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a', kernel: '6.8-test', available: true, message: 'Host worker available.',
      plan: {id: 'f'.repeat(64), state: 'available', profileId: 'strix-halo-ubuntu-24.04', profileVersion: '1', gpuProfile: 'strix-halo', experimental: true,
        packages: {'linux-generic-hwe-24.04': '7.0.0-test'}, rebootRequired: true, targetKernel: '7.0-test', message: 'Kernel preparation needed.', displayGpus: ['1002:1586']}};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {const body = JSON.parse(String(init.body)); writes.push(body); host.operation = {action: body.action, requestId: body.requestId, phase: 'Pending'}; return response({accepted: true, requestId: body.requestId, operation: {phase: 'Pending'}});}
      return response({nodes: [host]});
    }));
  });

  it.each(['Restart computer', 'Shut down computer'])('requires exact host confirmation for %s', async (name) => {
    mount();
    await userEvent.click(await screen.findByRole('button', {name}));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', {name});
    expect(confirm).toBeDisabled();
    expect(writes).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(confirm);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: name.startsWith('Restart') ? 'reboot' : 'poweroff', nodeUid: 'node-uid', bootId: 'boot-a',
      confirmation: 'example-node', acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, requestId: expect.stringMatching(/^[a-f0-9]{32}$/)});
    expect(writes[0]).not.toHaveProperty('planId');
    expect(await screen.findByText(/Request accepted/)).toBeInTheDocument();
    expect(screen.getByRole('button', {name})).toBeDisabled();
  });

  it('cancel never sends a power request', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Shut down computer'}));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Cancel'}));
    expect(writes).toHaveLength(0);
  });

  it.each([true, false])('disables actions for %s unavailable/busy host', async (busy) => {
    host.available = busy;
    if (busy) host.operation = {requestId: 'b'.repeat(32), action: 'prepare-gpu', phase: 'Preparing'};
    mount();
    expect(await screen.findByRole('button', {name: 'Restart computer'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Shut down computer'})).toBeDisabled();
  });

  it('requires profile acknowledgement and host confirmation before preparation', async () => {
    mount(<HostPreparationPanel session={session} />);
    const review = await screen.findByRole('button', {name: 'Review hardware preparation'});
    expect(review).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', {name: /I accept the experimental profile/}));
    await userEvent.click(review);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('one orderly restart');
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Prepare hardware'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'prepare-gpu', planId: 'f'.repeat(64), allowExperimental: true, experimentMode: false});
  });

  it('an unreviewed combination requires a separate experiment toggle and plan', async () => {
    host.plan!.experiment = {...host.plan!, id: 'e'.repeat(64), experimentMode: true, message: 'Unreviewed combination; keep local console access.', displayGpus: ['1002:1586', '10de:2684']};
    host.plan!.state = 'blocked';
    mount(<HostPreparationPanel session={session} />);
    await userEvent.click(await screen.findByRole('checkbox', {name: /Experiment mode/}));
    expect(screen.getByText('1002:1586, 10de:2684')).toBeInTheDocument();
    const review = screen.getByRole('button', {name: 'Review hardware experiment'});
    expect(review).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', {name: /local recovery risk/}));
    await userEvent.click(review);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Other GPUs or network access may fail');
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Start hardware experiment'}));
    await waitFor(() => expect(writes[0]).toMatchObject({planId: 'e'.repeat(64), experimentMode: true, allowExperimental: true}));
  });

  it('viewers and operators cannot prepare hardware or activate experiments', async () => {
    host.plan!.experiment = {...host.plan!, id: 'e'.repeat(64), experimentMode: true};
    mount(<HostPreparationPanel session={{...session, roles: ['magicstick-operator']}} />);
    await screen.findByText('example-node');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /Review hardware/})).not.toBeInTheDocument();
  });
});
