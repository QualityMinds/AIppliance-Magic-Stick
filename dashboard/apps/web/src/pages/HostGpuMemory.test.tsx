import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ManagedHost, Session} from '@magicstick/dashboard-contracts';
import {HostGpuMemoryPanel} from './HostGpuMemory';

const session: Session = {subject: 'example', username: 'example', roles: ['magicstick-admin'], identityManagementAvailable: false, identityManagementMode: 'external'};
let host: ManagedHost;
const writes: Array<Record<string, unknown>> = [];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const mount = (initialHost = host, initialSession = session) => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  const component = (nextHost: ManagedHost, stale = false) => <QueryClientProvider client={client}><HostGpuMemoryPanel host={nextHost} session={initialSession} stale={stale} /></QueryClientProvider>;
  const rendered = render(component(initialHost));
  return {rerender: (nextHost: ManagedHost, stale = false) => rendered.rerender(component(nextHost, stale))};
};
const fixedSlider = () => screen.getByRole('slider', {name: 'Fixed GPU reservation (firmware)'});
const dynamicSlider = () => screen.getByRole('slider', {name: 'Dynamic GPU memory limit'});
const review = () => screen.getByRole('button', {name: 'Review memory configuration'});
const consent = () => screen.getByRole('checkbox', {name: /I accept the experimental memory configuration/});
const chooseMemory = () => {
  fireEvent.change(fixedSlider(), {target: {value: '0'}});
  fireEvent.change(dynamicSlider(), {target: {value: String(100 * 1024)}});
};
const openConfirmation = async () => {
  chooseMemory();
  await userEvent.click(consent());
  await userEvent.click(review());
  return screen.getByRole('dialog');
};

