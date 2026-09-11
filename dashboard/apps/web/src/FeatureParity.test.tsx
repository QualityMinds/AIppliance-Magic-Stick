import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ReactElement} from 'react';
import {OverviewPage} from './pages/OverviewPage';
import {ServicesPage} from './pages/ServicesPage';
import {ModelsPage} from './pages/ModelsPage';
import {SettingsPage} from './pages/SettingsPage';
import {UsersPage} from './pages/UsersPage';
import {ApiAccessPage} from './pages/ApiAccessPage';
import {KubernetesAccessPage} from './pages/KubernetesAccessPage';
import {SystemPage} from './pages/SystemPage';

const session = {subject: 'admin-id', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const modules = {
  modules: {
    dashboard: {enabled: true, displayName: 'Dashboard', activationMode: 'static', status: {phase: 'Ready'}},
    litellm: {enabled: true, displayName: 'LiteLLM', activationMode: 'moduleactivation', status: {phase: 'Ready'}},
    'model-catalog': {enabled: true, displayName: 'Model Catalog', activationMode: 'moduleactivation', status: {phase: 'Ready'}},
    'paperclip-operator': {enabled: true, displayName: 'Paperclip Operator', activationMode: 'moduleactivation', status: {phase: 'Ready'}},
    'agent-sandbox': {enabled: true, displayName: 'Agent Sandbox', activationMode: 'moduleactivation', status: {phase: 'Ready'}},
    kubeai: {enabled: false, displayName: 'KubeAI', activationMode: 'moduleactivation', status: {phase: 'Disabled'}},
  },
  catalogJson: {
    modules: {
      dashboard: {displayName: 'Dashboard', group: 'core', activationMode: 'static', order: 10},
      litellm: {displayName: 'LiteLLM', group: 'runtime', activationMode: 'moduleactivation', order: 50, credentials: {provider: 'litellm'}},
      'model-catalog': {displayName: 'Model Catalog', group: 'runtime', activationMode: 'moduleactivation', order: 60},
      'paperclip-operator': {displayName: 'Paperclip Operator', group: 'operators', activationMode: 'moduleactivation', order: 100},
      'agent-sandbox': {displayName: 'Agent Sandbox', group: 'operators', activationMode: 'moduleactivation', order: 105},
      kubeai: {displayName: 'KubeAI', group: 'runtime', activationMode: 'moduleactivation', order: 40},
    },
    applications: {paperclip: {displayName: 'Paperclip', requiredModules: ['paperclip-operator', 'agent-sandbox', 'litellm', 'model-catalog']}},
  },
};
const instances = {instances: {paperclip: [{metadata: {name: 'paperclip-default'}, spec: {application: 'paperclip', enabled: true, targetNamespace: 'ai', access: {authentication: 'sso', role: 'user'}}, status: {phase: 'Ready', localURL: 'https://default.paperclip.magicstick.local/'}}]}};
const models = {
  models: [{id: 'qwen-chat', name: 'Qwen Chat', type: 'chat', provider: 'litellm', modelRef: 'openai/qwen-chat'}, {id: 'embedding-only', type: 'embedding', provider: 'litellm'}],
  activations: [{metadata: {name: 'qwen-chat'}, spec: {type: 'local', enabled: true, targetNamespace: 'ai', local: {modelType: 'chat', computeTarget: 'cpu', engine: 'VLLM', contextWindow: 32768, maxNumSeqs: 1, memoryRequiredMi: 6400}}, status: {phase: 'Ready', modelRef: 'hf://Qwen/Qwen3.5-9B'}}],
  presets: {qwen: {displayName: 'Qwen tested', variants: [{engine: 'VLLM', computeTarget: 'cpu', url: 'hf://Qwen/Qwen3.5-9B', contextWindow: 32768, maxNumSeqs: 1}]}},
  computeTargets: {default: 'cpu', targets: [{id: 'cpu', kind: 'cpu', displayName: 'CPU', engines: ['VLLM', 'OLlama'], available: true, kvCacheTypes: {
    VLLM: [{value: 'auto', label: 'Standard - model precision'}],
    OLlama: [{value: 'f16', label: 'Standard - F16'}, {value: 'q8_0', label: 'Memory saving - Q8'}, {value: 'q4_0', label: 'Strongly compressed - Q4'}],
  }}, {id: 'nvidia-gpu', kind: 'gpu', displayName: 'NVIDIA GPU', engines: ['VLLM', 'OLlama'], available: true, kvCacheTypes: {
    VLLM: [{value: 'auto', label: 'Standard - model precision'}, {value: 'fp8', label: 'FP8'}],
    OLlama: [{value: 'f16', label: 'Standard - F16'}, {value: 'q8_0', label: 'Memory saving - Q8'}, {value: 'q4_0', label: 'Strongly compressed - Q4'}],
  }}]},
  computeMemory: {devices: [{id: 'cpu', name: 'CPU', kind: 'cpu', computeTarget: 'cpu', totalMi: 65536, reservedMi: 6400, unreservedMi: 59136, freeMi: 50000, metricsAvailable: true}, {id: 'gpu-1', name: 'NVIDIA GPU', kind: 'gpu', computeTarget: 'nvidia-gpu', totalMi: 24564, reservedMi: 0, unreservedMi: 24564, freeMi: 23000, metricsAvailable: true}]},
  modules: {kubeai: {enabled: true, autoEnabled: true}},
};
const status = {
  fluxKustomizations: [{namespace: 'flux-system', name: 'apps', conditions: [{type: 'Ready', status: 'True'}]}],
  pods: [{namespace: 'ai', name: 'model', phase: 'Running'}], services: [{namespace: 'ai', name: 'litellm'}],
  ingresses: [],
  httpRoutes: [{namespace: 'identity-system', name: 'paperclip-default', labels: {'appliance.magicstick.dev/appinstance': 'paperclip-default'}, hostnames: ['default.paperclip.magicstick.local'], accepted: true}, {namespace: 'identity-system', name: 'paperclip-default-callback', labels: {'appliance.magicstick.dev/appinstance': 'paperclip-default'}, hostnames: ['magicstick.local'], accepted: true}, {namespace: 'identity-system', name: 'litellm', labels: {'app.kubernetes.io/name': 'litellm'}, hostnames: ['litellm.magicstick.local'], accepted: true}],
  hardwareOperators: {gpu: {displayName: 'NVIDIA GPU Operator', phase: 'NotRequired', operatorActive: false, operatorVersion: 'v1', driverMode: 'operator-managed', detectedNodes: [], compatibleNodes: [], allocatableResources: 0, message: 'No NVIDIA GPU detected.'}},
};
const users = {users: [
  {id: 'local', username: 'local-user', displayName: 'Local User', email: 'local@example.com', enabled: true, source: 'Local', local: true, createdAt: '2026-09-01T10:00:00Z', accessLevel: 'operator', effectiveAccessLevel: 'operator', directRoles: ['magicstick-user', 'magicstick-operator'], effectiveRoles: ['magicstick-user', 'magicstick-operator'], capabilities: {canEditProfile: true, canManageRoles: true, canDisable: true, canResetPassword: true, canDelete: true}},
  {id: 'external', username: 'entra-user', displayName: 'Entra User', email: 'entra@example.com', enabled: true, source: {displayName: 'Microsoft Entra'}, local: false, accessLevel: 'user', effectiveAccessLevel: 'user', directRoles: ['magicstick-user'], effectiveRoles: ['magicstick-user'], capabilities: {canEditProfile: false, canManageRoles: true, canDisable: true, canResetPassword: false, canDelete: false}},
], total: 2, first: 0, max: 25};

const json = (value: unknown, statusCode = 200) => new Response(JSON.stringify(value), {status: statusCode, headers: {'content-type': 'application/json'}});
const requestLog: Array<{path: string; method: string; body?: unknown}> = [];

const payload = (path: string, method: string) => {
  if (path === '/api/appliance') return {metadata: {namespace: 'ai-system', name: 'local'}, status: {phase: 'Ready'}};
  if (path === '/api/modules') return modules;
  if (path === '/api/instances') return instances;
  if (path === '/api/models') return models;
  if (path === '/api/status') return status;
  if (path === '/api/settings') return {publicDomain: 'magicstick.example.com', dashboardHost: 'magicstick.example.com', mdnsDomain: 'magicstick.local', mdnsName: 'magicstick'};
  if (path === '/api/users') return users;
  if (path === '/api/api-access' && method === 'GET') return {items: [{id: 'hash', name: 'CI pipeline', keyHint: 'abc...123', createdAt: '2026-09-01T10:00:00Z', status: 'active'}], total: 1, apiBases: [{scope: 'local', url: 'https://litellm.magicstick.local/v1'}]};
  if (path === '/api/api-access' && method === 'POST') return {item: {id: 'new', name: 'Demo'}, key: 'sk-secret-once', apiBases: [{scope: 'local', url: 'https://litellm.magicstick.local/v1'}]};
  if (path === '/api/kubernetes-access') return {users: [{id: 'local', username: 'local-user', displayName: 'Local User', email: 'local@example.com', enabled: true, source: 'Local', accessLevel: 'viewer'}], total: 1, first: 0, max: 100, configuration: {configured: true, apiServer: 'https://192.0.2.44:6443', issuerUrl: 'https://id.magicstick.local/realms/magicstick', credentialPlugin: 'kubectl oidc-login'}};
  if (path === '/api/model-discovery/popular') return {provider: 'huggingface', results: [{id: 'Qwen/Qwen3.5-9B', repo: 'Qwen/Qwen3.5-9B', name: 'Qwen3.5-9B'}], total: 1};
  if (path === '/api/models/estimate-memory') return {
    minimumMi: 5500,
    recommendedMi: 6700,
    maximumMi: 59136,
    weightsMi: 3800,
    kvCacheMi: 700,
    kvCacheType: 'fp8',
    kvCacheBaselineMi: 1050,
    kvCacheSavingsMi: 350,
    theoreticalKvCacheMi: 175,
    hybridAllocatorSafetyMi: 525,
    reserveMi: 1000,
    recommendedReserveMi: 1200,
    runtimeDetails: {compileReserveMi: 600, multimodalReserveMi: 400},
    downloadBytes: 4300000000,
    computeTarget: 'cpu',
    confidence: 'estimated',
  };
  if (path === '/api/modules/litellm/credentials') return {title: 'LiteLLM credentials', credentials: [{key: 'API key', value: 'secret'}]};
  if (path === '/api/instances/paperclip-default/credentials') return {title: 'Paperclip credentials', credentials: [{key: 'Password', value: 'secret'}]};
  return {};
};

const renderPage = (node: ReactElement) => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}, mutations: {retry: false}}});
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
};

