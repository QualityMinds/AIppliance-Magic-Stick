import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {MeshStatus} from '@magicstick/dashboard-contracts';
import {MeshPage} from './MeshPage';

let status: MeshStatus;
const writes: Array<{url: string; body: Record<string, unknown>}> = [];
let onPost: ((write: typeof writes[number]) => Response | void) | undefined;
const mount = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><MeshPage /></QueryClientProvider>);

describe('Private Mesh', () => {
  beforeEach(() => {
    writes.length = 0;
    onPost = undefined;
    status = {installed: true, configured: true, phase: 'connected', authority: true,
      mesh: {name: 'example-mesh', id: 'mesh-id', authority: 'owner-id', origin: 'https://example.com'},
      node: {id: 'owner-id', name: 'stick-a', type: 'magic-stick'},
      nodes: [{id: 'owner-id', name: 'stick-a', type: 'magic-stick', online: true, revoked: false, lastSeen: 1}],
      models: ['qwen'], shares: {}, imports: ['mesh/stick-b/coder'], relay: {mode: 'auto', url: ''}, invites: []};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const write = {url: String(input), body: JSON.parse(String(init.body))};
        writes.push(write);
        return onPost?.(write) ?? new Response(JSON.stringify({accepted: true}), {headers: {'content-type': 'application/json'}});
      }
      return new Response(JSON.stringify(status), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('shows status without writes or private credentials', async () => {
    mount();
    expect(await screen.findByText('example-mesh')).toBeInTheDocument();
    expect(screen.getByRole('tab', {name: 'Invitations'})).toBeInTheDocument();
    expect(screen.getByText('Not yet reported')).toBeInTheDocument();
    expect(writes).toEqual([]);
    expect(screen.queryByLabelText('Invite token')).not.toBeInTheDocument();
  });

  it('creates a mesh only after completing the setup wizard', async () => {
    status = {installed: true, configured: false, phase: 'disconnected', models: ['qwen']};
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Create Private Mesh'}));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', {name: 'Next'})).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Mesh name'), 'example-mesh');
    await userEvent.type(within(dialog).getByLabelText('Node name'), 'stick-a');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Next'}));
    await userEvent.selectOptions(within(dialog).getByLabelText('Relay mode'), 'public');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Next'}));
    await userEvent.click(within(dialog).getByRole('checkbox', {name: 'qwen'}));
    expect(writes).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', {name: 'Create mesh'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({url: '/api/mesh/create', body: {meshName: 'example-mesh', nodeName: 'stick-a', relay: {mode: 'public'}, shares: {qwen: {enabled: true, priority: 'low'}}}});
  });

  it('offers Join Mesh before installation and installs only after confirmation', async () => {
    status = {installed: false, configured: false, phase: 'disconnected'};
    onPost = ({url}) => {if (url === '/api/modules/private-mesh/enable') status = {...status, installed: true};};
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Join Mesh'}));
    const dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    expect(writes).toEqual([]);
    expect(within(dialog).queryByLabelText('Invite token')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', {name: 'Enable Private Mesh'}));
    expect(await within(dialog).findByLabelText('Invite token')).toHaveValue('');
    expect(within(dialog).getByRole('button', {name: 'Join mesh'})).toBeDisabled();
    expect(writes).toEqual([{url: '/api/modules/private-mesh/enable', body: {}}]);
  });

  it('joins with a device name and invitation without creating a new mesh', async () => {
    const joined = {...status, authority: false};
    status = {installed: true, configured: false, phase: 'disconnected'};
    onPost = ({url}) => {if (url === '/api/mesh/join') status = joined;};
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Join Mesh'}));
    const dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    const submit = within(dialog).getByRole('button', {name: 'Join mesh'});
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Node name'), 'stick-b');
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Invite token'), 'fixture-invitation');
    expect(writes).toEqual([]);
    await userEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Join private mesh'})).not.toBeInTheDocument());
    expect(await screen.findByRole('tab', {name: 'Overview'})).toHaveAttribute('aria-selected', 'true');
    expect(writes).toEqual([{url: '/api/mesh/join', body: {nodeName: 'stick-b', token: 'fixture-invitation'}}]);
  });

  it('validates the node name and clears the invitation on cancel', async () => {
    status = {installed: true, configured: false, phase: 'disconnected'};
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Join Mesh'}));
    let dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    const name = within(dialog).getByLabelText('Node name');
    await userEvent.type(name, 'Invalid Name');
    await userEvent.type(within(dialog).getByLabelText('Invite token'), 'fixture-invitation');
    expect(within(dialog).getByRole('button', {name: 'Join mesh'})).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, 'a');
    expect(within(dialog).getByRole('button', {name: 'Join mesh'})).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}));
    await userEvent.click(screen.getByRole('button', {name: 'Join Mesh'}));
    dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    expect(within(dialog).getByLabelText('Invite token')).toHaveValue('');
    expect(writes).toEqual([]);
  });

  it('reports a failed invitation and allows correction without losing the form', async () => {
    status = {installed: true, configured: false, phase: 'disconnected'};
    onPost = () => new Response(JSON.stringify({message: 'This invitation has expired.'}), {status: 400, headers: {'content-type': 'application/json'}});
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Join Mesh'}));
    const dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    await userEvent.type(within(dialog).getByLabelText('Node name'), 'stick-b');
    await userEvent.type(within(dialog).getByLabelText('Invite token'), 'expired-fixture');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Join mesh'}));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This invitation has expired.');
    expect(within(dialog).getByLabelText('Node name')).toHaveValue('stick-b');
    expect(within(dialog).getByLabelText('Invite token')).toHaveValue('expired-fixture');
    expect(within(dialog).getByRole('button', {name: 'Join mesh'})).toBeEnabled();
    expect(status.configured).toBe(false);
    expect(writes.map(({url}) => url)).toEqual(['/api/mesh/join']);
  });

  it.each(['connected', 'disconnected', 'authentication_failed'])('keeps Join Mesh discoverable while %s without changing membership', async (phase) => {
    status.phase = phase;
    status.shares = {qwen: {enabled: true, maxConcurrent: 2, rpm: 10, tpm: 64000, maxContext: 32768, maxOutput: 2048, priority: 'low'}};
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Join Mesh'}));
    const dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    expect(within(dialog).getByText('example-mesh')).toBeInTheDocument();
    expect(within(dialog).getByText(/This node owns the mesh/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', {name: 'Leave current mesh'})).toBeEnabled();
    expect(within(dialog).queryByLabelText('Invite token')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}));
    expect(writes).toEqual([]);
    expect(status.configured).toBe(true);
    expect(status.shares.qwen?.enabled).toBe(true);
  });

  it('requires an explicit leave before joining another mesh and returns to Overview', async () => {
    const joined = {...status, authority: false, mesh: {...status.mesh!, name: 'another-mesh'}};
    onPost = ({url}) => {
      if (url === '/api/mesh/leave') status = {installed: true, configured: false, phase: 'disconnected'};
      if (url === '/api/mesh/join') status = joined;
    };
    mount();
    await userEvent.click(await screen.findByRole('tab', {name: 'Invitations'}));
    await userEvent.click(screen.getByRole('button', {name: 'Join Mesh'}));
    const dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    expect(writes).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', {name: 'Leave current mesh'}));
    expect(await within(dialog).findByLabelText('Node name')).toHaveValue('stick-a');
    expect(writes.map(({url}) => url)).toEqual(['/api/mesh/leave']);
    await userEvent.type(within(dialog).getByLabelText('Invite token'), 'fresh-fixture');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Join mesh'}));
    expect(await screen.findByText('another-mesh')).toBeInTheDocument();
    expect(screen.getByRole('tab', {name: 'Overview'})).toHaveAttribute('aria-selected', 'true');
    expect(writes).toEqual([{url: '/api/mesh/leave', body: {}}, {url: '/api/mesh/join', body: {nodeName: 'stick-a', token: 'fresh-fixture'}}]);
  });

  it('does not proceed to join if leaving the current mesh failed', async () => {
    onPost = () => new Response(JSON.stringify({message: 'Private Mesh is currently unavailable.'}), {status: 503, headers: {'content-type': 'application/json'}});
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Join Mesh'}));
    const dialog = screen.getByRole('dialog', {name: 'Join private mesh'});
    await userEvent.click(within(dialog).getByRole('button', {name: 'Leave current mesh'}));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Private Mesh is currently unavailable.');
    expect(within(dialog).getByRole('button', {name: 'Leave current mesh'})).toBeEnabled();
    expect(within(dialog).queryByLabelText('Invite token')).not.toBeInTheDocument();
    expect(status.configured).toBe(true);
    expect(writes.map(({url}) => url)).toEqual(['/api/mesh/leave']);
  });

  it('keeps sharing unchanged until explicitly saved', async () => {
    mount();
    await userEvent.click(await screen.findByRole('tab', {name: 'Models'}));
    await userEvent.click(screen.getByText('qwen', {selector: 'strong'}));
    expect(screen.getByRole('button', {name: 'Save sharing'})).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', {name: 'Share with private mesh'}));
    expect(writes).toEqual([]);
    expect(screen.getByText('Remote request limits')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Save sharing'}));
    await waitFor(() => expect(writes[0]).toMatchObject({url: '/api/mesh/share', body: {model: 'qwen', settings: {enabled: true, maxConcurrent: 2}}}));
  });

  it.each(['ollama-model', 'vllm-model', 'freetoken-model'])('offers %s for sharing without an engine restriction', async (name) => {
    status.models = [name];
    status.components = {models: 'ready', mesh: 'ready'};
    mount();
    expect(await screen.findByText('Local models · ready')).toBeInTheDocument();
    expect(screen.queryByText(/vLLM ·/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', {name: 'Models'}));
    await userEvent.click(screen.getByText(name, {selector: 'strong'}));
    await userEvent.click(screen.getByRole('checkbox', {name: 'Share with private mesh'}));
    await userEvent.click(screen.getByRole('button', {name: 'Save sharing'}));
    await waitFor(() => expect(writes[0]).toMatchObject({url: '/api/mesh/share', body: {model: name, settings: {enabled: true}}}));
  });

  it('shows an engine-neutral empty state', async () => {
    status.models = [];
    mount();
    await userEvent.click(await screen.findByRole('tab', {name: 'Models'}));
    expect(screen.getByText('No local model is ready. Start a model in Models to share it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Save sharing'})).not.toBeInTheDocument();
  });

  it('does not offer invites to a joined client', async () => {
    status.authority = false;
    status.node!.type = 'client';
    mount();
    await screen.findByRole('tab', {name: 'Overview'});
    expect(screen.queryByRole('tab', {name: 'Invitations'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Revoke access'})).not.toBeInTheDocument();
  });

  it('saves relay changes only on request', async () => {
    mount();
    await userEvent.click(await screen.findByRole('tab', {name: 'Network'}));
    expect(screen.getByRole('button', {name: 'Save network'})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Relay mode'), 'custom');
    await userEvent.type(screen.getByLabelText('Relay URL'), 'https://relay.example.com');
    expect(writes).toEqual([]);
    await userEvent.click(screen.getByRole('button', {name: 'Save network'}));
    await waitFor(() => expect(writes[0]).toMatchObject({url: '/api/mesh/relay', body: {mode: 'custom', url: 'https://relay.example.com'}}));
  });

  it('offers setup without a license file or license-status request', async () => {
    status = {...status, installed: false, configured: false};
    mount();
    expect(await screen.findByRole('button', {name: 'Enable Private Mesh'})).toBeEnabled();
    expect(screen.queryByRole('link', {name: 'Manage license'})).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/license'))).toBe(false);
  });
});
