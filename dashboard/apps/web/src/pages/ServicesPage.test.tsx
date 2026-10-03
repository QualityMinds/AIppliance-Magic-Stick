import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModulesPayload} from '@magicstick/dashboard-contracts';
import {ServicesPage} from './ServicesPage';

const session = {subject: 'operator-fixture', username: 'example-operator', roles: ['magicstick-operator'],
  identityManagementAvailable: false, identityManagementMode: 'external'};
let modules: ModulesPayload;
let models: {models: Array<{id: string; type: string}>};
let mutationError: string | undefined;
const writes: Array<{path: string; body: Record<string, unknown>}> = [];

const renderServices = (roles = session.roles) => render(<QueryClientProvider client={new QueryClient({
  defaultOptions: {queries: {retry: false, staleTime: Infinity}, mutations: {retry: false}},
})}><ServicesPage session={{...session, roles}} /></QueryClientProvider>);

describe('Pi Coding instances', () => {
  beforeEach(() => {
    writes.length = 0;
    mutationError = undefined;
    models = {models: [{id: 'local-coder', type: 'chat'}, {id: 'embedding-only', type: 'embedding'}]};
    modules = {
      modules: Object.fromEntries(['pi-coding', 'litellm', 'model-catalog'].map(name => [name, {
        enabled: true, activationMode: 'moduleactivation', status: {phase: 'Ready'},
      }])),
      catalogJson: {
        applications: {'pi-coding': {displayName: 'Pi Coding Agent', requiredModules: ['pi-coding', 'litellm', 'model-catalog']}},
        modules: {'pi-coding': {displayName: 'Pi Coding Agent', group: 'apps', activationMode: 'moduleactivation'},
          litellm: {displayName: 'LiteLLM', group: 'runtime'}, 'model-catalog': {displayName: 'Model Catalog', group: 'runtime'}},
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      let value: unknown = {};
      if ((init?.method ?? 'GET') !== 'GET') {
        writes.push({path, body: JSON.parse(String(init?.body ?? '{}'))});
        if (mutationError) return new Response(JSON.stringify({error: mutationError}), {status: 503, headers: {'content-type': 'application/json'}});
      } else if (path === '/api/modules') value = modules;
      else if (path === '/api/models') value = models;
      else if (path === '/api/instances') value = {instances: {}};
      else if (path === '/api/status') value = {httpRoutes: [], hardwareOperators: {}};
      else if (path === '/api/settings') value = {publicDomain: 'example.com'};
      return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('creates a Pi instance with a chat model, persistent storage and shared SSO defaults', async () => {
    renderServices();
    await userEvent.click(await screen.findByRole('button', {name: 'New Instance'}));
    const dialog = within(screen.getByRole('dialog', {name: 'Create Instance'}));
    expect(dialog.getByLabelText('Application')).toHaveValue('pi-coding');
    expect(dialog.getByLabelText('Model')).toHaveValue('local-coder');
    expect(dialog.queryByRole('option', {name: 'embedding-only'})).not.toBeInTheDocument();
    await userEvent.clear(dialog.getByLabelText('Name'));
    await userEvent.type(dialog.getByLabelText('Name'), 'my-project');
    await userEvent.click(dialog.getByText('Configure'));
    await userEvent.clear(dialog.getByLabelText('Storage'));
    await userEvent.type(dialog.getByLabelText('Storage'), '10Gi');
    await userEvent.click(dialog.getByRole('button', {name: 'Create Pi Coding Agent'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({path: '/api/instances/pi-coding', body: {
      name: 'my-project', enabled: true, namespace: 'ai', model: 'local-coder', storage: {size: '10Gi'},
      ingress: {enabled: false, host: 'my-project.pi-coding.example.com'},
      access: {authentication: 'sso', role: 'user', exposure: 'localAndPublic'},
    }});
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows a disabled service and missing dependencies without starting anything on page load', async () => {
    modules.modules['pi-coding'] = {enabled: false, status: {phase: 'Disabled'}};
    renderServices();
    expect(await screen.findByText('Pi Coding Agent')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Create Instance'})).toBeDisabled();
    expect(screen.queryByRole('button', {name: 'New Instance'})).not.toBeInTheDocument();
    expect(screen.getAllByText(/Required services are not ready/).length).toBeGreaterThan(0);
    expect(writes).toEqual([]);
  });

  it('blocks creation without a deployed chat model and hides mutations from viewers', async () => {
    models = {models: [{id: 'embedding-only', type: 'embedding'}]};
    renderServices(['magicstick-viewer']);
    expect(await screen.findByText('Pi Coding Agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'New Instance'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Create Instance'})).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('keeps a failed creation draft available with an actionable API error', async () => {
    mutationError = 'Pi service is temporarily unavailable. Try again.';
    renderServices();
    await userEvent.click(await screen.findByRole('button', {name: 'New Instance'}));
    const dialog = within(screen.getByRole('dialog', {name: 'Create Instance'}));
    await userEvent.click(dialog.getByRole('button', {name: 'Create Pi Coding Agent'}));
    expect(await screen.findByText(mutationError)).toBeInTheDocument();
    expect(dialog.getByLabelText('Model')).toHaveValue('local-coder');
    expect(dialog.getByLabelText('Name')).toHaveValue('default');
  });
});