describe('host shared GPU memory', () => {
  beforeEach(() => {
    writes.length = 0;
    host = {name: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a', kernel: '7.0-test', available: true, message: 'Host worker available.',
      gpuMemory: {id: 'a'.repeat(64), supported: true, message: 'Firmware memory settings are available.', pciAddress: '0000:01:00.0',
        systemMemoryMi: 65536, currentCarveoutIndex: 4, currentCarveoutMi: 65536, currentDynamicLimitMi: 32768,
        options: [{index: 4, label: '64G', sizeMi: 65536}, {index: 9, label: '512M', sizeMi: 512}, {index: 2, label: '32G', sizeMi: 32768}],
        systemReserveMi: 16384, stepMi: 1024, minDynamicLimitMi: 1024}};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {const body = JSON.parse(String(init.body)); writes.push(body); return response({accepted: true, requestId: body.requestId, operation: {phase: 'Pending'}});}
      return response({nodes: [host]});
    }));
  });

  it('shows actual memory pools and a discrete slider using only firmware choices', async () => {
    mount();
    expect(screen.getByText('Current fixed GPU reservation').nextElementSibling).toHaveTextContent('64 GiB');
    expect(screen.getByText('Current dynamic GPU ceiling (TTM)').nextElementSibling).toHaveTextContent('32 GiB');
    expect(screen.getByText('Currently visible Linux RAM').nextElementSibling).toHaveTextContent('64 GiB');
    expect(screen.queryByText(/not additional independent pools/)).not.toBeInTheDocument();
    await userEvent.hover(screen.getByRole('button', {name: 'Explain Shared GPU memory on example-node'}));
    expect(screen.getByText(/not additional independent pools/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(fixedSlider()).toHaveAttribute('max', '2');
    expect(fixedSlider()).toHaveAttribute('aria-valuetext', '64G: 64 GiB');
    expect(review()).toBeDisabled();
    fireEvent.change(fixedSlider(), {target: {value: '0'}});
    expect(fixedSlider()).toHaveAttribute('aria-valuetext', '512M: 512 MiB');
    expect(dynamicSlider()).toHaveAttribute('max', String(111 * 1024));
    expect(screen.getByText('Projected Linux RAM after fixed reservation').nextElementSibling).toHaveTextContent('127.5 GiB');
    expect(writes).toHaveLength(0);
  });

  it('requires explicit consent and the exact hostname before submitting a scoped operation', async () => {
    mount(); chooseMemory();
    expect(review()).toBeDisabled();
    await userEvent.click(consent()); await userEvent.click(review());
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('up to two restarts');
    expect(dialog).toHaveTextContent('not guaranteed');
    const confirm = within(dialog).getByRole('button', {name: 'Apply memory configuration'});
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'Example-node');
    expect(confirm).toBeDisabled(); expect(writes).toHaveLength(0);
    await userEvent.clear(within(dialog).getByLabelText('Type example-node to confirm'));
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(confirm);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({action: 'configure-gpu-memory', nodeName: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a',
      requestId: expect.stringMatching(/^[a-f0-9]{32}$/), confirmation: 'example-node', acknowledgeDisruption: true,
      allowExperimental: true, experimentMode: false, planId: 'a'.repeat(64), gpuMemory: {carveoutIndex: 9, dynamicLimitMi: 102400}});
    expect(await screen.findByText(/Memory configuration requested/)).toBeInTheDocument();
    expect(review()).toBeDisabled();
  });

  it('explains that a dynamic-limit-only change requires one restart', async () => {
    mount(); fireEvent.change(dynamicSlider(), {target: {value: String(40 * 1024)}});
    await userEvent.click(consent()); await userEvent.click(review());
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Changing only the dynamic limit requires one restart.');
    expect(dialog).not.toHaveTextContent('up to two restarts');
  });

  it('cancels without writing and clears hostname confirmation before another review', async () => {
    mount(); const dialog = await openConfirmation();
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(writes).toHaveLength(0);
    await userEvent.click(review());
    expect(within(screen.getByRole('dialog')).getByRole('button', {name: 'Apply memory configuration'})).toBeDisabled();
  });

  it('keeps no-op configurations disabled even after a slider interaction', () => {
    mount(); fireEvent.change(dynamicSlider(), {target: {value: String(40 * 1024)}});
    fireEvent.change(dynamicSlider(), {target: {value: String(32 * 1024)}});
    expect(consent()).toBeDisabled(); expect(review()).toBeDisabled(); expect(writes).toHaveLength(0);
  });

  it('does not treat a rounded kernel default as a requested change', () => {
    host.gpuMemory!.currentDynamicLimitMi = 31949;
    mount();
    expect(screen.getByText('Current dynamic GPU ceiling (TTM)').nextElementSibling).toHaveTextContent('31.2 GiB');
    expect(dynamicSlider()).toHaveValue('31744');
    expect(screen.getByText('Draft rounded to 31 GiB')).toBeInTheDocument();
    expect(review()).toBeDisabled(); expect(consent()).toBeDisabled(); expect(writes).toHaveLength(0);
  });

  it('clamps the dependent dynamic limit with clear feedback and clears earlier consent', async () => {
    mount(); chooseMemory(); await userEvent.click(consent());
    fireEvent.change(fixedSlider(), {target: {value: '2'}});
    expect(dynamicSlider()).toHaveValue(String(48 * 1024));
    expect(screen.getByRole('status')).toHaveTextContent('adjusted to 48 GiB');
    expect(screen.getByRole('status')).toHaveTextContent('16 GiB CPU/OS safety allowance');
    expect(consent()).not.toBeChecked(); expect(review()).toBeDisabled();
  });

  it('preserves local slider choices on an unchanged polling report', () => {
    const view = mount(); chooseMemory();
    view.rerender({...host, observedAt: '2026-01-02T12:00:05Z', gpuMemory: {...host.gpuMemory!}});
    expect(fixedSlider()).toHaveAttribute('aria-valuetext', '512M: 512 MiB');
    expect(dynamicSlider()).toHaveValue(String(100 * 1024));
  });

  it.each(['node', 'boot', 'configuration'])('invalidates open confirmation and draft after %s evidence changes', async (change) => {
    const view = mount(); const dialog = await openConfirmation();
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    const next = {...host, ...(change === 'node' ? {nodeUid: 'new-node'} : change === 'boot' ? {bootId: 'boot-b'} : {gpuMemory: {...host.gpuMemory!, id: 'b'.repeat(64)}})};
    view.rerender(next);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fixedSlider()).toHaveAttribute('aria-valuetext', '64G: 64 GiB');
    expect(consent()).not.toBeChecked(); expect(review()).toBeDisabled(); expect(writes).toHaveLength(0);
  });

  it.each(['stale', 'unavailable', 'busy'])('blocks controls and invalidates confirmation when host becomes %s', async (state) => {
    const view = mount(); await openConfirmation();
    const next = {...host, ...(state === 'unavailable' ? {available: false} : state === 'busy' ? {operation: {action: 'prepare-gpu' as const, requestId: 'c'.repeat(32), phase: 'Preparing'}} : {})};
    view.rerender(next, state === 'stale');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fixedSlider()).toBeDisabled(); expect(dynamicSlider()).toBeDisabled(); expect(review()).toBeDisabled(); expect(writes).toHaveLength(0);
  });

  it.each(['Unsupported GPU firmware.', 'Mixed GPU configurations cannot change shared memory.'])('does not offer controls for unsupported hardware: %s', async (message) => {
    host.gpuMemory = {...host.gpuMemory!, supported: false, message}; mount();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    await userEvent.hover(screen.getByRole('button', {name: 'Explain Shared GPU memory on example-node'}));
    expect(screen.getByText(message)).toBeInTheDocument(); expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Review memory configuration'})).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('does not offer unsafe controls when required metadata is missing', () => {
    delete host.gpuMemory!.currentCarveoutMi; mount();
    expect(screen.getByText(/Complete firmware and memory information is not available/)).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it.each(['magicstick-viewer', 'magicstick-operator'])('keeps current values read-only for %s', (role) => {
    mount(host, {...session, roles: [role]});
    expect(screen.getByText('Current fixed GPU reservation')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument(); expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Review memory configuration'})).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('shows an API failure without repeating the operation automatically', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body))); return response({error: 'Host configuration changed. Refresh and review again.'}, 409);
    }));
    mount(); const dialog = await openConfirmation();
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Apply memory configuration'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Host configuration changed'); expect(writes).toHaveLength(1);
  });
});
