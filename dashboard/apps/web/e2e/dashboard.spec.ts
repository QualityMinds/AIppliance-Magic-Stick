import {expect, test, type Page} from '@playwright/test';

// Browser integration fixture, not a live Keycloak/Kubernetes acceptance test.
async function appliance(page: Page, role = 'magicstick-admin', expired = false) {
  const writes: Array<{path: string; method: string; body: unknown; csrf?: string}> = [];
  const activation = {
    metadata: {name: 'example-model', uid: 'example-model-uid', generation: 1},
    spec: {type: 'local', enabled: true, targetNamespace: 'ai', local: {
      engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://example:small',
      contextWindow: 4096, maxNumSeqs: 1,
    }},
    status: {phase: 'Ready'},
  };
  const payloads: Record<string, unknown> = {
    '/api/session': {subject: 'fixture', username: 'example-admin', roles: [role], identityManagementAvailable: true, identityManagementMode: 'keycloak'},
    '/api/appliance': {metadata: {name: 'local'}, status: {phase: 'Ready'}},
    '/api/modules': {modules: {}, catalogJson: {modules: {}, applications: {}}},
    '/api/instances': {instances: {}},
    '/api/models': {activations: [activation], models: [], presets: {}, computeTargets: {targets: []}, computeMemory: {devices: []}},
    '/api/status': {httpRoutes: [], hardwareOperators: {}},
    '/api/settings': {publicDomain: 'example.com', dashboardHost: 'example.com', mdnsDomain: 'example.local', mdnsName: 'example'},
    '/api/license': {state: 'missing', valid: false, features: [], revision: 'fixture'},
    '/api/host-management': {nodes: []},
    '/api/models/example-model/logs': {model: 'example-model', namespace: 'ai', generatedAt: '2026-09-24T00:00:00Z', tailLines: 300,
      pods: [{name: 'example-pod', phase: 'Running', node: 'example-node', deleting: false,
        containers: [{name: 'server', kind: 'application', ready: true, restartCount: 0, state: 'running',
          logs: [{previous: false, text: 'Synthetic server ready'}]}]}]},
  };
  let rejectMutation = false;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    if (expired && path === '/api/session') return reply({error: 'Session expired. Sign in again.'}, 401);
    if (request.method() !== 'GET') {
      writes.push({path, method: request.method(), body: request.postDataJSON(), csrf: request.headers()['x-magicstick-csrf']});
      if (rejectMutation) return reply({error: 'The model changed. Refresh and try again.'}, 409);
      if (path === '/api/models/example-model/stop' || path === '/api/models/example-model/start') {
        activation.spec.enabled = path.endsWith('/start');
        activation.metadata.generation += 1;
        activation.status.phase = activation.spec.enabled ? 'Ready' : 'Disabled';
        return reply({activation});
      }
      return reply({error: 'Unexpected fixture mutation'}, 400);
    }
    return reply(payloads[path] ?? {error: 'Unexpected fixture endpoint'}, path in payloads ? 200 : 404);
  });
  return {writes, activation, rejectMutations: () => {rejectMutation = true;}};
}

test('navigates the built dashboard without side effects', async ({page}) => {
  const state = await appliance(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Overview', exact: true})).toBeVisible();
  await expect(page.getByText('Signed in: example-admin')).toBeVisible();
  const nav = page.getByRole('navigation', {name: 'Dashboard pages'});
  await nav.getByRole('button', {name: 'Models', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Installed Models'})).toBeVisible();
  await expect(page).toHaveURL(/#\/models$/);
  await nav.getByRole('button', {name: 'System', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'System Status', exact: true})).toBeVisible();
  await page.getByRole('tab', {name: 'Settings', exact: true}).click();
  await expect(page.getByRole('tablist', {name: 'Settings sections'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', {name: 'Settings', exact: true})).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(state.writes).toEqual([]);
  expect(errors).toEqual([]);
});

test('stops and starts a saved model and shows its runtime logs', async ({page}) => {
  const state = await appliance(page);
  const original = structuredClone(state.activation.spec.local);
  await page.goto('/#/models');
  await page.getByRole('button', {name: 'Stop example-model'}).click();
  await expect(page.getByRole('button', {name: 'Start example-model'})).toBeEnabled();
  await page.getByRole('button', {name: 'Start example-model'}).click();
  await expect(page.getByRole('button', {name: 'Stop example-model'})).toBeEnabled();
  expect(state.writes.map(r => r.path)).toEqual(['/api/models/example-model/stop', '/api/models/example-model/start']);
  expect(state.writes.map(r => r.body)).toEqual([{expectedRevision: 'generation:example-model-uid:1'}, {expectedRevision: 'generation:example-model-uid:2'}]);
  expect(state.writes.every(r => r.method === 'POST' && r.csrf === 'dashboard')).toBe(true);
  expect(state.activation.spec.local).toEqual(original);
  await page.getByRole('button', {name: 'View logs for example-model'}).click();
  await expect(page.getByRole('dialog', {name: 'Runtime logs · example-model'})).toBeVisible();
  await expect(page.getByLabel('example-pod server current logs')).toContainText('Synthetic server ready');
});

test('surfaces a rejected change without claiming the model stopped', async ({page}) => {
  const state = await appliance(page);
  state.rejectMutations();
  await page.goto('/#/models');
  await page.getByRole('button', {name: 'Stop example-model'}).click();
  await expect(page.getByText('The model changed. Refresh and try again.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Stop example-model'})).toBeEnabled();
  expect(state.activation.spec.enabled).toBe(true);
  expect(state.writes).toHaveLength(1);
});

test('viewer cannot reach power controls through a direct URL', async ({page}) => {
  const state = await appliance(page, 'magicstick-viewer');
  await page.goto('/#/system/power');
  await expect(page.getByRole('heading', {name: 'System Status', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/#\/system\/status$/);
  await expect(page.getByRole('tab', {name: 'Computer power'})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Restart computer'})).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('expired session shows an error instead of administrative controls', async ({page}) => {
  await appliance(page, 'magicstick-admin', true);
  await page.goto('/');
  await expect(page.getByText('Session expired. Sign in again.')).toBeVisible({timeout: 15_000});
  await expect(page.getByRole('navigation', {name: 'Dashboard pages'})).toHaveCount(0);
});
