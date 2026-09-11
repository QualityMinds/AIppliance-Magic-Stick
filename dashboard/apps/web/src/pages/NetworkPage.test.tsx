import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ManagedHost} from '@magicstick/dashboard-contracts';
import {NetworkPage} from './NetworkPage';

let host: ManagedHost;
const writes: Array<{path: string; body: Record<string, unknown>}> = [];
const mount = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><NetworkPage /></QueryClientProvider>);

describe('network configuration', () => {
  beforeEach(() => {
    writes.length = 0;
    host = {name: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a', kernel: 'test', available: true, message: '', network: {
      id: 'a'.repeat(64), supported: true, message: 'Ready', interfaces: [
        {name: 'eth0', kind: 'ethernet', mac: '02:00:00:00:00:01', state: 'UP', addresses: ['198.51.100.10/24'], editable: true, scanSupported: false, configuredMode: 'dhcp', metric: 100, clusterAddresses: []},
        {name: 'wlan0', kind: 'wifi', mac: '02:00:00:00:00:02', state: 'DOWN', addresses: [], editable: true, scanSupported: true, configuredMode: 'dhcp', metric: 600, clusterAddresses: []},
      ],
    }};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)); writes.push({path, body});
        host.operation = {...body, phase: 'Pending'};
        return new Response(JSON.stringify({accepted: true}), {headers: {'content-type': 'application/json'}});
      }
      return new Response(JSON.stringify({nodes: [host]}), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('shows Ethernet and Wi-Fi without any automatic mutations', async () => {
    mount();
    expect(await screen.findByRole('article', {name: 'Ethernet eth0'})).toBeInTheDocument();
    expect(screen.getByRole('article', {name: 'Wi-Fi wlan0'})).toBeInTheDocument();
    expect(screen.queryByText(/Ethernet and Wi-Fi use/)).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('requires exact-host confirmation for a temporary Ethernet change', async () => {
    mount();
    await userEvent.click(within(await screen.findByRole('article', {name: 'Ethernet eth0'})).getByRole('button', {name: 'Configure'}));
    await userEvent.click(screen.getByRole('button', {name: 'Review network change'}));
    const dialog = screen.getByRole('dialog', {name: 'Apply network trial'});
    expect(within(dialog).getByRole('button', {name: 'Apply temporarily'})).toBeDisabled();
    expect(writes).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Apply temporarily'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({path: '/api/host-management/operations', body: {action: 'configure-network', bootId: 'boot-a', planId: 'a'.repeat(64), acknowledgeDisruption: true, network: {interface: 'eth0', mode: 'dhcp', metric: 100, dns: []}}});
  });

  it('sends a scan only after the explicit scan button and never includes a password', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Scan Wi-Fi'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body.network).toEqual({interface: 'wlan0'});
    expect(writes[0]?.body.action).toBe('scan-wifi');
  });

  it('requires a separate manual confirmation after the connection trial', async () => {
    host.operation = {requestId: 'b'.repeat(32), action: 'configure-network', phase: 'AwaitingConfirmation', confirmationDeadline: new Date(Date.now() + 120000).toISOString()};
    mount();
    const keep = await screen.findByRole('button', {name: 'Keep this network configuration'});
    expect(writes).toEqual([]);
    expect(screen.getAllByRole('button', {name: 'Configure'}).every((button) => button.hasAttribute('disabled'))).toBe(true);
    await userEvent.click(keep);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({path: '/api/host-management/network-confirm', body: {nodeUid: 'node-uid', requestId: 'b'.repeat(32), confirmation: 'example-node'}});
  });

  it('does not offer expired confirmation or modifications with stale host data', async () => {
    host.available = false;
    host.operation = {requestId: 'b'.repeat(32), action: 'configure-network', phase: 'AwaitingConfirmation', confirmationDeadline: new Date(Date.now() - 1000).toISOString()};
    mount();
    expect(await screen.findByRole('button', {name: 'Keep this network configuration'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Scan Wi-Fi'})).toBeDisabled();
  });
});
