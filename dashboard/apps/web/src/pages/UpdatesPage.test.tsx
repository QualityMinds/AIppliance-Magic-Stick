import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ManagedHost} from '@magicstick/dashboard-contracts';
import {UpdatesPage} from './UpdatesPage';

let host: ManagedHost;
const writes: Array<Record<string, unknown>> = [];
const mount = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><UpdatesPage /></QueryClientProvider>);

describe('Ubuntu updates', () => {
  beforeEach(() => {
    writes.length = 0;
    host = {name: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a', kernel: 'test', available: true, message: '', updates: {
      id: 'a'.repeat(64), supported: true, busy: false, rebootRequired: false,
      policy: {mode: 'security', windowStart: '03:00', windowMinutes: 120, automaticReboot: false},
      pendingCount: 3, securityCount: 2, blockedCount: 1,
      packages: [{name: 'linux-generic', installed: '1', candidate: '2', security: true, blocked: 'Hardware preparation'}],
    }};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)); writes.push(body);
        host.operation = {...body, phase: 'Pending'};
        return new Response(JSON.stringify({accepted: true}), {headers: {'content-type': 'application/json'}});
      }
      return new Response(JSON.stringify({nodes: [host]}), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('shows saved security defaults without issuing mutations', async () => {
    mount();
    expect(await screen.findByLabelText('Automatic updates')).toHaveValue('security');
    expect(screen.getByLabelText('Maintenance start (UTC)')).toHaveValue('03:00');
    expect(screen.getByRole('checkbox', {name: /Allow automatic restart/})).not.toBeChecked();
    expect(screen.getByRole('button', {name: 'Save update settings'})).toBeDisabled();
    expect(screen.getByText('linux-generic')).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('requires exact host confirmation before changing update policy', async () => {
    mount();
    await userEvent.selectOptions(await screen.findByLabelText('Automatic updates'), 'all');
    await userEvent.click(screen.getByRole('button', {name: 'Save update settings'}));
    const dialog = screen.getByRole('dialog', {name: 'Save update settings'});
    expect(within(dialog).getByRole('button', {name: 'Save settings'})).toBeDisabled();
    expect(writes).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Save settings'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'configure-updates', nodeUid: 'node-uid', bootId: 'boot-a', planId: 'a'.repeat(64),
      acknowledgeDisruption: true, updatePolicy: {mode: 'all', windowStart: '03:00', windowMinutes: 120, automaticReboot: false}});
  });

  it('asks before manual installation and keeps requested scope explicit', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Install security updates'}));
    const dialog = screen.getByRole('dialog', {name: 'Install Ubuntu updates'});
    expect(within(dialog).getByText(/does not restart the computer automatically/)).toBeInTheDocument();
    expect(writes).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Install updates'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'install-updates', updateScope: 'security'});
    expect(writes[0]).not.toHaveProperty('updatePolicy');
  });

  it('only checks after explicit click and never sends an installation scope', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Check for updates'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'check-updates', planId: 'a'.repeat(64)});
    expect(writes[0]).not.toHaveProperty('updateScope');
  });

  it.each(['busy', 'stale', 'operation'] as const)('blocks modifications for %s host state', async (kind) => {
    if (kind === 'busy') host.updates!.busy = true;
    if (kind === 'stale') host.available = false;
    if (kind === 'operation') host.operation = {action: 'prepare-gpu', requestId: 'b'.repeat(32), phase: 'Preparing'};
    mount();
    expect(await screen.findByRole('button', {name: 'Check for updates'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Install security updates'})).toBeDisabled();
    expect(screen.getByLabelText('Automatic updates')).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it('links restart requirement to the separate power tab', async () => {
    host.updates!.rebootRequired = true;
    mount();
    expect(await screen.findByRole('link', {name: 'Computer power'})).toHaveAttribute('href', '#/system/power');
    expect(writes).toEqual([]);
  });

  it('offers no actions until host update management is installed', async () => {
    host.updates = undefined;
    mount();
    expect(await screen.findByText('Update management requires the current host worker.')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Check for updates'})).not.toBeInTheDocument();
  });
});