describe('dashboard feature contracts', () => {
  beforeEach(() => {
    requestLog.length = 0;
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: vi.fn(async () => undefined)}});
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin); const method = String(init?.method ?? 'GET').toUpperCase();
      requestLog.push({path: url.pathname, method, body: init?.body ? JSON.parse(String(init.body)) : undefined});
      return json(payload(url.pathname, method));
    }));
  });

  it('Overview groups module and instance URLs and includes all counters', async () => {
    renderPage(<OverviewPage />);
    expect(await screen.findByRole('heading', {name: 'Overview'})).toBeInTheDocument();
    expect(await screen.findByText('default.paperclip.magicstick.local')).toBeInTheDocument();
    expect(screen.getByText('litellm.magicstick.local')).toBeInTheDocument();
    expect(screen.queryByText('magicstick.local')).not.toBeInTheDocument();
    expect(screen.getByText('installed or registered')).toBeInTheDocument();
  });

  it('Services restores grouping, nested instances, credentials and every Paperclip field', async () => {
    renderPage(<ServicesPage session={session} />);
    expect(await screen.findByRole('heading', {name: 'Applications'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'AI Runtime'})).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: /Show/}));
    expect(await screen.findByText('paperclip-default')).toBeInTheDocument();
    expect(screen.getAllByRole('button', {name: 'Credentials'}).length).toBeGreaterThanOrEqual(1);
    await userEvent.click(screen.getAllByRole('button', {name: /Create Instance|New Instance/})[0]!);
    expect(await screen.findByRole('dialog', {name: 'Create Instance'})).toBeInTheDocument();
    expect(screen.getByLabelText('Admin Email')).toBeInTheDocument();
    expect(screen.getByText('Agent runtimes')).toBeInTheDocument();
    expect(screen.getByLabelText('Parallel Agents')).toBeInTheDocument();
    expect(screen.getByLabelText('Postgres')).toBeInTheDocument();
  });

  it('Models keeps shared-memory gauges compact and exposes accounting behind an info symbol', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === '/api/models') return json({...models, computeMemory: {sharedPools: [{id: 'unified-example', node: 'example-node', installedMemoryMi: 131072, firmwareReservedMi: 65536, physicalMemoryMi: 65536, gpuAccessibleMi: 47104, gpuCapacityMi: 65536, gpuAllocationMode: 'firmware-reserved', gpuCapacitySource: 'kfd-topology'}], devices: [{id: 'amd-example', name: 'Example GPU', computeTarget: 'amd-gpu', totalMi: 65536, unreservedMi: 32768, freeMi: null, gpuCapacityMi: 65536, gpuAllocationMode: 'firmware-reserved', memoryArchitecture: 'unified', sharedPoolId: 'unified-example', sharedMemoryMi: 65536, accountingVerified: false, message: 'GPU accounting is not a guaranteed hard limit.'}]}});
      return json(payload(path, 'GET'));
    }));
    renderPage(<ModelsPage session={session} />);
    expect(await screen.findByText('dedicated unreserved')).toBeInTheDocument();
    expect(screen.getByRole('region', {name: 'Dedicated memory'})).toHaveTextContent('64 GiB');
    expect(screen.queryByText('Installed RAM')).not.toBeInTheDocument();
    expect(screen.queryByText(/GPU accounting is not a guaranteed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', {name: /Physical memory layout/})).not.toBeInTheDocument();
    expect(screen.getAllByText('Example GPU')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', {name: 'Explain Example GPU memory'}));
    expect(screen.getByText('Installed RAM').parentElement).toHaveTextContent('128 GiB');
    expect(screen.getByText('Fixed GPU reservation').parentElement).toHaveTextContent('64 GiB');
    expect(screen.getByText(/Dedicated free requires live GPU metrics/)).toBeInTheDocument();
    expect(screen.getByText(/GPU memory accounting not yet verified/)).toBeInTheDocument();
    expect(screen.getByText('GPU accounting is not a guaranteed hard limit.')).toBeInTheDocument();
  });

  it('Models restores model-source controls, memory planning and registered models', async () => {
    renderPage(<ModelsPage session={session} />);
    expect(await screen.findByRole('heading', {name: 'Models'})).toBeInTheDocument();
    expect(screen.getByRole('heading', {name: 'Registered Models'})).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Create'}));
    expect(await screen.findByRole('dialog', {name: 'Create Model'})).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Model source'), 'direct');
    await userEvent.type(screen.getByLabelText('Hugging Face URL'), 'hf://Qwen/Qwen3.5-9B');
    expect(await screen.findByText('RAM reservation')).toBeInTheDocument();
    expect(screen.getByLabelText('Max Num Seqs')).toHaveValue(1);
    expect(screen.getByLabelText('KV Cache')).toHaveValue('auto');
    expect(within(screen.getByLabelText('KV Cache')).queryByRole('option', {name: 'FP8'})).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Hardware'), 'nvidia-gpu');
    expect(await within(screen.getByLabelText('KV Cache')).findByRole('option', {name: 'FP8'})).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('KV Cache'), 'fp8');
    expect(await screen.findByText('KV cache saving vs F16')).toBeInTheDocument();
    await waitFor(() => expect(requestLog.some((item) => item.path === '/api/models/estimate-memory' && (item.body as {kvCacheType?: string})?.kvCacheType === 'fp8')).toBe(true));
    expect(screen.getByText('Breakdown')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Breakdown'));
    expect(screen.getByText('Theoretical KV cache')).toBeInTheDocument();
    expect(screen.getByText('Hybrid allocator safety')).toBeInTheDocument();
    expect(screen.getByText('Compile / warm-up')).toBeInTheDocument();
    expect(screen.getByText('Multimodal processor cache')).toBeInTheDocument();
    expect(screen.getByText('Recommended headroom')).toBeInTheDocument();
    expect(screen.getByText(/Download size is not added to memory/)).toBeInTheDocument();
  });

  it('Settings retains both editable domains', async () => {
    renderPage(<SettingsPage />);
    expect(await screen.findByLabelText('Public Domain')).toHaveValue('magicstick.example.com');
    expect(screen.getByLabelText('mDNS Domain')).toHaveValue('magicstick.local');
  });

  it('Users restores filters, pagination, roles and safe user dialogs', async () => {
    renderPage(<UsersPage />);
    expect(await screen.findByText('Local User')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Entra')).toBeInTheDocument();
    expect(screen.getByText(/Direct: magicstick-user, magicstick-operator/)).toBeInTheDocument();
    expect(screen.getByLabelText('Per page')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Create User'}));
    expect(await screen.findByLabelText('Confirm temporary password')).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable the account/)).toBeChecked();
  });

  it('API Access restores refresh, endpoint, one-time secret and revoke flow', async () => {
    renderPage(<ApiAccessPage />);
    expect(await screen.findByText('CI pipeline')).toBeInTheDocument();
    expect(screen.getByText('https://litellm.magicstick.local/v1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Create API Key'}));
    await userEvent.type(screen.getByLabelText('Name'), 'Demo');
    await userEvent.click(within(screen.getByRole('dialog', {name: 'Create API Key'})).getByRole('button', {name: 'Create Key'}));
    expect(await screen.findByText('sk-secret-once')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Copy API key'})).toBeInTheDocument();
  });

  it('Kubernetes Access restores level guidance, OIDC readiness and edit/export actions', async () => {
    renderPage(<KubernetesAccessPage />);
    expect(await screen.findByText(/SSO is active for https:\/\/192.0.2.44:6443/)).toBeInTheDocument();
    expect(screen.getByText('Cluster Administrator')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Download Kubeconfig'})).toBeEnabled();
    await userEvent.click(screen.getByRole('button', {name: 'Edit Access'}));
    expect(await screen.findByRole('dialog', {name: /Kubernetes access for local-user/})).toBeInTheDocument();
    expect(screen.getByText(/Viewer can inspect cluster resources/)).toBeInTheDocument();
  });

  it('System Status restores GPU, Flux, pod and Gateway route details', async () => {
    renderPage(<SystemPage />);
    expect(await screen.findByText('NVIDIA GPU Operator')).toBeInTheDocument();
    expect(screen.getByText('0 ready / 0 active / 1 known')).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('default.paperclip.magicstick.local')).toBeInTheDocument();
  });
});
