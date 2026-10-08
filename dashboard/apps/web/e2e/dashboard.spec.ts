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
    '/api/mesh': {installed: false, configured: false, phase: 'disconnected', models: []},
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
    if (path === '/api/models/estimate-memory' && path in payloads) return reply(payloads[path]);
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
  return {writes, activation, payloads, rejectMutations: () => {rejectMutation = true;}};
}

test('shows the selected Hugging Face revision in the create dialog without mobile overflow', async ({page}, testInfo) => {
  const state = await appliance(page);
  const revision = 'a'.repeat(40), otherRevision = 'b'.repeat(40);
  state.payloads['/api/models'] = {activations: [], models: [], presets: {},
    computeTargets: {default: 'cpu', targets: [{id: 'cpu', kind: 'cpu', available: true, engines: ['VLLM'],
      kvCacheTypes: {VLLM: [{value: 'auto', label: 'Standard - model precision'}]}}]},
    computeMemory: {devices: [{id: 'cpu', computeTarget: 'cpu', totalMi: 16384, unreservedMi: 15000, freeMi: 14000}]}};
  state.payloads['/api/model-discovery/popular'] = {provider: 'huggingface', results: [], total: 0};
  state.payloads['/api/model-discovery/search'] = {provider: 'huggingface', total: 1,
    results: [{id: 'example/model', repo: 'example/model'}]};
  state.payloads['/api/model-discovery/artifacts'] = {provider: 'huggingface', total: 2, artifacts: [
    {id: 'fp8', repo: 'example/model-FP8', url: 'hf://example/model-FP8', revision},
    {id: 'bf16', repo: 'example/model', url: 'hf://example/model', revision: otherRevision},
  ]};
  state.payloads['/api/models/estimate-memory'] = {minimumMi: 1000, recommendedMi: 2000, maximumMi: 15000,
    computeTarget: 'cpu', weightsMi: 500, kvCacheMi: 250, reserveMi: 250, confidence: 'estimated'};
  await page.goto('/#/models');
  await page.getByRole('button', {name: 'Create', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Create Model'});
  await dialog.getByRole('button', {name: 'Search', exact: true}).click();
  const metadata = dialog.locator('.discovery-meta');
  await expect(metadata.getByText(`Revision: ${revision}`, {exact: true})).toBeVisible();
  await expect(dialog.getByLabel('Selected URL')).toHaveValue('hf://example/model-FP8');
  await expect(metadata).not.toContainText('Revision: ' + otherRevision);
  expect(await metadata.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await metadata.scrollIntoViewIfNeeded();
  await page.screenshot({path: testInfo.outputPath('model-discovery-revision.png'), fullPage: true});
  await dialog.getByLabel('Quantization / artifact').selectOption('bf16');
  await expect(metadata.getByText(`Revision: ${otherRevision}`, {exact: true})).toBeVisible();
  await expect(metadata).not.toContainText('Revision: ' + revision);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(state.writes).toEqual([]);
});

test('keeps offline license notices available after a status failure without overflow or writes', async ({page}) => {
  const state=await appliance(page);
  await page.route('**/api/license',route=>route.fulfill({status:503,contentType:'application/json',
    body:JSON.stringify({error:'License API unavailable.'})}));
  await page.goto('/#/system/license');
  await expect(page.getByRole('alert')).toContainText('License API unavailable.');
  await expect(page.getByRole('heading',{name:'Software licenses'})).toBeVisible();
  await page.locator('summary').getByText('Business Source License 1.1',{exact:true}).click();
  const download=page.getByRole('link',{name:'Download Business Source License 1.1'});
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute('download','MagicStick-BSL.txt');
  const href=await download.getAttribute('href');
  expect(decodeURIComponent(href!.split(',',2)[1]!)).toContain('EUR 2,000,000');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(state.writes).toEqual([]);
});

test('navigates the built dashboard without side effects', async ({page}) => {
  const state = await appliance(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Overview', exact: true})).toBeVisible();
  await expect(page.getByText('Signed in: example-admin')).toBeVisible();
  const nav = page.getByRole('navigation', {name: 'Dashboard pages'});
  const labels = await nav.getByRole('button').allTextContents();
  expect(labels.indexOf('Models')).toBe(labels.indexOf('Overview') + 1);
  expect(labels.indexOf('Services')).toBe(labels.indexOf('Models') + 1);
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

test('shows Mesh below API Access and preserves old Mesh links', async ({page}) => {
  const state = await appliance(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', {name: 'Dashboard pages'});
  await expect(nav.getByRole('button', {name: 'Mesh', exact: true})).toBeVisible();
  const labels = await nav.getByRole('button').allTextContents();
  expect(labels.indexOf('Mesh')).toBe(labels.indexOf('API Access') + 1);
  await nav.getByRole('button', {name: 'Mesh', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Private Mesh'})).toBeVisible();
  await expect(page).toHaveURL(/#\/mesh$/);
  await page.goto('/#/system/settings/mesh');
  await expect(page.getByRole('heading', {name: 'Private Mesh'})).toBeVisible();
  await expect(page).toHaveURL(/#\/mesh$/);
  await expect(page.getByRole('tablist', {name: 'Settings sections'})).toHaveCount(0);
  expect(state.writes).toEqual([]);
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

test('viewer cannot reach Mesh through a direct URL', async ({page}) => {
  const state = await appliance(page, 'magicstick-viewer');
  await page.goto('/#/mesh');
  await expect(page.getByRole('heading', {name: 'Overview', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(page.getByRole('navigation', {name: 'Dashboard pages'}).getByRole('button', {name: 'Mesh'})).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('expired session shows an error instead of administrative controls', async ({page}) => {
  await appliance(page, 'magicstick-admin', true);
  await page.goto('/');
  await expect(page.getByText('Session expired. Sign in again.')).toBeVisible({timeout: 15_000});
  await expect(page.getByRole('navigation', {name: 'Dashboard pages'})).toHaveCount(0);
});
