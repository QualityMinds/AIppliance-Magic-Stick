import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {GpuCompatibility, Session} from '@magicstick/dashboard-contracts';
import {HardwarePage} from './HardwarePage';

const session: Session = {subject: 'example', username: 'example', roles: ['magicstick-admin'], identityManagementAvailable: false, identityManagementMode: 'external'};
const profile = {id: 'strix-halo', displayName: 'AMD Strix Halo', version: '1', experimental: true, memoryArchitecture: 'unified', expectedArchitecture: 'gfx1151'};
const initial = (): GpuCompatibility => ({schemaVersion: 1, selectedProfile: '', allowExperimental: false, profiles: [profile], nodes: [{node: 'example-node', profileId: 'strix-halo', optedIn: false, eligible: false, upstreamSupported: false, memoryArchitecture: 'unified', physicalMemoryMi: 65536, gpuAccessibleMi: 49152, memoryAccountingVerified: false, hostDriverReady: true, resourceRegistered: false, validation: {OLlama: {state: 'passed', image: 'example/ollama:1', message: 'GPU calculation passed.'}, VLLM: {state: 'failed', message: 'GPU calculation failed.'}}}]});
let compatibility: GpuCompatibility;
const writes: Array<{path: string; body: unknown}> = [];
const mount = (roles = session.roles) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><HardwarePage session={{...session, roles}} /></QueryClientProvider>);
const openAdvanced = async () => {await userEvent.click(await screen.findByText('Advanced · AMD runtime profile'));};
const explain = async (label: string) => {await userEvent.hover(screen.getByRole('button', {name: `Explain ${label}`}));};

