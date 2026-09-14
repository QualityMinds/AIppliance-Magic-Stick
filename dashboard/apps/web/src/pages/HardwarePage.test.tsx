import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {GpuCompatibility, GpuSharingState, HardwareGpuDevice, ManagedHost, Session} from '@magicstick/dashboard-contracts';
import {HardwarePage} from './HardwarePage';

const session: Session = {subject: 'example', username: 'example', roles: ['magicstick-admin'], identityManagementAvailable: false, identityManagementMode: 'external'};
let compatibility: GpuCompatibility;
let host: ManagedHost;
let devices: HardwareGpuDevice[];
let sharing: GpuSharingState[];
const writes: Array<{path: string; body: unknown}> = [];
const mount = (roles = session.roles) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><HardwarePage session={{...session, roles}} /></QueryClientProvider>);
const openAmd = async () => userEvent.click(await screen.findByText('GPU Configuration AMD'));
const openProfile = async () => {await openAmd(); await userEvent.click(screen.getByText('AMD runtime profile'));};
const explain = async (label: string) => userEvent.hover(screen.getByRole('button', {name: `Explain ${label}`}));

describe('physical GPU hardware view', () => {
  beforeEach(() => {
    host = {name: 'example-node', nodeUid: 'example-uid', bootId: 'example-boot', kernel: '7.0-test', available: true, message: 'Host worker available.'};
    compatibility = {schemaVersion: 1, selectedProfile: 'strix-halo', allowExperimental: true,
      profiles: [{id: 'strix-halo', displayName: 'AMD Strix Halo', version: '1', experimental: true, memoryArchitecture: 'unified'}],
      nodes: [{node: host.name, nodeUid: host.nodeUid, profileId: 'strix-halo', profileVersion: '1', upstreamSupported: false, eligible: true}]};
    const base = {node: host.name, nodeUid: host.nodeUid, eligible: true, hostDriverReady: true, resourceRegistered: true, validationAvailable: true};
    devices = [
      {...base, id: 'example-uid/0000:01:00.0', vendor: 'amd', name: 'AMD Strix Halo', pciAddress: '0000:01:00.0', pciId: '1002:1586', architecture: 'gfx1151', hostDriver: 'amdgpu', memoryArchitecture: 'unified',
        memory: {node: host.name, installedMemoryMi: 131072, firmwareReservedMi: 512, physicalMemoryMi: 126000, gpuAccessibleMi: 100000, gpuCapacityMi: 100000, gpuCapacitySource: 'kfd-topology', gpuAllocationMode: 'shared-gtt'},
        validation: {OLlama: {state: 'passed', message: 'AMD smoke passed.', runtimeReady: true}, VLLM: {state: 'unverified'}}},
      {...base, id: 'example-uid/0000:02:00.0', vendor: 'nvidia', name: 'NVIDIA Example GPU', pciAddress: '0000:02:00.0', pciId: '10de:example', architecture: 'CUDA 8.9', hostDriver: 'nvidia', memoryTotalMi: 24576,
        validation: {OLlama: {state: 'unverified'}, VLLM: {state: 'failed', message: 'NVIDIA smoke failed.'}}},
    ];
    const shared: GpuSharingState = {provider: 'amd', backend: 'dra', mode: 'shared', managed: true, experimental: true, maxModels: 4, nodeName: host.name, nodeUid: host.nodeUid, namespace: 'ai', expectedRevision: '7', available: true, reason: '', phase: 'Ready', message: '', claimName: '', activeModels: 0, admittedModels: [], memoryIsolation: false};
    sharing = [shared, {...shared, provider: 'nvidia', backend: 'time-slicing', maxModels: 2, experimental: false}];
    writes.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (init?.method === 'POST') {writes.push({path, body: JSON.parse(String(init.body))}); return Response.json({accepted: true});}
      if (path === '/api/host-management') return Response.json({nodes: [host]});
      if (path === '/api/hardware/gpu-sharing') return Response.json({providers: sharing});
      return Response.json({hardwareOperators: {
        'amd-gpu': {displayName: 'AMD GPU Operator', compatibility, devices: devices.filter((d) => d.vendor === 'amd')},
        gpu: {displayName: 'NVIDIA GPU Operator', devices: devices.filter((d) => d.vendor === 'nvidia')},
      }});
    }));
  });

  it('separates node facts from one named accordion per physical GPU, not per sharing slot', async () => {
    host.plan = {id: 'plan', state: 'ready', profileId: 'host-profile', profileVersion: '1', gpuProfile: 'strix-halo', experimental: true, message: '', packages: {}, rebootRequired: false, targetKernel: ''};
    mount();
    const node = await screen.findByRole('article', {name: 'GPU node example-node'});
    expect(within(node).getByText('Node: example-node')).toBeInTheDocument();
    const facts = within(node).getByText('Running kernel').closest('dl')!;
    expect([...facts.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Profile', 'Upstream operator recognition', 'Running kernel', 'Planned kernel', 'Kernel / driver plan']);
    const gpus = within(node).getByRole('region', {name: 'GPUs on example-node'});
    expect(gpus.querySelectorAll('.gpu-configuration')).toHaveLength(2);
    expect(gpus.querySelectorAll('.gpu-configuration > details[open]')).toHaveLength(0);
    await openAmd();
    const amd = within(gpus).getByRole('region', {name: 'GPU AMD Strix Halo · 0000:01:00.0'});
    expect(within(amd).getByText('Architecture').parentElement).toHaveTextContent('gfx1151');
    expect(within(amd).getByText('Detected GPU device').parentElement).toHaveTextContent('1002:1586 · 0000:01:00.0');
    expect(within(amd).getByText('Host driver').parentElement).toHaveTextContent('Ready · amdgpu');
    expect(within(amd).queryByText('Running kernel')).not.toBeInTheDocument();
    const operators = screen.getByRole('heading', {name: 'GPU operators'}).closest('section')!;
    expect(operators.nextElementSibling).toBe(screen.getByRole('heading', {name: 'GPU nodes'}).closest('section'));
    expect(gpus.nextElementSibling).toBe(within(node).getByRole('region', {name: 'Engine validation on example-node'}));
    expect(writes).toEqual([]);
  });

  it('puts memory layout first and uses bold collapsed summaries without duplicate headings', async () => {
    mount(); await openAmd();
    const amd = screen.getByRole('region', {name: 'GPU AMD Strix Halo · 0000:01:00.0'});
    expect(amd.querySelector('.gpu-configuration-content')?.firstElementChild).toHaveAccessibleName('Physical memory layout on example-node');
    for (const label of ['GPU sharing', 'AMD runtime profile', 'Shared GPU memory']) {
      const title = within(amd).getByText(label);
      expect(title.tagName).toBe('STRONG');
      expect(title.closest('summary')).not.toBeNull();
      expect(title.closest('details')).not.toHaveAttribute('open');
    }
    expect(within(amd).queryByText('Advanced · AMD runtime profile')).not.toBeInTheDocument();
    expect(within(amd).queryByText('GPU memory')).not.toBeInTheDocument();
    expect(within(amd).getAllByText('AMD runtime profile')).toHaveLength(1);
    expect(within(amd).getAllByText('Shared GPU memory')).toHaveLength(1);
    await userEvent.click(within(amd).getByText('GPU sharing'));
    expect(within(amd).getByRole('button', {name: 'Apply AMD sharing'})).toBeVisible();
    expect(within(amd).getByRole('button', {name: 'Apply AMD sharing'})).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it('keeps summary explanations on the info icon without toggling the accordion', async () => {
    mount(); await openAmd();
    const summary = screen.getByText('AMD runtime profile').closest('details')!;
    expect(screen.queryByText(/Host preparation already activates/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Explain AMD runtime profile'}));
    expect(summary).not.toHaveAttribute('open');
    expect(screen.getByRole('dialog', {name: 'AMD runtime profile'})).toHaveTextContent('installs no kernel');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps NVIDIA memory and configuration independent from AMD shared memory', async () => {
    mount(); await userEvent.click(await screen.findByText('GPU Configuration NVIDIA'));
    const nvidia = screen.getByRole('region', {name: 'GPU NVIDIA Example GPU · 0000:02:00.0'});
    expect(within(nvidia).getByText('Dedicated GPU memory').parentElement).toHaveTextContent('24 GiB');
    expect(within(nvidia).queryByText('AMD runtime profile')).not.toBeInTheDocument();
    expect(within(nvidia).queryByText('Shared GPU memory')).not.toBeInTheDocument();
    expect(within(nvidia).queryByText('Dynamic GPU ceiling')).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('keeps distinct same-vendor GPUs separate without duplicating provider-scoped sharing controls', async () => {
    devices.push({...devices[1]!, id: 'example-uid/0000:03:00.0', pciAddress: '0000:03:00.0'});
    mount();
    await screen.findByText('Node: example-node');
    expect(screen.getAllByRole('heading', {name: 'GPU Configuration NVIDIA'})).toHaveLength(2);
    expect(screen.queryByLabelText('NVIDIA allocation mode')).not.toBeInTheDocument();
  });

  it.each(['Ollama', 'vLLM'])('confirms and submits %s for all GPUs on this node', async (name) => {
    mount();
    await userEvent.click(await screen.findByRole('button', {name: `Verify ${name}`}));
    expect(writes).toEqual([]);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('AMD Strix Halo (0000:01:00.0)');
    expect(dialog).toHaveTextContent('NVIDIA Example GPU (0000:02:00.0)');
    await userEvent.click(screen.getByRole('button', {name: 'Run verification'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({path: '/api/hardware/validation', body: {nodeName: host.name, nodeUid: host.nodeUid, engine: name === 'Ollama' ? 'OLlama' : 'VLLM', deviceIds: devices.map((d) => d.id), acknowledgeResourceUse: true}});
  });

  it('verifies only a selected NVIDIA GPU and leaves AMD out of the request', async () => {
    mount();
    await userEvent.selectOptions(await screen.findByLabelText('GPUs to verify'), devices[1]!.id);
    await userEvent.click(screen.getByRole('button', {name: 'Verify Ollama'}));
    expect(screen.getByRole('dialog')).not.toHaveTextContent('AMD Strix Halo');
    await userEvent.click(screen.getByRole('button', {name: 'Run verification'}));
    await waitFor(() => expect(writes[0]).toMatchObject({body: {deviceIds: [devices[1]!.id]}}));
  });

  it.each(['queued', 'running'] as const)('does not duplicate a %s verification while another engine remains selectable', async (state) => {
    devices[0]!.validation!.OLlama = {state};
    mount();
    expect(await screen.findByRole('button', {name: 'Verify Ollama'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Verify vLLM'})).toBeEnabled();
    await userEvent.selectOptions(screen.getByLabelText('GPUs to verify'), devices[1]!.id);
    expect(screen.getByRole('button', {name: 'Verify Ollama'})).toBeEnabled();
    expect(writes).toEqual([]);
  });

  it('does not silently omit an unavailable device from an all-GPU request', async () => {
    devices[0]!.validationAvailable = false;
    devices[0]!.validationReason = 'GPU driver not ready.';
    mount();
    expect(await screen.findByRole('button', {name: 'Verify Ollama'})).toBeDisabled();
    await explain('Engine validation on example-node');
    expect(screen.getByText('AMD Strix Halo: GPU driver not ready.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.selectOptions(screen.getByLabelText('GPUs to verify'), devices[1]!.id);
    expect(screen.getByRole('button', {name: 'Verify Ollama'})).toBeEnabled();
  });

  it('keeps explicit unknown driver and memory values unknown', async () => {
    devices[1]!.hostDriverReady = null; devices[1]!.hostDriver = ''; devices[1]!.memoryTotalMi = null;
    mount(); await userEvent.click(await screen.findByText('GPU Configuration NVIDIA'));
    const card = screen.getByRole('region', {name: 'GPU NVIDIA Example GPU · 0000:02:00.0'});
    expect(within(card).getByText('Host driver').parentElement).toHaveTextContent('Not verified');
    expect(within(card).getByText('Dedicated GPU memory').parentElement).toHaveTextContent('Not reported');
  });

  it('requires profile opt-in and preserves unsaved profile drafts during diagnostics', async () => {
    mount(); await openProfile();
    await userEvent.selectOptions(screen.getByLabelText('AMD compatibility profile'), '');
    await userEvent.selectOptions(screen.getByLabelText('AMD compatibility profile'), 'strix-halo');
    expect(screen.getByRole('button', {name: 'Save hardware profile'})).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', {name: /I accept the experimental hardware profile/}));
    await userEvent.selectOptions(screen.getByLabelText('AMD compatibility profile'), '');
    await userEvent.click(screen.getByRole('button', {name: 'Verify Ollama'}));
    expect(screen.getByRole('dialog')).toHaveTextContent('Unsaved profile changes are not applied.');
    await userEvent.click(screen.getByRole('button', {name: 'Run verification'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toBe('/api/hardware/validation');
  });

  it('saves a deliberate profile change through the existing module API', async () => {
    mount(); await openProfile();
    await userEvent.selectOptions(screen.getByLabelText('AMD compatibility profile'), '');
    await userEvent.click(screen.getByRole('button', {name: 'Save hardware profile'}));
    await waitFor(() => expect(writes[0]).toMatchObject({path: '/api/modules/amd-gpu/enable', body: {parameters: {compatibilityProfile: '', allowExperimental: 'false'}}}));
  });

  it('keeps the experimental kernel plan live at node level', async () => {
    host.plan = {id: 'plan', state: 'blocked', profileId: 'host-profile', profileVersion: '1', gpuProfile: 'strix-halo', experimental: true, message: '', packages: {}, rebootRequired: false, targetKernel: ''};
    host.plan.experiment = {...host.plan, id: 'experiment', state: 'available', experimentMode: true, rebootRequired: true, targetKernel: '7.1-test'};
    mount();
    await userEvent.click(await screen.findByRole('checkbox', {name: /Experiment mode/}));
    expect(screen.getByText('Planned kernel').parentElement).toHaveTextContent('7.1-test');
    expect(screen.getByRole('button', {name: 'Review hardware experiment'})).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it.each(['magicstick-viewer', 'magicstick-operator'])('keeps %s read-only', async (role) => {
    mount([role]); await openProfile();
    expect(screen.queryByLabelText('AMD compatibility profile')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /^Verify /})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /^Apply .* sharing/})).not.toBeInTheDocument();
    await explain('AMD runtime profile');
    expect(screen.getByText(/Administrator access is required/)).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('renders NVIDIA-only nodes without assigning AMD fields or controls to them', async () => {
    compatibility.nodes = []; devices = [devices[1]!]; sharing = [sharing[1]!];
    mount();
    await screen.findByText('Node: example-node');
    expect(screen.getByText('GPU Configuration NVIDIA')).toBeInTheDocument();
    expect(screen.queryByText('GPU Configuration AMD')).not.toBeInTheDocument();
    expect(screen.queryByText('AMD runtime profile')).not.toBeInTheDocument();
  });

  it('shows legacy inventory read-only until the host publishes physical devices', async () => {
    devices = []; mount();
    expect(await screen.findByText('GPU Configuration AMD')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Verify Ollama'})).toBeDisabled();
    expect(writes).toEqual([]);
  });
});
