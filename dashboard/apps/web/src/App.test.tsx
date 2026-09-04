import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {App} from './App';

const payloads: Record<string, unknown> = {
  '/api/session': {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  '/api/appliance': {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  '/api/modules': {modules: {litellm: {enabled: true, displayName: 'LiteLLM', status: {phase: 'Ready'}}}, catalogJson: {modules: {litellm: {displayName: 'LiteLLM', activationMode: 'moduleactivation'}}, applications: {}}},
  '/api/instances': {instances: {}},
  '/api/models': {activations: [], presets: {}, computeTargets: {default: 'cpu', targets: [{id: 'cpu', displayName: 'CPU', engines: ['VLLM'], available: true}]}, computeMemory: {devices: [{id: 'cpu', name: 'CPU', computeTarget: 'cpu', totalMi: 65536, unreservedMi: 60000, freeMi: 50000}]}},
  '/api/status': {httpRoutes: [{name: 'litellm', labels: {'app.kubernetes.io/name': 'litellm'}, hostnames: ['litellm.magicstick.local'], accepted: true}], hardwareOperators: {}},
  '/api/settings': {publicDomain: 'magicstick.example.com', dashboardHost: 'magicstick.example.com', mdnsDomain: 'magicstick.local', mdnsName: 'magicstick'},
  '/api/users?search=&first=0&max=25': {users: [], total: 0, first: 0, max: 25},
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

const renderApp = () => {
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  return render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
};

describe('React dashboard preview', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#/overview');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      return response(payloads[`${url.pathname}${url.search}`] ?? payloads[url.pathname] ?? {error: 'not mocked'}, payloads[`${url.pathname}${url.search}`] || payloads[url.pathname] ? 200 : 404);
    }));
  });

  it('renders live appliance data and every admin page', async () => {
    renderApp();
    expect(await screen.findByRole('heading', {name: 'AI Appliance Dashboard 2'})).toBeInTheDocument();
    expect(await screen.findByText('magicstick.local', {exact: false})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Users'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'API Access'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Kubernetes Access'})).toBeInTheDocument();
  });

  it('loads admin data only after opening its tab', async () => {
    renderApp();
    await screen.findByRole('heading', {name: 'Overview'});
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/users'))).toBe(false);
    await userEvent.click(screen.getByRole('button', {name: 'Users'}));
    await screen.findByRole('heading', {name: 'Users'});
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/users'))).toBe(true));
  });

  it('follows direct hash navigation and browser history changes', async () => {
    renderApp();
    await screen.findByRole('heading', {name: 'Overview'});
    window.location.hash = '#/system';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', {name: 'System Status'})).toBeInTheDocument();
  });

  it('hides administrative tabs from viewers', async () => {
    payloads['/api/session'] = {subject: '2', username: 'viewer', roles: ['magicstick-viewer']};
    renderApp();
    await screen.findByRole('heading', {name: 'Overview'});
    expect(screen.queryByRole('button', {name: 'Users'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Settings'})).not.toBeInTheDocument();
    payloads['/api/session'] = {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
  });
});