describe('hardware compatibility', () => {
  beforeEach(() => {
    compatibility = initial();
    writes.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (init?.method === 'POST') {writes.push({path, body: JSON.parse(String(init.body))}); return new Response('{}', {headers: {'content-type': 'application/json'}});}
      if (path === '/api/host-management') return new Response(JSON.stringify({nodes: [{name: 'example-node', nodeUid: 'example-uid', bootId: 'example-boot', kernel: '7.0-test', available: true, message: 'Host worker available.'}]}), {headers: {'content-type': 'application/json'}});
      return new Response(JSON.stringify({hardwareOperators: {'amd-gpu': {displayName: 'AMD GPU Operator', phase: 'Degraded', allocatableResources: 0, compatibility}}}), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('requires an explicit experimental opt-in and sends only catalog profile parameters', async () => {
    mount();
    await openAdvanced();
    await userEvent.selectOptions(await screen.findByLabelText('AMD compatibility profile'), 'strix-halo');
    expect(screen.getByRole('button', {name: 'Save hardware profile'})).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', {name: /I accept the experimental/}));
    await userEvent.click(screen.getByRole('button', {name: 'Save hardware profile'}));
    await waitFor(() => expect(writes).toEqual([{path: '/api/modules/amd-gpu/enable', body: {parameters: {compatibilityProfile: 'strix-halo', allowExperimental: 'true'}}}]));
  });

  it('keeps discovery, resource registration and each engine result separate', async () => {
    mount();
    await screen.findByText('GPU smoke passed');
    expect(screen.queryByText('GPU calculation passed.')).not.toBeInTheDocument();
    await explain('Ollama validation on example-node');
    expect(screen.getByText('GPU calculation passed.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await explain('vLLM validation on example-node');
    expect(screen.getByText('GPU calculation failed.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Not recognized')).toBeInTheDocument();
    expect(screen.getByText('Not ready')).toBeInTheDocument();
    expect(screen.queryByText(/One GPU, not two deployment targets/)).not.toBeInTheDocument();
    expect(screen.getByText('Linux-visible RAM').parentElement).toHaveTextContent('64 GiB');
    expect(screen.getByText('Installed RAM').parentElement).toHaveTextContent('Not reported');
    await explain('Physical memory layout on example-node');
    expect(screen.getByText(/not yet verified; no capacity guarantee/)).toBeInTheDocument();
  });

  it('offers no mutation controls to viewers or operators', async () => {
    mount(['magicstick-operator']);
    await openAdvanced();
    await explain('AMD runtime profile');
    expect(screen.getByText(/Administrator access is required to change profiles/)).toBeInTheDocument();
    expect(screen.queryByLabelText('AMD compatibility profile')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Run GPU validation'})).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('treats explicit null host evidence as unknown instead of a driver failure', async () => {
    compatibility.nodes = [{node: 'example-node', upstreamSupported: true, hostDriverReady: null, physicalMemoryMi: null, gpuAccessibleMi: null, memoryArchitecture: 'unified'}];
    mount();
    const driver = await screen.findByText('Host driver');
    expect(driver.parentElement).toHaveTextContent('Not verified');
    expect(screen.getByText('Dynamic GPU ceiling').parentElement).toHaveTextContent('Not reported');
    expect(screen.queryByText('Not ready')).not.toBeInTheDocument();
  });

  it.each([false, true])('separates a successful smoke test from runtime adoption (%s)', async (runtimeReady) => {
    compatibility.nodes[0]!.validation = {OLlama: {state: 'passed', runtimeReady, runtimeMessage: runtimeReady ? 'Validated image adopted.' : 'KubeAI will activate when a model is created.'}};
    mount();
    expect(await screen.findByText('GPU smoke passed')).toBeInTheDocument();
    const badge = screen.getByText(runtimeReady ? 'Runtime Ready' : 'Runtime pending');
    expect(badge).toHaveClass(runtimeReady ? 'status-good' : 'status-warn');
    await explain('Ollama validation on example-node');
    expect(screen.getByText(runtimeReady ? 'Validated image adopted.' : 'KubeAI will activate when a model is created.')).toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
  });

  it('requires confirmation before requesting GPU resource-consuming validation', async () => {
    compatibility.selectedProfile = 'strix-halo'; compatibility.allowExperimental = true;
    mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Run GPU validation'}));
    expect(writes).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', {name: 'Run tests'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({path: '/api/modules/amd-gpu/enable', body: {parameters: {compatibilityProfile: 'strix-halo', allowExperimental: 'true', validationRequest: expect.stringMatching(/^dashboard-/)}}});
  });

  it.each(['unverified', 'failed', 'running', 'stale'] as const)('keeps GPU/runtime readiness separate from optional %s tests', async (state) => {
    compatibility.selectedProfile = 'strix-halo'; compatibility.allowExperimental = true;
    compatibility.nodes[0]!.eligible = true;
    compatibility.nodes[0]!.validation = {OLlama: {state, runtimeReady: true, runtimeMessage: 'Configured image adopted; testing is optional.'}};
    mount();
    expect(await screen.findByText('Engine validation · Optional')).toBeInTheDocument();
    expect(screen.getByText('Eligible')).toBeInTheDocument();
    expect(screen.getByText('Runtime Ready')).toBeInTheDocument();
    expect(within(screen.getByText('Runtime Ready').parentElement!).getByText(state)).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Run GPU validation'})).toBeEnabled();
    expect(screen.queryByText('GPU smoke passed')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('allows returning to upstream recognition without experimental acknowledgement', async () => {
    compatibility.selectedProfile = 'strix-halo'; compatibility.allowExperimental = true;
    mount();
    await openAdvanced();
    await userEvent.selectOptions(await screen.findByLabelText('AMD compatibility profile'), '');
    await userEvent.click(screen.getByRole('button', {name: 'Save hardware profile'}));
    await waitFor(() => expect(writes[0]).toMatchObject({body: {parameters: {compatibilityProfile: '', allowExperimental: 'false'}}}));
  });

  it('puts operators first, groups profile overrides under setup, and separates memory controls', async () => {
    mount();
    const operators = await screen.findByRole('heading', {name: 'GPU operators'});
    const setup = screen.getByRole('heading', {name: 'GPU setup'}).closest('section')!;
    const memory = screen.getByRole('heading', {name: 'GPU memory'}).closest('section')!;
    const nodes = screen.getByRole('heading', {name: 'GPU nodes'}).closest('section')!;
    expect(operators.closest('section')?.nextElementSibling).toBe(setup);
    expect(setup.nextElementSibling).toBe(memory);
    expect(memory.nextElementSibling).toBe(nodes);
    expect(within(setup).getByRole('heading', {name: 'Host preparation'})).toBeInTheDocument();
    expect(within(setup).queryByRole('region', {name: /Shared GPU memory/})).not.toBeInTheDocument();
    expect(await within(memory).findByRole('region', {name: 'Shared GPU memory on example-node'})).toBeInTheDocument();
    const advanced = within(setup).getByText('Advanced · AMD runtime profile').closest('details')!;
    expect(advanced).not.toHaveAttribute('open');
    expect(within(setup).getByRole('button', {name: 'Save hardware profile'})).not.toBeVisible();
    expect(within(nodes).getByRole('button', {name: 'Run GPU validation'})).toBeInTheDocument();
    expect(screen.queryByText(/GPUs are available when hardware/)).not.toBeInTheDocument();
    await explain('GPU setup');
    expect(screen.getByRole('dialog', {name: 'GPU setup'})).toHaveTextContent('Host preparation is the primary setup path');
    expect(writes).toHaveLength(0);
  });

  it('validates the saved profile without applying an unsaved advanced override', async () => {
    compatibility.selectedProfile = 'strix-halo'; compatibility.allowExperimental = true;
    mount();
    await openAdvanced();
    await userEvent.selectOptions(screen.getByLabelText('AMD compatibility profile'), '');
    await userEvent.click(screen.getByRole('button', {name: 'Run GPU validation'}));
    expect(screen.getByRole('dialog', {name: 'Run GPU validation'})).toHaveTextContent('Unsaved profile changes are not applied.');
    expect(writes).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', {name: 'Run tests'}));
    await waitFor(() => expect(writes[0]).toMatchObject({body: {parameters: {compatibilityProfile: 'strix-halo', allowExperimental: 'true', validationRequest: expect.stringMatching(/^dashboard-/)}}}));
  });
});
