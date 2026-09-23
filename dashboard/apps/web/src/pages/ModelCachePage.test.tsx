import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ManagedHost, Session} from '@magicstick/dashboard-contracts';
import {ModelCachePage} from './ModelCachePage';
import {allowedSystemSections, isSystemSection} from './SystemAreaPage';

let host: ManagedHost;
const writes: Array<Record<string, unknown>> = [];
const mount = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><ModelCachePage /></QueryClientProvider>);

describe('Model cache management', () => {
  beforeEach(() => {
    writes.length = 0;
    host = {name: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a', kernel: 'test', available: true, message: '', modelCache: {
      id: 'a'.repeat(64), supported: true, blocked: false, reclaimableBytes: 30e9, totalBytes: 250e9, freeBytes: 50e9,
      caches: [{id: 'huggingface', name: 'Hugging Face / vLLM', usedBytes: 20e9, clearable: true},
        {id: 'ollama', name: 'Ollama', usedBytes: 10e9, clearable: true},
        {id: 'freetoken', name: 'FreeToken (temporary)', usedBytes: 0, clearable: false}],
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

  it('shows disk and all engine caches without side effects', async () => {
    mount();
    expect(await screen.findByText('Hugging Face / vLLM')).toBeInTheDocument();
    expect(screen.getByText('Free disk space')).toBeInTheDocument();
    expect(screen.getByText('FreeToken (temporary)')).toBeInTheDocument();
    expect(screen.getByText('0 B')).toBeInTheDocument();
    expect(writes).toEqual([]);
    await userEvent.click(screen.getByRole('button', {name: 'Refresh cache'}));
    expect(writes).toEqual([]);
  });

  it('requires exact host confirmation and sends only a bounded operation', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Clear model cache'}));
    const dialog = screen.getByRole('dialog', {name: 'Clear model cache'});
    expect(within(dialog).getByRole('button', {name: 'Clear cache'})).toBeDisabled();
    expect(within(dialog).getByText(/must be downloaded again/)).toBeInTheDocument();
    expect(writes).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Clear cache'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'clear-model-cache', nodeName: 'example-node', bootId: 'boot-a', planId: 'a'.repeat(64),
      acknowledgeDisruption: true, allowExperimental: false, experimentMode: false});
    expect(writes[0]).not.toHaveProperty('path');
    expect(await screen.findByText('Cache cleanup')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Clear model cache'})).toBeDisabled();
  });

  it.each(['active-model', 'stale', 'operation', 'empty'] as const)('blocks cleanup for %s', async (kind) => {
    if (kind === 'active-model') host.modelCache!.blocked = true;
    if (kind === 'stale') host.available = false;
    if (kind === 'operation') host.operation = {action: 'prepare-gpu', requestId: 'b'.repeat(32), phase: 'Preparing'};
    if (kind === 'empty') host.modelCache!.reclaimableBytes = 0;
    mount();
    expect(await screen.findByRole('button', {name: 'Clear model cache'})).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it('does not offer a delete button on an old worker', async () => {
    host.modelCache = undefined;
    mount();
    expect(await screen.findByText('Model cache management requires the current host worker.')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Clear model cache'})).not.toBeInTheDocument();
  });

  it('registers the tab only for administrators, including direct route handling', () => {
    expect(isSystemSection('model-cache')).toBe(true);
    for (const role of ['magicstick-user', 'magicstick-operator', 'magicstick-viewer', 'magicstick-admin']) {
      const session = {subject: 'test-user', username: 'example', roles: [role]} as Session;
      expect(allowedSystemSections(session).some((section) => section.id === 'model-cache')).toBe(role === 'magicstick-admin');
    }
  });
});
