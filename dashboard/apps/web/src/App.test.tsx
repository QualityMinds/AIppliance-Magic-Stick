import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
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
  '/api/license': {state: 'valid', message: 'License valid.', valid: true, installationId: 'example-installation', revision: 'revision-1', checkedAt: 1, trustedKeyIds: ['example-key'], hasDocument: true, features: [{id: 'federated-sso', name: 'Dashboard-managed federated SSO', licensed: true, implemented: true, available: true, reason: 'available'}]},
  '/api/federated-sso': {feature: {id: 'federated-sso', name: 'Dashboard-managed federated SSO', licensed: true, implemented: true, available: true, reason: 'available'}, issuer: 'https://id.magicstick.local/realms/magicstick', callbackUrl: 'https://id.magicstick.local/realms/magicstick/broker/{alias}/endpoint', providers: []},
  '/api/users?search=&first=0&max=25': {users: [], total: 0, first: 0, max: 25},
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

const renderApp = () => {
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  return render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
};

describe('default React dashboard', () => {
  beforeEach(() => {
    payloads['/api/session'] = {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
    payloads['/api/license'] = {state: 'valid', message: 'License valid.', valid: true, installationId: 'example-installation', revision: 'revision-1', checkedAt: 1, trustedKeyIds: ['example-key'], hasDocument: true, features: [{id: 'federated-sso', name: 'Dashboard-managed federated SSO', licensed: true, implemented: true, available: true, reason: 'available'}]};
    window.history.replaceState(null, '', '#/overview');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      return response(payloads[`${url.pathname}${url.search}`] ?? payloads[url.pathname] ?? {error: 'not mocked'}, payloads[`${url.pathname}${url.search}`] || payloads[url.pathname] ? 200 : 404);
    }));
  });

  it('renders live appliance data and every admin page', async () => {
    renderApp();
    expect(await screen.findByRole('heading', {name: 'AI Appliance Dashboard'})).toBeInTheDocument();
    expect(screen.queryByRole('link', {name: 'Open current dashboard'})).not.toBeInTheDocument();
    expect(screen.queryByText(/React Preview|Dashboard 2 preview/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', {name: 'Log out'})).toHaveAttribute('href', '/logout');
    expect(await screen.findByText('magicstick.local', {exact: false})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'API Access'})).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Federated SSO'})).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Kubernetes Access'})).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', {name: 'Dashboard pages'});
    expect(within(navigation).getByRole('button', {name: 'System'})).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', {name: 'Settings'})).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', {name: 'License'})).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', {name: 'Users'})).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', {name: 'System Status'})).not.toBeInTheDocument();
    await userEvent.click(within(navigation).getByRole('button', {name: 'System'}));
    const systemSections = await screen.findByRole('tablist', {name: 'System sections'});
    expect(within(systemSections).getByRole('tab', {name: 'Settings'})).toBeInTheDocument();
    expect(within(systemSections).getByRole('tab', {name: 'License'})).toBeInTheDocument();
    expect(within(systemSections).getByRole('tab', {name: 'Users'})).toBeInTheDocument();
    expect(await within(systemSections).findByRole('tab', {name: 'Federated SSO'})).toBeEnabled();
    expect(within(systemSections).getByRole('tab', {name: 'System Status'})).toBeInTheDocument();
  });

  it('loads admin data only after opening its tab', async () => {
    renderApp();
    await screen.findByRole('heading', {name: 'Overview'});
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/users'))).toBe(false);
    await userEvent.click(screen.getByRole('button', {name: 'System'}));
    await userEvent.click(await screen.findByRole('tab', {name: 'Users'}));
    await screen.findByRole('heading', {name: 'Users'});
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/users'))).toBe(true));
  });

  it('follows direct hash navigation and browser history changes', async () => {
    renderApp();
    await screen.findByRole('heading', {name: 'Overview'});
    window.location.hash = '#/system';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', {name: 'System Status'})).toBeInTheDocument();
    expect(window.location.hash).toBe('#/system/status');
  });

  it('redirects legacy settings links to the matching System section', async () => {
    window.history.replaceState(null, '', '#/settings');
    renderApp();
    expect(await screen.findByRole('heading', {name: 'Settings'})).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#/system/settings'));
    expect(screen.getByRole('tab', {name: 'Settings'})).toHaveAttribute('aria-selected', 'true');
  });

  it('redirects the former Federated SSO page into System', async () => {
    window.history.replaceState(null, '', '#/federated-sso');
    renderApp();
    expect(await screen.findByRole('heading', {name: 'Federated SSO'})).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#/system/federated-sso'));
    expect(screen.getByRole('tab', {name: 'Federated SSO'})).toHaveAttribute('aria-selected', 'true');
  });

  it('disables the Federated SSO System tab without its entitlement', async () => {
    payloads['/api/license'] = {...payloads['/api/license'] as object, valid: false, features: [{id: 'federated-sso', name: 'Dashboard-managed federated SSO', licensed: false, implemented: true, available: false, reason: 'unlicensed'}]};
    renderApp();
    await userEvent.click(await screen.findByRole('button', {name: 'System'}));
    expect(await screen.findByRole('tab', {name: 'Federated SSO (Enterprise license required)'})).toBeDisabled();
  });

  it('hides administrative tabs from viewers', async () => {
    payloads['/api/session'] = {subject: '2', username: 'viewer', roles: ['magicstick-viewer']};
    window.history.replaceState(null, '', '#/license');
    renderApp();
    expect(await screen.findByRole('heading', {name: 'System Status'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'System'})).toBeInTheDocument();
    const systemSections = screen.getByRole('tablist', {name: 'System sections'});
    expect(within(systemSections).queryByRole('tab', {name: 'Users'})).not.toBeInTheDocument();
    expect(within(systemSections).queryByRole('tab', {name: /Federated SSO/})).not.toBeInTheDocument();
    expect(within(systemSections).queryByRole('tab', {name: 'Settings'})).not.toBeInTheDocument();
    expect(within(systemSections).queryByRole('tab', {name: 'License'})).not.toBeInTheDocument();
    expect(within(systemSections).getByRole('tab', {name: 'System Status'})).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/license'))).toBe(false);
  });

  it('keeps identity-dependent Users hidden when local identity management is unavailable', async () => {
    payloads['/api/session'] = {subject: '1', username: 'tova', roles: ['magicstick-admin'], identityManagementAvailable: false, identityManagementMode: 'external'};
    window.history.replaceState(null, '', '#/system/users');
    renderApp();
    expect(await screen.findByRole('heading', {name: 'System Status'})).toBeInTheDocument();
    const systemSections = screen.getByRole('tablist', {name: 'System sections'});
    expect(within(systemSections).getByRole('tab', {name: 'Settings'})).toBeInTheDocument();
    expect(within(systemSections).getByRole('tab', {name: 'License'})).toBeInTheDocument();
    expect(within(systemSections).queryByRole('tab', {name: 'Users'})).not.toBeInTheDocument();
    expect(within(systemSections).queryByRole('tab', {name: /Federated SSO/})).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith('/api/users'))).toBe(false);
  });
});
